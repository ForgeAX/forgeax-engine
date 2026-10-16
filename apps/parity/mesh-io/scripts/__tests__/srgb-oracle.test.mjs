import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesSourceSrgb, sourceSrgbInterval } from '../srgb-oracle.mjs';

test('accepts actual DX12 conversion within the specified native precision', () => {
  assert.ok(matchesSourceSrgb([.00701904296875, .71484375, .045166015625], [20, 220, 60], .0005));
});

test('rejects missing sRGB decode, swapped quadrants and nonfinite output', () => {
  assert.equal(matchesSourceSrgb([20 / 255, 220 / 255, 60 / 255], [20, 220, 60], .0005), false);
  assert.equal(matchesSourceSrgb([1, .021219, .006995], [20, 220, 60], .0005), false);
  assert.equal(matchesSourceSrgb([NaN, .71484375, .045166], [20, 220, 60], .0005), false);
});

test('does not grant conversion error at exact endpoints or outside the specified interval', () => {
  assert.deepEqual(sourceSrgbInterval(0, 0), [0, 0]);
  assert.deepEqual(sourceSrgbInterval(255, 0), [1, 1]);
  for (const byte of [20, 40, 60, 80, 200, 220, 240]) {
    const [min, max] = sourceSrgbInterval(byte, .0005);
    assert.equal(matchesSourceSrgb([min - .000001], [byte], .0005), false);
    assert.equal(matchesSourceSrgb([max + .000001], [byte], .0005), false);
  }
});
