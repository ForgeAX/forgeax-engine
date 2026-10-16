import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ok, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import {
  createMaterialProgramArtifactReceipt,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  type ShaderCatalog,
  ShaderRegistry,
  type ShaderRegistryDevice,
} from '@forgeax/engine-shader';
import { ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { deviceOptionsForAdapter } from '../assembly/device-feature-admission';
import {
  allowsUnlitPreparedFallback,
  isSharedMaterialUserRegionCompatible,
  normalizeMaterialShaderVariantSet,
  requiresPreparedMaterialShader,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderUvSetCount,
  resolveMaterialShaderVariantSet,
  resolveMaterialShaderVertexInputContract,
  selectNoColorPbrVariant,
  selectPipelineLayoutForVariant,
  stripCloudShadowBindingsForLowLimit,
} from '../assembly/factory';
import {
  prepareMaterialShaders,
  viewAndSceneDepthLayoutEntries,
} from '../assembly/material-shader-policy';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
  validateTemporalPipelineContract,
} from '../pipeline-builder';
import { effectiveMaterialLayoutIdentity } from '../record/main-pass-geometry';
import { userRegionTextureFieldOrder } from '../record/main-pass-material';

const hdrpVariantKey =
  'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';
const urpVariantKey =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

function noColorVariant(
  definesKey: string,
  clusterForward: boolean,
): MaterialShaderManifestVariant {
  return {
    definesKey,
    defines: {
      STORAGE_BUFFER_AVAILABLE: true,
      VERTEX_COLOR_AVAILABLE: false,
      CLUSTER_FORWARD_AVAILABLE: clusterForward,
    },
    composedWgsl: definesKey,
  };
}

function noColorManifest() {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'default-standard-pbr.wgsl',
    composedWgsl: 'shader',
    paramSchema: '{}',
    variants: [noColorVariant(hdrpVariantKey, true), noColorVariant(urpVariantKey, false)],
  };
}

describe('material shader variant identity', () => {
  it('lowers the optional cloud shadow bindings on cooked single-source materials', () => {
    const source = `
@group(0) @binding(16) var cloudShadowMapX: texture_2d<f32>;
@group(0) @binding(17) var cloudShadowSamplerX: sampler;
fn cloud_direct_solar_factorX() -> f32 {
  let sampled = textureSampleLevel(cloudShadowMapX, cloudShadowSamplerX, vec2<f32>(0.5), 0.0).x;
  return sampled;
}
`;
    const lowered = stripCloudShadowBindingsForLowLimit(source);
    expect(lowered).not.toMatch(/@group\(0\)\s*@binding\((?:16|17)\)/u);
    expect(lowered).not.toContain('cloudShadowMapX');
    expect(lowered).not.toContain('cloudShadowSamplerX');
    expect(lowered).toContain('vec4<f32>(1.0).x');
  });

  it.each([
    'COVERAGE_ONLY',
    'VISIBLE_SURFACE_AVAILABLE',
  ])('defaults the %s axis to the ordinary boot variant', async (axis) => {
    const entry: MaterialShaderManifestEntry = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: 'coverage-off',
      paramSchema: '[]',
      variants: [
        {
          definesKey: [`${axis}=false`, 'STORAGE_BUFFER_AVAILABLE=true'].sort().join('+'),
          defines: { [axis]: false, STORAGE_BUFFER_AVAILABLE: true },
          composedWgsl: 'coverage-off',
        },
        {
          definesKey: [`${axis}=true`, 'STORAGE_BUFFER_AVAILABLE=true'].sort().join('+'),
          defines: { [axis]: true, STORAGE_BUFFER_AVAILABLE: true },
          composedWgsl: 'coverage-on',
        },
      ],
    };
    const installMaterialArtifact = vi.fn();
    const registry = {
      loadManifest: vi.fn(async () => ({ ok: true, value: undefined })),
      materialShaderManifestEntries: () => [entry][Symbol.iterator](),
      findMaterialArtifact: vi.fn(() => ({ ok: false })),
      installMaterialArtifact,
    } as unknown as ShaderCatalog;
    const assets = { catalog: vi.fn(() => ({ ok: true, value: undefined })) } as never;
    const device = {
      caps: {
        backendKind: 'webgpu',
        storageBuffer: true,
        rgba16floatRenderable: true,
        samplerAliasing: true,
      },
      limits: {
        maxStorageBuffersPerShaderStage: 8,
        maxSampledTexturesPerShaderStage: 32,
        maxTextureArrayLayers: 64,
        maxUniformBuffersPerShaderStage: 4,
      },
    } as unknown as RhiDevice;

    await prepareMaterialShaders(device, () => registry, assets, new Map());

    expect(installMaterialArtifact).toHaveBeenCalledWith('forgeax::default-standard-pbr', {
      source: 'coverage-off',
      paramSchema: [],
    });
  });

  it('boots an authored axis at its all-true default on the WebGL2 storage fallback', async () => {
    const variant = (multiUv: boolean, storage: boolean): MaterialShaderManifestVariant => ({
      definesKey: `M3_MULTI_UV_VARIANT=${multiUv}+STORAGE_BUFFER_AVAILABLE=${storage}`,
      defines: { M3_MULTI_UV_VARIANT: multiUv, STORAGE_BUFFER_AVAILABLE: storage },
      composedWgsl: `multi-uv=${multiUv} storage=${storage}`,
    });
    const entry: MaterialShaderManifestEntry = {
      identifier: 'hello-multi-uv::multi-uv-demo',
      sourcePath: 'multi-uv-demo.wgsl',
      composedWgsl: 'canonical',
      paramSchema: '[]',
      variants: [
        variant(false, false),
        variant(false, true),
        variant(true, false),
        variant(true, true),
      ],
    };
    const installMaterialArtifact = vi.fn();
    const registry = {
      loadManifest: vi.fn(async () => ({ ok: true, value: undefined })),
      materialShaderManifestEntries: () => [entry][Symbol.iterator](),
      findMaterialArtifact: vi.fn(() => ({ ok: false })),
      installMaterialArtifact,
    } as unknown as ShaderCatalog;
    const assets = { catalog: vi.fn(() => ({ ok: true, value: undefined })) } as never;
    const device = {
      caps: {
        backendKind: 'wgpu-webgl2',
        storageBuffer: false,
        rgba16floatRenderable: true,
        samplerAliasing: true,
      },
      limits: {
        maxStorageBuffersPerShaderStage: 0,
        maxSampledTexturesPerShaderStage: 16,
        maxTextureArrayLayers: 64,
        maxUniformBuffersPerShaderStage: 12,
      },
    } as unknown as RhiDevice;

    await prepareMaterialShaders(device, () => registry, assets, new Map());

    expect(installMaterialArtifact).toHaveBeenCalledWith('hello-multi-uv::multi-uv-demo', {
      source: 'multi-uv=true storage=false',
      paramSchema: [],
    });
    expect(resolveMaterialShaderVariantSet(undefined, entry.variants, 'wgpu-webgl2', false)).toBe(
      variant(true, false).definesKey,
    );
  });

  it('selects the replacement device capability variant after a metadata-only fork', async () => {
    const uniformReceipt = createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_uniform',
      sceneIndexEntry: 'vs_scene_uniform',
      vertexInputs: [],
      layoutIdentity: 'uniform',
    });
    const storageReceipt = createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_storage',
      sceneIndexEntry: 'vs_scene_storage',
      vertexInputs: [],
      layoutIdentity: 'storage',
    });
    const entry: MaterialShaderManifestEntry = {
      identifier: 'game::variant',
      sourcePath: 'variant.wgsl',
      composedWgsl: 'fallback',
      paramSchema: '[]',
      uvSetCount: 3,
      variants: [
        {
          definesKey: 'STORAGE_BUFFER_AVAILABLE=false',
          defines: { STORAGE_BUFFER_AVAILABLE: false },
          composedWgsl: 'uniform-variant',
          receipt: uniformReceipt,
        },
        {
          definesKey: '',
          defines: { STORAGE_BUFFER_AVAILABLE: true },
          composedWgsl: 'storage-variant',
          receipt: storageReceipt,
        },
      ],
    };
    const manifestUrl = URL.createObjectURL(
      new Blob([JSON.stringify({ entries: [], materialShaders: [entry] })]),
    );
    const registryDevice = (): ShaderRegistryDevice => ({
      createShaderModule: () => ok({} as never),
    });
    const device = (storageBuffer: boolean): RhiDevice =>
      ({
        caps: {
          backendKind: 'webgpu',
          storageBuffer,
          rgba16floatRenderable: true,
          samplerAliasing: true,
        },
        limits: {
          maxStorageBuffersPerShaderStage: storageBuffer ? 8 : 0,
          maxSampledTexturesPerShaderStage: 32,
          maxTextureArrayLayers: 64,
          maxUniformBuffersPerShaderStage: 4,
        },
      }) as unknown as RhiDevice;

    try {
      const active = new ShaderRegistry({ device: registryDevice(), manifestUrl });
      const activeAssets = new AssetRegistry(active);
      await prepareMaterialShaders(device(false), () => active, activeAssets, new Map());
      active.installMaterialArtifact('game::custom', {
        source: 'custom-variant',
        paramSchema: [],
        receipt: uniformReceipt,
      });
      const activeArtifact = active.findMaterialArtifact('game::variant');
      expect(activeArtifact.ok).toBe(true);
      if (!activeArtifact.ok) return;
      expect(activeArtifact.value.source).toBe('uniform-variant');
      expect(activeArtifact.value.receipt).toEqual(uniformReceipt);

      URL.revokeObjectURL(manifestUrl);
      const candidate = active.forkForDevice(registryDevice());
      const candidateAssets = new AssetRegistry(candidate);
      const uvSetCounts = new Map<string, number>();
      await prepareMaterialShaders(device(true), () => candidate, candidateAssets, uvSetCounts);
      const candidateArtifact = candidate.findMaterialArtifact('game::variant');
      expect(candidateArtifact.ok).toBe(true);
      if (!candidateArtifact.ok) return;
      expect(candidateArtifact.value.source).toBe('storage-variant');
      expect(candidateArtifact.value.receipt).toEqual(storageReceipt);
      expect(uvSetCounts.get('game::variant')).toBe(3);
      expect(candidate.findMaterialArtifact('game::custom').ok).toBe(false);

      const customArtifact = active.findMaterialArtifact('game::custom');
      expect(customArtifact.ok).toBe(true);
      if (!customArtifact.ok) return;
      candidate.installMaterialArtifact('game::custom', customArtifact.value);
      const candidateCustom = candidate.findMaterialArtifact('game::custom');
      expect(candidateCustom.ok && candidateCustom.value.source).toBe('custom-variant');
      expect(activeArtifact.value.source).toBe('uniform-variant');
    } finally {
      URL.revokeObjectURL(manifestUrl);
    }
  });

  it('requests the extended-lighting sampled-texture limit when the adapter supports it', () => {
    const features = new Set<GPUFeatureName>();
    expect(
      deviceOptionsForAdapter({
        features,
        limits: { maxSampledTexturesPerShaderStage: 48 },
      } as never),
    ).toEqual({
      requiredFeatures: ['depth32float-stencil8'],
      requiredLimits: { maxSampledTexturesPerShaderStage: 31 },
    });
    expect(
      deviceOptionsForAdapter({
        features,
        limits: { maxSampledTexturesPerShaderStage: 16 },
      } as never),
    ).toEqual({ requiredFeatures: ['depth32float-stencil8'] });
  });

  it('preserves the distinction between absent, canonical, and explicit requests', () => {
    const manifest = noColorManifest();

    expect(selectNoColorPbrVariant(manifest, true, undefined)?.definesKey).toBe(urpVariantKey);
    expect(selectNoColorPbrVariant(manifest, true, '')?.definesKey).toBe(hdrpVariantKey);
    expect(
      selectNoColorPbrVariant(manifest, true, 'CLUSTER_FORWARD_AVAILABLE=true')?.definesKey,
    ).toBe(hdrpVariantKey);
    expect(
      selectNoColorPbrVariant(manifest, true, 'CLUSTER_FORWARD_AVAILABLE=false')?.definesKey,
    ).toBe(urpVariantKey);
  });

  it('keeps coverage-only fallback selection explicit', () => {
    const coverageKey = `COVERAGE_ONLY=true+${urpVariantKey}`;
    const manifest = {
      ...noColorManifest(),
      variants: [
        {
          ...noColorVariant(coverageKey, false),
          definesKey: coverageKey,
          defines: {
            ...noColorVariant(coverageKey, false).defines,
            COVERAGE_ONLY: true,
          },
          composedWgsl: 'coverage-on',
        },
        { ...noColorVariant(urpVariantKey, false), composedWgsl: 'coverage-off' },
      ],
    };
    expect(selectNoColorPbrVariant(manifest, true, undefined)?.definesKey).toBe(urpVariantKey);
    expect(
      selectNoColorPbrVariant(manifest, true, `COVERAGE_ONLY=true+${urpVariantKey}`)?.definesKey,
    ).toBe(coverageKey);
  });

  it('keeps physical root declarations out of capability variant selection', () => {
    const manifest = noColorManifest();
    expect(
      selectNoColorPbrVariant(
        manifest,
        true,
        `${hdrpVariantKey}+CLEARCOAT_TEXTURE_AVAILABLE=true+TRANSMISSION_AVAILABLE=true`,
      )?.definesKey,
    ).toBe(hdrpVariantKey);
  });

  it('retains the WebGL2 colored clustered PBR variant and layout', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: true,
        },
      },
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: true,
        },
      },
    ];
    const resolved = resolveMaterialShaderVariantSet(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true',
      variants,
      'wgpu-webgl2',
      false,
    );

    expect(resolved).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true',
    );
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: 'hdrp' as never,
          pbrSkinPipelineLayout: null,
        },
        resolved,
        'hdrp-pbr',
      ),
    ).toBe('hdrp');
  });

  it('rewrites directional PCSS to the backend-owned WebGL2 shader variant', () => {
    const variants = [
      {
        defines: {
          STORAGE_BUFFER_AVAILABLE: false,
          DIRECTIONAL_PCSS_AVAILABLE: false,
        },
      },
      {
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          DIRECTIONAL_PCSS_AVAILABLE: true,
        },
      },
    ];

    expect(
      resolveMaterialShaderVariantSet(
        'DIRECTIONAL_PCSS_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
        variants,
        'wgpu-webgl2',
        false,
      ),
    ).toBe('DIRECTIONAL_PCSS_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false');
    expect(
      resolveMaterialShaderVariantSet(
        'DIRECTIONAL_PCSS_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
        variants,
        'webgpu',
        true,
      ),
    ).toBe('');
  });

  it('fails closed when a clustered layout is unavailable', () => {
    expect(
      selectPipelineLayoutForVariant(
        {
          pbrPipelineLayout: 'urp' as never,
          hdrpPbrPipelineLayout: null,
          pbrSkinPipelineLayout: null,
        },
        '',
        'hdrp-pbr',
      ),
    ).toBeNull();
  });

  it('selects the producer-owned clustered layouts for scene-index batches', () => {
    const state = {
      pbrPipelineLayout: 'urp' as never,
      hdrpPbrPipelineLayout: 'hdrp' as never,
      pbrSkinPipelineLayout: 'skin-urp' as never,
      gpuDrivenPbrPipelineLayout: 'gpu-urp' as never,
      gpuDrivenPbrSkinPipelineLayout: 'gpu-skin-urp' as never,
      gpuDrivenClusterPbrPipelineLayout: 'gpu-cluster' as never,
      gpuDrivenClusterPbrSkinPipelineLayout: 'gpu-skin-cluster' as never,
    };

    expect(selectPipelineLayoutForVariant(state, '', 'gpu-driven-cluster-pbr')).toBe('gpu-cluster');
    expect(selectPipelineLayoutForVariant(state, '', 'gpu-driven-cluster-skin')).toBe(
      'gpu-skin-cluster',
    );
  });

  it('does not promote an omitted semantic axis to true', () => {
    const resolved = resolveMaterialShaderVariantSet(
      'VERTEX_COLOR_AVAILABLE=true',
      [
        {
          defines: {
            CLUSTER_FORWARD_AVAILABLE: false,
            STORAGE_BUFFER_AVAILABLE: false,
            VERTEX_COLOR_AVAILABLE: true,
          },
        },
      ],
      'wgpu-webgl2',
      false,
    );

    expect(resolved).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true',
    );
  });

  it('defaults coverage-only variants to the opaque path unless explicitly enabled', () => {
    const variants = [{ defines: { COVERAGE_ONLY: true } }, { defines: { COVERAGE_ONLY: false } }];

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true)).toBe(
      'COVERAGE_ONLY=false',
    );
    expect(resolveMaterialShaderVariantSet('', variants, 'webgpu', true)).toBe(
      'COVERAGE_ONLY=false',
    );
    expect(resolveMaterialShaderVariantSet('COVERAGE_ONLY=true', variants, 'webgpu', true)).toBe(
      '',
    );
  });

  it('keeps the negative skinning axis disabled when a shadow request omits it', () => {
    const variants = [
      {
        defines: {
          SKINNING_DISABLED: true,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
      {
        defines: {
          SKINNING_DISABLED: false,
          STORAGE_BUFFER_AVAILABLE: false,
        },
      },
    ];

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'wgpu-webgl2', false)).toBe(
      'SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(resolveMaterialShaderVariantSet('', variants, 'wgpu-webgl2', false)).toBe(
      'SKINNING_DISABLED=true+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(
      resolveMaterialShaderVariantSet(
        'SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false',
        variants,
        'wgpu-webgl2',
        false,
      ),
    ).toBe('SKINNING_DISABLED=false+STORAGE_BUFFER_AVAILABLE=false');
  });

  it('disables extended lighting when the device cannot sample its shared layout topology', () => {
    const variants = [
      { defines: { EXTENDED_LIGHTING_AVAILABLE: false } },
      { defines: { EXTENDED_LIGHTING_AVAILABLE: true } },
    ];

    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        true,
        16,
      ),
    ).toBe('EXTENDED_LIGHTING_AVAILABLE=false');
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        true,
        20,
      ),
    ).toBe('EXTENDED_LIGHTING_AVAILABLE=false');
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        true,
        24,
      ),
    ).toBe('');
    expect(
      resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true, 24),
    ).toBeUndefined();
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=false',
        variants,
        'webgpu',
        true,
        24,
      ),
    ).toBe('');
    expect(
      resolveMaterialShaderVariantSet(
        'EXTENDED_LIGHTING_AVAILABLE=true',
        variants,
        'webgpu',
        false,
        20,
      ),
    ).toBe('EXTENDED_LIGHTING_AVAILABLE=false');
  });

  it('preserves authored default axes while rewriting backend capabilities', () => {
    const variants = [
      { defines: { AUTHORED_TINT: true, STORAGE_BUFFER_AVAILABLE: true } },
      { defines: { AUTHORED_TINT: false, STORAGE_BUFFER_AVAILABLE: true } },
      { defines: { AUTHORED_TINT: true, STORAGE_BUFFER_AVAILABLE: false } },
      { defines: { AUTHORED_TINT: false, STORAGE_BUFFER_AVAILABLE: false } },
    ];
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true)).toBeUndefined();
    expect(resolveMaterialShaderVariantSet('', variants, 'webgpu', true)).toBe('');
    expect(
      resolveMaterialShaderVariantSet('STORAGE_BUFFER_AVAILABLE=true', variants, 'webgpu', true),
    ).toBe('');
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'wgpu-webgl2', false)).toBe(
      'AUTHORED_TINT=true+STORAGE_BUFFER_AVAILABLE=false',
    );
    expect(resolveMaterialShaderVariantSet('AUTHORED_TINT=false', variants, 'webgpu', true)).toBe(
      'AUTHORED_TINT=false+STORAGE_BUFFER_AVAILABLE=true',
    );
  });

  it('keeps sprite region variants on the explicit empty-key contract', () => {
    const variants = [
      {
        defines: { PER_INSTANCE_REGION: true, STORAGE_BUFFER_AVAILABLE: true },
      },
      {
        defines: { PER_INSTANCE_REGION: false, STORAGE_BUFFER_AVAILABLE: true },
      },
    ];

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true)).toBe(
      'PER_INSTANCE_REGION=false+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(resolveMaterialShaderVariantSet('', variants, 'webgpu', true)).toBe('');
  });

  it('keeps an explicit empty key colored while omitted and explicit-false stay plain', () => {
    const variants = [
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, VERTEX_COLOR_AVAILABLE: true },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, VERTEX_COLOR_AVAILABLE: false },
      },
    ];

    expect(resolveMaterialShaderVariantSet('', variants, 'webgpu', true)).toBe('');
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true)).toBe(
      'STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(
      resolveMaterialShaderVariantSet('VERTEX_COLOR_AVAILABLE=false', variants, 'webgpu', true),
    ).toBe('STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false');
  });

  it('selects the projector-disabled PBR variant when the device exposes only 16 sampled textures', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          PROJECTOR_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          PROJECTOR_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
    ];

    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+PROJECTOR_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'webgpu', true, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+PROJECTOR_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('keeps single-source manifests on the canonical module key', () => {
    const singleSourceManifest = {
      identifier: 'forgeax::points-lines',
      sourcePath: 'points-lines.wgsl',
      composedWgsl: 'shader',
      paramSchema: '{}',
      variants: [],
    };

    expect(
      normalizeMaterialShaderVariantSet('VERTEX_COLOR_AVAILABLE=false', singleSourceManifest),
    ).toBeUndefined();
  });

  it('preserves variant requests for manifests that actually declare variants', () => {
    const variantManifest = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'standard-pbr.wgsl',
      composedWgsl: 'shader',
      paramSchema: '{}',
      variants: [
        {
          definesKey: 'STORAGE_BUFFER_AVAILABLE=true',
          defines: { STORAGE_BUFFER_AVAILABLE: true },
          composedWgsl: 'shader',
        },
      ],
    };

    expect(
      normalizeMaterialShaderVariantSet('STORAGE_BUFFER_AVAILABLE=true', variantManifest),
    ).toBe('STORAGE_BUFFER_AVAILABLE=true');
    expect(normalizeMaterialShaderVariantSet('CUSTOM=true', undefined)).toBe('CUSTOM=true');
  });

  it('projects a published Surface artifact to its WebGL2 capability alias', () => {
    const base = 'surface-specialization';
    const webgl2 = 'forgeax::surface-variant::surface-specialization::webgl2::uniform-fallback';
    const artifact = {
      metadata: {
        variants: [
          {
            backend: 'webgpu',
            capability: 'storage-buffer',
            specializationKey: base,
          },
          {
            backend: 'webgl2',
            capability: 'uniform-fallback',
            specializationKey: webgl2,
          },
        ],
      },
    };

    expect(resolveMaterialShaderBackendArtifactKey(base, 'wgpu-webgl2', artifact)).toBe(webgl2);
    expect(resolveMaterialShaderBackendArtifactKey(base, 'webgpu', artifact)).toBe(base);
    expect(resolveMaterialShaderBackendArtifactKey(base, 'wgpu-webgl2', undefined)).toBe(base);
  });
});

describe('temporal material PSO creation contract', () => {
  const source = `
    struct VsIn { @location(0) position: vec3<f32> }
    @vertex fn vs_temporal(input: VsIn) -> @builtin(position) vec4<f32> {
      return vec4<f32>(input.position, 1.0);
    }
    @fragment fn fs_temporal() -> @location(0) vec4<f32> {
      return vec4<f32>(1.0);
    }
  `;
  const capabilities = { storageBuffer: false, rgba16floatRenderable: true };
  const context = {
    colorFormat: 'rgba16float' as GPUTextureFormat,
    depthFormat: 'depth24plus-stencil8' as GPUTextureFormat,
    capabilities,
  } satisfies Pick<PipelineBuilderContext, 'colorFormat' | 'depthFormat' | 'capabilities'>;

  it('accepts the WebGL2 temporal source/layout/attachment contract', () => {
    expect(validateTemporalPipelineContract(source, context).ok).toBe(true);
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal',
      { source, paramSchema: [] },
      {
        ...context,
        device: {
          createRenderPipeline,
        },
        shaderModuleFactory: {
          createShaderModule: () => ({ ok: true, value: {} }),
        },
        pipelineLayout: {},
        vertexBuffers: [],
        label: 'pbr-pipeline-default-unlit-temporal',
      } as unknown as PipelineBuilderContext,
      { depthWriteEnabled: false, depthCompare: 'less-equal' },
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(true);
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(createRenderPipeline.mock.calls[0]?.[0]).toMatchObject({
      vertex: { entryPoint: 'vs_temporal' },
      fragment: { entryPoint: 'fs_temporal', targets: [{ format: 'rgba16float' }] },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
  });

  it('accepts r8unorm only for the output-domain coverage temporal variant', () => {
    const coverageContext = {
      ...context,
      colorFormat: 'r8unorm' as GPUTextureFormat,
      coverageOnly: true,
    } satisfies Pick<
      PipelineBuilderContext,
      'colorFormat' | 'depthFormat' | 'capabilities' | 'coverageOnly'
    >;
    expect(validateTemporalPipelineContract(source, coverageContext).ok).toBe(true);
    expect(
      validateTemporalPipelineContract(source, { ...coverageContext, coverageOnly: false }).ok,
    ).toBe(false);

    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal-coverage',
      { source, paramSchema: [] },
      {
        ...coverageContext,
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
      } as unknown as PipelineBuilderContext,
      { depthWriteEnabled: true, depthCompare: 'less-equal' },
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(true);
    expect(createRenderPipeline.mock.calls[0]?.[0]).toMatchObject({
      fragment: { entryPoint: 'fs_temporal', targets: [{ format: 'r8unorm' }] },
    });
  });

  it.each([
    { depthWriteEnabled: false, depthCompare: 'always' as const },
    { depthWriteEnabled: true, depthCompare: 'never' as const },
  ])('preserves explicit depth-only render state (%s)', (renderState) => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'prepared-depth-only',
      {
        source: `
          struct VsIn { @location(0) position: vec3<f32> }
          @vertex fn vs_main(input: VsIn) -> @builtin(position) vec4<f32> {
            return vec4<f32>(input.position, 1.0);
          }
        `,
        paramSchema: [],
      },
      {
        ...context,
        colorFormats: [],
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
      } as unknown as PipelineBuilderContext,
      renderState,
      undefined,
      'vs_main',
      undefined,
      undefined,
      'shadow-caster',
    );
    expect(result.ok).toBe(true);
    expect(createRenderPipeline.mock.calls[0]?.[0]).toMatchObject({
      fragment: undefined,
      depthStencil: {
        depthWriteEnabled: renderState.depthWriteEnabled,
        depthCompare: renderState.depthCompare,
      },
    });
  });

  it('rejects a storage variant mismatch before caching or device creation', () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal',
      {
        source: source.replace(
          'struct VsIn',
          `@group(2) var<storage> meshes: array<u32>;
    struct VsIn`,
        ),
        paramSchema: [],
      },
      {
        ...context,
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
      } as unknown as PipelineBuilderContext,
      undefined,
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('shader-compile-failed');
    expect(createRenderPipeline).not.toHaveBeenCalled();
  });

  it('preserves the underlying pipeline error hint and raw sentinel', () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({
      ok: false,
      error: new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'pipeline validates at creation',
        hint: 'raw shader validation sentinel',
      }),
    }));
    const result = buildPipelineForMaterialShader(
      'default-unlit-temporal',
      { source, paramSchema: [] },
      {
        ...context,
        device: { createRenderPipeline },
        shaderModuleFactory: { createShaderModule: () => ({ ok: true, value: {} }) },
        pipelineLayout: {},
        vertexBuffers: [],
      } as unknown as PipelineBuilderContext,
      undefined,
      undefined,
      'vs_temporal',
      'fs_temporal',
      undefined,
      'temporal',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('shader-compile-failed');
      expect(result.error.hint).toContain('raw shader validation sentinel');
      expect(result.error.hint).toContain('[RhiError webgpu-runtime-error]');
    }
  });
});

describe('material shader capability variant resolution', () => {
  it('rewrites only backend capability axes', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: false,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
    ];
    expect(
      resolveMaterialShaderVariantSet(
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
        variants,
        'wgpu-webgl2',
        false,
      ),
    ).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('resolves a custom WebGL2 material to its capability-specific boot variant', () => {
    const variants = [
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, WEBGL2_COMPAT: true },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: false, WEBGL2_COMPAT: true },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: true, WEBGL2_COMPAT: false },
      },
      {
        defines: { STORAGE_BUFFER_AVAILABLE: false, WEBGL2_COMPAT: false },
      },
    ];
    expect(resolveMaterialShaderVariantSet(undefined, variants, 'wgpu-webgl2', false)).toBe(
      'STORAGE_BUFFER_AVAILABLE=false+WEBGL2_COMPAT=true',
    );
  });
});

describe('material shader binding contract', () => {
  it.each([
    false,
    true,
  ])('admits declared vertex and fragment depth access (atmosphere=%s)', (atmosphere) => {
    const depth = viewAndSceneDepthLayoutEntries(atmosphere).find((entry) => entry.binding === 1);
    expect(depth?.visibility).toBe(GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT);
    expect(depth?.texture?.sampleType).toBe('depth');
  });
  it('does not reuse the shared PBR layout when compact texture names shift semantics', () => {
    expect(
      isSharedMaterialUserRegionCompatible([
        { name: 'baseColor', type: 'color' },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
      ]),
    ).toBe(false);
  });

  it('reuses an admitted texture projection without exposing mutable cached arrays', () => {
    const owner = new ParamSchemaProjectionOwner();
    const schema = [{ name: 'albedo', type: 'texture2d' as const }];
    const first = owner.admit({ ownerId: 'test::material', revision: 1, schema });
    const fields = userRegionTextureFieldOrder(first.schema);
    expect(userRegionTextureFieldOrder(first.schema)).toBe(fields);
    expect(() => (fields as string[]).push('caller::corruption')).toThrow();
    expect(userRegionTextureFieldOrder(first.schema)).toEqual(['albedo']);
    schema[0] = { name: 'replacement', type: 'texture2d' };
    const next = owner.admit({ ownerId: 'test::material', revision: 2, schema });
    expect(userRegionTextureFieldOrder(next.schema)).toEqual(['replacement']);
    expect(userRegionTextureFieldOrder(first.schema)).toBe(fields);
  });

  it('preserves compact authored texture order for custom material schemas', () => {
    expect(
      userRegionTextureFieldOrder([
        { name: 'baseColor', type: 'color' },
        { name: 'baseColorTexture', type: 'texture2d' },
        { name: 'normalTexture', type: 'texture2d' },
      ]),
    ).toEqual(['baseColorTexture', 'normalTexture']);
    expect(userRegionTextureFieldOrder([])).toEqual([]);
    expect(userRegionTextureFieldOrder(undefined)).toEqual([
      'baseColorTexture',
      'metallicRoughnessTexture',
      'normalTexture',
      'emissiveTexture',
      'occlusionTexture',
      'transmissionTexture',
      'thicknessTexture',
      'bumpTexture',
      'metallicTexture',
      'roughnessTexture',
      'alphaTexture',
      'displacementTexture',
    ]);
  });

  it('keeps record binding on the cooked projection contract', () => {
    const recordSource = readFileSync(
      resolve(import.meta.dirname, '../record/main-pass-material.ts'),
      'utf8',
    );
    expect(recordSource).not.toMatch(/internals\.assets\.get<MaterialAsset>/);
    expect(recordSource).not.toMatch(/firstMaterial as \{/);
    expect(recordSource).not.toContain('baseColorHandle');
  });

  it.each([
    'group-0',
    'group-0-resource',
    'view-only',
    'view-and-scene-depth',
    'render-material-with-scene-depth',
    'render-material-and-scene-depth',
    'render-material',
  ] as const)('uses the explicit published binding contract: %s', (bindings) => {
    expect(resolveMaterialShaderBindingContract({ bindings })).toEqual({ bindings });
  });

  it('uses the documented ordinary material default without inspecting shader text', () => {
    expect(resolveMaterialShaderBindingContract(undefined)).toEqual({
      bindings: 'render-material',
    });
    expect(resolveMaterialShaderBindingContract({})).toEqual({ bindings: 'render-material' });
  });

  it('keeps the depth version with the binding interface across feature planning', () => {
    expect(
      resolveMaterialShaderBindingContract({
        bindings: 'view-and-scene-depth',
        sceneDepth: 'before-pass',
      }),
    ).toEqual({ bindings: 'view-and-scene-depth', sceneDepth: 'before-pass' });
  });
});

describe('material shader color-domain contract', () => {
  it('keeps shared sprite layouts stable while splitting standard clearcoat maps', () => {
    const sharedSpriteSchema = [{ name: 'tint', type: 'color' as const }];
    const standardClearcoatSchema = [
      { name: 'clearcoat', type: 'f32' as const },
      { name: 'clearcoatTexture', type: 'texture2d' as const },
    ];

    expect(effectiveMaterialLayoutIdentity('forgeax::sprite', sharedSpriteSchema)).toBeUndefined();
    expect(
      effectiveMaterialLayoutIdentity('forgeax::default-standard-pbr', standardClearcoatSchema),
    ).toBeTypeOf('string');
    expect(
      effectiveMaterialLayoutIdentity('forgeax::default-standard-pbr', [
        { name: 'clearcoat', type: 'f32' as const },
      ]),
    ).toBeUndefined();
  });

  it('routes HDR sprite targets to fs_main_hdr while unorm targets use fs_main', () => {
    const source = [
      readFileSync(resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../assembly/webgpu-ready.ts'), 'utf8'),
    ]
      .join('\n')
      .replaceAll('\r\n', '\n');
    expect(source).toContain(
      "isHdr &&\n      passKind === 'forward' &&\n      (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit')",
    );
    expect(source).toContain("? 'fs_main_hdr'");
    expect(source).toContain('colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat');
    expect(source).toContain("entryPoint = 'fs_main_hdr'");
  });

  it('keeps physical map layout derivation in the shared pipeline owner', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../assembly/material/layout-cache.ts'),
      'utf8',
    );
    expect(source).toContain('isCanonicalStandardPbrMaterialShader(materialShaderId)');
    expect(source).toContain('requiresStandardMapLayout');
  });

  it('does not reuse the scalar shared BGL for authored clearcoat maps', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../assembly/material/layout-cache.ts'),
      'utf8',
    );
    expect(source).toContain('!singleLayerMedium');
    expect(source).toContain('!clustered');
    expect(source).toContain('isSharedMaterialUserRegionCompatible');
  });

  it('keeps the fixed standard texture ABI before authored clearcoat slots', () => {
    const pipelineSource = readFileSync(resolve(import.meta.dirname, '../pbr-pipeline.ts'), 'utf8');
    const recordSource = readFileSync(
      resolve(import.meta.dirname, '../record/main-pass-material.ts'),
      'utf8',
    );
    expect(pipelineSource).toContain(
      'const physicalFields = physicalTextureFields(effectiveSchema)',
    );
    expect(pipelineSource).toContain('appendTextureInjection(effectiveSchema)');
    expect(recordSource).toContain('BUILTIN_USER_REGION_TEXTURE_FIELDS');
  });

  it('keeps scene-index entries and GPU-driven instance layouts on custom pipelines', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../assembly/material/pipeline-helpers.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /const sceneIndex =\s+[\s\S]*layoutKind === 'gpu-driven-pbr'[\s\S]*layoutKind === 'gpu-driven-skin'[\s\S]*layoutKind === 'gpu-driven-cluster-pbr'[\s\S]*layoutKind === 'gpu-driven-cluster-skin'/u,
    );
    expect(source).toContain('? (vertexEntryPoint ?? authoredVertexEntry)');
    expect(source).toMatch(
      /const instancesLayout =\s+[\s\S]*layoutKind === 'gpu-driven-pbr'[\s\S]*layoutKind === 'gpu-driven-skin'[\s\S]*layoutKind === 'gpu-driven-cluster-pbr'[\s\S]*layoutKind === 'gpu-driven-cluster-skin'[\s\S]*state\.gpuDrivenInstancesBindGroupLayout/u,
    );
  });
});

describe('material shader vertex input contract', () => {
  it('recognizes VsIn-style vertex input structs', () => {
    const source = `
      struct VsIn { @location(0) position: vec3<f32> }
      struct VsOut { @builtin(position) position: vec4<f32> }
      @vertex fn vs_main(input: VsIn) -> VsOut { var out: VsOut; return out }
    `;

    expect(resolveMaterialShaderVertexInputContract(source)).toBe('render-material');
  });

  it('does not treat fullscreen output locations as vertex inputs', () => {
    const source = `
      struct FullscreenOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      }
      @vertex fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
        var out: FullscreenOutput;
        return out;
      }
    `;

    expect(resolveMaterialShaderVertexInputContract(source)).toBe('none');
  });

  it('derives authored Standard UV aliases from the vertex input struct', () => {
    const source = `
      struct VsIn {
        @location(0) position: vec3<f32>,
        @location(2) uv: vec2<f32>,
        @location(6) uv1_: vec2<f32>,
        @location(12) uv7_: vec2<f32>,
      }
      struct VsOut { @builtin(position) position: vec4<f32> }
      @vertex fn vs_main(input: VsIn) -> VsOut { var out: VsOut; return out }
    `;

    expect(resolveMaterialShaderUvSetCount(source)).toBe(8);
  });

  it('keeps an explicit prepared vertex layout on a missing shader', () => {
    expect(allowsUnlitPreparedFallback(null, undefined)).toBe(true);
    expect(allowsUnlitPreparedFallback(null, 'position-size-color-instance', 'forward')).toBe(true);
    expect(
      allowsUnlitPreparedFallback(null, 'position-size-color-instance', 'forgeax::missing-shader'),
    ).toBe(false);
  });

  it('requires an exact material shader for every VFX prepared layout', () => {
    expect(requiresPreparedMaterialShader('billboard-material-instance')).toBe(true);
    expect(requiresPreparedMaterialShader('topology-segment-instance')).toBe(true);
    expect(requiresPreparedMaterialShader('mesh-geometry-material-instance')).toBe(true);
    expect(requiresPreparedMaterialShader('position-size-color-instance')).toBe(false);
    expect(requiresPreparedMaterialShader(undefined)).toBe(false);
  });
});
