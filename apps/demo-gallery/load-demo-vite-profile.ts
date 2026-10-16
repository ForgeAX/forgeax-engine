import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PluginPackOptions } from '@forgeax/engine-vite-plugin-pack';
import type { Plugin, UserConfig } from 'vite';
import type { DemoPackProfile, DemoPluginProfile } from './demo-plugin-profile.js';
import {
  getCapturedPackOptions,
  getCapturedShaderOptions,
  runWithDemoViteCapture,
} from './demo-vite-load-stubs.ts';
import { galleryDebug } from './gallery-debug.js';

const require = createRequire(import.meta.url);
const createJiti = require('jiti') as (id: string, opts?: Record<string, unknown>) => (id: string) => unknown;

const galleryDir = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(galleryDir, '..', '..');
const stubsPath = join(galleryDir, 'demo-vite-load-stubs.ts');
const runtimeStubsPath = join(galleryDir, 'demo-vite-runtime-stubs');
const engineStubsPath = join(galleryDir, 'demo-vite-engine-stubs.ts');
const optionalAssetPackStubPath = join(galleryDir, 'demo-vite-optional-asset-pack-stub.ts');
const sharedOptionalAssetPack = join(monorepoRoot, 'apps', 'shared', 'src', 'optional-asset-pack.js');

function jitiAliases(): Record<string, string> {
  return {
    vite: runtimeStubsPath,
    'vitest/config': runtimeStubsPath,
    '@forgeax/engine-vite-plugin-shader': stubsPath,
    '@forgeax/engine-vite-plugin-rhi-debug': stubsPath,
    '@forgeax/engine-vite-plugin-pack': stubsPath,
    '@forgeax/engine-fbx': engineStubsPath,
    '@forgeax/engine-gltf': engineStubsPath,
    '@forgeax/engine-image/image-importer': engineStubsPath,
    '@forgeax/engine-audio-webaudio/audio-importer': engineStubsPath,
    '@forgeax/engine-font/font-importer': engineStubsPath,
    '@forgeax/engine-ui/importer': engineStubsPath,
    '@forgeax/engine-shader-compiler': engineStubsPath,
    '@forgeax/engine-vfx-compiler': engineStubsPath,
    '@forgeax/engine-types': engineStubsPath,
    '@forgeax/engine-devkit': engineStubsPath,
    [sharedOptionalAssetPack]: optionalAssetPackStubPath,
    '../shared/src/optional-asset-pack.js': optionalAssetPackStubPath,
    '../../shared/src/optional-asset-pack.js': optionalAssetPackStubPath,
    '../../../shared/src/optional-asset-pack.js': optionalAssetPackStubPath,
  };
}

const STUB_NAMES = new Set([
  'forgeax:pack-stub',
  'forgeax:shader-stub',
  'forgeax:rhi-debug-stub',
  'forgeax:pack:runtime-only',
]);

function flattenPlugins(plugins: UserConfig['plugins']): Plugin[] {
  if (plugins === undefined) return [];
  const out: Plugin[] = [];
  for (const entry of plugins) {
    if (entry === undefined || entry === false) continue;
    if (Array.isArray(entry)) {
      out.push(...flattenPlugins(entry));
      continue;
    }
    if (typeof entry === 'function') continue;
    out.push(entry);
  }
  return out;
}

function isStubPlugin(plugin: Plugin): boolean {
  const name = plugin.name ?? '';
  return STUB_NAMES.has(name) || name.endsWith(':runtime-only');
}

function mergePackCaptures(captures: readonly PluginPackOptions[]): DemoPackProfile | undefined {
  if (captures.length === 0) return undefined;

  const merged = captures.reduce<DemoPackProfile>(
    (acc, capture) => {
      const roots = capture.roots ? [...capture.roots] : [];
      const importers = capture.importers ? [...capture.importers] : [];
      const cookers = capture.cookers ? [...capture.cookers] : [];
      return {
        runtimeBinding: capture.runtimeBinding ?? acc.runtimeBinding,
        roots: [...acc.roots, ...roots],
        importers: [...acc.importers, ...importers],
        cookers: [...acc.cookers, ...cookers],
        producerReadiness: capture.producerReadiness ?? acc.producerReadiness,
        projectDdcRoot: capture.ddc?.projectDdcRoot ?? acc.projectDdcRoot,
      };
    },
    { roots: [], importers: [], cookers: [] },
  );

  if (merged.runtimeBinding === undefined && merged.roots.length === 0) return undefined;
  return merged;
}

async function readDemoViteProfile(configPath: string): Promise<{
  pack: DemoPackProfile | undefined;
  shader: ReturnType<typeof getCapturedShaderOptions>;
  extraPlugins: Plugin[];
}> {
  return runWithDemoViteCapture(async () => {
    const configUrl = pathToFileURL(configPath).href;
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      cache: false,
      requireCache: false,
      v8cache: false,
      alias: jitiAliases(),
      transformOptions: {
        define: {
          'import.meta.url': JSON.stringify(configUrl),
        },
      },
    });

    const loaded = jiti(configPath) as UserConfig | ((env: unknown) => UserConfig | Promise<UserConfig>);
    const config =
      typeof loaded === 'function'
        ? await loaded({ command: 'serve', mode: 'development' })
        : loaded;
    const plugins = flattenPlugins(config?.plugins);
    const extraPlugins = plugins.filter((plugin) => !isStubPlugin(plugin));
    const pack = mergePackCaptures(getCapturedPackOptions());
    const shader = getCapturedShaderOptions();
    return { pack, shader, extraPlugins };
  });
}

export async function loadDemoViteProfile(route: string, consumerRoot: string): Promise<DemoPluginProfile> {
  const configPath = join(consumerRoot, 'vite.config.ts');
  if (!existsSync(configPath)) {
    return { route, consumerRoot, extraPlugins: [] };
  }

  try {
    const { pack, shader, extraPlugins } = await readDemoViteProfile(configPath);
    if (pack === undefined) {
      galleryDebug('profile has no pluginPack capture', { route, configPath });
    }

    return {
      route,
      consumerRoot: resolve(consumerRoot),
      ...(pack ? { pack } : {}),
      ...(shader ? { shader } : {}),
      extraPlugins,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[demo-gallery] failed to load vite plugins for ${route}: ${message}`);
    return { route, consumerRoot, extraPlugins: [] };
  }
}
