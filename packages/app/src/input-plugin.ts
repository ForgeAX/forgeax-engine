import { Update } from '@forgeax/engine-ecs';
import {
  createInputSnapshot,
  GAMEPAD_FEEDBACK_KEY,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  InputFrameStartScan,
  InputSet,
} from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';

/** Project one Host-owned input provider into reversible World contributions. */
export function inputPlugin(): Plugin {
  return {
    name: 'input',
    inject: ['world', 'input'],
    apply(ctx) {
      const world = ctx.world;
      const input = ctx.input;
      if (input === undefined) throw new Error('Cordis activated input without its provider');
      ctx.effect(() => {
        world.insertResource(INPUT_BACKEND_KEY, input);
        if (input.feedback) world.insertResource(GAMEPAD_FEEDBACK_KEY, input.feedback);
        // Make the documented empty signal available during the pre-first-frame
        // window.  Inspection and gameplay plugins may be queried immediately
        // after activation; they should not race the first Update scan just to
        // read a value whose neutral form is already defined by InputSnapshot.
        world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, createInputSnapshot());
        return () => {
          world.removeResource(INPUT_BACKEND_KEY);
          world.removeResource(GAMEPAD_FEEDBACK_KEY);
          world.removeResource(INPUT_SNAPSHOT_RESOURCE_KEY);
        };
      }, 'input/resource');
      ctx.effect(() => {
        world.addSystems(Update, InputSet, [InputFrameStartScan]).unwrap();
        return () => world.removeSystem(Update, InputFrameStartScan.name);
      }, 'input/frame-start-scan');
    },
  };
}
