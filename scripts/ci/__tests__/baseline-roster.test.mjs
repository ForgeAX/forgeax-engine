import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const baselineFixtureFiles = [
  'packages/vite-plugin-pack/src/__tests__/baseline-identity.test.ts',
  'packages/vite-plugin-pack/src/__tests__/baseline-failure-classification.test.ts',
  'scripts/ci/__tests__/baseline-roster.test.mjs',
];

test('M0 fixture roster has no unconditional skipped tests', () => {
  for (const relativePath of baselineFixtureFiles) {
    const source = readFileSync(resolve(root, relativePath), 'utf8');
    assert.equal(
      source.match(/\b(?:describe|test|it)\.skip\s*\(/g)?.length ?? 0,
      0,
      `${relativePath} contains an unconditional skipped test`,
    );
  }
});

test('M0 fixture roster remains in the prescribed test directories', () => {
  for (const relativePath of baselineFixtureFiles) {
    assert.match(
      relativePath,
      /(?:packages\/vite-plugin-pack\/src\/__tests__|scripts\/ci\/__tests__)\//,
    );
  }
});
