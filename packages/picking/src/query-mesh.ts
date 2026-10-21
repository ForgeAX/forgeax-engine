import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import {
  glyphTextGeometry,
  MeshFilter,
  MeshRenderer,
  tilemapGeometry,
} from '@forgeax/engine-render';
import { GlyphText, Tilemap } from '@forgeax/engine-render/authoring';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { readWorldMatrix, type ScreenRay } from './pick-core';

export function* meshQueryEntities(world: World): Generator<EntityHandle> {
  for (const row of world
    .query({ read: [Transform, GlobalTransform, MeshFilter, MeshRenderer] })
    .unwrap())
    if (!world.hasComponent(row.entity, GlyphText) && !world.hasComponent(row.entity, Tilemap))
      yield row.entity;
  for (const row of world.query({ read: [Transform, GlobalTransform, GlyphText] }).unwrap())
    yield row.entity;
  for (const row of world.query({ read: [Transform, GlobalTransform, Tilemap] }).unwrap())
    yield row.entity;
}

export function queryMesh(
  world: World,
  entity: EntityHandle,
):
  | {
      readonly mesh: MeshAsset;
      readonly assetHandle?: AssetHandle<'mesh'>;
    }
  | undefined {
  if (world.hasComponent(entity, Tilemap)) {
    const mesh = tilemapGeometry(world, entity);
    return mesh === undefined ? undefined : { mesh };
  }
  if (world.hasComponent(entity, GlyphText)) {
    const mesh = glyphTextGeometry(world, entity);
    return mesh === undefined ? undefined : { mesh };
  }
  const binding = world.get(entity, MeshFilter);
  if (!binding.ok || binding.value.assetHandle === 0) return undefined;
  const resolved = runtimeAssets(world.assets).resolveAsset<MeshAsset>(binding.value.assetHandle);
  return resolved.ok ? { mesh: resolved.value, assetHandle: binding.value.assetHandle } : undefined;
}

/** Same look-at billboard basis as msdf-text.wgsl; label rotation/scale do not deform glyphs. */
export function queryMeshMatrix(world: World, entity: EntityHandle, screen: ScreenRay) {
  const matrix = readWorldMatrix(world, entity);
  if (matrix === undefined || !world.hasComponent(entity, GlyphText)) return matrix;
  const camera = mat4.invert(mat4.create(), screen.view);
  const forward = vec3.normalize(
    vec3.create(),
    vec3.create(
      (camera[12] ?? 0) - (matrix[12] ?? 0),
      (camera[13] ?? 0) - (matrix[13] ?? 0),
      (camera[14] ?? 0) - (matrix[14] ?? 0),
    ),
  );
  const reference = Math.abs(forward[1] ?? 0) > 0.999 ? vec3.create(0, 0, 1) : vec3.create(0, 1, 0);
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), reference, forward));
  const up = vec3.cross(vec3.create(), forward, right);
  const result = mat4.identity(mat4.create());
  result.set(right, 0);
  result.set(up, 4);
  result.set(forward, 8);
  result[12] = matrix[12] ?? 0;
  result[13] = matrix[13] ?? 0;
  result[14] = matrix[14] ?? 0;
  return result;
}
