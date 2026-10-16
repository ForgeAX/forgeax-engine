import type { Component, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { Skin } from './skin';

const SKINNING_COMPONENTS: readonly Component[] = [Skin];

function registerSkinningComponents(world: World): () => void {
  const leases = SKINNING_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

/** Install skeletal binding components in a World that consumes skinned scenes. */
export function skinningPlugin(): Plugin {
  return {
    name: 'skinning',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerSkinningComponents(ctx.world), 'skinning/components');
    },
  };
}
