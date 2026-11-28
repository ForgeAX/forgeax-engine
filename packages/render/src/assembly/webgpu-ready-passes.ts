import { SSAO_SCREEN_PROGRAMS } from '../ssao-screen-program';
import {
  STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS,
  STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS,
} from '../standard-attachments';
// Boot pipeline construction for one ready device generation: the shared PSO
// device provider, SPEC_CONST material prewarm, and the FXAA / skybox / SSAO
// fullscreen pipelines that stay outside the SPEC_CONST table.

import type {
  BindGroupLayout,
  BindGroupLayoutEntry,
  ComputePipeline,
  PipelineLayout,
  RenderPipeline,
  RhiDevice,
  Sampler,
} from '@forgeax/engine-rhi';
import {
  findVariantByKey,
  type PipelineGroup2Contract,
  type ShaderCatalog,
} from '@forgeax/engine-shader';
import { GPU_SHADER_STAGE_COMPUTE, GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import {
  cacheKeyOf,
  getOrBuildPipeline,
  getOrBuildPipelineAsync,
  type PipelineCache,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
} from '../pipeline-spec';
import type {
  FxaaPassResources,
  LegacyGtaoResources,
  LegacySsaoResources,
  PerPassResources,
  SkyboxPassResources,
} from '../record/render-context';
import type { DeferredAoNormalLayout } from '../ssao-config';
import { runShimSyncStep } from './renderer-helpers';
import { HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';
import type { EngineShaderModules } from './webgpu-ready-shaders';

export type PipelineModules = NonNullable<Parameters<typeof getOrBuildPipeline>[3]>;

/** Fullscreen triangle spec: no vertex buffers, no depth, no culling. */
export function fullscreenPipelineSpec(
  id: string,
  passKind: PipelineSpec['shader']['passKind'],
  colorFormat: PipelineSpec['attachments']['colorFormats'][number],
  sampleCount: PipelineSpec['attachments']['sampleCount'],
): PipelineSpec {
  return {
    shader: { id, passKind, variantSet: undefined },
    attachments: { colorFormats: [colorFormat], depthFormat: undefined, sampleCount },
    geometry: { topology: 'triangle-list', stripIndexFormat: undefined, vertexLayout: {} },
    renderState: { cullMode: 'none' },
  };
}

/** Background color shares the scene depth lifetime without testing or writing it. */
export function skyboxScenePipelineSpec(
  sampleCount: 1 | 4,
  depthFormat: GPUTextureFormat,
  colorFormat: GPUTextureFormat,
): PipelineSpec {
  const base = fullscreenPipelineSpec('forgeax::skybox::cube', 'skybox', colorFormat, sampleCount);
  return {
    ...base,
    attachments: { ...base.attachments, depthFormat },
    renderState: { ...base.renderState, depthCompare: 'always', depthWriteEnabled: false },
  };
}

/** Build through the shared cache; foreign failures become a structured PipelineSpecError. */
export function buildPipelineOrThrow(
  spec: PipelineSpec,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  modules: PipelineModules,
  hint: string,
): RenderPipeline {
  try {
    return getOrBuildPipeline(spec, provider, cache, modules) as RenderPipeline;
  } catch (err) {
    if (err instanceof PipelineSpecError) throw err;
    throw new PipelineSpecError({ code: 'pipeline-build-failed', detail: { cause: err }, hint });
  }
}

function isSpriteModule(modules: EngineShaderModules, fragmentModule: unknown): boolean {
  return fragmentModule === modules.sprite || fragmentModule === modules.spriteLit;
}

/**
 * Debug/test label derived from the fragment module and colour format; the
 * spec stays business-agnostic, so module identity names the PSO variant.
 */
function fragmentPipelineLabel(
  modules: EngineShaderModules,
  fragmentModule: unknown,
  isHdr: boolean,
  multisampled: boolean,
): string {
  if (fragmentModule === modules.sprite) return isHdr ? 'sprite-pipeline-hdr' : 'sprite-pipeline';
  if (fragmentModule === modules.spriteLit)
    return isHdr ? 'sprite-lit-pipeline-hdr' : 'sprite-lit-pipeline';
  if (fragmentModule === modules.unlit)
    return isHdr ? 'pbr-pipeline-unlit-hdr' : 'pbr-pipeline-unlit';
  if (fragmentModule === modules.pbr)
    return isHdr ? 'pbr-pipeline-standard-hdr' : 'pbr-pipeline-standard';
  if (fragmentModule === modules.fxaa) return 'fxaa-pipeline';
  if (fragmentModule === modules.skybox)
    return multisampled ? 'skybox-pipeline-msaa' : 'skybox-pipeline';
  if (fragmentModule === modules.bloomHorizontal) return 'bloom-horizontal-pipeline';
  if (fragmentModule === modules.bloomVertical) return 'bloom-vertical-pipeline';
  if (fragmentModule === modules.bloomComposite) return 'bloom-composite-pipeline';
  if (fragmentModule === modules.ssao) return 'ssao-calc-pipeline';
  return 'pbr-pipeline';
}

/**
 * Fills the pipeline layout when the spec descriptor carries none, swaps the
 * sprite HDR pass-through entry point, and labels each PSO. Vertex buffers stay
 * derived from the spec's vertex layout.
 */
export function createReadyPipelineDeviceProvider(
  device: RhiDevice,
  modules: EngineShaderModules,
  unlitPipelineLayout: PipelineLayout | null,
  pbrPipelineLayout: PipelineLayout,
): PipelineDeviceProvider {
  const normalizeDescriptor = (descriptor: Record<string, unknown>) => {
    const d = { ...descriptor } as Record<string, unknown>;
    if (d.layout === undefined) {
      d.layout =
        unlitPipelineLayout !== null &&
        (d.fragment as { module?: unknown } | undefined)?.module === modules.unlit
          ? unlitPipelineLayout
          : pbrPipelineLayout;
    }
    let label = 'pbr-pipeline';
    if (d.fragment) {
      const f = { ...(d.fragment as Record<string, unknown>) } as Record<string, unknown>;
      const targets = f.targets as Array<Record<string, unknown>> | undefined;
      const isHdr = targets?.[0]?.format === HDR_COLOR_ATTACHMENT_FORMAT;
      label = fragmentPipelineLabel(modules, f.module, isHdr, d.multisample !== undefined);
      if (isHdr && isSpriteModule(modules, f.module)) f.entryPoint = 'fs_main_hdr';
      d.fragment = f;
    }
    d.label = (d.label as string | undefined) ?? label;
    return d as Parameters<typeof device.createRenderPipeline>[0];
  };
  const createAsync = device.createRenderPipelineAsync;
  return {
    createRenderPipeline: (descriptor) =>
      device.createRenderPipeline(normalizeDescriptor(descriptor)),
    ...(createAsync === undefined
      ? {}
      : {
          createRenderPipelineAsync: (descriptor: Record<string, unknown>) =>
            createAsync.call(device, normalizeDescriptor(descriptor)),
        }),
  };
}

/**
 * Material shader modules by canonical id for SPEC_CONST prewarm. Sprite and
 * sprite-lit register under their single canonical ids, which the generic
 * per-MaterialShader cache reads for transparent passes.
 */
export function materialModulesById(
  modules: EngineShaderModules,
): ReadonlyMap<string, PipelineModules> {
  const byId = new Map<string, PipelineModules>();
  if (modules.unlit !== null)
    byId.set('forgeax::default-unlit', { vertex: modules.unlit, fragment: modules.unlit });
  if (modules.pbr !== null)
    byId.set('forgeax::default-standard-pbr', { vertex: modules.pbr, fragment: modules.pbr });
  if (modules.sprite !== null)
    byId.set('forgeax::sprite', { vertex: modules.sprite, fragment: modules.sprite });
  if (modules.spriteLit !== null)
    byId.set('forgeax::sprite-lit', { vertex: modules.spriteLit, fragment: modules.spriteLit });
  return byId;
}

/**
 * A prewarmed SPEC_CONST PSO by (shaderId, HDR, sampleCount), or null when its
 * module was not compiled (empty manifest) or the cache is cold.
 */
export function cachedSpecPipeline(
  specs: readonly PipelineSpec[],
  cache: PipelineCache,
  shaderId: string,
  isHdr: boolean,
  sampleCount: 1 | 4,
): RenderPipeline | null {
  const spec = specs.find(
    (entry) =>
      entry.shader.id === shaderId &&
      entry.attachments.sampleCount === sampleCount &&
      (entry.attachments.colorFormats[0] === HDR_COLOR_ATTACHMENT_FORMAT) === isHdr,
  );
  if (spec === undefined) return null;
  return (cache.get(cacheKeyOf(spec)) ?? null) as RenderPipeline | null;
}

/** Boot pipelines consume the same reflected UV requirement as lazy material pipelines. */
export function withMaterialVertexInputs(
  registry: ShaderCatalog,
  spec: Readonly<PipelineSpec>,
): Readonly<PipelineSpec> {
  const uvSetCount =
    registry.materialArtifact(spec.shader.id)?.program.uvSetCount ??
    registry.materialShaderManifestEntry(spec.shader.id)?.uvSetCount;
  return uvSetCount === undefined
    ? spec
    : { ...spec, geometry: { ...spec.geometry, shaderUvSetCount: uvSetCount } };
}

function group2ContractForSpec(
  registry: ShaderCatalog,
  spec: PipelineSpec,
): PipelineGroup2Contract {
  const material = [...registry.materialShaderManifestEntries()].find(
    (entry) => entry.identifier === spec.shader.id,
  );
  const source =
    material === undefined
      ? undefined
      : spec.shader.variantSet === undefined
        ? material?.variants[0]?.composedWgsl
        : findVariantByKey(material, spec.shader.variantSet)?.composedWgsl;
  return registry.materialProgram(source ?? '').group2;
}

/**
 * Build every SPEC_CONST entry whose shader module compiled; absent modules
 * (empty manifest) are skipped, and a failed build blocks the first frame.
 */
export async function prewarmMaterialSpecPipelines(
  specs: readonly PipelineSpec[],
  modulesById: ReadonlyMap<string, PipelineModules>,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
): Promise<void> {
  const unique = new Map<string, { spec: PipelineSpec; modules: PipelineModules }>();
  for (const spec of specs) {
    const key = cacheKeyOf(spec);
    const modules = modulesById.get(spec.shader.id);
    if (modules !== undefined && !unique.has(key)) unique.set(key, { spec, modules });
  }
  const results = await Promise.allSettled(
    [...unique.values()].map(async ({ spec, modules }) => {
      try {
        await getOrBuildPipelineAsync(spec, provider, cache, modules);
      } catch (error) {
        if (error instanceof PipelineSpecError) throw error;
        throw new PipelineSpecError({
          code: 'pipeline-build-failed',
          detail: { cause: error },
          hint: `Boot-time SPEC_CONST pre-warm failed for shader '${spec.shader.id}'; inspect gpuMessage on the cause`,
        });
      }
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

/**
 * The linear-LDR geometry target is separate from the swap-chain view target.
 * Seed every built material entry, including no-variant unlit, because
 * tonemap=none reaches the material cache directly on frame one.
 */
export function seedLinearLdrMaterialPipelines(
  specs: readonly PipelineSpec[],
  modulesById: ReadonlyMap<string, PipelineModules>,
  cache: PipelineCache,
  registry: ShaderCatalog,
  seedMaterialShaderPipelineCache: (
    key: string,
    pso: RenderPipeline,
    group2Contract: PipelineGroup2Contract,
  ) => void,
): void {
  for (const spec of specs) {
    if (modulesById.get(spec.shader.id) === undefined) continue;
    const key = cacheKeyOf(spec);
    const built = cache.get(key);
    if (built !== undefined)
      seedMaterialShaderPipelineCache(
        key,
        built as RenderPipeline,
        group2ContractForSpec(registry, spec),
      );
  }
}

export type FullscreenPassResources = Pick<
  PerPassResources,
  | 'fxaaPipeline'
  | 'fxaaBindGroupLayout'
  | 'fxaaSampler'
  | 'skyboxPipeline'
  | 'skyboxPipelineMsaa'
  | 'skyboxScenePipeline'
  | 'skyboxBindGroupLayout'
  | 'skyboxSampler'
  | 'skyboxRotationBuffer'
  | 'ssaoCalcPipeline'
  | 'ssaoBlurPipeline'
  | 'ssaoBgl'
> & {
  readonly gtaoComputePipeline: ComputePipeline | null;
  readonly gtaoComputeBgl: BindGroupLayout | null;
  readonly ssaoDepthCalcPipeline: RenderPipeline | null;
  readonly ssaoDepthBlurPipeline: RenderPipeline | null;
  readonly ssaoDepthBgl: BindGroupLayout | null;
  readonly gtaoScreenComputePipeline?: PerPassResources['gtaoScreenComputePipeline'];
  readonly ssaoScreenPipeline?: PerPassResources['ssaoScreenPipeline'];
  readonly ssaoGBufferPipelines?: PerPassResources['ssaoGBufferPipelines'];
  readonly gtaoGBufferComputePipeline?: PerPassResources['gtaoGBufferComputePipeline'];
};

export function emptyFullscreenPassResources(): FullscreenPassResources {
  return {
    fxaaPipeline: null,
    fxaaBindGroupLayout: null,
    fxaaSampler: null,
    skyboxPipeline: null,
    skyboxPipelineMsaa: null,
    skyboxBindGroupLayout: null,
    skyboxSampler: null,
    skyboxRotationBuffer: null,
    ssaoCalcPipeline: null,
    ssaoBlurPipeline: null,
    ssaoBgl: null,
    gtaoComputePipeline: null,
    gtaoComputeBgl: null,
    ssaoDepthCalcPipeline: null,
    ssaoDepthBlurPipeline: null,
    ssaoDepthBgl: null,
  };
}

function createSinglePipelineLayout(
  device: RhiDevice,
  label: string,
  bindGroupLayout: BindGroupLayout,
  expected: string,
  hint: string,
): PipelineLayout {
  const result = runShimSyncStep(
    () => device.createPipelineLayout({ label, bindGroupLayouts: [bindGroupLayout] }),
    'webgpu-runtime-error',
    expected,
    hint,
  );
  if (!result.ok) throw result.error;
  return result.value;
}

function createClampSampler(device: RhiDevice, label: string, expected: string): Sampler {
  const result = runShimSyncStep(
    () =>
      device.createSampler({
        label,
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    'webgpu-runtime-error',
    expected,
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * FXAA reads one texture through a linear clamp sampler (no edge bleed) plus
 * its output-policy UBO, and writes the non-sRGB final target.
 */
export function createFxaaPassResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  fxaaModule: NonNullable<EngineShaderModules['fxaa']>,
  colorFormat: PipelineSpec['attachments']['colorFormats'][number],
): FxaaPassResources {
  const bindGroupLayout = runShimSyncStep(
    () =>
      device.createBindGroupLayout({
        label: 'fxaa-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'float', viewDimension: '2d' },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' },
          },
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
        ],
      }),
    'webgpu-runtime-error',
    'createBindGroupLayout(fxaa) succeeded',
    'check device.limits.maxBindGroupsPerPipelineLayout',
  );
  if (!bindGroupLayout.ok) throw bindGroupLayout.error;
  const layout = createSinglePipelineLayout(
    device,
    'fxaa-pl',
    bindGroupLayout.value,
    'createPipelineLayout(fxaa) succeeded',
    'verify fxaa BindGroupLayout matches shader @group(0) bindings',
  );
  const pipeline = buildPipelineOrThrow(
    fullscreenPipelineSpec('forgeax::post::fxaa', 'post-process', colorFormat, 1),
    provider,
    cache,
    { vertex: fxaaModule, fragment: fxaaModule, layout },
    'createRenderPipeline (fxaa fullscreen) failed; inspect gpuMessage',
  );
  return {
    fxaaPipeline: pipeline,
    fxaaBindGroupLayout: bindGroupLayout.value,
    fxaaSampler: createClampSampler(device, 'fxaa-sampler', 'createSampler (fxaa) succeeded'),
  };
}

/** The MSAA skybox variant degrades gracefully; the single-sample skybox is unaffected. */
function buildSkyboxMsaaPipeline(
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  modules: PipelineModules,
): RenderPipeline | null {
  try {
    return getOrBuildPipeline(
      fullscreenPipelineSpec('forgeax::skybox::cube', 'skybox', HDR_COLOR_ATTACHMENT_FORMAT, 4),
      provider,
      cache,
      modules,
    ) as RenderPipeline;
  } catch (msaaErr) {
    console.warn(
      `[forgeax] skybox MSAA pipeline variant preparation failed; ` +
        `non-MSAA skybox unaffected. (cause: ${String(msaaErr)})`,
    );
    return null;
  }
}

/**
 * Skybox samples a cubemap (clamp avoids face seams) with the View and rotation
 * UBOs, writing HDR colour for the later tonemap pass.
 */
export function createSkyboxPassResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  skyboxModule: NonNullable<EngineShaderModules['skybox']>,
  createPersistentBuffer: RhiDevice['createBuffer'],
): SkyboxPassResources {
  const bindGroupLayout = runShimSyncStep(
    () =>
      device.createBindGroupLayout({
        label: 'skybox-bgl',
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'float', viewDimension: 'cube' },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' },
          },
          {
            binding: 2,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' },
          },
        ],
      }),
    'webgpu-runtime-error',
    'createBindGroupLayout(skybox) succeeded',
    'check device.limits.maxBindGroupsPerPipelineLayout',
  );
  if (!bindGroupLayout.ok) throw bindGroupLayout.error;
  const modules: PipelineModules = {
    vertex: skyboxModule,
    fragment: skyboxModule,
    fragmentEntryPoint: 'skybox_fs',
    layout: createSinglePipelineLayout(
      device,
      'skybox-pl',
      bindGroupLayout.value,
      'createPipelineLayout(skybox) succeeded',
      'verify skybox BindGroupLayout matches shader @group(0) bindings',
    ),
  };
  const pipeline = getOrBuildPipeline(
    fullscreenPipelineSpec('forgeax::skybox::cube', 'skybox', HDR_COLOR_ATTACHMENT_FORMAT, 1),
    provider,
    cache,
    modules,
  ) as RenderPipeline;
  const pipelineMsaa = buildSkyboxMsaaPipeline(provider, cache, modules);
  const sampler = createClampSampler(device, 'skybox-sampler', 'createSampler (skybox) succeeded');
  const rotationBuffer = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label: 'skybox-rotation-ubo',
        size: 16,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (skybox rotation) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
  if (!rotationBuffer.ok) throw rotationBuffer.error;
  return {
    skyboxPipeline: pipeline,
    skyboxPipelineMsaa: pipelineMsaa,
    skyboxScenePipeline(sampleCount, depthFormat, colorFormat) {
      return getOrBuildPipeline(
        skyboxScenePipelineSpec(sampleCount, depthFormat, colorFormat),
        provider,
        cache,
        modules,
      ) as RenderPipeline;
    },
    skyboxBindGroupLayout: bindGroupLayout.value,
    skyboxSampler: sampler,
    skyboxRotationBuffer: rotationBuffer.value,
  };
}

/** hdrp-ssao.wgsl @group(0); binding 4 is the prepass normal. */
const SSAO_BGL_ENTRIES: readonly BindGroupLayoutEntry[] = [
  { binding: 0, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
  { binding: 1, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
  {
    binding: 2,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
  },
  {
    binding: 3,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    sampler: { type: 'non-filtering' },
  },
  {
    binding: 4,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    texture: { sampleType: 'uint', viewDimension: '2d' },
  },
  {
    binding: 5,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    texture: { sampleType: 'depth', viewDimension: '2d' },
  },
  {
    binding: 6,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    sampler: { type: 'non-filtering' },
  },
  {
    binding: 7,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
  },
  {
    binding: 8,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    // Shared with binding 3 (one sampler resource); both entries must
    // declare the same sampler-type kind.
    sampler: { type: 'non-filtering' },
  },
];

/**
 * SSAO calculation and bilateral blur share the hdrp-ssao.wgsl layout and
 * module; distinct synthetic shader IDs keep their entry points in separate
 * cache keys. Packed normals use textureLoad; float noise and depth use
 * nearest sampling, so RGBA32F noise needs no float32-filterable feature.
 */
export function createLegacySsaoResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  ssaoModule: NonNullable<EngineShaderModules['ssao']>,
  gbufferV2: boolean,
  compactGBuffer: boolean,
): LegacySsaoResources {
  const bindGroupLayout = runShimSyncStep(
    () => device.createBindGroupLayout({ label: 'ssao-bgl', entries: SSAO_BGL_ENTRIES }),
    'webgpu-runtime-error',
    'createBindGroupLayout(ssao) succeeded',
    'check device.limits.maxBindGroupsPerPipelineLayout',
  );
  if (!bindGroupLayout.ok) throw bindGroupLayout.error;
  const baseModules = {
    vertex: ssaoModule,
    fragment: ssaoModule,
    vertexEntryPoint: 'vs_ssao',
    layout: createSinglePipelineLayout(
      device,
      'ssao-pl',
      bindGroupLayout.value,
      'createPipelineLayout(ssao) succeeded',
      'verify SSAO BindGroupLayout matches shader @group(2) bindings',
    ),
  };
  const calc = buildPipelineOrThrow(
    fullscreenPipelineSpec('forgeax::post::ssao-calc', 'post-process', 'rgba8unorm', 1),
    provider,
    cache,
    { ...baseModules, fragmentEntryPoint: 'fs_ssao_calc' },
    'createRenderPipeline (ssao-calc fullscreen) failed; inspect gpuMessage',
  );
  const blur = buildPipelineOrThrow(
    fullscreenPipelineSpec('forgeax::post::ssao-blur', 'post-process', 'r8unorm', 1),
    provider,
    cache,
    { ...baseModules, fragmentEntryPoint: 'fs_ssao_blur' },
    'createRenderPipeline (ssao-blur fullscreen) failed; inspect gpuMessage',
  );
  const gbufferPipelines = new Map<
    DeferredAoNormalLayout,
    { readonly calc: RenderPipeline; readonly blur: RenderPipeline }
  >();
  const ssaoGBufferPipelines = (layout: DeferredAoNormalLayout) => {
    const compact = layout === 'standard-gbuffer/4';
    if (compact ? !compactGBuffer : !gbufferV2) return undefined;
    const existing = gbufferPipelines.get(layout);
    if (existing !== undefined) return existing;
    const build = (entry: string, format: 'rgba8unorm' | 'r8unorm') => {
      const spec = fullscreenPipelineSpec(
        `forgeax::post::${entry}-${compact ? 'gbuffer-default' : 'gbuffer-v2'}`,
        'post-process',
        format,
        1,
      );
      return buildPipelineOrThrow(
        {
          ...spec,
          shader: {
            ...spec.shader,
            constants: compact
              ? STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS
              : STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS,
          },
        },
        provider,
        cache,
        { ...baseModules, fragmentEntryPoint: entry },
        `createRenderPipeline (${entry} ${layout}) failed`,
      );
    };
    const gbuffer = {
      calc: build('fs_ssao_calc', 'rgba8unorm'),
      blur: build('fs_ssao_blur', 'r8unorm'),
    };
    gbufferPipelines.set(layout, gbuffer);
    return gbuffer;
  };
  const depth = createSsaoDepthPipelines(device, provider, cache, ssaoModule);
  return {
    ssaoGBufferPipelines: gbufferV2 || compactGBuffer ? ssaoGBufferPipelines : undefined,
    ssaoCalcPipeline: calc,
    ssaoBlurPipeline: blur,
    ssaoBgl: bindGroupLayout.value,
    ...depth,
  };
}

/** Current screen-space passes select their own program and never need legacy layouts. */
export function createSsaoScreenPrograms(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  readModule: () => NonNullable<EngineShaderModules['ssao']>,
): Required<Pick<FullscreenPassResources, 'ssaoScreenPipeline' | 'gtaoScreenComputePipeline'>> {
  const screenPrograms = new Map<
    string,
    ReturnType<NonNullable<PerPassResources['ssaoScreenPipeline']>>
  >();
  const ssaoScreenPipeline: NonNullable<PerPassResources['ssaoScreenPipeline']> = (
    stage,
    normalLayout,
  ) => {
    const spec = SSAO_SCREEN_PROGRAMS[stage];
    const key = `${stage}:${normalLayout ?? 'depth'}`;
    const prior = screenPrograms.get(key);
    if (prior !== undefined) return prior;
    const layout = device
      .createBindGroupLayout({
        label: `ssao-${stage}-bgl`,
        entries: spec.bindings.map((binding) => ({
          binding,
          visibility: GPU_SHADER_STAGE_FRAGMENT,
          ...(binding === 14
            ? { buffer: { type: 'uniform' as const } }
            : {
                texture: {
                  sampleType:
                    binding === 5
                      ? ('depth' as const)
                      : binding === 4 || binding === 20
                        ? ('uint' as const)
                        : ('unfilterable-float' as const),
                  viewDimension: '2d' as const,
                },
              }),
        })),
      })
      .unwrap();
    const descriptor = fullscreenPipelineSpec(
      `forgeax::post::ssao-${key}`,
      'post-process',
      spec.format,
      1,
    );
    const constants =
      normalLayout === 'standard-gbuffer/4'
        ? STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS
        : normalLayout === 'standard-gbuffer/2'
          ? STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS
          : undefined;
    const module = readModule();
    const pipeline = buildPipelineOrThrow(
      constants === undefined
        ? descriptor
        : { ...descriptor, shader: { ...descriptor.shader, constants } },
      provider,
      cache,
      {
        vertex: module,
        fragment: module,
        vertexEntryPoint: 'vs_ssao',
        layout: createSinglePipelineLayout(
          device,
          `ssao-${stage}-pl`,
          layout,
          'SSAO Screen Pass',
          'verify the SSAO input contract',
        ),
        fragmentEntryPoint: spec.entry,
      },
      `createRenderPipeline(ssao-${stage}) failed`,
    );
    const prepared = { layout, pipeline };
    screenPrograms.set(key, prepared);
    return prepared;
  };
  const gtaoComputePrograms = new Map<
    string,
    { readonly pipeline: ComputePipeline; readonly layout: BindGroupLayout }
  >();
  const gtaoScreenComputePipeline: NonNullable<PerPassResources['gtaoScreenComputePipeline']> = (
    normalLayout,
  ) => {
    const key = normalLayout ?? 'depth';
    const existing = gtaoComputePrograms.get(key);
    if (existing !== undefined) return existing;
    const normal = normalLayout !== undefined;
    const bindings = SSAO_SCREEN_PROGRAMS[normal ? 'gtao-normal' : 'gtao-depth'].bindings;
    const layout = device
      .createBindGroupLayout({
        label: `gtao-compute-${key}-bgl`,
        entries: [
          ...bindings.map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            ...(binding === 14
              ? { buffer: { type: 'uniform' as const } }
              : {
                  texture: {
                    sampleType:
                      binding === 4
                        ? ('uint' as const)
                        : binding === 5
                          ? ('depth' as const)
                          : ('unfilterable-float' as const),
                    viewDimension: '2d' as const,
                  },
                }),
          })),
          {
            binding: 22,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const pipelineLayout = device
      .createPipelineLayout({
        label: `gtao-compute-${key}-pl`,
        bindGroupLayouts: [layout],
      })
      .unwrap();
    const constants =
      normalLayout === 'standard-gbuffer/4'
        ? STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS
        : normalLayout === 'standard-gbuffer/2'
          ? STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS
          : undefined;
    const pipeline = device
      .createComputePipeline({
        label: `standard-gtao-${key}`,
        layout: pipelineLayout,
        compute: {
          module: readModule(),
          entryPoint: normal ? 'cs_gtao_normal' : 'cs_gtao_depth',
          ...(constants === undefined ? {} : { constants }),
        },
      })
      .unwrap();
    const prepared = { layout, pipeline };
    gtaoComputePrograms.set(key, prepared);
    return prepared;
  };
  return { ssaoScreenPipeline, gtaoScreenComputePipeline };
}

/**
 * Depth-only prepass AO: the *_depth entries reconstruct normals from depth and
 * never declare gbuffer_normal, so their layout omits binding 4.
 */
function createSsaoDepthPipelines(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  ssaoModule: NonNullable<EngineShaderModules['ssao']>,
): Pick<
  FullscreenPassResources,
  'ssaoDepthCalcPipeline' | 'ssaoDepthBlurPipeline' | 'ssaoDepthBgl'
> {
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'ssao-depth-bgl',
    entries: SSAO_BGL_ENTRIES.filter((entry) => entry.binding !== 4),
  });
  if (!bindGroupLayout.ok) throw bindGroupLayout.error;
  const modules = {
    vertex: ssaoModule,
    fragment: ssaoModule,
    vertexEntryPoint: 'vs_ssao',
    layout: createSinglePipelineLayout(
      device,
      'ssao-depth-pl',
      bindGroupLayout.value,
      'createPipelineLayout(ssao-depth) succeeded',
      'verify the depth-only SSAO layout matches the *_depth entries',
    ),
  };
  return {
    ssaoDepthCalcPipeline: buildPipelineOrThrow(
      fullscreenPipelineSpec('forgeax::post::ssao-calc-depth', 'post-process', 'rgba8unorm', 1),
      provider,
      cache,
      { ...modules, fragmentEntryPoint: 'fs_ssao_calc_depth' },
      'createRenderPipeline (ssao-calc-depth fullscreen) failed; inspect gpuMessage',
    ),
    ssaoDepthBlurPipeline: buildPipelineOrThrow(
      fullscreenPipelineSpec('forgeax::post::ssao-blur-depth', 'post-process', 'r8unorm', 1),
      provider,
      cache,
      { ...modules, fragmentEntryPoint: 'fs_ssao_blur_depth' },
      'createRenderPipeline (ssao-blur-depth fullscreen) failed; inspect gpuMessage',
    ),
    ssaoDepthBgl: bindGroupLayout.value,
  };
}

export function createLegacyGtaoResources(
  device: RhiDevice,
  module: NonNullable<EngineShaderModules['gtaoCompute']>,
  gbufferV2: boolean,
): LegacyGtaoResources {
  const layout = device.createBindGroupLayout({
    label: 'gtao-compute-bgl',
    entries: [
      { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
      {
        binding: 4,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'uint', viewDimension: '2d' },
      },
      {
        binding: 5,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'depth', viewDimension: '2d' },
      },
      {
        binding: 9,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
      },
    ],
  });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = device.createPipelineLayout({
    label: 'gtao-compute-pipeline-layout',
    bindGroupLayouts: [layout.value],
  });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  const pipeline = device.createComputePipeline({
    label: 'gtao-raw-compute',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'cs_gtao_calc' },
  });
  if (!pipeline.ok) throw pipeline.error;
  let gbuffer: ComputePipeline | undefined;
  return {
    gtaoComputePipeline: pipeline.value,
    gtaoComputeBgl: layout.value,
    gtaoGBufferComputePipeline: gbufferV2
      ? () => {
          gbuffer ??= device
            .createComputePipeline({
              label: 'gtao-raw-compute-gbuffer-v2',
              layout: pipelineLayout.value,
              compute: {
                module,
                entryPoint: 'cs_gtao_calc',
                constants: STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS,
              },
            })
            .unwrap();
          return gbuffer;
        }
      : undefined,
  };
}

/** FXAA, skybox and SSAO pipelines for each compiled module, in that order. */
export function createFullscreenPassResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  modules: EngineShaderModules,
  fxaaColorFormat: PipelineSpec['attachments']['colorFormats'][number],
  createPersistentBuffer: RhiDevice['createBuffer'],
): FullscreenPassResources {
  const empty = emptyFullscreenPassResources();
  const fxaa =
    modules.fxaa === null
      ? empty
      : createFxaaPassResources(device, provider, cache, modules.fxaa, fxaaColorFormat);
  const skybox =
    modules.skybox === null
      ? empty
      : createSkyboxPassResources(device, provider, cache, modules.skybox, createPersistentBuffer);
  const ssao =
    modules.ssao === null
      ? empty
      : createLegacySsaoResources(
          device,
          provider,
          cache,
          modules.ssao,
          modules.ssaoGBufferV2 === true,
          modules.ssaoCompactGBuffer === true,
        );
  const gtaoCompute =
    modules.gtaoCompute === null
      ? empty
      : createLegacyGtaoResources(device, modules.gtaoCompute, modules.gtaoGBufferV2 === true);
  const module = modules.ssao;
  const screen =
    module === null ? empty : createSsaoScreenPrograms(device, provider, cache, () => module);
  return {
    fxaaPipeline: fxaa.fxaaPipeline,
    fxaaBindGroupLayout: fxaa.fxaaBindGroupLayout,
    fxaaSampler: fxaa.fxaaSampler,
    skyboxPipeline: skybox.skyboxPipeline,
    skyboxPipelineMsaa: skybox.skyboxPipelineMsaa,
    skyboxScenePipeline: skybox.skyboxScenePipeline,
    skyboxBindGroupLayout: skybox.skyboxBindGroupLayout,
    skyboxSampler: skybox.skyboxSampler,
    skyboxRotationBuffer: skybox.skyboxRotationBuffer,
    ssaoGBufferPipelines: ssao.ssaoGBufferPipelines,
    gtaoGBufferComputePipeline: gtaoCompute.gtaoGBufferComputePipeline,
    ssaoCalcPipeline: ssao.ssaoCalcPipeline,
    ssaoBlurPipeline: ssao.ssaoBlurPipeline,
    ssaoBgl: ssao.ssaoBgl,
    gtaoComputePipeline: gtaoCompute.gtaoComputePipeline ?? null,
    gtaoComputeBgl: gtaoCompute.gtaoComputeBgl ?? null,
    ssaoDepthCalcPipeline: ssao.ssaoDepthCalcPipeline ?? null,
    ssaoDepthBlurPipeline: ssao.ssaoDepthBlurPipeline ?? null,
    ssaoDepthBgl: ssao.ssaoDepthBgl ?? null,
    ssaoScreenPipeline: screen.ssaoScreenPipeline,
    gtaoScreenComputePipeline: screen.gtaoScreenComputePipeline,
  };
}
