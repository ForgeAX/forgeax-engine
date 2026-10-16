#!/usr/bin/env node
// scripts/lint/grep-r12-lint.mjs - feat-20260608-ci-time-cut M5 w15.
//
// Replaces packages/rhi/__tests__/r12-lint.test.ts (4 it blocks). The original
// test spawned packages/rhi/scripts/r12-lint.mjs as a child process to verify
// (a) zero violations on packages/rhi/src/index.ts and (b) the fixture
// catches drifted field names. This script runs both checks directly without
// vitest, exiting non-zero if either invariant breaks.
//
// Invocation:
//   node scripts/lint/grep-r12-lint.mjs
//
// Behaviour:
//   - Run `node packages/rhi/scripts/r12-lint.mjs` (real lint) -> must exit 0
//     and stdout must contain "0 violations".
//   - Run `node packages/rhi/scripts/r12-lint.mjs --fixture <FIXTURE>` ->
//     must exit 1 and stderr must contain "byteSize", "entrys", "customField",
//     plus a "(N) violation(s) detected" with N >= 3.
//   - Run with a missing fixture path -> must exit 2 and stderr contains
//     "fixture not found" (script self-defense).

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const LINT_SCRIPT = resolve(REPO_ROOT, 'packages', 'rhi', 'scripts', 'r12-lint.mjs');
const FIXTURE = resolve(REPO_ROOT, 'packages', 'rhi', '__tests__', 'r12-lint.fixture.ts');

const failures = [];

function runLint(args) {
  return spawnSync('node', [LINT_SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

// (1) zero violations on the real source.
{
  const r = runLint([]);
  if (r.status !== 0) {
    failures.push(`(1) real lint exit=${r.status} (expected 0); stderr=${r.stderr}`);
  }
  if (!r.stdout.includes('0 violations')) {
    failures.push(`(1) real lint stdout missing "0 violations"; got: ${r.stdout.trim()}`);
  }
}

// (2) fixture flags every drifted field + exits 1 + violation count >= 3.
{
  const r = runLint(['--fixture', FIXTURE]);
  if (r.status !== 1) {
    failures.push(`(2) fixture lint exit=${r.status} (expected 1); stderr=${r.stderr}`);
  }
  for (const tok of ['byteSize', 'entrys', 'customField']) {
    if (!r.stderr.includes(tok)) {
      failures.push(`(2) fixture lint stderr missing token "${tok}"`);
    }
  }
  const m = /(\d+) violation\(s\) detected/.exec(r.stderr);
  if (!m) {
    failures.push(`(2) fixture lint stderr missing "(N) violation(s) detected" line`);
  } else if (Number(m[1]) < 3) {
    failures.push(`(2) fixture lint reported ${m[1]} violations (expected >= 3)`);
  }
}

// (3) missing fixture path -> exit 2.
{
  const r = runLint(['--fixture', resolve(REPO_ROOT, '__missing_fixture__.ts')]);
  if (r.status !== 2) {
    failures.push(`(3) missing-fixture lint exit=${r.status} (expected 2); stderr=${r.stderr}`);
  }
  if (!r.stderr.includes('fixture not found')) {
    failures.push(`(3) missing-fixture lint stderr missing "fixture not found"`);
  }
}

if (failures.length === 0) {
  console.log('grep-r12-lint: pass (3 checks)');
  process.exit(0);
} else {
  console.error('grep-r12-lint: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
