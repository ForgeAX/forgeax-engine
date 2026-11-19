import {
  ASSET_ERROR_HINTS,
  AssetError,
  type AssetReferenceOwner,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  type ArrayFieldPlan,
  type Component,
  type ComponentData,
  type ComponentSchema,
  componentDefinition,
  componentId,
  EMPTY_COMPONENT_VALUES,
  type FieldReflection,
} from './component';
import { Entity } from './entity';
import { ENTITY_NULL_RAW } from './entity-handle';
import {
  type ComponentFieldInvalidValueError,
  createComponentFieldInvalidValueError,
  createManagedArrayInvalidValueError,
  createRelationshipTargetReadonlyError,
  createSharedFieldInvalidValueError,
  createSpawnDataUnknownFieldError,
  type ManagedArrayInvalidValueError,
  type RelationshipTargetReadonlyError,
  RemoveEntityComponentError,
  type SharedFieldInvalidValueError,
  type SpawnDataUnknownFieldError,
} from './errors';
import { isRelationshipTarget } from './relationship-index';

// Shared raw input defaults for spawn and component insertion.

/** Raw fallback for an omitted field: false for bool, null-entity sentinel for entity,
 * an empty entity array, and zero otherwise. Row writers materialize managed defaults. */
function typeDefault(fieldType: string): unknown {
  // bool is the only scalar arm with a non-zero default.
  if (fieldType === 'bool') return false;
  // 'entity' uses the runtime NULL_ENTITY sentinel (0xffffffff).
  if (fieldType === 'entity') return ENTITY_NULL_RAW;
  // 'array<entity>' is the only array<T> arm whose layer-3 default is a
  // JS array literal — entity[] runtime shape is a JS Array<Entity>,
  // not a variable extent id (D-2 asymmetric pivot).
  if (fieldType === 'array<entity>') return [];
  // every other vocab keyword (incl. 'string' / 'unique<T>' / 'asset<kind>'
  // / 'array<T>' (T!=entity) / 'array<T, N>')
  // and every remaining ScalarFieldType (f* / i* / u* / enum)
  // defaults to numeric 0 at the spawn-data raw surface. Layer-4
  // silent fallback inside writeRow turns 0 into the empty-slot
  // shape on the column-store side when applicable.
  return 0;
}

/** Fill omitted fields from definition defaults, then type defaults.
 * Explicit properties (including inherited properties and undefined) win.
 * Returns a fresh record; fieldless tags share one frozen empty record. */
export function fillComponentDefaults<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const definition = componentDefinition(token);
  const fieldNames = definition.fieldNames;
  // Tags have nothing to fill; one frozen record serves every caller.
  if (fieldNames.length === 0) return EMPTY_COMPONENT_VALUES;
  const schema = definition.schema;
  const layer2 = definition.defaults;
  // A plain literal keeps the record in fast (shared hidden class) mode; only a
  // schema declaring `__proto__` needs the prototype-free dictionary form.
  const out: Record<string, unknown> = Object.hasOwn(schema, '__proto__')
    ? Object.create(null)
    : {};
  for (let index = 0; index < fieldNames.length; index++) {
    const fieldName = fieldNames[index] as string;
    const fieldType = schema[fieldName];
    if (fieldType === undefined) continue;
    if (raw !== undefined && fieldName in raw) out[fieldName] = raw[fieldName];
    else if (layer2 !== undefined && fieldName in layer2) out[fieldName] = layer2[fieldName];
    else out[fieldName] = typeDefault(fieldType);
  }
  return out;
}

/** An owned, initialized payload. World admission still checks current references. */
export class InitializedComponentData implements ComponentData {
  #initialized = true;
  readonly data: ComponentData['data'];

  constructor(
    readonly component: Component,
    raw: Readonly<Record<string, unknown>> | undefined,
  ) {
    this.data = fillComponentDefaults(component, raw) as ComponentData['data'];
  }

  static is(input: ComponentData): input is InitializedComponentData {
    return #initialized in input;
  }
}

// Re-export the private dispatch for unit-test introspection (t1
// keyword pin — every vocab arm gets a one-liner it() block). The
// helper-private arity is preserved at callers via the
// `fillComponentDefaults` boundary.
export { typeDefault };

/** Reject unknown own keys before mutation. Validation does not require every schema field. */
export function validateComponentDataKeys<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): SpawnDataUnknownFieldError | null {
  if (raw === undefined) return null;
  const definition = componentDefinition(token);
  const schema = definition.schema;
  const rawObj = raw as Record<string, unknown>;
  for (const fieldName in rawObj) {
    if (!(fieldName in schema) && Object.hasOwn(rawObj, fieldName)) {
      return createSpawnDataUnknownFieldError(token.name, fieldName, definition.fieldNames);
    }
  }
  return null;
}

// Value admission is shared by spawn, insertion, and patching before mutation.

/** The declared element codec also owns which views may be copied or detached. */
export function isArrayPayload(value: unknown, field: ArrayFieldPlan): boolean {
  return Array.isArray(value) || value instanceof field.element.viewCtor;
}

/** One payload pass after asset validation; array errors precede shared errors. */
export function validateComponentFieldValues(
  component: Component,
  data: Readonly<Record<string, unknown>>,
  validateAsset: (handle: number, target: string) => Result<void, AssetError>,
): Result<void, AssetError | ManagedArrayInvalidValueError | SharedFieldInvalidValueError> {
  const definition = componentDefinition(component);
  const plan = definition.plan;
  if (plan.hasAssetField) {
    const assets = visitAssetFields(component, data, validateAsset);
    if (!assets.ok) return assets;
  }
  if (!plan.hasArrayField && !plan.hasSharedField) return NO_ASSET_FIELDS;
  let sharedError: SharedFieldInvalidValueError | undefined;
  for (const name in data) {
    const field = plan.fields[name];
    if (field === undefined) continue;
    const value = data[name];
    if (value === undefined || value === null) continue;
    const type = definition.fields[name]?.type as string;
    if (field.kind === 'array' || field.kind === 'fixed-array') {
      if (value !== 0 && !isArrayPayload(value, field))
        return err(createManagedArrayInvalidValueError(component.name, name, type, value));
    }
    if (field.reference !== 'shared' || sharedError !== undefined || !Object.hasOwn(data, name))
      continue;
    if (field.kind === 'shared') {
      if (typeof value !== 'number')
        sharedError = createSharedFieldInvalidValueError(component.name, name, type, value);
    } else if (Array.isArray(value)) {
      sharedError = invalidSharedArrayElement(component.name, name, type, value);
    }
  }
  return sharedError === undefined ? NO_ASSET_FIELDS : err(sharedError);
}

/** Keep the first bad shared element while the caller finishes array admission. */
function invalidSharedArrayElement(
  componentName: string,
  fieldName: string,
  type: string,
  values: readonly unknown[],
): SharedFieldInvalidValueError | undefined {
  for (let index = 0; index < values.length; index++) {
    const element = values[index];
    if (element !== undefined && element !== null && typeof element !== 'number')
      return createSharedFieldInvalidValueError(componentName, fieldName, type, element, index);
  }
  return undefined;
}

const NO_ASSET_FIELDS: Result<undefined, AssetError> = Object.freeze(ok(undefined));

/** Visit references in the supplied binding only; never inspect existing holders. */
export function visitAssetFields(
  component: Component,
  data: Readonly<Record<string, unknown>>,
  visit: (handle: number, target: string) => Result<void, AssetError>,
): Result<void, AssetError> {
  // Guard outside the closure-capturing body (see holdAssetFields).
  if (!componentDefinition(component).plan.hasAssetField) return NO_ASSET_FIELDS;
  return visitDeclaredAssetFields(component, data, visit);
}

function visitDeclaredAssetFields(
  component: Component,
  data: Readonly<Record<string, unknown>>,
  visit: (handle: number, target: string) => Result<void, AssetError>,
): Result<void, AssetError> {
  const definition = componentDefinition(component);
  for (const key of Object.keys(data)) {
    const plan = definition.plan.fields[key];
    if (plan?.reference !== 'asset') continue;
    const field = definition.fields[key] as FieldReflection;
    const target = plan.target as string;
    const value = data[key];
    if (value === undefined || value === null || value === 0) continue;
    const validate = (handle: unknown): Result<void, AssetError> => {
      if (
        typeof handle !== 'number' ||
        !Number.isInteger(handle) ||
        handle < 0 ||
        handle > 0xffff_ffff
      )
        return err(invalidAssetBinding(`${component.name}.${key}: a runtime ${target} reference`));
      return handle === 0 ? ok(undefined) : visit(handle, target);
    };
    if (field.arrayMeta === undefined) {
      const result = validate(value);
      if (!result.ok) return result;
    } else {
      // Float/byte views cannot carry u32 reference encodings. Do not reinterpret them.
      if (!Array.isArray(value) && !(value instanceof Uint32Array))
        return err(invalidAssetBinding(`${component.name}.${key}: a reference array`));
      const count = Math.min(value.length, field.arrayMeta.length ?? value.length);
      for (let i = 0; i < count; i++) {
        const result = validate(value[i]);
        if (!result.ok) return result;
      }
    }
  }
  return ok(undefined);
}

export function invalidAssetBinding(expected: string): AssetError {
  return new AssetError({
    code: 'asset-reference-invalid',
    expected,
    hint: ASSET_ERROR_HINTS['asset-reference-invalid'],
  });
}

/** Owner disposal already retires its contents; later World teardown needs no release. */
export function releaseAssetReference(
  owner: AssetReferenceOwner | undefined,
  handle: number,
): void {
  if (handle === 0) return;
  if (owner === undefined) throw invalidAssetBinding('the attached asset owner during release');
  const released = owner.release(handle);
  if (!released.ok && released.error.code !== 'asset-owner-closed') throw released.error;
}

/** A temporary hold allows swaps across fields even when the World is the last holder. */
export function holdAssetFields(
  owner: AssetReferenceOwner | undefined,
  component: Component,
  data: Readonly<Record<string, unknown>>,
): Result<(() => void) | undefined, AssetError> {
  // The guard lives outside the closure-capturing body: V8 allocates that
  // body's context on entry, before any early return.
  if (!componentDefinition(component).plan.hasAssetField) return NO_ASSET_FIELDS;
  return holdDeclaredAssetFields(owner, component, data);
}

function holdDeclaredAssetFields(
  owner: AssetReferenceOwner | undefined,
  component: Component,
  data: Readonly<Record<string, unknown>>,
): Result<(() => void) | undefined, AssetError> {
  let held: number[] | undefined;
  const release = () => {
    if (held !== undefined) for (const handle of held) releaseAssetReference(owner, handle);
  };
  const result = visitAssetFields(component, data, (handle, target) => {
    if (owner === undefined)
      return err(invalidAssetBinding('an asset owner attached to the World'));
    const retained = owner.retain(handle, target);
    if (retained.ok) {
      held ??= [];
      held.push(handle);
    }
    return retained;
  });
  if (!result.ok) {
    release();
    return result;
  }
  return ok(held === undefined ? undefined : release);
}

/**
 * Validate the closed enum fields present in a write payload. Enums without
 * labels remain open numeric fields for compatibility with existing schemas.
 */
export function validateEnumFieldValues<S extends ComponentSchema>(
  component: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entity?: number,
): ComponentFieldInvalidValueError | null {
  if (raw === undefined) return null;
  const definition = componentDefinition(component);
  if (!definition.plan.hasLabeledEnum) return null;
  const fields = definition.fields as Readonly<Record<string, FieldReflection>>;
  const rawValues = raw as Record<string, unknown>;
  for (const fieldName of Object.keys(rawValues)) {
    const reflection = fields[fieldName];
    if (reflection?.type !== 'enum' || reflection.labels === undefined) continue;
    const value = rawValues[fieldName];
    const allowedValues = Object.values(reflection.labels);
    if (typeof value !== 'number' || !Number.isInteger(value) || !allowedValues.includes(value)) {
      return createComponentFieldInvalidValueError(
        entity,
        component.name,
        fieldName,
        value,
        reflection.labels,
      );
    }
  }
  return null;
}

/** Structural protection shared by direct removal and deferred admission. */
export function componentRemovalError(
  component: Component,
  internal = false,
): RelationshipTargetReadonlyError | RemoveEntityComponentError | undefined {
  if (!internal && isRelationshipTarget(component))
    return createRelationshipTargetReadonlyError(component.name, 'removeComponent');
  if (componentId(component) === componentId(Entity)) return new RemoveEntityComponentError();
  return undefined;
}
