import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  selectHdrpPbrPrewarmVariants,
  selectPipelineLayoutForVariant,
  selectSkinPrewarmVariants,
} from '../assembly/factory';

describe('custom skinned mesh motion consumer contract', () => {
  it('prepares both URP and HDRP pbr-skin consumers with the skin-cluster contract', () => {
    const variants = selectSkinPrewarmVariants(
      {
        identifier: 'forgeax::pbr-skin',
        sourcePath: 'default-standard-pbr-skin.wgsl',
        composedWgsl: '@group(2) @binding(1) var<storage> palette: array<u32>;',
        paramSchema: '[]',
        variants: [
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: false,
              PROBE_BLEND_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: 'probe-urp',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: false,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: '@group(2) @binding(1) var<storage> palette: array<u32>;',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=true+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: true,
              PROBE_BLEND_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl: 'probe-hdrp',
          },
          {
            definesKey:
              'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
            defines: {
              CLUSTER_FORWARD_AVAILABLE: true,
              STORAGE_BUFFER_AVAILABLE: true,
              VERTEX_COLOR_AVAILABLE: false,
            },
            composedWgsl:
              '@group(2) @binding(1) var<storage> palette: array<u32>; @group(2) @binding(4) var<storage> lights: array<u32>;',
          },
        ],
      },
      true,
    );
    expect(variants.map((variant) => variant.definesKey)).toEqual([
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    ]);
    expect(createMaterialShaderProgram(variants[1]?.composedWgsl ?? '').group2).toBe(
      'skin-cluster',
    );
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: 'hdrp' as never,
          pbrSkinPipelineLayout: 'skin-urp' as never,
          hdrpSkinPipelineLayout: 'skin-hdrp' as never,
        },
        variants[1]?.definesKey,
        'hdrp-skin',
      ),
    ).toBe('skin-hdrp');
  });

  it('warms only device-reachable skin variants while retaining all draw and reflection lanes', () => {
    const deviceAxes = [
      'EXTENDED_LIGHTING_AVAILABLE',
      'DIRECTIONAL_PCSS_AVAILABLE',
      'PROJECTOR_AVAILABLE',
    ] as const;
    const drawAxes = [
      'CLUSTER_FORWARD_AVAILABLE',
      'VERTEX_COLOR_AVAILABLE',
      'TRANSMISSION_AVAILABLE',
      'REFLECTION_FALLBACK_AVAILABLE',
      'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    ] as const;
    const axes = [...deviceAxes, ...drawAxes];
    const variants = Array.from({ length: 2 ** axes.length }, (_, bits) => ({
      definesKey: String(bits),
      composedWgsl: String(bits),
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        ...Object.fromEntries(axes.map((axis, bit) => [axis, (bits & (1 << bit)) !== 0])),
      },
    }));
    const entry = {
      identifier: 'forgeax::pbr-skin',
      sourcePath: 'skin.wgsl',
      composedWgsl: '',
      paramSchema: '[]',
      variants,
    };
    // A boot cannot know the scene's topology, color, material or SSR choices.
    // The dedicated non-clustered program does not cover all scene-index draws.
    const selected = selectSkinPrewarmVariants(entry, true, false, true, false, true);
    expect(selected).toHaveLength(32);
    for (const variant of selected) {
      expect(variant.defines).toMatchObject({
        EXTENDED_LIGHTING_AVAILABLE: false,
        DIRECTIONAL_PCSS_AVAILABLE: true,
        PROJECTOR_AVAILABLE: false,
      });
    }
    for (const axis of drawAxes) {
      expect(new Set(selected.map((variant) => variant.defines[axis]))).toEqual(
        new Set([false, true]),
      );
    }
    const lowTextureLimit = selectSkinPrewarmVariants(entry, true, false, true, false, false);
    expect(lowTextureLimit).toHaveLength(16);
    expect(
      lowTextureLimit.every((variant) => variant.defines.TRANSMISSION_AVAILABLE === false),
    ).toBe(true);
  });

  it('prewarms direct and clustered skin on WebGL2 without storage-backed PBR prewarming', () => {
    const variants = [
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false',
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
        },
        composedWgsl: 'urp-uniform',
      },
      {
        definesKey: 'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false',
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
        composedWgsl: 'hdrp-uniform',
      },
    ];
    const entry = {
      identifier: 'forgeax::default-standard-pbr-skin',
      sourcePath: 'default-standard-pbr-skin.wgsl',
      composedWgsl: 'default',
      paramSchema: '[]',
      variants,
    };

    expect(selectSkinPrewarmVariants(entry, false).map((variant) => variant.definesKey)).toEqual([
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false',
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false',
    ]);
    expect(selectHdrpPbrPrewarmVariants(entry, false, true)).toEqual([]);
  });
});
