import { stripWgslComments } from './wgsl-comments.js';
import { WGSL_NUMERIC_LAYOUT } from './wgsl-numeric-layout.js';
// derive(schema) — paramSchema -> one DerivedMaterialInterface.
// feat-20260613-material-paramschema-driven-binding M1 / w3
//
// Decision anchors (plan-strategy §2):
//   - D-2  single pure function, no side effect; one signature consumed by 3
//          downstream paths (BGL build / UBO record / loader-extract).
//   - D-3  consecutive numeric entries are run-merged into one UBO entry at
//          one binding slot (uniform buffer); std140-aligned offsets.
//   - D-4  every texture* family entry auto-pairs a filtering sampler at
//          binding-1 (sampler emitted FIRST, then texture); sampler /
//          sampler_comparison stay user-declared.
//   - D-7  type set is the 14-literal MaterialParamType union.
//   - D-12 empty schema is graceful: bglEntries=[] / totalBytes=0 / fields empty.
//
// std140 alignment table (WGSL uniform):
//   - f32 / i32 / u32     size 4   align 4
//   - vec2<f32>           size 8   align 8
//   - vec3<f32>           size 12  align 16
//   - vec4 / color (rgba) size 16  align 16
//   - struct round-up: totalBytes is rounded up to 16-byte alignment.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  BindGroupLayoutEntry,
  MaterialParamType,
  NumericParamType,
  ParamSchemaEntry,
  TextureBindingParamType,
} from './index.js';

const FRAGMENT = 0x2 as GPUShaderStageFlags;

/** Numeric material ABI shared by layout derivation, WGSL emission and reflection. */
export const MATERIAL_NUMERIC_LAYOUT = {
  f32: { ...WGSL_NUMERIC_LAYOUT.f32, wgslType: 'f32' },
  i32: { ...WGSL_NUMERIC_LAYOUT.i32, wgslType: 'i32' },
  u32: { ...WGSL_NUMERIC_LAYOUT.u32, wgslType: 'u32' },
  vec2: { ...WGSL_NUMERIC_LAYOUT['vec2<f32>'], wgslType: 'vec2<f32>' },
  vec3: { ...WGSL_NUMERIC_LAYOUT['vec3<f32>'], wgslType: 'vec3<f32>' },
  vec4: { ...WGSL_NUMERIC_LAYOUT['vec4<f32>'], wgslType: 'vec4<f32>' },
  color: { ...WGSL_NUMERIC_LAYOUT['vec4<f32>'], wgslType: 'vec4<f32>' },
} as const satisfies Record<
  NumericParamType,
  { size: number; alignment: number; wgslType: string }
>;

const NUMERIC_TYPES = new Set<string>(Object.keys(MATERIAL_NUMERIC_LAYOUT));

type TextureViewParamType = Exclude<TextureBindingParamType, 'sampler' | 'sampler_comparison'>;

/** Sampled texture ABI; sampler declarations are a separate parameter family. */
export const MATERIAL_TEXTURE_LAYOUT = {
  texture2d: {
    sampleType: 'float',
    viewDimension: '2d',
    external: false,
    wgslType: 'texture_2d<f32>',
  },
  texture2d_array: {
    sampleType: 'float',
    viewDimension: '2d-array',
    external: false,
    wgslType: 'texture_2d_array<f32>',
  },
  texture3d: {
    sampleType: 'float',
    viewDimension: '3d',
    external: false,
    wgslType: 'texture_3d<f32>',
  },
  texture_cube: {
    sampleType: 'float',
    viewDimension: 'cube',
    external: false,
    wgslType: 'texture_cube<f32>',
  },
  texture_depth_2d: {
    sampleType: 'depth',
    viewDimension: '2d',
    external: false,
    wgslType: 'texture_depth_2d',
  },
  texture_cube_array: {
    sampleType: 'float',
    viewDimension: 'cube-array',
    external: false,
    wgslType: 'texture_cube_array<f32>',
  },
  texture_external: {
    sampleType: 'float',
    viewDimension: '2d',
    external: true,
    wgslType: 'texture_external',
  },
} as const satisfies Record<
  TextureViewParamType,
  {
    sampleType: GPUTextureSampleType;
    viewDimension: GPUTextureViewDimension;
    external: boolean;
    wgslType: string;
  }
>;

for (const layout of Object.values(MATERIAL_NUMERIC_LAYOUT)) Object.freeze(layout);
for (const layout of Object.values(MATERIAL_TEXTURE_LAYOUT)) Object.freeze(layout);
Object.freeze(MATERIAL_NUMERIC_LAYOUT);
Object.freeze(MATERIAL_TEXTURE_LAYOUT);

const TEXTURE_VIEW_TYPES = new Set<string>(Object.keys(MATERIAL_TEXTURE_LAYOUT));

const SAMPLER_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'sampler',
  'sampler_comparison',
]);

const ALL_TYPES: ReadonlySet<string> = new Set<string>([
  ...NUMERIC_TYPES,
  ...TEXTURE_VIEW_TYPES,
  ...SAMPLER_TYPES,
  'storage_buffer',
]);

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

function samplerBindingType(t: 'sampler' | 'sampler_comparison'): GPUSamplerBindingType {
  return t === 'sampler' ? 'filtering' : 'comparison';
}

/** Single UBO sub-entry — one merged std140 slot. */
export interface UboFieldLayout {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly type: NumericParamType;
}

export interface DerivedNumericMember extends UboFieldLayout {
  readonly alignment: number;
}

export interface MaterialCoordinateRecordLayout {
  readonly parameter: string;
  readonly offset: number;
  readonly size: 48;
  readonly alignment: 16;
  readonly transformMember: string;
  readonly metadataMember: string;
  readonly rotationMember: string;
}

export const MATERIAL_RESOURCE_KINDS = ['sampler', 'texture', 'storage-buffer'] as const;
export type MaterialResourceKind = (typeof MATERIAL_RESOURCE_KINDS)[number];

export interface MaterialResourceBindingLayout {
  readonly name: string;
  readonly parameter?: string;
  readonly kind: MaterialResourceKind;
  readonly binding: number;
}

export interface MaterialBindingSpan {
  readonly group: number;
  readonly binding: number;
  readonly start: number;
  readonly end: number;
}

export interface MaterialUserRegion {
  readonly group: number;
  readonly bindingStart: number;
  readonly bindingEnd: number;
}

export interface MaterialParameterResourceProjection {
  readonly kind: 'sampler' | 'storage-buffer';
  readonly name: string;
  readonly type: 'sampler' | 'sampler_comparison' | 'storage_buffer';
  readonly resource: MaterialResourceBindingLayout;
  readonly coordinates?: never;
}

export interface MaterialParameterTextureProjection {
  readonly kind: 'texture';
  readonly name: string;
  readonly type: TextureViewParamType;
  readonly coordinates: MaterialCoordinateRecordLayout;
  readonly resource: {
    readonly parameter: string;
    readonly texture: MaterialResourceBindingLayout;
    readonly sampler: MaterialResourceBindingLayout;
  };
}

export interface MaterialParameterNumericProjection {
  readonly kind: 'numeric';
  readonly name: string;
  readonly type: NumericParamType;
  readonly member: DerivedNumericMember;
  readonly coordinates?: never;
  readonly resource?: never;
}

export type MaterialParameterProjection =
  | MaterialParameterNumericProjection
  | MaterialParameterTextureProjection
  | MaterialParameterResourceProjection;

export interface DerivedMaterialInterface {
  readonly schemaVersion: 'material-abi/1';
  readonly group: number;
  readonly visibility: GPUShaderStageFlags;
  readonly bglEntries: readonly BindGroupLayoutEntry[];
  readonly uboLayout: UboLayout;
  readonly numericMembers: readonly DerivedNumericMember[];
  readonly coordinateRecords: readonly MaterialCoordinateRecordLayout[];
  readonly resourceBindings: readonly MaterialResourceBindingLayout[];
  readonly totalBytes: number;
  readonly layoutIdentity: string;
  /** Validated parameter types, indexed once during interface derivation. */
  readonly parameterTypes: ReadonlyMap<string, MaterialParamType>;
  readonly textureFieldNames: ReadonlySet<string>;
  readonly samplerForTexture: ReadonlyMap<string, string>;
  readonly userRegionBindingEnd: number;
  readonly bindingSpans: readonly MaterialBindingSpan[];
  readonly userRegion: MaterialUserRegion;
}

export interface UboLayout {
  readonly entries: readonly UboFieldLayout[];
  readonly totalBytes: number;
}

export type DeriveOutput = DerivedMaterialInterface;

export interface ImmutableParamSchemaProjection {
  readonly ownerId: string;
  readonly revision: number;
  readonly schema: readonly ParamSchemaEntry[];
  readonly derivedInterface: DerivedMaterialInterface;
}

export interface ParamSchemaProjectionOwnerStats {
  readonly admissions: number;
  readonly derivations: number;
  readonly projections: number;
}

export type ParamSchemaDeriveObservationKind =
  | 'admitted-identity-hit'
  | 'fallback-cache-hit'
  | 'unregistered-fallback-derive'
  | 'fallback-layout-sha';

export interface ParamSchemaDeriveObserver {
  readonly enabled: boolean;
  readonly observe: (event: {
    readonly kind: ParamSchemaDeriveObservationKind;
    readonly site: string;
  }) => void;
}

interface OwnedParamSchemaProjection extends ImmutableParamSchemaProjection {
  readonly canonicalSchema: string;
}

// Runtime consumers can still receive the schema array through older API
// surfaces. Admission binds that immutable array identity back to the one
// owner projection, so those compatibility calls return the admitted result
// without deriving or hashing again. Unregistered schemas keep the pure
// offline/compiler behavior.
const ADMITTED_PARAM_SCHEMA_PROJECTIONS = new WeakMap<
  readonly ParamSchemaEntry[],
  ParamSchemaDerivation
>();

interface ParamSchemaShape {
  readonly names: readonly string[];
  readonly types: readonly MaterialParamType[];
  readonly sampleTypes: readonly (string | undefined)[];
}

interface ParamSchemaDerivation {
  readonly shape: ParamSchemaShape;
  readonly derivedInterface: DerivedMaterialInterface;
  /** Exact JSON spelling of an owner-frozen schema, when it is lossless. */
  readonly canonicalSchema?: string;
}

// Many materials publish equal runtime schemas as separate arrays. Owner
// admission shares one frozen schema and derivation per exact content, so a
// schema is copied, frozen and derived once instead of once per material. The
// key is the JSON spelling, used only when that spelling is lossless (no
// undefined fields, negative zero or non-finite numbers); the index is weak.
const ADMITTED_PARAM_SCHEMAS_BY_CONTENT = new Map<string, WeakRef<readonly ParamSchemaEntry[]>>();
const collectedParamSchemas =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<string>((key) => {
        if (ADMITTED_PARAM_SCHEMAS_BY_CONTENT.get(key)?.deref() === undefined)
          ADMITTED_PARAM_SCHEMAS_BY_CONTENT.delete(key);
      })
    : undefined;

/** JSON spelling plus whether it identifies the value exactly. */
function exactSchemaJson(schema: readonly ParamSchemaEntry[]): {
  readonly text: string;
  readonly exact: boolean;
} {
  let exact = true;
  const text = JSON.stringify(schema, (_key, value: unknown) => {
    if (
      value === undefined ||
      (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    )
      exact = false;
    else if (value !== null && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== Array.prototype) exact = false;
    }
    return value;
  });
  return { text, exact };
}

// Runtime compatibility callers do not always carry an owner/revision. Keep
// that path fast without weakening its mutable-schema contract: the cache is
// keyed by array identity, while every hit rechecks the only fields consumed by
// `derivePure` (ordered `name` + `type`). Results are frozen before publication
// so a caller cannot poison a later hit.
const UNADMITTED_PARAM_SCHEMA_PROJECTIONS = new WeakMap<
  readonly ParamSchemaEntry[],
  ParamSchemaDerivation
>();

/**
 * Immutable/revision owner for runtime ParamSchema projections.
 *
 * A new `(ownerId, revision)` derives a caller-owned schema once, or shares
 * facts already admitted for the same immutable schema identity. Repeating the
 * same admission is idempotent when the schema bytes match and fails loud when
 * a revision is reused for different content. Caller-owned schemas are cloned
 * and frozen so their mutation cannot alter a published revision.
 */
export class ParamSchemaProjectionOwner {
  readonly #projections = new Map<string, OwnedParamSchemaProjection>();
  #admissions = 0;
  #derivations = 0;

  admit(args: {
    readonly ownerId: string;
    readonly revision: number;
    readonly schema: readonly ParamSchemaEntry[];
  }): ImmutableParamSchemaProjection {
    if (args.ownerId.length === 0) {
      throw new Error('ParamSchemaProjectionOwner: ownerId must be non-empty');
    }
    if (!Number.isSafeInteger(args.revision) || args.revision < 1) {
      throw new Error('ParamSchemaProjectionOwner: revision must be a positive safe integer');
    }
    this.#admissions += 1;
    const key = `${args.ownerId}\u0000${args.revision}`;
    const spelled = exactSchemaJson(args.schema);
    const existing = this.#projections.get(key);
    if (existing !== undefined) {
      if (existing.canonicalSchema !== spelled.text) {
        throw new Error(
          `ParamSchemaProjectionOwner: ${args.ownerId}@${args.revision} reused with different schema content`,
        );
      }
      return existing;
    }

    let schema = args.schema;
    let admitted = ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(schema);
    if (admitted === undefined && spelled.exact) {
      const shared = ADMITTED_PARAM_SCHEMAS_BY_CONTENT.get(spelled.text)?.deref();
      const sharedDerivation =
        shared === undefined ? undefined : ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(shared);
      if (shared !== undefined && sharedDerivation !== undefined) {
        schema = shared;
        admitted = sharedDerivation;
      }
    }
    if (admitted === undefined) {
      schema = freezeParamSchema(schema);
      const shape = captureParamSchemaShape(schema);
      admitted = {
        shape,
        derivedInterface: freezeDerivedMaterialInterface(derivePure(schema, shape)),
        ...(spelled.exact ? { canonicalSchema: spelled.text } : {}),
      };
      this.#derivations += 1;
      ADMITTED_PARAM_SCHEMA_PROJECTIONS.set(schema, admitted);
      if (spelled.exact) {
        ADMITTED_PARAM_SCHEMAS_BY_CONTENT.set(spelled.text, new WeakRef(schema));
        collectedParamSchemas?.register(schema, spelled.text);
      }
    }
    const projection = Object.freeze({
      ownerId: args.ownerId,
      revision: args.revision,
      schema,
      derivedInterface: admitted.derivedInterface,
      // Reuse the retained spelling; equal text from this call is garbage.
      canonicalSchema: admitted.canonicalSchema ?? spelled.text,
    });
    this.#projections.set(key, projection);
    return projection;
  }

  get(ownerId: string, revision: number): ImmutableParamSchemaProjection | undefined {
    return this.#projections.get(`${ownerId}\u0000${revision}`);
  }

  stats(): ParamSchemaProjectionOwnerStats {
    return Object.freeze({
      admissions: this.#admissions,
      derivations: this.#derivations,
      projections: this.#projections.size,
    });
  }
}

/**
 * Deterministic derivation: paramSchema -> BGL entries + UBO byte layout +
 * field maps. Unadmitted schemas are memoized by identity after an exact
 * ordered name/type check; owner-admitted schemas still take precedence.
 *
 * The function has no side effects and is the SSOT for BGL / UBO / loader
 * lookup tables (D-2). Runtime / vite-plugin-shader / loader all call into
 * this single entry point; in particular, `userRegionBindingEnd` is the
 * post-user-region binding index that engine-injected groups (shadow / IBL
 * / transmission, see D-6) must start from.
 * An optional owner-admitted reference can avoid rebuilding a cold transport
 * copy's identical layout. It never skips the copy's ordered field observations;
 * unadmitted references, changed shapes and existing compatibility entries retain
 * their normal validation path.
 *
 * Throws on schema authoring errors:
 *   - duplicate entry name (numeric or non-numeric)
 *   - unrecognised type literal (not in the 14-member union)
 *   - empty entry name
 *   - user-declared name collides with the auto-paired `<tex>_sampler`
 */
export function derive(
  schema: readonly ParamSchemaEntry[],
  admittedReference?: readonly ParamSchemaEntry[],
): DeriveOutput {
  const admitted = ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(schema);
  if (admitted !== undefined) return admitted.derivedInterface;
  return deriveUnadmitted(schema, admittedReference).derivedInterface;
}

/** Read only an existing immutable admission; compatibility inputs remain unadmitted. */
export function getAdmittedParamSchemaInterface(
  schema: readonly ParamSchemaEntry[],
): DerivedMaterialInterface | undefined {
  return ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(schema)?.derivedInterface;
}

/**
 * Debug-only observation seam for runtime compatibility consumers.
 *
 * This wrapper records whether the supplied schema identity was admitted by the
 * ParamSchemaProjectionOwner, or reused through the unadmitted identity cache.
 * Keeping the observer out of the normal `derive` signature leaves production
 * callers on the existing zero-argument path.
 */
export function deriveObserved(
  schema: readonly ParamSchemaEntry[],
  observer: ParamSchemaDeriveObserver,
  site: string,
): DeriveOutput {
  const admitted = ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(schema);
  if (admitted !== undefined) {
    if (observer.enabled) observer.observe({ kind: 'admitted-identity-hit', site });
    return admitted.derivedInterface;
  }
  const result = deriveUnadmitted(schema);
  if (observer.enabled) {
    observer.observe({
      kind: result.cacheHit ? 'fallback-cache-hit' : 'unregistered-fallback-derive',
      site,
    });
    if (!result.cacheHit) observer.observe({ kind: 'fallback-layout-sha', site });
  }
  return result.derivedInterface;
}

function deriveUnadmitted(
  schema: readonly ParamSchemaEntry[],
  admittedReference?: readonly ParamSchemaEntry[],
): {
  readonly cacheHit: boolean;
  readonly derivedInterface: DerivedMaterialInterface;
} {
  const cached = UNADMITTED_PARAM_SCHEMA_PROJECTIONS.get(schema);
  // A transport copy can retain an already admitted ABI's exact shape without
  // retaining its array identity. Reuse that owner's detached evidence only
  // after every original compatibility observation, and only on a cold input.
  const reference =
    cached === undefined && admittedReference !== undefined
      ? ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(admittedReference)
      : undefined;
  const shape = captureParamSchemaShape(schema, cached?.shape ?? reference?.shape);
  if (cached !== undefined && shape === cached.shape) {
    return { cacheHit: true, derivedInterface: cached.derivedInterface };
  }

  // Only publish successful derivations. A legal -> illegal mutation must
  // still execute the original validation and throw rather than falling back
  // to a stale result.
  const derivedInterface =
    reference !== undefined && shape === reference.shape
      ? reference.derivedInterface
      : freezeDerivedMaterialInterface(derivePure(schema, shape));
  UNADMITTED_PARAM_SCHEMA_PROJECTIONS.set(schema, { shape, derivedInterface });
  return { cacheHit: false, derivedInterface };
}

function captureParamSchemaShape(
  schema: readonly ParamSchemaEntry[],
  previous?: ParamSchemaShape,
): ParamSchemaShape {
  // Preserve the original three length/array-admission observations before
  // reading any entry; mutable array Proxies may change fields at these reads.
  const namesLength = schema.length;
  let names: string[] | undefined =
    previous?.names.length === namesLength ? undefined : new Array(namesLength);
  const typesLength = schema.length;
  let types: MaterialParamType[] | undefined =
    previous?.types.length === typesLength ? undefined : new Array(typesLength);
  const sampleTypesLength = schema.length;
  let sampleTypes: (string | undefined)[] | undefined =
    previous?.sampleTypes.length === sampleTypesLength ? undefined : new Array(sampleTypesLength);
  const comparable =
    names === undefined && types === undefined && sampleTypes === undefined ? previous : undefined;
  if (comparable === undefined) {
    names ??= new Array(namesLength);
    types ??= new Array(typesLength);
    sampleTypes ??= new Array(sampleTypesLength);
  }
  let visited = 0;
  for (let index = 0; index < schema.length; index++) {
    visited = index + 1;
    const entry = schema[index] as ParamSchemaEntry;
    const name = entry.name,
      type = entry.type;
    const sampleType = 'sampleType' in entry ? entry.sampleType : undefined;
    if (
      names === undefined &&
      comparable !== undefined &&
      (name !== comparable.names[index] ||
        type !== comparable.types[index] ||
        sampleType !== comparable.sampleTypes[index])
    ) {
      names = new Array(namesLength);
      types = new Array(typesLength);
      sampleTypes = new Array(sampleTypesLength);
      for (let prefix = 0; prefix < index; prefix++) {
        names[prefix] = comparable.names[prefix] as string;
        types[prefix] = comparable.types[prefix] as MaterialParamType;
        sampleTypes[prefix] = comparable.sampleTypes[prefix];
      }
    }
    if (names !== undefined && types !== undefined && sampleTypes !== undefined) {
      names[index] = name;
      types[index] = type;
      sampleTypes[index] = sampleType;
    }
  }
  // Mutable author inputs still undergo every field read. Allocate detached
  // evidence only when that exact shape actually changed.
  if (names === undefined && comparable !== undefined) {
    if (visited === namesLength) return comparable;
    names = new Array(namesLength);
    types = new Array(typesLength);
    sampleTypes = new Array(sampleTypesLength);
    for (let prefix = 0; prefix < visited; prefix++) {
      names[prefix] = comparable.names[prefix] as string;
      types[prefix] = comparable.types[prefix] as MaterialParamType;
      sampleTypes[prefix] = comparable.sampleTypes[prefix];
    }
  }
  const shape = Object.freeze({
    names: Object.freeze(names ?? []),
    types: Object.freeze(types ?? []),
    sampleTypes: Object.freeze(sampleTypes ?? []),
  });
  // Preserve the old comparison's names-length domain even when a Proxy
  // reports different capacities for the three evidence arrays.
  if (
    comparable === undefined &&
    previous !== undefined &&
    shape.names.length === previous.names.length
  ) {
    let equal = true;
    for (let index = 0; index < shape.names.length; index++) {
      if (
        shape.names[index] !== previous.names[index] ||
        shape.types[index] !== previous.types[index] ||
        shape.sampleTypes[index] !== previous.sampleTypes[index]
      ) {
        equal = false;
        break;
      }
    }
    if (equal) return previous;
  }
  return shape;
}

function derivePure(
  schema: readonly ParamSchemaEntry[],
  shape: ParamSchemaShape = captureParamSchemaShape(schema),
): DeriveOutput {
  const bglEntries: BindGroupLayoutEntry[] = [];
  const uboFields: UboFieldLayout[] = [];
  const numericMembers: DerivedNumericMember[] = [];
  const coordinateRecords: MaterialCoordinateRecordLayout[] = [];
  const resourceBindings: MaterialResourceBindingLayout[] = [];
  const bindingSpans: MaterialBindingSpan[] = [];
  const textureFieldNames = new Set<string>();
  const samplerForTexture = new Map<string, string>();
  const parameterTypes = new Map<string, MaterialParamType>();
  const seenNames = new Set<string>();
  const reservedSamplerNames = new Set<string>();

  let nextBinding = 0;
  let uboCursor = 0;
  let uboBinding: number | null = null;

  const ensureUboBinding = (): number => {
    if (uboBinding !== null) return uboBinding;
    uboBinding = nextBinding;
    nextBinding += 1;
    bglEntries.push({
      binding: uboBinding,
      visibility: FRAGMENT,
      buffer: { type: 'uniform' },
    });
    bindingSpans.push({ group: 1, binding: uboBinding, start: 0, end: 0 });
    return uboBinding;
  };

  for (let index = 0; index < shape.names.length; index += 1) {
    const name = shape.names[index] as string;
    const type = shape.types[index] as MaterialParamType;
    if (name.length === 0) {
      throw new Error('derive: schema entry name must be non-empty');
    }
    if (!ALL_TYPES.has(type)) {
      throw new Error(`derive: unrecognised paramSchema type literal '${type}'`);
    }
    if (seenNames.has(name)) {
      throw new Error(`derive: duplicate paramSchema entry name '${name}'`);
    }
    if (reservedSamplerNames.has(name)) {
      throw new Error(`derive: paramSchema entry '${name}' collides with auto-paired sampler name`);
    }
    seenNames.add(name);
    parameterTypes.set(name, type);

    if (NUMERIC_TYPES.has(type)) {
      const numericType = type as NumericParamType;
      const { size, alignment } = MATERIAL_NUMERIC_LAYOUT[numericType];
      ensureUboBinding();
      const offset = alignUp(uboCursor, alignment);
      uboFields.push({ name, offset, size, type: numericType });
      numericMembers.push({ name, offset, size, alignment, type: numericType });
      uboCursor = offset + size;
      continue;
    }

    if (TEXTURE_VIEW_TYPES.has(type)) {
      const texType = type as TextureViewParamType;
      ensureUboBinding();
      const coordinateOffset = alignUp(uboCursor, 16);
      const coordinates: MaterialCoordinateRecordLayout = {
        parameter: name,
        offset: coordinateOffset,
        size: 48,
        alignment: 16,
        transformMember: `${name}CoordinatesTransform`,
        metadataMember: `${name}CoordinatesMetadata`,
        rotationMember: `${name}CoordinatesRotation`,
      };
      coordinateRecords.push(coordinates);
      uboCursor = coordinateOffset + coordinates.size;
      const textureDescriptor = MATERIAL_TEXTURE_LAYOUT[texType];
      const sampleType = shape.sampleTypes[index] ?? textureDescriptor.sampleType;
      if (
        (sampleType !== textureDescriptor.sampleType &&
          !(sampleType === 'unfilterable-float' && textureDescriptor.sampleType === 'float')) ||
        (textureDescriptor.external && sampleType !== 'float')
      ) {
        throw new Error(`derive: invalid texture sample type '${sampleType}' for '${name}'`);
      }
      const viewDimension = textureDescriptor.viewDimension;
      // Sampler-first per plan §D-4: emit auto-paired filtering sampler at
      // binding N, then the texture view at binding N+1. Matches the actual
      // WGSL @binding declaration order in the 5 built-in shaders (sampler
      // declared on the odd binding, texture on the even+1 binding).
      const samplerName = `${name}_sampler`;
      if (seenNames.has(samplerName)) {
        throw new Error(
          `derive: auto-paired sampler name '${samplerName}' collides with existing entry`,
        );
      }
      reservedSamplerNames.add(samplerName);
      samplerForTexture.set(name, samplerName);
      const samplerBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: samplerBinding,
        visibility: FRAGMENT,
        sampler: { type: 'filtering' },
      });
      bindingSpans.push({ group: 1, binding: samplerBinding, start: 0, end: 0 });
      resourceBindings.push({
        name: samplerName,
        parameter: name,
        kind: 'sampler',
        binding: samplerBinding,
      });

      const texBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push(
        textureDescriptor.external
          ? { binding: texBinding, visibility: FRAGMENT, externalTexture: {} }
          : {
              binding: texBinding,
              visibility: FRAGMENT,
              texture: {
                sampleType: sampleType as GPUTextureSampleType,
                viewDimension,
                multisampled: false,
              },
            },
      );
      bindingSpans.push({ group: 1, binding: texBinding, start: 0, end: 0 });
      resourceBindings.push({
        name,
        parameter: name,
        kind: 'texture',
        binding: texBinding,
      });
      textureFieldNames.add(name);
      continue;
    }

    if (SAMPLER_TYPES.has(type)) {
      const samplerType = type as 'sampler' | 'sampler_comparison';
      const samplerBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: samplerBinding,
        visibility: FRAGMENT,
        sampler: { type: samplerBindingType(samplerType) },
      });
      bindingSpans.push({ group: 1, binding: samplerBinding, start: 0, end: 0 });
      resourceBindings.push({
        name,
        parameter: name,
        kind: 'sampler',
        binding: samplerBinding,
      });
      continue;
    }

    // entry.type === 'storage_buffer'
    const storageBinding = nextBinding;
    nextBinding += 1;
    bglEntries.push({
      binding: storageBinding,
      visibility: FRAGMENT,
      buffer: { type: 'read-only-storage' },
    });
    bindingSpans.push({ group: 1, binding: storageBinding, start: 0, end: 0 });
    resourceBindings.push({
      name,
      parameter: name,
      kind: 'storage-buffer',
      binding: storageBinding,
    });
  }

  const totalBytes = uboCursor === 0 ? 0 : alignUp(uboCursor, 16);
  const uniformSpan = bindingSpans.find((span) => span.binding === uboBinding);
  if (uniformSpan !== undefined) {
    const index = bindingSpans.indexOf(uniformSpan);
    bindingSpans[index] = { ...uniformSpan, end: totalBytes };
  }
  const userRegion: MaterialUserRegion = { group: 1, bindingStart: 0, bindingEnd: nextBinding };
  const layoutIdentity = sha256LayoutIdentity({
    bglEntries,
    numericMembers,
    coordinateRecords,
    resourceBindings,
    totalBytes,
    bindingSpans,
    userRegion,
  });

  return {
    schemaVersion: 'material-abi/1',
    group: 1,
    visibility: FRAGMENT,
    bglEntries,
    uboLayout: { entries: uboFields, totalBytes },
    numericMembers,
    coordinateRecords,
    resourceBindings,
    totalBytes,
    layoutIdentity,
    parameterTypes,
    textureFieldNames,
    samplerForTexture,
    userRegionBindingEnd: nextBinding,
    bindingSpans,
    userRegion,
  };
}

function freezeParamSchema(schema: readonly ParamSchemaEntry[]): readonly ParamSchemaEntry[] {
  return Object.freeze(
    schema.map((entry) => {
      if ('default' in entry && !NUMERIC_TYPES.has(entry.type))
        throw new TypeError(
          `ParamSchemaProjectionOwner: ${entry.name} (${entry.type}) cannot declare a default`,
        );
      if (!('default' in entry) || entry.default === undefined) return Object.freeze({ ...entry });
      const value = entry.default;
      return Object.freeze({
        ...entry,
        default: typeof value === 'number' ? value : Object.freeze([...value]),
      });
    }),
  );
}

function freezeDerivedMaterialInterface(
  derived: DerivedMaterialInterface,
): DerivedMaterialInterface {
  deepFreeze(derived.bglEntries);
  deepFreeze(derived.uboLayout);
  deepFreeze(derived.numericMembers);
  deepFreeze(derived.coordinateRecords);
  deepFreeze(derived.resourceBindings);
  deepFreeze(derived.bindingSpans);
  deepFreeze(derived.userRegion);
  return Object.freeze({
    ...derived,
    parameterTypes: new ImmutableMapView(derived.parameterTypes),
    textureFieldNames: new ImmutableSetView(derived.textureFieldNames),
    samplerForTexture: new ImmutableMapView(derived.samplerForTexture),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

class ImmutableSetView<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }
}

class ImmutableMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(values: Iterable<readonly [K, V]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#values[Symbol.iterator]();
  }
}

export function inferMaterialParameterKind(
  entry: ParamSchemaEntry,
): MaterialParameterProjection['kind'] {
  if (NUMERIC_TYPES.has(entry.type)) return 'numeric';
  if (TEXTURE_VIEW_TYPES.has(entry.type)) return 'texture';
  if (entry.type === 'storage_buffer') return 'storage-buffer';
  return 'sampler';
}

function sha256LayoutIdentity(value: {
  readonly bglEntries: readonly BindGroupLayoutEntry[];
  readonly numericMembers: readonly DerivedNumericMember[];
  readonly coordinateRecords: readonly MaterialCoordinateRecordLayout[];
  readonly resourceBindings: readonly MaterialResourceBindingLayout[];
  readonly totalBytes: number;
  readonly bindingSpans: readonly MaterialBindingSpan[];
  readonly userRegion: MaterialUserRegion;
}): string {
  const canonical = JSON.stringify({
    version: 2,
    bglEntries: value.bglEntries,
    numericMembers: value.numericMembers,
    coordinateRecords: value.coordinateRecords,
    resourceBindings: value.resourceBindings,
    totalBytes: value.totalBytes,
    bindingSpans: value.bindingSpans,
    userRegion: value.userRegion,
  });
  return `sha256-${bytesToHex(sha256(new TextEncoder().encode(canonical)))}`;
}

/**
 * The three user-region material texture fields whose handles flow through the
 * paramSchema-driven extract filter (`validateTextureHandle`). They map to the
 * fixed `@group(1) @binding(2/4/6)` slots in the standard material BGL.
 *
 * `emissiveTexture` / `occlusionTexture` are deliberately EXCLUDED: they are
 * engine-owned Standard textures, are sampled by `default-standard-pbr` without
 * a schema entry, and are never filtered by `validateTextureHandle`. Including them
 * would false-positive the engine's own PBR shader.
 */
const USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
];

/**
 * Detect user-region material textures a shader actually `textureSample`s but
 * its paramSchema fails to declare as a texture entry.
 *
 * This is the runtime (register-time) counterpart of the build-time superset
 * gate (`compareMaterialBindings`): user shaders registered directly via
 * `ShaderRegistry.installMaterialArtifact` bypass the vite-plugin-shader
 * reflection path, so an under-declared schema would otherwise let the extract
 * stage's `validateTextureHandle` silently drop the sampled texture's handle
 * and fall back to the default white texture (charter P3 violation — the bug
 * that turned the LearnOpenGL 4.3 blending demo's grass + windows opaque white;
 * see docs/handover/2026-06-19-blending-transparency-regression-bisect.md).
 *
 * Returns the field names that are sampled-but-undeclared (empty = consistent).
 * Scan is name-based on the WGSL var passed as the first `textureSample*`
 * argument; comments are stripped first so a commented-out sample never trips
 * the check. Only the three `USER_REGION_TEXTURE_FIELDS` participate, so a
 * shader that merely *declares* the standard binding layout without sampling it
 * (e.g. an outline / depth-viz shader reusing the PBR BGL) is not flagged.
 */
export function findUndeclaredSampledTextures(
  wgslSource: string,
  schema: readonly ParamSchemaEntry[],
): readonly string[] {
  const declared = derive(schema).textureFieldNames;
  const clean = stripWgslComments(wgslSource);
  const sampleRe = /textureSample[A-Za-z]*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  const sampled = new Set<string>();
  for (let m = sampleRe.exec(clean); m !== null; m = sampleRe.exec(clean)) {
    const name = m[1];
    if (name !== undefined) sampled.add(name);
  }
  return USER_REGION_TEXTURE_FIELDS.filter((f) => sampled.has(f) && !declared.has(f));
}
