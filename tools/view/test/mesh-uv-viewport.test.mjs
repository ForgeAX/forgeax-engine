import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fitUvViewport, panUvViewport, uvAtPoint, uvBounds, uvTransform, zoomUvViewport,
} from '../packages/view-plugin-mesh/src/ui/uv-viewport.ts';

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const layout = { coordinates: [-2, -3, 4, 5, 0.25, 0.75, 99999, -99999], triangleIndices: [0, 1, 2] };

test('UV bounds include the unit reference and every referenced vertex, excluding unused outliers', () => {
  assert.deepEqual(uvBounds(layout), { minU: -2, minV: -3, maxU: 4, maxV: 5 });
  assert.deepEqual(uvBounds({ coordinates: [0.25, 0.3, 0.7, 0.8], triangleIndices: [0, 1, 0] }), { minU: 0, minV: 0, maxU: 1, maxV: 1 });
});

test('full framing keeps negative and overflowing UVs inside padded canvases at each DPR', () => {
  const bounds = uvBounds(layout);
  const points = [[0, 0], [1, 1], [-2, -3], [4, 5], [0.25, 0.75]];
  for (const size of [{ width: 280, height: 248 }, { width: 900, height: 180 }, { width: 80, height: 640 }]) {
    const transform = uvTransform(bounds, size, null);
    for (const ratio of [1, 2]) {
      for (const [u, v] of points) {
        const x = (u * transform.scale + transform.x) * ratio;
        const y = (v * transform.scale + transform.y) * ratio;
        assert(x >= 8 * ratio - 1e-9 && x <= (size.width - 8) * ratio + 1e-9);
        assert(y >= 8 * ratio - 1e-9 && y <= (size.height - 8) * ratio + 1e-9);
      }
    }
    const origin = uvAtPoint(transform, { x: transform.x, y: transform.y });
    close(origin.u, 0); close(origin.v, 0);
    assert(transform.scale > 0, 'V continues downward with the Engine UV convention');
  }
});

test('empty and degenerate layouts retain a finite reference frame', () => {
  for (const input of [{ coordinates: [], triangleIndices: [] }, { coordinates: [2, 2], triangleIndices: [0, 0, 0] }]) {
    const bounds = uvBounds(input);
    for (const size of [{ width: 0, height: 0 }, { width: 280, height: 240 }])
      assert(Object.values(uvTransform(bounds, size, null)).every(Number.isFinite));
    assert.equal(fitUvViewport(bounds).zoom, 1);
  }
  assert.throws(() => uvBounds({ coordinates: [0, Number.NaN], triangleIndices: [0] }));
  assert.throws(() => uvBounds({ coordinates: [0, 0], triangleIndices: [9] }));
});

test('zoom preserves the cursor UV anchor, including both zoom limits', () => {
  const bounds = uvBounds(layout), size = { width: 280, height: 240 };
  for (const point of [{ x: 29, y: 53 }, { x: 140, y: 120 }, { x: 249, y: 209 }]) {
    let viewport = null;
    for (const delta of [-300, 200, -1e9, 1e9]) {
      const before = uvAtPoint(uvTransform(bounds, size, viewport), point);
      viewport = zoomUvViewport(bounds, size, viewport, point, delta);
      const after = uvAtPoint(uvTransform(bounds, size, viewport), point);
      close(before.u, after.u); close(before.v, after.v);
      assert(viewport.zoom >= 1 / 32 && viewport.zoom <= 1024);
    }
    assert.equal(viewport.zoom, 1 / 32);
  }
});

test('pan follows pixel displacement without changing scale or source coordinates', () => {
  const beforeSource = structuredClone(layout);
  const bounds = uvBounds(layout), size = { width: 280, height: 240 };
  const before = uvTransform(bounds, size, null);
  const viewport = panUvViewport(bounds, size, null, 45, -27);
  const after = uvTransform(bounds, size, viewport);
  close(after.x - before.x, 45); close(after.y - before.y, -27);
  close(after.scale, before.scale);
  assert.deepEqual(layout, beforeSource);
});

test('resizing retains UV center and relative zoom while reset fits the full layout again', () => {
  const bounds = uvBounds(layout);
  const viewport = { centerU: -0.75, centerV: 2, zoom: 3 };
  for (const size of [{ width: 280, height: 240 }, { width: 440, height: 180 }]) {
    const transform = uvTransform(bounds, size, viewport);
    const center = uvAtPoint(transform, { x: size.width / 2, y: size.height / 2 });
    close(center.u, viewport.centerU); close(center.v, viewport.centerV);
    close(transform.scale / uvTransform(bounds, size, null).scale, 3);
    const reset = uvTransform(bounds, size, null);
    const min = { x: bounds.minU * reset.scale + reset.x, y: bounds.minV * reset.scale + reset.y };
    assert(min.x >= 8 - 1e-9 && min.y >= 8 - 1e-9);
  }
});
