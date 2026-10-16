// bridge-skin-shader-route.unit.test.ts (feat-20260611 M4 / w17-a).
//
// Covers cooker-side auto-route: toMaterialAsset emits
// `forgeax::pbr-skin` when MaterialBridgeContext.skinned === true,
// falls back to `forgeax::default-standard-pbr` otherwise. The
// gltf-importer is the only call site that has the per-mesh skin
// presence info; routing here keeps shader choice content-driven
// without exposing a runtime auto-resolve (Q4) — the runtime
// SkinMaterialMismatchError fail-fast in render-system-extract is
// the reverse-direction safety net for misauthored content.

import { describe, expect, it } from 'vitest';
import { toMaterialAsset } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

function makeMatIr(): GltfMaterialIr {
  return {
    baseColorFactor: [1, 1, 1, 1] as const,
    metallicFactor: 0.0,
    roughnessFactor: 1.0,
  };
}

describe('toMaterialAsset shader routing (w17-a)', () => {
  it('skinned: true -> passes[0].shader === forgeax::pbr-skin', () => {
    const mat = makeMatIr();
    const asset = toMaterialAsset(mat, { skinned: true });
    expect(asset.passes?.[0]?.program.module).toBe('forgeax::pbr-skin');
  });

  it('skinned: false -> passes[0].shader === forgeax::default-standard-pbr', () => {
    const mat = makeMatIr();
    const asset = toMaterialAsset(mat, { skinned: false });
    expect(asset.passes?.[0]?.program.module).toBe('forgeax::default-standard-pbr');
  });

  it('no flag (back-compat) -> passes[0].shader === forgeax::default-standard-pbr', () => {
    const mat = makeMatIr();
    const asset = toMaterialAsset(mat);
    expect(asset.passes?.[0]?.program.module).toBe('forgeax::default-standard-pbr');
  });
});
