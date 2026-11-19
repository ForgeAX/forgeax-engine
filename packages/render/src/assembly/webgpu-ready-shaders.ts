import { manifestShaderSource, materialShaderSource } from '@forgeax/engine-shader';
import { type ShaderSource, shaderSourceDescriptor } from '@forgeax/engine-types';
import type { SeedShaderModule } from './material-shader-policy';
// Engine shader roster for one ready device generation: device variant axes,
// manifest entry classification, capability variant patching and the eager
// module compiles that keep first-frame lazy pipelines off async misses.

import type { Result, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import {
  findVariantByDefines,
  findVariantByKey,
  isShaderTemplateManifestRow,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  materialShaderAxes,
  materialShaderPreparedSourceRows,
  materialShaderSourceEquals,
  type ShaderCatalog,
  shaderTemplateVariantEntry,
} from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';
import { atmosphereAvailable, directionalPcssCapable } from '../environment/capability';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import type { GpuDrivenPbrProgram } from '../gpu-driven/pbr-program';
import { setIblComposedShaders } from '../ibl/IblPipelineCache';
import { assertStorageBufferCap } from '../light-buffer-layout';
import { SKIN_MATERIAL_SHADER_ID } from '../pbr-pipeline';
import type { StandardSceneShaderSources } from '../pipeline/standard-deferred-lighting';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import { deriveExtendedLightingCapability } from '../prepare/extended-lighting/resources';
import type { AtmosphereShaderSources } from '../render-contract';
import { selectCloudShadowCompatibleEntry } from './cloud-shadow-entry';
import {
  invokeDeviceCreateShaderModule,
  prepareLowLimitMaterialShaderEntry,
} from './material-shader-policy';
import { runShimStep } from './renderer-helpers';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES, selectBootVariant } from './shader-prewarm-policy';
import { ATMOSPHERE_SHADER_STAGES, prewarmUtilityShaders } from './utility-shader-prewarm';

export type AsyncCreateShaderModule = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, RhiError>>;

/** Compile one module or throw its structured failure; seeding stays with the caller. */
export type CompileShaderModule = (
  code: string | ShaderSource,
  label: string,
  expected: string,
  hint: string,
) => Promise<ShaderModule>;

/**
 * Eagerly compiled engine modules. A null module means its manifest entry is
 * absent (the camera-only empty manifest leaves every module null) and the
 * dependent pipeline stays null.
 */
export interface EngineShaderModules {
  readonly pbr: ShaderModule | null;
  readonly unlit: ShaderModule | null;
  readonly sprite: ShaderModule | null;
  readonly spriteLit: ShaderModule | null;
  readonly fxaa: ShaderModule | null;
  readonly skybox: ShaderModule | null;
  readonly bloomHorizontal: ShaderModule | null;
  readonly bloomVertical: ShaderModule | null;
  readonly bloomComposite: ShaderModule | null;
  readonly ssao: ShaderModule | null;
  readonly ssaoGBufferV2?: boolean;
  readonly gtaoGBufferV2?: boolean;
  readonly gtaoCompute: ShaderModule | null;
  readonly gpuDrivenPbrPrograms: ReadonlyMap<string, GpuDrivenPbrProgram>;
}

export function emptyEngineShaderModules(): EngineShaderModules {
  return {
    pbr: null,
    unlit: null,
    sprite: null,
    spriteLit: null,
    fxaa: null,
    skybox: null,
    bloomHorizontal: null,
    bloomVertical: null,
    bloomComposite: null,
    ssao: null,
    gtaoCompute: null,
    gpuDrivenPbrPrograms: new Map(),
  };
}

/** Variant axes this device generation compiles its engine programs for. */
export interface ReadyDeviceCapabilities {
  readonly storageBuffer: boolean;
  readonly webgl2Downlevel: boolean;
  readonly extendedLighting: boolean;
  readonly atmosphere: boolean;
  readonly directionalPcss: boolean;
  readonly projector: boolean;
}

/** Shader and layout construction consume the same storage capability. */
export function deriveReadyDeviceCapabilities(device: RhiDevice): ReadyDeviceCapabilities {
  const extendedLighting = deriveExtendedLightingCapability(device).admitted;
  const capValue = device.limits.maxStorageBuffersPerShaderStage;
  const webgl2Downlevel = device.caps.backendKind === 'wgpu-webgl2';
  let storageBuffer = !webgl2Downlevel && device.caps.storageBuffer;
  if (typeof capValue === 'number') {
    const capCheck = assertStorageBufferCap(capValue);
    storageBuffer = capCheck.ok && !webgl2Downlevel && device.caps.storageBuffer && capCheck.value;
  }
  return {
    storageBuffer,
    webgl2Downlevel,
    extendedLighting,
    atmosphere: atmosphereAvailable(storageBuffer, device.limits.maxSampledTexturesPerShaderStage),
    directionalPcss: directionalPcssCapable(device.caps.backendKind),
    projector:
      (device.limits.maxSampledTexturesPerShaderStage ?? 0) >=
      STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  };
}

/** rhi-webgpu supplies an async factory; other backends use the synchronous device entry. */
export function createShaderModuleResult(
  device: RhiDevice,
  asyncCreateShaderModule: AsyncCreateShaderModule | undefined,
  code: string | ShaderSource,
  label: string,
  expected: string,
  hint: string,
): Promise<Result<ShaderModule, RhiError>> {
  return runShimStep(
    () =>
      asyncCreateShaderModule
        ? asyncCreateShaderModule(device, shaderSourceDescriptor(code, label))
        : invokeDeviceCreateShaderModule(device, shaderSourceDescriptor(code, label)),
    'shader-compile-failed',
    expected,
    hint,
  );
}

export async function compileShaderModule(
  device: RhiDevice,
  asyncCreateShaderModule: AsyncCreateShaderModule | undefined,
  code: string | ShaderSource,
  label: string,
  expected: string,
  hint: string,
): Promise<ShaderModule> {
  const result = await createShaderModuleResult(
    device,
    asyncCreateShaderModule,
    code,
    label,
    expected,
    hint,
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/** Compile an optional engine manifest entry under its conventional diagnostics. */
export async function compileManifestModule(
  compile: CompileShaderModule,
  entry: ManifestEntry | undefined,
  label: string,
): Promise<ShaderModule | null> {
  if (entry === undefined) return null;
  return compile(
    entry.wgsl,
    label,
    `${label} shader module compiled`,
    `inspect manifest ${label} entry composed wgsl; check device.features`,
  );
}

export function findMaterialShaderEntry(
  registry: ShaderCatalog,
  identifier: string,
): MaterialShaderManifestEntry | undefined {
  return [...registry.materialShaderManifestEntries()].find(
    (entry) => entry.identifier === identifier,
  );
}

/** Resolve a reserved engine material identity to its flat manifest entry. */
export function findEngineManifestEntry(
  registry: ShaderCatalog,
  manifestEntries: readonly ManifestEntry[],
  identifier: string,
): ManifestEntry | undefined {
  const named = manifestEntries.find(
    (entry) => entry.identifier === identifier && isShaderTemplateManifestRow(entry),
  );
  if (named !== undefined) return named;
  const materialEntry = findMaterialShaderEntry(registry, identifier);
  if (materialEntry === undefined) return undefined;
  return (
    manifestEntries.find((entry) => entry.wgsl === materialEntry.composedWgsl) ?? {
      hash: `engine:${identifier}`,
      wgsl: materialEntry.composedWgsl,
      glsl: undefined,
      bindings: '',
    }
  );
}

/** Engine programs found in the flat manifest; absent optional roles stay undefined. */
export interface EngineManifestEntries {
  pbr?: ManifestEntry | undefined;
  pbrSkin?: ManifestEntry | undefined;
  unlit?: ManifestEntry | undefined;
  shadowCaster?: ManifestEntry | undefined;
  tonemap?: ManifestEntry | undefined;
  motionBlur?: ManifestEntry | undefined;
  taaResolve?: ManifestEntry | undefined;
  spriteLit?: ManifestEntry | undefined;
  sprite?: ManifestEntry | undefined;
  iblEquirect?: ManifestEntry | undefined;
  iblIrradiance?: ManifestEntry | undefined;
  iblPrefilter?: ManifestEntry | undefined;
  iblBrdfLut?: ManifestEntry | undefined;
  probeBackground?: ManifestEntry | undefined;
  fxaa?: ManifestEntry | undefined;
  skybox?: ManifestEntry | undefined;
  bloomHorizontal?: ManifestEntry | undefined;
  bloomVertical?: ManifestEntry | undefined;
  bloomComposite?: ManifestEntry | undefined;
  ssao?: ManifestEntry | undefined;
  gtaoCompute?: ManifestEntry | undefined;
}

/** The validated roster: the engine SSOT triple is always present. */
export interface ResolvedEngineManifestEntries extends EngineManifestEntries {
  pbr: ManifestEntry;
  unlit: ManifestEntry;
  tonemap: ManifestEntry;
}

type MarkerRole = Exclude<keyof EngineManifestEntries, 'pbrSkin' | 'shadowCaster'>;

/**
 * Content-marker triage over composed WGSL (explicit failure: a silent wrong
 * entry would mis-shade indistinguishably). Order matters: sprite-lit carries
 * sprite's `pivotAndSize` field, and marker roles precede the unlit fallback.
 */
function markerRoleOf(wgsl: string): MarkerRole {
  if (wgsl.includes('TonemapParams')) return 'tonemap';
  if (wgsl.includes('MotionBlurParams')) return 'motionBlur';
  if (wgsl.includes('fs_taa_resolve')) return 'taaResolve';
  if (wgsl.includes('spriteLitShadeAccum')) return 'spriteLit';
  if (wgsl.includes('pivotAndSize')) return 'sprite';
  if (wgsl.includes('equirectToCube_fs')) return 'iblEquirect';
  if (wgsl.includes('irradianceConvolve_fs')) return 'iblIrradiance';
  if (wgsl.includes('prefilterEnv_fs')) return 'iblPrefilter';
  if (wgsl.includes('brdfLutBake_fs')) return 'iblBrdfLut';
  if (wgsl.includes('probe_background_fs')) return 'probeBackground';
  if (wgsl.includes('f_schlick')) return 'pbr';
  if (wgsl.includes('rgb2luma')) return 'fxaa';
  if (wgsl.includes('skybox_fs')) return 'skybox';
  if (wgsl.includes('BloomHorizontalParams')) return 'bloomHorizontal';
  if (wgsl.includes('BloomVerticalParams')) return 'bloomVertical';
  if (wgsl.includes('BloomCompositeParams')) return 'bloomComposite';
  if (wgsl.includes('cs_gtao_calc')) return 'gtaoCompute';
  if (wgsl.includes('fs_ssao_calc')) return 'ssao';
  return 'unlit';
}

/** Reserved identities win; content markers fill the remaining roles first-come. */
function classifyEngineManifestEntries(
  registry: ShaderCatalog,
  manifestEntries: readonly ManifestEntry[],
): EngineManifestEntries {
  const found: EngineManifestEntries = {
    pbr: findEngineManifestEntry(registry, manifestEntries, 'forgeax::default-standard-pbr'),
    pbrSkin:
      findEngineManifestEntry(registry, manifestEntries, SKIN_MATERIAL_SHADER_ID) ??
      findEngineManifestEntry(registry, manifestEntries, 'forgeax::default-standard-pbr-skin'),
    unlit: findEngineManifestEntry(registry, manifestEntries, 'forgeax::default-unlit'),
    shadowCaster: findEngineManifestEntry(
      registry,
      manifestEntries,
      'forgeax::default-shadow-caster',
    ),
  };
  for (const entry of manifestEntries) {
    const role =
      entry.role ?? (isShaderTemplateManifestRow(entry) ? undefined : markerRoleOf(entry.wgsl));
    if (role !== undefined) found[role] ??= entry;
  }
  return found;
}

/** Null is structural-only; real backends require the shipped manifest triple. */
function requireEngineTriple(
  found: EngineManifestEntries,
  backendKind: RhiDevice['caps']['backendKind'],
): ResolvedEngineManifestEntries {
  if (backendKind === 'null') {
    found.pbr ??= nullBackendEntry('null-pbr');
    found.unlit ??= nullBackendEntry('null-unlit');
    found.tonemap ??= nullBackendEntry('null-tonemap');
  }
  const { pbr, unlit, tonemap } = found;
  if (pbr === undefined || unlit === undefined || tonemap === undefined) {
    throw new RhiError({
      code: 'shader-compile-failed',
      expected:
        'manifest entries include pbr.wgsl + unlit.wgsl + tonemap.wgsl (engine SSOT triple)',
      hint: 'publish a shader manifest containing pbr.wgsl, unlit.wgsl, and tonemap.wgsl',
    });
  }
  return { ...found, pbr, unlit, tonemap };
}

function nullBackendEntry(hash: string): ManifestEntry {
  return { hash, wgsl: '', glsl: '', bindings: '' };
}

type VariantDefines = MaterialShaderManifestVariant['defines'];

/** An optional variant axis is either absent from the program or set to `value`. */
function axisAbsentOr(defines: VariantDefines, axis: string, value: boolean): boolean {
  return !(axis in defines) || defines[axis] === value;
}

/** Boot excludes optional draw lanes; storage fallback additionally excludes atmosphere. */
function bootVariantConstraints(
  caps: ReadyDeviceCapabilities,
  storageFallback: boolean,
): Readonly<Record<string, boolean>> {
  return {
    STORAGE_BUFFER_AVAILABLE: storageFallback ? false : caps.storageBuffer,
    ATMOSPHERE_AVAILABLE: storageFallback ? false : caps.atmosphere,
    DIRECTIONAL_PCSS_AVAILABLE: caps.directionalPcss,
    PROJECTOR_AVAILABLE: caps.projector,
    WATER_WAVES_AVAILABLE: false,
    WATER_INFO_RGBA16: false,
    COVERAGE_ONLY: false,
    VISIBLE_SURFACE_AVAILABLE: false,
    ALPHA_MASK: false,
    DIRECTIONAL_SHADOW_SIMPLE: false,
    LEAN_LIGHTING: false,
    STANDARD_LEAN_INPUTS: false,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
    GPU_SCENE_DIRECT: false,
    PROBE_BLEND_AVAILABLE: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    VERTEX_COLOR_AVAILABLE: false,
    REFLECTION_FALLBACK_AVAILABLE: false,
    SKINNING_DISABLED: true,
    ...(storageFallback
      ? {}
      : { EXTENDED_LIGHTING_AVAILABLE: caps.extendedLighting, TRANSMISSION_AVAILABLE: false }),
  };
}

/** Select one legal boot declaration without expanding a source family's feature matrix. */
function variantWgslByIdentifier(
  registry: ShaderCatalog,
  caps: ReadyDeviceCapabilities,
  storageFallback = false,
): ReadonlyMap<string, MaterialShaderManifestVariant> {
  const wgslById = new Map<string, MaterialShaderManifestVariant>();
  const constraints = bootVariantConstraints(caps, storageFallback);
  const requests = Object.entries(constraints);
  for (const materialEntry of registry.materialShaderManifestEntries()) {
    if (!BOOT_MATERIAL_IDENTIFIERS.has(materialEntry.identifier)) continue;
    let exact: MaterialShaderManifestVariant | undefined;
    if (isShaderTemplateManifestRow(materialEntry)) {
      const axes = new Set(materialShaderAxes(materialEntry));
      if (!axes.has('STORAGE_BUFFER_AVAILABLE')) continue;
      exact = findVariantByDefines(
        materialEntry,
        Object.fromEntries(requests.filter(([axis]) => axes.has(axis))),
      );
    } else {
      exact = materialEntry.variants.find(
        ({ defines }) =>
          defines.STORAGE_BUFFER_AVAILABLE === constraints.STORAGE_BUFFER_AVAILABLE &&
          requests.every(([axis, value]) => axisAbsentOr(defines, axis, value)),
      );
    }
    const variant =
      exact === undefined ? undefined : findVariantByKey(materialEntry, exact.definesKey);
    if (variant !== undefined) wgslById.set(materialEntry.identifier, variant);
  }
  return wgslById;
}

const BOOT_MATERIAL_IDENTIFIERS = new Set([
  'forgeax::default-standard-pbr',
  SKIN_MATERIAL_SHADER_ID,
  'forgeax::default-standard-pbr-skin',
  'forgeax::default-unlit',
  'forgeax::default-shadow-caster',
  'forgeax::sprite',
  'forgeax::sprite-lit',
]);

function patchEntry(
  entry: ManifestEntry,
  wgslById: ReadonlyMap<string, MaterialShaderManifestVariant>,
  identifier: string,
): ManifestEntry {
  const variant = wgslById.get(identifier);
  return variant === undefined
    ? entry
    : (shaderTemplateVariantEntry(entry, variant) ?? { ...entry, wgsl: variant.composedWgsl });
}

/** WebGL2 compiles the storage=false variants against its uniform fallback layouts. */
function applyStorageFallbackVariants(
  registry: ShaderCatalog,
  entries: ResolvedEngineManifestEntries,
  caps: ReadyDeviceCapabilities,
): void {
  const wgslById = variantWgslByIdentifier(registry, caps, true);
  entries.pbr = patchEntry(entries.pbr, wgslById, 'forgeax::default-standard-pbr');
  entries.unlit = patchEntry(entries.unlit, wgslById, 'forgeax::default-unlit');
  if (entries.shadowCaster !== undefined)
    entries.shadowCaster = patchEntry(
      entries.shadowCaster,
      wgslById,
      'forgeax::default-shadow-caster',
    );
  if (entries.sprite !== undefined)
    entries.sprite = patchEntry(entries.sprite, wgslById, 'forgeax::sprite');
  if (entries.spriteLit !== undefined)
    entries.spriteLit = patchEntry(entries.spriteLit, wgslById, 'forgeax::sprite-lit');
}

/** Canonical sources may declare optional vertex inputs absent from the boot layout. */
function applyRuntimeVariants(
  registry: ShaderCatalog,
  entries: ResolvedEngineManifestEntries,
  caps: ReadyDeviceCapabilities,
): void {
  const wgslById = variantWgslByIdentifier(registry, caps);
  entries.pbr = selectCloudShadowCompatibleEntry(
    patchEntry(entries.pbr, wgslById, 'forgeax::default-standard-pbr'),
    findMaterialShaderEntry(registry, 'forgeax::default-standard-pbr'),
    caps.projector,
  );
  if (entries.pbrSkin !== undefined) {
    const skinMaterialEntry = [...registry.materialShaderManifestEntries()].find(
      (entry) =>
        entry.identifier === SKIN_MATERIAL_SHADER_ID ||
        entry.identifier === 'forgeax::default-standard-pbr-skin',
    );
    entries.pbrSkin = selectCloudShadowCompatibleEntry(
      patchEntry(
        patchEntry(entries.pbrSkin, wgslById, SKIN_MATERIAL_SHADER_ID),
        wgslById,
        'forgeax::default-standard-pbr-skin',
      ),
      skinMaterialEntry,
      caps.projector,
    );
  }
  entries.unlit = patchEntry(entries.unlit, wgslById, 'forgeax::default-unlit');
  if (entries.shadowCaster !== undefined)
    entries.shadowCaster = patchEntry(
      entries.shadowCaster,
      wgslById,
      'forgeax::default-shadow-caster',
    );
  if (entries.sprite !== undefined)
    entries.sprite = patchEntry(entries.sprite, wgslById, 'forgeax::sprite');
  if (entries.spriteLit !== undefined)
    entries.spriteLit = patchEntry(entries.spriteLit, wgslById, 'forgeax::sprite-lit');
}

/**
 * The per-entity sprite path seeds `module-forgeax::sprite` from the eager
 * compile, so it must be the PER_INSTANCE_REGION=false variant; region batches
 * request a distinct `#` label compiled from their own variant.
 */
function applySpriteRegionlessVariant(
  registry: ShaderCatalog,
  entries: ResolvedEngineManifestEntries,
  caps: ReadyDeviceCapabilities,
): void {
  if (entries.sprite === undefined) return;
  const spriteMaterialEntry = findMaterialShaderEntry(registry, 'forgeax::sprite');
  if (spriteMaterialEntry === undefined) return;
  const regionless = selectBootVariant(spriteMaterialEntry, {
    PER_INSTANCE_REGION: false,
    STORAGE_BUFFER_AVAILABLE: caps.storageBuffer,
    ATMOSPHERE_AVAILABLE: caps.atmosphere,
  });
  if (regionless !== undefined)
    entries.sprite = { ...entries.sprite, wgsl: regionless.composedWgsl };
}

/** Classify the flat manifest and patch eager entries to this device's exact variants. */
export function resolveEngineManifestEntries(
  registry: ShaderCatalog,
  manifestEntries: readonly ManifestEntry[],
  backendKind: RhiDevice['caps']['backendKind'],
  caps: ReadyDeviceCapabilities,
): ResolvedEngineManifestEntries {
  const entries = requireEngineTriple(
    classifyEngineManifestEntries(registry, manifestEntries),
    backendKind,
  );
  if (!caps.storageBuffer) applyStorageFallbackVariants(registry, entries, caps);
  applyRuntimeVariants(registry, entries, caps);
  applySpriteRegionlessVariant(registry, entries, caps);
  return entries;
}

/** Publish the generation's compiled IBL programs before resource preparation. */
export function publishIblPrograms(entries: EngineManifestEntries): void {
  const { iblEquirect, iblIrradiance, iblPrefilter, iblBrdfLut, probeBackground } = entries;
  if (
    iblEquirect === undefined ||
    iblIrradiance === undefined ||
    iblPrefilter === undefined ||
    iblBrdfLut === undefined
  )
    return;
  setIblComposedShaders({
    equirectToCube: iblEquirect.wgsl,
    irradiance: iblIrradiance.wgsl,
    prefilter: iblPrefilter.wgsl,
    brdfLut: iblBrdfLut.wgsl,
    ...(probeBackground === undefined ? {} : { probeBackground: probeBackground.wgsl }),
  });
}

/**
 * Points/Lines are an engine-owned record path, not a producer feature, so they
 * cannot declare `requiredMaterialShaders`; prewarm their optional artifact so
 * a first frame cannot silently skip its draw behind an async module compile.
 */
export async function prewarmPointsLinesProgram(
  registry: ShaderCatalog,
  compile: CompileShaderModule,
  seed: SeedShaderModule,
): Promise<void> {
  const lookup = registry.findMaterialArtifact(POINTS_LINES_MATERIAL_SHADER_ID);
  if (!lookup.ok) return;
  const label = `module-${POINTS_LINES_MATERIAL_SHADER_ID}`;
  const module = await compile(
    lookup.value.source,
    label,
    `engine material shader '${POINTS_LINES_MATERIAL_SHADER_ID}' compiled`,
    `inspect the composed WGSL for '${POINTS_LINES_MATERIAL_SHADER_ID}' and check device.features`,
  );
  seed(label, module, lookup.value.program.sourceReference);
}

/** Fullscreen feature modules compiled before the first synchronous frame. */
export async function prewarmFullscreenPostProcesses(
  postProcesses: readonly { readonly identity: string; readonly source: string }[],
  compile: CompileShaderModule,
  seed: SeedShaderModule,
): Promise<void> {
  for (const postProcess of postProcesses) {
    const label = postProcessShaderModuleLabel(postProcess);
    const module = await compile(
      postProcess.source,
      label,
      `declared fullscreen render feature '${postProcess.identity}' compiled`,
      `inspect the composed WGSL for '${postProcess.identity}' and check device.features`,
    );
    seed(label, module, postProcess.source);
  }
}

type CompileUtilityShader = (
  label: string,
  source: string | ShaderSource,
  context: string,
) => Promise<ShaderModule>;

const STANDARD_COMPANION_PROGRAMS = [
  ['forwardScreenPack', 'forgeax::engine-forward-screen-pack'],
  ['forwardScreenCompose', 'forgeax::engine-forward-screen-compose'],
  ['forwardContact', 'forgeax::engine-forward-contact-shadow'],
  ['shadowVariance', 'forgeax::engine-shadow-variance'],
  ['decalProject', 'forgeax::engine-decal-project'],
  ['decalApply', 'forgeax::engine-decal-apply'],
  ['subsurface', 'forgeax::engine-subsurface-diffusion'],
] as const;

/** Deferred lighting variants plus their decal/subsurface companions, or undefined when absent. */
export async function prewarmStandardScenePrograms(
  registry: ShaderCatalog,
  compileUtility: CompileUtilityShader,
  seed: SeedShaderModule,
  caps: ReadyDeviceCapabilities,
): Promise<StandardSceneShaderSources | undefined> {
  const deferred = findMaterialShaderEntry(registry, 'forgeax::engine-standard-deferred-lighting');

  const declarations = [...registry.entries()];
  const contractFor = (material: MaterialShaderManifestEntry | undefined) => {
    if (material === undefined) return undefined;
    const declared = declarations.find((entry) => entry.identifier === material.identifier);
    if (declared !== undefined) return declared.programContract;
    const hash = material.hash;
    return hash === undefined
      ? undefined
      : declarations.find((entry) => entry.hash === hash)?.programContract;
  };
  let gbufferCompatible = contractFor(deferred)?.gbuffer === 'standard-gbuffer/2';
  const resolve = async (clustered: boolean, directDfgLut = false): Promise<ShaderSource> => {
    if (deferred === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'published Deferred lighting',
        hint: 'Rebuild the Engine shader manifest.',
      });
    const variant = deferred.variants.find((candidate) =>
      isDeferredLightingVariant(candidate.defines, clustered, directDfgLut, caps),
    );
    if (variant === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'capability-matched deferred lighting variant',
        hint: 'rebuild the Engine shader manifest',
      });
    const label = `standard_deferred_${clustered}_${directDfgLut}`;
    seed(
      label,
      await compileUtility(label, materialShaderSource(variant), 'Deferred'),
      materialShaderSource(variant),
    );
    return materialShaderSource(variant);
  };
  const companions: {
    forwardScreenPack?: ShaderSource;
    forwardScreenCompose?: ShaderSource;
    forwardContact?: ShaderSource;
    shadowVariance?: ShaderSource;
    decalProject?: ShaderSource;
    decalApply?: ShaderSource;
    subsurface?: ShaderSource;
  } = {};
  for (const [field, identifier] of STANDARD_COMPANION_PROGRAMS) {
    if (!caps.storageBuffer && (field === 'shadowVariance' || field === 'subsurface')) continue;
    const entry = findMaterialShaderEntry(registry, identifier);
    if (entry === undefined) continue;
    if (
      (field === 'decalProject' || field === 'decalApply' || field === 'subsurface') &&
      contractFor(entry)?.gbuffer !== 'standard-gbuffer/2'
    )
      gbufferCompatible = false;
    const source = materialShaderSource(entry.variants[0] ?? entry);
    seed(
      identifier,
      await compileUtility(identifier, source, field === 'subsurface' ? 'Subsurface' : 'Decal'),
      source,
    );
    companions[field] = source;
  }
  return {
    ...companions,
    ...(gbufferCompatible ? { gbuffer: 'standard-gbuffer/2' as const } : {}),
    ...(caps.storageBuffer && deferred !== undefined
      ? {
          deferred: {
            clustered: await resolve(true),
            unclustered: await resolve(false),
            ...(deferred.variants.some(
              (variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === true,
            )
              ? {
                  clusteredLut: await resolve(true, true),
                  unclusteredLut: await resolve(false, true),
                }
              : {}),
          },
        }
      : {}),
  };
}

function isDeferredLightingVariant(
  defines: VariantDefines,
  clustered: boolean,
  directDfgLut: boolean,
  caps: ReadyDeviceCapabilities,
): boolean {
  return (
    defines.CLUSTER_FORWARD_AVAILABLE === clustered &&
    (defines.DIRECT_DFG_LUT_AVAILABLE ?? false) === directDfgLut &&
    (defines.ATMOSPHERE_AVAILABLE ?? false) === caps.atmosphere &&
    defines.EXTENDED_LIGHTING_AVAILABLE === caps.extendedLighting &&
    defines.PROJECTOR_AVAILABLE === caps.projector
  );
}

/** Atmosphere sources plus the shared environment PMREM program they require. */
export async function prewarmAtmospherePrograms(
  manifestEntries: readonly ManifestEntry[],
  compileUtility: CompileUtilityShader,
  seed: SeedShaderModule,
): Promise<AtmosphereShaderSources | undefined> {
  const sources = await prewarmUtilityShaders(
    'analytic-atmosphere',
    ATMOSPHERE_SHADER_STAGES,
    manifestEntries,
    (label, source) => compileUtility(label, source, 'Atmosphere'),
    seed,
  );
  if (sources === undefined) return undefined;
  const prefilter = manifestEntries.find((entry) =>
    isShaderTemplateManifestRow(entry)
      ? entry.role === 'iblPrefilter'
      : entry.entryPoints === undefined
        ? entry.wgsl.includes('fn prefilterEnv_fs(')
        : entry.entryPoints.some((point) => point.name === 'prefilterEnv_fs'),
  );
  if (prefilter === undefined) {
    throw new RhiError({
      code: 'shader-compile-failed',
      expected: 'Atmosphere uses the shared environment PMREM program',
      hint: 'include ibl-prefilter in the Engine shader manifest',
    });
  }
  seed(
    'ibl-prefilter',
    await compileUtility('ibl-prefilter', manifestShaderSource(prefilter), 'Atmosphere'),
    manifestShaderSource(prefilter),
  );
  return { ...sources, prefilter: manifestShaderSource(prefilter) };
}

/**
 * Materials with an explicit renderState reach the lazy pipeline path under a
 * variant-set label. Reuse the boot PBR module only for byte-identical sources;
 * HDRP and WebGL2 variants keep their own module identities.
 */
export function seedPbrSourceAliases(
  registry: ShaderCatalog,
  pbrSource: string,
  pbrModule: ShaderModule,
  seed: SeedShaderModule,
): void {
  for (const materialEntry of registry.materialShaderManifestEntries()) {
    for (const variant of materialShaderPreparedSourceRows(materialEntry)) {
      if ('definesKey' in variant && materialShaderSourceEquals(variant, pbrSource))
        seed(
          `module-${materialEntry.identifier}#${variant.definesKey}`,
          pbrModule,
          materialShaderSource(variant),
        );
    }
  }
}

/**
 * Seed the eager unlit module under every label a first-frame draw requests:
 * the boot label, the canonical material label and the exact no-color variant;
 * the colored variant composes different WGSL and compiles its own module.
 */
export async function compileUnlitModules(
  registry: ShaderCatalog,
  compile: CompileShaderModule,
  seed: SeedShaderModule,
  caps: ReadyDeviceCapabilities,
  unlitEntry: ManifestEntry,
): Promise<ShaderModule> {
  const unlitModule = await compile(
    unlitEntry.wgsl,
    'unlit',
    'unlit shader module compiled',
    'inspect manifest unlit entry composed wgsl; check device.features',
  );
  seed('unlit', unlitModule, manifestShaderSource(unlitEntry));
  seed('module-forgeax::default-unlit', unlitModule, manifestShaderSource(unlitEntry));
  const unlitMaterialEntry = findMaterialShaderEntry(registry, 'forgeax::default-unlit');
  const variantOf = (vertexColor: boolean, sceneIndex: boolean) =>
    selectBootVariant(unlitMaterialEntry, {
      VERTEX_COLOR_AVAILABLE: vertexColor,
      STORAGE_BUFFER_AVAILABLE: caps.storageBuffer,
      ATMOSPHERE_AVAILABLE: caps.atmosphere,
      WATER_WAVES_AVAILABLE: false,
      WATER_INFO_RGBA16: false,
      COVERAGE_ONLY: false,
      SKINNING_DISABLED: true,
      GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
      GPU_SCENE_DIRECT: false,
    });
  const colored = variantOf(true, false);
  if (colored !== undefined && colored.composedWgsl !== unlitEntry.wgsl) {
    const coloredModule = await compile(
      colored.composedWgsl,
      'unlit-vertex-color',
      'colored unlit shader module compiled',
      'inspect the VERTEX_COLOR_AVAILABLE=true unlit variant and device.features',
    );
    seed(
      `module-forgeax::default-unlit#${colored.definesKey}`,
      coloredModule,
      materialShaderSource(colored),
    );
  }
  const uncolored = variantOf(false, false);
  if (uncolored !== undefined)
    seed(
      `module-forgeax::default-unlit#${uncolored.definesKey}`,
      unlitModule,
      manifestShaderSource(unlitEntry),
    );
  // Opaque unlit rows join the GPU-driven lane on storage devices; keep their
  // first scene-index frame off the lazy module path.
  if (caps.storageBuffer) {
    for (const vertexColor of [false, true]) {
      const scene = variantOf(vertexColor, true);
      if (scene === undefined) continue;
      seed(
        `module-forgeax::default-unlit#${scene.definesKey}`,
        await compile(
          scene.composedWgsl,
          `unlit-scene-index${vertexColor ? '-vertex-color' : ''}`,
          'scene-index unlit shader module compiled',
          'inspect the GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true unlit variant and device.features',
        ),
        materialShaderSource(scene),
      );
    }
  }
  return unlitModule;
}

/**
 * The lazy shadow PSO build hits `module-forgeax::default-shadow-caster` on
 * frame 1. Static (SKINNING_DISABLED=true, canonical `''`) and skinned variants
 * are both prewarmed for the active storage capability; a manifest without a
 * shadow caster keeps the lazy one-frame retry.
 */
export async function prewarmShadowCasterModules(
  registry: ShaderCatalog,
  compile: CompileShaderModule,
  seed: SeedShaderModule,
  caps: ReadyDeviceCapabilities,
  shadowCasterEntry: ManifestEntry | undefined,
): Promise<void> {
  if (shadowCasterEntry === undefined) return;
  const shadowCasterModule = await compile(
    shadowCasterEntry.wgsl,
    'shadow_caster',
    'shadow_caster shader module compiled',
    'inspect manifest shadow_caster entry composed wgsl; check device.features',
  );
  seed(
    'module-forgeax::default-shadow-caster',
    shadowCasterModule,
    manifestShaderSource(shadowCasterEntry),
  );
  const shadowFamily = findMaterialShaderEntry(registry, 'forgeax::default-shadow-caster');
  // Native programs are selected by the actual caster's geometry and coverage.
  // The ordinary material adapter owns readiness on first use; a device boot
  // must not prepare every unused skin/color/alpha/scene-address combination.
  if (shadowFamily !== undefined && isShaderTemplateManifestRow(shadowFamily)) return;
  const activeVariants = findMaterialShaderEntry(
    registry,
    'forgeax::default-shadow-caster',
  )?.variants.filter(
    (variant) =>
      variant.defines.STORAGE_BUFFER_AVAILABLE === caps.storageBuffer &&
      axisAbsentOr(variant.defines, 'ATMOSPHERE_AVAILABLE', caps.atmosphere) &&
      typeof variant.defines.SKINNING_DISABLED === 'boolean',
  );
  for (const variant of activeVariants ?? []) {
    if (variant.definesKey === '') {
      seed(
        'module-forgeax::default-shadow-caster#',
        shadowCasterModule,
        manifestShaderSource(shadowCasterEntry),
      );
      continue;
    }
    const variantModule = await compile(
      variant.composedWgsl,
      `shadow_caster#${variant.definesKey}`,
      `shadow_caster variant ${variant.definesKey || '<default>'} compiled`,
      'inspect the selected shadow_caster storage/skinning variant and device.features',
    );
    seed(
      `module-forgeax::default-shadow-caster#${variant.definesKey}`,
      variantModule,
      materialShaderSource(variant),
    );
  }
}

/**
 * Sprite shares the generic per-MaterialShader lazy build, so its eager module
 * is seeded under `module-forgeax::sprite`; region batches use their own label.
 */
export async function compileSpriteModules(
  registry: ShaderCatalog,
  compile: CompileShaderModule,
  seed: SeedShaderModule,
  caps: ReadyDeviceCapabilities,
  spriteEntry: ManifestEntry | undefined,
): Promise<ShaderModule | null> {
  const spriteModule = await compileManifestModule(compile, spriteEntry, 'sprite');
  if (spriteModule === null || spriteEntry === undefined) return null;
  seed('module-forgeax::sprite', spriteModule, manifestShaderSource(spriteEntry));
  const regionVariant = selectBootVariant(findMaterialShaderEntry(registry, 'forgeax::sprite'), {
    PER_INSTANCE_REGION: true,
    STORAGE_BUFFER_AVAILABLE: caps.storageBuffer,
    ATMOSPHERE_AVAILABLE: caps.atmosphere,
  });
  if (regionVariant !== undefined) {
    const regionModule = await compile(
      regionVariant.composedWgsl,
      `sprite#${regionVariant.definesKey}`,
      `sprite variant ${regionVariant.definesKey || '<default>'} compiled`,
      'inspect the selected sprite PER_INSTANCE_REGION variant and device.features',
    );
    seed(
      `module-forgeax::sprite#${regionVariant.definesKey}`,
      regionModule,
      materialShaderSource(regionVariant),
    );
  }
  return spriteModule;
}

/**
 * Sprite-lit selects its Standard capability variant at record time; warm every
 * device-matched variant from the same capability-adjusted source the lazy
 * pipeline uses, so its shared label never retains unavailable cloud bindings.
 */
export async function compileSpriteLitModules(
  device: RhiDevice,
  registry: ShaderCatalog,
  compile: CompileShaderModule,
  seed: SeedShaderModule,
  caps: ReadyDeviceCapabilities,
  spriteLitEntry: ManifestEntry | undefined,
): Promise<ShaderModule | null> {
  if (spriteLitEntry === undefined) return null;
  const sampledTextureLimit = device.limits.maxSampledTexturesPerShaderStage;
  const source = prepareLowLimitMaterialShaderEntry(
    { source: spriteLitEntry.wgsl },
    sampledTextureLimit,
  ).source;
  const spriteLitModule = await compile(
    source,
    'sprite-lit',
    'sprite-lit shader module compiled',
    'inspect manifest sprite-lit entry composed wgsl; check device.features',
  );
  seed('module-forgeax::sprite-lit', spriteLitModule, source);
  const spriteFamily = findMaterialShaderEntry(registry, 'forgeax::sprite-lit');
  if (spriteFamily !== undefined && isShaderTemplateManifestRow(spriteFamily))
    return spriteLitModule;
  const modulesBySource = new Map<string, ShaderModule>([[source, spriteLitModule]]);
  const variants = findMaterialShaderEntry(registry, 'forgeax::sprite-lit')?.variants ?? [];
  for (const variant of variants) {
    if (variant.defines.STORAGE_BUFFER_AVAILABLE !== caps.storageBuffer) continue;
    if (!axisAbsentOr(variant.defines, 'ATMOSPHERE_AVAILABLE', caps.atmosphere)) continue;
    const moduleLabel = `module-forgeax::sprite-lit#${variant.definesKey}`;
    const variantSource = prepareLowLimitMaterialShaderEntry(
      { source: variant.composedWgsl },
      sampledTextureLimit,
    ).source;
    let variantModule = modulesBySource.get(variantSource);
    if (variantModule === undefined) {
      variantModule = await compile(
        variantSource,
        moduleLabel,
        `sprite-lit variant ${variant.definesKey || '<default>'} compiled`,
        'inspect the selected sprite-lit Standard capability variant and device.features',
      );
      modulesBySource.set(variantSource, variantModule);
    }
    seed(moduleLabel, variantModule, variantSource);
  }
  return spriteLitModule;
}
