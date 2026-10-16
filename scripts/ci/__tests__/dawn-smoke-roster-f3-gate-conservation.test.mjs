import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { readRoster } from '../run-dawn-smoke-roster.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

test('roster represents multiple stable gates under one package', () => {
  const roster = readRoster();
  const skin = roster.entries.find((entry) => entry.package === '@forgeax/hello-skin');
  assert.ok(skin, 'hello-skin must remain in the authoritative roster');
  assert.ok(Array.isArray(skin.gates));
  assert.deepEqual(
    skin.gates.map((gate) => gate.gateId),
    ['hello-skin/direct-dawn', 'hello-skin/writeback'],
  );
});

test('roster includes supplemental roots-outside gates', () => {
  const roster = readRoster();
  assert.ok(
    roster.entries.some(
      (entry) =>
        entry.classification === 'supplemental' && entry.path === 'apps/collectathon/package.json',
    ),
  );
  assert.ok(
    roster.entries.some(
      (entry) =>
        entry.classification === 'supplemental' &&
        entry.path === 'apps/shadertoy/happy-blob/package.json',
    ),
  );
});

test('workflow keeps independent domain gates outside the sharded runner', () => {
  for (const command of [
    'pnpm --filter @forgeax/hello-skin smoke:writeback',
    'pnpm --filter @forgeax/hello-m7-backend-recovery smoke',
    'pnpm --filter @forgeax/hello-taa smoke:webgl2',
    'pnpm --filter @forgeax/hello-taa smoke:rhinull',
    'pnpm --filter @forgeax/hello-taa smoke:falsify',
    'pnpm --filter @forgeax/hello-taa smoke:performance',
    'node apps/hello/triangle/scripts/smoke-coverage-gate.mjs',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  }
});

test('workflow preserves roots-outside build and smoke gates', () => {
  for (const command of [
    'pnpm --filter @forgeax/engine-shadertoy-happy-blob smoke',
    'pnpm --filter @forgeax/collectathon smoke',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(workflow, /pnpm --filter @forgeax\/engine-shadertoy-happy-blob build/);
});

test('workflow-owned direct Dawn gates are not executed a second time by the sharded roster', () => {
  const roster = readRoster();
  const escapeRegex = (value) => value.replaceAll(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const smokeStart = workflow.indexOf('  smoke-fleet:\n');
  const smokeEnd = workflow.indexOf('\n  smoke-fleet-required-context:', smokeStart);
  assert.ok(smokeStart >= 0 && smokeEnd > smokeStart, 'smoke-fleet job must remain present');
  const smokeFleet = workflow.slice(smokeStart, smokeEnd);
  const commandOccurrences = (entry, gate, source) => {
    const script = gate.script === undefined ? 'smoke' : gate.script;
    const pattern = new RegExp(
      `pnpm --filter ['"]?${escapeRegex(entry.package)}['"]? ${escapeRegex(script)}(?:\\s|$)`,
    );
    return source.split('\n').filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && pattern.test(trimmed);
    }).length;
  };
  const workflowOwns = (entry, gate) => commandOccurrences(entry, gate, workflow) > 0;
  const owned = roster.entries.flatMap((entry) =>
    entry.gates
      .filter((gate) => gate.executionClass !== 'excluded' && workflowOwns(entry, gate))
      .map((gate) => ({ entry, gate })),
  );
  assert.ok(owned.length > 0, 'the workflow-owned roster must not be empty');
  assert.ok(owned.every(({ gate }) => gate.executionClass === 'independent'));
  for (const { entry, gate } of owned) {
    assert.equal(
      commandOccurrences(entry, gate, smokeFleet),
      1,
      `${gate.gateId} must have exactly one smoke-fleet owner`,
    );
  }
  assert.equal(
    roster.entries.flatMap((entry) =>
      entry.gates.filter((gate) => gate.executionClass === 'sharded' && workflowOwns(entry, gate)),
    ).length,
    0,
  );
});
