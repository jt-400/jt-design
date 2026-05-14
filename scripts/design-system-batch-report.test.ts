// Sanity checks on the design-system-batch-report analyzer + report
// renderer, run as part of `pnpm guard` (see package.json `guard` script).
//
// Concretely we want three guarantees in CI:
//
//   1. The analyzer says "near-perfect" on each brand's reference
//      components.html. If the reference fixture itself has hardcoded
//      colors outside the :root paste, the structured channel is broken
//      at its source — agents will copy those literals into artifacts.
//
//   2. The analyzer correctly DOWNGRADES a synthetic bad artifact (one
//      that hardcodes hex colors and doesn't reference any tokens).
//      This pins the analyzer's discriminative power: if the formula
//      ever flips signs, the test breaks.
//
//   3. renderReportHtml emits a self-contained HTML document with the
//      key data fields (control vs treatment delta, summary cards) so
//      the report stays usable without re-running batch tests.

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeTokenUsage,
  loadBrandTokens,
  renderReportHtml,
} from './design-system-batch-report.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

async function readBrandFixture(brand: string): Promise<string> {
  return await readFile(path.join(REPO_ROOT, 'design-systems', brand, 'components.html'), 'utf8');
}

/** Discover every brand on this branch that ships a components.html. */
async function discoverStructuredBrands(): Promise<string[]> {
  const root = path.join(REPO_ROOT, 'design-systems');
  const entries = await readdir(root, { withFileTypes: true });
  const brands: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const fixture = path.join(root, entry.name, 'components.html');
    try {
      await access(fixture);
      brands.push(entry.name);
    } catch {
      // Brand has no structured fixture on this branch — fine, skip.
    }
  }
  return brands;
}

const structuredBrands = await discoverStructuredBrands();
assert.ok(structuredBrands.length >= 2, `expected ≥2 structured brands, got ${structuredBrands.length}: ${structuredBrands.join(', ')}`);

for (const brand of structuredBrands) {
  test(`analyzer reports near-perfect hit rate on ${brand}'s reference fixture`, async () => {
    const [html, tokens] = await Promise.all([readBrandFixture(brand), loadBrandTokens(brand)]);
    const usage = analyzeTokenUsage(html, tokens);
    assert.ok(
      usage.varRefCount > 20,
      `${brand} fixture should reference 20+ tokens, got ${usage.varRefCount}`,
    );
    // The reference fixtures intentionally use NO literal colors outside
    // their :root paste. If a fixture starts leaking literals, agents
    // pattern-matching it will copy those literals into artifacts.
    assert.equal(
      usage.hardcodedColorCount,
      0,
      `${brand} fixture leaks ${usage.hardcodedColorCount} literal colors outside :root: ` +
        usage.hardcodedColorSamples.join(', '),
    );
    assert.equal(usage.tokenHitRate, 1, `${brand} hit rate should be 1.0, got ${usage.tokenHitRate}`);
    assert.ok(
      usage.brandTokenRecall >= 0.5,
      `${brand} reference fixture should use ≥50% of declared tokens, got ${usage.brandTokenRecall}`,
    );
  });
}

test('analyzer downgrades a synthetic literal-heavy artifact', () => {
  const html = `
    <html>
      <head>
        <style>
          .danger { color: #ff0000; background: rgb(255, 200, 0); border: 1px solid hsl(120, 80%, 50%); }
        </style>
      </head>
      <body>
        <div style="color: #abcdef">Hi</div>
      </body>
    </html>
  `;
  const tokens = { declared: new Set(['fg', 'bg', 'accent']), hasStructuredTokens: true };
  const usage = analyzeTokenUsage(html, tokens);
  assert.equal(usage.varRefCount, 0);
  // Three literal colors in the <style> (#ff0000, rgb(...), hsl(...)) +
  // one in the inline style attribute (#abcdef).
  assert.equal(usage.hardcodedColorCount, 4);
  assert.equal(usage.tokenHitRate, 0);
  assert.equal(usage.brandTokenRecall, 0);
  assert.equal(usage.brandTokensMissed.length, 3);
});

test('analyzer ignores literals INSIDE the :root paste', () => {
  // Agents that paste a brand's :root block verbatim will technically
  // include the brand's own #hex values inside :root. Those should NOT
  // be counted as "hardcoded" since they are the brand's source of truth.
  const html = `
    <style>
      :root { --fg: #111111; --bg: #fafafa; }
      .card { color: var(--fg); background: var(--bg); }
    </style>
  `;
  const tokens = { declared: new Set(['fg', 'bg']), hasStructuredTokens: true };
  const usage = analyzeTokenUsage(html, tokens);
  assert.equal(usage.hardcodedColorCount, 0, 'literals inside :root must not count');
  assert.equal(usage.varRefCount, 2);
  assert.equal(usage.tokenHitRate, 1);
  assert.equal(usage.brandTokenRecall, 1);
});

test('renderReportHtml produces a self-contained HTML report with key data', () => {
  const fakeUsage = (varRefs: number, literals: number, recall: number) => ({
    varRefCount: varRefs,
    uniqueVarRefs: ['fg', 'bg'].slice(0, Math.min(2, varRefs)),
    hardcodedColorCount: literals,
    hardcodedColorSamples: literals > 0 ? ['#ff0000'] : [],
    brandTokenRecall: recall,
    brandTokensUsed: recall > 0 ? ['fg', 'bg'] : [],
    brandTokensMissed: recall < 1 ? ['accent'] : [],
    tokenHitRate: varRefs / Math.max(1, varRefs + literals),
  });
  const rows = [
    {
      brand: 'default',
      control: {
        brand: 'default',
        arm: 'control' as const,
        projectId: 'p1',
        primaryFile: null,
        htmlBytes: 1234,
        htmlPath: 'artifacts/default-control.html',
        screenshotPath: 'screenshots/default-control.png',
        usage: fakeUsage(10, 4, 0.5),
      },
      treatment: {
        brand: 'default',
        arm: 'treatment' as const,
        projectId: 'p2',
        primaryFile: null,
        htmlBytes: 1500,
        htmlPath: 'artifacts/default-treatment.html',
        screenshotPath: 'screenshots/default-treatment.png',
        usage: fakeUsage(20, 0, 1.0),
      },
      delta: { tokenHitRate: 0.286, brandTokenRecall: 0.5, hardcodedColorCount: -4 },
    },
  ];
  const html = renderReportHtml(rows, {
    generatedAt: '2026-05-14T10:00:00Z',
    controlPath: '.tmp/control.jsonl',
    treatmentPath: '.tmp/treatment.jsonl',
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Design system batch/);
  assert.match(html, /default/);
  assert.match(html, /default-control\.png/);
  assert.match(html, /default-treatment\.png/);
  assert.match(html, /\+50pp/, 'positive recall delta must render with explicit + sign');
  assert.match(html, /-4/, 'negative literal-color delta should render with - sign');
  assert.match(html, /Brands compared/);
  assert.match(html, /delta-pos/, 'positive delta should carry the delta-pos class');
  assert.match(html, /delta-neg/, 'negative delta should carry the delta-neg class');
});
