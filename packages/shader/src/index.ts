// @forgeax/engine-shader — runtime shader registry public surface.
//
// Shape rules (plan-strategy §S-10 / D-R10 / OQ-5 close):
// - instance-per-engine — exposed through the lazy `engine.shader:
//   ShaderRegistry` property; module-level singletons / static methods are
//   forbidden (aligned with `Engine.create({ rhi })`'s instance-based style).
// - Physical isolation — this package's deps only contain `@forgeax/engine-rhi` +
//   `@forgeax/engine-types`; importing `@forgeax/engine-shader-compiler` / `@forgeax/engine-naga`
//   / `@forgeax/engine-wgpu-wasm` directly or transitively is **forbidden**
//   (guarded by the AC-06 triple-grep gate; feat-20260511-naga-rhi-wgpu-merge
//   M4 replaced the legacy single-shim ban with the merged ban triple above).
// - Result model — expected failures go through
//   `Result.err(RhiError | ShaderError)` and **never throw** (AGENTS.md
//   "Errors are structured" / charter proposition 4: explicit failure).
//
// Top-level surface (charter proposition 1: progressive disclosure):
// - ShaderRegistry / ShaderRegistryOptions / ShaderRegistryDevice — main class
//   + injection interface
// - ShaderError / ShaderErrorCode / 2 factories — runtime error types
// - Result<T, E> + ok / err — binary result type and constructors
// - ManifestEntry — re-exported from `@forgeax/engine-types` (manifest schema SSOT)

export type { ManifestEntry, ParamSchemaEntry } from '@forgeax/engine-types';
export { DIRECT_DFG_LUT_SIZE, directDfgLutBytes } from './direct-dfg-lut-data.js';
export {
  expandShaderManifestPublication,
  materialShaderSourceEquals,
  materialShaderSourceMatches,
  readShaderManifestPublication,
  SHADER_MANIFEST_PUBLICATION_VERSION,
  shaderSourceDigestInput,
} from './manifest-publication.js';

import type { MaterialAsset, MaterialParameter, MaterialValue } from '@forgeax/engine-types';
import { standardSurfaceParameters, unlitMaterialParameters } from '@forgeax/engine-types';
import { STANDARD_PBR_ALPHA_CUTOFF_DEFAULT } from './material-schemas.js';

export { MATERIAL_PARAM_TYPES } from '@forgeax/engine-types';
export {
  err,
  manifestMalformed,
  materialShaderNotFound,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
  shaderNotFound,
} from './errors.js';
export {
  generateLtcTables,
  hashLtcTable,
  LTC_SOURCE_PROVENANCE,
  LTC_TABLE_HASHES,
  LTC_TABLE_HEIGHT,
  LTC_TABLE_WIDTH,
  LTC_TABLES,
} from './ltc/tables.js';
export {
  type MaterialArtifactConflictError,
  type MaterialArtifactInspection,
  MaterialArtifactRegistry,
  type MaterialRuntimeArtifact,
} from './material/artifact-registry.js';
export {
  createMaterialProgramArtifactReceipt,
  createStandardPbrArtifactReceipt,
  GPU_DRIVEN_MATERIAL_ROW_BYTES,
  type MaterialShaderArtifact,
} from './material/artifact-types.js';
export {
  DEFAULT_MSDF_TEXT_PARAM_SCHEMA,
  DEFAULT_SPRITE_PARAM_SCHEMA,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  PARTICLE_MESH_SURFACE_PARAM_SCHEMA,
  STANDARD_DIRECT_DFG_LUT_BINDING,
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_PBR_ALPHA_CUTOFF_DEFAULT,
  STANDARD_PBR_ARTIFACT_RECEIPT,
  STANDARD_PBR_SKIN_ARTIFACT_RECEIPT,
  STANDARD_PHYSICAL_BINDING_START,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_SAMPLE_REUSE,
  STANDARD_SHARED_TRANSMISSION_DEFINE,
  STANDARD_SHARED_TRANSMISSION_SLOTS,
  STANDARD_SURFACE_DISCARD_LOD_COVERAGE,
  STANDARD_SURFACE_DISCARD_VIEW_CLIPPING,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
  type StandardPhysicalTextureField,
  type StandardSharedTransmissionHost,
  standardPhysicalTextureFields,
  standardProjectionMask,
  standardSampleReuseMask,
  standardSharedTransmissionConflicts,
  standardSharedTransmissionDefines,
  standardTextureMask,
} from './material-schemas.js';
export {
  DEPTH_PYRAMID_SHADER_MODULES,
  FORGEAX_RESERVED_PATH_PREFIX,
  type MaterialShaderEntry,
  type RegisteredMaterialShaderEntry,
  ShaderRegistry,
  ShaderRegistry as ShaderCatalog,
  type ShaderRegistryDevice,
  type ShaderRegistryDevice as ShaderCatalogDevice,
  type ShaderRegistryOptions,
  type ShaderRegistryOptions as ShaderCatalogOptions,
  SSR_SHADER_MODULES,
} from './ShaderRegistry.js';
export {
  findVariantByKey,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
} from './types.js';

export const BUILTIN_MATERIAL_MODULES = {
  standard: 'forgeax_material::standard',
  unlit: 'forgeax_material::unlit',
  sprite: 'forgeax_material::sprite',
} as const;

/**
 * The engine-owned Standard Surface selected by a built-in Standard material.
 * Keep this explicit in the authored pass so the build-time cooker sees the
 * same slot contract as Materials.standard().
 */
export const DEFAULT_STANDARD_SURFACE_MODULE =
  'forgeax_material::default_standard_surface' as const;

export { LIGHT_TEXTURE_RESAMPLE_WGSL } from './light-texture-resample.js';
/**
 * Full-resolution raw-depth producer used by the Standard single-layer
 * medium graph. This is a post-process source rather than a material module:
 * it copies the opaque depth attachment into an independent sampled r32float
 * target before the medium color pass writes scene depth.
 */
export {
  SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL,
  SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL,
  SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL,
} from './single-layer-medium-raw-depth.js';

/** Runtime WGSL for the fixed-cohort, same-frame auto exposure meter. */
export const AUTO_EXPOSURE_METER_WGSL = /* wgsl */ `
struct AutoExposureParameters {
  compensationEv: f32,
  rangeMinEv: f32,
  rangeMaxEv: f32,
  upRate: f32,
  downRate: f32,
  deltaTime: f32,
  fallback: f32,
  generation: f32,
};
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> state: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> candidate: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> parameters: AutoExposureParameters;

var<workgroup> localHistogram: array<atomic<u32>, 256>;
var<workgroup> totals: array<u32, 64>;
var<workgroup> sampleTotal: u32;

fn finite(value: f32) -> bool {
  // Equality rejects NaN; the magnitude bound rejects +/-infinity.
  return value == value && abs(value) <= 3.402823e+37;
}

fn centerWeight(
  block: vec2<u32>,
  center: vec2<f32>,
  inverseExtentSquared: vec2<f32>,
) -> u32 {
  let delta = vec2<f32>(block) - center;
  let distanceSquared =
    delta.x * delta.x * inverseExtentSquared.x +
    delta.y * delta.y * inverseExtentSquared.y;
  if (distanceSquared <= 0.25) { return 3u; }
  if (distanceSquared <= 0.75) { return 2u; }
  return 1u;
}

fn accumulateSample(
  block: vec2<u32>,
  sampleGrid: vec2<u32>,
  dimensions: vec2<u32>,
  center: vec2<f32>,
  extent: vec2<f32>,
) {
  if (block.x >= sampleGrid.x || block.y >= sampleGrid.y) { return; }
  let pixel = min(block * vec2<u32>(4u) + vec2<u32>(2u), dimensions - vec2<u32>(1u));
  let sample = textureLoad(source, vec2<i32>(pixel), 0);
  if (!finite(sample.r) || !finite(sample.g) || !finite(sample.b)) { return; }
  let luminance = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  if (!finite(luminance) || luminance <= 0.0) { return; }
  let bin = min(u32(clamp(log2(luminance) + 12.0, 0.0, 23.999) * (256.0 / 24.0)), 255u);
  atomicAdd(&localHistogram[bin], centerWeight(block, center, extent));
}

@compute @workgroup_size(256, 1, 1)
fn auto_exposure_clear(@builtin(local_invocation_index) localIndex: u32) {
  atomicStore(&histogram[localIndex], 0u);
}

@compute @workgroup_size(256, 1, 1)
fn auto_exposure_histogram(
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let dimensions = textureDimensions(source);
  let sampleGrid = (dimensions.xy + vec2<u32>(3u)) / vec2<u32>(4u);
  let grid = vec2<f32>(sampleGrid);
  let center = (grid - vec2<f32>(1.0)) * 0.5;
  let extent = max(center, vec2<f32>(1.0));
  let inverseExtent = 1.0 / extent;
  let inverseExtentSquared = inverseExtent * inverseExtent;

  // Map the 256 lanes to a 16x16 logical tile. The fixed 4x8 dispatch grid
  // then uses a two-dimensional tile stride to cover every 4x4 sample block.
  atomicStore(&localHistogram[localIndex], 0u);
  workgroupBarrier();
  let localGrid = vec2<u32>(localIndex % 16u, localIndex / 16u);
  let tileSize = vec2<u32>(16u);
  let blockStart = workgroupId.xy * tileSize + localGrid;
  let blockStride = numWorkgroups.xy * tileSize;
  for (var blockY = blockStart.y; blockY < sampleGrid.y; blockY += blockStride.y) {
    for (var blockX = blockStart.x; blockX < sampleGrid.x; blockX += blockStride.x) {
      accumulateSample(
        vec2<u32>(blockX, blockY),
        sampleGrid,
        dimensions,
        center,
        inverseExtentSquared,
      );
    }
  }
  workgroupBarrier();

  // Every lane owns one bin. All local accumulation is complete before the
  // owners atomically publish their finite result to the one global 1KiB map.
  let localCount = atomicLoad(&localHistogram[localIndex]);
  if (localCount > 0u) {
    atomicAdd(&histogram[localIndex], localCount);
  }
}

@compute @workgroup_size(64, 1, 1)
fn auto_exposure_adapt(@builtin(local_invocation_index) localIndex: u32) {
  var total = 0u;
  for (var index = localIndex; index < 256u; index += 64u) {
    total += atomicLoad(&histogram[index]);
  }
  totals[localIndex] = total;
  workgroupBarrier();
  if (localIndex == 0u) {
    var reducedTotal = 0u;
    for (var lane = 0u; lane < 64u; lane += 1u) {
      reducedTotal += totals[lane];
    }
    sampleTotal = reducedTotal;
  }
  workgroupBarrier();
  if (localIndex == 0u) {
    let validParameters =
      finite(parameters.compensationEv) &&
      finite(parameters.rangeMinEv) &&
      finite(parameters.rangeMaxEv) &&
      parameters.rangeMinEv <= parameters.rangeMaxEv &&
      finite(parameters.upRate) &&
      finite(parameters.downRate) &&
      finite(parameters.deltaTime) &&
      parameters.deltaTime >= 0.0 &&
      finite(parameters.fallback) &&
      parameters.fallback > 0.0 &&
      finite(parameters.generation);
    let safeFallback = select(
      1.0,
      parameters.fallback,
      finite(parameters.fallback) && parameters.fallback > 0.0,
    );
    let safeGeneration = select(0.0, parameters.generation, finite(parameters.generation));
    let lowRank = min(sampleTotal, u32(f32(sampleTotal) * 0.05));
    let highRank = min(sampleTotal, max(lowRank + 1u, u32(ceil(f32(sampleTotal) * 0.95))));
    var cumulative = 0u;
    var clippedWeightedLog = 0.0;
    var clippedTotal = 0u;
    for (var index = 0u; index < 256u; index += 1u) {
      let count = atomicLoad(&histogram[index]);
      let begin = cumulative;
      cumulative += count;
      let keptBegin = max(begin, lowRank);
      let keptEnd = min(cumulative, highRank);
      if (keptEnd > keptBegin) {
        let kept = keptEnd - keptBegin;
        clippedTotal += kept;
        clippedWeightedLog += f32(kept) * (-12.0 + (f32(index) + 0.5) * (24.0 / 256.0));
      }
    }
    let averageLog = select(0.0, clippedWeightedLog / f32(clippedTotal), clippedTotal > 0u);
    let measuredExposure = exp2(-averageLog) * 0.18;
    let targetExposure = select(
      safeFallback,
      exp2(clamp(log2(max(measuredExposure, 1e-6)) + parameters.compensationEv, parameters.rangeMinEv, parameters.rangeMaxEv)),
      validParameters && clippedTotal > 0u && finite(measuredExposure),
    );
    let previous = state[0];
    let hasPrevious = validParameters && previous.y > 0.5 && previous.z == safeGeneration && previous.w == safeFallback && finite(previous.x) && previous.x > 0.0;
    let current = select(safeFallback, previous.x, hasPrevious);
    let rate = select(parameters.downRate, parameters.upRate, targetExposure > current);
    let safeRate = select(0.0, rate, finite(rate) && rate >= 0.0);
    let dt = select(0.0, parameters.deltaTime, finite(parameters.deltaTime) && parameters.deltaTime >= 0.0);
    let amount = 1.0 - exp(-safeRate * dt);
    let adapted = select(current, current + (targetExposure - current) * amount, validParameters && finite(targetExposure) && finite(current) && dt > 0.0 && safeRate > 0.0);
    let exposure = select(safeFallback, adapted, finite(adapted) && adapted > 0.0);
    candidate[0] = vec4<f32>(exposure, 1.0, safeGeneration, safeFallback);
    state[0] = candidate[0];
  }
}
`;

/**
 * Material modules whose shader source and parameter contract are owned by
 * the Engine. They live in the runtime ShaderRegistry, so a Pack containing
 * one of these materials carries authored values only and does not require a
 * project material-cook artifact. A Standard pass with a project Surface slot
 * is deliberately excluded: its root composition is project-owned and must
 * arrive with a cooked material publication.
 */
export const ENGINE_MATERIAL_MODULES = [
  'forgeax::default-standard-pbr',
  'forgeax::standard-terrain',
  'forgeax::standard-terrain-ids',
  'forgeax::standard-terrain-shadow',
  'forgeax::standard-terrain-ids-shadow',
  'forgeax::single-layer-medium',
  'forgeax::pbr-skin',
  'forgeax::default-standard-pbr-skin',
  'forgeax::default-unlit',
  'forgeax::default-shadow-caster',
  'forgeax::sprite',
  'forgeax::sprite-lit',
  'forgeax::msdf-text',
  BUILTIN_MATERIAL_MODULES.standard,
  BUILTIN_MATERIAL_MODULES.unlit,
  BUILTIN_MATERIAL_MODULES.sprite,
  'forgeax_material::sprite-lit',
] as const;

export function isEngineMaterialModule(module: string): boolean {
  return (ENGINE_MATERIAL_MODULES as readonly string[]).includes(module);
}

export function isEngineMaterial(
  material: Pick<MaterialAsset, 'passes'> &
    Partial<Pick<MaterialAsset, 'surface' | 'parameters' | 'staticSwitches'>>,
): boolean {
  const passes = material.passes ?? [];
  return (
    passes.length > 0 &&
    // A declared Surface is project-owned content and therefore needs the
    // material cooker even when its template module is Engine-shipped.
    material.surface === undefined &&
    // Explicit static choices need their own admitted specialization, even false.
    (material.staticSwitches === undefined || Object.keys(material.staticSwitches).length === 0) &&
    // Local clipping extends the material ABI and needs a cooked program.
    !material.parameters?.some((parameter) => parameter.name === 'clippingControl') &&
    passes.every(
      (pass) =>
        isEngineMaterialModule(pass.program.module) &&
        (pass.program.moduleSlots?.surface === undefined ||
          pass.program.moduleSlots.surface === DEFAULT_STANDARD_SURFACE_MODULE),
    )
  );
}

export type BuiltinMaterialKind = keyof typeof BUILTIN_MATERIAL_MODULES;

const BUILTIN_PARAMETERS: Readonly<Record<BuiltinMaterialKind, readonly MaterialParameter[]>> = {
  standard: [
    { name: 'baseColor', type: 'color' },
    { name: 'metallic', type: 'f32' },
    { name: 'roughness', type: 'f32' },
    { name: 'alphaCutoff', type: 'f32', optional: true },
  ],
  unlit: unlitMaterialParameters('srgb'),
  sprite: [{ name: 'colorTint', type: 'vec4', colorSpace: 'srgb' }],
};

const BUILTIN_VALUES: Readonly<
  Record<BuiltinMaterialKind, Readonly<Record<string, MaterialValue>>>
> = {
  standard: {
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
    alphaCutoff: STANDARD_PBR_ALPHA_CUTOFF_DEFAULT,
  },
  unlit: { baseColor: [1, 1, 1, 1] },
  sprite: { colorTint: [1, 1, 1, 1] },
};

export function createBuiltinMaterialAsset(kind: BuiltinMaterialKind): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'forward',
        program: {
          module: BUILTIN_MATERIAL_MODULES[kind],
          ...(kind === 'standard'
            ? { moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE } }
            : {}),
        },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    parameters:
      kind === 'standard'
        ? standardSurfaceParameters(BUILTIN_PARAMETERS[kind])
        : BUILTIN_PARAMETERS[kind],
    values: BUILTIN_VALUES[kind],
  };
}

/**
 * Shared luminance epsilon floor for the extended Reinhard tone-map
 * (feat-20260519-tonemap-reinhard-mvp / D-O3).
 *
 * The WGSL fragment stage in `packages/shader/src/tonemap.wgsl` applies
 * `max(Y, TONEMAP_LUMINANCE_EPSILON)` before dividing the luminance ratio.
 * The floor keeps the divisor finite at degenerate inputs (`Y = 0` from black
 * pixels, `Y < 0` from rare numerical artefacts). Single SSOT here so a
 * single `import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader'`
 * keeps TS / WGSL byte-equivalent.
 *
 * Value: `1e-5` — small enough to not perturb any plausible HDR luminance.
 */
export const TONEMAP_LUMINANCE_EPSILON = 1e-5;

export * from './cloud-programs';
export {
  createMaterialShaderProgram,
  type MaterialShaderProgram,
  materialShaderUvSetCount,
  materialShaderVertexInputRequired,
  type PipelineGroup2Contract,
} from './material/program.js';
export {
  admitRayMaterial,
  admitRayMaterialValues,
  type RayMaterialError,
  type RaySurfaceProgram,
  rayMaterialContract,
  rayMaterialFailure,
  rayMaterialNeedsCoverage,
} from './material/ray-program';
export { TONEMAP_PARAMS_LAYOUT, TONEMAP_SHADER_MODE } from './tonemap.js';
