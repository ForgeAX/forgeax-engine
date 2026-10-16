import assert from 'node:assert/strict';
import test from 'node:test';
import { parseObservedFrameReceipt } from '../run-dawn-smoke-roster.mjs';

const identity = { gateId: 'hello/direct-dawn', commandId: 'smoke' };

function receiptLine(framesObserved, overrides = {}) {
  return `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    ...identity,
    framesObserved,
    completed: true,
    ...overrides,
  })}`;
}

test('only one gate-specific receipt is an observed frame fact', () => {
  const receipt = parseObservedFrameReceipt(receiptLine(60), identity);
  assert.equal(receipt.framesObserved, 60);
  assert.equal(receipt.completed, true);
  assert.equal('framesExpected' in receipt, false);
  assert.equal(receipt.parserId, 'forgeax-smoke-receipt-v1');
});

test('strict legacy adapter accepts an explicit frame line plus producer PASS', () => {
  const receipt = parseObservedFrameReceipt(
    '[smoke] frames observed=60 (wall=5302ms, target=60)\n[smoke] PASS - frames=60',
    identity,
  );
  assert.equal(receipt.framesObserved, 60);
  assert.equal(receipt.evidenceSource, 'legacy-smoke-output');
  assert.match(receipt.frameEvidenceLine, /frames observed=60/);
  assert.match(receipt.passEvidenceLine, /PASS/);
});

for (const [name, output] of [
  ['expected-only output', 'framesExpected: 60'],
  ['environment-only output', 'SMOKE_MIN_FRAMES=60'],
  ['unrelated frame number', '999 frames'],
  ['short receipt', receiptLine(59)],
  ['wrong gate', receiptLine(300, { gateId: 'other/gate' })],
  ['wrong command', receiptLine(300, { commandId: 'other-command' })],
  ['incomplete receipt', receiptLine(300, { completed: false })],
  ['legacy frame without PASS', '[smoke] frames observed=60'],
  ['legacy target number without observed frame', '[smoke] PASS - target=60'],
  [
    'legacy deferred frame',
    '[smoke] frames observed=60\n[smoke] env-deferred=no-adapter\n[smoke] PASS',
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseObservedFrameReceipt(output, identity), /receipt|frame|gate|command/i);
  });
}

test('rejects multiple receipts instead of selecting a maximum', () => {
  const output = `${receiptLine(300)}\n${receiptLine(301)}`;
  assert.throws(() => parseObservedFrameReceipt(output, identity), /multiple|receipt/i);
});
