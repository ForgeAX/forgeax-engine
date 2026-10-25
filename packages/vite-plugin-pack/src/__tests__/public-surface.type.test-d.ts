import type { Plugin } from 'vite';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  AssetHostRefreshPolicy,
  PluginPack,
  PluginPackDdcOptions,
  PluginPackOptions,
} from '../index.js';
import { pluginPack } from '../index.js';

describe('vite-plugin-pack public type surface', () => {
  it('keeps the root vocabulary narrow and option names explicit', () => {
    expectTypeOf(pluginPack()).toEqualTypeOf<PluginPack>();
    expectTypeOf<PluginPack>().toMatchTypeOf<Plugin>();
    expectTypeOf(pluginPack().runtimeBinding).toBeFunction();
    expectTypeOf(pluginPack().rebind).toBeFunction();
    expectTypeOf<keyof PluginPackOptions>().toEqualTypeOf<
      | 'roots'
      | 'takeInitialSourceSnapshot'
      | 'producerReadiness'
      | 'importers'
      | 'cookers'
      | 'refresh'
      | 'watch'
      | 'ignorePath'
      | 'sourceIdentityFor'
      | 'runtimeBinding'
      | 'ddc'
    >();
    expectTypeOf<keyof PluginPackDdcOptions>().toEqualTypeOf<
      'buildCacheRoot' | 'projectDdcRoot' | 'identityRoot'
    >();
    expectTypeOf<AssetHostRefreshPolicy>().toBeFunction();
  });
});
