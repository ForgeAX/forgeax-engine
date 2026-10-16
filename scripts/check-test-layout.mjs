#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\n')
  .filter(Boolean);

const testFilePattern = /(^|\/)[^/]+\.(?:test-d|test|spec|bench)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const forbiddenDirectoryPattern = /(^|\/)(?:test|tests|__test__)(?:\/|$)/;
const benchmarkPattern = /(^|\/)bench\/[^/]+\.bench\.(?:ts|tsx|js|mjs|cjs)$/;

const testFiles = trackedFiles.filter((file) => testFilePattern.test(file));
const violations = [];

for (const file of testFiles) {
  if (forbiddenDirectoryPattern.test(file)) {
    violations.push(
      `${file}: use __tests__/ instead of a singular or non-underscored test directory`,
    );
    continue;
  }

  if (!/(^|\/)__tests__\//.test(file) && !benchmarkPattern.test(file)) {
    violations.push(`${file}: test-like files must live under __tests__/ or bench/`);
  }
}

if (violations.length > 0) {
  console.error(`test layout: ${violations.length} violation(s)`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  const benchmarkCount = testFiles.filter((file) => benchmarkPattern.test(file)).length;
  console.log(
    `test layout: ${testFiles.length} test-like files valid (${testFiles.length - benchmarkCount} under __tests__, ${benchmarkCount} under bench)`,
  );
}
