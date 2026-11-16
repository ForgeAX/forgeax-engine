import { describe, expect, it, vi } from 'vitest';
import { buildWaterMeshView, type WaterMeshBuildInput } from '../water-mesh.js';
import { WATER_MESH_INSTANCE_LAYOUT, WATER_MESH_INSTANCE_STRIDE_BYTES } from '../water-mesh-abi.js';

const input: WaterMeshBuildInput = {
  zoneGuid: 'zone',
  zoneGeneration: 1,
  originXZ: [0, 0],
  extentM: [64, 64],
  tileSizeM: 8,
  tessellationFactor: 2,
  lodScale: 1,
  bodies: [
    {
      guid: 'ocean',
      generation: 1,
      type: 'ocean',
      visible: true,
      affectsWaterMesh: true,
      priority: 0,
      materialKey: 'water',
      waveOriginXZ: [0, 0],
      baseHeightM: 0,
      maxWaveHeightM: 0,
      polygon: {
        outer: [
          [-2.125, -3.5],
          [61.125, -3.5],
          [61.125, 60.75],
          [-2.125, 60.75],
        ],
        holes: [
          [
            [20.125, 20.75],
            [20.125, 28.75],
            [28.125, 28.75],
            [28.125, 20.75],
          ],
        ],
      },
    },
  ],
};

function build(observerM: readonly [number, number, number]) {
  return buildWaterMeshView(input, { viewId: 'serialization', observerM }).unwrap();
}

function expectCoverage(view: ReturnType<typeof build>) {
  const data = new DataView(view.instanceBytes.buffer, view.instanceBytes.byteOffset);
  const expected = new Uint8Array(view.coverageBytes.byteLength);
  const coverage = new DataView(expected.buffer);
  let word = 0;
  for (const [index, instance] of view.instances.entries()) {
    const rings = instance.far ? undefined : instance.coverageRings;
    if (!rings?.length) continue;
    const offset = index * WATER_MESH_INSTANCE_STRIDE_BYTES;
    expect(
      data.getUint32(offset + WATER_MESH_INSTANCE_LAYOUT.offsets.coverageWordOffset, true),
    ).toBe((view.instances.length * WATER_MESH_INSTANCE_STRIDE_BYTES) / 4 + word);
    expect(
      data.getUint32(offset + WATER_MESH_INSTANCE_LAYOUT.offsets.coverageRingCount, true),
    ).toBe(rings.length);
    coverage.setUint32(word++ * 4, rings.length, true);
    for (const ring of rings) coverage.setUint32(word++ * 4, ring.length, true);
    for (const ring of rings)
      for (const point of ring)
        for (const value of point) coverage.setFloat32(word++ * 4, value, true);
  }
  expect(view.coverageBytes).toEqual(expected);
}

describe('WaterMesh complete serialization owner', () => {
  it('does not allocate four-byte backing per coverage coordinate', () => {
    const Original = globalThis.ArrayBuffer;
    let tinyBackings = 0;
    vi.stubGlobal(
      'ArrayBuffer',
      new Proxy(Original, {
        construct(target, args) {
          if (args[0] === 4) tinyBackings++;
          return Reflect.construct(target, args);
        },
      }),
    );
    let result: ReturnType<typeof build>;
    try {
      result = build([3.7, 8, 20.3]);
    } finally {
      vi.unstubAllGlobals();
    }
    expectCoverage(result);
    expect(result.coverageBytes.byteLength).toBeGreaterThan(4);
    expect(tinyBackings).toBe(0);
  });

  it('retains complete little-endian coverage, receipt hashes and detached old results', () => {
    const previous = build([3.7, 8, 20.3]);
    const bytes = previous.instanceBytes.slice(),
      coverage = previous.coverageBytes.slice();
    const layout = structuredClone(previous.layout);
    const draws = previous.buckets
      .flatMap((bucket) => bucket.ownerDraws)
      .map((draw) => ({
        draw,
        bytes: draw.instanceBytes.slice(),
        coverage: draw.coverageBytes.slice(),
        layout: structuredClone(draw.layout),
      }));
    expectCoverage(previous);
    const next = build([-25.5, 18, 50.25]);
    expectCoverage(next);
    expect(next.instanceBytes.buffer).not.toBe(previous.instanceBytes.buffer);
    expect(next.coverageBytes.buffer).not.toBe(previous.coverageBytes.buffer);
    expect(previous.instanceBytes).toEqual(bytes);
    expect(previous.coverageBytes).toEqual(coverage);
    expect(previous.layout).toEqual(layout);
    for (const held of draws) {
      expect(held.draw.instanceBytes).toEqual(held.bytes);
      expect(held.draw.coverageBytes).toEqual(held.coverage);
      expect(held.draw.layout).toEqual(held.layout);
    }
  });
});
