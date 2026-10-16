// ci-conclusion.test.mjs (M3 w13) - ci.yml job-name extraction + GHA conclusion
// aggregation unit test.
//
// Two-part TDD landing point (plan-strategy K-7 + AC-10 (b)):
//
//   (alpha) yaml-parse with minimal regex - extract top-level `jobs.*` names
//           from .github/workflows/ci.yml via the
//           /^\s+([a-z][a-z0-9-]+):\s*$/m line scanner. Cross-validates
//           AC-01 by asserting the post-L2 job-name set contains
//           `metrics-validate` + `sticky-comment` and does NOT contain
//           `report` (legacy job retired per w9 commit).
//
//   (beta)  pure-function `aggregateConclusion(jobConclusions)` mock that
//           reproduces the GitHub Actions workflow conclusion rule
//           (research §Finding 10): every non-skipped job must be `success`
//           for the workflow to be green; any non-skipped non-success is
//           `failure`; entirely skipped is `skipped`.
//
// Implementation note: aggregateConclusion lives inline here (plan-strategy
// K-7 + plan-tasks.json#w13 description); no extra production file - the
// regex + aggregation contract is a test-asserted shape that the existing
// .github/workflows/ci.yml + post-merge-monitor.yml must satisfy.
//
// Reference:
//   - requirements §AC-10 (b) (ci.yml conclusion derivation unit test, minimal
//     yaml-parser)
//   - research §Finding 10 (aggregateConclusion mock + observed behavior on
//     skipped jobs)
//   - plan-strategy §2 K-7 (landing path scripts/metrics/__tests__/) + §3 R-7
//     (regex drift mitigation) + §4.3 unit layer table + OQ-3 verdict.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');
const ciYmlPath = resolve(repoRoot, '.github/workflows/ci.yml');

// Minimal yaml job-name extractor. Two-space indented `<name>:` line at column
// 3 inside a `jobs:` block matches a top-level job. The regex deliberately
// matches kebab-case lowercase identifiers only (R-7 drift mitigation: drops
// nested options like `name:` / `runs-on:` / `if:` that live at column 5+).
function extractTopLevelJobNames(yamlText) {
  const names = new Set();
  const lines = yamlText.split('\n');
  let inJobsBlock = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobsBlock = true;
      continue;
    }
    if (!inJobsBlock) continue;
    // Top-level keys outside `jobs:` block reset state. A non-indented
    // top-level key would re-trigger `inJobsBlock = false`.
    if (/^[a-z]/i.test(line)) {
      inJobsBlock = false;
      continue;
    }
    const m = line.match(/^\s{2}([a-z][a-z0-9-]+):\s*$/);
    if (m) names.add(m[1]);
  }
  return names;
}

// GHA workflow conclusion aggregator (research §Finding 10):
//   - empty input -> 'skipped' (no jobs ran)
//   - all 'skipped' -> 'skipped'
//   - any non-skipped non-success -> 'failure'
//   - else -> 'success'
function aggregateConclusion(jobConclusions) {
  const values = Object.values(jobConclusions);
  if (values.length === 0) return 'skipped';
  const nonSkipped = values.filter((v) => v !== 'skipped');
  if (nonSkipped.length === 0) return 'skipped';
  for (const v of nonSkipped) {
    if (v !== 'success') return 'failure';
  }
  return 'success';
}

describe('(alpha) ci.yml top-level jobs.* extraction (AC-01 cross-validate)', () => {
  it('extracts metrics-validate + sticky-comment + pnpm + bun and excludes report', () => {
    const yamlText = readFileSync(ciYmlPath, 'utf8');
    const names = extractTopLevelJobNames(yamlText);
    expect(names.has('metrics-validate')).toBe(true);
    expect(names.has('sticky-comment')).toBe(true);
    expect(names.has('pnpm')).toBe(true);
    expect(names.has('bun')).toBe(true);
    expect(names.has('report')).toBe(false);
  });

  it('finds exactly the expected post-L2 job set (no extra jobs introduced inadvertently)', () => {
    const yamlText = readFileSync(ciYmlPath, 'utf8');
    const names = extractTopLevelJobNames(yamlText);
    const expected = ['pnpm', 'bun', 'metrics-validate', 'sticky-comment'].sort();
    const actual = [...names].sort();
    expect(actual).toEqual(expected);
  });
});

describe('(beta) aggregateConclusion mock (GHA workflow_run rule)', () => {
  it('case 1 - all success -> success', () => {
    const result = aggregateConclusion({
      pnpm: 'success',
      bun: 'success',
      'metrics-validate': 'success',
      'sticky-comment': 'success',
    });
    expect(result).toBe('success');
  });

  it('case 2 - metrics-validate failure + sticky-comment skipped -> failure', () => {
    const result = aggregateConclusion({
      pnpm: 'success',
      bun: 'success',
      'metrics-validate': 'failure',
      'sticky-comment': 'skipped',
    });
    expect(result).toBe('failure');
  });

  it('case 3 - all skipped -> skipped', () => {
    const result = aggregateConclusion({
      pnpm: 'skipped',
      bun: 'skipped',
      'metrics-validate': 'skipped',
      'sticky-comment': 'skipped',
    });
    expect(result).toBe('skipped');
  });

  it('case 4 - metrics-validate success + sticky-comment skipped (push event) -> success', () => {
    const result = aggregateConclusion({
      pnpm: 'success',
      bun: 'success',
      'metrics-validate': 'success',
      'sticky-comment': 'skipped',
    });
    expect(result).toBe('success');
  });
});
