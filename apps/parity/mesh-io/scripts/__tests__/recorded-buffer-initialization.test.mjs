import assert from 'node:assert/strict';
import test from 'node:test';
import { recordedBufferInitialization } from '../recorded-buffer-initialization.mjs';

const write = (offset, size) => ({ kind: 'writeBuffer', handleId: 'uniform', bufferOffset: offset, size });
const resource = { resourceId: 'uniform', consumers: [{ access: 'read', workIndex: 0, eventIndex: 2 }] };
test('admits complete original uploads before GPU use and rejects missing, partial, late and holed writes', () => {
  assert.equal(recordedBufferInitialization({ events: [write(0, 80), write(80, 80), {}] }, resource, 160, []).kind, 'recorded-buffer-upload');
  for (const events of [[], [write(0, 80)], [write(0, 80), write(81, 79)], [{}, {}, write(0, 160)], [write(0, 164)]])
    assert.throws(() => recordedBufferInitialization({ events }, resource, 160, []), /initializ/);
  assert.throws(() => recordedBufferInitialization({ events: [{ ...write(0, 160), handleId: 'other' }] }, resource, 160, []), /initializ/);
});

test('resolves GPU binding reads through the work model before admitting an upload', () => {
  const work = [{ eventIndex: 0, bindings: [{ resourceId: 'uniform', access: 'read' }] }];
  assert.throws(() => recordedBufferInitialization({ events: [{}, write(0, 160)] }, { ...resource, consumers: [] }, 160, work), /initializ/);
});
