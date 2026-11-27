import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import type { InlineConfig } from 'vite';
import type { DevKitAppOptions } from '../plugin-build.js';
import type { BuildOptions, ProjectFacts } from '../types.js';
import { prepareDesktopBuild } from './desktop.js';
import type { PluginSourceInventory } from './plugin-assets.js';
import { prepareWechatBuild } from './wechat.js';

type PlatformBuild =
  | { readonly kind: 'browser' }
  | (Awaited<ReturnType<typeof prepareWechatBuild>> & { readonly kind: 'wechat' })
  | (Awaited<ReturnType<typeof prepareDesktopBuild>> & { readonly kind: 'native' });

export async function preparePlatformBuild(
  facts: ProjectFacts,
  generated: string,
  inventory: PluginSourceInventory,
  appOptions: DevKitAppOptions,
  options: {
    readonly authoredPacks: readonly AuthoredRuntimePack[];
    readonly target?: BuildOptions['target'];
    readonly platform?: BuildOptions['platform'];
    readonly arch?: BuildOptions['arch'];
  },
): Promise<PlatformBuild> {
  switch (options.target) {
    case 'wechat':
      return {
        kind: 'wechat',
        ...(await prepareWechatBuild(
          facts,
          generated,
          inventory,
          appOptions,
          options.authoredPacks,
        )),
      };
    case 'native':
      return {
        kind: 'native',
        ...(await prepareDesktopBuild(facts, generated, inventory, appOptions, options)),
      };
    default:
      return { kind: 'browser' };
  }
}

export function viteBuildOptions(
  platform: PlatformBuild,
  realGeneratedRoot: string,
  projectRoot: string,
  output: { readonly sourcemap?: BuildOptions['sourcemap']; readonly outDir?: string },
  localBootstrap = false,
): NonNullable<InlineConfig['build']> {
  const wechat = platform.kind === 'wechat';
  const desktop = platform.kind === 'native';
  return {
    // Syntax capabilities only: lower optional chains/class fields but keep native BigInt.
    target: wechat ? 'chrome70' : 'esnext',
    sourcemap: output.sourcemap ?? false,
    outDir: output.outDir ?? resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    modulePreload: false,
    // Node-side WASM/provenance readers require actual module-relative files.
    ...(!desktop ? {} : { assetsInlineLimit: 0 }),
    rollupOptions: {
      // Portable plugin entries declare strict signatures individually.
      preserveEntrySignatures: wechat || desktop ? 'strict' : 'allow-extension',
      ...(!desktop ? {} : { external: isBuiltin }),
      input:
        platform.kind !== 'browser'
          ? { game: platform.entry }
          : {
              index: resolve(realGeneratedRoot, 'index.html'),
              ...(localBootstrap
                ? {}
                : { 'execution-bootstrap': resolve(realGeneratedRoot, 'execution-bootstrap.ts') }),
            },
      output: {
        ...(wechat ? { format: 'cjs' as const, chunkFileNames: 'assets/[name]-[hash].js' } : {}),
        // Generated pack module names can include absolute source paths.
        ...(desktop ? { format: 'es' as const, chunkFileNames: 'assets/chunk-[hash].mjs' } : {}),
        entryFileNames: wechat ? 'game.js' : desktop ? '[name].mjs' : 'assets/[name]-[hash].js',
      },
    },
  };
}
