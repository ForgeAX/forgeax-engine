import type { PipelineGroup2Contract } from '@forgeax/engine-shader';
import { atmosphereAvailable } from '../environment/capability';
import type { GpuDrivenPbrProgram } from '../gpu-driven/pbr-program';
import { MESH_PER_ENTITY_STRIDE, MESH_UBO_FULL_ARRAY_BYTES } from '../record/mesh-ssbo';
import { SHADOW_PARAMS_BYTES } from '../record/view-ubo';
import { transmissionBackdropAvailable } from './device-feature-admission';
import { buildClusterMembershipProducer } from './webgpu-cluster-ready';
// WebGPU generation-scoped ready-state builder.
// This owner performs one complete device-generation promotion; it receives
// policy/adapters and returns a fully prepared PipelineState.

import type {
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  PipelineLibraryManifest,
  RenderPipeline,
  Result,
  RhiDevice,
  Sampler,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, RhiError } from '@forgeax/engine-rhi';
import {
  DEFAULT_UNLIT_PARAM_SCHEMA,
  findVariantByKey,
  materialShaderSourceEquals,
  type ShaderCatalog,
} from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';
import { prewarmDepthOfField } from '../features/depth-of-field/depth-of-field-assembly';
import type { RhiBackendPack } from './backend-contract';
import { selectCloudShadowCompatibleEntry } from './cloud-shadow-entry';
import {
  ATMOSPHERE_SHADER_STAGES,
  prewarmSsrWithDepthPyramid,
  prewarmUtilityShaders,
  VOLUMETRIC_FOG_SHADER_STAGES,
} from './utility-shader-prewarm';

export type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

import type { GpuResidencyCache } from '../device/gpu-residency';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING } from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { setIblComposedShaders } from '../ibl/IblPipelineCache';
import {
  createSkylightFallback,
  type SkylightFallback,
  texelFallbackDescriptor,
  writeTexelFallback,
} from '../ibl/skylight-bind-group';
import { type BloomInspection, emptyBloomInspection } from '../inspection-types';
import type { DeviceScope, RhiErrorListenerRegistry } from '../lifecycle';
import { assertStorageBufferCap } from '../light-buffer-layout';
import { buildPbrPipelineLayouts, SKIN_MATERIAL_SHADER_ID } from '../pbr-pipeline';
import { inspectStandardBloomGraph } from '../pipeline/standard-post';
import {
  buildBindGroupLayoutDescriptor,
  buildLinearLdrMaterialSpecTable,
  buildSpecConstTable,
  cacheKeyOf,
  createHdrpBindGroupLayoutDescriptor,
  getOrBuildPipeline,
  type PipelineCache,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
} from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import { deriveExtendedLightingCapability } from '../prepare/extended-lighting/resources';
import { createPointsLinesViewBuffer } from '../record/points-lines-view-buffer';
import { type BloomPersistentBundle, MATERIAL_UNIFORM_BYTES } from '../record/render-context';
import { SHADOW_CASTER_BUFFER_SIZE } from '../record/shadow-pass';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import {
  MATERIAL_PER_ENTITY_STRIDE,
  type PipelineState,
  selectSwapChainFormat,
} from '../render-system';
import type { SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { createExtendedLightingFallbackResources } from './extended-lighting-fallback';
import { createLayeredTextureFallbackViews } from './layered-texture-fallback';
import {
  invokeDeviceCreateShaderModule,
  prepareLowLimitMaterialShaderEntry,
} from './material-shader-policy';
import { prewarmRequiredMaterialShaders } from './material-shader-prewarm';
import {
  createMeshSsboGrowController,
  INITIAL_MESH_SSBO_SLOT_COUNT,
  type MeshSsboGrowDevice,
  type MeshSsboGrowResult,
  type MeshSsboState,
  requireMeshSsboBuffer,
} from './mesh-ssbo-grow';
import { runShimStep, runShimSyncStep } from './renderer-helpers';
import {
  prewarmMaterialShaderVariants,
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  selectBootVariant,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
  type VariantPrewarmAdmission,
} from './shader-prewarm-policy';
import { createShadowArrayFallbackView } from './shadow-array-fallback';
import { createSkinPaletteOwner } from './skin-palette-owner';
import { createTemporalShaderPrewarmer } from './temporal-post-process-prewarm';
import { buildGpuDrivenPbrReadyLayouts, buildGpuDrivenPbrReadyModules } from './webgpu-pbr-ready';
import {
  BLOOM_COMPOSITE_PARAMS_BYTES,
  BLOOM_HORIZONTAL_PARAMS_BYTES,
  BLOOM_VERTICAL_PARAMS_BYTES,
  HDR_COLOR_ATTACHMENT_FORMAT,
  VIEW_UBO_BYTES,
} from './webgpu-ready-contract';
import { prewarmMipmapPipeline } from './webgpu-ready-mipmap';
import { createReadyPerPassResources } from './webgpu-ready-per-pass';

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
  const extendedLightingShaderAvailable = deriveExtendedLightingCapability(rhiDevice).admitted;
  // Shader and layout construction consume the same storage capability.
  const capValue = rhiDevice.limits.maxStorageBuffersPerShaderStage;
  const webgl2Downlevel = rhiDevice.caps.backendKind === 'wgpu-webgl2';
  let storageBufferCapable = !webgl2Downlevel && rhiDevice.caps.storageBuffer;
  if (typeof capValue === 'number') {
    const capCheck = assertStorageBufferCap(capValue);
    storageBufferCapable =
      capCheck.ok && !webgl2Downlevel && rhiDevice.caps.storageBuffer && capCheck.value;
  }
  const atmosphereShaderAvailable = atmosphereAvailable(
    storageBufferCapable,
    rhiDevice.limits.maxSampledTexturesPerShaderStage,
  );
  const atmosphereFallbackView = atmosphereShaderAvailable
    ? (() => {
        const descriptor = texelFallbackDescriptor('atmosphere-neutral-volume', 'rgba8unorm', '3d');
        const texture = createPersistentTexture(descriptor).unwrap();
        writeTexelFallback(rhiDevice.queue, texture, descriptor, new Uint8Array(4)).unwrap();
        return rhiDevice.createTextureView(texture, { dimension: '3d' }).unwrap();
      })()
    : undefined;
  const directionalPcssAvailable =
    rhiDevice.caps.backendKind === 'webgpu' || rhiDevice.caps.backendKind === 'wgpu-native';
  const projectorAvailable =
    (rhiDevice.limits.maxSampledTexturesPerShaderStage ?? 0) >=
    STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES;
  // bug-20260612: choose swap-chain storage / view formats by backend.
  // Channel 2 (native WebGPU) follows navigator.gpu.getPreferredCanvasFormat();
  // Channel 3 (wgpu-wasm GLES, storageBufferCapable=false) hard-codes
  // rgba8unorm. The pair flows into PipelineState.format /
  // .colorAttachmentFormat below and through it into every downstream
  // pipeline target, configure() call, and color-attachment format —
  // single SSOT, no scattered branches. See selectSwapChainFormat
  // (above the SWAP_CHAIN_*_FORMAT historical constants).
  const surfaceViewFormats =
    (rhiDevice as unknown as { readonly surfaceViewFormats?: boolean }).surfaceViewFormats ??
    !webgl2Downlevel;
  const swapChainFormats = selectSwapChainFormat(storageBufferCapable, surfaceViewFormats);
  // The 'null' (headless RhiNull) backend has no UA preferred-canvas-format by
  // design; the rgba8unorm fallback is its intended steady state, not a
  // degraded one — firing 'rhi-not-available' there is territorially wrong
  // (the backend IS available) and only pollutes Renderer error events in headless
  // CI. Skip the diagnostic for it; Channel 2/3 still report a missing
  // getPreferredCanvasFormat as before.
  if (swapChainFormats.fallbackReason !== undefined && rhiDevice.caps.backendKind !== 'null') {
    // Step ③ in selectSwapChainFormat fired — surface a structured
    // diagnostic through the RhiError channel so AI users subscribed via
    // Renderer error subscribers can detect "extremely-old UA / missing
    // navigator.gpu.getPreferredCanvasFormat" and react. The renderer
    // continues with the rgba8unorm fallback (charter §9 graceful
    // degradation; charter P3 explicit failure — no silent fallback).
    errorRegistry.fire(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'navigator.gpu.getPreferredCanvasFormat is callable on Channel 2',
        hint: 'browser is too old or WebGPU implementation incomplete; falling back to rgba8unorm swap-chain format. Update the UA or use a Channel-3-compatible canvas configuration.',
      }),
    );
  }
  // ── Step 2: PBR + unlit pipeline compile ───────────────────────────────────
  // bug-20260519 D-1 + D-3: gate the entire PBR / unlit shader-compile block
  // behind `manifestEntries.length > 0`. The Camera-only / clear-pass-only
  // path (LO 1.1 hello-window equivalent) ships an empty manifest -- no
  // PBR/unlit entry to find, no shader module to compile. When the gate is
  // skipped both `unlitModule` and `pbrModule` stay `null` and the later
  // unlit / standard `createRenderPipeline` calls are skipped in turn so
  // the returned `PipelineState.{unlitPipeline,standardPipeline}` fields
  // are written `null` (D-3 nullable). The render-time access point in
  // `render-system-record.ts` narrows on `=== null` and fires a structured
  // `RhiError shader-compile-failed` (charter P3 explicit failure;
  // AC-03). Other PipelineState fields (BindGroupLayout chain / shared
  // buffers / defaultSampler / fallbackTextureView / depthTexture* /
  // identityInstanceBuffer / mesh handles) keep their existing
  // construction so the clear-pass path remains fully wired (D-3
  // explicit scope).
  const registry = getShader();
  //
  // feat-20260518-pbr-direct-lighting-mvp M5 / w22.9 (AC-05 + plan-strategy
  // D-3 + D-4 + dual-pipeline contract w12): the manifest now ships the
  // pbr.wgsl + unlit.wgsl entries written by `@forgeax/engine-vite-plugin-shader`'s
  // `buildStart` hook (engine-entries eager compile via naga_oil). Identify
  // them by content marker (charter P3 explicit failure: silent fallback to
  // a wrong entry would produce mis-shaded pixels indistinguishable from
  // success). pbr.wgsl is the only entry whose composed body contains the
  // `f_schlick(` BRDF helper call; the other engine entry is unlit.
  // M3 D-P4: rhi-webgpu supplies the async factory; rhi-wgpu and the
  // explicit escape hatch fall back to the synchronous device entry.
  const manifestEntries: ManifestEntry[] = [];
  for (const entry of registry.entries()) {
    manifestEntries.push(entry);
  }
  if (rhiDevice.caps.backendKind === 'null' && manifestEntries.length === 0) {
    // Decide after shader preparation: an unloaded registry is not an empty
    // manifest. Structural frames share the same single registration owner.
    registerBuiltinTonemap('');
  }
  let pbrModule: ShaderModule | null = null;
  let gpuDrivenPbrPrograms: ReadonlyMap<string, GpuDrivenPbrProgram> = new Map();
  let unlitModule: ShaderModule | null = null;
  let spriteModule: ShaderModule | null = null;
  let spriteLitModule: ShaderModule | null = null;
  let fxaaModule: ShaderModule | null = null;
  let skyboxModule: ShaderModule | null = null;
  let bloomHorizontalModule: ShaderModule | null = null;
  let bloomVerticalModule: ShaderModule | null = null;
  let bloomCompositeModule: ShaderModule | null = null;
  let ssaoModule: ShaderModule | null = null;
  const findEngineManifestEntry = (identifier: string): ManifestEntry | undefined => {
    const materialEntry = Array.from(registry.materialShaderManifestEntries()).find(
      (candidate) => candidate.identifier === identifier,
    );
    if (materialEntry === undefined) return undefined;
    return (
      manifestEntries.find((entry) => entry.wgsl === materialEntry.composedWgsl) ?? {
        hash: `engine:${identifier}`,
        wgsl: materialEntry.composedWgsl,
        glsl: undefined,
        bindings: '',
      }
    );
  };
  if (manifestEntries.length > 0) {
    // Merge of bug-20260519 D-1 + D-3 (manifest-zero gate, this branch's
    // outer `if (manifestEntries.length > 0)`) + main feat-20260519-tonemap
    // T-M2.5 (engine SSOT triple — pbr + unlit + tonemap) +
    // feat-20260520-directional-light-shadow-mapping M1c / w9 (shadow_caster
    // as additional engine entry) + feat-20260520-2d-sprite-layer-mvp M-3 / w24
    // (sprite as additional engine entry) + feat-20260520-skylight-ibl-cubemap
    // M5-amend Gap A (4 IBL precompute entries).
    //
    // Manifest non-empty: require pbr + unlit + tonemap; shadow_caster +
    // sprite + IBL entries are optional — absent ones leave their module
    // null and the dependent pipeline stays null (callers fail-fast at
    // dispatch if they relied on a missing entry).
    //
    // Marker triage (charter P3 explicit failure):
    //   - tonemap.wgsl: declares `struct TonemapParams`
    //   - sprite.wgsl: declares `pivotAndSize` Material field
    //   - pbr.wgsl: composes `f_schlick`
    //   - shadow_caster.wgsl: only position input (no normal/uv/tangent)
    //   - IBL entries: identified by their fragment entry-point markers
    //     (equirectToCube_fs / irradianceConvolve_fs / prefilterEnv_fs /
    //     brdfLutBake_fs) which survive naga_oil composition unchanged.
    //   - unlit.wgsl: none of the above markers → falls into the unlit slot.
    let pbrEntry = findEngineManifestEntry('forgeax::default-standard-pbr');
    let pbrSkinEntry =
      findEngineManifestEntry(SKIN_MATERIAL_SHADER_ID) ??
      findEngineManifestEntry('forgeax::default-standard-pbr-skin');
    let unlitEntry = findEngineManifestEntry('forgeax::default-unlit');
    let tonemapEntry: ManifestEntry | undefined;
    let motionBlurEntry: ManifestEntry | undefined;
    let spriteEntry: ManifestEntry | undefined;
    // sprite-lit identification marker is the `spriteLitShadeAccum`
    // helper (defined in sprite-lit.wgsl, absent from sprite.wgsl). The
    // outer shading accumulator name is stable across shading-formula
    // changes and unique to sprite-lit. Identified BEFORE sprite so the
    // `pivotAndSize` marker (shared between sprite + sprite-lit since
    // their paramSchema mirror) does not mis-classify sprite-lit as
    // sprite.
    let spriteLitEntry: ManifestEntry | undefined;
    let taaResolveEntry: ManifestEntry | undefined;
    let iblEquirectEntry: ManifestEntry | undefined;
    let iblIrradianceEntry: ManifestEntry | undefined;
    let iblPrefilterEntry: ManifestEntry | undefined;
    let iblBrdfLutEntry: ManifestEntry | undefined;
    let probeBackgroundEntry: ManifestEntry | undefined;
    let fxaaEntry: ManifestEntry | undefined;
    let skyboxEntry: ManifestEntry | undefined;
    let bloomHorizontalEntry: ManifestEntry | undefined;
    let bloomVerticalEntry: ManifestEntry | undefined;
    let bloomCompositeEntry: ManifestEntry | undefined;
    let ssaoEntry: ManifestEntry | undefined;
    // feat-20260609 R3-fixup: shadow_caster module pre-bake. T-009 deleted
    // the hardcoded shadowCasterPipeline; the lazy
    // getMaterialShaderPipeline path (passKind='shadow-caster') uses
    // the shared adapter cache, which is unwarmed for shadow_caster on
    // frame 1. We eagerly compile + seed the adapter cache so the lazy
    // build hit on `module-forgeax::default-shadow-caster` returns OK
    // without a 1-frame warmup. Resolve it by its reserved manifest identity;
    // game shaders are free to use each vertex-input subset.
    let shadowCasterEntry = findEngineManifestEntry('forgeax::default-shadow-caster');
    for (const entry of manifestEntries) {
      if (entry.wgsl.includes('TonemapParams')) {
        tonemapEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('MotionBlurParams')) {
        motionBlurEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('fs_taa_resolve')) {
        taaResolveEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('spriteLitShadeAccum')) {
        // sprite-lit identification — must precede the `pivotAndSize`
        // marker since sprite-lit also carries that field (paramSchema
        // mirror with sprite.wgsl).
        spriteLitEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('pivotAndSize')) {
        spriteEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('equirectToCube_fs')) {
        iblEquirectEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('irradianceConvolve_fs')) {
        iblIrradianceEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('prefilterEnv_fs')) {
        iblPrefilterEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('brdfLutBake_fs')) {
        iblBrdfLutEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('probe_background_fs')) {
        probeBackgroundEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('f_schlick')) {
        pbrEntry ??= entry;
        continue;
      }
      // feat-20260528-fxaa-post-processing: fxaa marker — the composed
      // WGSL contains the rgb2luma helper unique to the FXAA algorithm
      // (plan-strategy D-5). Identified before shadow_caster / unlit
      // fallback so the marker takes priority over generic position-only
      // heuristics.
      if (entry.wgsl.includes('rgb2luma')) {
        fxaaEntry ??= entry;
        continue;
      }
      // feat-20260531-skybox-env-background M3 / w15: skybox marker --
      // the composed WGSL contains the skybox_fs fragment entry point
      // unique to skybox.wgsl (plan-strategy D-7).
      if (entry.wgsl.includes('skybox_fs')) {
        skyboxEntry ??= entry;
        continue;
      }
      // Multiscale Bloom marker triage. The composed WGSL retains these
      // uniform-struct names through naga_oil, so shader ownership is resolved
      // from the cooked manifest rather than from a runtime compiler or a
      // second heuristic path.
      if (entry.wgsl.includes('BloomHorizontalParams')) {
        bloomHorizontalEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('BloomVerticalParams')) {
        bloomVerticalEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('BloomCompositeParams')) {
        bloomCompositeEntry ??= entry;
        continue;
      }
      // feat-20260612-hdrp-ssao M6 / w27: SSAO marker triage (D-E).
      // The composed WGSL contains 'fs_ssao_calc' fragment entry point
      // which survives naga_oil composition unchanged. Same pattern as
      // the bloom struct-name markers above.
      if (entry.wgsl.includes('fs_ssao_calc')) {
        ssaoEntry ??= entry;
        continue;
      }
      unlitEntry ??= entry;
    }
    // Null is structural-only; real backends require the shipped manifest.
    if (
      rhiDevice.caps.backendKind === 'null' &&
      (pbrEntry === undefined || unlitEntry === undefined || tonemapEntry === undefined)
    ) {
      const fallback = (hash: string) =>
        ({ hash, wgsl: '', glsl: '', bindings: '' }) as ManifestEntry;
      pbrEntry ??= fallback('null-pbr');
      unlitEntry ??= fallback('null-unlit');
      tonemapEntry ??= fallback('null-tonemap');
    }
    if (pbrEntry === undefined || unlitEntry === undefined || tonemapEntry === undefined) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected:
          'manifest entries include pbr.wgsl + unlit.wgsl + tonemap.wgsl (engine SSOT triple)',
        hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with the 3 engine entries; check vite plugin engineEntries option',
      });
    }
    // WebGL2 must compile the storage=false material variants against its
    // uniform fallback layouts; patch the flat engine entries accordingly.
    if (!storageBufferCapable) {
      // Match by fields because multi-axis keys are compound and order-sensitive.
      const idToVariantWgsl = new Map<string, string>();
      for (const ms of registry.materialShaderManifestEntries()) {
        const exact = ms.variants.find(
          (v) =>
            v.defines.STORAGE_BUFFER_AVAILABLE === false &&
            v.defines.ATMOSPHERE_AVAILABLE !== true &&
            v.defines.COVERAGE_ONLY !== true &&
            v.defines.VISIBLE_SURFACE_AVAILABLE !== true &&
            v.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true &&
            (!('CLUSTER_FORWARD_AVAILABLE' in v.defines) ||
              v.defines.CLUSTER_FORWARD_AVAILABLE === false) &&
            (!('VERTEX_COLOR_AVAILABLE' in v.defines) ||
              v.defines.VERTEX_COLOR_AVAILABLE === false) &&
            (!('DIRECTIONAL_PCSS_AVAILABLE' in v.defines) ||
              v.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
            (!('PROJECTOR_AVAILABLE' in v.defines) ||
              v.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
            (!('REFLECTION_FALLBACK_AVAILABLE' in v.defines) ||
              v.defines.REFLECTION_FALLBACK_AVAILABLE === false) &&
            v.defines.PROBE_BLEND_AVAILABLE !== true &&
            (!('SKINNING_DISABLED' in v.defines) || v.defines.SKINNING_DISABLED === true),
        );
        const v = exact === undefined ? undefined : findVariantByKey(ms, exact.definesKey);
        if (v !== undefined) {
          idToVariantWgsl.set(ms.identifier, v.composedWgsl);
        }
      }
      const patch = (entry: ManifestEntry, identifier: string): ManifestEntry => {
        const wgsl = idToVariantWgsl.get(identifier);
        return wgsl !== undefined ? { ...entry, wgsl } : entry;
      };
      pbrEntry = patch(pbrEntry, 'forgeax::default-standard-pbr');
      unlitEntry = patch(unlitEntry, 'forgeax::default-unlit');
      if (shadowCasterEntry !== undefined) {
        // Shadow caster also needs the storage=false uniform fallback.
        shadowCasterEntry = patch(shadowCasterEntry, 'forgeax::default-shadow-caster');
      }
      if (spriteEntry !== undefined) {
        spriteEntry = patch(spriteEntry, 'forgeax::sprite');
      }
      if (spriteLitEntry !== undefined) {
        spriteLitEntry = patch(spriteLitEntry, 'forgeax::sprite-lit');
      }
    }
    // Patch eager entries to the exact device/URP variant; canonical sources
    // may declare optional vertex inputs absent from the boot layout.
    const idToRuntimeVariantWgsl = new Map<string, string>();
    for (const ms of registry.materialShaderManifestEntries()) {
      const exact = ms.variants.find(
        (variant) =>
          variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
          (!('ATMOSPHERE_AVAILABLE' in variant.defines) ||
            variant.defines.ATMOSPHERE_AVAILABLE === atmosphereShaderAvailable) &&
          variant.defines.COVERAGE_ONLY !== true &&
          variant.defines.VISIBLE_SURFACE_AVAILABLE !== true &&
          // Scene-index variants bind only GPU Scene tables in slot 3.
          variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true &&
          (!('CLUSTER_FORWARD_AVAILABLE' in variant.defines) ||
            variant.defines.CLUSTER_FORWARD_AVAILABLE === false) &&
          (!('VERTEX_COLOR_AVAILABLE' in variant.defines) ||
            variant.defines.VERTEX_COLOR_AVAILABLE === false) &&
          (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
            variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
          (!('PROJECTOR_AVAILABLE' in variant.defines) ||
            variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
          (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
            variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
          variant.defines.PROBE_BLEND_AVAILABLE !== true &&
          (!('SKINNING_DISABLED' in variant.defines) ||
            variant.defines.SKINNING_DISABLED === true) &&
          (!('TRANSMISSION_AVAILABLE' in variant.defines) ||
            variant.defines.TRANSMISSION_AVAILABLE === false) &&
          (!('REFLECTION_FALLBACK_AVAILABLE' in variant.defines) ||
            variant.defines.REFLECTION_FALLBACK_AVAILABLE === false),
      );
      const variant = exact === undefined ? undefined : findVariantByKey(ms, exact.definesKey);
      if (variant !== undefined) {
        idToRuntimeVariantWgsl.set(ms.identifier, variant.composedWgsl);
      }
    }
    const patchRuntimeVariant = (entry: ManifestEntry, identifier: string): ManifestEntry => {
      const wgsl = idToRuntimeVariantWgsl.get(identifier);
      return wgsl !== undefined ? { ...entry, wgsl } : entry;
    };
    pbrEntry = patchRuntimeVariant(pbrEntry, 'forgeax::default-standard-pbr');
    const pbrMaterialEntry = Array.from(registry.materialShaderManifestEntries()).find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    pbrEntry = selectCloudShadowCompatibleEntry(pbrEntry, pbrMaterialEntry, projectorAvailable);
    if (pbrSkinEntry !== undefined) {
      pbrSkinEntry = patchRuntimeVariant(
        patchRuntimeVariant(pbrSkinEntry, SKIN_MATERIAL_SHADER_ID),
        'forgeax::default-standard-pbr-skin',
      );
      const pbrSkinMaterialEntry = Array.from(registry.materialShaderManifestEntries()).find(
        (entry) =>
          entry.identifier === SKIN_MATERIAL_SHADER_ID ||
          entry.identifier === 'forgeax::default-standard-pbr-skin',
      );
      pbrSkinEntry = selectCloudShadowCompatibleEntry(
        pbrSkinEntry,
        pbrSkinMaterialEntry,
        projectorAvailable,
      );
    }
    unlitEntry = patchRuntimeVariant(unlitEntry, 'forgeax::default-unlit');
    if (shadowCasterEntry !== undefined) {
      shadowCasterEntry = patchRuntimeVariant(shadowCasterEntry, 'forgeax::default-shadow-caster');
    }
    if (spriteEntry !== undefined) {
      spriteEntry = patchRuntimeVariant(spriteEntry, 'forgeax::sprite');
    }
    if (spriteLitEntry !== undefined) {
      spriteLitEntry = patchRuntimeVariant(spriteLitEntry, 'forgeax::sprite-lit');
    }
    // bug-20260708 M2 (a): sprite entry WGSL patch — always substitute the
    // PIR=false variant so the eager compile at line ~4272 (which produces
    // `spriteModule`, seeded under `module-forgeax::sprite` at line ~4297 and
    // exposed via `shaderModuleMap.set('forgeax::sprite', ...)` at line
    // ~5438) yields the 5575B PIR=false shader module. The character /
    // sprite-atlas per-entity path (`main-pass-sprite-draws.ts:511-513`)
    // routes `variantSet=undefined` through `getMaterialShaderPipeline`
    // with `moduleLabel='module-forgeax::sprite'` — hitting this seeded
    // module. SpriteInstances batches request `variantSet=''` →
    // `moduleLabel='module-forgeax::sprite#'` (distinct label) → compile
    // fresh from `findVariantByKey(msEntry, '')` returning the PIR=true
    // 5653B variant. The upstream `manifestEntries` populated
    // `spriteEntry.wgsl` with the plugin default (all-true canonical =
    // PIR=true+SBA=true); we substitute the matching-SBA PIR=false variant
    // here. Runs regardless of `storageBufferCapable` — the WebGL2 fallback
    // patch above (bug-20260610) already substitutes SBA=false; we now
    // substitute PIR=false on top so the boot-time seeded module for
    // sprite is aligned with the boot-registered material-shader source
    // (patched at line ~3710 via the PER_INSTANCE_REGION extension above).
    if (spriteEntry !== undefined) {
      for (const msEntry of registry.materialShaderManifestEntries()) {
        if (msEntry.identifier === 'forgeax::sprite') {
          const pirFalseVariant = selectBootVariant(msEntry, {
            PER_INSTANCE_REGION: false,
            STORAGE_BUFFER_AVAILABLE: storageBufferCapable,
            ATMOSPHERE_AVAILABLE: atmosphereShaderAvailable,
          });
          if (pirFalseVariant !== undefined) {
            spriteEntry = { ...spriteEntry, wgsl: pirFalseVariant.composedWgsl };
          }
          break;
        }
      }
    }
    // Publish the generation's compiled IBL programs before resource preparation.
    if (
      iblEquirectEntry !== undefined &&
      iblIrradianceEntry !== undefined &&
      iblPrefilterEntry !== undefined &&
      iblBrdfLutEntry !== undefined
    ) {
      setIblComposedShaders({
        equirectToCube: iblEquirectEntry.wgsl,
        irradiance: iblIrradianceEntry.wgsl,
        prefilter: iblPrefilterEntry.wgsl,
        brdfLut: iblBrdfLutEntry.wgsl,
        ...(probeBackgroundEntry === undefined
          ? {}
          : { probeBackground: probeBackgroundEntry.wgsl }),
      });
    }
    // Points/Lines are an engine-owned record path rather than a producer
    // RenderFeature, so they cannot declare `requiredMaterialShaders`. Their
    // material pipeline still goes through the same lazy shader-module adapter
    // as producer features. Prewarm the optional manifest artifact here so a
    // first frame cannot race async module compilation and silently skip its
    // draw while the adapter is still pending. Older/minimal manifests may not
    // carry the optional entry; those hosts retain their existing behavior.
    const pointsLinesLookup = registry.findMaterialArtifact(POINTS_LINES_MATERIAL_SHADER_ID);
    if (pointsLinesLookup.ok) {
      const pointsLinesLabel = `module-${POINTS_LINES_MATERIAL_SHADER_ID}`;
      const pointsLinesShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: pointsLinesLookup.value.source,
                label: pointsLinesLabel,
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: pointsLinesLookup.value.source,
                label: pointsLinesLabel,
              }),
        'shader-compile-failed',
        `engine material shader '${POINTS_LINES_MATERIAL_SHADER_ID}' compiled`,
        `inspect the composed WGSL for '${POINTS_LINES_MATERIAL_SHADER_ID}' and check device.features`,
      );
      if (!pointsLinesShaderResult.ok) throw pointsLinesShaderResult.error;
      seedShaderModule(pointsLinesLabel, pointsLinesShaderResult.value);
    }
    await prewarmRequiredMaterialShaders({
      rhiDevice,
      registry,
      asyncCreateShaderModule,
      requiredMaterialShaders,
      seedShaderModule,
    });
    for (const postProcess of requiredFullscreenPostProcesses) {
      const label = postProcessShaderModuleLabel(postProcess.source);
      const shaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: postProcess.source, label })
            : invokeDeviceCreateShaderModule(rhiDevice, { code: postProcess.source, label }),
        'shader-compile-failed',
        `declared fullscreen render feature '${postProcess.identity}' compiled`,
        `inspect the composed WGSL for '${postProcess.identity}' and check device.features`,
      );
      if (!shaderResult.ok) throw shaderResult.error;
      seedShaderModule(label, shaderResult.value);
    }
    const compileUtilityShader = async (
      label: string,
      source: string,
      context: string,
    ): Promise<ShaderModule> => {
      const result = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: source, label })
            : invokeDeviceCreateShaderModule(rhiDevice, { code: source, label }),
        'shader-compile-failed',
        `${context} shader module '${label}' compiled`,
        `inspect manifest WGSL for '${label}' and check device.features`,
      );
      if (!result.ok) throw result.error;
      return result.value;
    };
    if (rhiDevice.caps.compute && rhiDevice.caps.storageTexture) {
      const sources = await prewarmUtilityShaders(
        'volumetric fog',
        VOLUMETRIC_FOG_SHADER_STAGES,
        manifestEntries,
        (label, source) => compileUtilityShader(label, source, 'volumetric fog'),
        seedShaderModule,
      );
      if (sources !== undefined) await setVolumetricFogShaderSources(sources);
    }

    if (rhiDevice.caps.compute && rhiDevice.caps.storageTexture) {
      const sources = await prewarmSsrWithDepthPyramid(
        manifestEntries,
        compileUtilityShader,
        seedShaderModule,
      );
      if (sources !== undefined) setSsrShaderSources(sources.ssr, sources.pyramid);
    }
    if (storageBufferCapable) {
      const deferred = [...registry.materialShaderManifestEntries()].find(
        (entry) => entry.identifier === 'forgeax::engine-standard-deferred-lighting',
      );
      if (deferred !== undefined) {
        const resolve = async (clustered: boolean, directDfgLut = false) => {
          const variant = deferred.variants.find(
            (candidate) =>
              candidate.defines.CLUSTER_FORWARD_AVAILABLE === clustered &&
              (candidate.defines.DIRECT_DFG_LUT_AVAILABLE ?? false) === directDfgLut &&
              (candidate.defines.ATMOSPHERE_AVAILABLE ?? false) === atmosphereShaderAvailable &&
              candidate.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable &&
              candidate.defines.PROJECTOR_AVAILABLE === projectorAvailable &&
              candidate.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable,
          );
          if (variant === undefined)
            throw new RhiError({
              code: 'shader-compile-failed',
              expected: 'capability-matched deferred lighting variant',
              hint: 'rebuild the Engine shader manifest',
            });
          const label = `standard_deferred_${clustered}_${directDfgLut}`;
          seedShaderModule(
            label,
            await compileUtilityShader(label, variant.composedWgsl, 'Deferred'),
          );
          return variant.composedWgsl;
        };
        const decals: {
          shadowVariance?: string;
          decalProject?: string;
          decalApply?: string;
          subsurface?: string;
        } = {};
        for (const [field, identifier] of [
          ['shadowVariance', 'forgeax::engine-shadow-variance'],
          ['decalProject', 'forgeax::engine-decal-project'],
          ['decalApply', 'forgeax::engine-decal-apply'],
          ['subsurface', 'forgeax::engine-subsurface-diffusion'],
        ] as const) {
          const entry = [...registry.materialShaderManifestEntries()].find(
            (entry) => entry.identifier === identifier,
          );
          if (entry === undefined) continue;
          const source = entry.variants[0]?.composedWgsl ?? entry.composedWgsl;
          seedShaderModule(
            identifier,
            await compileUtilityShader(
              identifier,
              source,
              field === 'subsurface' ? 'Subsurface' : 'Decal',
            ),
          );
          decals[field] = source;
        }
        setStandardDeferredShaderSources({
          ...decals,
          clustered: await resolve(true),
          unclustered: await resolve(false),
          ...(deferred.variants.some((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === true)
            ? {
                clusteredLut: await resolve(true, true),
                unclusteredLut: await resolve(false, true),
              }
            : {}),
        });
      }
    }
    const atmosphereSources = await prewarmUtilityShaders(
      'analytic-atmosphere',
      ATMOSPHERE_SHADER_STAGES,
      manifestEntries,
      (label, source) => compileUtilityShader(label, source, 'Atmosphere'),
      seedShaderModule,
    );
    if (atmosphereSources !== undefined) {
      const prefilter = manifestEntries.find((entry) => entry.wgsl.includes('fn prefilterEnv_fs('));
      if (prefilter === undefined) {
        throw new RhiError({
          code: 'shader-compile-failed',
          expected: 'Atmosphere uses the shared environment PMREM program',
          hint: 'include ibl-prefilter in the Engine shader manifest',
        });
      }
      seedShaderModule(
        'ibl-prefilter',
        await compileUtilityShader('ibl-prefilter', prefilter.wgsl, 'Atmosphere'),
      );
      setAtmosphereShaderSources({ ...atmosphereSources, prefilter: prefilter.wgsl });
    }
    const pbrShaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, { code: pbrEntry.wgsl, label: 'pbr' })
          : invokeDeviceCreateShaderModule(rhiDevice, { code: pbrEntry.wgsl, label: 'pbr' }),
      'shader-compile-failed',
      'PBR shader module compiled',
      'inspect manifest pbr entry composed wgsl; check device.features',
    );
    if (!pbrShaderResult.ok) throw pbrShaderResult.error;
    pbrModule = pbrShaderResult.value;
    // feat-20260629-multi-uv-set-support: a real extra-UV mesh creates a
    // layout-specific material PSO after the boot-time standard-layout PSO
    // has been pre-warmed. Seed the shared shader-module adapter under the
    // exact lazy-build labels so that this first-touch PSO can reuse the
    // already compiled PBR variant instead of returning the transient
    // `rhi-not-available` pending signal in a tight draw loop.
    seedShaderModule('module-forgeax::default-standard-pbr', pbrModule);
    const pbrManifestEntry = [...registry.materialShaderManifestEntries()].find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const pbrSkinManifestEntry =
      [...registry.materialShaderManifestEntries()].find(
        (entry) => entry.identifier === SKIN_MATERIAL_SHADER_ID,
      ) ??
      [...registry.materialShaderManifestEntries()].find(
        (entry) => entry.identifier === 'forgeax::default-standard-pbr-skin',
      );
    const gpuDrivenModules = await buildGpuDrivenPbrReadyModules({
      registry,
      device: rhiDevice,
      storageBufferCapable,
      asyncCreateShaderModule,
      pbrSkinEntry,
      immediateCreateShaderModule,
      pbrManifestEntry,
      pbrSkinManifestEntry,
      extendedLightingShaderAvailable,
      directionalPcssAvailable,
      projectorAvailable,
      seedShaderModule,
      admitsVariant,
    });
    gpuDrivenPbrPrograms = gpuDrivenModules.gpuDrivenPbrPrograms;
    const pbrVariant = pbrManifestEntry?.variants.find((variant) =>
      materialShaderSourceEquals(variant, pbrEntry.wgsl),
    );
    if (pbrVariant !== undefined) {
      seedShaderModule(`module-forgeax::default-standard-pbr#${pbrVariant.definesKey}`, pbrModule);
    }
    if (immediateCreateShaderModule === undefined) {
      // Every sampled-texture limit admits Standard transmission: a low-limit
      // device selects the shared-slot variant through the same variant axes.
      const transmissionVariants = selectStandardPbrTransmissionPrewarmVariants(
        pbrManifestEntry,
        storageBufferCapable,
        directionalPcssAvailable,
        projectorAvailable,
        extendedLightingShaderAvailable,
        atmosphereShaderAvailable,
      );

      // HDRP uses the canonical all-true variant key (`''`) and the lazy
      // material pipeline adapter therefore requests a distinct module label.
      // Compile every device-capability-matched HDRP variant and seed its exact
      // label. Color availability is part of the geometry-owned variant axis, so
      // both colored and no-color HDRP sources must be retained.
      const prewarmedPbrModules = new Map<string, ShaderModule>([[pbrEntry.wgsl, pbrModule]]);
      await prewarmMaterialShaderVariants(
        'forgeax::default-standard-pbr',
        [
          ...transmissionVariants,
          ...selectHdrpPbrPrewarmVariants(
            pbrManifestEntry,
            storageBufferCapable,
            extendedLightingShaderAvailable,
            true,
            directionalPcssAvailable,
            projectorAvailable,
            atmosphereShaderAvailable,
          ),
          ...selectProbePrewarmVariants(
            pbrManifestEntry,
            storageBufferCapable,
            extendedLightingShaderAvailable,
            true,
            directionalPcssAvailable,
            projectorAvailable,
            webgl2Downlevel,
            atmosphereShaderAvailable,
          ),
        ],
        prewarmedPbrModules,
        (variant, label) =>
          runShimStep(
            () =>
              asyncCreateShaderModule
                ? asyncCreateShaderModule(rhiDevice, { code: variant.composedWgsl, label })
                : invokeDeviceCreateShaderModule(rhiDevice, { code: variant.composedWgsl, label }),
            'shader-compile-failed',
            `Standard PBR variant ${variant.definesKey || '<default>'} compiled`,
            'inspect the selected Standard PBR variant WGSL and device.features',
          ),
        seedShaderModule,
        admitsVariant,
      );
    }
    // M2-07-c: Materials.standard with an explicit renderState reaches the
    // lazy material pipeline path, whose module label includes the requested
    // variant set. Reuse the boot-compiled PBR module only for manifest
    // variants with byte-identical composed WGSL; HDRP and WebGL2 variants
    // keep their own module identities and are never aliased here.
    for (const materialEntry of registry.materialShaderManifestEntries()) {
      for (const variant of materialEntry.variants) {
        if (materialShaderSourceEquals(variant, pbrEntry.wgsl)) {
          seedShaderModule(`module-${materialEntry.identifier}#${variant.definesKey}`, pbrModule);
        }
      }
    }
    const unlitShaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, { code: unlitEntry.wgsl, label: 'unlit' })
          : invokeDeviceCreateShaderModule(rhiDevice, { code: unlitEntry.wgsl, label: 'unlit' }),
      'shader-compile-failed',
      'unlit shader module compiled',
      'inspect manifest unlit entry composed wgsl; check device.features',
    );
    if (!unlitShaderResult.ok) throw unlitShaderResult.error;
    unlitModule = unlitShaderResult.value;
    // Seed the shared lazy adapter with the eagerly compiled module so
    // prepared color-only PSOs build synchronously on their first frame.
    seedShaderModule('unlit', unlitModule);
    // Material render-state variants use the canonical material id as their
    // module-cache label. Seed that alias too so a first-frame stencil,
    // blend, or cull variant does not skip its draw while the adapter warms.
    seedShaderModule('module-forgeax::default-unlit', unlitModule);
    // The canonical colored unlit variant uses a different composed WGSL from
    // the boot-time no-color module. Seed its exact lazy label so the first
    // COLOR_0 draw does not wait for an asynchronous module compile.
    const unlitManifestEntry = [...registry.materialShaderManifestEntries()].find(
      (entry) => entry.identifier === 'forgeax::default-unlit',
    );
    const coloredUnlitVariant = selectBootVariant(unlitManifestEntry, {
      VERTEX_COLOR_AVAILABLE: true,
      STORAGE_BUFFER_AVAILABLE: storageBufferCapable,
      ATMOSPHERE_AVAILABLE: atmosphereShaderAvailable,
      COVERAGE_ONLY: false,
    });
    if (coloredUnlitVariant !== undefined && coloredUnlitVariant.composedWgsl !== unlitEntry.wgsl) {
      const coloredUnlitShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: coloredUnlitVariant.composedWgsl,
                label: 'unlit-vertex-color',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: coloredUnlitVariant.composedWgsl,
                label: 'unlit-vertex-color',
              }),
        'shader-compile-failed',
        'colored unlit shader module compiled',
        'inspect the VERTEX_COLOR_AVAILABLE=true unlit variant and device.features',
      );
      if (!coloredUnlitShaderResult.ok) throw coloredUnlitShaderResult.error;
      seedShaderModule(
        `module-forgeax::default-unlit#${coloredUnlitVariant.definesKey}`,
        coloredUnlitShaderResult.value,
      );
    }
    const uncoloredUnlitVariant = selectBootVariant(unlitManifestEntry, {
      VERTEX_COLOR_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: storageBufferCapable,
      ATMOSPHERE_AVAILABLE: atmosphereShaderAvailable,
      COVERAGE_ONLY: false,
    });
    if (uncoloredUnlitVariant !== undefined) {
      seedShaderModule(
        `module-forgeax::default-unlit#${uncoloredUnlitVariant.definesKey}`,
        unlitModule,
      );
    }
    // feat-20260609 R3-fixup: eagerly compile shadow_caster module + seed
    // the lazy MaterialShader pipeline cache adapter so the first frame's
    // shadow PSO build (passKind='shadow-caster') hits OK without a
    // 1-frame warmup. T-009 deleted the hardcoded shadowCasterPipeline;
    // the lazy path replaces it but the adapter cache key
    // ('module-forgeax::default-shadow-caster') was previously unwarmed,
    // causing the first frame's createShaderModule to return
    // 'rhi-not-available' and the shadow PSO build to fail (which left
    // the shadow depth attachment unwritten). Optional: when the manifest
    // omits shadow_caster (legacy hosts), the lazy path simply falls
    // through to the existing 1-frame retry; no regression.
    if (shadowCasterEntry !== undefined) {
      const shadowCasterShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: shadowCasterEntry.wgsl,
                label: 'shadow_caster',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: shadowCasterEntry.wgsl,
                label: 'shadow_caster',
              }),
        'shader-compile-failed',
        'shadow_caster shader module compiled',
        'inspect manifest shadow_caster entry composed wgsl; check device.features',
      );
      if (!shadowCasterShaderResult.ok) throw shadowCasterShaderResult.error;
      // Seed the adapter cache under the same label
      // (`module-${materialShaderId}`) that getMaterialShaderPipeline
      // uses so the lazy build's createShaderModule call hits OK on
      // frame 1.
      seedShaderModule('module-forgeax::default-shadow-caster', shadowCasterShaderResult.value);
      // The shadow caster now has independent storage and skinning axes. The
      // canonical all-true entry remains the ordinary static source through
      // SKINNING_DISABLED=true; skinned meshes request the explicit false
      // variant. Prewarm both for the active storage capability so neither
      // path loses its first shadow frame to the lazy module retry contract.
      const shadowCasterManifestEntry = Array.from(registry.materialShaderManifestEntries()).find(
        (candidate) => candidate.identifier === 'forgeax::default-shadow-caster',
      );
      const activeShadowVariants = shadowCasterManifestEntry?.variants.filter(
        (variant) =>
          variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
          (!('ATMOSPHERE_AVAILABLE' in variant.defines) ||
            variant.defines.ATMOSPHERE_AVAILABLE === atmosphereShaderAvailable) &&
          typeof variant.defines.SKINNING_DISABLED === 'boolean',
      );
      for (const variant of activeShadowVariants ?? []) {
        if (variant.definesKey === '') {
          seedShaderModule(
            'module-forgeax::default-shadow-caster#',
            shadowCasterShaderResult.value,
          );
          continue;
        }
        const variantShaderResult = await runShimStep(
          () =>
            asyncCreateShaderModule
              ? asyncCreateShaderModule(rhiDevice, {
                  code: variant.composedWgsl,
                  label: `shadow_caster#${variant.definesKey}`,
                })
              : invokeDeviceCreateShaderModule(rhiDevice, {
                  code: variant.composedWgsl,
                  label: `shadow_caster#${variant.definesKey}`,
                }),
          'shader-compile-failed',
          `shadow_caster variant ${variant.definesKey || '<default>'} compiled`,
          'inspect the selected shadow_caster storage/skinning variant and device.features',
        );
        if (!variantShaderResult.ok) throw variantShaderResult.error;
        seedShaderModule(
          `module-forgeax::default-shadow-caster#${variant.definesKey}`,
          variantShaderResult.value,
        );
      }
    }

    // feat-20260621 M-A3 (D-5): register the built-in tonemap onto the unified
    // post-process channel instead of building a dedicated pipeline. The composed
    // tonemap WGSL (`tonemapEntry.wgsl`, @group(1) bindings after w16) becomes the
    // registered `entry.source`; fullscreen effect registration eager-creates the 16 B
    // params UBO (fail-fast). The empty-manifest path never reaches here (the
    // manifest triple guard above throws when tonemapEntry is undefined), so
    // registration is unconditional within this gate.
    //
    // Eager pre-warm (zero-regression): the dedicated tonemap pipeline used to be
    // built during `ready`, so tonemap rendered correctly on frame 1 with NO
    // event-loop yield. The unified `getPostProcessPipeline` lazy path otherwise
    // returns `rhi-not-available` until the async shader-compile promise resolves
    // -- a consumer driving `draw()` in a tight loop without an `await` between
    // frames (e.g. the hello-tonemap dawn smoke) would stall on a black frame
    // forever. Mirror the shadow_caster prewarm: await-compile the tonemap module
    // here and `seedShaderModule` it under the exact label
    // `buildPostProcessPipeline` requests (keyed by shader source), so the
    // first `getPostProcessPipeline(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, …)` hits the module cache
    // synchronously and builds the pipeline on frame 1.
    const tonemapPrewarm = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, {
              code: tonemapEntry.wgsl,
              label: postProcessShaderModuleLabel(tonemapEntry.wgsl),
            })
          : invokeDeviceCreateShaderModule(rhiDevice, {
              code: tonemapEntry.wgsl,
              label: postProcessShaderModuleLabel(tonemapEntry.wgsl),
            }),
      'shader-compile-failed',
      'tonemap shader module compiled (unified post-process prewarm)',
      'inspect manifest tonemap entry composed wgsl; check device.features',
    );
    if (!tonemapPrewarm.ok) throw tonemapPrewarm.error;
    seedShaderModule(postProcessShaderModuleLabel(tonemapEntry.wgsl), tonemapPrewarm.value);
    registerBuiltinTonemap(tonemapEntry.wgsl);

    // Prewarm temporal fullscreen modules before readiness so first-frame
    // recording cannot encounter an asynchronous compile miss.
    const prewarmTemporal = createTemporalShaderPrewarmer({
      device: rhiDevice,
      asyncCreateShaderModule,
      seedShaderModule,
    });
    const analyticFogEntry = findEngineManifestEntry('forgeax::analytic-fog');
    await prewarmTemporal(analyticFogEntry, 'forgeax.analytic-fog');
    if (analyticFogEntry !== undefined) registerBuiltinAnalyticFog(analyticFogEntry.wgsl);
    await prewarmTemporal(motionBlurEntry, 'forgeax.motion-blur');
    await prewarmTemporal(taaResolveEntry, 'forgeax.taa-resolve');
    await prewarmDepthOfField(manifestEntries, prewarmTemporal, registerBuiltinDepthOfField);
    registerBuiltinTemporalPostProcesses({
      ...(motionBlurEntry === undefined ? {} : { motionBlur: motionBlurEntry.wgsl }),
      ...(taaResolveEntry === undefined ? {} : { taaResolve: taaResolveEntry.wgsl }),
    });

    // feat-20260520-2d-sprite-layer-mvp M-3 / w24: sprite shader module
    // is optional in the 3-tuple legacy manifest (back-compat for apps
    // that locked their manifest URL before this feat). With the
    // vite-plugin-shader 4-entry surface (M-3 / w20), spriteEntry is
    // present and we build both LDR + HDR sprite pipeline variants.
    if (spriteEntry !== undefined) {
      const spriteShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: spriteEntry.wgsl, label: 'sprite' })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: spriteEntry.wgsl,
                label: 'sprite',
              }),
        'shader-compile-failed',
        'sprite shader module compiled',
        'inspect manifest sprite entry composed wgsl; check device.features',
      );
      if (!spriteShaderResult.ok) throw spriteShaderResult.error;
      spriteModule = spriteShaderResult.value;
      // feat-20260625-refactor-sprite-as-transparent-mesh CI-fix: seed the
      // lazy adapter cache under the same label (`module-forgeax::sprite`)
      // that `getMaterialShaderPipeline -> buildAndCachePipeline ->
      // buildPipelineForMaterialShader` uses, so the first lazy build of
      // the sprite PSO at LDR transparent-split time hits the module cache
      // on frame 1 and does NOT trip the 1-frame `rhi-not-available` skip
      // (which surfaces as `shader-compile-failed` "manifest entries
      // include sprite.wgsl" at the spritePH===null branch in
      // render-system-record.ts §spritePass). Mirrors the
      // `module-forgeax::default-shadow-caster` prewarm above; the pre-
      // feat-20260625 dedicated `spritePipeline` baked the module into a
      // boot-time PSO so this seed step was implicit. Post-w14 the sprite
      // shares the generic per-MaterialShader lazy build path, which now
      // needs the explicit seed to preserve frame-1 readiness.
      seedShaderModule('module-forgeax::sprite', spriteShaderResult.value);
      const spriteManifestEntry = Array.from(registry.materialShaderManifestEntries()).find(
        (entry) => entry.identifier === 'forgeax::sprite',
      );
      const regionVariant = selectBootVariant(spriteManifestEntry, {
        PER_INSTANCE_REGION: true,
        STORAGE_BUFFER_AVAILABLE: storageBufferCapable,
        ATMOSPHERE_AVAILABLE: atmosphereShaderAvailable,
      });
      if (regionVariant !== undefined) {
        const regionShaderResult = await runShimStep(
          () =>
            asyncCreateShaderModule
              ? asyncCreateShaderModule(rhiDevice, {
                  code: regionVariant.composedWgsl,
                  label: `sprite#${regionVariant.definesKey}`,
                })
              : invokeDeviceCreateShaderModule(rhiDevice, {
                  code: regionVariant.composedWgsl,
                  label: `sprite#${regionVariant.definesKey}`,
                }),
          'shader-compile-failed',
          `sprite variant ${regionVariant.definesKey || '<default>'} compiled`,
          'inspect the selected sprite PER_INSTANCE_REGION variant and device.features',
        );
        if (!regionShaderResult.ok) throw regionShaderResult.error;
        seedShaderModule(
          `module-forgeax::sprite#${regionVariant.definesKey}`,
          regionShaderResult.value,
        );
      }
    }

    // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
    // sprite-lit shader module — mirrors sprite registration shape (same
    // lazy-build seed under `module-forgeax::sprite-lit`). Optional in the
    // manifest (back-compat for apps locked to a pre-sprite-lit manifest URL).
    if (spriteLitEntry !== undefined) {
      // Seed the same capability-adjusted source that the lazy pipeline uses;
      // otherwise its shared module label retains unavailable cloud bindings.
      const spriteLitSource = prepareLowLimitMaterialShaderEntry(
        { source: spriteLitEntry.wgsl },
        rhiDevice.limits.maxSampledTexturesPerShaderStage,
      ).source;
      const spriteLitShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: spriteLitSource,
                label: 'sprite-lit',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: spriteLitSource,
                label: 'sprite-lit',
              }),
        'shader-compile-failed',
        'sprite-lit shader module compiled',
        'inspect manifest sprite-lit entry composed wgsl; check device.features',
      );
      if (!spriteLitShaderResult.ok) throw spriteLitShaderResult.error;
      spriteLitModule = spriteLitShaderResult.value;
      seedShaderModule('module-forgeax::sprite-lit', spriteLitShaderResult.value);
      // Sprite-lit selects its Standard capability variant at record time.
      // Warm every device-matched variant before initialization resolves so a
      // tight smoke/browser frame loop can build the selected PSO synchronously.
      const spriteLitManifestEntry = Array.from(registry.materialShaderManifestEntries()).find(
        (entry) => entry.identifier === 'forgeax::sprite-lit',
      );
      const prewarmedSpriteLitModules = new Map<string, ShaderModule>([
        [spriteLitSource, spriteLitShaderResult.value],
      ]);
      for (const variant of spriteLitManifestEntry?.variants ?? []) {
        if (variant.defines.STORAGE_BUFFER_AVAILABLE !== storageBufferCapable) continue;
        if (
          'ATMOSPHERE_AVAILABLE' in variant.defines &&
          variant.defines.ATMOSPHERE_AVAILABLE !== atmosphereShaderAvailable
        )
          continue;
        const moduleLabel = `module-forgeax::sprite-lit#${variant.definesKey}`;
        const variantSource = prepareLowLimitMaterialShaderEntry(
          { source: variant.composedWgsl },
          rhiDevice.limits.maxSampledTexturesPerShaderStage,
        ).source;
        let variantModule = prewarmedSpriteLitModules.get(variantSource);
        if (variantModule === undefined) {
          const variantResult = await runShimStep(
            () =>
              asyncCreateShaderModule
                ? asyncCreateShaderModule(rhiDevice, {
                    code: variantSource,
                    label: moduleLabel,
                  })
                : invokeDeviceCreateShaderModule(rhiDevice, {
                    code: variantSource,
                    label: moduleLabel,
                  }),
            'shader-compile-failed',
            `sprite-lit variant ${variant.definesKey || '<default>'} compiled`,
            'inspect the selected sprite-lit Standard capability variant and device.features',
          );
          if (!variantResult.ok) throw variantResult.error;
          variantModule = variantResult.value;
          prewarmedSpriteLitModules.set(variantSource, variantModule);
        }
        seedShaderModule(moduleLabel, variantModule);
      }
    }

    // feat-20260528-fxaa-post-processing: fxaa shader module is optional
    // (apps with legacy manifests without fxaa.wgsl continue to boot).
    // Identified by rgb2luma content marker (plan-strategy D-5). When
    // present, the module is compiled here; pipeline construction happens
    // alongside the tonemap pipeline below (step 2 prebuild).
    if (fxaaEntry !== undefined) {
      const fxaaShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: fxaaEntry.wgsl, label: 'fxaa' })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: fxaaEntry.wgsl,
                label: 'fxaa',
              }),
        'shader-compile-failed',
        'fxaa shader module compiled',
        'inspect manifest fxaa entry composed wgsl; check device.features',
      );
      if (!fxaaShaderResult.ok) throw fxaaShaderResult.error;
      fxaaModule = fxaaShaderResult.value;
      registerBuiltinFxaa(fxaaEntry.wgsl);
      // The typed graph may need a second FXAA pipeline for a graph-owned
      // linear-LDR target (for example BarrelDistortion + FXAA). Seed the
      // shared post-process adapter with the already compiled module so that
      // this alternate color format is available on the first submitted
      // frame instead of waiting for an async recompile.
      seedShaderModule(postProcessShaderModuleLabel(fxaaEntry.wgsl), fxaaModule);
    }

    // feat-20260531-skybox-env-background M3 / w15: skybox shader module.
    // Optional (apps with legacy manifests without skybox.wgsl continue to
    // boot). Identified by skybox_fs content marker (plan-strategy D-7).
    // Compiled here; pipeline construction happens alongside tonemap/fxaa
    // in step 2 prebuild below.
    if (skyboxEntry !== undefined) {
      const skyboxShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: skyboxEntry.wgsl, label: 'skybox' })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: skyboxEntry.wgsl,
                label: 'skybox',
              }),
        'shader-compile-failed',
        'skybox shader module compiled',
        'inspect manifest skybox entry composed wgsl; check device.features',
      );
      if (!skyboxShaderResult.ok) throw skyboxShaderResult.error;
      skyboxModule = skyboxShaderResult.value;
    }

    // Bloom shader modules remain available to the lazy Bloom pipeline owner.
    // Their construction is still part of renderer readiness because the
    // backend may expose only an asynchronous module factory; the expensive
    // pipeline, binding, and parameter resources stay deferred until admission.
    if (bloomHorizontalEntry !== undefined) {
      const result = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: bloomHorizontalEntry.wgsl,
                label: 'bloom-horizontal',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: bloomHorizontalEntry.wgsl,
                label: 'bloom-horizontal',
              }),
        'shader-compile-failed',
        'bloom-horizontal shader module compiled',
        'inspect manifest bloom-horizontal entry composed wgsl; check device.features',
      );
      if (!result.ok) throw result.error;
      bloomHorizontalModule = result.value;
    }
    if (bloomVerticalEntry !== undefined) {
      const result = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: bloomVerticalEntry.wgsl,
                label: 'bloom-vertical',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: bloomVerticalEntry.wgsl,
                label: 'bloom-vertical',
              }),
        'shader-compile-failed',
        'bloom-vertical shader module compiled',
        'inspect manifest bloom-vertical entry composed wgsl; check device.features',
      );
      if (!result.ok) throw result.error;
      bloomVerticalModule = result.value;
    }
    if (bloomCompositeEntry !== undefined) {
      const result = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: bloomCompositeEntry.wgsl,
                label: 'bloom-composite',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: bloomCompositeEntry.wgsl,
                label: 'bloom-composite',
              }),
        'shader-compile-failed',
        'bloom-composite shader module compiled',
        'inspect manifest bloom-composite entry composed wgsl; check device.features',
      );
      if (!result.ok) throw result.error;
      bloomCompositeModule = result.value;
    }
    // feat-20260612-hdrp-ssao M6 / w27: SSAO shader module compilation.
    // Optional manifest entry — absent on legacy manifests (zero-overhead
    // opt-out, same as bloom). Identified by 'fs_ssao_calc' content marker.
    // The GLES translator cannot read raw depth through this SSAO program.
    // Keep optional AO out of fallback startup; requesting it is refused by
    // the record owner instead of breaking every AO-disabled renderer.
    if (ssaoEntry !== undefined && !webgl2Downlevel) {
      const entry = ssaoEntry;
      const ssaoShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: entry.wgsl,
                label: 'hdrp-ssao',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: entry.wgsl,
                label: 'hdrp-ssao',
              }),
        'shader-compile-failed',
        'hdrp-ssao shader module compiled',
        'inspect manifest hdrp-ssao entry composed wgsl; check device.features',
      );
      if (!ssaoShaderResult.ok) throw ssaoShaderResult.error;
      ssaoModule = ssaoShaderResult.value;
    }
  }

  // feat-20260520-skylight-ibl-cubemap M4 round-4 / t59: the PBR pipeline
  // layout construction migrated to `pbr-pipeline.ts buildPbrPipelineLayouts`.
  // The factory builds 4 BindGroupLayouts (view + material + mesh-array +
  // instances) and the 4-slot pipeline layout in one call, throwing on each
  // device.createBindGroupLayout / device.createPipelineLayout failure.
  // material BGL now carries 24 entries (canonical material 0..14 + Skylight
  // 15..20 + transmission 21..22); authored physical maps append after the
  // engine-owned injections. The pipeline layout itself stays at 4 slots, no
  // @group(4) allocated (D-5 round-4 fix for the round-2 maxBindGroups=4
  // BLOCKER). The standalone unlit BGL is the 15-entry user region exposed by
  // `buildUnlitMaterialBgl`; the shared boot path keeps its own fallback
  // resources at the material slot.
  //
  // feat-20260520-directional-light-shadow-mapping merge: view BGL entries
  // include binding(3) shadowMap + binding(4) comparison sampler (extended
  // in `buildPbrViewBglEntries`); the shadow caster pipeline + shadow RT
  // remain owned by createRenderer below, but the layout is shared.
  // bug-20260610: storageBufferCapable is hoisted to the top of
  // buildReadyWebGPU (above) so Step 2 (variant patch) and this layout
  // build read the same value.
  const pbrLayouts = runShimSyncStep(
    () =>
      ok(
        buildPbrPipelineLayouts(rhiDevice, {
          storageBuffer: storageBufferCapable,
          extendedLighting: extendedLightingShaderAvailable,
          atmosphere: atmosphereShaderAvailable,
          projectorAvailable,
          transmissionBackdrop: transmissionBackdropAvailable(
            rhiDevice.limits.maxSampledTexturesPerShaderStage,
          ),
        }),
      ),
    'webgpu-runtime-error',
    'buildPbrPipelineLayouts succeeded',
    'check device.limits.maxBindingsPerBindGroup (need >=14) and maxBindGroupsPerPipelineLayout',
  );
  if (!pbrLayouts.ok) throw pbrLayouts.error;
  const viewBglResult = ok(pbrLayouts.value.viewBgl);
  const materialBglResult = ok(pbrLayouts.value.materialBgl);
  const meshArrayBglResult = ok(pbrLayouts.value.meshArrayBgl);
  const instancesBglResult = ok(pbrLayouts.value.instancesBgl);
  const probeInstancesBglResult = ok(pbrLayouts.value.probeInstancesBgl);
  const pipelineLayoutResult = ok(pbrLayouts.value.pipelineLayout);
  const unlitMaterialLayout = rhiDevice
    .createBindGroupLayout(
      buildBindGroupLayoutDescriptor(
        {
          shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
          attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
          geometry: { topology: 'triangle-list', vertexLayout: {} },
          renderState: undefined,
        },
        {
          kind: 'pbr-material-merged',
          registry,
          materialParamSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
          caps: {
            storageBuffer: storageBufferCapable,
            transmissionBackdrop: transmissionBackdropAvailable(
              rhiDevice.limits.maxSampledTexturesPerShaderStage,
            ),
          },
        },
      ),
    )
    .unwrap();
  const unlitPipelineLayout = rhiDevice
    .createPipelineLayout({
      label: 'unlit-pipeline-layout',
      bindGroupLayouts: [
        viewBglResult.value,
        unlitMaterialLayout,
        meshArrayBglResult.value,
        instancesBglResult.value,
      ],
    })
    .unwrap();

  // feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w36 (D-10 option A):
  // boot-time build of the HDRP-variant PipelineLayout. The 4-BGL chain is
  // [view, material, hdrp-unified-7-slot, instances]; the HDRP unified BGL
  // (createHdrpBindGroupLayoutDescriptor) replaces the 1-slot pbr-mesh-array
  // BGL at group(2) so an HDRP-variant PSO validates against the 7-slot
  // group(2) bindGroup that the record stage sets via hdrpClusterBindGroup.
  // Stays null when createBindGroupLayout / createPipelineLayout fails;
  // selectPipelineLayoutForVariant gracefully falls back to pbrPipelineLayout
  // (URP layout) so the manifest entry's URP variant WGSL still builds a
  // valid PSO instead of hard-disabling the entire HDRP-variant build path.
  let hdrpPbrPipelineLayoutHandle: PipelineLayout | null = null;
  let hdrpMeshBindGroupLayoutHandle: BindGroupLayout | null = null;
  let hdrpProbePbrPipelineLayoutHandle: PipelineLayout | null = null;
  let hdrpUnifiedBglHandle: BindGroupLayout | null = null;
  {
    const hdrpUnifiedBglDesc = createHdrpBindGroupLayoutDescriptor(storageBufferCapable);
    const hdrpUnifiedBglRes = rhiDevice.createBindGroupLayout(hdrpUnifiedBglDesc);
    if (hdrpUnifiedBglRes.ok) {
      hdrpUnifiedBglHandle = hdrpUnifiedBglRes.value;
      hdrpMeshBindGroupLayoutHandle = hdrpUnifiedBglRes.value;
      const hdrpPlRes = rhiDevice.createPipelineLayout({
        label: 'hdrp-pbr-pl',
        bindGroupLayouts: [
          viewBglResult.value,
          materialBglResult.value,
          hdrpUnifiedBglRes.value,
          instancesBglResult.value,
        ],
      });
      if (hdrpPlRes.ok) {
        hdrpPbrPipelineLayoutHandle = hdrpPlRes.value;
      }
      if (storageBufferCapable) {
        const hdrpProbePlRes = rhiDevice.createPipelineLayout({
          label: 'hdrp-probe-pbr-pl',
          bindGroupLayouts: [
            viewBglResult.value,
            materialBglResult.value,
            hdrpUnifiedBglRes.value,
            probeInstancesBglResult.value,
          ],
        });
        if (hdrpProbePlRes.ok) hdrpProbePbrPipelineLayoutHandle = hdrpProbePlRes.value;
      }
    }
  }

  const { hdrpClusterMembershipPipeline, hdrpClusterMembershipBindGroupLayout } =
    await buildClusterMembershipProducer(
      rhiDevice,
      storageBufferCapable && pbrModule !== null && unlitModule !== null,
      asyncCreateShaderModule,
    );

  const {
    hdrpSkinPipelineLayout: hdrpSkinPipelineLayoutHandle,
    hdrpSkinProbePipelineLayout: hdrpSkinProbePipelineLayoutHandle,
    hdrpSkinMeshBindGroupLayout: hdrpSkinMeshBindGroupLayoutHandle,
    pbrSkinPipelineLayout: pbrSkinPipelineLayoutHandle,
    pbrSkinProbePipelineLayout: pbrSkinProbePipelineLayoutHandle,
    pbrSkinMeshBindGroupLayout: pbrSkinMeshBindGroupLayoutHandle,
    gpuDrivenInstancesBindGroupLayout: gpuDrivenInstancesBindGroupLayoutHandle,
    gpuDrivenPbrPipelineLayout: gpuDrivenPbrPipelineLayoutHandle,
    gpuDrivenPbrSkinPipelineLayout: gpuDrivenPbrSkinPipelineLayoutHandle,
    surfaceDirectInstancesBindGroupLayout: surfaceDirectInstancesBindGroupLayoutHandle,
  } = buildGpuDrivenPbrReadyLayouts(rhiDevice, storageBufferCapable, pbrLayouts.value);
  // GPU-driven Standard batches use the compact scene-index slot(3) while
  // retaining the same clustered group(2) bind group that the ordinary main
  // pass publishes. Build a matching pipeline layout from those exact
  // producer-owned layouts; a separate URP mesh-array layout would validate
  // the indirect draw but reject its clustered bind group at encode time.
  let gpuDrivenClusterPbrPipelineLayoutHandle: PipelineLayout | null = null;
  let gpuDrivenClusterPbrSkinPipelineLayoutHandle: PipelineLayout | null = null;
  if (
    storageBufferCapable &&
    hdrpUnifiedBglHandle !== null &&
    gpuDrivenInstancesBindGroupLayoutHandle !== null
  ) {
    const rigidResult = rhiDevice.createPipelineLayout({
      label: 'pbr-gpu-driven-cluster-pl',
      bindGroupLayouts: [
        viewBglResult.value,
        materialBglResult.value,
        hdrpUnifiedBglHandle,
        gpuDrivenInstancesBindGroupLayoutHandle,
      ],
    });
    if (rigidResult.ok) gpuDrivenClusterPbrPipelineLayoutHandle = rigidResult.value;
  }
  if (
    storageBufferCapable &&
    hdrpSkinMeshBindGroupLayoutHandle !== null &&
    gpuDrivenInstancesBindGroupLayoutHandle !== null
  ) {
    const skinResult = rhiDevice.createPipelineLayout({
      label: 'pbr-skin-gpu-driven-cluster-pl',
      bindGroupLayouts: [
        viewBglResult.value,
        materialBglResult.value,
        hdrpSkinMeshBindGroupLayoutHandle,
        gpuDrivenInstancesBindGroupLayoutHandle,
      ],
    });
    if (skinResult.ok) gpuDrivenClusterPbrSkinPipelineLayoutHandle = skinResult.value;
  }

  // The allocator owns one palette buffer, grown lazily by frame preparation.
  // Its capacity follows the device's full binding-size limit: the 16320-byte
  // per-draw window is only one entity's range within the shared buffer.
  // Storage and uniform devices therefore use their respective binding limits.
  const skinPaletteAllocatorHandle: SkinPaletteAllocator = createSkinPaletteOwner(
    rhiDevice,
    storageBufferCapable,
  );

  const queue = rhiDevice.queue;

  // ── Step 3.b: per-pipeline shared UBO / SSBO buffers ──────────────────────
  // The 3 BindGroups (view / material / mesh) the pbr.wgsl pipeline expects
  // are built per draw(world) frame in render-system.ts; the underlying
  // buffers are pipeline-scoped (allocated once, queue.writeBuffer-updated
  // per frame). The mesh storage path uses a runtime-sized
  // array<Mesh> bound up to instanceCount * 64 B per draw
  // (feat-20260511-tetris-retro-followups M4 D-P9); the buffer is initially
  // sized for INITIAL_MESH_SSBO_SLOT_COUNT = 1024 slots and grows on demand
  // via `meshSsboController.growMeshSsbo(neededSlots)` (M2 / T-M2-05;
  // pow2 doubling, ceiling = device.limits.maxStorageBufferBindingSize).
  const viewUboResult = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label: 'pbr-view-ubo',
        size: VIEW_UBO_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (view ubo) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
  if (!viewUboResult.ok) throw viewUboResult.error;

  const pointsLinesView = createPointsLinesViewBuffer(rhiDevice, rendererScope);

  // feat-20260613-csm-cascaded-shadow-maps M5 / w28: per-pass cascade-index
  // UBO consumed by shadow_caster.wgsl. Stable singleton; the record stage
  // queue.writeBuffer-overwrites the fields immediately before each pass's
  // command-encoder submit, and the per-pass submits serialize host writes
  // against GPU reads.
  //
  // feat-20260625-spot-light-shadow-mapping M2 / w10 + w11 (D-1): grew 16 -> 80
  // B. First 16 B carry `index` u32 + `isSpot` u32 + 2 pad u32 (keeps the
  // mat4 16 B-aligned for WebGL2); the trailing 64 B carry `spotLightViewProj`
  // mat4x4<f32>, written per spot tile pass by recordSpotShadowPass and read by
  // the shadow_caster spot branch. Directional cascade passes leave isSpot=0
  // and ignore the matrix lanes.
  const shadowCasterCascadeUboResult = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label: 'shadow-caster-cascade-ubo',
        size: SHADOW_CASTER_BUFFER_SIZE,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (shadow-caster cascade ubo) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
  if (!shadowCasterCascadeUboResult.ok) throw shadowCasterCascadeUboResult.error;
  // This existing owner also serves per-view buffers. Uniform-only bindings
  // use bounded physical pages; storage-capable draws keep their shared arena.
  // Its candidate scope owns allocation rollback and generation retirement.
  const meshSsboGrowDeviceAdapter: MeshSsboGrowDevice = {
    limits: rhiDevice.limits,
    createBuffer: (descriptor) => {
      const result = rhiDevice.createBuffer(descriptor);
      if (!result.ok) throw result.error;
      return result.value;
    },
    destroyBuffer: (buffer) => {
      const result = rhiDevice.destroyBuffer(buffer);
      if (!result.ok) errorRegistry.fire(result.error);
    },
  };
  const meshSsboController = createMeshSsboGrowController({
    device: meshSsboGrowDeviceAdapter,
    scope: rendererScope,
    meshStride: MESH_PER_ENTITY_STRIDE,
    meshBindingSize: storageBufferCapable ? MESH_PER_ENTITY_STRIDE : MESH_UBO_FULL_ARRAY_BYTES,
    materialBindingSize: MATERIAL_UNIFORM_BYTES,
    uniformPages: !storageBufferCapable,
    errorRegistry: errorRegistry,
    initialSlotCount: INITIAL_MESH_SSBO_SLOT_COUNT,
    materialStride: MATERIAL_PER_ENTITY_STRIDE,
    // bug-20260610: WebGL2 fallback uses uniform-buffer for the mesh array
    // (matches the STORAGE_BUFFER_AVAILABLE=false shader variant which
    // declares `var<uniform> meshes : array<Mesh, 128>` instead of
    // `var<storage> meshes : array<Mesh>`).
    meshUsage: storageBufferCapable
      ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
      : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    materialUsage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const initialBuildResult = runShimSyncStep<true>(
    () => {
      meshSsboController.initialBuild();
      return ok(true as const);
    },
    'webgpu-runtime-error',
    'createBuffer (mesh ssbo + material ubo initial build) succeeded',
    'check device.limits.maxStorageBufferBindingSize / maxUniformBufferBindingSize',
  );
  if (!initialBuildResult.ok) throw initialBuildResult.error;
  const meshSsboState = meshSsboController.state;
  requireMeshSsboBuffer(meshSsboState.mesh);
  requireMeshSsboBuffer(meshSsboState.material);
  // Expose the grow hook + state on internals (via the setGrowMeshSsboHook
  // callback) so M3's record stage `ensureMeshSsboCapacity` can call it
  // (T-M2-05 acceptanceCheck #3 + T-M3-04 wiring: `growMeshSsbo` mention
  // count >= 2 in createRenderer.ts — definition + this exposure).
  setGrowMeshSsboHook(meshSsboController.growMeshSsbo, meshSsboController.state);

  // feat-20260513-instanced-mesh M3 (T-M3-2): identity-mat4 fallback
  // storage buffer. Single 64-byte storage buffer carrying one identity
  // mat4 column-major. Renderables without an `Instances` component bind
  // this buffer at @group(3) so the shader's
  // `instances_local[instance_index]` lookup at idx=0 returns I (no
  // additional transform), giving the consistent-abstraction single
  // branch (charter prop 5; plan D-7 fallback semantics). The buffer is
  // seeded once at pipeline creation; the record-stage never rewrites
  // it.
  // bug-20260610: WebGL2 fallback uses uniform-buffer for instances
  // (the shader's `STORAGE_BUFFER_AVAILABLE=false` variant declares
  // `var<uniform> instances : array<InstanceData, 128>`).
  //
  // fix: the shared identity instance buffer is bound at @group(3) for EVERY
  // pipeline variant that lacks per-entity Instances, including the sprite
  // `PER_INSTANCE_REGION=true` variant whose InstanceData is 80 bytes
  // (mat4 64B + region vec4 16B) rather than the base PBR 64B (mat4 only).
  // The transparent split pass reaches that 80B-min-binding pipeline as soon
  // as transparent geometry exists (e.g. a glTF alphaMode=BLEND material),
  // and a 64B buffer fails WebGPU's min-binding-size validation
  // ("requires a buffer binding which is at least 80 bytes"), invalidating the
  // frame's command buffer. Size the shared identity buffer to the largest
  // InstanceData variant (80B) so it satisfies both the 64B PBR and 80B
  // sprite-region layouts; the extra 16 region bytes stay zeroed (a valid
  // empty UV region) and the PBR shader never reads past its mat4.
  const IDENTITY_INSTANCE_BYTES = storageBufferCapable ? 128 : 80 * 128;
  const identityInstanceResult = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label: 'pbr-identity-instance-ssbo',
        size: IDENTITY_INSTANCE_BYTES,
        usage: storageBufferCapable
          ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
          : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (identity instance ssbo) succeeded',
    'check device.limits.maxStorageBufferBindingSize',
  );
  if (!identityInstanceResult.ok) throw identityInstanceResult.error;
  // Seed the identity mat4 (column-major; diagonal 1s). Storage-backed
  // InstanceData carries current + previous transforms, so mirror the mat4
  // into both slots; uniform-backed variants consume only the first slot.
  const identityPayload = new Float32Array(storageBufferCapable ? 32 : 16);
  for (const base of storageBufferCapable ? [0, 16] : [0]) {
    identityPayload[base] = 1;
    identityPayload[base + 5] = 1;
    identityPayload[base + 10] = 1;
    identityPayload[base + 15] = 1;
  }
  const identityWrite = runShimSyncStep(
    () => queue.writeBuffer(identityInstanceResult.value, 0, identityPayload),
    'queue-write-buffer-out-of-bounds',
    'queue.writeBuffer (identity instance ssbo) succeeded',
    'verify offset alignment and bounds against buffer.size',
  );
  if (!identityWrite.ok) throw identityWrite.error;

  // feat-20260515 M3 / T-M3-05 (research F-6 fix): default sampler + fallback
  // 1x1 white texture seed the materialBindGroup sampler / textureView
  // entries when MaterialAsset.baseColorTexture is undefined. Default
  // sampler matches research F-5 SSOT three-source convergence (linear
  // min/mag/mipmap; repeat addressMode); the fallback texture is a 1x1
  // RGBA8 white pixel so unlit / standard materials with no texture
  // multiply by 1 in M5 once UV-driven sampling lands.
  const defaultSamplerResult = runShimSyncStep(
    () =>
      rhiDevice.createSampler({
        label: 'default-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      }),
    'webgpu-runtime-error',
    'createSampler (default) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!defaultSamplerResult.ok) throw defaultSamplerResult.error;

  // r32float Surface raw-depth views are unfilterable. Keep their sampler
  // distinct from the filtering material sampler so WebGPU's sample-type
  // validation remains explicit at the material BGL boundary.
  const surfaceMediumDepthSamplerResult = runShimSyncStep(
    () =>
      rhiDevice.createSampler({
        label: 'surface-medium-depth-sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    'webgpu-runtime-error',
    'createSampler (single-layer medium raw depth) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!surfaceMediumDepthSamplerResult.ok) throw surfaceMediumDepthSamplerResult.error;

  // feat-20260520-directional-light-shadow-mapping M1c / w8 + M2 / w14:
  // shadow comparison sampler — clamp-to-edge, linear filter, compare:'greater'.
  // Used for shadow map sampling in M2/M3 and shadow depth pass. comparison
  // sampler enables textureSampleCompareLevel in pbr.wgsl's evalDirectional().
  // Created once at pipeline build time; reused across frames.
  const shadowSamplerResult = runShimSyncStep(
    () =>
      rhiDevice.createSampler({
        label: 'shadow-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        compare: 'greater-equal',
      }),
    'webgpu-runtime-error',
    'createSampler (shadow) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!shadowSamplerResult.ok) throw shadowSamplerResult.error;

  const fallbackTextureDescriptor = texelFallbackDescriptor('fallback-white-1x1', 'rgba8unorm');
  const fallbackTextureResult = runShimSyncStep(
    () => createPersistentTexture(fallbackTextureDescriptor),
    'webgpu-runtime-error',
    'createTexture (fallback white) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!fallbackTextureResult.ok) throw fallbackTextureResult.error;
  const fallbackWriteResult = runShimSyncStep(
    () =>
      writeTexelFallback(
        queue,
        fallbackTextureResult.value,
        fallbackTextureDescriptor,
        new Uint8Array([255, 255, 255, 255]),
      ),
    'queue-write-buffer-out-of-bounds',
    'queue.writeTexture (fallback white pixel) succeeded',
    'verify bytesPerRow / rowsPerImage alignment',
  );
  if (!fallbackWriteResult.ok) throw fallbackWriteResult.error;

  const fallbackTextureViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(fallbackTextureResult.value, {
        label: 'fallback-white-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (fallback white) succeeded',
    'check fallback texture format / usage',
  );
  if (!fallbackTextureViewResult.ok) throw fallbackTextureViewResult.error;

  const extendedLightingFallback = createExtendedLightingFallbackResources(
    {
      createBuffer: createPersistentBuffer,
      createTexture: createPersistentTexture,
      createTextureView: rhiDevice.createTextureView.bind(rhiDevice),
      queue: rhiDevice.queue,
    },
    extendedLightingShaderAvailable,
  );

  // A declared normal map that is not ready needs an exactly neutral sample.
  // RGBA8 cannot encode 0.5: 128/255 perturbs the reflected ray even on a
  // perfectly flat surface. Half float stores (0.5, 0.5, 1, 1) exactly.
  // Cannot share the white fallback (255,255,...) because RG=(255,255)=1.0
  // gives tangent.xy=(1,1) -> 1 - 2 = -1 under the sqrt -> NaN (saturate
  // clamps to 0 z=0, still wrong). White-on-missing semantics for baseColor
  // / metallicRoughness slots is preserved by keeping those bound to the
  // shared fallbackTextureView; only the normal slot uses this view.
  const fallbackNormalTextureDescriptor = texelFallbackDescriptor(
    'fallback-normal-1x1',
    'rgba16float',
  );
  const fallbackNormalTextureResult = runShimSyncStep(
    () => createPersistentTexture(fallbackNormalTextureDescriptor),
    'webgpu-runtime-error',
    'createTexture (fallback normal) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!fallbackNormalTextureResult.ok) throw fallbackNormalTextureResult.error;
  const fallbackNormalTexel = new Uint16Array([0x3800, 0x3800, 0x3c00, 0x3c00]);
  const fallbackNormalWriteResult = runShimSyncStep(
    () =>
      writeTexelFallback(
        queue,
        fallbackNormalTextureResult.value,
        fallbackNormalTextureDescriptor,
        fallbackNormalTexel,
      ),
    'queue-write-buffer-out-of-bounds',
    'queue.writeTexture (fallback normal pixel) succeeded',
    'verify bytesPerRow / rowsPerImage alignment',
  );
  if (!fallbackNormalWriteResult.ok) throw fallbackNormalWriteResult.error;

  const fallbackNormalTextureViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(fallbackNormalTextureResult.value, {
        label: 'fallback-normal-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (fallback normal) succeeded',
    'check fallback normal texture format / usage',
  );
  if (!fallbackNormalTextureViewResult.ok) throw fallbackNormalTextureViewResult.error;

  // feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1):
  // shadowFallbackTextureView is a 1x1 depth32float 2D fallback for scene
  // depth consumers; the shadow bindings use the depth-array fallback below.
  // Cleared to 1.0 (far plane) via a minimal render pass so
  // textureSampleCompareLevel always returns 1.0 (fully lit).
  // Uses RENDER_ATTACHMENT for the clear pass + TEXTURE_BINDING for sampling.
  const shadowFallbackTexResult = runShimSyncStep(
    () =>
      createPersistentTexture({
        label: 'shadow-fallback-depth-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    'webgpu-runtime-error',
    'createTexture (shadow fallback depth) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!shadowFallbackTexResult.ok) throw shadowFallbackTexResult.error;

  const shadowFallbackViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(shadowFallbackTexResult.value, {
        label: 'shadow-fallback-depth-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow fallback depth) succeeded',
    'check shadow fallback texture format / usage',
  );
  if (!shadowFallbackViewResult.ok) throw shadowFallbackViewResult.error;

  // Clear the 1x1 depth fallback to 1.0 (far plane) via a 1-pixel render pass.
  const shadowFallbackClearEncResult = rhiDevice.createCommandEncoder({
    label: 'shadow-fallback-clear-encoder',
  });
  if (!shadowFallbackClearEncResult.ok) throw shadowFallbackClearEncResult.error;
  const shadowFallbackPass = shadowFallbackClearEncResult.value.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: shadowFallbackViewResult.value,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  } as never);
  shadowFallbackPass.end();
  const shadowFallbackClearFinish = shadowFallbackClearEncResult.value.finish();
  if (!shadowFallbackClearFinish.ok) throw shadowFallbackClearFinish.error;
  const shadowFallbackClearSubmit = queue.submit([shadowFallbackClearFinish.value]);
  if (!shadowFallbackClearSubmit.ok) throw shadowFallbackClearSubmit.error;

  const shadowArrayFallbackTextureView = createShadowArrayFallbackView(
    rhiDevice,
    createPersistentTexture,
  );
  const layeredTextureFallback = createLayeredTextureFallbackViews(
    rhiDevice,
    createPersistentTexture,
  );

  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 1x1x6
  // depth32float cube_array fallback bound at viewBindGroup entry 5 when no
  // PointLightShadow snapshots are active. dimension: '2d' with
  // depthOrArrayLayers: 6 produces a 6-layer 2D array that
  // `dimension: 'cube-array'` views can target (one cube, layers=1). The
  // texture is cleared to depth=1.0 (far plane) so
  // textureSampleCompareLevel always returns 1.0 (fully lit) regardless of
  // the depthRef the shader passes. AC-09 zero-allocation invariant
  // preserved: the real cube_array atlas in ShadowAtlas is still
  // lazy-allocated (the fallback is always created, but it only takes 24
  // bytes of GPU memory).
  const shadowAtlasFallbackTexResult = runShimSyncStep(
    () =>
      createPersistentTexture({
        label: 'shadow-atlas-fallback-cube-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 6 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: 'cube',
      }),
    'webgpu-runtime-error',
    'createTexture (shadow atlas fallback cube) succeeded',
    'check device.limits.maxTextureDimension2D and cube-array support',
  );
  if (!shadowAtlasFallbackTexResult.ok) throw shadowAtlasFallbackTexResult.error;

  const shadowAtlasFallbackViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(shadowAtlasFallbackTexResult.value, {
        label: 'shadow-atlas-fallback-cube-array-view',
        dimension: 'cube-array',
        aspect: 'depth-only',
        baseArrayLayer: 0,
        arrayLayerCount: 6,
        baseMipLevel: 0,
        mipLevelCount: 1,
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow atlas fallback cube-array) succeeded',
    'check shadow atlas fallback texture format / usage / dimension',
  );
  if (!shadowAtlasFallbackViewResult.ok) throw shadowAtlasFallbackViewResult.error;

  // Clear all 6 fallback faces to 1.0 (far plane). One pass per face
  // (WebGPU forbids cube views as render-pass attachments; per-face 2D view
  // is required).
  for (let face = 0; face < 6; face++) {
    const faceViewRes = runShimSyncStep(
      () =>
        rhiDevice.createTextureView(shadowAtlasFallbackTexResult.value, {
          label: `shadow-atlas-fallback-face-${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      'webgpu-runtime-error',
      `createTextureView (shadow atlas fallback face ${face}) succeeded`,
      'check shadow atlas fallback texture format / usage',
    );
    if (!faceViewRes.ok) throw faceViewRes.error;
    const encRes = rhiDevice.createCommandEncoder({
      label: `shadow-atlas-fallback-clear-encoder-face-${face}`,
    });
    if (!encRes.ok) throw encRes.error;
    const pass = encRes.value.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: faceViewRes.value,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as never);
    pass.end();
    const finRes = encRes.value.finish();
    if (!finRes.ok) throw finRes.error;
    const subRes = queue.submit([finRes.value]);
    if (!subRes.ok) throw subRes.error;
  }

  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: shadowParams
  // uniform buffer = `array<vec4<f32>, 4>` (4 lanes x 16 B = 64 B). One
  // lane per PointLightShadow slot (cap = 4). Each lane stores
  // `(near, far, 1/(far-near), 0)` for depth-ref reconstruction in
  // lighting-punctual.wgsl evalPointShadowed. Written per frame in the
  // record stage from `frameState.pointShadowSnapshots`. Initial contents
  // are zero (writeBuffer at create time is implicit per spec); zero lanes
  // are safe because the WGSL sample path is gated on
  // `PointLight.shadowAtlasLayer >= 0` -- a non-shadow-casting light
  // cannot read its lane.
  const shadowParamsBufferResult = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label: 'shadow-params-ubo',
        size: SHADOW_PARAMS_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (shadow params UBO) succeeded',
    'check device.limits.maxUniformBufferBindingSize (need >= 256)',
  );
  if (!shadowParamsBufferResult.ok) throw shadowParamsBufferResult.error;
  // Zero-initialize the buffer so the no-shadow path reads deterministic
  // zeros across every Point/Spot control lane.
  const SHADOW_PARAMS_ZEROES = new Uint8Array(SHADOW_PARAMS_BYTES);
  const shadowParamsZeroWriteRes = queue.writeBuffer(
    shadowParamsBufferResult.value,
    0,
    SHADOW_PARAMS_ZEROES,
  );
  if (!shadowParamsZeroWriteRes.ok) throw shadowParamsZeroWriteRes.error;

  // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
  // the per-spot fragment-read perspective lightViewProj matrices no longer have
  // a standalone uniform buffer — they fold into the View UBO tail
  // (`view.spotLightViewProj`, bytes 528..784, allocated as part of
  // VIEW_UBO_BYTES = 784 above). The View UBO's createBuffer already zero-fills
  // on first writeBuffer; render-system-record writes the spot lanes inside the
  // per-frame viewPayload. Removing the dedicated buffer drops the WebGL2
  // fallback fragment uniform-buffer count from 12 back to 11.

  // feat-20260520-skylight-ibl-cubemap M2 round-4 / t40 amend
  // (plan-strategy D-5 round-4 REVISED): allocate the fallback Skylight
  // identity resource bundle -- 1x1 all-zero rgba16float texture_cube * 2
  // (irradiance + prefilter) + 1x1 approximate rg16float brdfLut +
  // intensity=0 uniform buffer + a single linear/clamp sampler reused
  // across the three texture slots. No stand-alone BindGroupLayout /
  // BindGroup is allocated -- those roles moved into the PBR material
  // BGL factory (entries 7..13 inside @group(1)). The M4 record-stage
  // material BG assembly site feeds these resources through
  // `assembleMaterialWithSkylightEntries` when `skylightCount === 0` so
  // the active standard material path dispatches with ambient = 0 --
  // physical convergence with D-4 (charter F1: AI users writing demos do
  // not need a "is there a skylight?" branch).
  //
  // Keep the helper's narrow mockable contracts at the RHI boundary while
  // forwarding the concrete device and queue methods without a structural cast.
  let skylightFallback: SkylightFallback | null = null;
  try {
    const skylightDevice: Parameters<typeof createSkylightFallback>[0] = {
      createSampler: (descriptor) => rhiDevice.createSampler(descriptor),
      createTexture: (descriptor) => createPersistentTexture(descriptor),
      createTextureView: (texture, descriptor) => rhiDevice.createTextureView(texture, descriptor),
      createBuffer: (descriptor) => createPersistentBuffer(descriptor),
    };
    const skylightQueue: Parameters<typeof createSkylightFallback>[1] = {
      writeTexture: (destination, data, layout, size) =>
        queue.writeTexture(destination, data, layout, size),
      writeBuffer: (buffer, offset, data) => queue.writeBuffer(buffer, offset, data),
    };
    skylightFallback = createSkylightFallback(skylightDevice, skylightQueue);
  } catch (caught) {
    if (caught instanceof RhiError) throw caught;
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'createSkylightFallback succeeded',
      hint: `verify texture_cube + uniform allocation (cause: ${
        caught instanceof Error ? caught.message : String(caught)
      })`,
    });
  }

  // feat-20260615-pipeline-spec-ssot M2-T4: PipelineCache is the single PSO container
  // (SSOT axiom — plan D-12). Created once at boot; shared across all call sites.
  // The provider is a thin wrapper over rhiDevice that fills in vertex buffers +
  // pipeline layout on the descriptor produced by buildPipelineDescriptor.
  const pipelineCache: PipelineCache = new Map();

  // Shader module mapping — maps spec.shader.id to compiled shader modules +
  // optional per-pass metadata (layout, entry points). Material shaders fill
  // only vertex/fragment; fullscreen-post passes add layout + entry points
  // for the boot-time SPEC_CONST pre-warm and lazy-build getOrBuildPipeline.
  const shaderModuleMap = new Map<
    string,
    {
      vertex: unknown;
      fragment: unknown;
      vertexEntryPoint?: string;
      fragmentEntryPoint?: string;
      layout?: unknown;
      label?: string;
    }
  >();
  if (unlitModule !== null)
    shaderModuleMap.set('forgeax::default-unlit', {
      vertex: unlitModule,
      fragment: unlitModule,
    });
  if (pbrModule !== null)
    shaderModuleMap.set('forgeax::default-standard-pbr', {
      vertex: pbrModule,
      fragment: pbrModule,
    });
  if (spriteModule !== null)
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
    // sprite shader registers under the single canonical id `forgeax::sprite`
    // (previously double-mapped via the engine-built default-sprite id for
    // the deleted boot-time pre-warm path). The generic per-MaterialShader
    // pipeline cache reads this entry when a sprite material lands a
    // transparent pass through the LDR split.
    shaderModuleMap.set('forgeax::sprite', {
      vertex: spriteModule,
      fragment: spriteModule,
    });
  // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
  // sprite-lit shader registers under canonical `forgeax::sprite-lit` —
  // mirror sprite, parallel cache slot (D-11 string isolation).
  if (spriteLitModule !== null)
    shaderModuleMap.set('forgeax::sprite-lit', {
      vertex: spriteLitModule,
      fragment: spriteLitModule,
    });
  // M2-T4: fullscreen-post shader modules (tonemap + skybox) are registered
  // in their respective blocks after pipeline layout creation — layout is
  // required for the boot-time SPEC_CONST pre-warm to succeed. The entries
  // in SPEC_CONST_TABLE will be pre-warmed per-block.

  // M2-T4: provider no longer overwrites vertex buffers — buildPipelineDescriptor
  // derives them from spec.geometry.vertexLayout (SSOT). Layout is only filled
  // when the descriptor doesn't already carry one (fullscreen-post passes set it
  // via modules.layout). Fullscreen-post module detection added for label generation.
  const pipelineDeviceProvider: PipelineDeviceProvider = {
    createRenderPipeline(descriptor: Record<string, unknown>):
      | {
          ok: true;
          value: unknown;
        }
      | { ok: false; error: unknown } {
      const d = { ...descriptor } as Record<string, unknown>;

      // Layout: only fill if buildPipelineDescriptor did not already set it.
      if (d.layout === undefined) {
        d.layout =
          (d.fragment as { module?: unknown } | undefined)?.module === unlitModule
            ? unlitPipelineLayout
            : pipelineLayoutResult.value;
      }

      // Sprite HDR uses fragment entry point 'fs_main_hdr'; all other
      // standard material pipelines (unlit/standard LDR/HDR, sprite LDR)
      // use 'fs_main'. The spec is business-agnostic (plan D-7) so the
      // provider resolves this by checking the fragment module reference
      // against the compiled sprite module + the attachment format.
      //
      // Also generates a label for each PSO so integration tests and GPU
      // debug captures can identify the pipeline variant. The label shape
      // is derived from the fragment module + color format (backward-
      // compatible with pre-M2 descriptor literals).
      let label = 'pbr-pipeline';
      if (d.fragment) {
        const f = { ...(d.fragment as Record<string, unknown>) } as Record<string, unknown>;
        const fragModule = f.module;
        const targets = f.targets as Array<Record<string, unknown>> | undefined;
        const isHdr = targets?.[0]?.format === HDR_COLOR_ATTACHMENT_FORMAT;

        if (fragModule === spriteModule || fragModule === spriteLitModule) {
          // Sprite and sprite-lit share one HDR entry swap: `fs_main` (LDR
          // clamped) vs `fs_main_hdr` (HDR pass-through).
          const prefix = fragModule === spriteModule ? 'sprite' : 'sprite-lit';
          label = isHdr ? `${prefix}-pipeline-hdr` : `${prefix}-pipeline`;
          if (isHdr) f.entryPoint = 'fs_main_hdr';
        } else if (fragModule === unlitModule || fragModule === pbrModule) {
          const prefix = fragModule === unlitModule ? 'unlit' : 'standard';
          label = isHdr ? `pbr-pipeline-${prefix}-hdr` : `pbr-pipeline-${prefix}`;
        } else if (fragModule === fxaaModule) {
          label = 'fxaa-pipeline';
        } else if (fragModule === skyboxModule) {
          const msaa = d.multisample as Record<string, unknown> | undefined;
          label = msaa !== undefined ? 'skybox-pipeline-msaa' : 'skybox-pipeline';
        } else if (fragModule === bloomHorizontalModule) {
          label = 'bloom-horizontal-pipeline';
        } else if (fragModule === bloomVerticalModule) {
          label = 'bloom-vertical-pipeline';
        } else if (fragModule === bloomCompositeModule) {
          label = 'bloom-composite-pipeline';
        } else if (fragModule === ssaoModule) {
          label = 'ssao-calc-pipeline';
        }

        d.fragment = f;
      }
      d.label = (d.label as string | undefined) ?? label;

      return rhiDevice.createRenderPipeline(
        d as Parameters<typeof rhiDevice.createRenderPipeline>[0],
      );
    },
  };

  // bug-20260615 fix-up: build the SPEC_CONST table with the runtime-resolved
  // LDR view format. Hard-coding `bgra8unorm-srgb` at module load made the
  // pre-warmed PSOs incompatible with the actual swap-chain format on
  // backends where `getPreferredCanvasFormat()` (or the wgpu-wasm GLES path)
  // returns `rgba8unorm` (Channel 3 + dawn-node) — every frame's whole
  // commandBuffer was being rejected. Calling `buildSpecConstTable` after
  // `selectSwapChainFormat` resolves keeps the pre-warmed key (`cacheKeyOf`)
  // and the runtime tonemap call site (uses the same `swapChainFormats.view`)
  // identical, so the cache lookup hits instead of double-building.
  // Pass both view (unlit / standard / tonemap LDR target) and storage
  // (sprite LDR target — pre-feat sprite PSO targeted swapChainFormats.storage
  // directly so the alpha-blend pass writes the raw, non-srgb view of the
  // swap-chain texture; see pipeline-spec.ts SPRITE_ATTACHMENTS jsdoc).
  // Boot pipelines consume the same reflected UV requirement as lazy material
  // pipelines. Geometry owns aliasing absent sets onto the last supplied UV.
  const withMaterialVertexInputs = (spec: Readonly<PipelineSpec>): Readonly<PipelineSpec> => {
    const uvSetCount =
      registry.materialArtifact(spec.shader.id)?.program.uvSetCount ??
      registry.materialShaderManifestEntry(spec.shader.id)?.uvSetCount;
    return uvSetCount === undefined
      ? spec
      : { ...spec, geometry: { ...spec.geometry, shaderUvSetCount: uvSetCount } };
  };
  const runtimeSpecConstTable = buildSpecConstTable(swapChainFormats.view).map(
    withMaterialVertexInputs,
  );
  const runtimeLinearLdrMaterialSpecTable = buildLinearLdrMaterialSpecTable(
    swapChainFormats.view,
  ).map(withMaterialVertexInputs);
  const runtimeMaterialPrewarmTable = [
    ...runtimeSpecConstTable,
    ...runtimeLinearLdrMaterialSpecTable,
  ];
  const group2ContractForSpec = (spec: PipelineSpec): PipelineGroup2Contract => {
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
  };

  // Boot-time pre-warm: build SPEC_CONST entries whose shader modules are
  // compiled. Entries referencing a missing module are silently skipped
  // (the empty-manifest path — D-3). Each build failure for an available
  // module throws PipelineSpecError (fail-fast, charter P3).
  if (
    unlitModule !== null ||
    pbrModule !== null ||
    spriteModule !== null ||
    spriteLitModule !== null
  ) {
    for (const spec of runtimeMaterialPrewarmTable) {
      const modules = shaderModuleMap.get(spec.shader.id);
      if (modules === undefined) {
        // Module not compiled (empty-manifest for this shader): skip.
        continue;
      }
      try {
        getOrBuildPipeline(spec, pipelineDeviceProvider, pipelineCache, modules);
      } catch (err) {
        if (err instanceof PipelineSpecError) throw err;
        throw new PipelineSpecError({
          code: 'pipeline-build-failed',
          detail: { cause: err },
          hint: `Boot-time SPEC_CONST pre-warm failed for shader '${spec.shader.id}'; inspect gpuMessage on the cause`,
        });
      }
    }

    // The linear-LDR geometry target is intentionally separate from the
    // swap-chain view target. Seed every material entry, including no-variant
    // unlit, because tonemap=none reaches this cache directly on frame one.
    for (const spec of runtimeLinearLdrMaterialSpecTable) {
      if (shaderModuleMap.get(spec.shader.id) === undefined) continue;
      const key = cacheKeyOf(spec);
      const built = pipelineCache.get(key);
      if (built !== undefined) {
        seedMaterialShaderPipelineCache(key, built as RenderPipeline, group2ContractForSpec(spec));
      }
    }
  }

  // helper: look up a pre-warmed PSO from cache by (shaderId, isHdr, sampleCount).
  // Resolves the matching runtimeSpecConstTable entry, computes cacheKeyOf,
  // and returns the cached handle. Returns null when the spec entry's module
  // was not compiled (empty-manifest path) or the cache is cold.
  const getCachedPipelineOrNull = (
    shaderId: string,
    isHdr: boolean,
    sampleCount: 1 | 4,
  ): RenderPipeline | null => {
    for (const entry of runtimeSpecConstTable) {
      if (entry.shader.id === shaderId && entry.attachments.sampleCount === sampleCount) {
        const color0 = entry.attachments.colorFormats[0];
        const entryIsHdr = color0 === HDR_COLOR_ATTACHMENT_FORMAT;
        if (entryIsHdr === isHdr) {
          const key = cacheKeyOf(entry);
          return (pipelineCache.get(key) ?? null) as RenderPipeline | null;
        }
      }
    }
    return null;
  };

  // ── feat-20260520-2d-sprite-layer-mvp / M-3 / w24 ────────────────────────
  //
  // Sprite alpha-blend pipeline pair — LDR (`bgra8unorm-srgb` swap-chain
  // view) + HDR (`rgba16float` offscreen view; routed when active camera
  // carries `tonemap !== 'none'`, same as unlit/standard HDR siblings).
  //
  // @new-surface sprite alpha-blend pipeline (4th + 5th GPU render-pipeline
  // handles on PipelineState; the engine grows 5 -> 9 distinct pipelines:
  // unlit + standard + tonemap each existed before; sprite adds LDR + HDR).
  // The blend op is premultiplied alpha (charter P5 consistent abstraction
  // with the OpenGL / WebGPU industry default; sprite.wgsl fragment outputs
  // premultiplied RGB so srcFactor='one' / dstFactor='one-minus-src-alpha'
  // composes correctly).
  //
  // @reuses pipelineLayoutResult (the 4-BindGroupLayout chain shared with
  //   unlit / standard / pbr — view + material + meshArray + instances).
  // @reuses defaultSampler — sprite material BindGroup entries 3 + 5
  //   (metallicRoughnessSampler / normalSampler placeholders bound to
  //   `pipelineState.defaultSampler`; D-1 candidate b; zero new sampler
  //   created).
  // @reuses defaultWhiteTextureView — sprite material BindGroup entries
  //   4 + 6 (metallicRoughnessTexture / normalTexture placeholders bound
  //   to `pipelineState.defaultWhiteTextureView`; D-1 candidate b; the
  //   1x1 white view was already provisioned for unlit / standard fallback
  //   so the sprite path adds 0 lines of new GPU resource code, only
  //   binding references in render-system-record.ts w25).
  //   Sprite material BindGroup populates entries 0..2 with sprite's own
  //   uniform / sampler / texture, and entries 3..6 with
  //   pipelineState.defaultSampler + pipelineState.defaultWhiteTextureView
  //   (D-1 candidate b — zero new GPU resource; 4-line binding wiring lives
  //   in render-system-record.ts w25). The unused entries are physically
  //   bound to ensure WebGPU's BindGroupLayout congruence (declared in the
  //   shader at @binding 3..6 even though the sprite fragment never reads
  //   them; plan-strategy D-1 + sprite.wgsl JSDoc head).
  //
  // @derives unlit / standard LDR+HDR dual-pipeline structure (lines 2058-
  //   2147 above + 2174-2253 below). The sprite pair mirrors the unlit
  //   pair byte-for-byte except for:
  //     - module: spriteModule (vs unlitModule)
  //     - fragment.targets[0].blend: premultiplied alpha (vs no blend)
  //     - depthStencil.depthWriteEnabled: false (vs true)
  //     - depthStencil.depthCompare: 'greater-equal' (vs 'greater')
  //   The vertex stride comes from the geometry-owned projection (HANDLE_QUAD
  //   passes through the same 12-float interleaved layout as procedural meshes),
  //   so no new vertex pipeline branch is needed in the record stage
  //   (plan-strategy §3 RT4).
  //
  // Premultiplied alpha blend op (`{ srcFactor: 'one', dstFactor:
  // 'one-minus-src-alpha', operation: 'add' }`) is the industry-default for
  // sprite atlases; sprite.wgsl emits premultiplied RGB so the over-
  // composite math (`dst' = src + dst * (1 - src.a)`) is direct.
  // feat-20260615-pipeline-spec-ssot M2-T4: sprite pipelines are pre-warmed in
  // SPEC_CONST_TABLE (4 entries: LDR/HDR x S1/S4). Cache lookup replaces the
  // prior local-handle variables + createMsaaVariant closure.
  // The pre-existing sprite-build-failure defer-to-null semantics are now
  // handled by the boot-time SPEC_CONST pre-warm block above: if the sprite
  // module exists but the SPEC_CONST build fails, the fail-fast throw blocks
  // the engine from entering the first frame (charter P3: no silent fallback).
  // AI users who need sprite tolerance for lavapipe / dawn-vulkan validation
  // can skip SPEC_CONST entries at their own peril via a future M7 opt-out
  // gate; the current M2 contract is fail-fast.
  // feat-20260608-tilemap-object-layer-rendering M2 / m2-t6 (D-8): SPEC_CONST
  // sprite entries set cullMode='none' so H/V flip via negative scale x/y
  // (tilemap per-cell entity TRS form, D-1) does not get culled when winding
  // inverts. See pipeline-spec.ts sprite LDR S1/S4 + HDR S1/S4 entries.

  // ── feat-20260519-tonemap-reinhard-mvp / M2 / T-M2.5 ──────────────────────
  //
  // HDR variants of the unlit + standard pipelines (rgba16float colour
  // attachment instead of bgra8unorm-srgb) plus the post-process tonemap
  // pipeline + 3-entry BGL + sampler + 16 B params UBO. Routed by record-
  // stage when the active camera carries `tonemap !== 'none'` (AC-03(a) /
  // AC-11). Sharing the geometry shader modules across the sRGB + HDR
  // pipelines keeps the shader compile cost flat and the WGSL byte-for-byte
  // identical between the two routes — the only difference is the colour-
  // attachment format declaration in the fragment state target list (charter
  // P5 consistent abstraction; plan-strategy D-2 + D-3).
  //
  // bug-20260519 D-3 nullable extension: the HDR pipeline block is gated on
  // `pbrModule + unlitModule !== null` so the empty-manifest path skips every
  // device.create* call below and writes `null` into the corresponding
  // PipelineState fields. feat-20260621 M-A3 (D-5): the dedicated tonemap
  // pipeline / BGL / sampler / params-UBO handles are gone — the built-in
  // tonemap registers through the unified post-process channel (see the
  // `registerBuiltinTonemap` callback above; pipeline + BGL + sampler + UBO
  // are owned by dispatchFullscreenPass / the fullscreen feature host).
  let fxaaPipelineHandle: RenderPipeline | null = null;
  let fxaaBglHandle: BindGroupLayout | null = null;
  let fxaaSamplerHandle: Sampler | null = null;
  let skyboxPipelineHandle: RenderPipeline | null = null;
  let skyboxBglHandle: BindGroupLayout | null = null;
  let skyboxSamplerHandle: Sampler | null = null;
  let skyboxRotationBufferHandle: Buffer | null = null;
  let skyboxPipelineMsaaHandle: RenderPipeline | null = null;
  // Multiscale Bloom pipeline handles. One level-parameterized horizontal
  // pipeline and one vertical Gaussian pipeline serve the whole five-level graph;
  // the composite is the only other Bloom pipeline. All use rgba16float.
  let bloomHorizontalPipelineHandle: RenderPipeline | null = null;
  let bloomVerticalPipelineHandle: RenderPipeline | null = null;
  let bloomCompositePipelineHandle: RenderPipeline | null = null;
  let bloomHorizontalBglHandle: BindGroupLayout | null = null;
  let bloomVerticalBglHandle: BindGroupLayout | null = null;
  let bloomCompositeBglHandle: BindGroupLayout | null = null;
  let bloomSamplerHandle: Sampler | null = null;
  let bloomHorizontalParamsBufferHandle: Buffer | null = null;
  let bloomVerticalParamsBufferHandle: Buffer | null = null;
  let bloomCompositeParamsBufferHandle: Buffer | null = null;
  let bloomResourcesReady = false;
  let ensureBloomResources: (() => void) | undefined;
  let bloomActiveBundle: BloomPersistentBundle | undefined;
  let bloomCandidateBundle: BloomPersistentBundle | undefined;
  const retiringBloomBundles = new Set<BloomPersistentBundle>();
  let bloomGeneration = 0;
  let lastSuccessfulBloomReceipts:
    | import('../record/frame-snapshot').BloomFrameReceipts
    | undefined;
  const getBloomResourcesStable = (): BloomPersistentBundle | null =>
    bloomCandidateBundle ?? bloomActiveBundle ?? null;
  let commitBloomResources: (() => void) | undefined;
  let discardBloomResources: (() => void) | undefined;
  let retireBloomResources: ((completion: Promise<unknown>) => void) | undefined;
  let drainBloomResources: (() => void) | undefined;
  let inspectBloomResources:
    | ((graph?: import('@forgeax/engine-render-graph').CompiledRenderGraphInfo) => BloomInspection)
    | undefined;
  const ensureBloomResourcesStable = (): void => {
    ensureBloomResources?.();
  };
  const retireBloomResourcesStable = (completion: Promise<unknown>): void => {
    retireBloomResources?.(completion);
  };
  const commitBloomResourcesStable = (): void => {
    commitBloomResources?.();
  };
  const discardBloomResourcesStable = (): void => {
    discardBloomResources?.();
  };
  const drainBloomResourcesStable = (): void => {
    drainBloomResources?.();
  };
  const inspectBloomResourcesStable = (
    graph?: import('@forgeax/engine-render-graph').CompiledRenderGraphInfo,
  ): BloomInspection => {
    return inspectBloomResources?.(graph) ?? emptyBloomInspection();
  };
  // feat-20260612-hdrp-ssao M6 / w26 + w43: SSAO pipeline handles (D-A).
  // calc + blur RenderPipeline pair sharing a dedicated 6-entry BGL.
  // Optional — null when manifest lacks hdrp-ssao entry.
  let ssaoCalcPipelineHandle: RenderPipeline | null = null;
  let ssaoBlurPipelineHandle: RenderPipeline | null = null;
  let ssaoBglHandle: BindGroupLayout | null = null;
  if (unlitModule !== null && pbrModule !== null) {
    // feat-20260615-pipeline-spec-ssot M2-T4: unlit/standard HDR pipeline
    // variants are pre-warmed in SPEC_CONST_TABLE (4 entries: unlit/standard
    // HDR x S1/S4). Cache lookup replaces prior local-handle variables.
    // The fxaa / skybox / bloom / SSAO fullscreen pipelines below
    // are NOT in SPEC_CONST_TABLE and remain boot-time lazy-built here.
    // feat-20260621 M-A3 (D-5): tonemap is no longer built here — it registers
    // through the unified post-process channel (registerBuiltinTonemap).

    // feat-20260528-fxaa-post-processing M2 / w10: FXAA pipeline prebuilt.
    // When the manifest contains the fxaa entry (rgb2luma marker, D-5),
    // construct the 3-entry BGL (texture + sampler + output-policy UBO),
    // pipeline layout, fullscreen render pipeline (vertex = fullscreen
    // triangle from fxaa.wgsl, fragment = FXAA 3.11 algorithm), and
    // linear clamp-to-edge sampler. Mirrors the tonemap pipeline
    // construction pattern directly above.
    if (fxaaModule !== null) {
      // FXAA BindGroupLayout: 3 entries (texture + sampler + output-policy UBO).
      // D-2: the fxaa.wgsl fragment stage declares @binding(0) texture_2d<f32>
      // + @binding(1) sampler + @binding(2) FxaaParams.
      const fxaaBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
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
      if (!fxaaBglResult.ok) throw fxaaBglResult.error;
      fxaaBglHandle = fxaaBglResult.value;

      const fxaaPipelineLayoutResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'fxaa-pl',
            bindGroupLayouts: [fxaaBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(fxaa) succeeded',
        'verify fxaa BindGroupLayout matches shader @group(0) bindings',
      );
      if (!fxaaPipelineLayoutResult.ok) throw fxaaPipelineLayoutResult.error;

      // M2-T4: FXAA pipeline via getOrBuildPipeline (lazy-build, not in SPEC_CONST_TABLE).
      // Color-space contract: FXAA writes bgra8unorm (NON-srgb) storage format.
      // Lazy-build via cache miss on first access.
      {
        const fxaaSpec: PipelineSpec = {
          shader: { id: 'forgeax::post::fxaa', passKind: 'post-process', variantSet: undefined },
          attachments: {
            colorFormats: [storageBufferCapable ? swapChainFormats.storage : swapChainFormats.view],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = {
          vertex: fxaaModule,
          fragment: fxaaModule,
          layout: fxaaPipelineLayoutResult.value,
        };
        try {
          fxaaPipelineHandle = getOrBuildPipeline(
            fxaaSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (err) {
          if (err instanceof PipelineSpecError) throw err;
          throw new PipelineSpecError({
            code: 'pipeline-build-failed',
            detail: { cause: err },
            hint: 'createRenderPipeline (fxaa fullscreen) failed; inspect gpuMessage',
          });
        }
      }

      // FXAA sampler: linear filter + clamp-to-edge. Clamp-to-edge
      // prevents edge bleed when sampling at the screen extents.
      const fxaaSamplerResult = runShimSyncStep(
        () =>
          rhiDevice.createSampler({
            label: 'fxaa-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        'webgpu-runtime-error',
        'createSampler (fxaa) succeeded',
        'check device.limits.maxSamplersPerShaderStage',
      );
      if (!fxaaSamplerResult.ok) throw fxaaSamplerResult.error;
      fxaaSamplerHandle = fxaaSamplerResult.value;
    }

    // feat-20260531-skybox-env-background M3 / w15: skybox pipeline prebuilt.
    // When the manifest contains the skybox entry (skybox_fs marker, D-7),
    // construct the 4-entry BGL (texture_cube + sampler + View UBO + rotation UBO),
    // pipeline layout, fullscreen render pipeline (vertex = fullscreen
    // triangle from skybox.wgsl, fragment = cubemap sample + write HDR),
    // and linear clamp-to-edge sampler. Mirrors tonemap/fxaa construction
    // pattern. Skybox writes to hdrColor rgba16float, NOT to the swap-chain
    // (plan-strategy D-2: tonemap pass reads hdrColor and maps to LDR).
    if (skyboxModule !== null) {
      const skyboxBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
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
      if (!skyboxBglResult.ok) throw skyboxBglResult.error;
      skyboxBglHandle = skyboxBglResult.value;

      const skyboxPipelineLayoutResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'skybox-pl',
            bindGroupLayouts: [skyboxBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(skybox) succeeded',
        'verify skybox BindGroupLayout matches shader @group(0) bindings',
      );
      if (!skyboxPipelineLayoutResult.ok) throw skyboxPipelineLayoutResult.error;

      // Skybox pipeline writes to hdrColor rgba16float render target (NOT
      // M2-T4: skybox pipeline via getOrBuildPipeline + SPEC_CONST_TABLE pre-warm.
      // Skybox HDR S1 + S4 entries are in SPEC_CONST_TABLE. Register module with
      // layout + fragmentEntryPoint 'skybox_fs'. The S1 variant is built via
      // getOrBuildPipeline; MSAA S4 variant catches failure gracefully (same as
      // pre-M2 behavior: warn + fire error, set handle to null).
      shaderModuleMap.set('forgeax::skybox::cube', {
        vertex: skyboxModule,
        fragment: skyboxModule,
        fragmentEntryPoint: 'skybox_fs',
        layout: skyboxPipelineLayoutResult.value,
      });
      // S1 (non-MSAA)
      {
        const skyboxSpec: PipelineSpec = {
          shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = shaderModuleMap.get('forgeax::skybox::cube');
        if (modules === undefined) throw new Error('expected skybox module in shaderModuleMap');
        skyboxPipelineHandle = getOrBuildPipeline(
          skyboxSpec,
          pipelineDeviceProvider,
          pipelineCache,
          modules,
        ) as RenderPipeline;
      }
      // S4 (MSAA variant — graceful failure, same as pre-M2)
      {
        const skyboxMsaaSpec: PipelineSpec = {
          shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 4,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = shaderModuleMap.get('forgeax::skybox::cube');
        if (modules === undefined) throw new Error('expected skybox module in shaderModuleMap');
        try {
          skyboxPipelineMsaaHandle = getOrBuildPipeline(
            skyboxMsaaSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (msaaErr) {
          // The MSAA variant is a graceful-degradation path -- console.warn is the
          // canonical signal for "feature degrades, not fails" (noConsole allows warn).
          console.warn(
            `[forgeax] skybox MSAA pipeline variant build failed at renderer init; ` +
              `non-MSAA skybox unaffected. (cause: ${String(msaaErr)})`,
          );
          // PipelineSpecError carries the underlying cause in `.detail.cause`;
          // the warn above already surfaces the message.
          skyboxPipelineMsaaHandle = null;
        }
      }

      // Skybox sampler: filterable (linear/linear/clamp). Clamp-to-edge
      // prevents seam artifacts at cubemap face boundaries.
      const skyboxSamplerResult = runShimSyncStep(
        () =>
          rhiDevice.createSampler({
            label: 'skybox-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        'webgpu-runtime-error',
        'createSampler (skybox) succeeded',
        'check device.limits.maxSamplersPerShaderStage',
      );
      if (!skyboxSamplerResult.ok) throw skyboxSamplerResult.error;
      skyboxSamplerHandle = skyboxSamplerResult.value;

      const skyboxRotationBufferResult = runShimSyncStep(
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
      if (!skyboxRotationBufferResult.ok) throw skyboxRotationBufferResult.error;
      skyboxRotationBufferHandle = skyboxRotationBufferResult.value;
    }

    // Multiscale Bloom pipeline assembly. The runtime owns exactly one
    // parameterized horizontal PSO, one vertical Gaussian PSO, and one composite
    // PSO. The graph owns the five horizontal and five vertical target
    // instances; no axis/radius compatibility route is retained.

    ensureBloomResources = (): void => {
      if (bloomResourcesReady) return;
      const candidateScope = rendererScope.createChild(`${rendererScope.owner}:standard-bloom`);
      const adopt = <T>(
        kind: Parameters<DeviceScope['_adopt']>[0],
        value: T,
        cleanup: (value: T) => void,
      ): T => {
        candidateScope._adopt(kind, value, cleanup);
        return value;
      };
      try {
        // Shared Bloom sampler: linear filter + clamp-to-edge (all passes
        // sample from textures using fullscreen triangle UVs).
        if (
          bloomHorizontalModule !== null ||
          bloomVerticalModule !== null ||
          bloomCompositeModule !== null
        ) {
          const bloomSamplerResult = runShimSyncStep(
            () =>
              rhiDevice.createSampler({
                label: 'bloom-sampler',
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
              }),
            'webgpu-runtime-error',
            'createSampler (bloom) succeeded',
            'check device.limits.maxSamplersPerShaderStage',
          );
          if (!bloomSamplerResult.ok) throw bloomSamplerResult.error;
          bloomSamplerHandle = adopt('binding', bloomSamplerResult.value, () => undefined);
        }

        // Bloom horizontal: source texture + sampler + one level slice.
        if (bloomHorizontalModule !== null && bloomSamplerHandle !== null) {
          const horizontalBglResult = runShimSyncStep(
            () =>
              rhiDevice.createBindGroupLayout({
                label: 'bloom-horizontal-bgl',
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
            'createBindGroupLayout(bloom-horizontal) succeeded',
            'check device.limits.maxBindGroupsPerPipelineLayout',
          );
          if (!horizontalBglResult.ok) throw horizontalBglResult.error;
          bloomHorizontalBglHandle = adopt('binding', horizontalBglResult.value, () => undefined);

          const horizontalPlResult = runShimSyncStep(
            () =>
              rhiDevice.createPipelineLayout({
                label: 'bloom-horizontal-pl',
                bindGroupLayouts: [horizontalBglResult.value],
              }),
            'webgpu-runtime-error',
            'createPipelineLayout(bloom-horizontal) succeeded',
            'verify bloom-horizontal BindGroupLayout matches shader @group(0) bindings',
          );
          if (!horizontalPlResult.ok) throw horizontalPlResult.error;
          adopt('binding', horizontalPlResult.value, () => undefined);

          // One pipeline serves first-level extraction and each horizontal Gaussian blur.
          {
            const horizontalSpec: PipelineSpec = {
              shader: {
                id: 'forgeax::post::bloom-horizontal',
                passKind: 'post-process',
                variantSet: undefined,
              },
              attachments: {
                colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
                depthFormat: undefined,
                sampleCount: 1,
              },
              geometry: {
                topology: 'triangle-list',
                stripIndexFormat: undefined,
                vertexLayout: {},
              },
              renderState: { cullMode: 'none' },
            };
            const modules = {
              vertex: bloomHorizontalModule,
              fragment: bloomHorizontalModule,
              layout: horizontalPlResult.value,
              label: 'bloom-horizontal-pipeline',
            };
            try {
              bloomHorizontalPipelineHandle = getOrBuildPipeline(
                horizontalSpec,
                pipelineDeviceProvider,
                pipelineCache,
                modules,
              ) as RenderPipeline;
              bloomHorizontalPipelineHandle = adopt(
                'pipeline',
                bloomHorizontalPipelineHandle,
                () => undefined,
              );
            } catch (err) {
              if (err instanceof PipelineSpecError) throw err;
              throw new PipelineSpecError({
                code: 'pipeline-build-failed',
                detail: { cause: err },
                hint: 'createRenderPipeline (bloom-horizontal fullscreen) failed; inspect gpuMessage',
              });
            }
          }

          // Five 32-byte std140 slices: threshold, smooth width, destination extent,
          // level and padding. The level is selected by the graph pass.
          const horizontalParamsResult = runShimSyncStep(
            () =>
              rhiDevice.createBuffer({
                label: 'bloom-horizontal-params-ubo',
                size: BLOOM_HORIZONTAL_PARAMS_BYTES,
                usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
                mappedAtCreation: false,
              }),
            'webgpu-runtime-error',
            'createBuffer (bloom-horizontal params UBO) succeeded',
            'check device.limits.maxUniformBufferBindingSize',
          );
          if (!horizontalParamsResult.ok) throw horizontalParamsResult.error;
          bloomHorizontalParamsBufferHandle = adopt(
            'buffer',
            horizontalParamsResult.value,
            (value) => {
              rhiDevice.destroyBuffer(value);
            },
          );
        }

        // Bloom vertical: horizontal texture + sampler + level slice.
        if (bloomVerticalModule !== null && bloomSamplerHandle !== null) {
          const verticalBglResult = runShimSyncStep(
            () =>
              rhiDevice.createBindGroupLayout({
                label: 'bloom-vertical-bgl',
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
            'createBindGroupLayout(bloom-vertical) succeeded',
            'check device.limits.maxBindGroupsPerPipelineLayout',
          );
          if (!verticalBglResult.ok) throw verticalBglResult.error;
          bloomVerticalBglHandle = adopt('binding', verticalBglResult.value, () => undefined);

          const verticalPlResult = runShimSyncStep(
            () =>
              rhiDevice.createPipelineLayout({
                label: 'bloom-vertical-pl',
                bindGroupLayouts: [verticalBglResult.value],
              }),
            'webgpu-runtime-error',
            'createPipelineLayout(bloom-vertical) succeeded',
            'verify bloom-vertical BindGroupLayout matches shader @group(0) bindings',
          );
          if (!verticalPlResult.ok) throw verticalPlResult.error;
          adopt('binding', verticalPlResult.value, () => undefined);

          // One pipeline serves every vertical Gaussian blur.
          {
            const verticalSpec: PipelineSpec = {
              shader: {
                id: 'forgeax::post::bloom-vertical',
                passKind: 'post-process',
                variantSet: undefined,
              },
              attachments: {
                colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
                depthFormat: undefined,
                sampleCount: 1,
              },
              geometry: {
                topology: 'triangle-list',
                stripIndexFormat: undefined,
                vertexLayout: {},
              },
              renderState: { cullMode: 'none' },
            };
            const modules = {
              vertex: bloomVerticalModule,
              fragment: bloomVerticalModule,
              layout: verticalPlResult.value,
              label: 'bloom-vertical-pipeline',
            };
            try {
              bloomVerticalPipelineHandle = getOrBuildPipeline(
                verticalSpec,
                pipelineDeviceProvider,
                pipelineCache,
                modules,
              ) as RenderPipeline;
              bloomVerticalPipelineHandle = adopt(
                'pipeline',
                bloomVerticalPipelineHandle,
                () => undefined,
              );
            } catch (err) {
              if (err instanceof PipelineSpecError) throw err;
              throw new PipelineSpecError({
                code: 'pipeline-build-failed',
                detail: { cause: err },
                hint: 'createRenderPipeline (bloom-vertical fullscreen) failed; inspect gpuMessage',
              });
            }
          }

          // Five 16-byte slices carry the vertical kernel radius for each level.
          const verticalParamsResult = runShimSyncStep(
            () =>
              rhiDevice.createBuffer({
                label: 'bloom-vertical-params-ubo',
                size: BLOOM_VERTICAL_PARAMS_BYTES,
                usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
                mappedAtCreation: false,
              }),
            'webgpu-runtime-error',
            'createBuffer (bloom-vertical params UBO) succeeded',
            'check device.limits.maxUniformBufferBindingSize',
          );
          if (!verticalParamsResult.ok) throw verticalParamsResult.error;
          bloomVerticalParamsBufferHandle = adopt('buffer', verticalParamsResult.value, (value) => {
            rhiDevice.destroyBuffer(value);
          });
        }

        // Bloom composite: scene plus five levels, sampler and intensity/radius uniform.
        if (bloomCompositeModule !== null && bloomSamplerHandle !== null) {
          const compositeBglResult = runShimSyncStep(
            () =>
              rhiDevice.createBindGroupLayout({
                label: 'bloom-composite-bgl',
                entries: [
                  ...Array.from({ length: 6 }, (_, binding) => ({
                    binding,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
                  })),
                  {
                    binding: 6,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    sampler: { type: 'filtering' },
                  },
                  {
                    binding: 7,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    buffer: { type: 'uniform' },
                  },
                ],
              }),
            'webgpu-runtime-error',
            'createBindGroupLayout(bloom-composite) succeeded',
            'check device.limits.maxBindGroupsPerPipelineLayout',
          );
          if (!compositeBglResult.ok) throw compositeBglResult.error;
          bloomCompositeBglHandle = adopt('binding', compositeBglResult.value, () => undefined);

          const compositePlResult = runShimSyncStep(
            () =>
              rhiDevice.createPipelineLayout({
                label: 'bloom-composite-pl',
                bindGroupLayouts: [compositeBglResult.value],
              }),
            'webgpu-runtime-error',
            'createPipelineLayout(bloom-composite) succeeded',
            'verify bloom-composite BindGroupLayout matches shader @group(0) bindings',
          );
          if (!compositePlResult.ok) throw compositePlResult.error;
          adopt('binding', compositePlResult.value, () => undefined);

          // M2-T4: bloom-composite pipeline via getOrBuildPipeline (lazy-build).
          {
            const compositeSpec: PipelineSpec = {
              shader: {
                id: 'forgeax::post::bloom-composite',
                passKind: 'post-process',
                variantSet: undefined,
              },
              attachments: {
                colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
                depthFormat: undefined,
                sampleCount: 1,
              },
              geometry: {
                topology: 'triangle-list',
                stripIndexFormat: undefined,
                vertexLayout: {},
              },
              renderState: { cullMode: 'none' },
            };
            const modules = {
              vertex: bloomCompositeModule,
              fragment: bloomCompositeModule,
              layout: compositePlResult.value,
            };
            try {
              bloomCompositePipelineHandle = getOrBuildPipeline(
                compositeSpec,
                pipelineDeviceProvider,
                pipelineCache,
                modules,
              ) as RenderPipeline;
              bloomCompositePipelineHandle = adopt(
                'pipeline',
                bloomCompositePipelineHandle,
                () => undefined,
              );
            } catch (err) {
              if (err instanceof PipelineSpecError) throw err;
              throw new PipelineSpecError({
                code: 'pipeline-build-failed',
                detail: { cause: err },
                hint: 'createRenderPipeline (bloom-composite fullscreen) failed; inspect gpuMessage',
              });
            }
          }

          // Composite params UBO: 16 B std140 (intensity f32 + 12 B pad).
          const compositeParamsResult = runShimSyncStep(
            () =>
              rhiDevice.createBuffer({
                label: 'bloom-composite-params-ubo',
                size: BLOOM_COMPOSITE_PARAMS_BYTES,
                usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
                mappedAtCreation: false,
              }),
            'webgpu-runtime-error',
            'createBuffer (bloom-composite params UBO) succeeded',
            'check device.limits.maxUniformBufferBindingSize',
          );
          if (!compositeParamsResult.ok) throw compositeParamsResult.error;
          bloomCompositeParamsBufferHandle = adopt(
            'buffer',
            compositeParamsResult.value,
            (value) => {
              rhiDevice.destroyBuffer(value);
            },
          );
        }

        bloomCandidateBundle = {
          scope: candidateScope,
          generation: bloomGeneration + 1,
          bloomHorizontalPipeline: bloomHorizontalPipelineHandle,
          bloomVerticalPipeline: bloomVerticalPipelineHandle,
          bloomCompositePipeline: bloomCompositePipelineHandle,
          bloomHorizontalBindGroupLayout: bloomHorizontalBglHandle,
          bloomVerticalBindGroupLayout: bloomVerticalBglHandle,
          bloomCompositeBindGroupLayout: bloomCompositeBglHandle,
          bloomSampler: bloomSamplerHandle,
          bloomHorizontalParamsBuffer: bloomHorizontalParamsBufferHandle,
          bloomVerticalParamsBuffer: bloomVerticalParamsBufferHandle,
          bloomCompositeParamsBuffer: bloomCompositeParamsBufferHandle,
        };
        inspectBloomResources = (graph): BloomInspection => {
          const retiring = [...retiringBloomBundles].sort(
            (left, right) => left.generation - right.generation,
          );
          const active = bloomActiveBundle?.scope.isAlive() ? bloomActiveBundle : undefined;
          const liveRetiring = retiring.filter((bundle) => bundle.scope.state === 'retiring');
          const selected = active ?? liveRetiring[liveRetiring.length - 1];
          if (selected === undefined) {
            return {
              graphStatus: 'empty',
              enabled: false,
              levelCount: 0,
              levelDimensions: [],
              horizontalPassCount: 0,
              verticalPassCount: 0,
              targetCount: 0,
              targetBytes: 0,
              resourceCount: 0,
              passCount: 0,
              encodeCount: 0,
              bindGroupCount: 0,
              uploadCount: 0,
              residentChildBytes: 0,
              generation: 0,
              state: 'off',
            };
          }
          const state = active === undefined ? 'retiring' : 'active';
          const ownedBundles = [...(active === undefined ? [] : [active]), ...liveRetiring];
          const graphInspection = inspectStandardBloomGraph(graph);
          const receipts = lastSuccessfulBloomReceipts ?? {
            uploadCount: 0,
            bindGroupCount: 0,
            encodeCount: 0,
          };
          return {
            graphStatus: active === undefined ? 'empty' : graphInspection.status,
            enabled: active !== undefined,
            levelCount: active === undefined ? 0 : graphInspection.levelCount,
            levelDimensions: active === undefined ? [] : graphInspection.levelDimensions,
            horizontalPassCount: active === undefined ? 0 : graphInspection.horizontalPassCount,
            verticalPassCount: active === undefined ? 0 : graphInspection.verticalPassCount,
            targetCount: active === undefined ? 0 : graphInspection.targetCount,
            targetBytes: active === undefined ? 0 : graphInspection.targetBytes,
            resourceCount: ownedBundles.reduce(
              (count, bundle) => count + bundle.scope.resourceDelta(),
              0,
            ),
            passCount: active === undefined ? 0 : graphInspection.passCount,
            encodeCount: active === undefined ? 0 : receipts.encodeCount,
            bindGroupCount: active === undefined ? 0 : receipts.bindGroupCount,
            uploadCount: active === undefined ? 0 : receipts.uploadCount,
            // The graph owns the target allocations.  Use its validated
            // descriptor byte sum for the active child; zero is reserved for
            // an absent/invalid current graph, never a placeholder for a
            // live Bloom allocation.
            residentChildBytes:
              active === undefined || graphInspection.status !== 'valid'
                ? 0
                : graphInspection.targetBytes,
            generation: selected?.generation ?? 0,
            state,
          };
        };
        commitBloomResources = () => {
          if (bloomCandidateBundle?.scope !== candidateScope) return;
          bloomActiveBundle = bloomCandidateBundle;
          bloomCandidateBundle = undefined;
          bloomGeneration += 1;
          bloomResourcesReady = true;
        };
        discardBloomResources = () => {
          if (bloomCandidateBundle?.scope !== candidateScope) return;
          candidateScope.abandon();
          bloomCandidateBundle = undefined;
          bloomResourcesReady = false;
        };
        const reportBloomFenceFailure = (cause: unknown): void => {
          if (cause instanceof RhiError) {
            errorRegistry.fire(cause);
            return;
          }
          const detailError = {
            code: 'bloom-fence-rejected',
            message: String(cause),
            ...(cause instanceof Error ? { name: cause.name } : {}),
          };
          errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'Bloom queue completion resolves after the submitted frame retires',
              hint: 'inspect renderer errors for the queue completion cause',
              detail: { error: detailError },
            }),
          );
        };
        retireBloomResources = (completion) => {
          const retiring = bloomActiveBundle;
          if (retiring === undefined) return;
          bloomActiveBundle = undefined;
          bloomResourcesReady = false;
          retiringBloomBundles.add(retiring);
          retiring.scope.beginRetire();
          void completion.then(
            () => {
              if (!retiringBloomBundles.has(retiring)) return;
              retiring.scope.retire();
              retiringBloomBundles.delete(retiring);
            },
            (cause) => {
              if (!retiringBloomBundles.has(retiring)) return;
              reportBloomFenceFailure(cause);
              retiring.scope.retire();
              retiringBloomBundles.delete(retiring);
            },
          );
        };
        drainBloomResources = () => {
          if (bloomCandidateBundle !== undefined) {
            bloomCandidateBundle.scope.abandon();
            bloomCandidateBundle = undefined;
          }
          if (bloomActiveBundle !== undefined) {
            bloomActiveBundle.scope.retire();
            bloomActiveBundle = undefined;
          }
          for (const retiring of retiringBloomBundles) retiring.scope.retire();
          retiringBloomBundles.clear();
          bloomResourcesReady = false;
        };
      } catch (cause) {
        candidateScope.abandon();
        if (bloomCandidateBundle?.scope === candidateScope) bloomCandidateBundle = undefined;
        commitBloomResources = undefined;
        discardBloomResources = undefined;
        drainBloomResources = undefined;
        bloomHorizontalPipelineHandle = null;
        bloomVerticalPipelineHandle = null;
        bloomCompositePipelineHandle = null;
        bloomHorizontalBglHandle = null;
        bloomVerticalBglHandle = null;
        bloomCompositeBglHandle = null;
        bloomSamplerHandle = null;
        bloomHorizontalParamsBufferHandle = null;
        bloomVerticalParamsBufferHandle = null;
        bloomCompositeParamsBufferHandle = null;
        throw cause;
      }
    };

    // SSAO calculation and bilateral blur share the hdrp-ssao.wgsl layout.
    // Packed normals use textureLoad; float noise and depth use nearest
    // sampling. Both passes draw fullscreen triangles into R8 targets.
    if (ssaoModule !== null) {
      const ssaoBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'ssao-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                // hdrp-ssao-noise is rgba32float; without the
                // float32-filterable extension this format is unfilterable.
                // The SSAO noise generator uses NEAREST/REPEAT sampling
                // so unfilterable-float is sufficient and works on dawn.
                texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
              },
              {
                binding: 3,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                // RGBA32F noise uses NEAREST/REPEAT without requiring
                // float32-filterable. Packed normals do not use a sampler.
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
                // Shared with binding 3 (single sampler resource); both BGL
                // entries must declare the same sampler-type kind.
                sampler: { type: 'non-filtering' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(ssao) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!ssaoBglResult.ok) throw ssaoBglResult.error;
      ssaoBglHandle = ssaoBglResult.value;

      const ssaoPipelineLayoutResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'ssao-pl',
            bindGroupLayouts: [ssaoBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(ssao) succeeded',
        'verify SSAO BindGroupLayout matches shader @group(2) bindings',
      );
      if (!ssaoPipelineLayoutResult.ok) throw ssaoPipelineLayoutResult.error;

      // M2-T4: SSAO calc + blur pipelines via getOrBuildPipeline (lazy-build).
      // Different fragment entry points distinguish calc (fs_ssao_calc) from
      // blur (fs_ssao_blur); distinct synthetic shader IDs ensure correct cache
      // key separation (same module, different entry points → different PSOs).
      {
        const layout = ssaoPipelineLayoutResult.value;
        const baseModules = {
          vertex: ssaoModule,
          fragment: ssaoModule,
          vertexEntryPoint: 'vs_ssao',
          layout,
        };
        // SSAO calc
        {
          const calcSpec: PipelineSpec = {
            shader: {
              id: 'forgeax::post::ssao-calc',
              passKind: 'post-process',
              variantSet: undefined,
            },
            attachments: {
              colorFormats: ['rgba8unorm'],
              depthFormat: undefined,
              sampleCount: 1,
            },
            geometry: {
              topology: 'triangle-list',
              stripIndexFormat: undefined,
              vertexLayout: {},
            },
            renderState: { cullMode: 'none' },
          };
          try {
            ssaoCalcPipelineHandle = getOrBuildPipeline(
              calcSpec,
              pipelineDeviceProvider,
              pipelineCache,
              { ...baseModules, fragmentEntryPoint: 'fs_ssao_calc' },
            ) as RenderPipeline;
          } catch (err) {
            if (err instanceof PipelineSpecError) throw err;
            throw new PipelineSpecError({
              code: 'pipeline-build-failed',
              detail: { cause: err },
              hint: 'createRenderPipeline (ssao-calc fullscreen) failed; inspect gpuMessage',
            });
          }
        }
        // SSAO blur
        {
          const blurSpec: PipelineSpec = {
            shader: {
              id: 'forgeax::post::ssao-blur',
              passKind: 'post-process',
              variantSet: undefined,
            },
            attachments: {
              colorFormats: ['r8unorm'],
              depthFormat: undefined,
              sampleCount: 1,
            },
            geometry: {
              topology: 'triangle-list',
              stripIndexFormat: undefined,
              vertexLayout: {},
            },
            renderState: { cullMode: 'none' },
          };
          try {
            ssaoBlurPipelineHandle = getOrBuildPipeline(
              blurSpec,
              pipelineDeviceProvider,
              pipelineCache,
              { ...baseModules, fragmentEntryPoint: 'fs_ssao_blur' },
            ) as RenderPipeline;
          } catch (err) {
            if (err instanceof PipelineSpecError) throw err;
            throw new PipelineSpecError({
              code: 'pipeline-build-failed',
              detail: { cause: err },
              hint: 'createRenderPipeline (ssao-blur fullscreen) failed; inspect gpuMessage',
            });
          }
        }
      }
    }
  }

  await prewarmMipmapPipeline(rhiDevice, gpuStore, manifestEntries.length > 0);

  const pipelineState: PipelineState = {
    device: rhiDevice,
    // The ready state keeps one canonical mesh vertex projection from the
    // geometry owner. Material selection and feature layout identity are
    // derived from that projection; no legacy stride discriminator participates
    // in pipeline or record routing.
    // bug-20260519: BUILTIN cube migrated to 12F so the legacy
    // `unlitBuiltinPipeline` (+ its zero-stride `unlitBuiltinDummyAttrBuffer`)
    // is gone; consumers pick per `mat.materialShaderId` only via the record-stage
    // 2-way `setPipeline` branch.
    // feat-20260615-pipeline-spec-ssot M2-T4: standard material PSOs are
    // pre-warmed in SPEC_CONST_TABLE and cached in pipelineCache. Cache
    // lookup replaces the prior local-handle variables (SSOT axiom D-12).
    // lookupSpecInTable resolves entries by (shaderId, isHdr, sampleCount);
    // null when the spec entry's module was not compiled (empty-manifest path).
    // (see definition near SPEC_CONST boot-time pre-warm block above)
    unlitPipeline: getCachedPipelineOrNull('forgeax::default-unlit', false, 1),
    standardPbrShaderUvSetCount,
    unlitPipelineMsaa: getCachedPipelineOrNull('forgeax::default-unlit', false, 4),
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (D-7):
    // four sprite-dedicated boot-time pre-warms are gone. Sprite PSO now
    // lands lazily through the generic per-MaterialShader pipeline cache
    // (`getMaterialShaderPipeline('forgeax::sprite', ...)`) keyed on
    // premultiplied-alpha renderState at draw time. -4 entries off
    // SPEC_CONST_TABLE (15 from 19); -4 fields off PipelineState.
    unlitPipelineHdrMsaa: getCachedPipelineOrNull('forgeax::default-unlit', true, 4),
    // feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
    // expose the shared pbr/unlit/sprite pipeline layout so the per-
    // MaterialShader pipeline cache callback (createRenderer.ts
    // getMaterialShaderPipeline) can reuse it at lazy build time without
    // re-running pbrLayouts construction. `null` when the manifest is empty
    // (Camera-only path; bug-20260519 D-3 nullable parallel to the unlit /
    // standard pipeline fields above).
    pbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? pipelineLayoutResult.value : null,
    gpuDrivenInstancesBindGroupLayout:
      unlitModule !== null && pbrModule !== null ? gpuDrivenInstancesBindGroupLayoutHandle : null,
    gpuDrivenPbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? gpuDrivenPbrPipelineLayoutHandle : null,
    gpuDrivenPbrPrograms,
    gpuDrivenPbrSkinPipelineLayout:
      unlitModule !== null && pbrModule !== null ? gpuDrivenPbrSkinPipelineLayoutHandle : null,
    surfaceDirectInstancesBindGroupLayout:
      unlitModule !== null && pbrModule !== null
        ? surfaceDirectInstancesBindGroupLayoutHandle
        : null,
    gpuDrivenClusterPbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? gpuDrivenClusterPbrPipelineLayoutHandle : null,
    gpuDrivenClusterPbrSkinPipelineLayout:
      unlitModule !== null && pbrModule !== null
        ? gpuDrivenClusterPbrSkinPipelineLayoutHandle
        : null,
    gpuDrivenClusterMeshBindGroupLayout:
      unlitModule !== null && pbrModule !== null ? hdrpUnifiedBglHandle : null,
    // HDRP variant uses the unified group(2) layout built above.
    hdrpPbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? hdrpPbrPipelineLayoutHandle : null,
    hdrpMeshBindGroupLayout: hdrpMeshBindGroupLayoutHandle,
    hdrpProbePbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? hdrpProbePbrPipelineLayoutHandle : null,
    hdrpClusterMembershipPipeline,
    hdrpClusterMembershipBindGroupLayout,
    // Skin variant uses its dedicated mesh-array layout; both handles are
    // gated on the same boot modules and may be null for camera-only startup.
    pbrSkinPipelineLayout:
      unlitModule !== null && pbrModule !== null ? pbrSkinPipelineLayoutHandle : null,
    pbrSkinProbePipelineLayout:
      unlitModule !== null && pbrModule !== null ? pbrSkinProbePipelineLayoutHandle : null,
    pbrSkinMeshBindGroupLayout:
      unlitModule !== null && pbrModule !== null ? pbrSkinMeshBindGroupLayoutHandle : null,
    hdrpSkinPipelineLayout:
      unlitModule !== null && pbrModule !== null ? hdrpSkinPipelineLayoutHandle : null,
    hdrpSkinProbePipelineLayout: hdrpSkinProbePipelineLayoutHandle,
    hdrpSkinMeshBindGroupLayout:
      unlitModule !== null && pbrModule !== null ? hdrpSkinMeshBindGroupLayoutHandle : null,
    // feat-20260612-skin-palette-per-frame-upload M1 / m1-2: animator-ready
    // skin-palette allocator (replaces the prior identity-buffer stub).
    // Same gating as `pbrSkinPipelineLayout` -- `null` when the skin
    // pipeline-layout build itself failed.
    skinPaletteAllocator:
      unlitModule !== null && pbrModule !== null ? skinPaletteAllocatorHandle : null,
    format: swapChainFormats.storage,
    colorAttachmentFormat: swapChainFormats.view,
    surfaceProfile: surfaceViewFormats ? 'dual-view' : 'raw-only',
    viewBindGroupLayout: viewBglResult.value,
    extendedLightingAvailable: extendedLightingShaderAvailable,
    atmosphereAvailable: atmosphereShaderAvailable,
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
    projectorAvailable,
    materialBindGroupLayout: materialBglResult.value,
    meshBindGroupLayout: meshArrayBglResult.value,
    viewUniformBuffer: viewUboResult.value,
    get pointsLinesViewBuffer() {
      return pointsLinesView.buffer;
    },
    ensurePointsLinesViewCapacity: pointsLinesView.ensureCapacity,
    shadowCasterCascadeBuffer: shadowCasterCascadeUboResult.value,
    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 /
    materialUniformBuffer: meshSsboState.material,
    meshStorageBuffer: meshSsboState.mesh,
    instancesBindGroupLayout: instancesBglResult.value,
    probeInstancesBindGroupLayout: probeInstancesBglResult.value,
    identityInstanceBuffer: identityInstanceResult.value,
    defaultSampler: defaultSamplerResult.value,
    surfaceMediumDepthSampler: surfaceMediumDepthSamplerResult.value,
    fallbackTextureView: fallbackTextureViewResult.value,
    defaultWhiteTextureView: fallbackTextureViewResult.value,
    // Exactly neutral half-float RG=(0.5,0.5) decodes to tangent (0,0,1).
    // Distinct from defaultWhiteTextureView because RG=(255,255)=1.0 gives
    // sqrt(1 - 1 - 1) = NaN, breaking the no-normal-map case.
    defaultNormalTextureView: fallbackNormalTextureViewResult.value,
    // feat-20260519-tonemap-reinhard-mvp M2 / T-M2.5: HDR fallback for the
    // built-in unlit pipeline (rgba16float colour attachment). Standard
    // material variants are resolved by the material-shader cache.
    unlitPipelineHdr: getCachedPipelineOrNull('forgeax::default-unlit', true, 1),
    // feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1):
    // 1x1 depth32float fallback bound at viewBindGroup binding(3).
    shadowFallbackTextureView: shadowFallbackViewResult.value,
    shadowArrayFallbackTextureView,
    ...layeredTextureFallback,
    ...extendedLightingFallback,
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 1x1x6
    // depth32float cube_array fallback bound at viewBindGroup binding(5)
    // when no PointLightShadow snapshots are active. Always-present
    // (24 B GPU footprint); ShadowAtlas takes over when a real frame has
    // pointShadowSnapshots.length > 0.
    shadowAtlasFallbackTextureView: shadowAtlasFallbackViewResult.value,
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 64 B point
    // shadow params UBO bound at viewBindGroup binding(6). Written per
    // frame from `frameState.pointShadowSnapshots`.
    shadowParamsBuffer: shadowParamsBufferResult.value,
    // feat-20260625-spot-light-shadow-mapping w25: the spot lightViewProj
    // matrices fold into the View UBO tail (`view.spotLightViewProj`); no
    // dedicated buffer / view-BG binding 9 (WebGL2 uniform-buffer budget).
    skylightFallback,
    perPassResources: createReadyPerPassResources({
      fxaaPipeline: fxaaPipelineHandle,
      fxaaBindGroupLayout: fxaaBglHandle,
      fxaaSampler: fxaaSamplerHandle,
      skyboxPipeline: skyboxPipelineHandle,
      skyboxPipelineMsaa: skyboxPipelineMsaaHandle,
      skyboxBindGroupLayout: skyboxBglHandle,
      skyboxSampler: skyboxSamplerHandle,
      skyboxRotationBuffer: skyboxRotationBufferHandle,
      shadowSampler: shadowSamplerResult.value,
      shadowLightSpaceMatrix: null,
      shadowCsmLightViewProj: null,
      shadowCsmSelection: null,
      // Multiscale Bloom pipeline handles are generation-owned by the ready
      // builder; graph targets are frame-owned and are not stored here.
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
      ensureBloomResources: ensureBloomResourcesStable,
      getBloomResources: getBloomResourcesStable,
      commitBloomResources: commitBloomResourcesStable,
      commitBloomFrameReceipts: (receipts) => {
        lastSuccessfulBloomReceipts = receipts;
      },
      discardBloomResources: discardBloomResourcesStable,
      retireBloomResources: retireBloomResourcesStable,
      drainBloomResources: drainBloomResourcesStable,
      inspectBloomResources: inspectBloomResourcesStable,
      // feat-20260612-hdrp-ssao M6 / w26 + M8 / w38: SSAO pipeline slots.
      ssaoCalcPipeline: ssaoCalcPipelineHandle,
      ssaoBlurPipeline: ssaoBlurPipelineHandle,
      ssaoBgl: ssaoBglHandle,
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
