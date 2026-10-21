import type { MaterialProgramAbi, ParamSchemaEntry } from '@forgeax/engine-types';
import {
  ParamSchemaProjectionOwner,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
} from '@forgeax/engine-types';
import {
  STANDARD_PIPELINE_PARAM_SCHEMA as CANONICAL_STANDARD_PIPELINE_PARAM_SCHEMA,
  createStandardPbrArtifactReceipt,
} from './material/artifact-types.js';

export const STANDARD_PBR_ALPHA_CUTOFF_DEFAULT = 0;

/** Shared material contract for the standard PBR and skinned PBR shaders. */
export const DEFAULT_STANDARD_PBR_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  STANDARD_MATERIAL_PARAM_SCHEMA.filter(
    (entry) => entry.name !== 'directMultiscatteringLut' && entry.name !== 'flatShading',
  );

/** Numeric WGSL override ID, stable across Naga symbol mangling. */
export const STANDARD_TEXTURE_MASK_OVERRIDE = '64000';

/** Physical maps follow the fixed scene-material (46) and global-prefilter (47) slots. */
export const STANDARD_PHYSICAL_BINDING_START = 48;

/** The optional engine-owned DFG texture follows every reserved physical map pair. */
export const STANDARD_DIRECT_DFG_LUT_BINDING =
  STANDARD_PHYSICAL_BINDING_START + STANDARD_PHYSICAL_TEXTURE_FIELDS.length * 2;

const standardTextureBits: ReadonlyMap<string, number> = new Map(
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) => entry.type === 'texture2d').map(
    (entry, index) => [entry.name, 2 ** index],
  ),
);

/** Earlier Standard samples that an independent scalar map may reuse. */
export const STANDARD_SAMPLE_REUSE = [
  {
    target: 'metallicTexture',
    shift: standardTextureBits.size,
    sources: ['baseColorTexture', 'metallicRoughnessTexture'],
  },
  {
    target: 'roughnessTexture',
    shift: standardTextureBits.size + 2,
    sources: ['baseColorTexture', 'metallicRoughnessTexture', 'metallicTexture'],
  },
  {
    target: 'alphaTexture',
    shift: standardTextureBits.size + 4,
    sources: [
      'baseColorTexture',
      'metallicRoughnessTexture',
      'metallicTexture',
      'roughnessTexture',
    ],
  },
] as const;

/**
 * The minimum-limit Standard transmission variant has no dedicated lanes for
 * its transmission, thickness, and screen backdrop textures. It rebinds them
 * into the split scalar-map pairs, so the fixed low-limit layout is unchanged
 * and a material may use transmission only while those scalar maps are absent.
 */
export const STANDARD_SHARED_TRANSMISSION_SLOTS = [
  { resource: 'transmissionTexture', sampler: 'transmissionSampler', host: 'metallicTexture' },
  { resource: 'thicknessTexture', sampler: 'thicknessSampler', host: 'roughnessTexture' },
  { resource: 'transmissionBackdropTexture', host: 'alphaTexture' },
] as const;

export const STANDARD_SHARED_TRANSMISSION_DEFINE = 'TRANSMISSION_SHARED_SLOTS';

function standardAvailableDefine(field: string): string {
  return `${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_AVAILABLE`;
}

/**
 * Define overrides for the one variant that selects shared transmission slots:
 * transmission without the projector and extended-lighting lanes, which the
 * renderer only selects below the dedicated sampled-texture budget.
 */
export function standardSharedTransmissionDefines(
  defines: Readonly<Record<string, boolean>> | undefined,
): Readonly<Record<string, boolean>> {
  if (
    defines?.TRANSMISSION_AVAILABLE !== true ||
    defines.PROJECTOR_AVAILABLE !== false ||
    defines.EXTENDED_LIGHTING_AVAILABLE !== false
  ) {
    return {};
  }
  const overrides: Record<string, boolean> = { [STANDARD_SHARED_TRANSMISSION_DEFINE]: true };
  for (const slot of STANDARD_SHARED_TRANSMISSION_SLOTS)
    overrides[standardAvailableDefine(slot.host)] = false;
  return overrides;
}

export type StandardSharedTransmissionHost =
  (typeof STANDARD_SHARED_TRANSMISSION_SLOTS)[number]['host'];

/** Authored scalar maps that occupy a shared transmission slot for this presence mask. */
export function standardSharedTransmissionConflicts(
  presenceMask: number,
): readonly StandardSharedTransmissionHost[] {
  return STANDARD_SHARED_TRANSMISSION_SLOTS.map((slot) => slot.host).filter(
    (host) => (presenceMask & (standardTextureBits.get(host) ?? 0)) !== 0,
  );
}

/** Presence follows the authored contract, never asynchronous GPU residency. */
export function standardTextureMask(schema: readonly ParamSchemaEntry[]): number {
  let mask = 0;
  for (const entry of schema) {
    if (entry.type === 'texture2d') mask |= standardTextureBits.get(entry.name) ?? 0;
  }
  return mask;
}

/**
 * Projection selectors above the sample-reuse selectors. They specialize the
 * pipeline from authored values, so slot sampling never branches per row.
 */
export const STANDARD_TRIPLANAR_PROJECTION_BIT = 2 ** 29;
export const STANDARD_OBJECT_SPACE_NORMAL_BIT = 2 ** 30;

/** Derive projection selectors from effective `triplanarSpace` / `normalMapSpace` values. */
export function standardProjectionMask(value: (name: string) => unknown): number {
  const triplanar = value('triplanarSpace');
  const normalSpace = value('normalMapSpace');
  return (
    (typeof triplanar === 'number' && triplanar > 0.5 ? STANDARD_TRIPLANAR_PROJECTION_BIT : 0) +
    (typeof normalSpace === 'number' && normalSpace > 0.5 ? STANDARD_OBJECT_SPACE_NORMAL_BIT : 0)
  );
}

/** Pack sample reuse into unused high bits of the existing pipeline override. */
export function standardSampleReuseMask(
  presenceMask: number,
  sameSample: (source: string, target: string) => boolean,
): number {
  let mask = 0;
  for (const entry of STANDARD_SAMPLE_REUSE) {
    if ((presenceMask & (standardTextureBits.get(entry.target) ?? 0)) === 0) continue;
    for (const [index, source] of entry.sources.entries()) {
      if ((presenceMask & (standardTextureBits.get(source) ?? 0)) === 0) continue;
      if (!sameSample(source, entry.target)) continue;
      mask += (index + 1) * 2 ** entry.shift;
      break;
    }
  }
  return mask;
}

export type { StandardPhysicalTextureField } from '@forgeax/engine-types';
/**
 * Stable physical texture injection order.  The order is part of the
 * Standard template's resource ABI and is derived from the root schema by
 * `standardPhysicalTextureFields`; render/cook must not maintain another
 * field inventory.
 */
export {
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
  standardPhysicalTextureFields,
} from '@forgeax/engine-types';

/**
 * Canonical boot-time user region for the shared Standard material BGL.
 *
 * It is still a projection of the root schema, but unlike the author-facing
 * base-only projection it retains the pre-existing transmission texture pair.
 * The template reserves those two pairs before the IBL/backdrop injection so
 * a base-only shader and a transmissive shader can share one boot layout;
 * physical texture pairs are never included here and are appended only for a
 * root contract that declares them.
 */
// Keep the runtime schema export on the receipt producer's canonical
// projection.  The shader artifact, GPU Scene row, and material bind-group
// builder must not each filter the Standard root independently.
export const STANDARD_PIPELINE_PARAM_SCHEMA = CANONICAL_STANDARD_PIPELINE_PARAM_SCHEMA;

/**
 * Fixed material contract consumed by the VFX mesh adapters.
 *
 * `standard-surface.wgsl` is an authored surface rather than the generated
 * Standard root, so its Material block must be projected explicitly when a
 * particle shader is published. Keep the projection derived from the
 * canonical Standard vocabulary wherever possible; only the surface-owned
 * `specularTint` scalar and texture alias are local to this contract. The
 * order is the WGSL ABI: uniform region first (400 B), followed by eight
 * sampler/texture pairs (bindings 1..16), then the shared IBL injection at
 * bindings 17..22.
 */
const PARTICLE_SURFACE_NUMERIC_FIELDS = [
  'baseColor',
  'metallic',
  'roughness',
  'metallicChannel',
  'roughnessChannel',
  'aoChannel',
  'extraChannel',
  'emissive',
  'emissiveIntensity',
  'occlusionStrength',
  'alphaCutoff',
  'clearcoat',
  'clearcoatRoughness',
  'specularTint',
  'normalScale',
  'transmission',
  'ior',
  'thickness',
  'attenuationColor',
  'attenuationDistance',
] as const;

const PARTICLE_SURFACE_TEXTURE_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularTintTexture',
  'emissiveTexture',
  'occlusionTexture',
  'transmissionTexture',
  'thicknessTexture',
] as const;

function particleSurfaceSchemaEntry(name: string): ParamSchemaEntry {
  const entry = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.find((candidate) => candidate.name === name);
  if (entry !== undefined) return entry;
  if (name === 'specularTint') {
    return { name, type: 'vec3', colorSpace: 'srgb', default: [1, 1, 1] };
  }
  if (name === 'specularTintTexture') return { name, type: 'texture2d' };
  throw new Error(`Particle Standard Surface schema field is missing: ${name}`);
}

export const PARTICLE_MESH_SURFACE_PARAM_SCHEMA: readonly ParamSchemaEntry[] = Object.freeze([
  ...PARTICLE_SURFACE_NUMERIC_FIELDS.map(particleSurfaceSchemaEntry),
  ...PARTICLE_SURFACE_TEXTURE_FIELDS.map(particleSurfaceSchemaEntry),
]);

/** The single producer receipt shared by direct and scene-index Standard PBR. */
export const STANDARD_PBR_ARTIFACT_RECEIPT: MaterialProgramAbi = createStandardPbrArtifactReceipt();

/** Skinned Standard PBR keeps the material receipt identity and adds palette ABI. */
export const STANDARD_PBR_SKIN_ARTIFACT_RECEIPT: MaterialProgramAbi =
  createStandardPbrArtifactReceipt(true);

export const DEFAULT_UNLIT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'alphaCutoff', type: 'f32', default: 0 },
  { name: 'alphaHash', type: 'f32', default: 0 },
  { name: 'shadowAlphaMode', type: 'f32', default: 0 },
  { name: 'alphaMode', type: 'f32', default: 0 },
  { name: 'alphaToCoverage', type: 'f32', default: 0 },
  { name: 'shading', type: 'f32', default: 0 },
  { name: 'alphaChannel', type: 'f32', default: 1 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'alphaTexture', type: 'texture2d' },
];

export const DEFAULT_SPRITE_PARAM_SCHEMA: readonly ParamSchemaEntry[] =
  new ParamSchemaProjectionOwner().admit({
    ownerId: 'forgeax::sprite',
    revision: 2,
    schema: [
      { name: 'colorTint', type: 'vec4', colorSpace: 'srgb', default: [1, 1, 1, 1] },
      { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
      { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
      { name: 'slicesAndMode', type: 'vec4', default: [0, 0, 0, 0] },
      { name: 'flipX', type: 'f32', default: 0 },
      { name: 'flipY', type: 'f32', default: 0 },
      { name: 'baseColorTexture', type: 'texture2d' },
    ],
  }).schema;

export const DEFAULT_MSDF_TEXT_PARAM_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
];
