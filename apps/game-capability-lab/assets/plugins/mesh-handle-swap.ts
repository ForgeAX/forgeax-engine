import type { AssetHandle } from '@forgeax/engine-types';
import { type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_SPHERE = createPrimitiveMesh('sphere').unwrap();


export interface MeshHandleSwap {
  readonly entity: EntityHandle;
  readonly original: AssetHandle<'mesh'>;
  readonly originalMaterials: readonly AssetHandle<'material'>[];
  readonly alternate: AssetHandle<'mesh'>;
  active: 'original' | 'alternate';
  swaps: number;
}

export function createMeshHandleSwap(world: World, assets: AssetRegistry, entity: EntityHandle | undefined): MeshHandleSwap | undefined {
  if (entity === undefined) return undefined;
  const mesh = world.get(entity, MeshFilter);
  const renderer = world.get(entity, MeshRenderer);
  if (!mesh.ok || !renderer.ok || renderer.value.materials.length === 0) return undefined;
  return {
    entity,
    original: mesh.value.assetHandle,
    originalMaterials: [...renderer.value.materials],
    alternate: assets.create(BUILTIN_SPHERE).unwrap(),
    active: 'original',
    swaps: 0,
  };
}

export function toggleMeshHandleSwap(world: World, state: MeshHandleSwap): void {
  state.active = state.active === 'original' ? 'alternate' : 'original';
  state.swaps += 1;
  world.set(state.entity, MeshFilter, {
    assetHandle: state.active === 'original' ? state.original : state.alternate,
  });
  world.set(state.entity, MeshRenderer, {
    materials: state.active === 'alternate' ? [state.originalMaterials[0]!] : [...state.originalMaterials],
  });
}

export function resetMeshHandleSwap(world: World, state: MeshHandleSwap | undefined): void {
  if (state === undefined || state.active === 'original') return;
  state.active = 'original';
  world.set(state.entity, MeshFilter, { assetHandle: state.original });
  world.set(state.entity, MeshRenderer, { materials: [...state.originalMaterials] });
}
