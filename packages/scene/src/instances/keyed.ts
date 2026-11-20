import type { Component, World } from '@forgeax/engine-ecs';
import { classifyEntityField, remapEntityFieldValue } from '@forgeax/engine-ecs/externalization';
import { componentDefinition, componentSchema } from '@forgeax/engine-ecs/internal';
import type {
  ComponentValuesMap,
  LocalEntityId,
  SceneAsset,
  SceneEntityAddress,
} from '@forgeax/engine-types';
import {
  type AssetHandle,
  err,
  ok,
  PACK_ERROR_HINTS,
  type Result,
  type SceneEntity,
} from '@forgeax/engine-types';
import { migrateLegacySceneComponentFields, normalizeLegacySceneAsset } from './legacy.js';
import type { MountOverride, SceneInstanceMount } from './runtime-types.js';
import { isPrimitiveScalarFieldType, primitiveJsType } from './state.js';

/** Numeric representation used only inside the Scene runtime. */
export interface CompiledSceneEntity {
  readonly localId: LocalEntityId;
  readonly components: Partial<ComponentValuesMap>;
}

export interface CompiledSceneAsset {
  readonly kind: 'scene';
  readonly entities: readonly CompiledSceneEntity[];
  readonly mounts?: readonly SceneInstanceMount[];
  readonly skinGuids?: readonly string[];
}

export interface CompiledSceneResult {
  readonly asset: CompiledSceneAsset;
  readonly keyByLocalId: ReadonlyMap<number, string>;
  readonly mountKeyByLocalId: ReadonlyMap<number, string>;
  /** Private slots that attach directly to this scene's synthetic root. */
  readonly rootLocalIds: readonly number[];
  /** Effective private ChildOf edges, including nested scene attachment. */
  readonly hierarchyParentByLocalId: ReadonlyMap<number, number>;
  readonly resolveAddress: (address: unknown, field?: string) => number | undefined;
}

export interface KeyedSceneCompileContext {
  readonly resolveSource: (
    source: string | AssetHandle<'scene'>,
    parent: AssetHandle<'scene'>,
  ) => Result<AssetHandle<'scene'>, unknown>;
  readonly resolveAsset: (handle: AssetHandle<'scene'>) => Result<SceneAsset, unknown>;
  readonly stack: ReadonlySet<number>;
  /** Compilations of the identical fixed closure, scoped to one materialization. */
  readonly fixedPlans?: Map<AssetHandle<'scene'>, CompiledSceneResult>;
}

function fail(reason: string, detail: Record<string, unknown> = {}): Result<never, unknown> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a keyed SceneAsset with schema-valid fields and entity/instance addresses',
    hint: 'repair the SceneAsset source and recook the asset',
    detail: { reason, ...detail },
  });
}

function keyList(entities: Readonly<Record<string, SceneEntity>>): string[] {
  return Object.keys(entities).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function addressParts(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string' && value.length > 0) return [value];
  // ScriptablePack 0.1.27 serialized ChildOf/Children addresses as numeric
  // local IDs. Accept that legacy wire form only at this compiler boundary;
  // the authoring contract remains string keyed.
  if (Number.isSafeInteger(value)) return [String(value)];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((part) => typeof part === 'string' && part.length > 0)) return undefined;
  return value as readonly string[];
}

/** Author values must survive storage conversion without coercion or wrap. */
function validPrimitive(type: string, value: unknown): boolean {
  if (typeof value !== primitiveJsType(type)) return false;
  if (typeof value !== 'number') return true;
  if (!Number.isFinite(value)) return false;
  if (type === 'f32') return Number.isFinite(Math.fround(value));
  if (type === 'f64') return true;
  const signed = type.startsWith('i');
  const bits = type.startsWith('enum') ? 32 : Number(type.slice(1));
  const bound = 2 ** (bits - (signed ? 1 : 0));
  return Number.isInteger(value) && value >= (signed ? -bound : 0) && value < bound;
}

export function fieldRemap(
  world: World,
  componentName: string,
  fields: Record<string, unknown>,
  resolveAddress: (address: unknown, field: string) => number | undefined,
  entityKey?: string,
): Result<Record<string, unknown>, unknown> {
  const steps = fieldRemapSteps(world, componentName, fields, resolveAddress, entityKey, false);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

interface FieldInput {
  readonly component: string;
  readonly field: string;
  readonly type: string;
  readonly entity: string | undefined;
}

function invalidField(reason: string, input: FieldInput): Result<never, unknown> {
  return fail(reason, {
    component: input.component,
    field: input.field,
    type: input.type,
    ...(input.entity === undefined ? {} : { entity: input.entity }),
  });
}

function fieldArray(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value) && 'length' in value)
    return Array.from(value as unknown as ArrayLike<unknown>);
  return undefined;
}

function nonEntityField(
  input: FieldInput,
  value: unknown,
  array: ReturnType<typeof componentDefinition>['fields'][string]['arrayMeta'],
): Result<unknown, unknown> {
  const primitive = array?.elementType === 'bool' ? 'u8' : (array?.elementType ?? input.type);
  if (!isPrimitiveScalarFieldType(primitive)) return ok(value);
  const values = array ? fieldArray(value) : [value];
  if (values === undefined || values.some((item) => !validPrimitive(primitive, item)))
    return invalidField('authored component value violates its declared schema', input);
  // Typed author arrays project numeric values rather than reinterpreting bytes.
  return ok(array ? values : value);
}

function entityAddressSlot(
  input: FieldInput,
  value: unknown,
  resolveAddress: (address: unknown, field: string) => number | undefined,
): Result<number, unknown> {
  const parts = addressParts(value);
  const detail = { component: input.component, field: input.field };
  if (parts === undefined) return fail('invalid entity address', { ...detail, address: value });
  const slot = resolveAddress(parts, `${input.component}.${input.field}`);
  return slot === undefined
    ? fail('missing entity address target', { ...detail, address: parts })
    : ok(slot);
}

function entityField(
  input: FieldInput,
  value: unknown,
  kind: NonNullable<ReturnType<typeof classifyEntityField>>,
  resolveAddress: (address: unknown, field: string) => number | undefined,
): Result<unknown, unknown> {
  const remap = (address: number): number =>
    resolveAddress(address, `${input.component}.${input.field}`) ?? address;
  if (!kind.isArray) {
    if (value === null) return ok(null);
    const slot = entityAddressSlot(input, value, resolveAddress);
    return slot.ok ? ok(remapEntityFieldValue(slot.value, kind, remap)) : slot;
  }
  if (!Array.isArray(value))
    return fail('array entity field is not an array', {
      component: input.component,
      field: input.field,
    });
  const numeric: number[] = [];
  for (const item of value) {
    const slot = entityAddressSlot(input, item, resolveAddress);
    if (!slot.ok) return slot;
    numeric.push(slot.value);
  }
  return ok(remapEntityFieldValue(numeric, kind, remap));
}

function* fieldRemapSteps(
  world: World,
  componentName: string,
  fields: Record<string, unknown>,
  resolveAddress: (address: unknown, field: string) => number | undefined,
  entityKey: string | undefined,
  incremental: boolean,
): Generator<void, Result<Record<string, unknown>, unknown>, void> {
  const token = world.components.resolve(componentName);
  if (token === undefined) return fail('unknown component', { component: componentName });
  const schema = componentSchema(token) as Record<string, string>;
  const definition = componentDefinition(token);
  const out: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(
    migrateLegacySceneComponentFields(componentName, fields),
  )) {
    if (incremental) yield;
    const fieldType = schema[fieldName];
    if (fieldType === undefined) {
      return fail('unknown component field', {
        component: componentName,
        field: fieldName,
        ...(entityKey === undefined ? {} : { entity: entityKey }),
      });
    }
    const input: FieldInput = {
      component: componentName,
      field: fieldName,
      type: fieldType,
      entity: entityKey,
    };
    const array = definition.fields[fieldName]?.arrayMeta;
    if (array !== undefined) {
      const values = fieldArray(value);
      if (values === undefined || (array.length !== undefined && values.length !== array.length))
        return invalidField('authored array violates its declared schema', input);
    }
    const kind = classifyEntityField(token as Component, fieldName);
    const result =
      kind === null
        ? nonEntityField(input, value, array)
        : entityField(input, value, kind, resolveAddress);
    if (!result.ok) return result;
    out[fieldName] = result.value;
  }
  return ok(out);
}

interface CompiledInstance {
  readonly node: SceneEntity;
  readonly compiled: CompiledSceneResult;
  mount: SceneInstanceMount;
}

function* compileInstances(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  context: KeyedSceneCompileContext,
  activeStack: ReadonlySet<number>,
  ownCount: number,
  instanceKeys: readonly string[],
  incremental: boolean,
): Generator<
  void,
  Result<
    { instances: Map<string, CompiledInstance>; mountKeyByLocalId: Map<number, string> },
    unknown
  >,
  void
> {
  const instances = new Map<string, CompiledInstance>();
  const mountKeyByLocalId = new Map<number, string>();
  let nextMemberFirst = ownCount + instanceKeys.length;
  for (const key of instanceKeys) {
    if (incremental) yield;
    const node = asset.entities[key] as SceneEntity;
    const declaration = node.instance;
    if (
      declaration === undefined ||
      (typeof declaration.source === 'string'
        ? declaration.source.length === 0
        : !Number.isSafeInteger(declaration.source) || declaration.source <= 0)
    ) {
      return fail('instance source must be a Scene reference or non-empty GUID', { entity: key });
    }
    const childHandle = context.resolveSource(declaration.source, handle);
    if (!childHandle.ok) return childHandle;
    const childRaw = Number(childHandle.value);
    if (activeStack.has(childRaw)) {
      return err({
        code: 'pack-cyclic-reference',
        expected: 'acyclic SceneAsset instance graph',
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
        detail: {
          code: 'pack-cyclic-reference',
          kind: 'mount-asset',
          cycle: [...activeStack, childRaw].map(String),
        },
      });
    }
    const childAsset = context.resolveAsset(childHandle.value);
    if (!childAsset.ok) return childAsset;
    const childContext: KeyedSceneCompileContext = {
      ...context,
      stack: activeStack,
    };
    const compiled = yield* compileKeyedSceneAssetSteps(
      world,
      childHandle.value,
      childAsset.value,
      childContext,
      incremental,
    );
    if (!compiled.ok) return compiled;
    const slot = ownCount + instances.size;
    const memberCount =
      compiled.value.asset.entities.length +
      (compiled.value.asset.mounts?.length ?? 0) +
      (compiled.value.asset.mounts ?? []).reduce((sum, mount) => sum + mount.memberCount, 0);
    instances.set(key, {
      node,
      compiled: compiled.value,
      mount: {
        localId: slot as LocalEntityId,
        source: Number(childHandle.value),
        memberFirst: nextMemberFirst as LocalEntityId,
        memberCount,
      },
    });
    mountKeyByLocalId.set(slot, key);
    nextMemberFirst += memberCount;
  }

  return ok({ instances, mountKeyByLocalId });
}

function* convertComponents(
  world: World,
  asset: SceneAsset,
  key: string,
  resolveAddress: (address: unknown) => number | undefined,
  incremental: boolean,
): Generator<void, Result<Record<string, Record<string, unknown>>, unknown>, void> {
  const node = asset.entities[key] as SceneEntity;
  const components: Record<string, Record<string, unknown>> = {};
  for (const [componentName, raw] of Object.entries(node.components)) {
    if (incremental) yield;
    const fields = yield* fieldRemapSteps(
      world,
      componentName,
      { ...(raw as Record<string, unknown>) },
      resolveAddress,
      key,
      incremental,
    );
    if (!fields.ok) return fields;
    components[componentName] = fields.value;
  }
  return ok(components);
}

function* compileOverrides(
  world: World,
  instances: Map<string, CompiledInstance>,
  resolveAddress: (address: unknown) => number | undefined,
  incremental: boolean,
): Generator<void, Result<void, unknown>, void> {
  // Convert ordered child-relative overrides into the private field patch
  // representation. Values resolve in the declaring parent namespace.
  // A component declaration that is absent on the target is represented as one
  // component-add override; an existing component stays field-granular so an
  // override cannot erase fields that were not mentioned by the author.
  const childHasComponent = (
    result: CompiledSceneResult,
    target: number,
    componentName: string,
  ): boolean => {
    const own = result.asset.entities.find((entity) => Number(entity.localId) === target);
    if (own !== undefined && own.components[componentName] !== undefined) return true;
    const mount = result.asset.mounts?.find((entry) => Number(entry.localId) === target);
    return mount?.components?.[componentName] !== undefined;
  };
  for (const [key, instance] of instances) {
    const declaration = instance.node.instance as NonNullable<SceneEntity['instance']>;
    const { mount, compiled } = instance;
    const childSlot = (target: SceneEntityAddress): number | undefined =>
      compiled.resolveAddress(target);
    const overrides: MountOverride[] = [];
    for (const override of declaration.overrides ?? []) {
      if (incremental) yield;
      const target = childSlot(override.target);
      if (target === undefined)
        return fail('instance override target does not exist', {
          entity: key,
          target: override.target,
        });
      for (const [componentName, fields] of Object.entries(override.components)) {
        const convertedFields = yield* fieldRemapSteps(
          world,
          componentName,
          { ...(fields as Record<string, unknown>) },
          resolveAddress,
          `${key}.instance.${override.target.join('.')}`,
          incremental,
        );
        if (!convertedFields.ok) return convertedFields;
        if (!childHasComponent(compiled, target, componentName)) {
          overrides.push({
            localId: ((mount.memberFirst as number) + target) as LocalEntityId,
            comp: componentName,
            value: convertedFields.value,
          });
        } else {
          overrides.push(
            ...Object.entries(convertedFields.value).map(([field, value]) => ({
              localId: ((mount.memberFirst as number) + target) as LocalEntityId,
              comp: componentName,
              field,
              value,
            })),
          );
        }
      }
    }
    if (overrides.length > 0) instance.mount = { ...mount, overrides };
  }

  return ok(undefined);
}

function overrideParent(override: MountOverride): number | undefined {
  if (override.comp !== 'ChildOf') return undefined;
  if (override.field === 'parent' && typeof override.value === 'number') return override.value;
  if (override.field !== undefined || typeof override.value !== 'object' || override.value === null)
    return undefined;
  const parent = (override.value as Record<string, unknown>).parent;
  return typeof parent === 'number' ? parent : undefined;
}

function* compileHierarchy(
  converted: readonly CompiledSceneEntity[],
  instances: ReadonlyMap<string, CompiledInstance>,
  incremental: boolean,
): Generator<void, Map<number, number>, void> {
  // Validate the authored hierarchy using the same keyed address resolver that
  // will be used for component fields. General component reference cycles are
  // legal; only ChildOf cycles are rejected before any spawn.
  const hierarchyParentByLocalId = new Map<number, number>();
  for (const node of converted) {
    if (incremental) yield;
    const parent = node.components.ChildOf?.parent;
    if (typeof parent === 'number' && parent >= 0) {
      hierarchyParentByLocalId.set(Number(node.localId), parent);
    }
  }
  for (const { mount, compiled } of instances.values()) {
    if (mount.parent !== undefined) {
      hierarchyParentByLocalId.set(Number(mount.localId), mount.parent);
    }
    for (const [childLocalId, childParent] of compiled.hierarchyParentByLocalId) {
      if (incremental) yield;
      hierarchyParentByLocalId.set(
        Number(mount.memberFirst) + childLocalId,
        Number(mount.memberFirst) + childParent,
      );
    }
    for (const childRoot of compiled.rootLocalIds) {
      if (incremental) yield;
      hierarchyParentByLocalId.set(Number(mount.memberFirst) + childRoot, Number(mount.localId));
    }
    for (const override of mount.overrides ?? []) {
      if (incremental) yield;
      const parent = overrideParent(override);
      if (parent !== undefined) hierarchyParentByLocalId.set(Number(override.localId), parent);
    }
  }
  return hierarchyParentByLocalId;
}

function* validateHierarchy(
  hierarchyParentByLocalId: ReadonlyMap<number, number>,
  keyByLocalId: ReadonlyMap<number, string>,
  incremental: boolean,
): Generator<void, Result<void, unknown>, void> {
  const settled = new Set<number>();
  for (const start of hierarchyParentByLocalId.keys()) {
    if (settled.has(start)) continue;
    const seen = new Set<number>();
    let current: number | undefined = start;
    while (
      current !== undefined &&
      hierarchyParentByLocalId.has(current) &&
      !settled.has(current)
    ) {
      if (incremental) yield;
      if (seen.has(current))
        return fail('hierarchy cycle', { entity: keyByLocalId.get(start), address: [...seen] });
      seen.add(current);
      current = hierarchyParentByLocalId.get(current);
    }
    for (const member of seen) {
      if (incremental) yield;
      settled.add(member);
    }
  }

  return ok(undefined);
}

/**
 * Compile keyed author data to the private numeric Scene representation. The
 * compiler establishes every local and nested address before the caller starts
 * spawning entities, so malformed references and recursive instances cannot
 * leave a partially usable World projection.
 */
export function compileKeyedSceneAsset(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  context: KeyedSceneCompileContext,
): Result<CompiledSceneResult, unknown> {
  const steps = compileKeyedSceneAssetSteps(world, handle, asset, context, false);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/**
 * The same compiler with explicit continuation boundaries. The caller retains
 * fixed input and component definitions across steps; no World member is spawned.
 * Key sorting and individual authored fields remain bounded-input work items.
 */
export function* compileKeyedSceneAssetSteps(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  context: KeyedSceneCompileContext,
  incremental = true,
): Generator<void, Result<CompiledSceneResult, unknown>, void> {
  const prepared = context.fixedPlans?.get(handle);
  if (prepared !== undefined) return ok(prepared);
  const compiled = yield* buildKeyedScenePlan(world, handle, asset, context, incremental);
  if (compiled.ok) context.fixedPlans?.set(handle, compiled.value);
  return compiled;
}

/** Resolve local addresses and validate hierarchy before publishing the plan. */
function* buildKeyedScenePlan(
  world: World,
  handle: AssetHandle<'scene'>,
  asset: SceneAsset,
  context: KeyedSceneCompileContext,
  incremental: boolean,
): Generator<void, Result<CompiledSceneResult, unknown>, void> {
  if (incremental) yield;
  asset = normalizeLegacySceneAsset(asset);
  if (
    asset.kind !== 'scene' ||
    asset.entities === null ||
    typeof asset.entities !== 'object' ||
    Array.isArray(asset.entities)
  ) {
    return fail('entities must be a keyed object');
  }
  const currentRaw = Number(handle);
  const activeStack = context.stack.has(currentRaw)
    ? context.stack
    : new Set([...context.stack, currentRaw]);
  const keys = keyList(asset.entities);
  if (keys.some((key) => key.length === 0)) return fail('entity keys must be non-empty');

  const ownKeys = keys.filter((key) => asset.entities[key]?.instance === undefined);
  const instanceKeys = keys.filter((key) => asset.entities[key]?.instance !== undefined);
  const slotByKey = new Map<string, number>();
  const keyByLocalId = new Map<number, string>();
  for (const [slot, key] of [...ownKeys, ...instanceKeys].entries()) {
    if (incremental) yield;
    slotByKey.set(key, slot);
    keyByLocalId.set(slot, key);
  }

  const nested = yield* compileInstances(
    world,
    handle,
    asset,
    context,
    activeStack,
    ownKeys.length,
    instanceKeys,
    incremental,
  );
  if (!nested.ok) return nested;
  const { instances, mountKeyByLocalId } = nested.value;

  const resolveAddress = (value: unknown): number | undefined => {
    const parts = addressParts(value);
    if (parts === undefined) return undefined;
    const first = parts[0];
    if (first === undefined) return undefined;
    const own = slotByKey.get(first);
    if (own !== undefined && parts.length === 1) return own;
    const instance = instances.get(first);
    if (instance === undefined) return undefined;
    const childSlot = instance.compiled.resolveAddress(parts.slice(1));
    return childSlot === undefined ? undefined : Number(instance.mount.memberFirst) + childSlot;
  };

  // Schema conversion completes before spawn; instance ChildOf is deferred until
  // its mount slot is live, while other components stay on that mount.
  for (const [key, instance] of instances) {
    const converted = yield* convertComponents(world, asset, key, resolveAddress, incremental);
    if (!converted.ok) return converted;
    const components = converted.value;
    const childOf = components.ChildOf?.parent;
    if (typeof childOf === 'number') {
      const { ChildOf: _ignored, ...mountComponents } = components;
      instance.mount = {
        ...instance.mount,
        components: mountComponents,
        parent: childOf as LocalEntityId,
      };
    } else {
      instance.mount = { ...instance.mount, components };
    }
  }

  const converted: CompiledSceneEntity[] = [];
  for (const key of ownKeys) {
    const components = yield* convertComponents(world, asset, key, resolveAddress, incremental);
    if (!components.ok) return components;
    converted.push({ localId: slotByKey.get(key) as LocalEntityId, components: components.value });
  }

  const overrides = yield* compileOverrides(world, instances, resolveAddress, incremental);
  if (!overrides.ok) return overrides;

  const mounts = [...instances.values()].map((instance) => instance.mount);

  const rootLocalIds: number[] = [
    ...convertedRootLocalIds(converted),
    ...mounts.filter((mount) => mount.parent === undefined).map((mount) => Number(mount.localId)),
  ];

  const hierarchyParentByLocalId = yield* compileHierarchy(converted, instances, incremental);
  const valid = yield* validateHierarchy(hierarchyParentByLocalId, keyByLocalId, incremental);
  if (!valid.ok) return valid;

  return ok({
    asset: {
      kind: 'scene',
      entities: converted,
      ...(mounts.length > 0 ? { mounts } : {}),
      ...(asset.skinGuids === undefined ? {} : { skinGuids: asset.skinGuids }),
    },
    keyByLocalId,
    mountKeyByLocalId,
    rootLocalIds,
    hierarchyParentByLocalId,
    resolveAddress,
  });
}

function convertedRootLocalIds(nodes: readonly CompiledSceneEntity[]): number[] {
  return nodes
    .filter((node) => node.components.ChildOf === undefined)
    .map((node) => Number(node.localId));
}
