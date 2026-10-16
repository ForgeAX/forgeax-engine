import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { MeshRenderer } from '@forgeax/engine/render';
import type { TextureAsset } from '@forgeax/engine/types';
import type { FeatureCheck } from '../../../lab/feature';
import { MESH, spawnMesh, type spawnStage, standard } from '../../../lab/stage';
import { errorCode } from './memory-pack';

type World = Parameters<typeof spawnStage>[0];

export async function loadTexture(
  assets: AssetRegistry,
  guid: string,
  checks: FeatureCheck[],
): Promise<TextureAsset | undefined> {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) {
    checks.push({ name: 'fixture GUID parses', ok: false, detail: guid });
    return undefined;
  }
  const loaded = await assets.loadByGuid<TextureAsset>(parsed.value);
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
  texture: TextureAsset | undefined,
): (on: boolean) => void {
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
          baseColorTexture: world.allocSharedRef('TextureAsset', texture) as never,
          roughness: 1,
          metallic: 0,
          renderState: { cullMode: 'none' },
        });
  const entity = spawnMesh(world, MESH.quad, textured, {
    pos: [0, 1.2, 0],
    scale: [2.4, 2.4, 2.4],
  });
  return (on) => {
    world.set(entity, MeshRenderer, { materials: [on ? textured : white] } as never);
  };
}
