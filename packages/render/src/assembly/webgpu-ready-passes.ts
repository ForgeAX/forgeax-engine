// Boot pipeline construction for one ready device generation: the shared PSO
// device provider, SPEC_CONST material prewarm, and the FXAA / skybox / SSAO
// fullscreen pipelines that stay outside the SPEC_CONST table.

import type {
  BindGroupLayout,
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
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import {
  cacheKeyOf,
  getOrBuildPipeline,
  type PipelineCache,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
} from '../pipeline-spec';
import type { PerPassResources } from '../record/render-context';
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
  unlitPipelineLayout: PipelineLayout,
  pbrPipelineLayout: PipelineLayout,
): PipelineDeviceProvider {
  return {
    createRenderPipeline(descriptor: Record<string, unknown>) {
      const d = { ...descriptor } as Record<string, unknown>;
      if (d.layout === undefined) {
        d.layout =
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
      return device.createRenderPipeline(d as Parameters<typeof device.createRenderPipeline>[0]);
    },
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
export function prewarmMaterialSpecPipelines(
  specs: readonly PipelineSpec[],
  modulesById: ReadonlyMap<string, PipelineModules>,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
): void {
  for (const spec of specs) {
    const modules = modulesById.get(spec.shader.id);
    if (modules === undefined) continue;
    buildPipelineOrThrow(
      spec,
      provider,
      cache,
      modules,
      `Boot-time SPEC_CONST pre-warm failed for shader '${spec.shader.id}'; inspect gpuMessage on the cause`,
    );
  }
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
  | 'skyboxBindGroupLayout'
  | 'skyboxSampler'
  | 'skyboxRotationBuffer'
  | 'skyboxModule'
  | 'ssaoCalcPipeline'
  | 'ssaoBlurPipeline'
  | 'ssaoBgl'
>;

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
    skyboxModule: null,
    ssaoCalcPipeline: null,
    ssaoBlurPipeline: null,
    ssaoBgl: null,
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
function createFxaaPassResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  fxaaModule: NonNullable<EngineShaderModules['fxaa']>,
  colorFormat: PipelineSpec['attachments']['colorFormats'][number],
): Pick<FullscreenPassResources, 'fxaaPipeline' | 'fxaaBindGroupLayout' | 'fxaaSampler'> {
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
      `[forgeax] skybox MSAA pipeline variant build failed at renderer init; ` +
        `non-MSAA skybox unaffected. (cause: ${String(msaaErr)})`,
    );
    return null;
  }
}

/**
 * Skybox samples a cubemap (clamp avoids face seams) with the View and rotation
 * UBOs, writing HDR colour for the later tonemap pass.
 */
function createSkyboxPassResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  skyboxModule: NonNullable<EngineShaderModules['skybox']>,
  createPersistentBuffer: RhiDevice['createBuffer'],
): Pick<
  FullscreenPassResources,
  | 'skyboxPipeline'
  | 'skyboxPipelineMsaa'
  | 'skyboxBindGroupLayout'
  | 'skyboxSampler'
  | 'skyboxRotationBuffer'
  | 'skyboxModule'
> {
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
    skyboxBindGroupLayout: bindGroupLayout.value,
    skyboxSampler: sampler,
    skyboxRotationBuffer: rotationBuffer.value,
    skyboxModule,
  };
}

/**
 * SSAO calculation and bilateral blur share the hdrp-ssao.wgsl layout and
 * module; distinct synthetic shader IDs keep their entry points in separate
 * cache keys. Packed normals use textureLoad; float noise and depth use
 * nearest sampling, so RGBA32F noise needs no float32-filterable feature.
 */
function createSsaoPassResources(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  ssaoModule: NonNullable<EngineShaderModules['ssao']>,
): Pick<FullscreenPassResources, 'ssaoCalcPipeline' | 'ssaoBlurPipeline' | 'ssaoBgl'> {
  const bindGroupLayout = runShimSyncStep(
    () =>
      device.createBindGroupLayout({
        label: 'ssao-bgl',
        entries: [
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
        ],
      }),
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
  return { ssaoCalcPipeline: calc, ssaoBlurPipeline: blur, ssaoBgl: bindGroupLayout.value };
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
    modules.ssao === null ? empty : createSsaoPassResources(device, provider, cache, modules.ssao);
  return {
    fxaaPipeline: fxaa.fxaaPipeline,
    fxaaBindGroupLayout: fxaa.fxaaBindGroupLayout,
    fxaaSampler: fxaa.fxaaSampler,
    skyboxPipeline: skybox.skyboxPipeline,
    skyboxPipelineMsaa: skybox.skyboxPipelineMsaa,
    skyboxBindGroupLayout: skybox.skyboxBindGroupLayout,
    skyboxSampler: skybox.skyboxSampler,
    skyboxRotationBuffer: skybox.skyboxRotationBuffer,
    skyboxModule: skybox.skyboxModule ?? null,
    ssaoCalcPipeline: ssao.ssaoCalcPipeline,
    ssaoBlurPipeline: ssao.ssaoBlurPipeline,
    ssaoBgl: ssao.ssaoBgl,
  };
}
