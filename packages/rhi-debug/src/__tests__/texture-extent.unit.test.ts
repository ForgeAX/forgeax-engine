import { expect, it } from 'vitest';
import { buildResourceLifecycle } from '../frame-model';
import { snapshotResourceBytes } from '../recorder/core';
import { projectTextureExtent } from '../texel-layout';

it.each(
  [4, [4], { width: 4 }, [4, 1], { width: 4, height: 1 }].map((size) => ({ size })),
)('uses one-row defaults for extent %j across snapshot budgets and lifecycle estimates', ({
  size,
}) => {
  expect(projectTextureExtent(size)).toEqual({ width: 4, height: 1, layerCount: 1 });
  expect(snapshotResourceBytes({ kind: 'texture', size, format: 'rgba8unorm', usage: 6 })).toEqual({
    payload: 16,
    staging: 256,
  });
  const report = buildResourceLifecycle({
    bootstrap: [],
    events: [
      {
        kind: 'createTexture',
        handleId: 'texture',
        desc: { size: typeof size === 'number' ? [size] : size, format: 'rgba8unorm', usage: 6 },
      },
    ],
  });
  expect(report.bytes.knownLive).toBe(16);
});

it.each(
  [
    undefined,
    null,
    [],
    {},
    [0],
    [-1],
    [4, 0],
    [4, 1, 0],
    { width: NaN },
    { width: 1.5 },
    { width: '4' },
  ].map((size) => ({ size })),
)('does not invent dimensions for malformed extent %j', ({ size }) =>
  expect(projectTextureExtent(size)).toBeUndefined());
