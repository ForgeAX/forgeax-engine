import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRoster, resolveRunnableEntries } from '../../../../../scripts/ci/run-dawn-smoke-roster.mjs';

const repoRoot = join(fileURLToPath(new URL('../../../../..', import.meta.url)));
const gatePath = join(repoRoot, 'apps/hello/triangle/scripts/ac-08-grep-gate.mjs');

test('AC-08 smoke stance uses roster and manifest ownership without CI duplication', () => {
  const source = readFileSync(gatePath, 'utf8');
  assert.doesNotMatch(source, /ciText\.includes\(target\)/);

  const { runnable, independent } = resolveRunnableEntries({ roster: readRoster() });
  for (const [name, owner] of [
    ['@forgeax/hello-triangle', 'sharded'],
    ['@forgeax/hello-room', 'independent'],
  ]) {
    const gates = [...runnable, ...independent].filter((entry) => entry.package === name);
    assert.equal(gates.length, 1, `${name} has one authoritative gate`);
    assert.equal(gates[0].executionClass, owner);
    assert.equal(gates[0].oracle, 'frameReceipt');
  }

  const output = execFileSync(process.execPath, [gatePath], { encoding: 'utf8' });
  assert.match(output, /\(h\) PASS: _internal_getRawDevice\( call sites confined/);
  assert.match(output, /all 11 gates PASS/);
});
