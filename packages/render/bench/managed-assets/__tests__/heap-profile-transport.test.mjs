import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { test } from 'node:test';
import { decodeProfileMessage } from '../heap-profile-transport.mjs';

test('retains normal CDP replies and every allocation sample', () => {
  assert.deepEqual(decodeProfileMessage(Buffer.from('{"id":2,"result":{}}')), { id: 2, result: {} });
  const samples = [{ size: 32768, nodeId: 4, ordinal: 9 }, { size: 65536, nodeId: 2, ordinal: 10 }];
  const message = { id: 5, result: { profile: { head: { id: 1, children: [] }, samples } } };
  const decoded = decodeProfileMessage(Buffer.from(JSON.stringify(message)));
  assert.deepEqual([...decoded.result.profile.samples], samples);
  assert.deepEqual(decoded.result.profile.head, message.result.profile.head);
  assert.equal(decoded.id, message.id);
});

test('rejects truncated profiles instead of accepting partial evidence', () => {
  assert.throws(() => decodeProfileMessage(Buffer.from('{"id":1,"result":{"profile":{"head":{},"samples":[{')));
  const decoded = decodeProfileMessage(Buffer.from('{"id":1,"result":{"profile":{"head":{},"samples":[{"size":"missing","nodeId":1,"ordinal":1}]}}}'));
  assert.throws(() => [...decoded.result.profile.samples], /Invalid CDP allocation sample/);
});

test('decodes a complete allocation response larger than the V8 string limit', () => {
  const prefix = Buffer.from('{"id":4,"result":{"profile":{"head":{"id":1,"children":[]},"samples":[');
  const sample = Buffer.from('{"size":32768,"nodeId":1,"ordinal":2},');
  const count = Math.ceil((constants.MAX_STRING_LENGTH + 1048576) / sample.length);
  const bytes = Buffer.allocUnsafe(prefix.length + count * sample.length + 3);
  prefix.copy(bytes);
  bytes.fill(sample, prefix.length, prefix.length + count * sample.length);
  Buffer.from(']}}}').copy(bytes, prefix.length + count * sample.length - 1);
  assert.throws(() => bytes.toString(), { code: 'ERR_STRING_TOO_LONG' });
  let decodedCount = 0, allocationBytes = 0;
  for (const item of decodeProfileMessage(bytes).result.profile.samples) {
    decodedCount++;
    allocationBytes += item.size;
  }
  assert.equal(decodedCount, count);
  assert.equal(allocationBytes, count * 32768);
});
