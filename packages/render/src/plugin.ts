import type { World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { RENDER_COMPONENTS } from './render-components';

function registerRenderComponents(world: World): () => void {
  const leases = RENDER_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

/** Install the built-in render ECS vocabulary in one World. */
export function renderComponentsPlugin(): Plugin {
  return {
    name: 'render-components',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerRenderComponents(ctx.world), 'render/components');
    },
  };
}
