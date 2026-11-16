import { GameLookOrder, GamePickShootOrder } from "../../src/system-order";
import { InputFrameStartScan } from "@forgeax/engine-input";
import { defineSystem, Update, type World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';

export type GameplayLifecycleContext = {
  world: World;
  readInput: () => InputSnapshot;
  requestReset: () => void;
};

/** Turn the reset action edge into one deterministic gameplay reset request. */
export function installGameplayLifecycle(ctx: GameplayLifecycleContext): void {
  ctx.world.addSystem(Update, defineSystem({
    name: 'game-reset',
    queries: [] as const,
    after: [InputFrameStartScan, GameLookOrder, GamePickShootOrder],
    fn: () => {
      if (ctx.readInput().action('reset').justPressed()) ctx.requestReset();
    },
  }));
}
