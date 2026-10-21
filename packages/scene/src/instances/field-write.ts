import type { Component, EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { err, type Result, type SceneEntityRef } from '@forgeax/engine-types';
import { sceneEntity } from './binding';
import { fieldRemap } from './keyed';
import { worldGetSceneInstanceState, worldResolveSceneEntity } from './scene-instances';

export interface SceneFieldWriteError {
  readonly code: 'scene-field-not-writable';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly component: string; readonly field: string };
}

/** A reverse lookup in one known instance. It never searches Worlds or other instances. */
export function worldSceneEntityAddressOf(
  world: World,
  root: EntityHandle,
  entity: EntityHandle,
): SceneEntityRef | undefined {
  if (!world.componentsOf(entity).ok) return undefined;
  const instance = worldGetSceneInstanceState(world, root);
  if (!instance.ok) return undefined;
  const address = instance.value.entityAddresses.get(entity);
  return address === undefined
    ? undefined
    : sceneEntity(instance.value.sceneSourceKey ?? '', address);
}

/** The same schema predicate serves declaration discovery and the actual write. */
export function sceneFieldWritable(component: Component | undefined, field: string): boolean {
  const type = component && componentSchema(component)[field];
  return (
    typeof type === 'string' &&
    /^(bool|string|[uif](8|16|32|64)|array<f(32|64),[234]>)$/.test(type.replace(/\s/g, ''))
  );
}

/** An explicit instance-local write, with the normal World validation and change evidence. */
export function worldWriteSceneField(
  world: World,
  root: EntityHandle,
  ref: SceneEntityRef,
  componentName: string,
  field: string,
  value: unknown,
): Result<void, SceneFieldWriteError | EcsError> {
  const entity = worldResolveSceneEntity(world, root, ref);
  if (!entity.ok) return entity;
  const component = world.components.resolve(componentName);
  if (!component || !sceneFieldWritable(component, field)) {
    return err({
      code: 'scene-field-not-writable',
      expected: 'a declared scalar, vector or quaternion field',
      hint: 'use the component owner for structural fields and references',
      detail: { component: componentName, field },
    });
  }
  const checked = fieldRemap(world, componentName, { [field]: value }, () => undefined);
  if (!checked.ok)
    return err({
      code: 'scene-field-not-writable',
      expected: 'a value matching the component schema',
      hint: 'repair the field type, range or vector length',
      detail: { component: componentName, field },
    });
  return world.set(entity.value, component, checked.value as never);
}
