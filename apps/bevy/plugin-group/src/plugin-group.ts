import { Time, Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

function printPlugin(name: 'hello' | 'world', message: string): Plugin {
  return {
    name: `print-${name}`,
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        ctx.world
          .addSystem(Update, {
            name: `print-${name}-system`,
            queries: [],
            fn: () => {
              console.log(message);
              void ctx.world.getResource(Time).delta;
            },
          })
          .unwrap();
        return () => ctx.world.removeSystem(Update, `print-${name}-system`);
      }, `print/${name}`);
    },
  };
}

/** Bevy's HelloWorldPlugins expressed as one native Cordis parent fiber. */
export const helloWorldPlugins: Plugin = {
  name: 'hello-world',
  inject: ['world'],
  async apply(ctx) {
    await ctx.plugin(printPlugin('hello', 'hello'));
    await ctx.plugin(printPlugin('world', 'world'));
  },
};
