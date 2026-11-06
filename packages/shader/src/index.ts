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
  STANDARD_DERIVED_LAYOUT_PROJECTIONS,
  STANDARD_DIRECT_DFG_LUT_BINDING,
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  STANDARD_PARALLAX_HEIGHT_DEFINE,
  STANDARD_PARALLAX_HEIGHT_PAIR,
  STANDARD_PBR_ALPHA_CUTOFF_DEFAULT,
  STANDARD_PBR_ARTIFACT_RECEIPT,
  STANDARD_PBR_SKIN_ARTIFACT_RECEIPT,
  STANDARD_PHYSICAL_BINDING_START,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
  STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
  STANDARD_SAMPLE_REUSE,
  STANDARD_SHADOW_RECEPTION_OVERRIDE,
  STANDARD_SHARED_TRANSMISSION_DEFINE,
  STANDARD_SHARED_TRANSMISSION_SLOTS,
  STANDARD_SURFACE_DISCARD_LOD_COVERAGE,
  STANDARD_SURFACE_DISCARD_VIEW_CLIPPING,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
  type StandardPhysicalTextureField,
  type StandardSharedTransmissionHost,
  standardMaskHasBit,
  standardParallaxSelectable,
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
  type MaterialShaderByteEntry,
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
  type ExpandedShaderManifest,
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

/** Runtime WGSL for the fixed-cohort, same-frame auto exposure meter. */
export { AUTO_EXPOSURE_FRAGMENT_WGSL, AUTO_EXPOSURE_METER_WGSL } from './auto-exposure-source';
export {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from './light-texture-resample.js';
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
export { manifestShaderSource } from './manifest-publication';
export { materialShaderSource } from './manifest-publication.js';
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
export { declaredMaterialVertexInputs } from './material/vertex-inputs.js';
export { TONEMAP_PARAMS_LAYOUT, TONEMAP_SHADER_MODE } from './tonemap.js';
