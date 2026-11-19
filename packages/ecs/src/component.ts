import {
  createManagedArrayElementTypeNotAllowedError,
  createSparseStorageRequiresTagError,
} from './errors';
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

import {
  type AssetHandle,
  err,
  type Handle,
  ok,
  type Result,
  type ResultOk,
} from '@forgeax/engine-types';
import type { EntityHandle } from './entity-handle';
import { SchemaUnsupportedFieldError } from './errors';
import type { RelationshipRole } from './relationship-index';
import type { ManagedColumnReader } from './storage/column';

/** Native constructors own scalar conversion and byte width. */
const VIEW_CTORS = {
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
} as const;

/** Numeric scalar field types backed by TypedArray storage. */
export type ScalarFieldType = keyof typeof VIEW_CTORS;

/** Array elements are numeric scalars, entity handles, shared handles, or asset handles.
 * Unique handles, buffers, and nested arrays are excluded. */
export type ManagedArrayElementType =
  | ScalarFieldType
  | 'entity'
  | `shared<${string}>`
  | `asset<${string}>`;

/** Managed and reference field vocabulary. Registration validates tags and positive fixed lengths. */
export type SchemaVocabKeyword =
  | 'string'
  | `unique<${string}>`
  | `shared<${string}>`
  | `asset<${string}>`
  | 'entity'
  | `array<${ManagedArrayElementType}, ${number}>`
  | `array<${ManagedArrayElementType}>`;

/**
 * Closed union of every keyword `defineComponent` accepts for a schema field.
 * Combines the scalar tier with the schema-vocab tier.
 *
 * `ComponentSchema` is keyed against this union; `defineComponent` rejects
 * any field value not satisfying it (compile-time) or matching it
 * (runtime).
 */
export type SchemaFieldType = ScalarFieldType | SchemaVocabKeyword;

/** Producer-owned semantic shapes for reflection; physical layout still follows the storage type. */
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

/** Native scalar keys are closed; inherited object properties are never field types. */
export function isScalarFieldType(type: string): type is ScalarFieldType {
  return Object.hasOwn(VIEW_CTORS, type);
}

/** Non-parametric array element vocabulary. Tagged asset/shared elements use the same registration validator. */
export const MANAGED_ARRAY_ELEMENT_TYPES: ReadonlySet<ManagedArrayElementType> =
  new Set<ManagedArrayElementType>([...(Object.keys(VIEW_CTORS) as ScalarFieldType[]), 'entity']);

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
  if (elementType.startsWith('asset<') || elementType.startsWith('shared<'))
    return isSchemaVocabKeyword(elementType);
  return false;
}

/** Parse a valid array element and optional positive fixed length.
 * Returns null for invalid elements, nested arrays, or malformed lengths. */
export function parseManagedArraySchema(
  fieldType: string,
): { readonly elementType: ManagedArrayElementType; readonly length: number | undefined } | null {
  if (!fieldType.startsWith('array<') || !fieldType.endsWith('>')) return null;
  const inner = fieldType.slice(6, -1);
  const commaIdx = inner.indexOf(',');
  if (commaIdx === -1) {
    // Variable-capacity: inner must be a bare element-type keyword or
    // asset<kind> template.
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

/** Registration-time vocabulary validator; row operations consume compiled FieldPlans. */
export function isSchemaVocabKeyword(s: string): s is SchemaVocabKeyword {
  if (s === 'string') return true;
  if (s === 'entity') return true;
  if (s.startsWith('unique<') && s.endsWith('>')) {
    return /^\w+$/.test(s.slice(7, -1));
  }
  if (s.startsWith('asset<') && s.endsWith('>')) return /^[\w-]+$/.test(s.slice(6, -1));
  if (s.startsWith('shared<') && s.endsWith('>')) {
    return /^\w+$/.test(s.slice(7, -1));
  }
  if (s.startsWith('array<') && s.endsWith('>')) {
    return parseManagedArraySchema(s) !== null;
  }
  return false;
}

/** Public field value. Numeric arrays borrow TypedArray storage; asset arrays and
 * relationship target arrays are detached on read. String fields resolve to native strings.
 * Borrowed arrays must be re-read after structural changes; mutation uses World APIs. */
type ArrayElementOf<T extends SchemaFieldType> =
  T extends `array<${infer E extends ManagedArrayElementType}, ${number}>`
    ? E
    : T extends `array<${infer E extends ManagedArrayElementType}>`
      ? E
      : never;

type ArrayFieldValue<E extends ManagedArrayElementType> = E extends `asset<${infer Target}>`
  ? readonly AssetHandle<Target>[]
  : E extends `shared<${infer Target}>`
    ? readonly Handle<Target, 'shared'>[]
    : TypedArrayFor<E extends 'entity' ? 'u32' : E>;

export type FieldValueType<T extends SchemaFieldType> = T extends `asset<${infer Target}>`
  ? AssetHandle<Target>
  : T extends 'bool'
    ? boolean
    : T extends 'entity'
      ? EntityHandle | null
      : T extends 'string'
        ? string
        : T extends `array<${string}>`
          ? ArrayFieldValue<ArrayElementOf<T>>
          : T extends `unique<${infer Target}>`
            ? Handle<Target, 'unique'>
            : T extends `shared<${infer Target}>`
              ? Handle<Target, 'shared'>
              : T extends ScalarFieldType
                ? number
                : never;

/** Numeric array inputs accept their declared TypedArray or numeric literals.
 * Raw bytes are explicit Uint8Array views stored as array<u8>. */
export type FieldInputType<T extends SchemaFieldType> =
  | FieldValueType<T>
  | (T extends `array<${string}>`
      ? FieldValueType<T> extends ArrayBufferView
        ? readonly number[]
        : never
      : never);

/** Query column shape: scalar/fixed numeric fields expose typed storage, while
 * managed fields expose a read-only slot reader. Fixed asset arrays also retain managed access. */
export type TypedArrayFor<T extends SchemaFieldType> = T extends ScalarFieldType
  ? (typeof VIEW_CTORS)[T]['prototype']
  : T extends 'entity'
    ? Uint32Array
    : T extends `array<${infer E extends ManagedArrayElementType}, ${number}>`
      ? E extends `asset<${string}>`
        ? ManagedColumnReader<T>
        : TypedArrayFor<E extends 'entity' | `shared<${string}>` ? 'u32' : E>
      : ManagedColumnReader<T>;

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

/** Component token and partial initial values. Spawn/add resolve omitted fields
 * from definition/type defaults; write inputs accept plain numeric arrays and declared typed views. */
export interface ComponentData<S extends ComponentSchema = ComponentSchema> {
  component: Component<string, S>;
  data: Partial<InputShapeOf<S>>;
}

/** Shared fieldless values; canonical inputs bind their own component token. */
export const EMPTY_COMPONENT_VALUES: Readonly<Record<string, never>> = Object.freeze(
  Object.create(null) as Record<string, never>,
);
// ComponentId

/**
 * Numeric identity is an ECS-owner fact, not component authoring data. Keep it
 * out of the token's own enumerable surface so reflection sees only
 * `name`/`fields`/`storage`.
 */
/** Component owner identity shared by independently bundled ECS entry points. */
const COMPONENT_REGISTRY = Symbol.for('forgeax.ecs.componentRegistry.v3');
interface ComponentRegistry {
  nextId: number;
  readonly definitions: WeakMap<object, ComponentDefinition>;
  readonly relationships: WeakMap<Component, RelationshipRole>;
}
const componentSymbols = globalThis as typeof globalThis & { [key: symbol]: unknown };
const ownerRegistry =
  (componentSymbols[COMPONENT_REGISTRY] as ComponentRegistry | undefined) ??
  (() => {
    const registry: ComponentRegistry = {
      nextId: 1,
      definitions: new WeakMap(),
      relationships: new WeakMap(),
    };
    componentSymbols[COMPONENT_REGISTRY] = registry;
    return registry;
  })();

/** @internal Read the owner-assigned identity for storage/archetype code. */
/** @internal Identity probe for content keys; unregistered components are `undefined`. */
export function registeredComponentId(component: Component): ComponentId | undefined {
  return ownerRegistry.definitions.get(component)?.id;
}

export function componentId(component: Component): ComponentId {
  const id = registeredComponentId(component);
  if (id === undefined) throw new Error(`Component identity missing for '${component.name}'.`);
  return id;
}

/** @internal Derive the flat type map from the fields SSOT. */
export function componentSchema<const C extends Component>(component: C): Readonly<SchemaOf<C>> {
  const schema = ownerRegistry.definitions.get(component)?.schema;
  if (schema === undefined) throw new Error(`Component schema missing for '${component.name}'.`);
  return schema as Readonly<SchemaOf<C>>;
}

/** Numeric identifier for a component type, used by bitmask matching and archetype edges. */
export type ComponentId = number;
export type ComponentStorage = 'table' | 'sparse';
// Token

declare const __componentBrand: unique symbol;

/** Opaque token carrying a literal name and phantom schema for precise World/query inference.
 * Its runtime surface is exactly name, fields, and storage; identity belongs to the ECS owner. */
export interface Component<N extends string = string, S extends ComponentSchema = ComponentSchema> {
  readonly name: N;
  /** The one schema projection: type, default, and enum labels per field. */
  readonly fields: Readonly<Record<keyof S & string, FieldReflection>>;
  readonly storage: ComponentStorage;
  readonly [__componentBrand]: ShapeOf<S>;
}

/** Physical scalar layout. FieldPlan owns field semantics and lifecycle. */
export interface ScalarLayout {
  readonly byteSize: number;
  readonly viewCtor: {
    new (
      buffer: ArrayBufferLike,
      byteOffset?: number,
      length?: number,
    ): TypedArrayFor<ScalarFieldType>;
    new (length: number): TypedArrayFor<ScalarFieldType>;
  };
  readonly storage: ScalarFieldType;
}

function scalarLayout(storage: ScalarFieldType): ScalarLayout {
  return Object.freeze({
    storage,
    viewCtor: VIEW_CTORS[storage],
    byteSize: VIEW_CTORS[storage].BYTES_PER_ELEMENT,
  });
}

export const SCALAR_LAYOUTS = Object.freeze({
  f32: scalarLayout('f32'),
  f64: scalarLayout('f64'),
  i32: scalarLayout('i32'),
  u32: scalarLayout('u32'),
  i16: scalarLayout('i16'),
  u16: scalarLayout('u16'),
  i8: scalarLayout('i8'),
  u8: scalarLayout('u8'),
  bool: scalarLayout('bool'),
  enum: scalarLayout('enum'),
});
// FieldDescriptor — input field-descriptor object + per-field reflection
// (feat-20260602 M1 / D-A1 / D-A3)

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

/** Field authoring descriptor. Type selects storage; default fills omitted input.
 * Shape, transient, labels, and metadata serve reflection/serialization consumers.
 * Component metadata overrides field metadata with the same key. */
export interface FieldDescriptor<T extends SchemaFieldType = SchemaFieldType> {
  readonly type: T;
  readonly default?: FieldValueType<T>;
  /** Semantic authoring shape; storage still follows `type`. */
  readonly shape?: FieldShapeKind;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly transient?: boolean;
  readonly labels?: Readonly<Record<string, number>>;
}

/** Frozen field reflection produced at registration. Optional properties are absent
 * when undeclared; arrayMeta caches element type and optional fixed length. */
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
 * One input field-spec value: either the bare type keyword (bare keyword form)
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
// defineComponent

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

/** Compile the validated field into its physical layout and lifecycle route once. */
function deriveFieldPlan(field: FieldReflection): FieldPlan {
  const type = field.type;
  const array = field.arrayMeta;
  const elementType = array?.elementType ?? type;
  const reference = elementType.startsWith('shared<')
    ? 'shared'
    : elementType.startsWith('asset<')
      ? 'asset'
      : undefined;
  const referencePlan: Pick<PhysicalFieldPlan, 'reference' | 'target'> =
    reference === undefined
      ? {}
      : { reference, target: elementType.slice(reference.length + 1, -1) };
  if (array !== undefined) {
    const element = SCALAR_LAYOUTS[isScalarFieldType(elementType) ? elementType : 'u32'];
    const variable = array.length === undefined;
    return Object.freeze({
      kind: variable ? 'array' : 'fixed-array',
      storage: variable ? 'u32' : element.storage,
      arity: array.length ?? 3,
      releases: variable || reference !== undefined,
      element,
      array,
      ...referencePlan,
    });
  }
  return deriveSingularFieldPlan(type, referencePlan);
}

/** Scalars and handles; sequences use the same element layout above. */
function deriveSingularFieldPlan(
  type: string,
  referencePlan: Pick<PhysicalFieldPlan, 'reference' | 'target'>,
): FieldPlan {
  let kind: Exclude<FieldKind, 'array' | 'fixed-array'>;
  if (type === 'bool' || type === 'entity' || type === 'string') kind = type;
  else if (referencePlan.reference !== undefined) kind = referencePlan.reference;
  else if (type.startsWith('unique<')) kind = 'unique';
  else kind = 'number';
  return Object.freeze({
    kind,
    storage: isScalarFieldType(type) ? type : 'u32',
    arity: 1,
    releases: kind === 'string' || kind === 'unique' || referencePlan.reference !== undefined,
    ...referencePlan,
  });
}

/** Define a frozen token from bare keywords or field descriptors.
 * Literal names and SchemaOf preserve query and mutation inference.
 * Invalid types fail at registration; relationships are declared with defineRelationship. */
export function defineComponent<const N extends string, const S extends FieldsInput>(
  name: N,
  fields: S,
  options?: DefineComponentOptions,
): Component<N, SchemaOf<S>> {
  const storage = options?.storage ?? 'table';
  assertComponentStorage(storage);
  if (storage === 'sparse' && Object.keys(fields).length !== 0) {
    throw createSparseStorageRequiresTagError(name);
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
    if (fieldType.startsWith('array<') && fieldType.endsWith('>')) {
      const parsed = parseManagedArraySchema(fieldType);
      if (parsed === null) {
        const elementType = fieldType.slice(6, -1);
        throw createManagedArrayElementTypeNotAllowedError(fieldName, elementType);
      }
      // Pre-parse once at registration (AC-03c): array fields cache arrayMeta.
      // Bare length sentinel {elementType, length?} (D-A1): drop `length` when
      // variable so the row is byte-identical to the parse return shape.
      arrayMeta = deepFreeze(
        parsed.length === undefined
          ? { elementType: parsed.elementType }
          : { elementType: parsed.elementType, length: parsed.length },
      );
    } else if (!isScalarFieldType(fieldType) && !isSchemaVocabKeyword(fieldType)) {
      throw new SchemaUnsupportedFieldError(fieldName, fieldType);
    }

    schema[fieldName] = fieldType;

    // Per-field reflection row — only attach arrayMeta / default when present
    // (exactOptionalPropertyTypes: never set an explicit `undefined`).
    const row: { -readonly [Property in keyof FieldReflection]: FieldReflection[Property] } = {
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
    reflectedFields[fieldName] = Object.freeze(row);
  }

  const id = name === 'Entity' ? 0 : ownerRegistry.nextId++;

  // Derived defaults projection (D-A8): pure from `fields[k].default`.
  // Each field descriptor is the authority for its default.
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
  const token = Object.freeze({ name, fields: frozenFields, storage }) as Component<N, SchemaOf<S>>;
  const fieldPlans: Record<string, FieldPlan> = {};
  for (const [fieldName, field] of Object.entries(reflectedFields))
    fieldPlans[fieldName] = deriveFieldPlan(field);
  const fieldNames = Object.freeze(Object.keys(frozenFields));
  const plans = Object.values(fieldPlans);
  const plan: ComponentPlan = Object.freeze({
    fields: Object.freeze({ ...fieldPlans }),
    releaseFields: Object.freeze(fieldNames.filter((name) => fieldPlans[name]?.releases === true)),
    hasAssetField: plans.some((field) => field.reference === 'asset'),
    hasArrayField: Object.values(frozenFields).some((field) => field.arrayMeta !== undefined),
    hasSharedField: plans.some((field) => field.reference === 'shared'),
    hasLabeledEnum: Object.values(frozenFields).some(
      (field) => field.type === 'enum' && field.labels !== undefined,
    ),
    scalarOnly: plans.every(
      (field) => field.kind === 'number' || field.kind === 'bool' || field.kind === 'entity',
    ),
  });
  ownerRegistry.definitions.set(
    token,
    Object.freeze({
      id,
      schema: frozenSchema,
      fields: frozenFields,
      defaults: frozenDefaults,
      policy: {
        transient: options?.transient ?? false,
        meta: collectedMeta,
        requires: Object.freeze([...(options?.requires ?? [])]),
      },
      fieldNames,
      plan,
      emptyInput: fieldNames.length === 0 ? createEmptyComponentInput(token) : undefined,
    }),
  );
  return token;
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

/**
 * Serialization facts owned beside schema registration, not carried by the
 * public component token. Queries and storage only need the token's schema
 * vocabulary; domain validation and lifecycle belong to their owners.
 */
export interface ComponentPolicy {
  readonly transient: boolean;
  readonly meta: Record<string, unknown>;
  /** Components that are materialized whenever this component is added. */
  readonly requires: readonly Component[];
}

/**
 * Storage dispatch derived once from a field's type keyword, so write, read
 * and release paths never re-parse schema strings per row.
 */
export type FieldKind =
  | 'number'
  | 'bool'
  | 'entity'
  | 'string'
  | 'unique'
  | 'shared'
  | 'asset'
  | 'array'
  | 'fixed-array';

interface PhysicalFieldPlan {
  readonly storage: ScalarFieldType;
  readonly arity: number;
  readonly reference?: 'asset' | 'shared';
  readonly target?: string;
  readonly releases: boolean;
}

export interface ArrayFieldPlan extends PhysicalFieldPlan {
  readonly kind: 'array' | 'fixed-array';
  readonly element: ScalarLayout;
  readonly array: ArrayMeta;
}

export type FieldPlan =
  | ArrayFieldPlan
  | (PhysicalFieldPlan & {
      readonly kind: Exclude<FieldKind, 'array' | 'fixed-array'>;
      readonly element?: never;
      readonly array?: never;
    });

/** Component-level answers derived from its field plans. */
export interface ComponentPlan {
  readonly fields: Readonly<Record<string, FieldPlan>>;
  /** Fields whose row value must be released before removal or overwrite. */
  readonly releaseFields: readonly string[];
  readonly hasAssetField: boolean;
  readonly hasArrayField: boolean;
  readonly hasSharedField: boolean;
  readonly hasLabeledEnum: boolean;
  /** Every field is a numeric, bool or entity scalar column. */
  readonly scalarOnly: boolean;
}

/** Immutable schema reflection plus non-token policy projection. */
export interface ComponentDefinition {
  readonly id: ComponentId;
  readonly schema: Readonly<ComponentSchema>;
  readonly fieldNames: readonly string[];
  readonly fields: Readonly<Record<string, FieldReflection>>;
  readonly defaults: Readonly<Record<string, unknown>> | undefined;
  readonly policy: ComponentPolicy;
  readonly plan: ComponentPlan;
  readonly emptyInput?: ResultOk<Readonly<ComponentData>> | undefined;
}

/** One identity shares definition and relationship facts across bundled entries. */
export const componentRelationshipRoles = ownerRegistry.relationships;

/** Read the definition-time schema/policy projection for a component token. */
export function componentDefinition(component: Component): ComponentDefinition {
  const definition = ownerRegistry.definitions.get(component);
  if (definition === undefined) {
    throw new Error(`Component definition missing for '${component.name}'.`);
  }
  return definition;
}

function createEmptyComponentInput(component: Component): ResultOk<Readonly<ComponentData>> {
  return Object.freeze(ok(Object.freeze({ component, data: EMPTY_COMPONENT_VALUES })));
}

/** Read a canonical fieldless input, without adding work to general metadata lookup. */
export function componentEmptyInput(
  component: Component,
): ResultOk<Readonly<ComponentData>> | undefined {
  const definition = componentDefinition(component);
  if (definition.fieldNames.length !== 0) return undefined;
  if (definition.emptyInput !== undefined) return definition.emptyInput;
  // A same-v2 bundle may have registered this frozen definition before the cache existed.
  // Preserve its schema, plan and numeric identity; enrich it once in the existing owner.
  const emptyInput = createEmptyComponentInput(component);
  ownerRegistry.definitions.set(component, Object.freeze({ ...definition, emptyInput }));
  return emptyInput;
}

/** Read the generic structural requirements declared by one component. */
export function componentRequirements(component: Component): readonly Component[] {
  // Keep invalid/foreign tokens on the ordinary preflight error path. The
  // expansion helper runs before validation, so it must not turn a structured
  // `component-not-defined` Result into an uncaught registry exception.
  return ownerRegistry.definitions.get(component)?.policy.requires ?? [];
}

type ComponentDataLike = {
  readonly component: Component;
  readonly data: Partial<Record<string, unknown>>;
};

/**
 * Expand component requirements once at the structural boundary.
 *
 * Explicit component data wins and is never duplicated. Requirements are
 * appended in declaration order, and the same identity set also terminates a
 * malformed dependency cycle without a per-frame scan.
 */
export function expandComponentRequirements<T extends ComponentDataLike>(
  componentDatas: readonly T[],
): T[] {
  let hasRequirements = false;
  for (const entry of componentDatas) {
    if (componentRequirements(entry.component).length !== 0) {
      hasRequirements = true;
      break;
    }
  }
  // Most structural operations use components without dependencies. Preserve
  // that path without copying or allocating a Set. The returned list retains
  // caller ownership when no expansion is needed.
  if (!hasRequirements) return componentDatas as T[];

  const expanded = [...componentDatas];
  const seen = new Set<Component>(expanded.map((entry) => entry.component));
  for (let index = 0; index < expanded.length; index++) {
    const component = expanded[index]?.component;
    if (component === undefined) continue;
    for (const required of componentRequirements(component)) {
      if (seen.has(required)) continue;
      seen.add(required);
      expanded.push({ component: required, data: {} } as T);
    }
  }
  return expanded;
}

/** Ordered implicit additions for one structural insertion. */
export function implicitComponentInputs(
  entry: ComponentData,
): readonly ComponentData[] | undefined {
  if (componentRequirements(entry.component).length === 0) return undefined;
  const expanded = expandComponentRequirements([entry]);
  expanded.shift();
  return expanded;
}

/**
 * Freeze a schema value recursively.  Component descriptors are authored data,
 * so nested defaults and enum label maps must not become mutation channels.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as Readonly<T>;
  }
  // Non-empty TypedArrays reject Object.freeze and their indexed elements
  // remain writable even when the wrapper is frozen. Treat binary views as
  // immutable leaf projections; the authored descriptor around them is still
  // recursively frozen by this function.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value as Readonly<T>;
  }
  const object = value as object;
  for (const key of Reflect.ownKeys(object)) {
    const child = (object as Record<PropertyKey, unknown>)[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value) as Readonly<T>;
}

export function assertComponentStorage(value: string): asserts value is ComponentStorage {
  if (value !== 'table' && value !== 'sparse') {
    throw new Error(`Unsupported component storage '${value}'. Expected 'table' or 'sparse'.`);
  }
}
