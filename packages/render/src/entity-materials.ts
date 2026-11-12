import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import type { Asset, AssetGuid, AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { MeshFilter, MeshRenderer } from './components';
import { resolveMeshMaterialBindings } from './mesh-material-bindings';
import { worldRenderResources } from './publication/resource-scope';
import { resolveRuntimeAssetReference } from './render-system-extract';

/** The lookups `resolveMeshMaterialBindings` needs, bound to one World's asset owner. */
export function meshSlotBindingDeps(world: World): {
  readonly isValidOverride: (handle: number) => boolean;
  readonly resolveMeshDefault: (
    reference: AssetGuid | AssetHandle<'material'>,
  ) => number | undefined;
} {
  return {
    isValidOverride(handle) {
      const material = runtimeAssets(world.assets).resolveAsset(handle as AssetHandle<'material'>);
      return material.ok && material.value.kind === 'material';
    },
    resolveMeshDefault(reference) {
      return resolveRuntimeAssetReference(worldRenderResources(world), reference, 'material') as
        | number
        | undefined;
    },
  };
}

/**
 * The material handles the renderer draws an entity with, one per mesh material slot:
 * a valid `MeshRenderer.materials` override, else the mesh slot's default material,
 * else 0 (the engine default). Without a resolvable mesh the overrides are returned as
 * written. Read-only: binding diagnostics are left to the renderer.
 */
export function resolveEntityMaterialHandles(world: World, entity: EntityHandle): number[] {
  const overrides = Array.from(
    readRenderArrayView(world, entity, MeshRenderer, 'materials') ?? [],
    Number,
  );
  if (world.assets === undefined) return overrides;
  const meshHandle = Math.round(
    Number(world[worldRead].getFieldValue(entity, MeshFilter, 'assetHandle') ?? 0),
  );
  if (!(meshHandle > 0)) return overrides;
  const mesh = runtimeAssets(world.assets).resolveAsset<Asset>(meshHandle as AssetHandle<'mesh'>);
  if (!mesh.ok || mesh.value.kind !== 'mesh') return overrides;
  const resolved = resolveMeshMaterialBindings(
    mesh.value as MeshAsset,
    overrides,
    meshSlotBindingDeps(world),
  );
  return resolved.ok ? resolved.bindings.map((binding) => binding.handle) : overrides;
}
