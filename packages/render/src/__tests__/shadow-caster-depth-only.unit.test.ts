import { describe, expect, it } from 'vitest';
import { materialPipelineCacheKey } from '../assembly/material-shader-policy';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import {
  positionOnlyShadowVertexEntry,
  SHADOW_CASTER_POSITION_ONLY_ENTRY,
  shadowCasterDepthOnly,
} from '../record/shadow-pass';

type Projection = Parameters<typeof shadowCasterDepthOnly>[1];
type Batch = Parameters<typeof shadowCasterDepthOnly>[2];

const rigidStandard = {
  identity: { material: 'forgeax::default-standard-pbr', deformation: 'rigid' },
} as unknown as NonNullable<Batch['prepared']>;

function projection(overrides: Partial<Record<string, unknown>> = {}): Projection {
  return {
    shadowArtifact: { material: SHADOW_CASTER_SHADER_ID },
    material: {},
    ...overrides,
  } as unknown as Projection;
}

function batch(overrides: Partial<Record<string, unknown>> = {}): Batch {
  return {
    key: { admission: 'opaque' },
    prepared: rigidStandard,
    lod: { crossfade: false, coverages: [1] },
    ...overrides,
  } as unknown as Batch;
}

describe('shadowCasterDepthOnly', () => {
  it('selects a vertex-only PSO for an opaque stock caster without coverage', () => {
    expect(shadowCasterDepthOnly(undefined, projection(), batch())).toBe(true);
    expect(
      shadowCasterDepthOnly(undefined, projection({ shadowFragmentEntry: 'fs_shadow' }), batch()),
    ).toBe(true);
    // A single LOD level cannot fade even on a crossfade-capable surface.
    expect(shadowCasterDepthOnly(undefined, projection(), batch({ lod: undefined }))).toBe(true);
  });

  it('keeps the fragment stage for every coverage source', () => {
    const cases: [string, Parameters<typeof shadowCasterDepthOnly>][] = [
      [
        'custom program',
        [undefined, projection({ shadowArtifact: { material: 'x::custom' } }), batch()],
      ],
      [
        'custom Surface',
        [
          undefined,
          projection({
            shadowArtifact: { material: SHADOW_CASTER_SHADER_ID, receipt: { surface: {} } },
          }),
          batch(),
        ],
      ],
      ['authored entry', [undefined, projection({ shadowFragmentEntry: 'fs_custom' }), batch()]],
      ['alpha mask', [undefined, projection(), batch({ key: { admission: 'alpha-mask' } })]],
      ['unknown admission', [undefined, projection(), batch({ key: {} })]],
      [
        'camera shadow clipping',
        [{ planes: [[1, 0, 0, 0]], clipShadows: true } as never, projection(), batch()],
      ],
      [
        'displacement',
        [
          undefined,
          projection({ material: { authoredTextureFields: new Set(['displacementTexture']) } }),
          batch(),
        ],
      ],
      [
        'material clipping schema',
        [
          undefined,
          projection({ material: { materialParamSchema: [{ name: 'clippingControl' }] } }),
          batch(),
        ],
      ],
      [
        'material clipping value',
        [
          undefined,
          projection({ material: { paramSnapshot: { clippingControl: [1, 0, 0, 0] } } }),
          batch(),
        ],
      ],
      [
        'LOD crossfade',
        [undefined, projection(), batch({ lod: { crossfade: true, coverages: [1] } })],
      ],
      [
        'LOD dither',
        [undefined, projection(), batch({ lod: { crossfade: false, coverages: [1, 0.5] } })],
      ],
      ['unknown LOD capability', [undefined, projection(), batch({ prepared: undefined })]],
    ];
    for (const [name, args] of cases) expect(shadowCasterDepthOnly(...args), name).toBe(false);
  });

  it('ignores camera clipping that shadows do not opt into', () => {
    expect(
      shadowCasterDepthOnly(
        { planes: [[1, 0, 0, 0]], clipShadows: false } as never,
        projection(),
        batch(),
      ),
    ).toBe(true);
    expect(
      shadowCasterDepthOnly({ planes: [], clipShadows: true } as never, projection(), batch()),
    ).toBe(true);
  });
});

describe('materialPipelineCacheKey', () => {
  it('keeps existing keys and splits only the vertex-only depth PSO', () => {
    expect(materialPipelineCacheKey('spec', undefined, undefined)).toBe('spec|vertex:vs_main');
    expect(materialPipelineCacheKey('spec', 'vs_scene_index', 'fs_shadow')).toBe(
      'spec|vertex:vs_scene_index',
    );
    expect(materialPipelineCacheKey('spec', 'vs_scene_index', null)).toBe(
      'spec|vertex:vs_scene_index|fs:none',
    );
  });
});

describe('positionOnlyShadowVertexEntry', () => {
  const artifact = (entries: readonly string[]) =>
    ({
      material: SHADOW_CASTER_SHADER_ID,
      receipt: { sceneIndexEntry: 'vs_scene_index' },
      program: { entryPoints: entries.map((name) => ({ stage: 'vertex', name })) },
    }) as unknown as Parameters<typeof positionOnlyShadowVertexEntry>[0];

  it('binds the position-only stream for rigid casters that declare it', () => {
    expect(
      positionOnlyShadowVertexEntry(
        artifact(['vs_scene_index', SHADOW_CASTER_POSITION_ONLY_ENTRY]),
        { deformation: 'rigid' },
      ),
    ).toBe(SHADOW_CASTER_POSITION_ONLY_ENTRY);
  });

  it('keeps the full entry for skinned casters, older artifacts and authored entries', () => {
    const both = artifact(['vs_scene_index', SHADOW_CASTER_POSITION_ONLY_ENTRY, 'vs_shadow']);
    expect(positionOnlyShadowVertexEntry(both, { deformation: 'skin' })).toBe('vs_scene_index');
    expect(
      positionOnlyShadowVertexEntry(artifact(['vs_scene_index']), { deformation: 'rigid' }),
    ).toBe('vs_scene_index');
    expect(
      positionOnlyShadowVertexEntry(both, { deformation: 'rigid', shadowVertexEntry: 'vs_shadow' }),
    ).toBe('vs_shadow');
  });
});
