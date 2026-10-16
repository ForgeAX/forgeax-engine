import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry.js';

function mesh(vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])): MeshAsset {
  return {
    kind: 'mesh',
    vertices,
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: vertices },
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'default', sourceKey: 'default' }],
  };
}

it.each([
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
])('rejects nonfinite vertices across the entire payload without retaining candidate credit (%s)', (invalid) => {
  const lifecycle = createDynamicGeometryLifecycle();
  try {
    for (const index of [0, 524287, 1048588]) {
      const vertices = new Float32Array(1048589);
      vertices[index] = invalid;
      expect(lifecycle.prepare({ world: {}, mesh: mesh(vertices), revision: 1 }, 1)).toMatchObject({
        ok: false,
        error: { code: 'dynamic-geometry-invalid', hint: 'MeshAsset.vertices must be finite' },
      });
      expect(lifecycle.inspect().prepared).toBe(0);
      expect(lifecycle.inspect().meshBytes).toBe(0);
    }
  } finally {
    lifecycle.dispose();
  }
});

it('checks only the supplied typed-array view and revalidates the same source after mutation', () => {
  const storage = new Float32Array(17).fill(Number.NaN);
  const vertices = storage.subarray(4, 13);
  vertices.fill(0);
  const source = mesh(vertices),
    lifecycle = createDynamicGeometryLifecycle();
  try {
    const first = lifecycle.prepare({ world: {}, mesh: source, revision: 1 }, 1).unwrap();
    lifecycle.cancel(first).unwrap();
    vertices[8] = Number.POSITIVE_INFINITY;
    expect(lifecycle.prepare({ world: {}, mesh: source, revision: 2 }, 1)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-invalid' },
    });
    vertices[8] = 0;
    expect(lifecycle.prepare({ world: {}, mesh: source, revision: 3 }, 1).ok).toBe(true);
  } finally {
    lifecycle.dispose();
  }
});

it('retains borrowed vertex observations and native detached-buffer rejection', () => {
  const source = mesh(),
    live = source.vertices;
  const detached = new Float32Array(9);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  let reads = 0;
  Object.defineProperty(source, 'vertices', { get: () => (++reads < 3 ? live : detached) });
  const lifecycle = createDynamicGeometryLifecycle();
  try {
    expect(() => lifecycle.prepare({ world: {}, mesh: source, revision: 1 }, 1)).toThrow(TypeError);
    expect(reads).toBe(3);
    expect(lifecycle.inspect().prepared).toBe(0);
    expect(lifecycle.inspect().meshBytes).toBe(0);
  } finally {
    lifecycle.dispose();
  }
});
