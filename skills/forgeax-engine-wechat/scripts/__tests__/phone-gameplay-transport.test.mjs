import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../phone_gameplay_transport.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export function', 'function');

function fixture({ diagnostic = true, canShow = true, failures = 1 } = {}) {
  const artifacts = [], modals = [], sends = [];
  const report = { kind: 'forgeax-phone-gameplay', status: 'partial', source: { original: 'source' },
    readiness: { renderer: { phase: 'ready' }, player: { position: [0, 1, 0] } } };
  const native = { request(options) { options.fail({ errMsg: 'request:fail exact native domain error', errno: 600001 }); },
    showModal(options) { modals.push(options); } };
  const context = vm.createContext({ Date, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), clearTimeout,
    persistPhoneReport(_wx, value, label) {
      artifacts.push({ label, value: structuredClone(value) });
      value.artifact = { status: 'saved', path: '/private/original-report.json' };
      return { body: JSON.stringify(artifacts.at(-1).value), sha256: 'same-payload-hash', bytes: 123 };
    },
    sendPhoneReport(_wx, _options, value, payload) {
      sends.push(payload);
      value.transfer = { status: sends.length <= failures ? 'failed' : 'sent' };
    },
  });
  vm.runInContext(source, context);
  const transport = context.createPhoneGameplayTransport({ controlUrl: 'http://127.0.0.1:1234/run',
    runId: 'transport-contract', source: report.source, transportDiagnostic: diagnostic }, native, report,
  { now: () => 123, canShow: () => canShow });
  return { transport, report, artifacts, modals, sends };
}

test('first native error and original readiness persist before the receiver is available', async () => {
  const f = fixture();
  await assert.rejects(f.transport.request('ready', {}), /exact native domain error/);
  await assert.rejects(f.transport.request('ready', {}), /exact native domain error/);
  assert.equal(f.report.connection.firstNativeError.native.errno, 600001);
  assert.equal(f.artifacts.length, 1);
  assert.equal(f.artifacts[0].value.readiness.renderer.phase, 'ready');
  assert.equal(f.modals.length, 1);
  assert.equal(f.modals[0].content, 'request:fail exact native domain error');
});

test('explicit modal covers an early readiness failure but never an active window', () => {
  const early = fixture();
  early.transport.failure(new Error('Original renderer failure'), 'readiness');
  assert.equal(early.modals[0].content, 'Original renderer failure');
  assert.equal(early.artifacts[0].value.connection.firstError.original.message, 'Original renderer failure');
  for (const f of [fixture({ canShow: false }), fixture({ diagnostic: false })]) {
    f.transport.failure(new Error('retained without UI'), 'readiness');
    assert.equal(f.modals.length, 0);
    assert.equal(f.artifacts.length, 1);
  }
});

test('final delivery retries the identical payload and digest without changing original failure', async () => {
  const f = fixture({ failures: 2 });
  f.report.failure = 'original game failure';
  await f.transport.finish();
  assert.equal(f.artifacts.length, 1);
  assert.equal(f.sends.length, 3);
  assert.ok(f.sends.every((payload) => payload === f.sends[0]));
  assert.equal(f.report.failure, 'original game failure');
  assert.equal(f.report.transfer.status, 'sent');
});
