import { nowMs } from '@forgeax/engine-platform';
import {
  ShaderSource,
  shaderSourceDescriptor,
  shaderSourceForDescriptor,
} from '@forgeax/engine-types';
import { ShadowViewResources } from '../record/shadow-view-resources';
import type { SeedShaderModule } from './material-shader-policy';
// WebGPU generation-scoped ready-state builder.
// This owner performs one complete device-generation promotion; it receives
// policy/adapters and returns a fully prepared PipelineState.

import type {
  PipelineLayout,
  PipelineLibraryManifest,
  RenderPipeline,
  Result,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import {
  isShaderTemplateManifestRow,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  manifestShaderSource,
  materialShaderPreparedSourceRows,
  materialShaderSource,
  type PipelineGroup2Contract,
  type ShaderCatalog,
  TAA_SCENE_VELOCITY_WGSL,
} from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';
import { prepareDepthOfFieldBuiltins } from '../features/depth-of-field/depth-of-field-assembly';
import { sceneVelocityComputeSource } from '../features/motion-blur/scene-velocity-motion-blur';
import {
  SCENE_VELOCITY_TEMPORAL_LABEL,
  SCENE_VELOCITY_TEMPORAL_WGSL,
} from '../temporal/default-gbuffer-velocity';
import type { RhiBackendPack } from './backend-contract';
import {
  prepareSsrWithDepthPyramid,
  prepareUtilityShaders,
  VOLUMETRIC_FOG_SHADER_STAGES,
} from './utility-shader-prewarm';

export type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

import type { GpuResidencyCache } from '../device/gpu-residency';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import type { DeviceScope, RhiErrorListenerRegistry } from '../lifecycle';
import { type PbrPipelineLayoutBundle, SKIN_MATERIAL_SHADER_ID } from '../pbr-pipeline';
import {
  buildLinearLdrMaterialSpecTable,
  buildSpecConstTable,
  type PipelineCache,
  type PipelineSpec,
} from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import { createPointsLinesViewBuffer } from '../record/points-lines-view-buffer';
import { STATIC_SHADOW_DEPTH_CLEAR_SHADER } from '../record/shadow-pass';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import { type PipelineState, selectSwapChainFormat } from '../render-system';
import { TRANSMISSION_MERGE_LABEL, TRANSMISSION_MERGE_WGSL } from '../transmission/merge';
import { createExtendedLightingFallbackResources } from './extended-lighting-fallback';
import { createLayeredTextureFallbackViews } from './layered-texture-fallback';
import { prewarmRequiredMaterialShaders } from './material-shader-prewarm';
import {
  type MeshSsboGrowResult,
  type MeshSsboState,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
import type { FullscreenProgramRequirement } from './render-feature-post-processes';
import {
  prewarmMaterialShaderVariants,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
  type VariantPrewarmAdmission,
} from './shader-prewarm-policy';
import { createShadowArrayFallbackView } from './shadow-array-fallback';
import { createTemporalShaderPrewarmer } from './temporal-post-process-prewarm';
import { buildClusterMembershipProducer, resolveStandardClusterAbi } from './webgpu-cluster-ready';
import { buildGpuDrivenPbrReadyLayouts, buildGpuDrivenPbrReadyModules } from './webgpu-pbr-ready';
import { createBloomResourceOwner } from './webgpu-ready-bloom';
import { prepareRendererMipmaps } from './webgpu-ready-mipmap';
import {
  cachedSpecPipeline,
  createFullscreenPassResources,
  createFxaaPassResources,
  createLegacyGtaoResources,
  createLegacySsaoResources,
  createReadyPipelineDeviceProvider,
  createSkyboxPassResources,
  createSsaoScreenPrograms,
  emptyFullscreenPassResources,
  materialModulesById,
  prewarmMaterialSpecPipelines,
  seedLinearLdrMaterialPipelines,
  withMaterialVertexInputs,
} from './webgpu-ready-passes';
import { createReadyPerPassResources } from './webgpu-ready-per-pass';
import {
  buildHdrpPipelineLayouts,
  buildReadyPbrLayouts,
  buildUnlitPipelineLayout,
  createAtmosphereFallbackView,
  createGpuDrivenClusterPipelineLayout,
  createIdentityInstanceBuffer,
  createReadyMeshSsboController,
  createReadySamplers,
  createReadySkylightFallback,
  createShadowAtlasFallbackView,
  createShadowCasterCascadeBuffer,
  createShadowFallbackDepthView,
  createShadowParamsBuffer,
  createTexelFallbackView,
  createViewUniformBuffer,
  type HdrpPipelineLayouts,
} from './webgpu-ready-resources';
import {
  type CompileShaderModule,
  compileManifestModule,
  compileShaderModule,
  compileSpriteLitModules,
  compileSpriteModules,
  compileUnlitModules,
  createShaderModuleResult,
  deriveReadyDeviceCapabilities,
  type EngineShaderModules,
  emptyEngineShaderModules,
  findEngineManifestEntry,
  findMaterialShaderEntry,
  prepareAtmospherePrograms,
  prepareStandardSceneSources,
  prewarmFullscreenPostProcesses,
  prewarmPointsLinesProgram,
  prewarmShadowCasterModules,
  publishIblPrograms,
  type ResolvedEngineManifestEntries,
  resolveEngineManifestEntries,
  seedPbrSourceAliases,
} from './webgpu-ready-shaders';

export async function prepareDevicePipelineLibrary(
  device: RhiDevice,
  manifest: PipelineLibraryManifest,
  shader: Pick<ShaderCatalog, 'materialProgram'>,
  owner?: object,
): Promise<void> {
  if (device.pipelineLibrary === undefined) return;
  const sources = manifest.shaders.map(
    (descriptor) => shaderSourceForDescriptor(descriptor) ?? new ShaderSource([descriptor.code]),
  );
  const prepared = await device.pipelineLibrary.prepare(manifest, {
    renderTargetPolicy: 'device-compatible',
    ...(owner === undefined ? {} : { owner }),
    sources,
  });
  if (!prepared.ok) throw prepared.error;
  // Native compilation and CPU source analysis share the captured graphics
  // roster. Keep first-use analysis out of draw even when the PSO is already
  // warm; the registry owns reuse across passes and device generations.
  const modules = new Set<number>();
  for (const pipeline of manifest.renderPipelines) {
    modules.add(pipeline.vertex.module);
    if (pipeline.fragment !== undefined) modules.add(pipeline.fragment.module);
  }
  for (const module of modules)
    shader.materialProgram(sources[module] as import('@forgeax/engine-types').ShaderSource);
}

/** CPU analysis slice of the background lane; menu frames keep their task turns. */
const BACKGROUND_ANALYSIS_SLICE_MS = 4;

/**
 * Non-blocking pipeline library lane started after renderer readiness. The
 * backend bounds shader validation and compilation, publishing each completed program as a
 * library hit. CPU source analysis only memoizes the first-use material
 * program analysis, so it runs in time-sliced tasks beside native work; a
 * skipped module is analyzed on first use exactly as without the library.
 * Never rejects: the first failure is reported once and the affected
 * pipelines compile on first use.
 */
export async function prepareBackgroundPipelineLibrary(
  device: RhiDevice,
  manifest: PipelineLibraryManifest,
  shader: () => Pick<ShaderCatalog, 'materialProgram'>,
  active: () => boolean,
  report: (cause: unknown) => void,
  owner: object,
  concurrency?: number,
): Promise<void> {
  const library = device.pipelineLibrary;
  if (library === undefined) return;
  let reported = false;
  const fail = (cause: unknown) => {
    if (reported || !active()) return;
    reported = true;
    report(cause);
  };
  const analyze = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const modules = new Set<number>();
    for (const pipeline of manifest.renderPipelines) {
      modules.add(pipeline.vertex.module);
      if (pipeline.fragment !== undefined) modules.add(pipeline.fragment.module);
    }
    let slice = nowMs();
    for (const module of modules) {
      if (nowMs() - slice >= BACKGROUND_ANALYSIS_SLICE_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        slice = nowMs();
      }
      if (!active()) return;
      const descriptor = manifest.shaders[module];
      if (descriptor !== undefined)
        shader().materialProgram(
          shaderSourceForDescriptor(descriptor) ?? new ShaderSource([descriptor.code]),
        );
    }
  };
  await Promise.all([
    library
      .prepare(manifest, {
        renderTargetPolicy: 'device-compatible',
        background: true,
        owner,
        ...(concurrency === undefined ? {} : { concurrency }),
        sources: manifest.shaders.map(
          (descriptor) =>
            shaderSourceForDescriptor(descriptor) ?? new ShaderSource([descriptor.code]),
        ),
      })
      .then((prepared) => {
        if (!prepared.ok) fail(prepared.error);
      }, fail),
    analyze().catch(fail),
  ]);
}

/**
 * The 'null' (headless RhiNull) backend has no preferred canvas format by
 * design; its rgba8unorm fallback is the intended steady state. Real backends
 * that lack navigator.gpu.getPreferredCanvasFormat report a structured
 * diagnostic and continue with the rgba8unorm fallback.
 */
function reportSwapChainFormatFallback(
  device: RhiDevice,
  formats: ReturnType<typeof selectSwapChainFormat>,
  errorRegistry: RhiErrorListenerRegistry,
): void {
  if (formats.fallbackReason === undefined || device.caps.backendKind === 'null') return;
  errorRegistry.fire(
    new RhiError({
      code: 'rhi-not-available',
      expected: 'navigator.gpu.getPreferredCanvasFormat is callable on Channel 2',
      hint: 'browser is too old or WebGPU implementation incomplete; falling back to rgba8unorm swap-chain format. Update the UA or use a Channel-3-compatible canvas configuration.',
    }),
  );
}

type GpuDrivenReadyLayouts = ReturnType<typeof buildGpuDrivenPbrReadyLayouts>;

type BootModuleLayouts = Pick<
  PipelineState,
  | 'pbrPipelineLayout'
  | 'gpuDrivenInstancesBindGroupLayout'
  | 'gpuDrivenPrimitiveBindGroupLayout'
  | 'gpuDrivenSkinPrimitiveBindGroupLayout'
  | 'gpuDrivenPbrPipelineLayout'
  | 'gpuDrivenPbrSkinPipelineLayout'
  | 'surfaceDirectInstancesBindGroupLayout'
  | 'sceneDirectInstancesBindGroupLayout'
  | 'sceneDirectPipelineLayout'
  | 'sceneDirectClusterPipelineLayout'
  | 'hdrpPbrPipelineLayout'
  | 'hdrpProbePbrPipelineLayout'
  | 'pbrSkinPipelineLayout'
  | 'pbrSkinProbePipelineLayout'
  | 'pbrSkinMeshBindGroupLayout'
  | 'hdrpSkinPipelineLayout'
  | 'hdrpSkinMeshBindGroupLayout'
>;

/**
 * An admitted engine publication supplies material pipeline layouts. The
 * camera-only empty manifest publishes null and cannot issue geometry.
 */
function selectBootModuleLayouts(
  hasEnginePublication: boolean,
  pbrLayouts: PbrPipelineLayoutBundle,
  hdrp: HdrpPipelineLayouts,
  gpuDriven: GpuDrivenReadyLayouts,
  sceneDirectClusterPipelineLayout: PipelineLayout | null,
): BootModuleLayouts {
  if (!hasEnginePublication) {
    return {
      pbrPipelineLayout: null,
      gpuDrivenInstancesBindGroupLayout: null,
      gpuDrivenPrimitiveBindGroupLayout: null,
      gpuDrivenSkinPrimitiveBindGroupLayout: null,
      gpuDrivenPbrPipelineLayout: null,
      gpuDrivenPbrSkinPipelineLayout: null,
      surfaceDirectInstancesBindGroupLayout: null,
      sceneDirectInstancesBindGroupLayout: null,
      sceneDirectPipelineLayout: null,
      sceneDirectClusterPipelineLayout: null,
      hdrpPbrPipelineLayout: null,
      hdrpProbePbrPipelineLayout: null,
      pbrSkinPipelineLayout: null,
      pbrSkinProbePipelineLayout: null,
      pbrSkinMeshBindGroupLayout: null,
      hdrpSkinPipelineLayout: null,
      hdrpSkinMeshBindGroupLayout: null,
    };
  }
  return {
    pbrPipelineLayout: pbrLayouts.pipelineLayout,
    gpuDrivenInstancesBindGroupLayout: gpuDriven.gpuDrivenInstancesBindGroupLayout,
    gpuDrivenPrimitiveBindGroupLayout: gpuDriven.gpuDrivenPrimitiveBindGroupLayout,
    gpuDrivenSkinPrimitiveBindGroupLayout: gpuDriven.gpuDrivenSkinPrimitiveBindGroupLayout,
    gpuDrivenPbrPipelineLayout: gpuDriven.gpuDrivenPbrPipelineLayout,
    gpuDrivenPbrSkinPipelineLayout: gpuDriven.gpuDrivenPbrSkinPipelineLayout,
    surfaceDirectInstancesBindGroupLayout: gpuDriven.surfaceDirectInstancesBindGroupLayout,
    sceneDirectInstancesBindGroupLayout: gpuDriven.sceneDirectInstancesBindGroupLayout,
    sceneDirectPipelineLayout: gpuDriven.sceneDirectPipelineLayout,
    sceneDirectClusterPipelineLayout,
    hdrpPbrPipelineLayout: hdrp.pbrPipelineLayout,
    hdrpProbePbrPipelineLayout: hdrp.probePbrPipelineLayout,
    pbrSkinPipelineLayout: gpuDriven.pbrSkinPipelineLayout,
    pbrSkinProbePipelineLayout: gpuDriven.pbrSkinProbePipelineLayout,
    pbrSkinMeshBindGroupLayout: gpuDriven.pbrSkinMeshBindGroupLayout,
    hdrpSkinPipelineLayout: gpuDriven.hdrpSkinPipelineLayout,
    hdrpSkinMeshBindGroupLayout: gpuDriven.hdrpSkinMeshBindGroupLayout,
  };
}

/** Screen AO shares the SSAO module with legacy SSAO, but owns its pipeline layouts. */
function nativeAoPrograms(
  device: RhiDevice,
  provider: Parameters<typeof createSsaoScreenPrograms>[1],
  cache: PipelineCache,
  modules: EngineShaderModules,
  entries: NonNullable<EngineShaderModules['fullscreenOnDemand']>,
  compile: (source: string, label: string) => ShaderModule,
) {
  const ssao = entries.ssao;
  const gtao = entries.gtaoCompute;
  let legacySsao: ReturnType<typeof createLegacySsaoResources> | undefined;
  let legacyGtao: ReturnType<typeof createLegacyGtaoResources> | undefined;
  const readSsao =
    ssao === undefined
      ? undefined
      : () => {
          modules.ssao ??= compile(ssao.wgsl, 'hdrp-ssao');
          return modules.ssao;
        };
  return {
    ...(readSsao === undefined
      ? {}
      : {
          ...createSsaoScreenPrograms(device, provider, cache, readSsao),
          getLegacySsaoResources() {
            legacySsao ??= createLegacySsaoResources(
              device,
              provider,
              cache,
              readSsao(),
              modules.ssaoGBufferV2 === true,
              modules.ssaoCompactGBuffer === true,
            );
            return legacySsao;
          },
        }),
    ...(gtao === undefined
      ? {}
      : {
          getLegacyGtaoResources() {
            modules.gtaoCompute ??= compile(gtao.wgsl, 'hdrp-gtao-compute');
            legacyGtao ??= createLegacyGtaoResources(
              device,
              modules.gtaoCompute,
              modules.gtaoGBufferV2 === true,
            );
            return legacyGtao;
          },
        }),
  };
}

/** Immediate-only programs share the same device-owned slots as eager modules. */
function createNativeFullscreenDemand(
  device: RhiDevice,
  provider: Parameters<typeof createFxaaPassResources>[1],
  cache: PipelineCache,
  modules: EngineShaderModules,
  createImmediate: RhiBackendPack['createShaderModuleImmediate'],
  fxaaFormat: Parameters<typeof createFxaaPassResources>[4],
  createBuffer: RhiDevice['createBuffer'],
  seed: SeedShaderModule,
): Pick<
  import('../record/render-context').PerPassResources,
  | 'getFxaaResources'
  | 'getSkyboxResources'
  | 'getLegacySsaoResources'
  | 'getLegacyGtaoResources'
  | 'ssaoScreenPipeline'
  | 'gtaoScreenComputePipeline'
> & {
  readonly prepareBloomModules?: () => void;
} {
  const entries = modules.fullscreenOnDemand;
  if (entries === undefined || createImmediate === undefined) return {};
  const compile = (source: string, label: string): ShaderModule =>
    createImmediate(device, shaderSourceDescriptor(source, label)).unwrap();
  let fxaa: ReturnType<typeof createFxaaPassResources> | undefined;
  let skybox: ReturnType<typeof createSkyboxPassResources> | undefined;
  return {
    ...nativeAoPrograms(device, provider, cache, modules, entries, compile),
    getFxaaResources() {
      const entry = entries.fxaa;
      if (entry === undefined) return undefined;
      if (fxaa !== undefined) return fxaa;
      const source = entry.wgsl;
      modules.fxaa ??= compile(source, 'fxaa');
      const module = modules.fxaa;
      seed(postProcessShaderModuleLabel(source), module, source);
      fxaa = createFxaaPassResources(device, provider, cache, module, fxaaFormat);
      return fxaa;
    },
    getSkyboxResources() {
      const entry = entries.skybox;
      if (entry === undefined) return undefined;
      if (skybox !== undefined) return skybox;
      modules.skybox ??= compile(entry.wgsl, 'skybox');
      skybox = createSkyboxPassResources(device, provider, cache, modules.skybox, createBuffer);
      return skybox;
    },
    prepareBloomModules() {
      if (entries.bloomHorizontal !== undefined)
        modules.bloomHorizontal ??= compile(entries.bloomHorizontal.wgsl, 'bloom-horizontal');
      if (entries.bloomVertical !== undefined)
        modules.bloomVertical ??= compile(entries.bloomVertical.wgsl, 'bloom-vertical');
      if (entries.bloomComposite !== undefined)
        modules.bloomComposite ??= compile(entries.bloomComposite.wgsl, 'bloom-composite');
    },
  };
}

/**
 * Load the manifest, compile pipelines and upload builtins before promoting one
 * complete device generation. Failure short-circuits initialization with the
 * owning RHI/Shader error; the first draw requires successful initialization.
 */
export async function buildReadyWebGPU(
  rhiDevice: RhiDevice,
  rendererScope: DeviceScope,
  getShader: () => ShaderCatalog,
  gpuStore: GpuResidencyCache,
  asyncCreateShaderModule:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Promise<Result<ShaderModule, RhiError>>)
    | undefined,
  immediateCreateShaderModule: RhiBackendPack['createShaderModuleImmediate'],
  errorRegistry: RhiErrorListenerRegistry,
  /**
   * Material shader modules declared by producer features. These are compiled
   * during Renderer.initialization so prepared graphics do not fail on their first
   * frame while the shared async shader adapter is still warming up.
   */
  requiredMaterialShaders: readonly string[],
  standardPbrShaderUvSetCount: number,
  /** Fullscreen feature modules compiled before the first synchronous frame. */
  requiredFullscreenPostProcesses: readonly FullscreenProgramRequirement[],
  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 /
  // T-M2-05 + M3 / T-M3-04: surface for setting `internals.growMeshSsbo`
  // + `internals.meshSsboState` so the record stage's
  // `ensureMeshSsboCapacity` hook can reach both. The mesh-SSBO grow
  // controller is owned in this function's scope, so the cleanest expose
  // path is a callback that buildReadyWebGPU invokes once after
  // `meshSsboController` is wired (the alternative — returning the
  // function + state alongside the PipelineState — bloats every
  // successful call site for two optional hooks).
  setGrowMeshSsboHook: (
    hook: (neededMeshSlots: number, neededMaterialSlots: number) => MeshSsboGrowResult,
    state: MeshSsboState,
  ) => void,
  // feat-20260609 R3-fixup: seed-shader-module hook the lazy
  // MaterialShader pipeline cache adapter exposes (see
  // makeShaderDeviceAdapter / ShaderDeviceAdapterInternal). Used to seed
  // the shadow_caster module under
  // `module-forgeax::default-shadow-caster` so the lazy PSO build hits
  // OK on frame 1 (no 1-frame warmup for the engine-shipped shadow
  // caster).
  seedShaderModule: SeedShaderModule,
  // M6 fix-up (feat-20260615-pipeline-spec-ssot): seed-pipeline hook the
  // outer `makeWebGPURenderer` exposes for `materialShaderPipelineCache`.
  // Invoked once per URP-variant SPEC_CONST entry after the boot-time
  // prewarm completes, so the URP record path's first-frame
  // `getMaterialShaderPipeline` lookup hits a live PSO instead of falling
  // into a 1-frame async-compile skip-draw window. Idempotent: caller
  // guards against re-seeding when a key already exists.
  seedMaterialShaderPipelineCache: (
    key: string,
    pso: RenderPipeline,
    group2Contract: PipelineGroup2Contract,
  ) => void,
  // V1 retains its published ABI. The initial output contract prepares its own module;
  // V2 uniform buffers belong to each view graph rather than the feature host.
  registerBuiltinOutputPrograms: (source: () => string, nativeSource?: () => string) => void,
  /** Register the special FXAA pass' final-output policy params UBO. */
  registerBuiltinFxaa: (source: string) => void,
  registerBuiltinAnalyticFog: (source: string | (() => string)) => void,
  registerBuiltinTemporalPostProcesses: (entries: {
    readonly motionBlur?: () => string;
    readonly taaResolve?: () => string;
  }) => void,
  registerBuiltinDepthOfField: Parameters<typeof prepareDepthOfFieldBuiltins>[2],
  /** Fallback backends prepare the canonical volume PSOs before publication. */
  setVolumetricFogShaderSources: (
    sources: VolumetricFogShaderSources,
    preparePipelines: boolean,
  ) => void | Promise<void>,
  /**
   * Install complete manifest-owned SSR and depth-pyramid declarations.
   * Backends without immediate creation compile before publication.
   */
  setSsrShaderSources: (
    sources: SsrShaderSources | undefined,
    pyramid: DepthPyramidShaderSources,
  ) => void,
  /** Install all required Atmosphere sources as one manifest bundle. */
  setAtmosphereShaderSources: (sources: AtmosphereShaderSources) => void,
  setStandardSceneShaderSources: (
    sources: import('../pipeline/standard-deferred-lighting').StandardSceneShaderSources,
  ) => void,
  /** Which material variant module labels this build compiles eagerly. */
  admitsVariant: VariantPrewarmAdmission,
  initialOutputContract:
    | import('../pipeline/standard-output/types').StandardOutputContract
    | undefined,
): Promise<PipelineState> {
  // These defaults belong to this renderer generation. They are not in the
  // mesh residency cache or frame graph, so its existing scope must retire them.
  const createPersistentBuffer: RhiDevice['createBuffer'] = (descriptor) => {
    const created = rhiDevice.createBuffer(descriptor);
    if (created.ok)
      rendererScope._adopt('buffer', created.value, (buffer) => {
        const result = rhiDevice.destroyBuffer(buffer);
        if (!result.ok) errorRegistry.fire(result.error);
      });
    return created;
  };
  const createPersistentTexture: RhiDevice['createTexture'] = (descriptor) => {
    const created = rhiDevice.createTexture(descriptor);
    if (created.ok)
      rendererScope._adopt('texture', created.value, (texture) => {
        const result = rhiDevice.destroyTexture(texture);
        if (!result.ok) errorRegistry.fire(result.error);
      });
    return created;
  };
  const caps = deriveReadyDeviceCapabilities(rhiDevice);
  const atmosphereFallbackView = caps.atmosphere
    ? createAtmosphereFallbackView(rhiDevice, createPersistentTexture)
    : undefined;
  // Swap-chain storage / view formats are chosen once per backend: native
  // WebGPU follows getPreferredCanvasFormat(); the GLES path (no storage
  // buffers) uses rgba8unorm. Every downstream target and configure() call
  // reads this single pair through PipelineState.format / colorAttachmentFormat.
  const surfaceViewFormats =
    (rhiDevice as unknown as { readonly surfaceViewFormats?: boolean }).surfaceViewFormats ??
    !caps.webgl2Downlevel;
  const swapChainFormats = selectSwapChainFormat(caps.storageBuffer, surfaceViewFormats);
  reportSwapChainFormatFallback(rhiDevice, swapChainFormats, errorRegistry);

  // The camera-only path ships an empty manifest: no engine module compiles,
  // every module stays null, and the dependent pipelines are published as null
  // so the record stage fails explicitly instead of mis-shading.
  const registry = getShader();
  const manifestEntries: ManifestEntry[] = [...registry.entries()];
  const standardClusterAbi = resolveStandardClusterAbi(rhiDevice, registry, manifestEntries);
  if (
    manifestEntries.length > 0 &&
    rhiDevice.caps.backendKind !== 'null' &&
    standardClusterAbi === undefined
  ) {
    throw new RhiError({
      code: 'shader-compile-failed',
      expected:
        'a storage-backed Standard PBR variant publishes source identity, compiler profile, DirectLightSlot, and ClusterUniform reflection',
      hint: 'rebuild the engine shader publication with per-variant Naga shader-reflection/3 metadata; runtime Cluster packing will not guess shader offsets',
    });
  }
  if (rhiDevice.caps.backendKind === 'null' && manifestEntries.length === 0) {
    // Decide after shader preparation: an unloaded registry is not an empty
    // manifest. Structural frames share the same single registration owner.
    registerBuiltinOutputPrograms(
      () => '',
      () => '',
    );
  }
  const compileModule: CompileShaderModule = (code, label, expected, hint) =>
    compileShaderModule(rhiDevice, asyncCreateShaderModule, code, label, expected, hint);
  const compileUtilityShader = (label: string, source: string | ShaderSource, context: string) =>
    compileModule(
      source,
      label,
      `${context} shader module '${label}' compiled`,
      `inspect manifest WGSL for '${label}' and check device.features`,
    );
  const canCreateSceneModulesOnDemand =
    rhiDevice.caps.backendKind === 'webgpu' && immediateCreateShaderModule !== undefined;

  /** Publish complete utility bundles; native passes prepare their own programs. */
  const prewarmUtilityPrograms = async (): Promise<void> => {
    const computeStorageTexture = rhiDevice.caps.compute && rhiDevice.caps.storageTexture;
    if (computeStorageTexture) {
      const sources = await prepareUtilityShaders(
        'volumetric fog',
        VOLUMETRIC_FOG_SHADER_STAGES,
        manifestEntries,
        canCreateSceneModulesOnDemand
          ? undefined
          : (label, source) => compileUtilityShader(label, source, 'volumetric fog'),
        seedShaderModule,
      );
      if (sources !== undefined)
        await setVolumetricFogShaderSources(sources, !canCreateSceneModulesOnDemand);
    }
    if (rhiDevice.caps.rgba16floatRenderable) {
      const sources = await prepareSsrWithDepthPyramid(
        manifestEntries,
        canCreateSceneModulesOnDemand ? undefined : compileUtilityShader,
        seedShaderModule,
        computeStorageTexture ? 'compute' : 'fragment',
      );
      if (sources !== undefined) setSsrShaderSources(sources.ssr, sources.pyramid);
      if (!canCreateSceneModulesOnDemand) {
        const merge = await compileUtilityShader(
          TRANSMISSION_MERGE_LABEL,
          TRANSMISSION_MERGE_WGSL,
          'stock transmission',
        );
        seedShaderModule(TRANSMISSION_MERGE_LABEL, merge, TRANSMISSION_MERGE_WGSL);
      }
    }
    const scenePrograms = await prepareStandardSceneSources(
      registry,
      canCreateSceneModulesOnDemand ? undefined : compileUtilityShader,
      seedShaderModule,
      caps,
    );
    if (scenePrograms !== undefined) setStandardSceneShaderSources(scenePrograms);
    const atmosphere = await prepareAtmospherePrograms(
      manifestEntries,
      canCreateSceneModulesOnDemand ? undefined : compileUtilityShader,
      seedShaderModule,
    );
    if (atmosphere !== undefined) setAtmosphereShaderSources(atmosphere);
  };

  /**
   * HDRP and transmission variants use their own module labels; compile every
   * device-capability-matched source (coloured and no-colour) and seed its
   * exact label when the backend lacks immediate shader creation.
   */
  const prewarmStandardPbrVariants = async (
    pbrManifestEntry: MaterialShaderManifestEntry | undefined,
    pbrEntry: ManifestEntry,
    pbrModule: ShaderModule,
  ): Promise<void> => {
    await prewarmMaterialShaderVariants(
      'forgeax::default-standard-pbr',
      [
        ...selectStandardPbrTransmissionPrewarmVariants(
          pbrManifestEntry,
          caps.storageBuffer,
          caps.directionalPcss,
          caps.projector,
          caps.extendedLighting,
          caps.atmosphere,
        ),
        ...selectHdrpPbrPrewarmVariants(
          pbrManifestEntry,
          caps.storageBuffer,
          caps.extendedLighting,
          true,
          caps.directionalPcss,
          caps.projector,
          caps.atmosphere,
        ),
        ...selectProbePrewarmVariants(
          pbrManifestEntry,
          caps.storageBuffer,
          caps.extendedLighting,
          true,
          caps.directionalPcss,
          caps.projector,
          caps.webgl2Downlevel,
          caps.atmosphere,
        ),
      ],
      new Map<string, ShaderModule>([[pbrEntry.wgsl, pbrModule]]),
      (variant, label) =>
        createShaderModuleResult(
          rhiDevice,
          asyncCreateShaderModule,
          variant.composedWgsl,
          label,
          `Standard PBR variant ${variant.definesKey || '<default>'} compiled`,
          'inspect the selected Standard PBR variant WGSL and device.features',
        ),
      seedShaderModule,
      admitsVariant,
    );
  };

  const hasNativeMaterialTemplate = (identifier: string): boolean => {
    if (!canCreateSceneModulesOnDemand) return false;
    const entry = registry.materialShaderManifestEntry(identifier);
    return entry !== undefined && isShaderTemplateManifestRow(entry);
  };

  /** Native material draws own raster selection. Compatibility backends keep the eager module. */
  const compileStandardPbr = async (
    entries: ResolvedEngineManifestEntries,
  ): Promise<{
    pbr: ShaderModule | null;
    gpuDrivenPbrPrograms: EngineShaderModules['gpuDrivenPbrPrograms'];
  }> => {
    const source = hasNativeMaterialTemplate('forgeax::default-standard-pbr')
      ? undefined
      : manifestShaderSource(entries.pbr);
    const pbrModule =
      source === undefined
        ? null
        : await compileModule(
            source,
            'pbr',
            'PBR shader module compiled',
            'inspect manifest pbr entry composed wgsl; check device.features',
          );
    if (source !== undefined && pbrModule !== null)
      seedShaderModule('module-forgeax::default-standard-pbr', pbrModule, source);
    const pbrManifestEntry = findMaterialShaderEntry(registry, 'forgeax::default-standard-pbr');
    const gpuDrivenModules = await buildGpuDrivenPbrReadyModules({
      registry,
      device: rhiDevice,
      storageBufferCapable: caps.storageBuffer,
      asyncCreateShaderModule,
      pbrSkinEntry: entries.pbrSkin,
      immediateCreateShaderModule,
      pbrManifestEntry,
      pbrSkinManifestEntry:
        findMaterialShaderEntry(registry, SKIN_MATERIAL_SHADER_ID) ??
        findMaterialShaderEntry(registry, 'forgeax::default-standard-pbr-skin'),
      extendedLightingShaderAvailable: caps.extendedLighting,
      directionalPcssAvailable: caps.directionalPcss,
      projectorAvailable: caps.projector,
      seedShaderModule,
      admitsVariant,
    });
    if (source === undefined || pbrModule === null)
      return { pbr: null, gpuDrivenPbrPrograms: gpuDrivenModules.gpuDrivenPbrPrograms };

    const pbrVariant =
      pbrManifestEntry === undefined
        ? undefined
        : materialShaderPreparedSourceRows(pbrManifestEntry).find(
            (variant): variant is MaterialShaderManifestVariant =>
              'definesKey' in variant && materialShaderSource(variant).sameText(source),
          );
    if (pbrVariant !== undefined)
      seedShaderModule(
        `module-forgeax::default-standard-pbr#${pbrVariant.definesKey}`,
        pbrModule,
        source,
      );
    if (
      immediateCreateShaderModule === undefined &&
      pbrManifestEntry !== undefined &&
      !isShaderTemplateManifestRow(pbrManifestEntry)
    )
      await prewarmStandardPbrVariants(pbrManifestEntry, entries.pbr, pbrModule);
    return { pbr: pbrModule, gpuDrivenPbrPrograms: gpuDrivenModules.gpuDrivenPbrPrograms };
  };

  /** Seed legacy backends. Native effects acquire their modules when their passes enter. */
  const prewarmTemporalPrograms = async (entries: ResolvedEngineManifestEntries) => {
    const prewarmTemporal = createTemporalShaderPrewarmer({
      device: rhiDevice,
      asyncCreateShaderModule,
      seedShaderModule,
    });
    if (entries.motionBlur !== undefined) {
      await prewarmTemporal(entries.motionBlur, 'forgeax.motion-blur');
      if (rhiDevice.caps.compute && rhiDevice.caps.storageBuffer && rhiDevice.caps.storageTexture) {
        const motionBlurVelocitySource = sceneVelocityComputeSource();
        const label = 'motion-blur-tile-summary';
        const module = await compileModule(
          motionBlurVelocitySource,
          label,
          'scene-velocity Motion Blur compute shader module compiles before the first temporal frame',
          'inspect the Motion Blur depth, velocity and scene-view bindings',
        );
        seedShaderModule(label, module, motionBlurVelocitySource);
        seedShaderModule('motion-blur', module, motionBlurVelocitySource);
      }
    }
    if (entries.taaResolve !== undefined) {
      await prewarmTemporal(entries.taaResolve, 'forgeax.taa-resolve');
      const taaVelocitySource = TAA_SCENE_VELOCITY_WGSL;
      const taaVelocityLabel = postProcessShaderModuleLabel(taaVelocitySource);
      const taaVelocityModule = await compileModule(
        taaVelocitySource,
        taaVelocityLabel,
        'scene-velocity TAA resolve shader module compiled before the first temporal frame',
        'inspect the TAA scene-velocity bindings and device.features',
      );
      seedShaderModule(taaVelocityLabel, taaVelocityModule, taaVelocitySource);
      const label = SCENE_VELOCITY_TEMPORAL_LABEL;
      const source = SCENE_VELOCITY_TEMPORAL_WGSL;
      const module = await compileModule(
        source,
        label,
        'scene velocity reconstruction compiles before the first temporal frame',
        'inspect the Standard depth and packed velocity bindings',
      );
      seedShaderModule(label, module, source);
    }
    return prewarmTemporal;
  };

  /**
   * Register the output and temporal declarations for the selected passes.
   * Backends without native creation before encoding seed their exact labels.
   */
  const prewarmPostProcessPrograms = async (
    entries: ResolvedEngineManifestEntries,
  ): Promise<void> => {
    if (!canCreateSceneModulesOnDemand) {
      const source = entries.tonemap.wgsl;
      const label = postProcessShaderModuleLabel(source);
      const module = await compileModule(
        source,
        label,
        'tonemap shader module compiled (unified post-process prewarm)',
        'inspect manifest tonemap entry composed wgsl; check device.features',
      );
      seedShaderModule(label, module, source);
    }
    const nativeOutput = findEngineManifestEntry(
      registry,
      manifestEntries,
      'forgeax::standard-output-v2',
    );
    registerBuiltinOutputPrograms(
      () => entries.tonemap.wgsl,
      nativeOutput === undefined ? undefined : () => nativeOutput.wgsl,
    );
    if (
      !canCreateSceneModulesOnDemand &&
      nativeOutput !== undefined &&
      initialOutputContract === 'standard-output-v2'
    ) {
      const source = nativeOutput.wgsl;
      const label = postProcessShaderModuleLabel(source);
      const module = await compileModule(
        source,
        label,
        'selected native output shader module compiled',
        'inspect the selected Standard output source and device capabilities',
      );
      seedShaderModule(label, module, source);
    }
    const analyticFog = findEngineManifestEntry(registry, manifestEntries, 'forgeax::analytic-fog');
    if (analyticFog !== undefined) registerBuiltinAnalyticFog(() => analyticFog.wgsl);
    const prewarmTemporal = canCreateSceneModulesOnDemand
      ? undefined
      : await prewarmTemporalPrograms(entries);
    await prepareDepthOfFieldBuiltins(
      manifestEntries,
      prewarmTemporal,
      registerBuiltinDepthOfField,
    );
    const { motionBlur, taaResolve } = entries;
    registerBuiltinTemporalPostProcesses({
      ...(motionBlur === undefined ? {} : { motionBlur: () => motionBlur.wgsl }),
      ...(taaResolve === undefined ? {} : { taaResolve: () => taaResolve.wgsl }),
    });
  };

  /**
   * FXAA registers its final-output policy params and seeds the shared
   * post-process adapter, so a graph-owned linear-LDR FXAA target is available
   * on the first frame without an async recompile.
   */
  const compileFxaa = async (
    fxaaEntry: ManifestEntry | undefined,
  ): Promise<ShaderModule | null> => {
    if (fxaaEntry === undefined) return null;
    const source = fxaaEntry.wgsl;
    if (canCreateSceneModulesOnDemand) {
      registerBuiltinFxaa(source);
      return null;
    }
    const module = await compileModule(
      source,
      'fxaa',
      'fxaa shader module compiled',
      'inspect manifest fxaa entry composed wgsl; check device.features',
    );
    registerBuiltinFxaa(source);
    seedShaderModule(postProcessShaderModuleLabel(source), module, source);
    return module;
  };

  const prewarmStaticShadowClear = async (): Promise<void> => {
    const staticClear = await compileModule(
      STATIC_SHADOW_DEPTH_CLEAR_SHADER.code,
      STATIC_SHADOW_DEPTH_CLEAR_SHADER.label,
      'static shadow depth-clear shader compiles before the first shadow frame',
      'inspect the static shadow clear program and backend compiler',
    );
    seedShaderModule(
      STATIC_SHADOW_DEPTH_CLEAR_SHADER.label,
      staticClear,
      STATIC_SHADOW_DEPTH_CLEAR_SHADER.code,
    );
  };

  /**
   * Compile every engine module the first synchronous frame can reach. Optional
   * entries absent from older manifests leave their module null. The GLES
   * translator cannot read raw depth through the SSAO program, so optional AO
   * stays out of fallback startup and its request is refused by the record owner.
   */
  const compileEngineModules = async (): Promise<EngineShaderModules> => {
    const entries = resolveEngineManifestEntries(
      registry,
      manifestEntries,
      rhiDevice.caps.backendKind,
      caps,
      canCreateSceneModulesOnDemand,
    );
    publishIblPrograms(entries, rendererScope);
    if (!hasNativeMaterialTemplate(POINTS_LINES_MATERIAL_SHADER_ID))
      await prewarmPointsLinesProgram(registry, compileModule, seedShaderModule);
    await prewarmRequiredMaterialShaders({
      rhiDevice,
      registry,
      asyncCreateShaderModule,
      requiredMaterialShaders,
      seedShaderModule,
    });
    await prewarmFullscreenPostProcesses(
      requiredFullscreenPostProcesses,
      compileModule,
      seedShaderModule,
      canCreateSceneModulesOnDemand,
    );
    await prewarmUtilityPrograms();
    const standard = await compileStandardPbr(entries);
    if (standard.pbr !== null)
      seedPbrSourceAliases(registry, entries.pbr.wgsl, standard.pbr, seedShaderModule);
    const unlit = hasNativeMaterialTemplate('forgeax::default-unlit')
      ? null
      : await compileUnlitModules(registry, compileModule, seedShaderModule, caps, entries.unlit);
    if (!canCreateSceneModulesOnDemand) await prewarmStaticShadowClear();
    if (!hasNativeMaterialTemplate('forgeax::default-shadow-caster'))
      await prewarmShadowCasterModules(
        registry,
        compileModule,
        seedShaderModule,
        caps,
        entries.shadowCaster,
      );
    await prewarmPostProcessPrograms(entries);
    const sprite = hasNativeMaterialTemplate('forgeax::sprite')
      ? null
      : await compileSpriteModules(registry, compileModule, seedShaderModule, caps, entries.sprite);
    const spriteLit = hasNativeMaterialTemplate('forgeax::sprite-lit')
      ? null
      : await compileSpriteLitModules(
          rhiDevice,
          registry,
          compileModule,
          seedShaderModule,
          caps,
          entries.spriteLit,
        );
    const fxaa = await compileFxaa(entries.fxaa);
    const compileFullscreen = (entry: ManifestEntry | undefined, label: string) =>
      canCreateSceneModulesOnDemand ? null : compileManifestModule(compileModule, entry, label);
    const skybox = await compileFullscreen(entries.skybox, 'skybox');
    const bloomHorizontal = await compileFullscreen(entries.bloomHorizontal, 'bloom-horizontal');
    const bloomVertical = await compileFullscreen(entries.bloomVertical, 'bloom-vertical');
    const bloomComposite = await compileFullscreen(entries.bloomComposite, 'bloom-composite');
    const ssao = await compileFullscreen(entries.ssao, 'hdrp-ssao');
    const gtaoCompute = rhiDevice.caps.compute
      ? await compileFullscreen(entries.gtaoCompute, 'hdrp-gtao-compute')
      : null;
    return {
      pbr: standard.pbr,
      unlit,
      sprite,
      spriteLit,
      fxaa,
      skybox,
      bloomHorizontal,
      bloomVertical,
      bloomComposite,
      ssao,
      ssaoGBufferV2: entries.ssao?.programContract?.gbuffer === 'standard-gbuffer/2',
      ssaoCompactGBuffer: entries.ssao?.programContract?.compactGbuffer === 'standard-gbuffer/4',
      gtaoGBufferV2: entries.gtaoCompute?.programContract?.gbuffer === 'standard-gbuffer/2',
      gtaoCompute,
      gpuDrivenPbrPrograms: standard.gpuDrivenPbrPrograms,
      ...(canCreateSceneModulesOnDemand
        ? {
            fullscreenOnDemand: {
              fxaa: entries.fxaa,
              skybox: entries.skybox,
              bloomHorizontal: entries.bloomHorizontal,
              bloomVertical: entries.bloomVertical,
              bloomComposite: entries.bloomComposite,
              ssao: entries.ssao,
              gtaoCompute: rhiDevice.caps.compute ? entries.gtaoCompute : undefined,
            },
          }
        : {}),
    };
  };

  const hasEnginePublication = manifestEntries.length > 0;
  const modules = hasEnginePublication ? await compileEngineModules() : emptyEngineShaderModules();

  // Standard layouts: view + material + mesh-array + instances (no group(4)).
  // Clustered and baseline GPU-driven passes share their Primitive and Scene layouts.
  const pbrLayouts = buildReadyPbrLayouts(rhiDevice, caps);
  const unlitPipelineLayout =
    modules.unlit === null
      ? null
      : buildUnlitPipelineLayout(rhiDevice, registry, caps.storageBuffer, pbrLayouts);
  const hdrp = buildHdrpPipelineLayouts(rhiDevice, caps.storageBuffer, pbrLayouts);
  const { hdrpClusterMembershipPipeline, hdrpClusterMembershipBindGroupLayout } =
    await buildClusterMembershipProducer(
      rhiDevice,
      caps.storageBuffer && hasEnginePublication,
      asyncCreateShaderModule,
    );
  const gpuDriven = buildGpuDrivenPbrReadyLayouts(rhiDevice, caps.storageBuffer, pbrLayouts);
  const sceneDirectClusterPipelineLayout = caps.storageBuffer
    ? null
    : createGpuDrivenClusterPipelineLayout(
        rhiDevice,
        'pbr-scene-direct-cluster-pl',
        pbrLayouts,
        hdrp.unifiedBgl,
        gpuDriven.sceneDirectInstancesBindGroupLayout,
      );

  // Pipeline-scoped shared buffers; per-frame bind groups reference them and
  // queue.writeBuffer updates their contents.
  const queue = rhiDevice.queue;
  const viewUniformBuffer = createViewUniformBuffer(createPersistentBuffer);
  const pointsLinesView = createPointsLinesViewBuffer(rhiDevice, rendererScope);
  const shadowCasterCascadeBuffer = createShadowCasterCascadeBuffer(createPersistentBuffer, queue);
  const meshSsboController = createReadyMeshSsboController(
    rhiDevice,
    rendererScope,
    errorRegistry,
    caps.storageBuffer,
  );
  const meshSsboState = meshSsboController.state;
  requireMeshSsboBuffer(meshSsboState.mesh);
  requireMeshSsboBuffer(meshSsboState.material);
  // The record stage's `ensureMeshSsboCapacity` reaches the grow hook through internals.
  setGrowMeshSsboHook(meshSsboController.growMeshSsbo, meshSsboController.state);
  const identityInstanceBuffer = createIdentityInstanceBuffer(
    createPersistentBuffer,
    queue,
    caps.storageBuffer,
  );
  const samplers = createReadySamplers(rhiDevice);
  const fallbackTextureView = createTexelFallbackView(
    rhiDevice,
    createPersistentTexture,
    'white',
    'rgba8unorm',
    new Uint8Array([255, 255, 255, 255]),
  );
  const extendedLightingFallback = createExtendedLightingFallbackResources(
    {
      createBuffer: createPersistentBuffer,
      createTexture: createPersistentTexture,
      createTextureView: rhiDevice.createTextureView.bind(rhiDevice),
      queue: rhiDevice.queue,
    },
    caps.extendedLighting,
  );
  // Half float stores the tangent-space normal (0.5, 0.5, 1, 1) exactly.
  const fallbackNormalTexel = new Uint16Array([0x3800, 0x3800, 0x3c00, 0x3c00]);
  const fallbackNormalTextureView = createTexelFallbackView(
    rhiDevice,
    createPersistentTexture,
    'normal',
    'rgba16float',
    fallbackNormalTexel,
  );
  const shadowFallbackTextureView = createShadowFallbackDepthView(
    rhiDevice,
    createPersistentTexture,
  );
  const shadowArrayFallbackTextureView = createShadowArrayFallbackView(
    rhiDevice,
    createPersistentTexture,
  );
  const layeredTextureFallback = createLayeredTextureFallbackViews(
    rhiDevice,
    createPersistentTexture,
  );
  const shadowAtlasFallbackTextureView = createShadowAtlasFallbackView(
    rhiDevice,
    createPersistentTexture,
  );
  // Spot light view-projections fold into the View UBO tail; no separate buffer.
  const shadowParamsBuffer = createShadowParamsBuffer(createPersistentBuffer, queue);
  const skylightFallback = createReadySkylightFallback(
    rhiDevice,
    createPersistentBuffer,
    createPersistentTexture,
  );

  // One PipelineCache is the single PSO container. SPEC_CONST tables resolve
  // against the runtime swap-chain view format so prewarmed keys match the
  // runtime lookups instead of double-building.
  const pipelineCache: PipelineCache = new Map();
  const shaderModuleMap = materialModulesById(modules);
  const pipelineDeviceProvider = createReadyPipelineDeviceProvider(
    rhiDevice,
    modules,
    unlitPipelineLayout,
    pbrLayouts.pipelineLayout,
  );
  const prepareBootSpecs = (specs: readonly PipelineSpec[]) =>
    specs
      .filter((spec) => shaderModuleMap.has(spec.shader.id))
      .map((spec) => withMaterialVertexInputs(registry, spec));
  const runtimeSpecConstTable = prepareBootSpecs(buildSpecConstTable(swapChainFormats.view));
  const runtimeLinearLdrMaterialSpecTable = prepareBootSpecs(
    buildLinearLdrMaterialSpecTable(swapChainFormats.view),
  );
  await prewarmMaterialSpecPipelines(
    [...runtimeSpecConstTable, ...runtimeLinearLdrMaterialSpecTable],
    shaderModuleMap,
    pipelineDeviceProvider,
    pipelineCache,
  );
  seedLinearLdrMaterialPipelines(
    runtimeLinearLdrMaterialSpecTable,
    shaderModuleMap,
    pipelineCache,
    registry,
    seedMaterialShaderPipelineCache,
  );
  // FXAA writes the non-sRGB storage view when storage textures exist.
  const fxaaFormat = caps.storageBuffer ? swapChainFormats.storage : swapChainFormats.view;
  const { prepareBloomModules, ...nativeFullscreen } = createNativeFullscreenDemand(
    rhiDevice,
    pipelineDeviceProvider,
    pipelineCache,
    modules,
    hasEnginePublication ? immediateCreateShaderModule : undefined,
    fxaaFormat,
    createPersistentBuffer,
    seedShaderModule,
  );
  const fullscreenPasses = hasEnginePublication
    ? createFullscreenPassResources(
        rhiDevice,
        pipelineDeviceProvider,
        pipelineCache,
        modules,
        fxaaFormat,
        createPersistentBuffer,
      )
    : emptyFullscreenPassResources();
  const bloom = createBloomResourceOwner(
    rhiDevice,
    rendererScope,
    errorRegistry,
    pipelineDeviceProvider,
    pipelineCache,
    modules,
    hasEnginePublication,
    prepareBloomModules,
  );

  await prepareRendererMipmaps(
    rhiDevice,
    gpuStore,
    manifestEntries.length > 0,
    immediateCreateShaderModule,
  );

  const cachedUnlitPipeline = (isHdr: boolean, sampleCount: 1 | 4): RenderPipeline | null =>
    cachedSpecPipeline(
      runtimeSpecConstTable,
      pipelineCache,
      'forgeax::default-unlit',
      isHdr,
      sampleCount,
    );
  const pipelineState: PipelineState = {
    device: rhiDevice,
    ...(standardClusterAbi === undefined ? {} : { standardClusterAbi }),
    // Only legacy Unlit draws have separate SPEC_CONST fallback pipelines.
    unlitPipeline: cachedUnlitPipeline(false, 1),
    standardPbrShaderUvSetCount,
    unlitPipelineMsaa: cachedUnlitPipeline(false, 4),
    unlitPipelineHdrMsaa: cachedUnlitPipeline(true, 4),
    ...selectBootModuleLayouts(
      hasEnginePublication,
      pbrLayouts,
      hdrp,
      gpuDriven,
      sceneDirectClusterPipelineLayout,
    ),
    gpuDrivenPbrPrograms: modules.gpuDrivenPbrPrograms,
    hdrpMeshBindGroupLayout: hdrp.unifiedBgl,
    hdrpClusterMembershipPipeline,
    hdrpClusterMembershipBindGroupLayout,
    hdrpSkinProbePipelineLayout: gpuDriven.hdrpSkinProbePipelineLayout,
    format: swapChainFormats.storage,
    colorAttachmentFormat: swapChainFormats.view,
    surfaceProfile: surfaceViewFormats ? 'dual-view' : 'raw-only',
    viewBindGroupLayout: pbrLayouts.viewBgl,
    extendedLightingAvailable: caps.extendedLighting,
    atmosphereAvailable: caps.atmosphere,
    viewLinearSampler: rhiDevice
      .createSampler({
        label: 'view-linear-clamp',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      })
      .unwrap(),
    atmosphereFallbackView,
    atmosphereDistantSkyFallback: caps.atmosphere
      ? createPersistentBuffer({
          label: 'atmosphere-neutral-distant-sky',
          size: 16,
          usage: 0x80,
        }).unwrap()
      : undefined,
    projectorAvailable: caps.projector,
    materialBindGroupLayout: pbrLayouts.materialBgl,
    meshBindGroupLayout: pbrLayouts.meshArrayBgl,
    viewUniformBuffer,
    get pointsLinesViewBuffer() {
      return pointsLinesView.buffer;
    },
    ensurePointsLinesViewCapacity: pointsLinesView.ensureCapacity,
    shadowCasterCascadeBuffer,
    materialUniformBuffer: meshSsboState.material,
    meshStorageBuffer: meshSsboState.mesh,
    instancesBindGroupLayout: pbrLayouts.instancesBgl,
    probeInstancesBindGroupLayout: pbrLayouts.probeInstancesBgl,
    identityInstanceBuffer,
    defaultSampler: samplers.defaultSampler,
    surfaceMediumDepthSampler: samplers.surfaceMediumDepthSampler,
    fallbackTextureView,
    defaultWhiteTextureView: fallbackTextureView,
    // Exactly neutral half-float RG=(0.5,0.5) decodes to tangent (0,0,1).
    defaultNormalTextureView: fallbackNormalTextureView,
    unlitPipelineHdr: cachedUnlitPipeline(true, 1),
    shadowFallbackTextureView,
    shadowArrayFallbackTextureView,
    ...layeredTextureFallback,
    ...extendedLightingFallback,
    // Point-shadow cube-array fallback; ShadowAtlas takes over for real snapshots.
    shadowAtlasFallbackTextureView,
    shadowParamsBuffer,
    skylightFallback,
    perPassResources: createReadyPerPassResources({
      ...fullscreenPasses,
      ...nativeFullscreen,
      shadowSampler: samplers.shadowSampler,
      // Bloom pipeline handles are generation-owned by the Bloom owner;
      // graph targets are frame-owned and are not stored here.
      bloomHorizontalPipeline: null,
      bloomVerticalPipeline: null,
      bloomCompositePipeline: null,
      bloomHorizontalBindGroupLayout: null,
      bloomVerticalBindGroupLayout: null,
      bloomCompositeBindGroupLayout: null,
      bloomSampler: null,
      bloomHorizontalParamsBuffer: null,
      bloomVerticalParamsBuffer: null,
      bloomCompositeParamsBuffer: null,
      ...bloom,
    }),
  };
  Object.assign(pipelineState, { shadowViewResources: new ShadowViewResources(pipelineState) });
  // Boot-time fallback resources submit real GPU work before the renderer is
  // published. Keep initialization as the readiness barrier for the first
  // frame: a Worker can otherwise receive `ready`, start its frame deadline,
  // and report `frame-submitted` while that earlier queue work still holds the
  // receipt's completion fence.
  await queue.onSubmittedWorkDone();
  return pipelineState;
}
