#!/usr/bin/env node
// Generate a control-vs-treatment report from two batch-design-system-test
// JSONL outputs. Renders each agent-produced HTML artifact to PNG via
// playwright-core, runs token-usage analysis on the HTML, and emits a
// single self-contained `report.html` with screenshots + data cards
// suitable for sharing in chat / attaching to a PR.
//
// Usage:
//   # 1. Run two batches against the same prompt + brand list, one with
//   #    OD_DESIGN_TOKEN_CHANNEL=0 (control) and one default (treatment).
//   OD_DESIGN_TOKEN_CHANNEL=0 node --experimental-strip-types \
//     scripts/batch-design-system-test.ts \
//     --prompt "Design a pricing landing page for an AI notes app" \
//     --design-systems default,kami,cursor \
//     --output .tmp/batch-control.jsonl
//
//   node --experimental-strip-types \
//     scripts/batch-design-system-test.ts \
//     --prompt "Design a pricing landing page for an AI notes app" \
//     --design-systems default,kami,cursor \
//     --output .tmp/batch-treatment.jsonl
//
//   # 2. Generate the report.
//   node --experimental-strip-types scripts/design-system-batch-report.ts \
//     --control .tmp/batch-control.jsonl \
//     --treatment .tmp/batch-treatment.jsonl \
//     --out .tmp/design-system-batch-report
//
// Output structure:
//   .tmp/design-system-batch-report/
//   ├── report.html              ← single-file shareable report
//   ├── data.json                ← machine-readable backing data
//   ├── artifacts/
//   │   └── <brand>-<arm>.html   ← raw downloaded HTML
//   └── screenshots/
//       └── <brand>-<arm>.png    ← desktop renders

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = '.tmp/design-system-batch-report';
const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
const SCREENSHOT_TIMEOUT_MS = 30_000;

type Arm = 'control' | 'treatment';

interface Args {
  controlPath: string;
  treatmentPath: string;
  out: string;
  daemonUrl?: string;
  viewport: { width: number; height: number };
  dryRun: boolean;
}

interface BatchResultRow {
  designSystemId: string;
  projectId: string;
  projectName?: string;
  conversationId?: string | null;
  runId?: string | null;
  status: string;
  daemonUrl?: string;
  error?: string;
}

interface ProjectFile {
  name: string;
  path?: string;
  size: number;
  mtime: number;
  kind?: string;
  mime?: string;
}

interface BrandTokenSet {
  /** Tokens declared in the brand's tokens.css `:root` block. */
  declared: Set<string>;
  /** Whether the brand has a structured tokens.css on disk. */
  hasStructuredTokens: boolean;
}

interface TokenUsage {
  /** Total `var(--*)` references across all <style> blocks (excluding the :root paste). */
  varRefCount: number;
  /** Unique token names referenced via `var(--*)`. */
  uniqueVarRefs: string[];
  /** Hardcoded color literals (#hex / rgb / hsl / oklab) outside any :root block. */
  hardcodedColorCount: number;
  /** Sample of hardcoded color literals for human review. */
  hardcodedColorSamples: string[];
  /** Brand-token recall — fraction of the brand's declared tokens that appear in the artifact. */
  brandTokenRecall: number;
  /** Names from the brand's tokens.css that the artifact actually used. */
  brandTokensUsed: string[];
  /** Names declared by the brand but never referenced in the artifact. */
  brandTokensMissed: string[];
  /** Token hit rate = varRefs / (varRefs + hardcodedColors). 1.0 = perfect, 0.0 = all literal. */
  tokenHitRate: number;
}

interface ArtifactInfo {
  brand: string;
  arm: Arm;
  projectId: string;
  primaryFile: ProjectFile | null;
  htmlBytes: number;
  htmlPath: string | null;
  screenshotPath: string | null;
  usage: TokenUsage | null;
  error?: string;
}

interface BrandRow {
  brand: string;
  control: ArtifactInfo;
  treatment: ArtifactInfo;
  /** Treatment minus control — positive numbers favor PR-D / structured channel. */
  delta: {
    tokenHitRate: number;
    brandTokenRecall: number;
    hardcodedColorCount: number;
  };
}

// ─── Args parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { viewport: { ...DEFAULT_VIEWPORT }, dryRun: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) throw new Error(`flag ${flag} expects a value`);
      i += 1;
      return v;
    };
    if (flag === '--control') out.controlPath = next();
    else if (flag === '--treatment') out.treatmentPath = next();
    else if (flag === '--out') out.out = next();
    else if (flag === '--daemon' || flag === '--daemon-url') out.daemonUrl = next();
    else if (flag === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(next());
      if (!m) throw new Error('--viewport must be WxH (e.g. 1440x900)');
      out.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`unknown flag: ${flag}`);
  }
  if (!out.controlPath) throw new Error('missing --control <path.jsonl>');
  if (!out.treatmentPath) throw new Error('missing --treatment <path.jsonl>');
  return out as Args;
}

function usage(): string {
  return [
    'Usage: node --experimental-strip-types scripts/design-system-batch-report.ts \\',
    '  --control <flag-off.jsonl> \\',
    '  --treatment <flag-on.jsonl> \\',
    '  [--out <dir>]            (default .tmp/design-system-batch-report)',
    '  [--daemon <url>]         (auto-discovered from OD_DAEMON_URL / OD_PORT / tools-dev)',
    '  [--viewport WxH]         (default 1440x900)',
    '  [--dry-run]              (parse + analyze without screenshots)',
  ].join('\n');
}

// ─── JSONL load + join ─────────────────────────────────────────────────────

async function readJsonl(filePath: string): Promise<BatchResultRow[]> {
  const absolute = path.resolve(REPO_ROOT, filePath);
  const text = await readFile(absolute, 'utf8');
  const rows: BatchResultRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`malformed JSONL line in ${filePath}: ${(err as Error).message}`);
    }
    rows.push(parsed as BatchResultRow);
  }
  return rows;
}

interface JoinedPair {
  brand: string;
  control: BatchResultRow;
  treatment: BatchResultRow;
}

function joinByBrand(control: BatchResultRow[], treatment: BatchResultRow[]): JoinedPair[] {
  const controlByBrand = new Map(control.map((r) => [r.designSystemId, r]));
  const treatmentByBrand = new Map(treatment.map((r) => [r.designSystemId, r]));
  const brands = new Set([...controlByBrand.keys(), ...treatmentByBrand.keys()]);
  const pairs: JoinedPair[] = [];
  for (const brand of [...brands].sort()) {
    const c = controlByBrand.get(brand);
    const t = treatmentByBrand.get(brand);
    if (!c || !t) {
      process.stderr.write(`warning: ${brand} appears in only one arm; skipping\n`);
      continue;
    }
    pairs.push({ brand, control: c, treatment: t });
  }
  if (pairs.length === 0) {
    throw new Error('no brand appears in both --control and --treatment JSONLs');
  }
  return pairs;
}

// ─── Daemon discovery + fetch ──────────────────────────────────────────────

function isDiscoverablePort(value: string | undefined): value is string {
  if (value == null || value.length === 0) return false;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536;
}

function resolveDaemonUrl(args: Args, rows: BatchResultRow[]): string {
  if (args.daemonUrl) return args.daemonUrl;
  if (process.env.OD_DAEMON_URL) return process.env.OD_DAEMON_URL;
  if (isDiscoverablePort(process.env.OD_PORT)) return `http://127.0.0.1:${process.env.OD_PORT}`;
  // Reuse the daemon URL persisted in JSONL rows when present (a batch run
  // records it next to each result).
  for (const row of rows) {
    if (typeof row.daemonUrl === 'string' && row.daemonUrl.length > 0) return row.daemonUrl;
  }
  throw new Error(
    'cannot determine daemon URL; pass --daemon <url> or set OD_DAEMON_URL',
  );
}

async function fetchProjectFiles(daemonUrl: string, projectId: string): Promise<ProjectFile[]> {
  const url = `${daemonUrl.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/files`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
  const body = (await resp.json()) as { files?: ProjectFile[] };
  return body.files ?? [];
}

async function fetchProjectFileRaw(daemonUrl: string, projectId: string, relPath: string): Promise<string> {
  // The daemon exposes raw artifact bytes at /api/projects/:id/raw/* — used by
  // the artifact preview iframe and useful for any out-of-app consumer.
  const url = `${daemonUrl.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/raw/${relPath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
  return resp.text();
}

function pickPrimaryHtml(files: ProjectFile[]): ProjectFile | null {
  const htmls = files.filter((f) => /\.html?$/i.test(f.name));
  if (htmls.length === 0) return null;
  // Prefer index.html, then the largest HTML by bytes (best heuristic for
  // "the entry artifact" when the agent emitted multiple pages).
  const index = htmls.find((f) => f.name.toLowerCase() === 'index.html');
  if (index) return index;
  return htmls.reduce((acc, cur) => (cur.size > acc.size ? cur : acc));
}

// ─── Brand tokens extraction ───────────────────────────────────────────────

export async function loadBrandTokens(brand: string): Promise<BrandTokenSet> {
  const tokensPath = path.join(REPO_ROOT, 'design-systems', brand, 'tokens.css');
  let css: string;
  try {
    css = await readFile(tokensPath, 'utf8');
  } catch {
    // Brand has no structured tokens.css — it's still valid for the report,
    // brandTokenRecall just reports 0 / total=0 = N/A.
    return { declared: new Set(), hasStructuredTokens: false };
  }
  return { declared: extractRootTokenNames(css), hasStructuredTokens: true };
}

/** Pull `--token-name` declarations out of the first `:root { ... }` block.
 *  Strips CSS comments first so prose references like `:root { … }` in the
 *  file header don't masquerade as the real block. */
export function extractRootTokenNames(css: string): Set<string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rootMatch = /:root\s*\{([\s\S]*?)\}/.exec(stripped);
  if (!rootMatch) return new Set();
  const declared = new Set<string>();
  const declRegex = /--([a-z0-9-]+)\s*:/gi;
  const rootBody = rootMatch[1] ?? '';
  let m: RegExpExecArray | null;
  while ((m = declRegex.exec(rootBody)) !== null) {
    const name = m[1];
    if (name) declared.add(name);
  }
  return declared;
}

// ─── Token usage analyzer ──────────────────────────────────────────────────

export function analyzeTokenUsage(html: string, brand: BrandTokenSet): TokenUsage {
  // Concatenate every <style> block, then strip every :root { ... } block so
  // the brand's pasted token table doesn't pollute the "raw color" count.
  const styleBlocks: string[] = [];
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleRegex.exec(html)) !== null) styleBlocks.push(m[1] ?? '');
  const allCss = styleBlocks.join('\n');
  const cssOutsideRoot = allCss.replace(/:root\s*\{[\s\S]*?\}/g, '');

  // Also include inline style="..." attributes — agents sometimes leak hex
  // values into element-level style attrs.
  const inlineStyles: string[] = [];
  const inlineRegex = /\sstyle\s*=\s*"([^"]*)"/gi;
  let im: RegExpExecArray | null;
  while ((im = inlineRegex.exec(html)) !== null) inlineStyles.push(im[1] ?? '');
  const haystack = `${cssOutsideRoot}\n${inlineStyles.join('\n')}`;

  // var(--name) refs — count each occurrence + collect unique names.
  const varRefRegex = /var\(\s*--([a-z0-9-]+)\s*[,)]/gi;
  let varRefCount = 0;
  const uniqueVarRefs = new Set<string>();
  let v: RegExpExecArray | null;
  while ((v = varRefRegex.exec(haystack)) !== null) {
    varRefCount += 1;
    const name = v[1];
    if (name) uniqueVarRefs.add(name);
  }

  // Hardcoded color literals — #hex, rgb()/rgba(), hsl()/hsla(), oklab()/oklch().
  // We deliberately scan ONLY css-outside-root + inline styles, so the brand's
  // pasted :root values are not double-counted.
  const colorRegex = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklab|oklch)\([^)]*\)/gi;
  const hardcoded: string[] = [];
  let h: RegExpExecArray | null;
  while ((h = colorRegex.exec(haystack)) !== null) hardcoded.push(h[0]);

  // Brand recall — what fraction of the brand's declared tokens did the
  // artifact use?
  const brandTokensUsed: string[] = [];
  const brandTokensMissed: string[] = [];
  if (brand.hasStructuredTokens) {
    for (const name of brand.declared) {
      if (uniqueVarRefs.has(name)) brandTokensUsed.push(name);
      else brandTokensMissed.push(name);
    }
  }

  const totalRefs = varRefCount + hardcoded.length;
  const tokenHitRate = totalRefs === 0 ? 0 : varRefCount / totalRefs;
  const brandTokenRecall = brand.declared.size === 0 ? 0 : brandTokensUsed.length / brand.declared.size;

  return {
    varRefCount,
    uniqueVarRefs: [...uniqueVarRefs].sort(),
    hardcodedColorCount: hardcoded.length,
    hardcodedColorSamples: dedupe(hardcoded).slice(0, 8),
    brandTokenRecall,
    brandTokensUsed: brandTokensUsed.sort(),
    brandTokensMissed: brandTokensMissed.sort(),
    tokenHitRate,
  };
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// ─── Screenshot via playwright-core ────────────────────────────────────────

interface Screenshotter {
  capture(html: string, outPath: string): Promise<void>;
  close(): Promise<void>;
}

async function openScreenshotter(viewport: { width: number; height: number }): Promise<Screenshotter> {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (err) {
    throw new Error(
      `cannot import playwright-core: ${(err as Error).message}. ` +
        'Run `pnpm install` from the repo root to ensure root devDependencies are installed.',
    );
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `cannot launch headless chromium: ${(err as Error).message}. ` +
        'Install the browser with `pnpm dlx playwright install chromium` or ' +
        'set PLAYWRIGHT_BROWSERS_PATH to a directory that already has it.',
    );
  }
  const context = await browser.newContext({ viewport });
  return {
    async capture(html, outPath) {
      const page = await context.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load', timeout: SCREENSHOT_TIMEOUT_MS });
        await page.screenshot({ path: outPath, fullPage: false, type: 'png' });
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

// ─── Per-brand collection ──────────────────────────────────────────────────

async function collectArm(
  brand: string,
  arm: Arm,
  row: BatchResultRow,
  brandTokens: BrandTokenSet,
  daemonUrl: string,
  shooter: Screenshotter | null,
  outDir: string,
): Promise<ArtifactInfo> {
  const info: ArtifactInfo = {
    brand,
    arm,
    projectId: row.projectId,
    primaryFile: null,
    htmlBytes: 0,
    htmlPath: null,
    screenshotPath: null,
    usage: null,
  };
  if (row.status !== 'succeeded') {
    info.error = row.error ?? `run status was '${row.status}', not 'succeeded'`;
    return info;
  }
  let files: ProjectFile[] = [];
  try {
    files = await fetchProjectFiles(daemonUrl, row.projectId);
  } catch (err) {
    info.error = `list files failed: ${(err as Error).message}`;
    return info;
  }
  const primary = pickPrimaryHtml(files);
  if (!primary) {
    info.error = 'no .html artifact in project';
    return info;
  }
  info.primaryFile = primary;
  let html: string;
  try {
    html = await fetchProjectFileRaw(daemonUrl, row.projectId, primary.path ?? primary.name);
  } catch (err) {
    info.error = `fetch raw failed: ${(err as Error).message}`;
    return info;
  }
  info.htmlBytes = html.length;
  // Persist the HTML under <out>/artifacts/<brand>-<arm>.html for re-analysis
  // without re-hitting the daemon.
  const artifactsDir = path.join(outDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const htmlOut = path.join(artifactsDir, `${brand}-${arm}.html`);
  await writeFile(htmlOut, html, 'utf8');
  info.htmlPath = path.relative(outDir, htmlOut);
  info.usage = analyzeTokenUsage(html, brandTokens);
  if (shooter) {
    const screenshotsDir = path.join(outDir, 'screenshots');
    await mkdir(screenshotsDir, { recursive: true });
    const screenshotOut = path.join(screenshotsDir, `${brand}-${arm}.png`);
    try {
      await shooter.capture(html, screenshotOut);
      info.screenshotPath = path.relative(outDir, screenshotOut);
    } catch (err) {
      info.error = `screenshot failed: ${(err as Error).message}`;
    }
  }
  return info;
}

// ─── Report HTML rendering ─────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function deltaCell(value: number, suffix = ''): string {
  if (value === 0) return `<span class="delta delta-zero">±0${escapeHtml(suffix)}</span>`;
  const sign = value > 0 ? '+' : '';
  const cls = value > 0 ? 'delta-pos' : 'delta-neg';
  return `<span class="delta ${cls}">${sign}${value.toFixed(value % 1 === 0 ? 0 : 3)}${escapeHtml(suffix)}</span>`;
}

function renderArmCell(info: ArtifactInfo): string {
  if (info.error) {
    return `<div class="cell-error">⚠︎ ${escapeHtml(info.error)}</div>`;
  }
  const u = info.usage!;
  const screenshotImg = info.screenshotPath
    ? `<img src="${escapeHtml(info.screenshotPath)}" alt="${escapeHtml(info.brand)} ${escapeHtml(info.arm)} desktop render" loading="lazy" />`
    : '<div class="no-screenshot">(no screenshot — dry-run)</div>';
  return `
    <div class="arm-cell">
      ${screenshotImg}
      <dl class="arm-stats">
        <dt>token hit-rate</dt>
        <dd>${pct(u.tokenHitRate)} <span class="muted">(${u.varRefCount} var refs / ${u.hardcodedColorCount} literals)</span></dd>
        <dt>brand token recall</dt>
        <dd>${pct(u.brandTokenRecall)} <span class="muted">(${u.brandTokensUsed.length} / ${u.brandTokensUsed.length + u.brandTokensMissed.length})</span></dd>
        <dt>artifact size</dt>
        <dd>${(info.htmlBytes / 1024).toFixed(1)} KB</dd>
        ${u.hardcodedColorSamples.length > 0 ? `<dt>literal color samples</dt><dd><code>${u.hardcodedColorSamples.map(escapeHtml).join('</code> <code>')}</code></dd>` : ''}
      </dl>
    </div>
  `;
}

export function renderReportHtml(rows: BrandRow[], meta: { generatedAt: string; controlPath: string; treatmentPath: string }): string {
  const summaryStats = computeSummary(rows);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Design system batch report — control vs treatment</title>
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --fg: #111111;
      --muted: #6b6b6b;
      --border: #e5e5e5;
      --pos: #16a34a;
      --neg: #dc2626;
      --neutral: #6b6b6b;
      --accent: #2f6feb;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }
    main { max-width: 1280px; margin-inline: auto; padding: 32px 24px 80px; }
    h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; }
    .subhead { color: var(--muted); margin: 0 0 32px; font-size: 14px; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-block-end: 40px;
    }
    .summary-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
    }
    .summary-card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-block-end: 6px; }
    .summary-card .value { font-size: 24px; font-weight: 600; }
    .summary-card .sub   { color: var(--muted); font-size: 12px; margin-block-start: 4px; }
    .brand-block {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      margin-block-end: 24px;
    }
    .brand-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-block-end: 16px; }
    .brand-head h2 { font-size: 22px; font-weight: 600; margin: 0; }
    .brand-head .delta-row { display: flex; gap: 16px; font-size: 13px; color: var(--muted); }
    .arm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .arm-grid > section h3 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 12px; }
    .arm-cell img { width: 100%; height: auto; border: 1px solid var(--border); border-radius: 8px; display: block; }
    .arm-cell .no-screenshot { padding: 48px 16px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; font-style: italic; }
    .arm-stats { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 12px 0 0; }
    .arm-stats dt { color: var(--muted); font-size: 12px; }
    .arm-stats dd { margin: 0; font-weight: 500; }
    .arm-stats code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; }
    .muted { color: var(--muted); font-weight: 400; }
    .delta { font-weight: 600; font-variant-numeric: tabular-nums; }
    .delta-pos { color: var(--pos); }
    .delta-neg { color: var(--neg); }
    .delta-zero { color: var(--neutral); }
    .cell-error { padding: 24px; text-align: center; color: var(--neg); border: 1px solid color-mix(in oklab, var(--neg), transparent 70%); border-radius: 8px; background: color-mix(in oklab, var(--neg), transparent 92%); }
    footer { margin-block-start: 40px; padding-block-start: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
    footer code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
<main>
  <h1>Design system batch — control vs treatment</h1>
  <p class="subhead">
    Control = <code>OD_DESIGN_TOKEN_CHANNEL=0</code> (prose-only). Treatment = default after PR-D
    (structured channel on for brands shipping <code>tokens.css</code> + <code>components.html</code>).
    Generated <time>${escapeHtml(meta.generatedAt)}</time>.
  </p>

  <section class="summary">
    <div class="summary-card">
      <div class="label">Brands compared</div>
      <div class="value">${summaryStats.brandCount}</div>
      <div class="sub">${summaryStats.structuredCount} structured · ${summaryStats.proseOnlyCount} prose-only</div>
    </div>
    <div class="summary-card">
      <div class="label">Avg token hit-rate</div>
      <div class="value">${pct(summaryStats.avgHitRateTreatment)}</div>
      <div class="sub">treatment vs ${pct(summaryStats.avgHitRateControl)} control · ${deltaCell(summaryStats.avgHitRateDelta * 100, 'pp')}</div>
    </div>
    <div class="summary-card">
      <div class="label">Avg brand recall</div>
      <div class="value">${pct(summaryStats.avgRecallTreatment)}</div>
      <div class="sub">treatment vs ${pct(summaryStats.avgRecallControl)} control · ${deltaCell(summaryStats.avgRecallDelta * 100, 'pp')}</div>
    </div>
    <div class="summary-card">
      <div class="label">Avg literal colors</div>
      <div class="value">${summaryStats.avgLiteralsTreatment.toFixed(1)}</div>
      <div class="sub">treatment vs ${summaryStats.avgLiteralsControl.toFixed(1)} control · ${deltaCell(summaryStats.avgLiteralsTreatment - summaryStats.avgLiteralsControl)}</div>
    </div>
  </section>

  ${rows.map(renderBrandBlock).join('\n')}

  <footer>
    <div>Control source: <code>${escapeHtml(meta.controlPath)}</code></div>
    <div>Treatment source: <code>${escapeHtml(meta.treatmentPath)}</code></div>
    <div>Higher token hit-rate / brand recall and lower literal-color count favor the treatment arm.</div>
  </footer>
</main>
</body>
</html>`;
}

interface SummaryStats {
  brandCount: number;
  structuredCount: number;
  proseOnlyCount: number;
  avgHitRateControl: number;
  avgHitRateTreatment: number;
  avgHitRateDelta: number;
  avgRecallControl: number;
  avgRecallTreatment: number;
  avgRecallDelta: number;
  avgLiteralsControl: number;
  avgLiteralsTreatment: number;
}

function computeSummary(rows: BrandRow[]): SummaryStats {
  const valid = rows.filter((r) => r.control.usage && r.treatment.usage);
  const structured = valid.filter((r) => (r.treatment.usage!.brandTokensUsed.length + r.treatment.usage!.brandTokensMissed.length) > 0);
  const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const hitC = valid.map((r) => r.control.usage!.tokenHitRate);
  const hitT = valid.map((r) => r.treatment.usage!.tokenHitRate);
  const recC = valid.map((r) => r.control.usage!.brandTokenRecall);
  const recT = valid.map((r) => r.treatment.usage!.brandTokenRecall);
  const litC = valid.map((r) => r.control.usage!.hardcodedColorCount);
  const litT = valid.map((r) => r.treatment.usage!.hardcodedColorCount);
  return {
    brandCount: rows.length,
    structuredCount: structured.length,
    proseOnlyCount: rows.length - structured.length,
    avgHitRateControl: avg(hitC),
    avgHitRateTreatment: avg(hitT),
    avgHitRateDelta: avg(hitT) - avg(hitC),
    avgRecallControl: avg(recC),
    avgRecallTreatment: avg(recT),
    avgRecallDelta: avg(recT) - avg(recC),
    avgLiteralsControl: avg(litC),
    avgLiteralsTreatment: avg(litT),
  };
}

function renderBrandBlock(row: BrandRow): string {
  return `
    <article class="brand-block" id="brand-${escapeHtml(row.brand)}">
      <header class="brand-head">
        <h2>${escapeHtml(row.brand)}</h2>
        <div class="delta-row">
          <span>hit-rate ${deltaCell(row.delta.tokenHitRate * 100, 'pp')}</span>
          <span>brand recall ${deltaCell(row.delta.brandTokenRecall * 100, 'pp')}</span>
          <span>literal colors ${deltaCell(row.delta.hardcodedColorCount)}</span>
        </div>
      </header>
      <div class="arm-grid">
        <section>
          <h3>Control · OD_DESIGN_TOKEN_CHANNEL=0</h3>
          ${renderArmCell(row.control)}
        </section>
        <section>
          <h3>Treatment · default (PR-D on)</h3>
          ${renderArmCell(row.treatment)}
        </section>
      </div>
    </article>
  `;
}

// ─── Main ──────────────────────────────────────────────────────────────────

export async function buildBrandRow(
  brand: string,
  control: BatchResultRow,
  treatment: BatchResultRow,
  daemonUrl: string,
  shooter: Screenshotter | null,
  outDir: string,
): Promise<BrandRow> {
  const tokens = await loadBrandTokens(brand);
  const [controlInfo, treatmentInfo] = await Promise.all([
    collectArm(brand, 'control', control, tokens, daemonUrl, shooter, outDir),
    collectArm(brand, 'treatment', treatment, tokens, daemonUrl, shooter, outDir),
  ]);
  const delta = {
    tokenHitRate: (treatmentInfo.usage?.tokenHitRate ?? 0) - (controlInfo.usage?.tokenHitRate ?? 0),
    brandTokenRecall: (treatmentInfo.usage?.brandTokenRecall ?? 0) - (controlInfo.usage?.brandTokenRecall ?? 0),
    hardcodedColorCount: (treatmentInfo.usage?.hardcodedColorCount ?? 0) - (controlInfo.usage?.hardcodedColorCount ?? 0),
  };
  return { brand, control: controlInfo, treatment: treatmentInfo, delta };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(REPO_ROOT, args.out);
  await mkdir(outDir, { recursive: true });

  const [controlRows, treatmentRows] = await Promise.all([
    readJsonl(args.controlPath),
    readJsonl(args.treatmentPath),
  ]);
  const pairs = joinByBrand(controlRows, treatmentRows);
  const daemonUrl = resolveDaemonUrl(args, [...controlRows, ...treatmentRows]);
  process.stdout.write(`design-system batch report → ${args.out}\n`);
  process.stdout.write(`daemon: ${daemonUrl}\n`);
  process.stdout.write(`brands (${pairs.length}): ${pairs.map((p) => p.brand).join(', ')}\n`);

  const shooter = args.dryRun ? null : await openScreenshotter(args.viewport);

  const brandRows: BrandRow[] = [];
  try {
    // Sequential per-brand to keep daemon load + chromium memory predictable.
    for (const pair of pairs) {
      process.stdout.write(`  - ${pair.brand}: collecting\n`);
      const row = await buildBrandRow(pair.brand, pair.control, pair.treatment, daemonUrl, shooter, outDir);
      const fmt = (info: ArtifactInfo): string => {
        if (info.error) return `error: ${info.error}`;
        const u = info.usage!;
        return `hit=${pct(u.tokenHitRate)} recall=${pct(u.brandTokenRecall)} literals=${u.hardcodedColorCount}`;
      };
      process.stdout.write(`    control:   ${fmt(row.control)}\n`);
      process.stdout.write(`    treatment: ${fmt(row.treatment)}\n`);
      brandRows.push(row);
    }
  } finally {
    if (shooter) await shooter.close();
  }

  const reportHtml = renderReportHtml(brandRows, {
    generatedAt: new Date().toISOString(),
    controlPath: args.controlPath,
    treatmentPath: args.treatmentPath,
  });
  await writeFile(path.join(outDir, 'report.html'), reportHtml, 'utf8');
  await writeFile(path.join(outDir, 'data.json'), JSON.stringify(brandRows, null, 2), 'utf8');

  process.stdout.write(`done — open ${path.relative(REPO_ROOT, path.join(outDir, 'report.html'))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
