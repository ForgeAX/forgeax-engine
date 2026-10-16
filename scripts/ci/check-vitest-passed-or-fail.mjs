#!/usr/bin/env node
/**
 * check-vitest-passed-or-fail.mjs (feat-20260608-ci-time-cut)
 *
 * Reads a vitest --reporter=json output file and exits 0 if all tests passed
 * (success=true and numFailedTests/numFailedTestSuites are both zero). Else
 * prints a one-line diagnostic and exits with VRC env var (or 1 if unset).
 *
 * Used by the ci.yml `Vitest unit (PR + main)` step to tolerate vitest 4.x
 * 'close timed out after 500ms' shutdown anomalies that produce exit code 1
 * even when all tests pass — without masking real test failures.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: check-vitest-passed-or-fail.mjs <vitest-output.json>');
  process.exit(1);
}

const fallback = Number.parseInt(process.env.VRC ?? '1', 10) || 1;

let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`failed to parse ${path}: ${err.message}`);
  process.exit(fallback);
}

const failedTests = report.numFailedTests ?? 0;
const failedSuites = report.numFailedTestSuites ?? 0;
if (!report.success || failedTests > 0 || failedSuites > 0) {
  console.error(
    `vitest reports failures: success=${report.success} failedTests=${failedTests} failedSuites=${failedSuites}`,
  );
  process.exit(fallback);
}

console.error(
  `vitest exited ${fallback} on close-timeout but all tests passed (numTotalTests=${report.numTotalTests}); treating as green`,
);
process.exit(0);
