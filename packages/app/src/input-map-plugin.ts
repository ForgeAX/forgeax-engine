import { type ActionConfig, INPUT_MAP_KEY } from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';

/** Install the canvas-form action map as an App-owned World contribution. */
export function inputMapPlugin(configs: readonly ActionConfig[]): Plugin {
  const deduped = new Map<string, ActionConfig>();
  for (const config of configs) {
    if (config.action.length > 0) deduped.set(config.action, config);
  }
  const inputMap = Object.freeze([...deduped.values()]);
  return {
    name: 'input-map',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        ctx.world.insertResource(INPUT_MAP_KEY, inputMap);
        return () => ctx.world.removeResource(INPUT_MAP_KEY);
      }, 'input/action-map');
    },
  };
}
