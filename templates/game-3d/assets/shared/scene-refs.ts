import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { sceneEntity, worldResolveSceneEntity } from '@forgeax/engine/scene';

export interface GameScene {
  readonly root: EntityHandle;
}
declare module '@forgeax/engine/plugin' {
  interface EngineContextServices {
    gameScene: GameScene;
  }
}
type GameEntityKey =
  | 'camera'
  | 'player'
  | 'point-light'
  | 'skylight'
  | 'sky-background'
  | 'sun'
  | `player/joint/${string}`;

const GAME_SCENE_SOURCE_KEY = 'scene/showcase' as const;

/** Resolve an instance-relative authored binding without consulting display names. */
export function resolveGameEntity(
  world: World,
  host: GameScene,
  entityKey: GameEntityKey,
): EntityHandle {
  if (host.root === undefined) {
    throw new Error(`game-3d default scene is unavailable for entity ${entityKey}`);
  }
  const resolved = worldResolveSceneEntity(
    world,
    host.root,
    sceneEntity(GAME_SCENE_SOURCE_KEY, entityKey),
  );
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}
