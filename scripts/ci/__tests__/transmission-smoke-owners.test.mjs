import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildSmokeRoster, executeSmokeRoster } from '../../rhi-debug-smoke-roster.mjs';
import { readRoster, resolveRunnableEntries } from '../run-dawn-smoke-roster.mjs';

const root = resolve(import.meta.dirname, '../../..');
const packageName = '@forgeax/app-learn-render-6-pbr-4-transmission-refraction';
const roster = buildSmokeRoster(join(root, 'apps/hello'), join(root, 'apps/learn-render'), 300);
const owners = roster.entries.filter((entry) => entry.package === packageName);

test('RHI Debug derives the three mandatory Smoke commands from the canonical roster', () => {
  const canonical = resolveRunnableEntries({
    repoRoot: root,
    roster: readRoster(),
  }).runnable.filter((entry) => entry.package === packageName);
  assert.deepEqual(
    owners.map((entry) => [entry.gateId, entry.commandId, entry.command, entry.oracle]),
    canonical.map((entry) => [entry.gateId, entry.commandId, entry.command, entry.oracle]),
  );
  assert.deepEqual(
    owners.map((entry) => entry.script),
    ['smoke:features-a', 'smoke:features-b', 'smoke:frames'],
  );
  assert.deepEqual(
    owners.map((entry) => entry.frames),
    [null, null, 300],
  );
  const manifest = JSON.parse(
    readFileSync(
      join(root, 'apps/learn-render/6.pbr/4.transmission-refraction/package.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.scripts.smoke, 'node scripts/smoke-dawn.mjs');
  assert.equal(manifest.forgeax.smokeInvocation, `pnpm --filter ${packageName} smoke`);
});

// Fixture startup is not the timeout contract; the explicit hanging case owns that check.
function execute(entry, source, timeoutMs = 5000) {
  return executeSmokeRoster(
    {
      ...roster,
      unavailable: [],
      entries: [{ ...entry, tokens: [process.execPath, '-e', source] }],
    },
    { cwd: root, timeoutMs },
  );
}

const receiptOutput =
  '[smoke] frames observed=300\n[smoke] PASS - transmission stability frames=300\n';
const writeReceipt = `require('node:fs').writeSync(1, ${JSON.stringify(receiptOutput)});`;

test('RHI frame owner consumes the requested budget and untruncated producer receipt', () => {
  const result = execute(
    owners[2],
    `process.stdout.write(${JSON.stringify(`${'x'.repeat(4500)}\n`)});${writeReceipt} if(process.env.SMOKE_MIN_FRAMES !== '300') process.exit(9);`,
  );
  assert.equal(result.status, 'passed');
  assert.equal(result.entries[0].frames, 300);
  assert.equal(result.entries[0].receipt.framesObserved, 300);
  assert.match(result.entries[0].stdout, /truncated/);
});

for (const [label, source, timeoutMs] of [
  ['missing receipt', "console.log('completed without evidence')", 1000],
  ['short receipt', writeReceipt.replaceAll('300', '299'), 1000],
  ['failed exit after valid receipt', `${writeReceipt}process.exit(7);`, 1000],
  [
    'timeout after valid receipt',
    // Delayed output must precede the real timeout; Node startup speed is not the contract.
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);${writeReceipt}setInterval(() => {}, 1000);`,
    5000,
  ],
]) {
  test(`RHI frame owner rejects ${label} without accepted frame credit`, () => {
    const result = execute(owners[2], source, timeoutMs);
    assert.equal(result.status, 'failed');
    assert.equal(result.entries[0].frames, null);
    assert.equal(result.entries[0].receipt, null);
    if (label.includes('after valid'))
      assert.match(result.entries[0].stdout, /frames observed=300/);
    if (label === 'timeout after valid receipt') {
      assert.equal(result.entries[0].returnCode, null);
      assert.equal(result.entries[0].signal, 'SIGTERM');
      assert.equal(result.entries[0].receiptFailure, null);
    }
  });
}

test('RHI assertion owners never receive frame credit and preserve nonzero failures', () => {
  for (const entry of owners.slice(0, 2)) {
    for (const code of [0, 7]) {
      const result = execute(entry, `${writeReceipt}process.exit(${code});`);
      assert.equal(
        result.status,
        code === 0 ? 'passed' : 'failed',
        JSON.stringify(result.entries[0]),
      );
      assert.equal(result.entries[0].returnCode, code);
      assert.equal(result.entries[0].signal, null);
      assert.equal(result.entries[0].frames, null);
      assert.equal(result.entries[0].receipt, null);
    }
  }
});

test('a foreign transmission manifest cannot silently borrow this checkout canonical owners', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'foreign-transmission-roster-'));
  try {
    const directory = join(fixture, 'apps/learn-render/transmission');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: packageName,
        scripts: { smoke: 'node foreign-smoke.mjs' },
        forgeax: { smokeInvocation: `pnpm --filter ${packageName} smoke` },
      }),
    );
    const result = buildSmokeRoster(
      join(root, 'apps/hello'),
      join(fixture, 'apps/learn-render'),
      300,
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(
      result.entries.some((entry) => entry.package === packageName),
      false,
    );
    assert.match(
      result.unavailable.find((entry) => entry.package === packageName).reason,
      /this Engine checkout/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
