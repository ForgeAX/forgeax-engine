import type { EntityHandle } from '@forgeax/engine-ecs';
import type { SceneEntityAddress, SceneEntityRef } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export type { SceneEntityRef } from '@forgeax/engine-types';

export type SceneBindingError = {
  readonly code: 'scene-binding-missing' | 'scene-binding-wrong-instance';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly sceneSourceKey: string; readonly address: SceneEntityAddress };
};

export type SceneBindingDeclarationError = {
  readonly code: 'scene-binding-duplicate' | 'scene-binding-source-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly sceneSourceKey?: string; readonly address?: SceneEntityAddress };
};

export function validateSceneEntityKeys(
  sceneSourceKey: string,
  entityKeys: readonly string[],
): Result<readonly string[], SceneBindingDeclarationError> {
  if (sceneSourceKey.length === 0) {
    return err({
      code: 'scene-binding-source-missing',
      expected: 'a non-empty scene sourceKey',
      hint: 'declare the scene sourceKey in the author inventory',
      detail: {},
    });
  }
  const seen = new Set<string>();
  for (const entityKey of entityKeys) {
    if (entityKey.length === 0 || seen.has(entityKey)) {
      return err({
        code: 'scene-binding-duplicate',
        expected: 'unique non-empty entity keys within one scene',
        hint: 'rename the duplicate entity key in the scene producer',
        detail: { sceneSourceKey, address: entityKey },
      });
    }
    seen.add(entityKey);
  }
  return ok([...entityKeys]);
}

export function sceneEntity(sceneSourceKey: string, address: SceneEntityAddress): SceneEntityRef {
  return { sceneSourceKey, address };
}

/** Stable map key shared by direct and nested SceneEntityRef addresses. */
export function sceneEntityAddressKey(address: SceneEntityAddress): string {
  if (typeof address === 'string') return `s:${JSON.stringify(address)}`;
  if (address.length === 1) return `s:${JSON.stringify(address[0] ?? '')}`;
  return `a:${JSON.stringify(address)}`;
}

/** Inverse of {@link sceneEntityAddressKey}. */
export function sceneEntityAddressFromKey(key: string): SceneEntityAddress {
  const value: unknown = JSON.parse(key.slice(2));
  return value as SceneEntityAddress;
}

export function resolveSceneEntity(
  ref: SceneEntityRef,
  instance: {
    readonly sceneSourceKey: string;
    readonly bindings: ReadonlyMap<string, EntityHandle | number>;
  },
): Result<EntityHandle | number, SceneBindingError> {
  if (ref.sceneSourceKey !== instance.sceneSourceKey) {
    return err({
      code: 'scene-binding-wrong-instance',
      expected: `scene instance ${ref.sceneSourceKey}`,
      hint: 'resolve the SceneEntityRef against its owning SceneInstance',
      detail: { sceneSourceKey: ref.sceneSourceKey, address: ref.address },
    });
  }
  const value = instance.bindings.get(sceneEntityAddressKey(ref.address));
  if (value === undefined) {
    return err({
      code: 'scene-binding-missing',
      expected: 'entity key declared by the scene producer',
      hint: 'declare the entity key in the scene producer before consuming it',
      detail: { sceneSourceKey: ref.sceneSourceKey, address: ref.address },
    });
  }
  return ok(value);
}
