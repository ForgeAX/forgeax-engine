import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { MeshRenderer } from '@forgeax/engine/render';
import type { AssetHandle } from '@forgeax/engine/types';
import type { FeatureCheck } from '../../../lab/feature';
import { spawnMesh, type spawnStage, standard } from '../../../lab/stage';
import { errorCode } from './memory-pack';

type World = Parameters<typeof spawnStage>[0];

export async function loadTexture(
  assets: AssetRegistry,
  guid: string,
  checks: FeatureCheck[],
): Promise<AssetHandle<'texture'> | undefined> {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) {
    checks.push({ name: 'fixture GUID parses', ok: false, detail: guid });
    return undefined;
  }
  const loaded = await assets.load(parsed.value, 'texture');
  checks.push({
    name: 'loadByGuid texture ok',
    ok: loaded.ok,
    ...(loaded.ok ? {} : { detail: errorCode(loaded.error) }),
  });
  return loaded.ok ? loaded.value : undefined;
}

/** A textured quad for a world whose stage is already spawned; toggle(false) swaps to plain white. */
export function texturedQuad(
  world: World,
  texture: AssetHandle<'texture'> | undefined,
): (on: boolean) => void {
  const primitiveAssets = world.assets;
  if (!(primitiveAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  const stageQuad = primitiveAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');

  const white = standard(world, {
    baseColor: [1, 1, 1, 1],
    roughness: 1,
    metallic: 0,
    renderState: { cullMode: 'none' },
  });
  const textured =
    texture === undefined
      ? white
      : standard(world, {
          baseColor: [1, 1, 1, 1],
          baseColorTexture: texture,
          roughness: 1,
          metallic: 0,
          renderState: { cullMode: 'none' },
        });
  const entity = spawnMesh(world, stageQuad, textured, {
    pos: [0, 1.2, 0],
    scale: [2.4, 2.4, 2.4],
  });
  return (on) => {
    world.set(entity, MeshRenderer, { materials: [on ? textured : white] } as never);
  };
}
