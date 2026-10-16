import { defineSystem, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { pick, viewportToWorld } from '@forgeax/engine-picking';
import type { InputSnapshot } from '@forgeax/engine-input';
import { inState } from '@forgeax/engine-state';
import type { HudHandle, ViewMode } from './hud';
import { GameState } from './gameplay-state';
import { GameplayInput, PlayerBodyPart, PlayerMotion } from './components/gameplay';
import { resolveShotDirection } from './gameplay-aim';

export type GameplayInputContext = {
  world: World;
  player: EntityHandle;
  camera: EntityHandle;
  canvas: HTMLCanvasElement;
  hud: HudHandle;
  readInput: () => InputSnapshot;
  getMode: () => ViewMode;
  getPlayerPosition: () => { x: number; z: number };
};

const LOOK_SENS = 0.0022;

/** Install the input-to-intent systems shared by all three camera views. */
export function installGameplayInput(ctx: GameplayInputContext): void {
  const clampPitch = (pitch: number) => Math.max(-1.2, Math.min(1.2, pitch));

  const gameLook = defineSystem({
    name: 'game-look',
    runIf: inState(GameState, 'Play'),
    queries: [] as const,
    after: ['input-frame-start-scan'],
    fn: () => {
      const snap = ctx.readInput();
      const mode = ctx.getMode();
      if ((mode !== 'fps' && mode !== 'orbit') || !snap.mouse.pointerLocked) {
        if (mode === 'fps' || mode === 'orbit') {
          ctx.hud.setLockStatus(snap.mouse.pointerLocked
            ? '🎮 Locked · mouse look · ESC releases'
            : '👍 Click canvas to lock mouse');
        }
        return;
      }
      const input = ctx.world.get(ctx.player, GameplayInput);
      if (!input.ok) return;
      ctx.world.set(ctx.player, GameplayInput, {
        lookYaw: input.value.lookYaw - snap.mouse.movementDelta.x * LOOK_SENS,
        lookPitch: clampPitch(input.value.lookPitch - snap.mouse.movementDelta.y * LOOK_SENS),
      });
      ctx.hud.setLockStatus('🎮 Locked · mouse look · ESC releases');
    },
  });
  ctx.world.addSystem(Update, gameLook);

  const gamePickShoot = defineSystem({
    name: 'game-pick-shoot',
    runIf: inState(GameState, 'Play'),
    queries: [] as const,
    after: ['input-frame-start-scan'],
    fn: () => {
      const snap = ctx.readInput();
      for (const ev of snap.pointerEvents) {
        if (ev.phase !== 'down' || ev.pointerType !== 'mouse') continue;
        if (ctx.getMode() === 'fps' || (ctx.getMode() === 'orbit' && snap.mouse.pointerLocked)) {
          if (snap.mouse.pointerLocked) ctx.world.set(ctx.player, GameplayInput, { wantShoot: 1 });
          continue;
        }
        const player = ctx.getPlayerPosition();
        const hit = pick(ctx.world, ctx.camera, ev.x, ev.y, ctx.canvas.width, ctx.canvas.height);
        const ray = viewportToWorld(
          ctx.world,
          ctx.camera,
          ev.x,
          ev.y,
          ctx.canvas.width,
          ctx.canvas.height,
        );
        const hitIsPlayerBodyPart =
          hit !== undefined &&
          (hit.entity === ctx.player || ctx.world.get(hit.entity, PlayerBodyPart).ok);
        const direction = resolveShotDirection({
          player,
          playerEntity: ctx.player,
          hit,
          hitIsPlayerBodyPart,
          ray,
        });
        if (direction === undefined) continue;
        ctx.world.set(ctx.player, GameplayInput, {
          shotDirX: direction.x,
          shotDirZ: direction.z,
          shotDirValid: 1,
          wantShoot: 1,
        });
        ctx.world.set(ctx.player, PlayerMotion, { faceX: direction.x, faceZ: direction.z });
      }
    },
  });
  ctx.world.addSystem(Update, gamePickShoot);
}
