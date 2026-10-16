// Public consumer imports validated by scripts/check-public-import-examples.mjs:
// import { Context, mountPluginAsset, type Plugin } from '@forgeax/engine/plugin';
import { Context, type Plugin } from '../index.js';

const plugin: Plugin.Object<{ readonly speed: number }> = {
  apply(_ctx, config) {
    void config.speed;
  },
};
const context = new Context();
context.plugin(plugin, { speed: 1 });
// @ts-expect-error Native Cordis configuration preserves the declared type.
context.plugin(plugin, { speed: 'fast' });
