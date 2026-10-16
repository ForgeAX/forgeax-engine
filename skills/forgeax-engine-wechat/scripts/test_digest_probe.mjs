import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const { values } = parseArgs({ options: { bundle: { type: 'string' } } });
if (!values.bundle) throw Error('node test_digest_probe.mjs --bundle BUILT_GAME_JS');
const source = await readFile(values.bundle, 'utf8');

async function run(crypto, configurable = true, fastTimeout = false) {
  const realm = { console: { info() {} }, setTimeout: (callback, delay) =>
    setTimeout(callback, fastTimeout && delay === 2000 ? 2 : delay), clearTimeout };
  Object.defineProperty(realm, 'crypto', { value: crypto, configurable, writable: configurable });
  runInNewContext(source, realm);
  const probe = realm.__forgeaxDigestProbe;
  assert.equal(probe.read().phase, 'ready');
  probe.start();
  probe.start();
  const deadline = Date.now() + 3000;
  while (probe.read().phase === 'running' && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 2));
  const report = JSON.parse(JSON.stringify(probe.read()));
  assert.equal(report.phase, 'complete');
  assert.equal(report.results.length, 4);
  assert.equal(realm.crypto, crypto);
  return report;
}

test('uses the bundled real digest owner for WebCrypto and forced JS at both sizes', async () => {
  const report = await run(webcrypto);
  assert.equal(report.passed, true);
  assert.deepEqual(report.results.map(row => row.selected), ['webcrypto', 'webcrypto', 'js', 'js']);
  assert.deepEqual(report.results.map(row => row.size), [64, 1048576, 64, 1048576]);
});

test('reports natural JS selection when the native host supplies no WebCrypto', async () => {
  const report = await run(undefined);
  assert.equal(report.passed, true);
  assert.ok(report.results.every(row => row.selected === 'js' && row.matches));
});

test('retains natural-provider timeouts and still runs the same owner fallback', async () => {
  const report = await run({ subtle: { digest: () => new Promise(() => {}) } }, true, true);
  assert.equal(report.passed, false);
  assert.deepEqual(report.results.map(row => row.status), ['timeout', 'timeout', 'completed', 'completed']);
  assert.ok(report.results.slice(2).every(row => row.matches));
});

test('preserves a host crypto descriptor that cannot be shadowed', async () => {
  const report = await run(webcrypto, false);
  assert.deepEqual(report.results.map(row => row.status), ['completed', 'completed', 'unsupported', 'unsupported']);
});
