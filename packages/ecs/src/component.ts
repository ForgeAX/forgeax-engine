// @forgeax/engine-ecs — Component schema + opaque token.
//
// `defineComponent(name, fields, options?)` returns a frozen token carrying
// only the three runtime facts needed by callers:
//   - `.name`: component name string
//   - `.fields`: frozen field descriptors (the schema SSOT)
//   - `.storage`: table or sparse placement
// Numeric identity, flat schema projections, and default maps live in the ECS
// owner tables below rather than on the public token.
//
// ComponentId is used by archetype storage, bitmask matching, and edges cache.

import { err, type Handle, ok, type Result } from '@forgeax/engine-types';
import {
  assertComponentStorage,
  deepFreeze,
  registerComponentDefinition,
} from './component-schema';
import type { EntityHandle } from './entity-handle';
import {
  ManagedArrayElementTypeNotAllowedError,
  SchemaUnsupportedFieldError,
  SparseStorageRequiresTagError,
} from './errors';
import type { ManagedColumnReader } from './storage/column';

// The internal package subpath reuses this owner module so the source budget
// does not grow a second forwarding module. Root exports remain curated in
// index.ts; this re-export is only reached through `@forgeax/engine-ecs/internal`.
export { componentDefinition } from './component-schema';

// ────────────────────────────────────────────────────────────────────────────
// Field types — schema vocab keywords (AC-01).
//
// Two-tier vocabulary:
//
//   1. Legacy scalar set: 11 keywords backed by TypedArray storage. Concrete
//      byte-sizes + TypedArray constructors are internal constants consumed by
//      `scalarRow()` to build TYPE_METADATA rows (see M4 §FIELD_SIZE_BYTES / VIEW_CTORS).
//
//   2. Schema-vocab keywords: 7 template-literal patterns expressing
//      ECS-managed types whose storage is owned by separate subsystems:
//        * `buffer:<bytes>`     — fixed-byte managed Uint8Array, stored by BufferPool
//        * `ref<T>`             — managed Handle<T,'unique'>, released by UniqueRefStore
//        * `shared<T>`          — rc-tracked Handle<T,'shared'>, lifecycle owned by SharedRefStore
//        * `entity`             — Entity reference (Entity | null)
//        * `string`             — utf-8 string payload, allocated as a managed handle via UniqueRefStore
//        * `array<T,N>`         — fixed-capacity typed view; elements inline in stride-N column (feat-20260602)
//        * `array<T>`           — variable-capacity typed view over BufferPool slot bytes
//
// The retired `array<entity>` predecessor (closed out by this feat) is no
// longer a valid schema field type — the union has narrowed it out.
// ────────────────────────────────────────────────────────────────────────────

/** Bytes per element for each scalar field type. */
const FIELD_SIZE_BYTES = {
  f32: 4,
  f64: 8,
  i32: 4,
  u32: 4,
  i16: 2,
  u16: 2,
  i8: 1,
  u8: 1,
  bool: 1,
  enum: 4,
  ref: 4,
} as const;

/** Numeric scalar field types backed by TypedArray storage (legacy tier). */
export type ScalarFieldType = keyof typeof FIELD_SIZE_BYTES;

/**
 * Legal element-type whitelist for the `array<T,N>` / `array<T>` vocab
 * keywords (AC-03). T must be a scalar field type, `entity`, or a
 * `shared\<X\>` template with a non-empty tag; reference / buffer / nested
 * array element types are forbidden (OOS-08 / OOS-03).
 *
 * feat-20260614 M5 / w23: the historical `handle\<X\>` element family was
 * deleted in favor of `shared\<X\>` (rc-tracked, lifecycle owned by
 * SharedRefStore). The `MANAGED_ARRAY_ELEMENT_TYPES` Set remains
 * static-scalar + entity only (D-8); dynamic `shared\<X\>` templates are
 * validated by `isValidArrayElementType` at parse time.
 *
 * Legal: every member of `ScalarFieldType` plus `entity` plus
 * `shared\<X\>` (non-empty tag). The `ref` legacy scalar keyword (a u32
 * column placeholder) is in the whitelist; the parametric `unique<T>` /
 * `shared<T>` scalars are rejected as array element types by AC-03.
 */
export type ManagedArrayElementType = ScalarFieldType | 'entity' | `shared<${string}>`;

/**
 * Schema-vocab keywords beyond the legacy scalar tier (AC-01).
 *
 * Each pattern is a template-literal type so a literal schema like
 * `{ mat: 'unique<MaterialAsset>' }` types the value as
 * `Handle<'MaterialAsset','unique'>` end-to-end. Runtime acceptance is
 * gated by the internal `isSchemaVocabKeyword` check — the SSOT for parser fail-fast.
 *
 * The legacy `'buffer:<N>'` literal is retired one-cut by
 * feat-20260515-buffer-array-vocab-collapse w4: replaced by the
 * angle-bracket generic shapes `'buffer'` (variable byte slot) and
 * `'buffer<N>'` (fixed byte slot). With `'array<T>'` / `'array<T, N>'` they
 * form a 4-keyword closed surface across two orthogonal axes (element-type
 * x capacity contract).
 */
export type SchemaVocabKeyword =
  | 'string'
  | 'buffer'
  | `buffer<${number}>`
  | `unique<${string}>`
  | `shared<${string}>`
  | 'entity'
  | `array<${ManagedArrayElementType}, ${number}>`
  | `array<${ManagedArrayElementType}>`;

/**
 * Closed union of every keyword `defineComponent` accepts for a schema field.
 * Combines the legacy scalar tier with the schema-vocab tier.
 *
 * `ComponentSchema` is keyed against this union; `defineComponent` rejects
 * any field value not satisfying it (compile-time) or matching it
 * (runtime).
 */
export type SchemaFieldType = ScalarFieldType | SchemaVocabKeyword;

/**
 * Producer-owned semantic shape tags for authoring/schema consumers.
 *
 * The ECS storage vocabulary remains the source of truth for bytes and
 * runtime values. These tags capture the semantic shape that storage alone
 * cannot express (for example an optional entity reference or a nested
 * unique payload). The tag is deliberately closed so downstream consumers
 * can exhaustively handle the representative field-shape vocabulary without
 * creating a second component registry.
 */
export type FieldShapeKind =
  | 'scalar'
  | 'boolean'
  | 'enum'
  | 'vector'
  | 'quaternion'
  | 'optional'
  | 'nested'
  | 'array'
  | 'asset-ref';

/**
 * Normalize any field-type keyword to its TYPE_METADATA key.
 *
 * The 11 legacy scalars round-trip their own key. The 6 vocab families normalize
 * their parametric shapes to the family key:
 *   - `unique<T>` / `shared<T>` — strip `<T>`    → `'ref'` / `'shared'`
 *   - `buffer<N>`             — strip `<N>`       → `'buffer'`
 *   - `array<T>` / `array<T,N>` — strip `<...>`   → `'array'`
 *   - `entity` / `string` / `buffer` are identity.
 *
 * Returns `null` for an unrecognised keyword so callers can skip column
 * allocation (same semantics as the retired `storageFieldType`).
 */
export function fieldTypeToMetaKey(fieldType: string): string | null {
  if (fieldType === 'entity' || fieldType === 'string' || fieldType === 'buffer') {
    return fieldType;
  }
  if (fieldType.startsWith('unique<') && fieldType.endsWith('>')) return 'ref';
  if (fieldType.startsWith('shared<') && fieldType.endsWith('>')) return 'shared';
  if (fieldType.startsWith('buffer<') && fieldType.endsWith('>')) return 'buffer';
  if (fieldType.startsWith('array<') && fieldType.endsWith('>')) return 'array';
  // Legacy scalar — the 11 types are keys in TYPE_METADATA.
  if (TYPE_METADATA[fieldType] !== undefined) return fieldType;
  return null;
}

/**
 * `true` when the schema field type is a managed-store slot - i.e. should be
 * routed through `UniqueRefStore` (or `SharedRefStore` for `'shared<T>'`)
 * for alloc / resolve / release. Derived from TYPE_METADATA[].isManaged
 * column (feat-20260611-ecs-storage-naming-ssot D-3).
 *
 * Naming note (D-6 whitelist): `managed = ECS-tracked`. The prefix here is
 * about column-side lifecycle ownership (the ECS releases the slot on
 * despawn / overwrite), not the retired `'managed' | 'unmanaged'` Handle
 * brand. Both `'unique<T>'` and `'shared<T>'` schema fields satisfy
 * `isManagedField` because both are ECS-tracked; the dispatcher in
 * `releaseManagedFieldOnRow` picks the right store per field type.
 */
export function isManagedField(fieldType: string): boolean {
  return TYPE_METADATA[fieldTypeToMetaKey(fieldType) ?? '']?.isManaged ?? false;
}

/**
 * `true` when the schema field type is a managed-buffer slot - i.e. should be
 * released by the M2 BufferPool release loop. Derived from
 * TYPE_METADATA[].isBuffer column (feat-20260611-ecs-storage-naming-ssot D-3/D-4).
 *
 * D-4 semantic widening accepted: `buffer<abc>` resolves to metaKey 'buffer'
 * (isBuffer=true) while the old regex-based impl rejected the non-integer N.
 * This is a dead path — `defineComponent` rejects `buffer<abc>` via
 * `isSchemaVocabKeyword` before the predicate fires.
 *
 * Naming note (D-6 whitelist): `managed = ECS-tracked`. Same semantic as
 * `isManagedField` — the variable `'buffer'` keyword is one whose
 * BufferPool slot the ECS releases at despawn / overwrite time.
 */
export function isManagedBufferField(fieldType: string): boolean {
  return TYPE_METADATA[fieldTypeToMetaKey(fieldType) ?? '']?.isBuffer ?? false;
}

/**
 * `true` when the schema field type is the single-entity reference keyword
 * `'entity'`. Derived from TYPE_METADATA[].isEntityRef column
 * (feat-20260611-ecs-storage-naming-ssot D-3).
 */
export function isEntityField(fieldType: string): boolean {
  return TYPE_METADATA[fieldTypeToMetaKey(fieldType) ?? '']?.isEntityRef ?? false;
}

/**
 * `true` when the schema field type is an `array<T,N>` / `array<T>` vocab
 * keyword. Derived from TYPE_METADATA[].isArray column
 * (feat-20260611-ecs-storage-naming-ssot D-3).
 *
 * Naming note (D-6 whitelist): `managed = ECS-tracked`. Variable
 * `array<T>` storage routes through BufferPool (slot lifecycle owned by
 * the ECS); fixed `array<T,N>` is inline stride-N and has no separate
 * slot to release, but both share this predicate as they share the
 * `'array'` meta key.
 */
export function isManagedArrayField(fieldType: string): boolean {
  return TYPE_METADATA[fieldTypeToMetaKey(fieldType) ?? '']?.isArray ?? false;
}

/**
 * Set of legal element types for the `array<T,N>` / `array<T>` keywords
 * (AC-03). Runtime mirror of `ManagedArrayElementType`.
 *
 * Naming note (D-6 whitelist): `MANAGED_ARRAY_ELEMENT_TYPES` keeps the
 * `MANAGED` prefix because `managed = ECS-tracked` here — the Set is the
 * static-whitelist arm of `isValidArrayElementType`, which gates which
 * element types the ECS array dispatch knows how to retain / release.
 * The `'shared<X>'` template family rides the `startsWith('shared<')`
 * special case (D-8) rather than living in this Set.
 */
export const MANAGED_ARRAY_ELEMENT_TYPES: ReadonlySet<ManagedArrayElementType> =
  new Set<ManagedArrayElementType>([
    'f32',
    'f64',
    'i32',
    'u32',
    'i16',
    'u16',
    'i8',
    'u8',
    'bool',
    'enum',
    'ref',
    'entity',
  ]);

/**
 * Return `true` when `elementType` is a legal array element type
 * (static-whitelist scalar | entity, or a `shared\<X\>` template with a
 * non-empty tag). The empty-tag form `shared\<\>` is rejected
 * (plan-strategy §2 D-1 / R-NEW-1).
 *
 * @internal
 */
function isValidArrayElementType(elementType: string): elementType is ManagedArrayElementType {
  if (MANAGED_ARRAY_ELEMENT_TYPES.has(elementType as ManagedArrayElementType)) return true;
  // feat-20260614 D-8: `shared<X>` is a legal element-type via the
  // startsWith special case; `MANAGED_ARRAY_ELEMENT_TYPES` Set deliberately
  // does NOT carry a `'shared'` entry (D-8 keeps the static-whitelist Set
  // free of the new family; runtime validation through the special case
  // here pairs with the independent `'shared'` TYPE_METADATA row that
  // routes element retain/release semantics in M4).
  if (elementType.startsWith('shared<') && elementType.endsWith('>') && elementType.length > 9)
    return true;
  return false;
}

/**
 * Parse an `array<T,N>` / `array<T>` schema string into its element type and
 * optional fixed length. Returns `null` if the string is not a managed-array
 * keyword or its element type is not in the whitelist (AC-03 runtime
 * fail-safe).
 *
 * Examples:
 *   parseManagedArraySchema('array<entity>')                => { elementType: 'entity', length: undefined }
 *   parseManagedArraySchema('array<f32, 16>')               => { elementType: 'f32',    length: 16 }
 *   parseManagedArraySchema('array<shared<MaterialAsset>>') => { elementType: 'shared<MaterialAsset>', length: undefined }
 *   parseManagedArraySchema('array<shared<>>')              => null (empty tag rejection)
 *   parseManagedArraySchema('array<unique<X>>')             => null (illegal element)
 *   parseManagedArraySchema('array<array<f32,4>>')          => null (nested rejected)
 *
 * Naming note (D-6 whitelist): `parseManagedArraySchema` keeps the
 * `Managed` infix because `managed = ECS-tracked` — every legal output
 * shape this parser returns is one whose lifecycle the ECS knows how to
 * retain / release on overwrite, despawn, or archetype migration.
 */
export function parseManagedArraySchema(
  fieldType: string,
): { readonly elementType: ManagedArrayElementType; readonly length: number | undefined } | null {
  if (!fieldType.startsWith('array<') || !fieldType.endsWith('>')) return null;
  const inner = fieldType.slice(6, -1);
  const commaIdx = inner.indexOf(',');
  if (commaIdx === -1) {
    // Variable-capacity: inner must be a bare element-type keyword or
    // handle<X> template.
    if (!isValidArrayElementType(inner)) return null;
    return { elementType: inner as ManagedArrayElementType, length: undefined };
  }
  // Fixed-capacity: split at first comma; element-type before, integer length
  // after. Reject any further '<' / ':' / ',' to keep the form unambiguous.
  const head = inner.slice(0, commaIdx).trim();
  const tail = inner.slice(commaIdx + 1).trim();
  if (!isValidArrayElementType(head)) return null;
  if (!/^[1-9]\d*$/.test(tail)) return null;
  return { elementType: head as ManagedArrayElementType, length: Number.parseInt(tail, 10) };
}

/**
 * Parse the byte count out of a `buffer<N>` schema keyword. Returns NaN if
 * the input does not match the keyword pattern - callers that already gated
 * via `isManagedBufferField` get a guaranteed-positive integer for the
 * fixed-byte form. The bare `'buffer'` keyword (variable byte capacity)
 * returns NaN and callers must check `fieldType === 'buffer'` separately.
 */
export function bufferFieldByteLength(fieldType: string): number {
  if (!fieldType.startsWith('buffer<') || !fieldType.endsWith('>')) return Number.NaN;
  const tail = fieldType.slice(7, -1);
  if (!/^[1-9]\d*$/.test(tail)) return Number.NaN;
  return Number.parseInt(tail, 10);
}

/**
 * Runtime check for a schema-vocab keyword (the tier-2 surface).
 *
 * Pure-function regex match — kept off the hot path; only invoked by
 * `defineComponent` once per field at registration time. The match patterns
 * are the runtime mirror of `SchemaVocabKeyword` template literals.
 *
 * - `'string'` is exact-match (bare literal, no `<>`).
 * - `'buffer'` is exact-match (variable-byte capacity).
 * - `buffer<N>` requires `N` to be a positive base-10 integer (`/^[1-9]\d*$/`).
 *   Forms like `buffer<abc>` / `buffer<0>` / `buffer<>` are rejected.
 * - `unique<T>` / `shared<T>` require a non-empty target tag (`/^\w+$/`).
 * - `entity` is exact-match.
 * - `array<T,N>` / `array<T>` accept only the whitelist element types
 *   (`MANAGED_ARRAY_ELEMENT_TYPES`); illegal inner types fall through and
 *   the caller surfaces `managed-array-element-type-not-allowed`.
 */
export function isSchemaVocabKeyword(s: string): s is SchemaVocabKeyword {
  if (s === 'string') return true;
  if (s === 'entity') return true;
  if (s === 'buffer') return true;
  if (s.startsWith('buffer<') && s.endsWith('>')) {
    const tail = s.slice(7, -1);
    return /^[1-9]\d*$/.test(tail);
  }
  if (s.startsWith('unique<') && s.endsWith('>')) {
    return /^\w+$/.test(s.slice(7, -1));
  }
  if (s.startsWith('shared<') && s.endsWith('>')) {
    return /^\w+$/.test(s.slice(7, -1));
  }
  if (s.startsWith('array<') && s.endsWith('>')) {
    return parseManagedArraySchema(s) !== null;
  }
  return false;
}

/**
 * Maps each field-type keyword to the JS value type read/written by it.
 *
 * Tier-1 (legacy scalars) widens to `boolean | number`; tier-2 (schema-vocab)
 * resolves to the corresponding handle / entity / buffer / array / string
 * shape via the `infer T` template-literal extraction pattern. Conditional
 * types resolve top-down --- the `'string'` arm sits BEFORE the array<...> /
 * `buffer<N>` arms so the precise literal wins template-literal resolution
 * (R-P5: prevents `'string'` from being shadowed by a wider template-literal
 * pattern). The fixed-capacity `array<T,N>` arm matches before the
 * variable-capacity `array<T>` arm by the same rule.
 *
 * The 4 buffer/array keywords (`'buffer'` / `'buffer<N>'` / `'array<T>'` /
 * `'array<T, N>'`) all resolve directly to a concrete TypedArray (or
 * Uint8Array for the byte-only buffer family). At the public `world.get`
 * boundary, a relationship-target `array<entity>` is a detached `Uint32Array`
 * snapshot. Other public array fields retain their existing transient live
 * TypedArray alias: fixed `buffer<N>` / `array<T,N>` values alias the inline
 * column buffer (feat-20260602), while variable `buffer` / `array<T>` values
 * alias the BufferPool slot bytes. Internal `readRow`, `_getArrayView`, and
 * `materializeArrayView` paths always use the live zero-copy alias. Mutation
 * flows through `world.set` / `world.push` / `world.pop`, not direct
 * assignment to a returned TypedArray.
 *
 * The `'string'` arm resolves to a native JS `string` (D-R1 / AC-13): the
 * dispatch routes the column u32 through `UniqueRefStore.resolve(handle)`
 * which returns the immutable string payload by reference.
 */
export type FieldValueType<T extends SchemaFieldType> = T extends 'bool'
  ? boolean
  : T extends 'entity'
    ? EntityHandle | null
    : T extends 'string'
      ? string
      : T extends 'buffer'
        ? Uint8Array
        : T extends `buffer<${number}>`
          ? Uint8Array
          : T extends `array<shared<${infer Target}>, ${number}>`
            ? readonly Handle<Target, 'shared'>[]
            : T extends `array<shared<${infer Target}>>`
              ? readonly Handle<Target, 'shared'>[]
              : T extends `array<${infer Elem extends ManagedArrayElementType}, ${number}>`
                ? TypedArrayFor<Elem extends 'entity' ? 'u32' : Elem>
                : T extends `array<${infer Elem extends ManagedArrayElementType}>`
                  ? TypedArrayFor<Elem extends 'entity' ? 'u32' : Elem>
                  : T extends `unique<${infer Target}>`
                    ? Handle<Target, 'unique'>
                    : T extends `shared<${infer Target}>`
                      ? Handle<Target, 'shared'>
                      : T extends ScalarFieldType
                        ? number
                        : never;

/**
 * Input-side counterpart of {@link FieldValueType} for write paths
 * (`world.spawn` / `world.addComponent` / `world.set`).
 *
 * Asymmetric on `array<scalar, N>` / `array<scalar>` ONLY: the read side
 * surfaces zero-copy `Float32Array` / `Uint32Array` / etc views; the write
 * side ALSO accepts `readonly number[]` because writeArrayField copies bytes
 * verbatim from either shape (TypedArray subarray() OR per-element pack via
 * DataView). Plain literals like `times: [0.5]` reach the same code path
 * with no Float32Array wrapper boilerplate at the call site, and short
 * prefixes pad the row tail with zero (writeArrayField D-3 contract).
 *
 * Asymmetric on `buffer` / `buffer<N>`: the read side returns `Uint8Array`,
 * but the write side accepts any `AllowSharedBufferSource` (Float32Array /
 * ArrayBuffer / Uint8Array / any TypedArray). The ECS buffer-write ingestion
 * point (`World.writeRow` / `World.set`) normalizes any view to `Uint8Array`
 * over its raw bytes before storing (feat-20260621 V2 / AC-A4). This lets AI
 * users write typed param payloads directly, e.g.
 * `world.set(e, PostProcessParams, { data: Float32Array.of(exposure,0,0,0) })`,
 * without manual byte-reinterpret boilerplate at the call site.
 *
 * Every other arm matches FieldValueType verbatim (no widening): handles
 * are already arrays-of-handle, scalars stay number, etc.
 */
export type FieldInputType<T extends SchemaFieldType> = T extends 'bool'
  ? boolean
  : T extends 'entity'
    ? EntityHandle | null
    : T extends 'string'
      ? string
      : T extends 'buffer'
        ? AllowSharedBufferSource
        : T extends `buffer<${number}>`
          ? AllowSharedBufferSource
          : T extends `array<shared<${infer Target}>, ${number}>`
            ? readonly Handle<Target, 'shared'>[]
            : T extends `array<shared<${infer Target}>>`
              ? readonly Handle<Target, 'shared'>[]
              : T extends `array<${infer Elem extends ManagedArrayElementType}, ${number}>`
                ? TypedArrayFor<Elem extends 'entity' ? 'u32' : Elem> | readonly number[]
                : T extends `array<${infer Elem extends ManagedArrayElementType}>`
                  ? TypedArrayFor<Elem extends 'entity' ? 'u32' : Elem> | readonly number[]
                  : T extends `unique<${infer Target}>`
                    ? Handle<Target, 'unique'>
                    : T extends `shared<${infer Target}>`
                      ? Handle<Target, 'shared'>
                      : T extends ScalarFieldType
                        ? number
                        : never;

/**
 * Maps a SchemaFieldType to its zero-copy query-column view type.
 *
 * Three storage shapes share the keyword space:
 *
 * 1. Scalar / fixed-inline columns -- the column buffer is the data, written
 *    in place. The bundle entry is a concrete writable TypedArray of the
 *    correct ctor (`f32` -> `Float32Array`, `'buffer<N>'` -> `Uint8Array`,
 *    `'array<T,N>'` -> the T-typed array). Direct index assignment is
 *    fine -- the column owns the bytes.
 *
 * 2. `shared\<X\>` (rc-tracked AssetRegistry reference) -- the column carries
 *    a u32 handle id; SharedRefStore owns the rc lifecycle. The bundle
 *    entry is a `ManagedColumnReader<T>` (D-4 / D-7) -- read-only, walk
 *    via `.get(i)`. Consumers route through `assets.get(handle)` to
 *    materialise the asset payload.
 *
 * 3. The 4 managed-vocab keywords -- `'string'` / `` `ref<T>` `` / variable
 *    `'buffer'` / variable `` `array<T>` `` -- the column carries a u32 slot
 *    id; the payload lives in `UniqueRefStore` / `BufferPool`. The bundle
 *    entry is a `ManagedColumnReader<T>` (D-4 / D-7) -- read-only by
 *    construction, no index signature. Mutation MUST flow through the
 *    public dispatch (`world.set` / `world.push` / `world.allocUniqueRef`).
 *
 * The `extends SchemaFieldType` upper bound matches `ComponentSchema[K]`
 * so query bundle types do not have to pre-filter.
 */
export type TypedArrayFor<T extends SchemaFieldType> = T extends 'f32'
  ? Float32Array
  : T extends 'f64'
    ? Float64Array
    : T extends 'i32'
      ? Int32Array
      : T extends 'u32' | 'enum' | 'ref' | 'entity'
        ? Uint32Array
        : T extends 'i16'
          ? Int16Array
          : T extends 'u16'
            ? Uint16Array
            : T extends 'i8'
              ? Int8Array
              : T extends 'u8' | 'bool'
                ? Uint8Array
                : T extends 'string'
                  ? ManagedColumnReader<'string'>
                  : T extends `unique<${string}>`
                    ? ManagedColumnReader<T>
                    : T extends `shared<${string}>`
                      ? ManagedColumnReader<T>
                      : T extends 'buffer'
                        ? ManagedColumnReader<'buffer'>
                        : T extends `buffer<${number}>`
                          ? Uint8Array
                          : T extends `array<${infer Elem extends ManagedArrayElementType}, ${number}>`
                            ? TypedArrayFor<
                                Elem extends 'entity' | `shared<${string}>` ? 'u32' : Elem
                              >
                            : T extends `array<${string}>`
                              ? ManagedColumnReader<T>
                              : never;

/**
 * Relationship metadata (feat-20260531 M2 / plan-strategy D-5). Declares this
 * component as the holder side of a Bevy-style bidirectional relationship: the
 * holder carries a single `entity` field (the target), and the engine mirrors
 * the reverse reference into `mirror`.`field` (an `array<entity>` on the target
 * entity) at add / remove / despawn time.
 *
 * - `mirror` — the mirror component's string NAME (not a type reference, so
 *   `engine-ecs` never imports the mirror component type; AC-29). The mirror
 *   component is a derived runtime view rebuilt by the relationship owner, so
 *   it MUST declare `transient: true` — otherwise scene collect serializes it
 *   and `instantiateScene` double-writes (serialized copy + owner rebuild).
 * - `field` — the `array<entity>` field on the mirror component that holds the
 *   reverse list. Validated to be exactly `'array<entity>'` at `defineComponent` time.
 * - `exclusive` — when `true`, re-adding the holder component with a new target
 *   auto-reparents (clears the old mirror entry, then appends the new one)
 *   instead of returning `ComponentAlreadyPresentError` (AC-12).
 * - `linkedSpawn` — when `true`, despawning the target recursively despawns the
 *   holders in its mirror list. Default `false` (D-1): despawn only prunes the
 *   mirror entry, the holder entity survives.
 */
/** A schema is a record of field-name → field-type keyword. */
export type ComponentSchema = Record<string, SchemaFieldType>;

/** Derive the JS value-shape from a schema (read side; zero-copy views). */
export type ShapeOf<S extends ComponentSchema> = {
  [K in keyof S]: FieldValueType<S[K]>;
};

/**
 * Derive the input-side value-shape from a schema (write side; widens
 * `array<scalar>` to also accept `readonly number[]` plus the strict
 * TypedArray view). Used by `world.spawn` / `world.addComponent` /
 * `world.set` `data` so AI users can write `times: [0.5]` instead of the
 * `new Float32Array([0.5])` boilerplate. writeArrayField walks both shapes
 * via the same byte-copy path so runtime semantics are identical.
 */
export type InputShapeOf<S extends ComponentSchema> = {
  [K in keyof S]: FieldInputType<S[K]>;
};

// ────────────────────────────────────────────────────────────────────────────
// ComponentId
// ────────────────────────────────────────────────────────────────────────────

/**
 * Numeric identity is an ECS-owner fact, not component authoring data. Keep it
 * out of the token's own enumerable surface so reflection sees only
 * `name`/`fields`/`storage`.
 */
/** Component owner identity shared by independently bundled ECS entry points. */
const COMPONENT_OWNER_REGISTRY = Symbol.for('forgeax.ecs.componentOwnerRegistry');
interface ComponentOwnerRegistry {
  nextId: number;
  readonly ids: WeakMap<object, ComponentId>;
  readonly schemas: WeakMap<object, Readonly<Record<string, SchemaFieldType>>>;
}
const ownerSymbols = globalThis as typeof globalThis & { [key: symbol]: unknown };
const ownerRegistry =
  (ownerSymbols[COMPONENT_OWNER_REGISTRY] as ComponentOwnerRegistry | undefined) ??
  (() => {
    const registry: ComponentOwnerRegistry = {
      nextId: 1,
      ids: new WeakMap<object, ComponentId>(),
      schemas: new WeakMap<object, Readonly<Record<string, SchemaFieldType>>>(),
    };
    ownerSymbols[COMPONENT_OWNER_REGISTRY] = registry;
    return registry;
  })();

let entityDefinitionSeen = false;
let componentDefinedBeforeEntity = false;

/** @internal Barrel-only check for the id=0 Entity import-order invariant. */
export function isComponentDefinitionOrderValid(): boolean {
  return !componentDefinedBeforeEntity;
}

/** @internal Read the owner-assigned identity for storage/archetype code. */
export function componentId(component: Component): ComponentId {
  const id = ownerRegistry.ids.get(component);
  if (id === undefined) throw new Error(`Component identity missing for '${component.name}'.`);
  return id;
}

/** @internal Derive the flat type map from the fields SSOT. */
export function componentSchema<const C extends Component>(component: C): Readonly<SchemaOf<C>> {
  const schema = ownerRegistry.schemas.get(component);
  if (schema === undefined) throw new Error(`Component schema missing for '${component.name}'.`);
  return schema as Readonly<SchemaOf<C>>;
}

/** Numeric identifier for a component type, used by bitmask matching and archetype edges. */
export type ComponentId = number;
export type ComponentStorage = 'table' | 'sparse';

// ────────────────────────────────────────────────────────────────────────────
// Token
// ────────────────────────────────────────────────────────────────────────────

declare const __componentBrand: unique symbol;

/**
 * Opaque component token. Carries the component name `N` as a string-literal
 * type parameter (lifted from the `defineComponent` call site via `<const N>`)
 * and the schema-shape `S` as a phantom brand so `world.get(e, Comp)` can
 * return `Result<ShapeOf<S>, EcsError>` precisely.
 *
 * The `N` parameter defaults to `string` to keep existing single-parameter
 * `Component<S>` annotations source-compatible. When inferred from a
 * `defineComponent('Position', ...)` call, `N` is the literal `'Position'`,
 * which lets query row/span mapped types resolve `{ [K in N]: ... }` to a
 * concrete keyed object instead of a degraded index signature (KD-1).
 */
export interface Component<N extends string = string, S extends ComponentSchema = ComponentSchema> {
  readonly name: N;
  /** The one schema projection: type, default, and enum labels per field. */
  readonly fields: Readonly<Record<keyof S & string, FieldReflection>>;
  readonly storage: ComponentStorage;
  readonly [__componentBrand]: ShapeOf<S>;
}

// ────────────────────────────────────────────────────────────────────────────
// TypedArray constructors — internal; consumed by `scalarRow()` to build
// TYPE_METADATA rows (feat-20260602 M4, w12).
// ────────────────────────────────────────────────────────────────────────────

/** TypedArray constructor for each scalar field type. */
const VIEW_CTORS: Readonly<
  Record<
    ScalarFieldType,
    | Float32ArrayConstructor
    | Float64ArrayConstructor
    | Int32ArrayConstructor
    | Uint32ArrayConstructor
    | Int16ArrayConstructor
    | Uint16ArrayConstructor
    | Int8ArrayConstructor
    | Uint8ArrayConstructor
  >
> = {
  f32: Float32Array,
  f64: Float64Array,
  i32: Int32Array,
  u32: Uint32Array,
  i16: Int16Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
  bool: Uint8Array,
  enum: Uint32Array,
  ref: Uint32Array,
};

// ────────────────────────────────────────────────────────────────────────────
// TYPE_METADATA — global per-type metadata table (feat-20260602 M1 / D-A6)
//
// Converges the 12 scattered type-intrinsic structures (3 tables + 9
// predicate / tool functions) into a single per-type authoritative table.
// Exports FIELD_SIZE_BYTES / VIEW_CTORS / isSchemaVocabKeyword /
// managedArrayElementBytes / SUPPORTED_FIELD_TYPES / storageFieldType were
// deleted M4 (w12); internal FIELD_SIZE_BYTES + VIEW_CTORS constants remain as
// build inputs for scalarRow(). All former consumers now read TYPE_METADATA:
// storage routing via fieldTypeToMetaKey() + TYPE_METADATA[key].storage,
// scalar checks via TYPE_METADATA[key]?.isScalar.
//
// Mixed key granularity (D-5): the 11 scalars are keyed by their concrete
// type (`f32` ... `ref`); the 6 vocab families are keyed by family (`entity`
// / `string` / `buffer` / `ref` / `handle` / `array`). The `array` row's T/N
// parameters are NOT table columns — they are parsed per-field into
// `arrayMeta` (see FieldDescriptor below). The vocab `ref` family row and
// the scalar `ref` row share the `'ref'` key intentionally: the scalar is a
// u32 column placeholder and the vocab `ref<T>` form maps to the same
// managed-ref storage, so one row carries both (isScalar + isManaged both
// true). tweak-20260612-ecs-concept-compression dropped redundant columns:
// `isVocabKeyword` (zero production consumers), the per-vocab managed-
// ref predicate column (100% duplicate of `isManaged`), and the YAGNI
// `fixedByteLength` placeholder;
// `isLegacyScalar` was renamed `isScalar` (the "legacy" prefix labelled the
// historical M2-introduction tense; the 11 scalars are first-class).
// ────────────────────────────────────────────────────────────────────────────

/**
 * One row of the global type-metadata table. Carries the type-intrinsic
 * properties a field type has regardless of which component declares it.
 *
 * - `byteSize` — element byte width for the column-storage scalar; `undefined`
 *   for families whose storage byte size is not a fixed per-type constant
 *   (variable buffer / array slot ids are u32-stored, surfaced via `storage`).
 * - `viewCtor` — TypedArray constructor for the column storage; `undefined`
 *   for families without a direct TypedArray column.
 * - `storage` — the column-storage scalar type this field routes to (every
 *   vocab family stores a u32 slot id / handle).
 * - `isScalar` — member of the 11 concrete scalar types
 *   (`f32`/`f64`/`i32`/`u32`/`i16`/`u16`/`i8`/`u8`/`bool`/`enum`/`ref`).
 * - `isManaged` — routed through `UniqueRefStore` (string / ref<T>).
 * - `isBuffer` — a `buffer` / `buffer<N>` managed-byte slot.
 * - `isEntityRef` — the single-entity `entity` reference keyword.
 * - `isArray` — an `array<T>` / `array<T,N>` keyword.
 */
export interface TypeMetadataRow {
  readonly byteSize: number | undefined;
  readonly viewCtor:
    | Float32ArrayConstructor
    | Float64ArrayConstructor
    | Int32ArrayConstructor
    | Uint32ArrayConstructor
    | Int16ArrayConstructor
    | Uint16ArrayConstructor
    | Int8ArrayConstructor
    | Uint8ArrayConstructor
    | undefined;
  readonly storage: ScalarFieldType;
  readonly isScalar: boolean;
  readonly isManaged: boolean;
  readonly isBuffer: boolean;
  readonly isEntityRef: boolean;
  readonly isArray: boolean;
}

/** Build a scalar row from the concrete scalar type. */
function scalarRow(t: ScalarFieldType): TypeMetadataRow {
  return {
    byteSize: FIELD_SIZE_BYTES[t],
    viewCtor: VIEW_CTORS[t],
    storage: t,
    isScalar: true,
    // The scalar `ref` shares its key with the vocab `ref<T>` family; mark
    // it as managed so the single row covers both.
    isManaged: t === 'ref',
    isBuffer: false,
    isEntityRef: false,
    isArray: false,
  };
}

/**
 * Global per-type metadata table. Keyed by concrete scalar type (11) plus
 * vocab family (6 — `entity` / `string` / `buffer` / `ref` / `handle` /
 * `array`). The `ref` key is shared by the legacy scalar and the vocab family
 * (see header). Every vocab family stores a u32 slot id / handle.
 *
 * Built once at module load; frozen so downstream consumers (column.ts /
 * archetype.ts / world.ts, migrated M2) read a stable single source.
 */
export const TYPE_METADATA: Readonly<Record<string, TypeMetadataRow>> = Object.freeze({
  f32: scalarRow('f32'),
  f64: scalarRow('f64'),
  i32: scalarRow('i32'),
  u32: scalarRow('u32'),
  i16: scalarRow('i16'),
  u16: scalarRow('u16'),
  i8: scalarRow('i8'),
  u8: scalarRow('u8'),
  bool: scalarRow('bool'),
  enum: scalarRow('enum'),
  ref: scalarRow('ref'),
  entity: {
    byteSize: 4,
    viewCtor: Uint32Array,
    storage: 'u32',
    isScalar: false,
    isManaged: false,
    isBuffer: false,
    isEntityRef: true,
    isArray: false,
  },
  string: {
    byteSize: 4,
    viewCtor: Uint32Array,
    storage: 'u32',
    isScalar: false,
    isManaged: true,
    isBuffer: false,
    isEntityRef: false,
    isArray: false,
  },
  buffer: {
    byteSize: 4,
    viewCtor: Uint32Array,
    storage: 'u32',
    isScalar: false,
    isManaged: false,
    isBuffer: true,
    isEntityRef: false,
    isArray: false,
  },
  // feat-20260614-ecs-shared-component-and-unique-rename M3 (plan-strategy
  // D-3): independent `'shared'` row, NOT a reuse of the `'ref'` (post-M2:
  // `'unique<T>'` family) row. `isManaged: true` so write-barrier dispatch
  // routes shared<T> fields through release on despawn / removeComponent /
  // set-overwrite, but the M4 sub-dispatch in releaseManagedFieldOnRow will
  // separate shared (rc--) from unique (direct slot drop) using the
  // fieldType.startsWith('shared<') predicate. Keeping the meta key
  // independent preserves the "meta key = release semantics" invariant
  // (architecture-principles.md #1 SSOT).
  shared: {
    byteSize: 4,
    viewCtor: Uint32Array,
    storage: 'u32',
    isScalar: false,
    isManaged: true,
    isBuffer: false,
    isEntityRef: false,
    isArray: false,
  },
  array: {
    byteSize: 4,
    viewCtor: Uint32Array,
    storage: 'u32',
    isScalar: false,
    isManaged: false,
    isBuffer: false,
    isEntityRef: false,
    isArray: true,
  },
});

// ────────────────────────────────────────────────────────────────────────────
// FieldDescriptor — input field-descriptor object + per-field reflection
// (feat-20260602 M1 / D-A1 / D-A3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pre-parsed `array<T>` / `array<T,N>` reflection. Bare length sentinel
 * (D-A1 user ruling): `length` present => fixed-capacity, `length === undefined`
 * => variable-capacity. No `isVariable` / `kind` field — both are losslessly
 * derivable from `length` presence (architecture-principles.md #2 Derive). This
 * is exactly the existing `parseManagedArraySchema` return shape (zero shape
 * change).
 */
export interface ArrayMeta {
  readonly elementType: ManagedArrayElementType;
  readonly length?: number;
}

/**
 * Input field-descriptor object (D-A3). The second `defineComponent` argument
 * may declare each field either as a bare type keyword (legacy flat form,
 * still accepted through M2; migrated repo-wide in M3) or as a descriptor
 * object aggregating `type` + `default` + semantic `shape` + field-level
 * `meta`.
 *
 * - `type` — the schema field-type keyword (a parametrized string such as
 *   `'array<f32,3>'` / `'unique<MaterialAsset>'` is used verbatim, D-A2).
 * - `default` — layer-2 default value; retained in the field reflection row.
 * - `shape` — producer-owned semantic shape tag for schema consumers; it does
 *   not change ECS storage or runtime value semantics.
 * - `meta` — field-level open namespace; aggregated into `component.meta`. The
 *   infra gives no key special meaning (open map, OOS-1).
 * - `transient` — when `true`, scene collect skips this field (D-5). Same word,
 *   same meaning as the component-level `transient` flag, with granularity sunk
 *   to the field level: a field that is derived/reconstructable (e.g. a resolved
 *   world mat4) is excluded from serialization while its component's persisted
 *   fields still round-trip. Absent (the common case) means the field is
 *   serialized.
 * - `labels` — for an `enum` field ONLY: the label→numeric-value map (e.g.
 *   `{ static: 0, dynamic: 1, kinematic: 2 }`). An `enum` field stores a bare
 *   `u32` variant index; the human-readable names historically lived in a
 *   SEPARATE per-package const map (`RigidBodyTypeValue`) + comment table, so no
 *   schema consumer could read them and the two could drift. Declaring `labels`
 *   attaches that map to the field itself (SSOT-adjacent): it is aggregated into
 *   `component.fields[field].labels` and surfaced by reflection consumers (the
 *   editor's `describeComponent`, inspector UIs, validation hints) so a
 *   docs-only user learns the legal variants + their integers from the schema
 *   alone. Pass the EXISTING `*Value` const map here (Derive, don't Duplicate —
 *   one object, two consumers). Absent for non-enum fields / enums that opt out.
 */
export interface FieldDescriptor<T extends SchemaFieldType = SchemaFieldType> {
  readonly type: T;
  readonly default?: FieldValueType<T>;
  /** Semantic authoring shape; storage still follows `type`. */
  readonly shape?: FieldShapeKind;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly transient?: boolean;
  readonly labels?: Readonly<Record<string, number>>;
}

/**
 * Per-field reflection produced at registration time and read off
 * `component.fields[fieldName]` (D-A3). Carries the pre-parsed facts: the
 * field `type`, its `default` (if any), semantic `shape` (if declared), — for
 * `array<...>` fields only — the pre-parsed `arrayMeta` (parse happens once at
 * registration, AC-03c), and the field-level `transient` flag (D-5) when
 * declared.
 *
 * `transient` mirrors the component-level `Component.transient` (same word,
 * same meaning): scene collect skips a `transient` field just as it skips a
 * `transient` component. Granularity is sunk to the field level so a component
 * can persist most of its fields while excluding a derived/reconstructable one
 * (e.g. `GlobalTransform.world`). Absent means the field participates in
 * serialization.
 */
export interface FieldReflection {
  readonly type: SchemaFieldType;
  readonly default?: unknown;
  /** Producer-declared semantic shape, when storage type alone is insufficient. */
  readonly shape?: FieldShapeKind;
  readonly arrayMeta?: ArrayMeta;
  readonly transient?: boolean;
  /**
   * For an `enum` field: the label→numeric-value map declared on the field
   * descriptor (see `FieldDescriptor.labels`). Lets a schema consumer resolve a
   * variant name ↔ its stored `u32` index without a separate const map. Absent
   * for non-enum fields / enums that did not declare labels.
   */
  readonly labels?: Readonly<Record<string, number>>;
}

/**
 * One input field-spec value: either the bare type keyword (legacy flat form)
 * or a field-descriptor object. Accepting both keeps the ~44 flat-string
 * call-sites + ~55 test files green through M1/M2 while the field-descriptor
 * form is migrated in repo-wide in M3 (D-A7 / D-A8 shrink the migration
 * surface to the input side only).
 */
export type FieldSpec<T extends SchemaFieldType = SchemaFieldType> = T | FieldDescriptor<T>;

/** An input field-spec map: field-name -> bare keyword | field-descriptor. */
export type FieldsInput = Record<string, FieldSpec>;

/**
 * Project an input field-spec map down to its flat `ComponentSchema` shape
 * (field-name -> type keyword). A bare-keyword spec maps to itself (identity,
 * so existing flat-string call-sites infer exactly as before); a descriptor
 * spec maps to its `type`. This keeps `Component<N, SchemaOf<F>>` driving every
 * downstream type (ShapeOf / query row/span projection / TypedArrayFor) unchanged.
 */
export type SchemaOf<F extends FieldsInput | Component> =
  F extends Component<string, infer S>
    ? S
    : F extends FieldsInput
      ? {
          [K in keyof F]: F[K] extends FieldDescriptor<infer T>
            ? T
            : F[K] extends SchemaFieldType
              ? F[K]
              : never;
        }
      : never;

// ────────────────────────────────────────────────────────────────────────────
// defineComponent
// ────────────────────────────────────────────────────────────────────────────

/** Optional configuration for `defineComponent` (w4, M3 consumer; w21 layer-2 defaults). */
export interface DefineComponentOptions {
  readonly storage?: ComponentStorage;
  /**
   * When `true`, the component is skipped by scene collect
   * (rootsToSceneAsset). The component stays in archetype columns and
   * participates normally in queries / world.get at runtime.
   *
   * Default: `false`. Mirror targets of relationship components should
   * declare `transient: true` so they are not serialized (their state is
   * rebuilt by the mirror hook after instantiateScene).
   */
  readonly transient?: boolean;
  /**
   * Components materialized automatically when this component is added.
   * Explicit data for a required component wins; the ECS appends only missing
   * identities at the spawn/add boundary, never from a frame system.
   */
  readonly requires?: readonly Component[];
  /**
   * Component-level open metadata namespace. Entries are copied into
   * `Component.meta` at registration; the ECS core assigns no meaning to any
   * key. Component-level entries win over field-level entries with the same
   * key, and consumers may extend the mutable map after registration.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Extract the bare field-type keyword from a field-spec (bare keyword | field-
 * descriptor object), fail-fast if a descriptor object is missing its `type`.
 * The throw carries the field name + expected shape (charter P3 / OOS-6: this
 * is a programmer error caught at registration time, no new EcsErrorCode).
 */
function fieldSpecType(fieldName: string, spec: FieldSpec): SchemaFieldType {
  if (typeof spec === 'string') return spec as SchemaFieldType;
  const t = (spec as FieldDescriptor).type;
  if (typeof t !== 'string') {
    throw new SchemaUnsupportedFieldError(
      fieldName,
      `<field-descriptor missing 'type'> (expected { type, default?, meta? })`,
    );
  }
  return t as SchemaFieldType;
}

/**
 * Define a component. Returns a frozen opaque token with exactly three runtime
 * facts: `.name`, `.fields`, and `.storage`. Numeric identity, flat schema,
 * and defaults are owner projections held outside the token.
 *
 * The second argument accepts each field either as a bare type keyword
 * ('f32', 'array<entity>', ...) or as a field-descriptor object
 * `{ type, default?, meta? }` (D-A3). The single `FieldsInput` overload
 * handles both forms — bare keywords are identity through `SchemaOf<F>`.
 *
 * The `<const N>` modifier lifts `name` to its string-literal type so the
 * returned `Component<N, SchemaOf<S>>` drives precise key-based mapped types
 * downstream (for example QueryRow and QuerySpan projections). At runtime `name` is a plain
 * string.
 *
 * Schema-field validation accepts both the legacy scalar tier
 * (`ScalarFieldType`, 11 keywords) and the schema-vocab tier
 * (`SchemaVocabKeyword`, 8 patterns including `array<T,N>` / `array<T>` /
 * `buffer` / `buffer<N>`). Mismatched values raise
 * `SchemaUnsupportedFieldError`. Illegal `array<...>` element types
 * (e.g. `array<ref<X>>`) raise `ManagedArrayElementTypeNotAllowedError`
 * (AC-03 runtime fail-safe).
 *
 * Relationship roles are declared through `defineRelationship`; component
 * definitions contain only schema vocabulary and no mirror metadata.
 *
 * @throws SchemaUnsupportedFieldError for any field type not in the supported
 *   set, or a field-descriptor object missing its `type`.
 * @throws ManagedArrayElementTypeNotAllowedError when an `array<...>`
 *   keyword carries an illegal element type.
 * @throws RelationshipMirrorComponentNotRegisteredError when
 *   `relationship.mirror` names a component not yet defined.
 * @throws RelationshipMirrorFieldTypeMismatchError when the mirror's
 *   `relationship.field` is missing or not typed `'array<entity>'`.
 */
// Single signature post-M4 (w12) — bare-keyword field specs are valid
// FieldSpec<T> values (identity through SchemaOf<F>), so flat-string schemas
// work without a separate overload. tweak-20260612-ecs-concept-compression
// dropped the redundant byte-identical overload declaration.
export function defineComponent<const N extends string, const S extends FieldsInput>(
  name: N,
  fields: S,
  options?: DefineComponentOptions,
): Component<N, SchemaOf<S>> {
  const storage = options?.storage ?? 'table';
  assertComponentStorage(storage);
  if (storage === 'sparse' && Object.keys(fields).length !== 0) {
    throw new SparseStorageRequiresTagError(name);
  }
  const schema: Record<string, SchemaFieldType> = {};
  const reflectedFields: Record<string, FieldReflection> = {};
  const collectedMeta: Record<string, unknown> = {};
  const collectedDefaults: Record<string, unknown> = {};

  for (const fieldName of Object.keys(fields)) {
    const spec = fields[fieldName] as FieldSpec;
    const fieldType = fieldSpecType(fieldName, spec);

    // Validate the field type — same fail-fast as before, now over the
    // normalized keyword.
    let arrayMeta: ArrayMeta | undefined;
    if (TYPE_METADATA[fieldType]?.isScalar === true) {
      // legacy scalar — ok
    } else if (fieldType === 'string') {
      // string vocab — ok
    } else if (fieldType.startsWith('array<') && fieldType.endsWith('>')) {
      const parsed = parseManagedArraySchema(fieldType);
      if (parsed === null) {
        const elementType = fieldType.slice(6, -1);
        throw new ManagedArrayElementTypeNotAllowedError(fieldName, elementType);
      }
      // Pre-parse once at registration (AC-03c): array fields cache arrayMeta.
      // Bare length sentinel {elementType, length?} (D-A1): drop `length` when
      // variable so the row is byte-identical to the parse return shape.
      arrayMeta = deepFreeze(
        parsed.length === undefined
          ? { elementType: parsed.elementType }
          : { elementType: parsed.elementType, length: parsed.length },
      );
    } else if (!isSchemaVocabKeyword(fieldType)) {
      throw new SchemaUnsupportedFieldError(fieldName, fieldType);
    }

    schema[fieldName] = fieldType;

    // Per-field reflection row — only attach arrayMeta / default when present
    // (exactOptionalPropertyTypes: never set an explicit `undefined`).
    const row: {
      type: string;
      default?: unknown;
      shape?: FieldShapeKind;
      arrayMeta?: ArrayMeta;
      transient?: boolean;
      labels?: Readonly<Record<string, number>>;
    } = {
      type: fieldType,
    };
    if (typeof spec !== 'string') {
      const desc = spec as FieldDescriptor;
      if ('default' in desc) {
        row.default = desc.default;
        collectedDefaults[fieldName] = desc.default;
      }
      if (desc.shape !== undefined) row.shape = desc.shape;
      if (desc.meta !== undefined) {
        Object.assign(collectedMeta, desc.meta);
      }
      // exactOptionalPropertyTypes: only attach `transient` when declared.
      if (desc.transient !== undefined) row.transient = desc.transient;
      // enum label→value map (see FieldDescriptor.labels). Frozen so the
      // reflected row exposes a stable read-only map. Only enum fields declare it.
      if (desc.labels !== undefined) row.labels = deepFreeze({ ...desc.labels });
    }
    if (arrayMeta !== undefined) row.arrayMeta = arrayMeta;
    reflectedFields[fieldName] = Object.freeze(row) as FieldReflection;
  }

  if (name === 'Entity') {
    entityDefinitionSeen = true;
  } else if (!entityDefinitionSeen) {
    componentDefinedBeforeEntity = true;
  }
  const id = name === 'Entity' ? 0 : ownerRegistry.nextId++;

  // Derived defaults projection (D-A8): pure from `fields[k].default`.
  // No longer merged with a removed `options.defaults` input — strict single-entry
  // means the only way to set a layer-2 default is through the field descriptor.
  const frozenDefaults =
    Object.keys(collectedDefaults).length === 0
      ? undefined
      : (deepFreeze(collectedDefaults) as Readonly<Partial<ShapeOf<SchemaOf<S>>>>);

  // Keep the component token immutable while leaving its open metadata map
  // extensible for higher-level consumers after registration.
  if (options?.meta !== undefined) {
    Object.assign(collectedMeta, options.meta);
  }
  const frozenSchema = deepFreeze(schema);
  const frozenFields = deepFreeze(reflectedFields);
  const meta = collectedMeta;
  const token = Object.freeze({ name, fields: frozenFields, storage }) as Component<N, SchemaOf<S>>;
  ownerRegistry.ids.set(token, id);
  ownerRegistry.schemas.set(token, frozenSchema);
  registerComponentDefinition(token, {
    fields: frozenFields,
    defaults: frozenDefaults,
    policy: {
      transient: options?.transient ?? false,
      meta,
      requires: Object.freeze([...(options?.requires ?? [])]),
    },
  });
  return Object.freeze(token);
}

export class ComponentInUseError extends Error {
  override readonly name = 'ComponentInUseError';
  readonly code = 'component-in-use' as const;
  readonly expected = 'the component to have no live entity or scheduled-system references';
  readonly hint =
    'Remove owning systems and component values before disposing the registration lease.';
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    super(`Component ${componentName} is still in use.`);
    this.detail = { componentName };
  }
}

export class ComponentNameConflictError extends Error {
  override readonly name = 'ComponentNameConflictError';
  readonly code = 'component-name-conflict' as const;
  readonly expected = 'one component token per name in a World';
  readonly hint =
    'Use the token already registered in this World or choose a distinct component name.';
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    super(`Component ${componentName} is already registered with a different token.`);
    this.detail = { componentName };
  }
}

export interface ComponentLease {
  readonly component: Component;
  dispose(): Result<void, ComponentInUseError>;
}

interface ComponentRegistration {
  readonly component: Component;
  owners: number;
}

/** World-local discovery and ownership boundary for plugin-installed component vocabulary. */
export class ComponentCatalog {
  private readonly registrations = new Map<string, ComponentRegistration>();

  constructor(private readonly inUse: (component: Component) => boolean) {}

  register(component: Component): Result<ComponentLease, ComponentNameConflictError> {
    const current = this.registrations.get(component.name);
    if (current !== undefined && current.component !== component) {
      return err(new ComponentNameConflictError(component.name));
    }
    if (current === undefined) {
      this.registrations.set(component.name, { component, owners: 1 });
    } else {
      current.owners += 1;
    }

    let active = true;
    return ok({
      component,
      dispose: () => {
        if (!active) return ok(undefined);
        const registration = this.registrations.get(component.name);
        if (registration === undefined || registration.component !== component) {
          active = false;
          return ok(undefined);
        }
        if (registration.owners > 1) {
          registration.owners -= 1;
          active = false;
          return ok(undefined);
        }
        if (this.inUse(component)) return err(new ComponentInUseError(component.name));
        this.registrations.delete(component.name);
        active = false;
        return ok(undefined);
      },
    });
  }

  resolve(name: string): Component | undefined {
    return this.registrations.get(name)?.component;
  }

  entries(): ReadonlyMap<string, Component> {
    return new Map(
      [...this.registrations].map(([name, registration]) => [name, registration.component]),
    );
  }
}
