import { createHash } from 'node:crypto';
import { vec3 } from '@forgeax/engine-math';
import {
  type MaterialShaderManifestEntry,
  readShaderManifestPublication,
  SHADER_MANIFEST_PUBLICATION_VERSION,
  shaderSourceDigestInput,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  inspectPointShadow,
  materialShadersSamplePointShadows,
  projectPointShadowInspection,
} from '../point-shadow-inspection';
import type { PointShadowSnapshot } from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';

function sourceDigest(fragments: readonly string[]): string {
  return createHash('sha256')
    .update(
      shaderSourceDigestInput(fragments.map((part) => createHash('sha256').update(part).digest())),
    )
    .digest('hex');
}

function snapshots(...layers: number[]): PointShadowSnapshot[] {
  return layers.map((shadowAtlasLayer, entity) => ({
    entity,
    position: vec3.create(0, 0, 0),
    mapSize: 512,
    nearPlane: 0.1,
    farPlane: 25,
    depthBias: 0.005,
    normalBias: 0.05,
    shadowAtlasLayer,
    shadowMatrices: new Float32Array(96),
  }));
}

describe('point-shadow inspection', () => {
  it('derives requested, admitted, shadowed, and occupancy from one layer projection', () => {
    expect(inspectPointShadow(snapshots(0, 1, 2, 3, -1), SHADOW_ATLAS_DEFAULT_LAYERS)).toEqual({
      status: 'over-budget',
      requested: SHADOW_ATLAS_DEFAULT_LAYERS + 1,
      admitted: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowed: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowAtlasOccupancy: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
  });

  it('reports disabled shadow production without inventing a fallback admission', () => {
    expect(inspectPointShadow([], SHADOW_ATLAS_DEFAULT_LAYERS)).toEqual({
      status: 'inactive',
      requested: 0,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
  });

  it('treats an invalid layer as non-admitted and keeps the request visible', () => {
    expect(inspectPointShadow(snapshots(-1, 7), SHADOW_ATLAS_DEFAULT_LAYERS)).toMatchObject({
      status: 'over-budget',
      requested: 2,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
    });
  });

  it('does not call a partially admitted request ready', () => {
    expect(inspectPointShadow(snapshots(0, -1), SHADOW_ATLAS_DEFAULT_LAYERS)).toMatchObject({
      status: 'over-budget',
      requested: 2,
      admitted: 1,
      shadowed: 1,
    });
  });
});

// Declaration shape copied from a `pointShadows: true` naga_oil build.
const LANE_WGSL =
  '@group(0) @binding(5) \nvar shadowAtlasX_naga_oil_mod_XMZXXEZ3FMF4F65TJMV3TUOTDN5WW233OX: texture_depth_cube_array;\n';

function entry(variantWgsl: readonly string[]): MaterialShaderManifestEntry {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'standard.wgsl',
    composedWgsl: '@group(0) @binding(8) var spotShadowMap: texture_depth_2d_array;',
    paramSchema: '[]',
    variants: variantWgsl.map((composedWgsl, index) => ({
      definesKey: `CLUSTER_FORWARD_AVAILABLE=${index === 0}`,
      defines: { CLUSTER_FORWARD_AVAILABLE: index === 0 },
      composedWgsl,
    })),
  };
}

describe('point-shadow shader lane', () => {
  it('derives the lane only from a compiled cube-array atlas declaration', () => {
    expect(materialShadersSamplePointShadows([entry([LANE_WGSL, 'fn main() {}'])])).toBe(true);
    expect(materialShadersSamplePointShadows([entry(['fn main() {}', 'fn main() {}'])])).toBe(
      false,
    );
    expect(materialShadersSamplePointShadows([])).toBe(false);
  });

  it('does not retain unselected sources when every loaded variant lacks the lane', async () => {
    const sources = ['fn primary() {}\n', 'fn variant() {}\n'];
    const digests = sources.map((source) => sourceDigest([source]));
    const manifest = (await readShaderManifestPublication({
      schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
      receipts: [],
      fragments: sources,
      sources: Object.fromEntries(digests.map((digest, index) => [digest, [index]])),
      entries: [],
      materialShaders: [
        {
          identifier: 'no-point-shadow',
          sourcePath: 'standard.wgsl',
          paramSchema: '[]',
          sourceDigest: digests[0],
          variants: [{ definesKey: '', defines: {}, sourceDigest: digests[1] }],
        },
      ],
    })) as { materialShaders: MaterialShaderManifestEntry[] };
    const row = manifest.materialShaders[0];
    const variant = row?.variants[0];
    if (variant === undefined) throw new Error('missing no-lane fixture variant');
    const join = Array.prototype.join;
    let variantJoins = 0;
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string,
    ) {
      const result = Reflect.apply(join, this, [separator]) as string;
      if (separator === '' && result === sources[1]) variantJoins++;
      return result;
    });
    try {
      expect(materialShadersSamplePointShadows(manifest.materialShaders)).toBe(false);
      const inspectionJoins = variantJoins;
      expect(variant.composedWgsl).toBe(sources[1]);
      expect(variantJoins).toBe(inspectionJoins + 1);
      expect(variant.composedWgsl).toBe(sources[1]);
      expect(variantJoins).toBe(inspectionJoins + 1);
    } finally {
      spy.mockRestore();
    }
  });

  it('finds the complete lane declaration across publication fragment boundaries', async () => {
    const fragments = [LANE_WGSL.slice(0, 17), LANE_WGSL.slice(17, 65), LANE_WGSL.slice(65)];
    const digest = sourceDigest(fragments);
    const manifest = (await readShaderManifestPublication({
      schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
      receipts: [],
      fragments,
      sources: { [digest]: [0, 1, 2] },
      entries: [],
      materialShaders: [
        {
          identifier: 'point-shadow',
          sourcePath: 'standard.wgsl',
          paramSchema: '[]',
          sourceDigest: digest,
          variants: [],
        },
      ],
    })) as { materialShaders: MaterialShaderManifestEntry[] };
    expect(materialShadersSamplePointShadows(manifest.materialShaders)).toBe(true);
  });

  it('never reports ready when no loaded shader samples point shadows', () => {
    const recorded = inspectPointShadow(snapshots(0), SHADOW_ATLAS_DEFAULT_LAYERS);
    expect(recorded.status).toBe('ready');
    expect(projectPointShadowInspection(recorded, false)).toEqual({
      status: 'unavailable',
      requested: 1,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
    expect(projectPointShadowInspection(undefined, false)?.status).toBe('unavailable');
    expect(projectPointShadowInspection(recorded, true)).toBe(recorded);
  });
});
