import { FixedUpdate, Time, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { quat } from '@forgeax/engine-runtime';
import { inState } from '@forgeax/engine-state';
import { orbitPose, ORBIT_INITIAL_PITCH, ORBIT_INITIAL_YAW, ORBIT_RADIUS } from '../camera-orbit';
import type { VideoTexturePanel } from '../video-texture-panel';
import type { WorldScoreTextHandle } from '../world-score-text';
import { CameraRig, GameplayInput, PlayerMotion } from '../components/gameplay';
import { GameState } from '../gameplay-state';
import { GAME_DEFAULT_GAMEPLAY_CONFIG, type GameplayConfig } from '../resources/gameplay';

export type CameraFollowSystemContext = {
  readonly world: World;
  readonly player: EntityHandle;
  readonly camera: EntityHandle;
  readonly getMode: () => 'topdown' | 'orbit' | 'fps' | 'pan';
  readonly applyPanCamera: () => void;
  readonly worldScoreText: WorldScoreTextHandle | undefined;
  readonly videoTexturePanel: VideoTexturePanel | undefined;
};

/** Writes the one camera Transform from player/camera ECS state each frame. */
export function installCameraFollowSystem(ctx: CameraFollowSystemContext): void {
  ctx.world.addSystem(Update, {
    name: 'game-camera-follow',
    runIf: inState(GameState, 'Play'),
    after: [FixedUpdate],
    queries: [],
    fn: () => {
      const dt = ctx.world.getResource(Time).delta;
      const config = ctx.world.getResource<GameplayConfig>(GAME_DEFAULT_GAMEPLAY_CONFIG);
      const playerTransform = ctx.world.get(ctx.player, Transform);
      const playerMotion = ctx.world.get(ctx.player, PlayerMotion);
      const input = ctx.world.get(ctx.player, GameplayInput);
      if (!playerTransform.ok || !playerMotion.ok || !input.ok) return;
      const px = playerTransform.value.pos[0] ?? 0;
      const pz = playerTransform.value.pos[2] ?? 0;
      const jumpY = playerMotion.value.jumpY;
      const freeY = playerMotion.value.freeY;
      const mode = ctx.getMode();
      if (mode === 'fps') {
        const qy = quat.create();
        const qx = quat.create();
        const cq = quat.create();
        quat.fromAxisAngle(qy, [0, 1, 0], input.value.lookYaw);
        quat.fromAxisAngle(qx, [1, 0, 0], input.value.lookPitch);
        quat.multiply(cq, qy, qx);
        ctx.world.set(ctx.camera, Transform, { pos: [px, freeY + config.camera.eyeHeight, pz], quat: [cq[0]!, cq[1]!, cq[2]!, cq[3]!] });
      } else if (mode === 'orbit') {
        const pose = orbitPose([px, jumpY + 0.8, pz], ORBIT_INITIAL_YAW + input.value.lookYaw, ORBIT_INITIAL_PITCH + input.value.lookPitch, ORBIT_RADIUS);
        ctx.world.set(ctx.camera, Transform, { pos: pose.pos, quat: pose.quat });
      } else if (mode === 'pan') {
        ctx.applyPanCamera();
      } else {
        const rig = ctx.world.get(ctx.camera, CameraRig);
        if (!rig.ok) return;
        const amount = 1 - Math.exp(-config.camera.follow * dt);
        const followX = rig.value.followX + (px - rig.value.followX) * amount;
        const followZ = rig.value.followZ + (pz + config.camera.topDownOffsetZ - rig.value.followZ) * amount;
        ctx.world.set(ctx.camera, CameraRig, { followX, followZ });
        ctx.world.set(ctx.camera, Transform, { pos: [followX, config.camera.topDownY, followZ], quat: config.camera.topQuaternion });
      }
      ctx.worldScoreText?.step(dt, ctx.camera);
      ctx.videoTexturePanel?.step(ctx.camera);
    },
  }).unwrap();
}
