import type { MaterialProgramAbi, ParamSchemaEntry } from '@forgeax/engine-types';
import {
  ParamSchemaProjectionOwner,
  STANDARD_DISPLACEMENT_MODES,
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
    (entry) =>
      entry.name !== 'directMultiscatteringLut' &&
      entry.name !== 'planarReflection' &&
      entry.name !== 'flatShading',
  );

/** Numeric WGSL override ID, stable across Naga symbol mangling. */
export const STANDARD_TEXTURE_MASK_OVERRIDE = '64000';

/**
 * Numeric WGSL override ID of the Standard template's surface discard gates.
 * Each set bit keeps one fragment discard; the default keeps both. A static
 * discard defeats hidden-surface removal on tile GPUs even when it never fires.
 */
export const STANDARD_SURFACE_DISCARDS_OVERRIDE = '64001';
/** Zero is valid only for an admitted draw that declares no shadow reception. */
export const STANDARD_SHADOW_RECEPTION_OVERRIDE = '64002';
/** The visible item may carry a nonzero dithered LOD crossfade. */
export const STANDARD_SURFACE_DISCARD_LOD_COVERAGE = 1;
/** The view may carry world-space camera clipping planes. */
export const STANDARD_SURFACE_DISCARD_VIEW_CLIPPING = 2;

/** Physical maps follow the fixed scene-material (46) and global-prefilter (47) slots. */
export const STANDARD_PHYSICAL_BINDING_START = 48;

/** The optional engine-owned DFG texture follows every reserved physical map pair. */
export const STANDARD_DIRECT_DFG_LUT_BINDING =
  STANDARD_PHYSICAL_BINDING_START + STANDARD_PHYSICAL_TEXTURE_FIELDS.length * 2;

/** The optional PlanarReflection target and its projection uniform follow the DFG texture. */
export const STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING = STANDARD_DIRECT_DFG_LUT_BINDING + 1;
export const STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING = STANDARD_DIRECT_DFG_LUT_BINDING + 2;

const standardTextureBits: ReadonlyMap<string, number> = new Map(
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) => entry.type === 'texture2d').map(
    (entry, index) => [entry.name, 2 ** index],
  ),
);

const STANDARD_SAMPLE_REUSE_SOURCES = [
  { target: 'metallicTexture', sources: ['metallicRoughnessTexture'] },
  {
    target: 'roughnessTexture',
    sources: ['baseColorTexture', 'metallicRoughnessTexture', 'metallicTexture'],
  },
  {
    target: 'alphaTexture',
    sources: ['baseColorTexture', 'metallicRoughnessTexture', 'metallicTexture'],
  },
] as const;

/**
 * Earlier Standard samples that an independent scalar map may reuse. The
 * source lists are bounded so presence, selectors and projection bits fit the
 * u32 pipeline override: a pair without an entry (metallic from base color,
 * alpha from roughness) simply samples separately. Each
 * selector stores `sourceIndex + 1` (0 = no reuse), so it is `width` bits wide
 * and starts where the previous field ended, after the texture presence bits.
 */
export const STANDARD_SAMPLE_REUSE = (() => {
  let shift = standardTextureBits.size;
  return STANDARD_SAMPLE_REUSE_SOURCES.map((entry) => {
    const width = Math.ceil(Math.log2(entry.sources.length + 1));
    const field = { ...entry, shift, width };
    shift += width;
    return field;
  });
})();

const standardReuseEnd = STANDARD_SAMPLE_REUSE.reduce(
  (end, entry) => Math.max(end, entry.shift + entry.width),
  standardTextureBits.size,
);

/**
 * Standard derived layout projections. In one mode a split scalar-map pair
 * (`host`) of the fixed Standard layout carries another author fact's resource,
 * so no layout grows, no BGL is added and no author fact is renamed. A material
 * may use a mode only while its host map is absent. Both the WGSL lowering and
 * the bind-group builders read this table.
 *
 * - `shared-transmission`: the minimum-limit transmission variant has no
 *   dedicated lanes for transmission, thickness and the screen backdrop.
 * - `parallax`: the fragment march of `displacementMode: 'parallax'` reads
 *   `displacementTexture` (its own view and sampler) through the metallic pair;
 *   the vertex displacement pair stays vertex-only.
 */
export const STANDARD_DERIVED_LAYOUT_PROJECTIONS = [
  {
    mode: 'shared-transmission',
    resource: 'transmissionTexture',
    sampler: 'transmissionSampler',
    host: 'metallicTexture',
  },
  {
    mode: 'shared-transmission',
    resource: 'thicknessTexture',
    sampler: 'thicknessSampler',
    host: 'roughnessTexture',
  },
  { mode: 'shared-transmission', resource: 'transmissionBackdropTexture', host: 'alphaTexture' },
  { mode: 'parallax', resource: 'displacementTexture', host: 'metallicTexture' },
] as const;

type StandardDerivedLayoutProjection = (typeof STANDARD_DERIVED_LAYOUT_PROJECTIONS)[number];

export const STANDARD_SHARED_TRANSMISSION_SLOTS = STANDARD_DERIVED_LAYOUT_PROJECTIONS.filter(
  (pair): pair is Extract<StandardDerivedLayoutProjection, { mode: 'shared-transmission' }> =>
    pair.mode === 'shared-transmission',
);

/** The derived fragment height binding of `displacementMode: 'parallax'`. */
export const STANDARD_PARALLAX_HEIGHT_PAIR = STANDARD_DERIVED_LAYOUT_PROJECTIONS.find(
  (pair): pair is Extract<StandardDerivedLayoutProjection, { mode: 'parallax' }> =>
    pair.mode === 'parallax',
) as Extract<StandardDerivedLayoutProjection, { mode: 'parallax' }>;

/**
 * A root can march parallax only when it declares the height, its closed mode,
 * the normal map it fades to and the metallic host pair of the derived
 * projection. The canonical root declares all four; a sparse cooked root
 * without the host keeps plain normal mapping.
 */
export function standardParallaxSelectable(declares: (name: string) => boolean): boolean {
  return (
    declares('displacementTexture') &&
    declares('displacementMode') &&
    declares('normalTexture') &&
    declares(STANDARD_PARALLAX_HEIGHT_PAIR.host)
  );
}

/** Compile define of an available fragment height binding; shared transmission withdraws it. */
export const STANDARD_PARALLAX_HEIGHT_DEFINE = 'PARALLAX_HEIGHT_FRAGMENT_AVAILABLE';

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
  // The parallax host now carries transmission: parallax evaluates as plain normal mapping.
  overrides[STANDARD_PARALLAX_HEIGHT_DEFINE] = false;
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
export const STANDARD_TRIPLANAR_PROJECTION_BIT = 2 ** standardReuseEnd;
export const STANDARD_OBJECT_SPACE_NORMAL_BIT = 2 ** (standardReuseEnd + 1);
/** `displacementMode` parallax: the height map offsets fragment UVs instead of vertices. */
export const STANDARD_PARALLAX_DISPLACEMENT_BIT = 2 ** (standardReuseEnd + 2);

if (standardReuseEnd + 3 > 32) {
  throw new Error(
    `Standard pipeline override mask needs ${standardReuseEnd + 3} bits; the WGSL override is u32`,
  );
}

/**
 * Read one mask bit as unsigned. The mask may exceed 2**31, where `&` would
 * go through a signed int32; division keeps the full u32 range exact.
 */
export function standardMaskHasBit(mask: number, bit: number): boolean {
  return Math.floor(mask / bit) % 2 === 1;
}

/** Derive projection selectors from effective `triplanarSpace` / `normalMapSpace` / `displacementMode` values. */
export function standardProjectionMask(value: (name: string) => unknown): number {
  const triplanar = value('triplanarSpace');
  const normalSpace = value('normalMapSpace');
  return (
    (typeof triplanar === 'number' && triplanar > 0.5 ? STANDARD_TRIPLANAR_PROJECTION_BIT : 0) +
    (typeof normalSpace === 'number' && normalSpace > 0.5 ? STANDARD_OBJECT_SPACE_NORMAL_BIT : 0) +
    (value('displacementMode') === STANDARD_DISPLACEMENT_MODES.parallax
      ? STANDARD_PARALLAX_DISPLACEMENT_BIT
      : 0)
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
