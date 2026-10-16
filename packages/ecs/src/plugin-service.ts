import { Context, type Plugin } from '@forgeax/engine-plugin';

import type { World } from './world';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    world: World;
  }
}

export function worldPlugin(world: World): Plugin {
  return {
    name: 'world',
    provide: 'world',
    apply(ctx) {
      ctx.provide('world', world);
    },
  };
}

/** Create one Cordis realm whose root service is the ECS World. */
export async function createWorldContext(
  world: World,
  plugins: readonly Plugin[] = [],
): Promise<Context> {
  const ctx = new Context();
  try {
    await ctx.plugin(worldPlugin(world));
    for (const plugin of plugins) await ctx.plugin(plugin);
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
