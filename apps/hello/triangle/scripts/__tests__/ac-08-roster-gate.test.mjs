import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('../../../../..', import.meta.url)));
const gatePath = join(repoRoot, 'apps/hello/triangle/scripts/ac-08-grep-gate.mjs');

test('AC-08 smoke stance uses roster and manifest ownership without CI duplication', () => {
  const source = readFileSync(gatePath, 'utf8');
  assert.match(source, /readRoster, resolveRunnableEntries/);
  assert.match(source, /artifactRequirements|executionClass !== 'sharded'/);
  assert.doesNotMatch(source, /ciText\.includes\(target\)/);

  const output = execFileSync(process.execPath, [gatePath], { encoding: 'utf8' });
  assert.match(output, /\(e\) PASS: @forgeax\/hello-triangle has one authoritative/);
  assert.match(output, /\(e2\) PASS: @forgeax\/hello-cube has one authoritative/);
  assert.match(output, /\(f\) PASS: authoritative roster proves unique sharded triangle\/cube gates/);
  assert.match(output, /all 14 gates PASS/);
});
