#!/usr/bin/env -S node --experimental-strip-types
/**
 * extract-verdicts.ts — render the agent's STEP markers into the PR comment.
 *
 * Reads the agent session output (JSON or NDJSON, as written by gh-aw to
 * /tmp/gh-aw/agent_output.json) and produces the Markdown comment that
 * matches the spec's "Comment output format" contract:
 *
 *   - Header (verdict / coverage / walltime / approver / finding counts)
 *   - Findings worth attention (⚠️/❌), expanded by default
 *   - <details>✅ N scenarios passed</details>, always collapsed
 *   - <details>📊 Run footprint</details>, always collapsed
 *   - Sediment candidates (collapsed) when any SEDIMENT lines were emitted
 *   - Advisory footer
 *
 * The wrapper is intentionally strict: malformed markers, unpaired
 * STEP_START/STEP_DONE, or duplicate step-ids surface in the rendered
 * comment as `status: unknown` with the raw text exposed — never silent
 * drop. Per spec § Wire format and parser.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface CliArgs {
  input: string;
  pr: string;
  head: string;
  approver: string;
  output: string;
}

interface Step {
  id: string;
  title?: string;
  verdict?: string;
  status: "passed" | "warning" | "failed" | "unknown";
  rawError?: string;
}

interface Sediment {
  target: string;
  rationale: string;
  scenario: string;
}

interface ParsedRun {
  steps: Step[];
  sediments: Sediment[];
  overall: "pass" | "fail" | "inconclusive" | null;
  overallRationale: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  assistantTurns: number;
  outputTokens: number;
  toolCounts: Map<string, number>;
}

const STEP_LINE = /^STEP_(START|DONE)\|(step-\d{2,})\|(.+)$/;
const SEDIMENT_LINE = /^SEDIMENT\|([^|]+)\|([^|]+)\|(.+)$/;
const RUN_DONE_LINE = /^RUN_DONE\|(pass|fail|inconclusive)\|(.+)$/;
const MAX_FIELD_LEN = 500;

function cliParse(): CliArgs {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      pr: { type: "string" },
      head: { type: "string" },
      approver: { type: "string" },
      output: { type: "string" },
    },
  });
  for (const k of ["input", "pr", "head", "approver", "output"] as const) {
    if (!values[k]) throw new Error(`missing --${k}`);
  }
  return values as unknown as CliArgs;
}

function iterateTextBlocks(rawInput: string): Iterable<string> {
  // gh-aw writes one of two shapes:
  //   (a) a single JSON object with an .events[].text fields, or
  //   (b) NDJSON (one event per line). Be defensive about both.
  const blocks: string[] = [];
  const trimmed = rawInput.trim();
  if (!trimmed) return blocks;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const events = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
      for (const ev of events) {
        const text = ev?.text ?? ev?.message?.content
          ?.find?.((c: { type?: string }) => c?.type === "text")?.text;
        if (typeof text === "string") blocks.push(text);
      }
      return blocks;
    } catch {
      /* fall through to NDJSON */
    }
  }

  for (const line of trimmed.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      const text = ev?.text ?? ev?.message?.content
        ?.find?.((c: { type?: string }) => c?.type === "text")?.text;
      if (typeof text === "string") blocks.push(text);
    } catch {
      /* ignore unparseable lines */
    }
  }
  return blocks;
}

function parseRun(rawInput: string): ParsedRun {
  const steps = new Map<string, Step>();
  const stepOrder: string[] = [];
  const sediments: Sediment[] = [];
  let overall: ParsedRun["overall"] = null;
  let overallRationale: string | null = null;
  // Track which (kind, id) pairs we've seen so we can flag duplicates
  // — spec § Wire format requires "exactly one STEP_START + one
  // STEP_DONE per id". A second STEP_START or STEP_DONE on the same
  // id is a parse failure, not a silent overwrite.
  const seenMarkers = new Set<string>();
  // Track sequence order to detect monotonic/no-skip violations.
  let lastNumericId = 0;

  for (const text of iterateTextBlocks(rawInput)) {
    for (const line of text.split("\n")) {
      const ln = line.trim();
      if (!ln) continue;

      const sMatch = STEP_LINE.exec(ln);
      if (sMatch) {
        const kind = sMatch[1];
        const id = sMatch[2];
        const payload = sMatch[3];
        const markerKey = `${kind}|${id}`;

        // Duplicate marker check (e.g., two STEP_START on the same id)
        if (seenMarkers.has(markerKey)) {
          if (!steps.has(id)) {
            steps.set(id, { id, status: "unknown" });
            stepOrder.push(id);
          }
          const step = steps.get(id)!;
          step.status = "unknown";
          step.rawError =
            (step.rawError ?? "") +
            (step.rawError ? " · " : "") +
            `duplicate ${kind} marker for ${id}`;
          continue;
        }
        seenMarkers.add(markerKey);

        if (payload.length > MAX_FIELD_LEN) {
          if (!steps.has(id)) {
            steps.set(id, {
              id,
              status: "unknown",
              rawError: `payload exceeded ${MAX_FIELD_LEN} chars`,
            });
            stepOrder.push(id);
          }
          continue;
        }
        if (!steps.has(id)) {
          steps.set(id, { id, status: "unknown" });
          stepOrder.push(id);
          // Monotonic / no-skip / starts-at-01 check fires on first
          // sighting of a new step id only.
          const numericId = Number.parseInt(id.replace("step-", ""), 10);
          const expected = lastNumericId + 1;
          if (numericId !== expected) {
            const step = steps.get(id)!;
            step.status = "unknown";
            step.rawError =
              (step.rawError ?? "") +
              (step.rawError ? " · " : "") +
              (lastNumericId === 0 && numericId !== 1
                ? `first step-id was ${id}, expected step-01`
                : `step-id ${id} not monotonic (expected step-${String(expected).padStart(2, "0")})`);
          }
          lastNumericId = numericId;
        }
        const step = steps.get(id)!;
        if (kind === "START") {
          if (step.title === undefined) step.title = payload;
        } else {
          if (step.verdict === undefined) step.verdict = payload;
        }
        continue;
      }

      const sedMatch = SEDIMENT_LINE.exec(ln);
      if (sedMatch) {
        sediments.push({
          target: sedMatch[1].trim(),
          rationale: sedMatch[2].trim(),
          scenario: sedMatch[3].trim(),
        });
        continue;
      }

      const doneMatch = RUN_DONE_LINE.exec(ln);
      if (doneMatch) {
        overall = doneMatch[1] as ParsedRun["overall"];
        overallRationale = doneMatch[2].trim();
      }
    }
  }

  // Classify each step.
  for (const step of steps.values()) {
    if (step.title === undefined || step.verdict === undefined) {
      step.status = "unknown";
      step.rawError ??= step.title === undefined
        ? "missing STEP_START"
        : "missing STEP_DONE";
      continue;
    }
    const v = step.verdict.toLowerCase();
    if (
      v.startsWith("fail") ||
      v.includes("is a regression") ||
      v.includes("test failed") ||
      v.includes("did not work")
    ) {
      step.status = "failed";
    } else if (
      v.includes("however") ||
      v.includes("discrepancy") ||
      v.includes("pre-existing") ||
      v.includes("not a regression") ||
      v.includes("not caused by this pr") ||
      v.includes("doesn't match") ||
      v.includes("does not match") ||
      v.includes("worth attention")
    ) {
      step.status = "warning";
    } else {
      step.status = "passed";
    }
  }

  return {
    steps: stepOrder.map((id) => steps.get(id)!),
    sediments,
    overall,
    overallRationale,
    startedAtMs: null,
    endedAtMs: null,
    assistantTurns: 0,
    outputTokens: 0,
    toolCounts: new Map(),
  };
}

function fmtDuration(ms: number): string {
  if (!ms) return "n/a";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

function renderMarkdown(parsed: ParsedRun, args: CliArgs): string {
  const passed = parsed.steps.filter((s) => s.status === "passed");
  const findings = parsed.steps.filter(
    (s) => s.status === "warning" || s.status === "failed" || s.status === "unknown",
  );
  const critical = parsed.steps.filter((s) => s.status === "failed").length;
  const worthAttention =
    parsed.steps.filter((s) => s.status === "warning").length +
    parsed.steps.filter((s) => s.status === "unknown").length;

  const overallEmoji = parsed.overall === "fail"
    ? "❌"
    : parsed.overall === "inconclusive"
    ? "⚠️"
    : parsed.overall === "pass"
    ? "✅"
    : "⚠️";

  const overallText = parsed.overall ?? "inconclusive (no RUN_DONE marker)";

  const walltime = parsed.startedAtMs && parsed.endedAtMs
    ? fmtDuration(parsed.endedAtMs - parsed.startedAtMs)
    : "n/a";

  const lines: string[] = [];
  const add = (s: string) => lines.push(s);

  add("## 🤖 Agent Explore Report");
  add("");
  add(
    `**Verdict**: ${overallEmoji} ${overallText} · ` +
      `**Coverage**: ${parsed.steps.length} scenarios · ` +
      `**Walltime**: ${walltime} · ` +
      `**Approved by**: @${args.approver}`,
  );
  add(
    `**Findings**: ${critical} critical · ${worthAttention} worth attention · ${passed.length} passed`,
  );
  add("");

  if (findings.length > 0) {
    add("### Findings worth attention");
    add("");
    for (const step of findings) {
      const icon = step.status === "failed"
        ? "❌"
        : step.status === "warning"
        ? "⚠️"
        : "❓";
      add(`#### ${icon} ${step.id} — ${step.title ?? "(missing title)"}`);
      add("");
      if (step.status === "unknown") {
        add(
          `verdict parsing failed for ${step.id} — see raw transcript in artifact (${step.rawError ?? "unknown reason"}).`,
        );
        if (step.verdict) {
          add("");
          add("> " + step.verdict);
        }
      } else {
        add(step.verdict ?? "(no verdict text)");
      }
      add("");
    }
  }

  if (passed.length > 0) {
    add(
      `<details>\n<summary>✅ ${passed.length} scenarios passed — click to expand</summary>\n`,
    );
    for (const step of passed) {
      add(`### ✅ ${step.id} — ${step.title}`);
      add("");
      add(step.verdict ?? "");
      add("");
    }
    add("</details>");
    add("");
  }

  add("<details>");
  add("<summary>📊 Run footprint</summary>\n");
  add(`- Walltime: ${walltime}`);
  add(`- Steps emitted: ${parsed.steps.length}`);
  if (parsed.assistantTurns) add(`- Assistant turns: ${parsed.assistantTurns}`);
  if (parsed.outputTokens) add(`- Output tokens: ${parsed.outputTokens.toLocaleString()}`);
  if (parsed.toolCounts.size > 0) {
    const top = [...parsed.toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    add(`- Tool calls (top 5): ${top}`);
  }
  if (parsed.overallRationale) {
    add(`- Overall rationale: ${parsed.overallRationale}`);
  }
  add("</details>");
  add("");

  if (parsed.sediments.length > 0) {
    add(
      `<details>\n<summary>💡 ${parsed.sediments.length} sediment candidates — scenarios worth promoting to permanent test suite</summary>\n`,
    );
    parsed.sediments.forEach((sed, i) => {
      add(`${i + 1}. **${sed.target}**`);
      add(`   - Scenario: ${sed.scenario}`);
      add(`   - Rationale: ${sed.rationale}`);
      add("");
    });
    add(
      "These are **suggestions, not commits**. The follow-on Sedimentation Bot batches these and proposes PRs; manual review before any `e2e/` change.",
    );
    add("</details>");
    add("");
  }

  add("---");
  add(
    `_Advisory only · never blocks merge · PR #${args.pr} @ \`${args.head.slice(0, 8)}\` · ` +
      "wrapper v1.0 · session jsonl in artifact_",
  );

  return lines.join("\n") + "\n";
}

function main(): void {
  const args = cliParse();
  let rawInput = "";
  try {
    rawInput = readFileSync(args.input, "utf-8");
  } catch (e) {
    rawInput = "";
    console.error(`extract-verdicts: input not found at ${args.input}, rendering empty report`);
  }
  const parsed = parseRun(rawInput);
  const md = renderMarkdown(parsed, args);
  writeFileSync(args.output, md, "utf-8");
  console.error(
    `extract-verdicts: wrote ${md.length} bytes to ${args.output} (` +
      `${parsed.steps.length} steps, ${parsed.sediments.length} sediments, ` +
      `overall=${parsed.overall ?? "n/a"})`,
  );
}

main();
