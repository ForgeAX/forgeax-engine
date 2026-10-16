#!/usr/bin/env node
// check-test-perf-budget.mjs — CI regression guard for vitest per-file timing.
// Reads vitest `--reporter=json` output (single JSON object or ndjson) from
// stdin. Computes ms/it per file from `testResults[].duration` (or the
// file-level endTime-startTime interval when Vitest omits duration) and
// `assertionResults.length`. Reports when ms/it > 200 && it < 3. This
// identifies file-consolidation candidates, not a performance regression:
// coverage instrumentation, runner load, and assertion grouping change this
// ratio. Real test deadlines, coverage thresholds, and benchmark gates remain
// blocking. Malformed reports still fail closed.
// Exempt via `// @perf-budget-skip` comment in the file.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const THRESHOLD_MS_PER_IT = 200;
const MIN_IT_FOR_EXEMPTION = 3;

/** Check if a file path contains `// @perf-budget-skip` in its first 20 lines. */
function hasSkipComment(fileName) {
  const absPath = resolve(fileName);
  try {
    const head = readFileSync(absPath, 'utf-8').split('\n').slice(0, 20).join('\n');
    return head.includes('@perf-budget-skip');
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidShape(path, expected) {
  throw new Error(`Vitest report shape invalid at ${path}: expected ${expected}`);
}

function validateReport(report, index) {
  if (!isRecord(report)) invalidShape(`report[${index}]`, 'an object');
  if (!Array.isArray(report.testResults)) invalidShape(`report[${index}].testResults`, 'an array');
  return report;
}

/** Parse ndjson or single JSON from stdin. Returns only complete vitest report objects. */
function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) invalidShape('stdin', 'a non-empty JSON report');

  // Try single JSON object (vitest --reporter=json produces one object).
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) invalidShape('root', 'an object or newline-delimited objects');
    return [validateReport(parsed, 0)];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Vitest report shape invalid'))
      throw error;
    // Not single JSON, fall through to ndjson.
  }

  // Try ndjson: one complete JSON object per line.
  const reports = [];
  for (const [index, line] of trimmed.split('\n').entries()) {
    const lt = line.trim();
    if (!lt) continue;
    let parsed;
    try {
      parsed = JSON.parse(lt);
    } catch (error) {
      throw new Error(`Failed to parse JSON line ${index + 1}: ${error.message}`);
    }
    reports.push(validateReport(parsed, index));
  }
  if (reports.length === 0) invalidShape('stdin', 'at least one JSON report');
  return reports;
}

/** Extract per-file metrics from vitest reports. */
function extractFiles(reports) {
  const files = [];
  for (const [reportIndex, report] of reports.entries()) {
    const testResults = report.testResults;
    if (!Array.isArray(testResults)) invalidShape(`report[${reportIndex}].testResults`, 'an array');
    for (const [resultIndex, tr] of testResults.entries()) {
      if (!isRecord(tr))
        invalidShape(`report[${reportIndex}].testResults[${resultIndex}]`, 'an object');
      const name = tr.name;
      if (typeof name !== 'string' || name.trim() === '')
        invalidShape(
          `report[${reportIndex}].testResults[${resultIndex}].name`,
          'a non-empty string',
        );
      let duration = tr.duration;
      if (duration === undefined) {
        const startTime = tr.startTime;
        const endTime = tr.endTime;
        if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime) {
          duration = endTime - startTime;
        }
      }
      if (!Number.isFinite(duration) || duration < 0)
        invalidShape(
          `report[${reportIndex}].testResults[${resultIndex}].duration`,
          'a non-negative number',
        );
      const assertionResults = tr.assertionResults;
      if (!Array.isArray(assertionResults))
        invalidShape(
          `report[${reportIndex}].testResults[${resultIndex}].assertionResults`,
          'an array',
        );
      for (const [assertionIndex, assertion] of assertionResults.entries()) {
        if (!isRecord(assertion))
          invalidShape(
            `report[${reportIndex}].testResults[${resultIndex}].assertionResults[${assertionIndex}]`,
            'an object',
          );
        if (typeof assertion.status !== 'string' || assertion.status.length === 0)
          invalidShape(
            `report[${reportIndex}].testResults[${resultIndex}].assertionResults[${assertionIndex}].status`,
            'a non-empty string',
          );
      }
      const itCount = assertionResults.filter((a) => a.status !== 'todo').length;
      files.push({ name, duration, itCount });
    }
  }
  return files;
}

function main() {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let files;
    try {
      const reports = parseInput(raw);
      files = extractFiles(reports);
    } catch (err) {
      process.stderr.write(`[parse-error] ${err.message}\n`);
      process.exit(2);
    }

    for (const file of files) {
      // @perf-budget-skip exemption.
      if (hasSkipComment(file.name)) continue;

      const itCount = file.itCount;
      const ms = file.duration;

      if (itCount === 0) continue;

      const msPerIt = ms / itCount;

      // Exemption: >= 3 tests in the file (large file, not a merge candidate).
      if (itCount >= MIN_IT_FOR_EXEMPTION) continue;

      // Threshold check.
      if (msPerIt > THRESHOLD_MS_PER_IT) {
        const result = {
          code: 'ci-test-consolidation-candidate',
          expected: 'ms/it <= 200 || it >= 3',
          actual: `${file.name} ${ms.toFixed(0)}ms / ${itCount} it = ${msPerIt.toFixed(0)} ms/it`,
          hint: '\u5408\u5E76\u5230\u540C\u529F\u80FD\u57DF\u6587\u4EF6\uFF08\u53C2\u8003 bind-group-cache-{keying,binding,frame}\uFF09\u6216\u62C6 fixture\uFF08merge into same-domain files like bind-group-cache-{keying,binding,frame} or split fixtures\uFF09',
        };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        // Keep every candidate visible without rejecting correct test runs.
      }
    }

    process.exit(0);
  });

  // Handle no stdin.
  process.stdin.on('close', () => {
    process.exit(0);
  });
}

main();
