import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pluginPack, type PluginPack } from '@forgeax/engine-vite-plugin-pack';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { Plugin, ViteDevServer } from 'vite';
import { createDemoCatalog, type DemoCatalog } from './demo-catalog.js';
import { getDemoContext, getLastActiveDemoRoute, setDemoMaterialPackages } from './demo-context.js';
import { packProfileKey, type DemoPluginProfile } from './demo-plugin-profile.js';
import { galleryDebug, galleryLog } from './gallery-debug.js';
import { loadDemoViteProfile } from './load-demo-vite-profile.js';
import { mergeDemoPackCapabilities } from './merge-demo-pack-capabilities.js';
import { resolveDemoMaterialPackages } from './resolve-demo-material-packages.js';
import {
  assetRuntimeConfigModulePath,
  bindingForScope,
  emitGalleryPackRuntimeModule,
  GALLERY_UNBOUND_SCOPE,
  isGalleryPackRuntimeId,
  rememberActiveBinding,
  scopedRuntimeId,
  scopeFromRuntimeId,
  SCOPED_RUNTIME_PREFIX,
  VIRTUAL_PACK_RUNTIME_ID,
} from './scoped-pack-runtime.js';

export interface DemoPluginsOptions {
  appsDir: string;
  galleryDir: string;
  catalog?: DemoCatalog;
}

function installExtraPlugin(server: ViteDevServer, plugin: Plugin): void {
  plugin.configureServer?.(server);
}

function delegateHook<T extends keyof Plugin>(
  packPlugin: () => PluginPack | undefined,
  hook: T,
): NonNullable<Plugin[T]> {
  return ((...args: never[]) => {
    const plugin = packPlugin();
    const fn = plugin?.[hook];
    if (typeof fn !== 'function') return undefined;
    return (fn as (...inner: never[]) => unknown).apply(plugin, args);
  }) as NonNullable<Plugin[T]>;
}

function findCapturedBinding(
  scopeId: string,
  profileCache: Map<string, DemoPluginProfile>,
): RuntimeAssetBinding | undefined {
  for (const profile of profileCache.values()) {
    if (profile.pack?.runtimeBinding?.scopeId === scopeId) return profile.pack.runtimeBinding;
  }
  return undefined;
}

function resolveBindingForScope(
  scopeId: string,
  profileCache: Map<string, DemoPluginProfile>,
): RuntimeAssetBinding | undefined {
  return bindingForScope(scopeId) ?? findCapturedBinding(scopeId, profileCache);
}

function resolveScopeIdForPackRuntime(
  profileCache: Map<string, DemoPluginProfile>,
): string {
  const context = getDemoContext();
  const routeCandidates = [
    context?.route,
    getLastActiveDemoRoute(),
  ].filter((route, index, list): route is string => typeof route === 'string' && list.indexOf(route) === index);

  for (const route of routeCandidates) {
    const scopeId = profileCache.get(route)?.pack?.runtimeBinding?.scopeId;
    if (scopeId !== undefined) {
      galleryDebug('pack-runtime scope resolved', {
        route,
        scopeId,
        via: route === context?.route ? 'context' : 'lastRoute',
      });
      return scopeId;
    }
  }

  if (context !== undefined) {
    galleryLog('pack-runtime resolve fell back to unbound despite demo context', {
      routeCandidates,
    });
  } else {
    galleryDebug('pack-runtime scope unbound (no demo context)', { routeCandidates });
  }
  return GALLERY_UNBOUND_SCOPE;
}

function invalidateGalleryPackRuntimeModules(server: ViteDevServer, appsDir: string): void {
  const configPath = assetRuntimeConfigModulePath(appsDir);
  const configModules = server.moduleGraph.getModulesByFile(configPath);
  if (configModules !== undefined) {
    for (const module of configModules) {
      server.moduleGraph.invalidateModule(module);
    }
  }

  for (const module of server.moduleGraph.idToModuleMap.values()) {
    const id = module.id ?? '';
    if (id.startsWith(SCOPED_RUNTIME_PREFIX)) {
      server.moduleGraph.invalidateModule(module);
    }
  }
}

export interface DemoGalleryPluginsResult {
  readonly plugins: Plugin[];
  readonly prepareDemoRuntime: (
    server: ViteDevServer,
    route: string,
    consumerRoot: string,
  ) => Promise<void>;
}

function resolveActiveBindingForScope(
  scopeId: string,
  profileCache: Map<string, DemoPluginProfile>,
  packPlugin: PluginPack | undefined,
): RuntimeAssetBinding | undefined {
  const live = packPlugin?.runtimeBinding();
  if (live !== undefined && live.scopeId === scopeId) return live;
  return resolveBindingForScope(scopeId, profileCache);
}

export function createDemoPluginsPlugin(options: DemoPluginsOptions): DemoGalleryPluginsResult {
  const catalog = options.catalog ?? createDemoCatalog(options.appsDir);
  const monorepoRoot = catalog.monorepoRoot;
  const galleryDir = options.galleryDir;

  const profileCache = new Map<string, DemoPluginProfile>();
  const installedExtraRoutes = new Set<string>();
  let packPlugin: PluginPack | undefined;
  let activePackKey: string | undefined;
  let profilesReady: Promise<void> | undefined;

  async function loadProfiles(): Promise<void> {
    for (const entry of catalog.hostedDemos) {
      const profile = await loadDemoViteProfile(entry.route, entry.dir);
      profileCache.set(profile.route, profile);
      if (profile.pack?.runtimeBinding !== undefined) {
        rememberActiveBinding(profile.pack.runtimeBinding);
      }
      setDemoMaterialPackages(
        profile.route,
        resolveDemoMaterialPackages(profile, entry.materialPackages),
      );
    }
    galleryDebug('profiles loaded', {
      demoCount: catalog.hostedDemos.length,
      withPack: [...profileCache.values()].filter((profile) => profile.pack?.runtimeBinding !== undefined).length,
    });
  }

  async function ensureProfilesReady(): Promise<void> {
    profilesReady ??= loadProfiles();
    await profilesReady;
  }

  async function ensureProfile(route: string, consumerRoot: string): Promise<DemoPluginProfile> {
    await ensureProfilesReady();
    const cached = profileCache.get(route);
    if (cached) return cached;
    const entry = catalog.hostedDemos.find((demo) => demo.route === route);
    const profile = await loadDemoViteProfile(route, consumerRoot);
    profileCache.set(route, profile);
    if (profile.pack?.runtimeBinding !== undefined) {
      rememberActiveBinding(profile.pack.runtimeBinding);
    }
    setDemoMaterialPackages(
      profile.route,
      resolveDemoMaterialPackages(profile, entry?.materialPackages ?? []),
    );
    return profile;
  }

  async function ensureExtraPlugins(server: ViteDevServer, profile: DemoPluginProfile): Promise<void> {
    if (installedExtraRoutes.has(profile.route)) return;
    for (const plugin of profile.extraPlugins) {
      installExtraPlugin(server, plugin);
    }
    installedExtraRoutes.add(profile.route);
  }

  async function ensurePack(server: ViteDevServer, profile: DemoPluginProfile): Promise<void> {
    if (packPlugin === undefined) return;

    const key = packProfileKey(profile.pack);
    if (activePackKey === key) return;

    if (profile.pack === undefined) {
      galleryLog('ensurePack skipped: no pack profile', { route: profile.route, key });
      activePackKey = key;
      return;
    }

    const binding = profile.pack.runtimeBinding;
    if (binding === undefined) {
      galleryLog('ensurePack skipped: no runtimeBinding in profile', { route: profile.route, key });
      activePackKey = key;
      return;
    }

    const roots = profile.pack.roots.filter((root) => existsSync(root));
    const projectDdcRoot =
      profile.pack.projectDdcRoot ?? resolve(galleryDir, '.forgeax', 'ddc', 'gallery', profile.route);

    await packPlugin.rebind(binding, roots, projectDdcRoot);
    rememberActiveBinding(packPlugin.runtimeBinding() ?? binding);
    activePackKey = key;
    invalidateGalleryPackRuntimeModules(server, catalog.appsDir);
    galleryDebug('ensurePack rebound', {
      route: profile.route,
      scopeId: binding.scopeId,
      roots: roots.length,
      generation: packPlugin.runtimeBinding()?.generation,
      status: packPlugin.runtimeBinding()?.status,
    });
  }

  async function prepareDemoRuntime(
    server: ViteDevServer,
    route: string,
    consumerRoot: string,
  ): Promise<void> {
    const profile = await ensureProfile(route, consumerRoot);
    await ensureExtraPlugins(server, profile);
    await ensurePack(server, profile);
  }

  const scopedRuntimePlugin: Plugin = {
    name: 'forgeax:demo-scoped-pack-runtime',
    enforce: 'pre',
    apply: 'serve',

    resolveId(source) {
      if (source === VIRTUAL_PACK_RUNTIME_ID) {
        const scopeId = resolveScopeIdForPackRuntime(profileCache);
        return scopedRuntimeId(scopeId);
      }
      if (isGalleryPackRuntimeId(source)) return source;
      return null;
    },

    load(id) {
      const scopeId = scopeFromRuntimeId(id);
      if (scopeId === undefined) return null;

      if (scopeId === GALLERY_UNBOUND_SCOPE) {
        galleryDebug('pack-runtime load unbound');
        return emitGalleryPackRuntimeModule(undefined);
      }

      const binding = resolveActiveBindingForScope(scopeId, profileCache, packPlugin);
      if (binding === undefined) {
        galleryLog('pack-runtime load missing binding for scope', { scopeId });
      } else {
        galleryDebug('pack-runtime load bound', { scopeId, gameId: binding.gameId });
      }
      return emitGalleryPackRuntimeModule(binding);
    },
  };

  const hostPlugin: Plugin = {
    name: 'forgeax:demo-plugins',
    enforce: 'pre',

    async configureServer(server) {
      await ensureProfilesReady();

      const { importers, cookers } = mergeDemoPackCapabilities(profileCache.values());

      packPlugin = pluginPack({
        refresh: () => {},
        ddc: {
          buildCacheRoot: resolve(monorepoRoot, 'shared-build-inputs', 'ddc'),
          projectDdcRoot: resolve(galleryDir, '.forgeax', 'ddc', 'gallery'),
        },
        importers,
        cookers,
      });

      packPlugin.configureServer?.(server);
    },

    resolveId(source, importer, meta) {
      const context = getDemoContext();
      if (context === undefined) return null;
      const profile = profileCache.get(context.route);
      if (profile === undefined) return null;

      for (const plugin of profile.extraPlugins) {
        const resolved = plugin.resolveId?.(source, importer, meta);
        if (resolved !== undefined && resolved !== null) return resolved;
      }
      return null;
    },

    load(id) {
      const context = getDemoContext();
      if (context === undefined) return null;
      const profile = profileCache.get(context.route);
      if (profile === undefined) return null;

      for (const plugin of profile.extraPlugins) {
        const loaded = plugin.load?.(id);
        if (loaded !== undefined && loaded !== null) return loaded;
      }
      return null;
    },
  };

  const packProxy: Plugin = {
    name: 'forgeax:demo-pack-proxy',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === VIRTUAL_PACK_RUNTIME_ID) return null;
      if (isGalleryPackRuntimeId(source)) return null;
      return delegateHook(() => packPlugin, 'resolveId')(source, importer);
    },
    load(id) {
      if (id === VIRTUAL_PACK_RUNTIME_ID || isGalleryPackRuntimeId(id)) return null;
      return delegateHook(() => packPlugin, 'load')(id);
    },
    transform: delegateHook(() => packPlugin, 'transform'),
    transformIndexHtml: delegateHook(() => packPlugin, 'transformIndexHtml'),
  };

  return {
    plugins: [scopedRuntimePlugin, hostPlugin, packProxy],
    prepareDemoRuntime,
  };
}
