import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { FixedUpdate, Time, Update } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import type { Plugin } from '@forgeax/engine/plugin';
import { PROPAGATE_TRANSFORMS_SYSTEM, readPresentationWorldMatrix, Transform } from '@forgeax/engine/scene';
import type { Game3dPlayerService } from '../player/player.ts';
import { integratePointerLook, orbitPosition } from './third-person.ts';
import { resolveGameEntity } from '../shared/scene-refs.ts';

const CAMERA_DISTANCE = 6.5;
const CAMERA_TARGET_HEIGHT = 0.5;
const CAMERA_FOLLOW = 10;

export const camera: Plugin = {
  name: 'game-3d/camera',
  inject: ['world', 'gameHost', 'game3dPlayer', 'gameScene'],
  apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d/camera requires the App-owned GameHost');
    const playerService = ctx.game3dPlayer as Game3dPlayerService | undefined;
    if (playerService === undefined)
      throw new Error('game-3d/camera requires the game-3d/player service');
    const player = playerService.entity;
    const camera = resolveGameEntity(ctx.world, ctx.gameScene, 'camera');
    ctx.effect(function* () {
      host.setPointerLockAllowed?.(true);
      yield () => host.setPointerLockAllowed?.(false);
      ctx.world
        .addSystem(Update, {
          name: 'game-3d-camera',
          after: [FixedUpdate, 'game-3d-player-input'],
          before: [PROPAGATE_TRANSFORMS_SYSTEM],
          queries: [],
          fn: () => {
            const input = playerService.readInput();
            const dt = ctx.world.getResource(Time).delta;
            const playerMatrix = readPresentationWorldMatrix(ctx.world, player);
            if (playerMatrix === undefined) throw new Error('game-3d/camera requires the player presentation pose');
            const rig = playerService.readRig();
            const look = integratePointerLook(rig.yaw, rig.pitch, input.lookX, input.lookY);
            const follow = 1 - Math.exp(-CAMERA_FOLLOW * dt);
            const focus = [
              rig.focusX + ((playerMatrix[12] ?? 0) - rig.focusX) * follow,
              rig.focusY +
                ((playerMatrix[13] ?? 0) + CAMERA_TARGET_HEIGHT - rig.focusY) * follow,
              rig.focusZ + ((playerMatrix[14] ?? 0) - rig.focusZ) * follow,
            ] as const;
            const position = orbitPosition(focus, look.yaw, look.pitch, CAMERA_DISTANCE);
            const rotation = quat.fromLookAt(quat.create(), position, focus, [0, 1, 0]);
            ctx.world
              .set(camera, Transform, {
                pos: position,
                quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
              })
              .unwrap();
            playerService.updateRig({
              yaw: look.yaw,
              pitch: look.pitch,
              focusX: focus[0],
              focusY: focus[1],
              focusZ: focus[2],
            });
          },
        })
        .unwrap();
      yield () => ctx.world.removeSystem(Update, 'game-3d-camera').unwrap();
    }, 'game-3d/camera');
  },
};


export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('019fb7ce-3c00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/camera': {
      kind: 'plugin',
      module: { specifier: './camera.pack.ts', export: 'camera' },
    },
  }),
});
