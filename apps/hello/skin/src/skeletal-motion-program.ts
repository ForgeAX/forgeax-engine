import { AnimationPlayer } from '@forgeax/engine/animation';
import {
  bindSkeletalMotion,
  type SkeletalMotionBinding,
  type SkeletalMotionDefinition,
} from '@forgeax/engine/animation/skeletal-motion';
import type { EntityHandle } from '@forgeax/engine/ecs';
import type { Plugin } from '@forgeax/engine/plugin';
import { Name } from '@forgeax/engine/scene';

declare module '@forgeax/engine/plugin' {
  interface EngineContextServices {
    skeletalMotionExample: { readonly binding: SkeletalMotionBinding; rebind(): void };
  }
}

/** The saved PluginAsset config installs and retires an ordinary player binding. */
const motionProgram: Plugin.Object<SkeletalMotionDefinition> = {
  name: 'skeletal-motion-example',
  provide: 'skeletalMotionExample',
  inject: ['world', 'physics'],
  apply(ctx, definition) {
    const world = ctx.world;
    let player: EntityHandle | undefined;
    for (const row of world.query({ read: [Name, AnimationPlayer] }).unwrap())
      if (row.get(Name).value === 'Actor') {
        player = row.entity;
        break;
      }
    if (player === undefined) throw new Error('authored Actor missing');
    let binding = bindSkeletalMotion(world, player, definition).unwrap();
    ctx.effect(() => () => binding.dispose());
    ctx.provide('skeletalMotionExample', {
      get binding() {
        return binding;
      },
      rebind() {
        binding.dispose();
        binding = bindSkeletalMotion(world, player, definition).unwrap();
      },
    });
  },
};
export default motionProgram;
