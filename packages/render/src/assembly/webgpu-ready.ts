// WebGPU generation-scoped ready-state builder.
// This owner performs one complete device-generation promotion; it receives
// policy/adapters and returns a fully prepared PipelineState.

import type {
  BindGroupLayout,
  PipelineLayout,
  PipelineLibraryManifest,
  RenderPipeline,
  Result,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import {
  type MaterialShaderManifestEntry,
  materialShaderSourceEquals,
  type PipelineGroup2Contract,
  type ShaderCatalog,
} from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';
import { prewarmDepthOfField } from '../features/depth-of-field/depth-of-field-assembly';
import type { RhiBackendPack } from './backend-contract';
import {
  prewarmSsrWithDepthPyramid,
  prewarmUtilityShaders,
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
} from '../pipeline-spec';
import { createPointsLinesViewBuffer } from '../record/points-lines-view-buffer';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import { type PipelineState, selectSwapChainFormat } from '../render-system';
import { createExtendedLightingFallbackResources } from './extended-lighting-fallback';
import { createLayeredTextureFallbackViews } from './layered-texture-fallback';
import { prewarmRequiredMaterialShaders } from './material-shader-prewarm';
import {
  type MeshSsboGrowResult,
  type MeshSsboState,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
import {
  prewarmMaterialShaderVariants,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
  type VariantPrewarmAdmission,
} from './shader-prewarm-policy';
import { createShadowArrayFallbackView } from './shadow-array-fallback';
import { createTemporalShaderPrewarmer } from './temporal-post-process-prewarm';
import { buildClusterMembershipProducer } from './webgpu-cluster-ready';
import { buildGpuDrivenPbrReadyLayouts, buildGpuDrivenPbrReadyModules } from './webgpu-pbr-ready';
import { createBloomResourceOwner } from './webgpu-ready-bloom';
import { prewarmMipmapPipeline } from './webgpu-ready-mipmap';
import {
  cachedSpecPipeline,
  createFullscreenPassResources,
  createReadyPipelineDeviceProvider,
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
  prewarmAtmospherePrograms,
  prewarmFullscreenPostProcesses,
  prewarmPointsLinesProgram,
  prewarmShadowCasterModules,
  prewarmStandardDeferredPrograms,
  publishIblPrograms,
  type ResolvedEngineManifestEntries,
  resolveEngineManifestEntries,
  seedPbrSourceAliases,
} from './webgpu-ready-shaders';

export async function prepareDevicePipelineLibrary(
  device: RhiDevice,
  manifest: PipelineLibraryManifest,
  shader: Pick<ShaderCatalog, 'materialProgram'>,
): Promise<void> {
  if (device.pipelineLibrary === undefined) return;
  const prepared = await device.pipelineLibrary.prepare(manifest);
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
    shader.materialProgram((manifest.shaders[module] as GPUShaderModuleDescriptor).code);
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
    let slice = performance.now();
    for (const module of modules) {
      if (performance.now() - slice >= BACKGROUND_ANALYSIS_SLICE_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        slice = performance.now();
      }
      if (!active()) return;
      const code = manifest.shaders[module]?.code;
      if (typeof code === 'string') shader().materialProgram(code);
    }
  };
  await Promise.all([
    library.prepare(manifest, { background: true }).then((prepared) => {
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
  | 'gpuDrivenPbrPipelineLayout'
  | 'gpuDrivenPbrSkinPipelineLayout'
  | 'surfaceDirectInstancesBindGroupLayout'
  | 'gpuDrivenClusterPbrPipelineLayout'
  | 'gpuDrivenClusterPbrSkinPipelineLayout'
  | 'gpuDrivenClusterMeshBindGroupLayout'
  | 'hdrpPbrPipelineLayout'
  | 'hdrpProbePbrPipelineLayout'
  | 'pbrSkinPipelineLayout'
  | 'pbrSkinProbePipelineLayout'
  | 'pbrSkinMeshBindGroupLayout'
  | 'hdrpSkinPipelineLayout'
  | 'hdrpSkinMeshBindGroupLayout'
>;

/**
 * Material pipeline layouts are published only when the boot unlit + PBR
 * modules compiled; the camera-only empty manifest publishes null so record
 * paths fail explicitly instead of drawing with an unbacked layout.
 */
function selectBootModuleLayouts(
  bootModulesReady: boolean,
  pbrLayouts: PbrPipelineLayoutBundle,
  hdrp: HdrpPipelineLayouts,
  gpuDriven: GpuDrivenReadyLayouts,
  gpuDrivenCluster: {
    readonly rigid: PipelineLayout | null;
    readonly skin: PipelineLayout | null;
  },
): BootModuleLayouts {
  if (!bootModulesReady) {
    return {
      pbrPipelineLayout: null,
      gpuDrivenInstancesBindGroupLayout: null,
      gpuDrivenPbrPipelineLayout: null,
      gpuDrivenPbrSkinPipelineLayout: null,
      surfaceDirectInstancesBindGroupLayout: null,
      gpuDrivenClusterPbrPipelineLayout: null,
      gpuDrivenClusterPbrSkinPipelineLayout: null,
      gpuDrivenClusterMeshBindGroupLayout: null,
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
    gpuDrivenPbrPipelineLayout: gpuDriven.gpuDrivenPbrPipelineLayout,
    gpuDrivenPbrSkinPipelineLayout: gpuDriven.gpuDrivenPbrSkinPipelineLayout,
    surfaceDirectInstancesBindGroupLayout: gpuDriven.surfaceDirectInstancesBindGroupLayout,
    gpuDrivenClusterPbrPipelineLayout: gpuDrivenCluster.rigid,
    gpuDrivenClusterPbrSkinPipelineLayout: gpuDrivenCluster.skin,
    gpuDrivenClusterMeshBindGroupLayout: hdrp.unifiedBgl,
    hdrpPbrPipelineLayout: hdrp.pbrPipelineLayout,
    hdrpProbePbrPipelineLayout: hdrp.probePbrPipelineLayout,
    pbrSkinPipelineLayout: gpuDriven.pbrSkinPipelineLayout,
    pbrSkinProbePipelineLayout: gpuDriven.pbrSkinProbePipelineLayout,
    pbrSkinMeshBindGroupLayout: gpuDriven.pbrSkinMeshBindGroupLayout,
    hdrpSkinPipelineLayout: gpuDriven.hdrpSkinPipelineLayout,
    hdrpSkinMeshBindGroupLayout: gpuDriven.hdrpSkinMeshBindGroupLayout,
  };
}

/** GPU-driven cluster layouts exist only on storage-capable devices. */
function buildGpuDrivenClusterLayouts(
  device: RhiDevice,
  storageBuffer: boolean,
  pbrLayouts: PbrPipelineLayoutBundle,
  hdrpUnifiedBgl: BindGroupLayout | null,
  gpuDriven: GpuDrivenReadyLayouts,
): { readonly rigid: PipelineLayout | null; readonly skin: PipelineLayout | null } {
  if (!storageBuffer) return { rigid: null, skin: null };
  return {
    rigid: createGpuDrivenClusterPipelineLayout(
      device,
      'pbr-gpu-driven-cluster-pl',
      pbrLayouts,
      hdrpUnifiedBgl,
      gpuDriven.gpuDrivenInstancesBindGroupLayout,
    ),
    skin: createGpuDrivenClusterPipelineLayout(
      device,
      'pbr-skin-gpu-driven-cluster-pl',
      pbrLayouts,
      gpuDriven.hdrpSkinMeshBindGroupLayout,
      gpuDriven.gpuDrivenInstancesBindGroupLayout,
    ),
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
  requiredFullscreenPostProcesses: readonly {
    readonly identity: string;
    readonly source: string;
  }[],
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
  seedShaderModule: (label: string, module: ShaderModule) => void,
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
  // feat-20260621 M-A3 (D-5): register the engine built-in tonemap onto the
  // unified post-process channel once the tonemap manifest entry's composed
  // WGSL is resolved. Invoked with the tonemap WGSL source string; the outer
  // `makeWebGPURenderer` closure forwards it to
  // the fullscreen feature host with `{ source, params }`.
  // Scope bridge mirrors `setGrowMeshSsboHook` / `seedShaderModule`: the
  // tonemap source resolves inside this async function (after the manifest-load
  // await), by which point the synchronous `renderSystem` const is defined.
  registerBuiltinTonemap: (source: string) => void,
  /** Register the special FXAA pass' final-output policy params UBO. */
  registerBuiltinFxaa: (source: string) => void,
  registerBuiltinAnalyticFog: (source: string) => void,
  registerBuiltinTemporalPostProcesses: (entries: {
    readonly motionBlur?: string;
    readonly taaResolve?: string;
  }) => void,
  registerBuiltinDepthOfField: Parameters<typeof prewarmDepthOfField>[2],
  /** Await canonical volume PSOs before promoting the manifest-owned utility sources. */
  setVolumetricFogShaderSources: (sources: VolumetricFogShaderSources) => void | Promise<void>,
  /**
   * Install manifest-owned SSR and depth-pyramid utility sources only after
   * both bundles compile; SSR trace currently reads the pyramid.
   */
  setSsrShaderSources: (sources: SsrShaderSources, pyramid: DepthPyramidShaderSources) => void,
  /** Install manifest-owned atmosphere utility sources only after all modules compile. */
  setAtmosphereShaderSources: (sources: AtmosphereShaderSources) => void,
  setStandardDeferredShaderSources: (
    sources: import('../pipeline/standard-deferred-lighting').StandardDeferredShaderSources,
  ) => void,
  /** Which material variant module labels this build compiles eagerly. */
  admitsVariant: VariantPrewarmAdmission,
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
  if (rhiDevice.caps.backendKind === 'null' && manifestEntries.length === 0) {
    // Decide after shader preparation: an unloaded registry is not an empty
    // manifest. Structural frames share the same single registration owner.
    registerBuiltinTonemap('');
  }
  const compileModule: CompileShaderModule = (code, label, expected, hint) =>
    compileShaderModule(rhiDevice, asyncCreateShaderModule, code, label, expected, hint);
  const compileUtilityShader = (label: string, source: string, context: string) =>
    compileModule(
      source,
      label,
      `${context} shader module '${label}' compiled`,
      `inspect manifest WGSL for '${label}' and check device.features`,
    );

  /** Manifest-owned utility programs install their sources only after every module compiles. */
  const prewarmUtilityPrograms = async (): Promise<void> => {
    const computeStorageTexture = rhiDevice.caps.compute && rhiDevice.caps.storageTexture;
    if (computeStorageTexture) {
      const sources = await prewarmUtilityShaders(
        'volumetric fog',
        VOLUMETRIC_FOG_SHADER_STAGES,
        manifestEntries,
        (label, source) => compileUtilityShader(label, source, 'volumetric fog'),
        seedShaderModule,
      );
      if (sources !== undefined) await setVolumetricFogShaderSources(sources);
    }
    if (computeStorageTexture) {
      const sources = await prewarmSsrWithDepthPyramid(
        manifestEntries,
        compileUtilityShader,
        seedShaderModule,
      );
      if (sources !== undefined) setSsrShaderSources(sources.ssr, sources.pyramid);
    }
    if (caps.storageBuffer) {
      const deferred = await prewarmStandardDeferredPrograms(
        registry,
        compileUtilityShader,
        seedShaderModule,
        caps,
      );
      if (deferred !== undefined) setStandardDeferredShaderSources(deferred);
    }
    const atmosphere = await prewarmAtmospherePrograms(
      manifestEntries,
      compileUtilityShader,
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

  /**
   * Seed the eager PBR module under the exact lazy labels (canonical and its
   * matching variant) so first-touch layout-specific PSOs reuse it instead of
   * spinning on the transient pending signal.
   */
  const compileStandardPbr = async (
    entries: ResolvedEngineManifestEntries,
  ): Promise<{
    pbr: ShaderModule;
    gpuDrivenPbrPrograms: EngineShaderModules['gpuDrivenPbrPrograms'];
  }> => {
    const pbrModule = await compileModule(
      entries.pbr.wgsl,
      'pbr',
      'PBR shader module compiled',
      'inspect manifest pbr entry composed wgsl; check device.features',
    );
    seedShaderModule('module-forgeax::default-standard-pbr', pbrModule);
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
    const pbrVariant = pbrManifestEntry?.variants.find((variant) =>
      materialShaderSourceEquals(variant, entries.pbr.wgsl),
    );
    if (pbrVariant !== undefined)
      seedShaderModule(`module-forgeax::default-standard-pbr#${pbrVariant.definesKey}`, pbrModule);
    if (immediateCreateShaderModule === undefined)
      await prewarmStandardPbrVariants(pbrManifestEntry, entries.pbr, pbrModule);
    return { pbr: pbrModule, gpuDrivenPbrPrograms: gpuDrivenModules.gpuDrivenPbrPrograms };
  };

  /**
   * Built-in tonemap and temporal programs register on the unified post-process
   * channel. Their modules are compiled and seeded under the exact label the
   * lazy post-process pipeline requests, so a tight draw loop without an await
   * builds them on frame 1 instead of stalling on a black frame.
   */
  const prewarmPostProcessPrograms = async (
    entries: ResolvedEngineManifestEntries,
  ): Promise<void> => {
    const tonemapLabel = postProcessShaderModuleLabel(entries.tonemap.wgsl);
    const tonemapModule = await compileModule(
      entries.tonemap.wgsl,
      tonemapLabel,
      'tonemap shader module compiled (unified post-process prewarm)',
      'inspect manifest tonemap entry composed wgsl; check device.features',
    );
    seedShaderModule(tonemapLabel, tonemapModule);
    registerBuiltinTonemap(entries.tonemap.wgsl);
    const prewarmTemporal = createTemporalShaderPrewarmer({
      device: rhiDevice,
      asyncCreateShaderModule,
      seedShaderModule,
    });
    const analyticFog = findEngineManifestEntry(registry, manifestEntries, 'forgeax::analytic-fog');
    await prewarmTemporal(analyticFog, 'forgeax.analytic-fog');
    if (analyticFog !== undefined) registerBuiltinAnalyticFog(analyticFog.wgsl);
    await prewarmTemporal(entries.motionBlur, 'forgeax.motion-blur');
    await prewarmTemporal(entries.taaResolve, 'forgeax.taa-resolve');
    await prewarmDepthOfField(manifestEntries, prewarmTemporal, registerBuiltinDepthOfField);
    registerBuiltinTemporalPostProcesses({
      ...(entries.motionBlur === undefined ? {} : { motionBlur: entries.motionBlur.wgsl }),
      ...(entries.taaResolve === undefined ? {} : { taaResolve: entries.taaResolve.wgsl }),
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
    const fxaaModule = await compileManifestModule(compileModule, fxaaEntry, 'fxaa');
    if (fxaaEntry === undefined || fxaaModule === null) return null;
    registerBuiltinFxaa(fxaaEntry.wgsl);
    seedShaderModule(postProcessShaderModuleLabel(fxaaEntry.wgsl), fxaaModule);
    return fxaaModule;
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
    );
    publishIblPrograms(entries);
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
    );
    await prewarmUtilityPrograms();
    const standard = await compileStandardPbr(entries);
    seedPbrSourceAliases(registry, entries.pbr.wgsl, standard.pbr, seedShaderModule);
    const unlit = await compileUnlitModules(
      registry,
      compileModule,
      seedShaderModule,
      caps,
      entries.unlit,
    );
    await prewarmShadowCasterModules(
      registry,
      compileModule,
      seedShaderModule,
      caps,
      entries.shadowCaster,
    );
    await prewarmPostProcessPrograms(entries);
    const sprite = await compileSpriteModules(
      registry,
      compileModule,
      seedShaderModule,
      caps,
      entries.sprite,
    );
    const spriteLit = await compileSpriteLitModules(
      rhiDevice,
      registry,
      compileModule,
      seedShaderModule,
      caps,
      entries.spriteLit,
    );
    const fxaa = await compileFxaa(entries.fxaa);
    const skybox = await compileManifestModule(compileModule, entries.skybox, 'skybox');
    // Bloom modules stay available to the lazy Bloom owner; its pipelines,
    // bindings and parameter buffers are deferred until admission.
    const bloomHorizontal = await compileManifestModule(
      compileModule,
      entries.bloomHorizontal,
      'bloom-horizontal',
    );
    const bloomVertical = await compileManifestModule(
      compileModule,
      entries.bloomVertical,
      'bloom-vertical',
    );
    const bloomComposite = await compileManifestModule(
      compileModule,
      entries.bloomComposite,
      'bloom-composite',
    );
    const ssao = caps.webgl2Downlevel
      ? null
      : await compileManifestModule(compileModule, entries.ssao, 'hdrp-ssao');
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
      gpuDrivenPbrPrograms: standard.gpuDrivenPbrPrograms,
    };
  };

  const modules =
    manifestEntries.length > 0 ? await compileEngineModules() : emptyEngineShaderModules();
  const bootModulesReady = modules.unlit !== null && modules.pbr !== null;

  // Standard layouts: view + material + mesh-array + instances (no group(4)).
  // HDRP variants swap the clustered unified group(2); GPU-driven batches keep
  // that group with the compact scene-index slot(3).
  const pbrLayouts = buildReadyPbrLayouts(rhiDevice, caps);
  const unlitPipelineLayout = buildUnlitPipelineLayout(
    rhiDevice,
    registry,
    caps.storageBuffer,
    pbrLayouts,
  );
  const hdrp = buildHdrpPipelineLayouts(rhiDevice, caps.storageBuffer, pbrLayouts);
  const { hdrpClusterMembershipPipeline, hdrpClusterMembershipBindGroupLayout } =
    await buildClusterMembershipProducer(
      rhiDevice,
      caps.storageBuffer && bootModulesReady,
      asyncCreateShaderModule,
    );
  const gpuDriven = buildGpuDrivenPbrReadyLayouts(rhiDevice, caps.storageBuffer, pbrLayouts);
  const gpuDrivenCluster = buildGpuDrivenClusterLayouts(
    rhiDevice,
    caps.storageBuffer,
    pbrLayouts,
    hdrp.unifiedBgl,
    gpuDriven,
  );

  // Pipeline-scoped shared buffers; per-frame bind groups reference them and
  // queue.writeBuffer updates their contents.
  const queue = rhiDevice.queue;
  const viewUniformBuffer = createViewUniformBuffer(createPersistentBuffer);
  const pointsLinesView = createPointsLinesViewBuffer(rhiDevice, rendererScope);
  const shadowCasterCascadeBuffer = createShadowCasterCascadeBuffer(createPersistentBuffer);
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
  const runtimeSpecConstTable = buildSpecConstTable(swapChainFormats.view).map((spec) =>
    withMaterialVertexInputs(registry, spec),
  );
  const runtimeLinearLdrMaterialSpecTable = buildLinearLdrMaterialSpecTable(
    swapChainFormats.view,
  ).map((spec) => withMaterialVertexInputs(registry, spec));
  prewarmMaterialSpecPipelines(
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
  const fullscreenPasses = bootModulesReady
    ? createFullscreenPassResources(
        rhiDevice,
        pipelineDeviceProvider,
        pipelineCache,
        modules,
        caps.storageBuffer ? swapChainFormats.storage : swapChainFormats.view,
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
    bootModulesReady,
  );

  await prewarmMipmapPipeline(rhiDevice, gpuStore, manifestEntries.length > 0);

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
    // Standard material variants resolve through the material-shader cache;
    // these unlit PSOs are the prewarmed SPEC_CONST built-ins (null for an
    // empty manifest).
    unlitPipeline: cachedUnlitPipeline(false, 1),
    standardPbrShaderUvSetCount,
    unlitPipelineMsaa: cachedUnlitPipeline(false, 4),
    unlitPipelineHdrMsaa: cachedUnlitPipeline(true, 4),
    ...selectBootModuleLayouts(bootModulesReady, pbrLayouts, hdrp, gpuDriven, gpuDrivenCluster),
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
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      })
      .unwrap(),
    atmosphereFallbackView,
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
      shadowSampler: samplers.shadowSampler,
      shadowLightSpaceMatrix: null,
      shadowCsmLightViewProj: null,
      shadowCsmSelection: null,
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
  // Boot-time fallback resources submit real GPU work before the renderer is
  // published. Keep initialization as the readiness barrier for the first
  // frame: a Worker can otherwise receive `ready`, start its frame deadline,
  // and report `frame-submitted` while that earlier queue work still holds the
  // receipt's completion fence.
  await queue.onSubmittedWorkDone();
  return pipelineState;
}
