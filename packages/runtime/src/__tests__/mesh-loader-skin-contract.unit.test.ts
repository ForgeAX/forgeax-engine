// mesh-loader-skin-contract.unit.test.ts -- feat-20260611-fox-skinning-vertex-
// attribute-chain M3 / w14: AC-05 dual-contract verification.
//
// meshLoader.load now accepts skinIndex (Uint16Array) / skinWeight
// (Float32Array) AND their JSON-roundtrip number[] shapes (post-
// JSON.stringify(pack) -> fetch -> JSON.parse on the dev-server / build-mode
// pack-body path). This file isolates the dual contract via direct meshLoader
// invocation -- dawn smoke walks register() and never touches the
// JSON-roundtrip path that shipped Fox.glb red on the browser path.
//
// AC-05: after JSON.stringify -> JSON.parse, meshLoader.load() returns a
// MeshAsset whose attributes.skinIndex instanceof Uint16Array and
// attributes.skinWeight instanceof Float32Array, with values element-wise
// equal to the original typed arrays.
//
// Anchors: requirements AC-05; plan-strategy D-7; research E-6 (PR #350
// skeletonLoader pattern); risk R-2 (mesh-loader dual-contract gap surfaces
// only on the browser pack-body path).

import { meshLoader } from '@forgeax/engine-assets-runtime';
import type { LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function makeCtx(): LoadContext {
  return {
    fetchBinary: () =>
      Promise.resolve({ ok: false as const, error: new Error('not used in unit') }),
    resolveRef: () => Promise.resolve({ ok: false as const, error: new Error('not used in unit') }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

describe('feat-20260611 / M3 / w14 - meshLoader skinIndex/skinWeight dual contract', () => {
  it('AC-05 (a) accepts native typed arrays directly', () => {
    const N = 4;
    const skinIndex = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
    const skinWeight = new Float32Array([
      1.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.25, 0.25, 0.25, 0.25, 0.0, 0.0, 0.0, 1.0,
    ]);
    const payload: Record<string, unknown> = {
      vertices: new Float32Array(N * 18),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      attributes: { skinIndex, skinWeight },
    };
    const result = meshLoader.load(payload, undefined, makeCtx());
    expect(result).toBeDefined();
    if (result === undefined) return;
    const asset = result as {
      kind: string;
      attributes: { skinIndex?: unknown; skinWeight?: unknown };
    };
    expect(asset.kind).toBe('mesh');
    expect(asset.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(asset.attributes.skinWeight).toBeInstanceOf(Float32Array);
    expect(asset.attributes.skinIndex).toBe(skinIndex);
    expect(asset.attributes.skinWeight).toBe(skinWeight);
  });

  it('AC-05 (b) JSON-roundtrip: number[] is rehydrated to Uint16Array / Float32Array', () => {
    const N = 4;
    const sourceSkinIndex = new Uint16Array([0, 1, 2, 3, 10, 11, 12, 13, 0, 0, 0, 0, 4, 5, 6, 7]);
    const sourceSkinWeight = new Float32Array([
      1.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.25, 0.25, 0.25, 0.25, 0.0, 0.0, 0.0, 1.0,
    ]);

    // Simulate the dev-server / build-mode pack-body wire path. The actual
    // wire pre-flattens typed arrays to plain Array via
    // @forgeax/engine-import normaliseForPack BEFORE JSON.stringify (see
    // packages/import/src/import-runner.ts). Without that step,
    // JSON.stringify(typedArray) yields a string-keyed object literal --
    // not the dual-contract shape the loader is designed to honour.
    const flatIndex = Array.from(sourceSkinIndex);
    const flatWeight = Array.from(sourceSkinWeight);
    const wire = JSON.parse(
      JSON.stringify({
        vertices: Array.from(new Float32Array(N * 18)),
        indices: Array.from(new Uint16Array([0, 1, 2, 0, 2, 3])),
        attributes: { skinIndex: flatIndex, skinWeight: flatWeight },
      }),
    ) as Record<string, unknown>;
    const wireAttrs = wire.attributes as { skinIndex: unknown; skinWeight: unknown };
    expect(Array.isArray(wireAttrs.skinIndex)).toBe(true);
    expect(Array.isArray(wireAttrs.skinWeight)).toBe(true);

    const result = meshLoader.load(wire, undefined, makeCtx());
    expect(result).toBeDefined();
    if (result === undefined) return;
    const attrs = (result as { attributes: { skinIndex?: unknown; skinWeight?: unknown } })
      .attributes;
    expect(attrs.skinIndex).toBeInstanceOf(Uint16Array);
    expect(attrs.skinWeight).toBeInstanceOf(Float32Array);

    const restoredIdx = attrs.skinIndex as Uint16Array;
    const restoredW = attrs.skinWeight as Float32Array;
    expect(restoredIdx.length).toBe(sourceSkinIndex.length);
    expect(restoredW.length).toBe(sourceSkinWeight.length);
    for (let i = 0; i < sourceSkinIndex.length; i++) {
      expect(restoredIdx[i]).toBe(sourceSkinIndex[i]);
    }
    for (let i = 0; i < sourceSkinWeight.length; i++) {
      expect(restoredW[i]).toBeCloseTo(sourceSkinWeight[i] as number, 6);
    }
  });

  it('AC-05 (c) absent skin attrs leave attributes unchanged (unskinned mesh path)', () => {
    const payload: Record<string, unknown> = {
      vertices: new Float32Array(3 * 12),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
    };
    const result = meshLoader.load(payload, undefined, makeCtx());
    expect(result).toBeDefined();
    if (result === undefined) return;
    const attrs = (result as { attributes: { skinIndex?: unknown; skinWeight?: unknown } })
      .attributes;
    expect(attrs.skinIndex).toBeUndefined();
    expect(attrs.skinWeight).toBeUndefined();
  });
});
