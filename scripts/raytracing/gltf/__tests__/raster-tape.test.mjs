import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rasterInitialization } from '../raster-tape.mjs';

function model(usage = 9, offset = 0, size = 5104) {
  return {
    unseededResources: [{ resourceId: 'buffer:4', kind: 'buffer' }],
    resources: [{ resourceId: 'buffer:4', descriptor: { desc: { size: 8192, usage } } }],
    works: [],
    commands: [
      {
        kind: 'copyBufferToBuffer',
        eventIndex: 10,
        params: {
          sourceHandleId: 'buffer:3',
          destinationHandleId: 'buffer:4',
          sourceOffset: 0,
          destinationOffset: offset,
          size,
        },
      },
    ],
  };
}

test('timing readback permits only an unused output staging tail', () => {
  const result = rasterInitialization(model())[0];
  assert.equal(result.initializedBytes, 5104);
  assert.equal(result.allocationBytes, 8192);
  assert.equal(result.uninitializedTailBytes, 3088);
});

test('GPU input buffers still require the complete allocation', () => {
  assert.throws(() => rasterInitialization(model(136)), /not fully initialized/);
  assert.equal(rasterInitialization(model(136, 0, 8192))[0].initializedBytes, 8192);
});

test('staging classification cannot hide a prefix gap or a GPU consumer', () => {
  assert.throws(() => rasterInitialization(model(9, 4)), /Uninitialized buffer gap/);
  const bound = model();
  bound.works.push({ eventIndex: 20, workIndex: 1, bindings: [{ resourceId: 'buffer:4' }] });
  assert.throws(() => rasterInitialization(bound), /not fully initialized/);
  const copied = model();
  copied.commands.push({
    kind: 'copyBufferToBuffer',
    eventIndex: 20,
    params: {
      sourceHandleId: 'buffer:4',
      destinationHandleId: 'buffer:5',
      sourceOffset: 0,
      destinationOffset: 0,
      size: 8192,
    },
  });
  assert.throws(() => rasterInitialization(copied), /not fully initialized/);
});
