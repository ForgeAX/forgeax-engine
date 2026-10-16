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
  err,
  type Handle,
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
    source: string,
    parent: Handle<'SceneAsset', 'shared'>,
  ) => Result<Handle<'SceneAsset', 'shared'>, unknown>;
  readonly resolveAsset: (handle: Handle<'SceneAsset', 'shared'>) => Result<SceneAsset, unknown>;
  readonly stack: ReadonlySet<number>;
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

function fieldRemap(
  world: World,
  componentName: string,
  fields: Record<string, unknown>,
  resolveAddress: (address: unknown, field: string) => number | undefined,
  entityKey?: string,
): Result<Record<string, unknown>, unknown> {
  const token = world.components.resolve(componentName);
  if (token === undefined) return fail('unknown component', { component: componentName });
  const schema = componentSchema(token) as Record<string, string>;
  const definition = componentDefinition(token);
  const out: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(
    migrateLegacySceneComponentFields(componentName, fields),
  )) {
    const fieldType = schema[fieldName];
    if (fieldType === undefined) {
      return fail('unknown component field', {
        component: componentName,
        field: fieldName,
        ...(entityKey === undefined ? {} : { entity: entityKey }),
      });
    }
    const kind = classifyEntityField(token as Component, fieldName);
    if (kind === null) {
      const array = definition.fields[fieldName]?.arrayMeta;
      const primitive = array?.elementType === 'bool' ? 'u8' : (array?.elementType ?? fieldType);
      if (isPrimitiveScalarFieldType(primitive)) {
        const values = array
          ? Array.isArray(value)
            ? value
            : ArrayBuffer.isView(value) && 'length' in value
              ? Array.from(value as unknown as ArrayLike<unknown>)
              : undefined
          : [value];
        if (
          values === undefined ||
          (array?.length !== undefined && values.length !== array.length) ||
          values.some((item) => !validPrimitive(primitive, item))
        )
          return fail('authored component value violates its declared schema', {
            component: componentName,
            field: fieldName,
            type: fieldType,
            ...(entityKey === undefined ? {} : { entity: entityKey }),
          });
        // Typed author arrays become numeric values before the ECS writer;
        // copying a differently sized view's raw bytes would reinterpret them.
        out[fieldName] = array ? values : value;
        continue;
      }
      out[fieldName] = value;
      continue;
    }
    const remap = (address: number): number =>
      resolveAddress(address, `${componentName}.${fieldName}`) ?? address;
    // The keyed authoring model uses string addresses for scalar entity fields
    // and an address per element for array<entity>. The ECS kernel still gets
    // numeric local slots, so conversion is complete before spawn.
    if (kind.isArray) {
      if (!Array.isArray(value))
        return fail('array entity field is not an array', {
          component: componentName,
          field: fieldName,
        });
      const numeric: number[] = [];
      for (const item of value) {
        const parts = addressParts(item);
        if (parts === undefined)
          return fail('invalid entity address', {
            component: componentName,
            field: fieldName,
            address: item,
          });
        const slot = resolveAddress(parts, `${componentName}.${fieldName}`);
        if (slot === undefined)
          return fail('missing entity address target', {
            component: componentName,
            field: fieldName,
            address: parts,
          });
        numeric.push(slot);
      }
      out[fieldName] = remapEntityFieldValue(numeric, kind, remap);
      continue;
    }
    if (value === null) {
      out[fieldName] = null;
      continue;
    }
    const parts = addressParts(value);
    if (parts === undefined)
      return fail('invalid entity address', {
        component: componentName,
        field: fieldName,
        address: value,
      });
    const slot = resolveAddress(parts, `${componentName}.${fieldName}`);
    if (slot === undefined)
      return fail('missing entity address target', {
        component: componentName,
        field: fieldName,
        address: parts,
      });
    out[fieldName] = remapEntityFieldValue(slot, kind, remap);
  }
  return ok(out);
}

/**
 * Compile keyed author data to the private numeric Scene representation. The
 * compiler establishes every local and nested address before the caller starts
 * spawning entities, so malformed references and recursive instances cannot
 * leave a partially usable World projection.
 */
export function compileKeyedSceneAsset(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  context: KeyedSceneCompileContext,
): Result<CompiledSceneResult, unknown> {
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
    slotByKey.set(key, slot);
    keyByLocalId.set(slot, key);
  }

  const instances = new Map<
    string,
    {
      readonly node: SceneEntity;
      readonly compiled: CompiledSceneResult;
      mount: SceneInstanceMount;
    }
  >();
  const mountKeyByLocalId = new Map<number, string>();
  let nextMemberFirst = ownKeys.length + instanceKeys.length;
  for (const key of instanceKeys) {
    const node = asset.entities[key] as SceneEntity;
    const declaration = node.instance;
    if (
      declaration === undefined ||
      typeof declaration.source !== 'string' ||
      declaration.source.length === 0
    ) {
      return fail('instance source must be a non-empty GUID', { entity: key });
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
    const compiled = compileKeyedSceneAsset(
      world,
      childHandle.value,
      childAsset.value,
      childContext,
    );
    if (!compiled.ok) return compiled;
    const slot = ownKeys.length + instances.size;
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

  const convertComponents = (
    key: string,
  ): Result<Record<string, Record<string, unknown>>, unknown> => {
    const node = asset.entities[key] as SceneEntity;
    const components: Record<string, Record<string, unknown>> = {};
    for (const [componentName, raw] of Object.entries(node.components)) {
      const fields = fieldRemap(
        world,
        componentName,
        { ...(raw as Record<string, unknown>) },
        resolveAddress,
        key,
      );
      if (!fields.ok) return fields;
      components[componentName] = fields.value;
    }
    return ok(components);
  };

  // Schema conversion completes before spawn; instance ChildOf is deferred until
  // its mount slot is live, while other components stay on that mount.
  for (const [key, instance] of instances) {
    const converted = convertComponents(key);
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
    const components = convertComponents(key);
    if (!components.ok) return components;
    converted.push({ localId: slotByKey.get(key) as LocalEntityId, components: components.value });
  }

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
      const target = childSlot(override.target);
      if (target === undefined)
        return fail('instance override target does not exist', {
          entity: key,
          target: override.target,
        });
      for (const [componentName, fields] of Object.entries(override.components)) {
        const convertedFields = fieldRemap(
          world,
          componentName,
          { ...(fields as Record<string, unknown>) },
          resolveAddress,
          `${key}.instance.${override.target.join('.')}`,
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

  const mounts = [...instances.values()].map((instance) => instance.mount);

  const rootLocalIds: number[] = [
    ...convertedRootLocalIds(converted),
    ...mounts.filter((mount) => mount.parent === undefined).map((mount) => Number(mount.localId)),
  ];

  // Validate the authored hierarchy using the same keyed address resolver that
  // will be used for component fields. General component reference cycles are
  // legal; only ChildOf cycles are rejected before any spawn.
  const hierarchyParentByLocalId = new Map<number, number>();
  for (const node of converted) {
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
      hierarchyParentByLocalId.set(
        Number(mount.memberFirst) + childLocalId,
        Number(mount.memberFirst) + childParent,
      );
    }
    for (const childRoot of compiled.rootLocalIds) {
      hierarchyParentByLocalId.set(Number(mount.memberFirst) + childRoot, Number(mount.localId));
    }
    for (const override of mount.overrides ?? []) {
      if (override.comp !== 'ChildOf') continue;
      if (override.field === 'parent' && typeof override.value === 'number') {
        hierarchyParentByLocalId.set(Number(override.localId), override.value);
      } else if (
        override.field === undefined &&
        typeof override.value === 'object' &&
        override.value !== null
      ) {
        const parentValue = (override.value as Record<string, unknown>).parent;
        if (typeof parentValue === 'number') {
          hierarchyParentByLocalId.set(Number(override.localId), parentValue);
        }
      }
    }
  }
  for (const start of hierarchyParentByLocalId.keys()) {
    const seen = new Set<number>();
    let current: number | undefined = start;
    while (current !== undefined && hierarchyParentByLocalId.has(current)) {
      if (seen.has(current))
        return fail('hierarchy cycle', { entity: keyByLocalId.get(start), address: [...seen] });
      seen.add(current);
      current = hierarchyParentByLocalId.get(current);
    }
  }

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
