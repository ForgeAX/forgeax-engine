import { Console } from 'node:console';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf/node-importer';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly, type HostAssembly } from '@forgeax/engine-host/protocol';
import { attachHostWebSocketServer, createHostTransport } from '@forgeax/engine-host/transport';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import {
  createScriptablePackProductCache,
  createStandardAssetOutputProducerRegistry,
  iesImporter,
} from '@forgeax/engine-import';
import { objImporter, stlImporter, svgImporter } from '@forgeax/engine-mesh-io';
import { encodeCatalogWire } from '@forgeax/engine-pack';
import type { PackError } from '@forgeax/engine-pack/errors';
import {
  declaredPackAssets,
  type ScanInventory,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
  scanInventory,
} from '@forgeax/engine-pack/scanner';
import { projectScriptablePackSceneComponents } from '@forgeax/engine-pack/source';
import {
  createScriptablePackSourceSnapshot,
  type ScriptablePackMetadataCache,
} from '@forgeax/engine-pack/source-node';
import { validateCanonicalKitReceipt } from '@forgeax/engine-preview';
import type { SsrAdmissionIdentity } from '@forgeax/engine-render';
import { createMaterialPackCooker, listMaterialSourcePaths } from '@forgeax/engine-shader-compiler';
import {
  createStandaloneRuntimeAssetBinding,
  DEFAULT_LOAD_PROGRESS_LABELS,
  type Importer,
  type LoadProgressLabels,
  resolveLoadProgressLabels,
} from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import {
  createLogger,
  createServer as createViteServer,
  type Environment,
  type HotUpdateOptions,
  type InlineConfig,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
  build as viteBuild,
  preview as vitePreview,
} from 'vite';
import { type WebSocket, WebSocketServer } from 'ws';
import { animationPlayback, environmentAnimationPlayback } from './animation-playback.js';
import {
  assetLibrarySourceIdentity,
  findEngineWorkspaceRoot,
  owningAssetLibrary,
} from './asset-libraries.js';
import { loadProjectCookers } from './build/cookers.js';
import { executionWorkerEntries, runtimeDependencyEntries } from './build/execution-workers.js';
import { materialBuildCapabilityGuard } from './build/material-profile.js';
import {
  assertPluginSourceInputs,
  discoverPluginAssets,
  isPluginAssetSourceIgnoredPath,
  type PluginSourceInventory,
  publishedPluginInventory,
} from './build/plugin-assets.js';
import {
  pluginProgramsBuild,
  pluginRootDescriptor,
  pluginRuntimeProjection,
} from './build/plugin-programs.js';
import { runtimePacksSource } from './build/runtime-packs-source.js';
import { staticPackProgramsSource } from './build/static-pack-programs.js';
import { writeTauriProject } from './build/tauri.js';
import {
  prepareWechatBuild,
  verifyWechatPackageBudget,
  writeWechatProject,
} from './build/wechat.js';
import { verifyDist, writeDistManifest } from './dist.js';
import {
  enginePackageRuntimeIdentity,
  inspectEngineWorkspace,
  readEngineBinding,
} from './engine-binding.js';
import { environmentExecutionWorkers } from './execution-workers.js';
import { filesystemPathRelative, isFilesystemPathWithin } from './filesystem-path.js';
import { gameVfxSource } from './game-vfx-source.js';
import { gameProjectionSource } from './host/game-projection-source.js';
import { previewBatchEntrySource } from './host/preview-batch-entry-source.js';
import {
  previewVfxBoundsSource,
  resourcePresentationSource,
} from './host/resource-presentation-source.js';
import { hostStartupDocument, hostStartupScript } from './host/startup-source.js';
import {
  composeBoundHostAssembly,
  type DevKitHostBinding,
  hostBindingError,
  validateHostBinding,
} from './host-binding.js';
import { LIVE_BRIDGE_OWNER_PARAM } from './live-bridge-url.js';
import { PLAYER_DELIVERY_FILE } from './player-dist.js';
import type { DevKitAppOptions } from './plugin-build.js';
import { preparePreviewHttpArtifacts } from './preview-http-artifacts.js';
import { commandError, readProjectFacts, readProjectStartupTimeoutMs } from './project.js';
import {
  DEV_EXECUTION_TIMEOUT_MS,
  DEV_PREPARATION_TIMEOUT_MS,
  PRODUCTION_EXECUTION_TIMEOUT_MS,
} from './startup-budget.js';
import { projectToolProjection } from './tools/project-tools.js';
import type {
  BootstrapRoot,
  BuildOptions,
  CommandResult,
  PreviewOptions,
  ProjectCommandOptions,
  ProjectFacts,
  ProjectPortOptions,
} from './types.js';
import { resolveProjectPort } from './types.js';

const activeDevKitHosts = new Set<BackendHost>();

async function notifyAuthoringSourceChange(
  host: DevKitHostBinding | undefined,
  context: HotUpdateOptions,
  resolvedPath: string,
): Promise<boolean | undefined> {
  const notify = host?.authoringSourceChanged;
  if (notify === undefined) return undefined;
  if (context.type !== 'delete') {
    try {
      await context.read();
    } catch (cause) {
      let missing = false;
      if (typeof cause === 'object' && cause !== null) {
        try {
          missing = Reflect.get(cause, 'code') === 'ENOENT';
        } catch {
          // Preserve the original read failure if its code cannot be read.
        }
      }
      if (!missing) throw cause;
    }
  }
  return notify.call(host, resolvedPath);
}

export async function disposeDevKitHosts(): Promise<void> {
  const hosts = [...activeDevKitHosts];
  activeDevKitHosts.clear();
  for (const host of hosts) await host.dispose();
}

export const DEFAULT_IMPORTERS: readonly Importer[] = [
  audioImporter,
  imageImporter,
  fbxImporter,
  gltfImporter,
  objImporter,
  stlImporter,
  svgImporter,
  fontImporter,
  iesImporter,
  createUiImporter(),
];

export function ignoreDevKitCatalogPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').includes('shaders');
}

export function devKitDdcRoots(projectRoot: string): {
  readonly buildCacheRoot: string;
  readonly projectDdcRoot: string;
  readonly identityRoot: string;
} {
  // Build-cache entries are content-addressed, keyed relative to the project
  // root, and published atomically, so a copied project reuses its products
  // and several checkouts may opt into one shared root.
  const sharedBuildCache = process.env.FORGEAX_BUILD_CACHE_DIR?.trim();
  return {
    buildCacheRoot: sharedBuildCache
      ? resolve(sharedBuildCache)
      : resolve(projectRoot, '.forgeax', 'ddc', 'build-cache'),
    projectDdcRoot: resolve(projectRoot, '.forgeax', 'ddc', 'v2'),
    identityRoot: resolve(projectRoot),
  };
}

/** Bind cached images to the actual transitive Engine implementation, once per server. */
async function previewProducerIdentity(): Promise<string> {
  const visited = new Set<string>();
  const identities: [string, string][] = [];
  const visit = async (manifestPath: string): Promise<void> => {
    const path = await realpath(manifestPath);
    if (visited.has(path)) return;
    visited.add(path);
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    const resolver = createRequire(path);
    identities.push([manifest.name, await enginePackageRuntimeIdentity(dirname(path))]);
    await Promise.all(
      Object.keys(manifest.dependencies ?? {})
        .filter((name) => name.startsWith('@forgeax/engine-'))
        .map((name) => visit(resolver.resolve(`${name}/package.json`))),
    );
  };
  await Promise.all(
    ['app', 'preview'].map((name) =>
      visit(hostRequire.resolve(`@forgeax/engine-${name}/package.json`)),
    ),
  );
  return createHash('sha256')
    .update(JSON.stringify(identities.sort(([a], [b]) => a.localeCompare(b))))
    .update(previewBatchEntrySource())
    .digest('hex');
}

function isResourcePreviewIgnoredPath(path: string): boolean {
  return (
    ignoreDevKitCatalogPath(path) ||
    path.endsWith('.wgsl.meta.json') ||
    path.endsWith('target-profile.json.meta.json')
  );
}

function isProjectSourceIgnoredPath(path: string): boolean {
  return (
    ignoreDevKitCatalogPath(path) ||
    path.endsWith('.wgsl.meta.json') ||
    path.endsWith('target-profile.json.meta.json')
  );
}

interface CanonicalKitLocation {
  readonly root: string;
  readonly guid: string;
}

/** Return authored single-material packs to the shader compiler's static graph. */
async function discoverMaterialPackages(
  inventory: Pick<ScanInventory, 'declarations'> | undefined,
): Promise<readonly string[]> {
  if (inventory === undefined) return [];
  const paths: string[] = [];
  for (const declaration of inventory.declarations.values()) {
    if (declaration.format !== 'pack.json') continue;
    const assets = declaredPackAssets(declaration.value);
    if (
      assets.length === 1 &&
      assets[0]?.kind === 'material' &&
      assets[0].payload?.kind === 'material'
    )
      paths.push(declaration.sourcePath);
  }
  return paths.sort();
}

const hostRequire = createRequire(import.meta.url);

interface EngineWorkspacePackage {
  readonly root: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

type PackageExportValue = string | null | { readonly [key: string]: PackageExportValue };

function findInstalledEnginePackageRoot(start: string): string | undefined {
  let cursor = resolve(start);
  for (;;) {
    if (dirname(cursor) !== cursor && cursor.endsWith(`${sep}node_modules${sep}@forgeax`)) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function engineWorkspacePackages(
  workspaceRoot?: string,
): Promise<ReadonlyMap<string, EngineWorkspacePackage>> {
  const sourceWorkspaceRoot = workspaceRoot ?? findEngineWorkspaceRoot();
  const packageRoot =
    sourceWorkspaceRoot !== undefined
      ? resolve(sourceWorkspaceRoot, 'packages')
      : findInstalledEnginePackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot === undefined) return new Map<string, EngineWorkspacePackage>();
  // A generated game is a pnpm workspace too, but it does not own a local
  // `packages/` tree. Its installed Engine packages are resolved by Node;
  // the workspace resolver is only an SDK/source-checkout fallback. A packaged
  // desktop DevKit has no pnpm workspace, so its staged node_modules/@forgeax
  // dependency closure is the equivalent immutable package root.
  if (!existsSync(packageRoot)) return new Map<string, EngineWorkspacePackage>();
  const packages = new Map<string, EngineWorkspacePackage>();
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = resolve(packageRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as unknown;
      if (manifest === null || typeof manifest !== 'object') continue;
      const name = (manifest as { readonly name?: unknown }).name;
      if (typeof name === 'string' && name.startsWith('@forgeax/engine')) {
        packages.set(name, { root, manifest: manifest as Readonly<Record<string, unknown>> });
      }
    } catch {
      // A partial SDK/source checkout may omit an unrelated package manifest. The
      // package remains resolvable from the consumer project when available.
    }
  }
  return packages;
}

function conditionalExport(
  value: PackageExportValue,
  conditions: readonly string[] = ['browser', 'import', 'node', 'default'],
): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || Array.isArray(value)) return undefined;
  for (const condition of conditions) {
    const candidate = value[condition];
    if (candidate === undefined) continue;
    const selected = conditionalExport(candidate, conditions);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function packageExportTarget(
  manifest: Readonly<Record<string, unknown>>,
  subpath: string,
  conditions?: readonly string[],
): string | undefined {
  const exportsValue = manifest.exports as PackageExportValue | undefined;
  if (exportsValue === undefined) {
    if (subpath.length > 0) return undefined;
    const main = manifest.module ?? manifest.main;
    return typeof main === 'string' ? main : undefined;
  }
  if (typeof exportsValue === 'string' || exportsValue === null) {
    return subpath.length === 0 ? conditionalExport(exportsValue, conditions) : undefined;
  }
  const keys = Object.keys(exportsValue);
  const subpathMap = keys.some((key) => key === '.' || key.startsWith('./'));
  if (!subpathMap)
    return subpath.length === 0 ? conditionalExport(exportsValue, conditions) : undefined;
  const requested = subpath.length === 0 ? '.' : `./${subpath}`;
  const exact = exportsValue[requested];
  if (exact !== undefined) return conditionalExport(exact, conditions);
  for (const key of keys) {
    const marker = key.indexOf('*');
    if (marker < 0) continue;
    const prefix = key.slice(0, marker);
    const suffix = key.slice(marker + 1);
    if (!requested.startsWith(prefix) || !requested.endsWith(suffix)) continue;
    const replacement = requested.slice(prefix.length, requested.length - suffix.length);
    const exportTarget = exportsValue[key];
    if (exportTarget === undefined) continue;
    const selected = conditionalExport(exportTarget, conditions);
    return selected?.replaceAll('*', replacement);
  }
  return undefined;
}

function engineWorkspaceImport(
  source: string,
  packages: ReadonlyMap<string, EngineWorkspacePackage>,
  conditions?: readonly string[],
): string | undefined {
  if (!source.startsWith('@forgeax/engine')) return undefined;
  const separator = source.indexOf('/', '@forgeax/engine'.length);
  const packageName = separator < 0 ? source : source.slice(0, separator);
  const subpath = separator < 0 ? '' : source.slice(separator + 1);
  const packageInfo = packages.get(packageName);
  if (packageInfo === undefined) return undefined;
  const target = packageExportTarget(packageInfo.manifest, subpath, conditions);
  if (target === undefined) return undefined;
  const absolute = resolve(packageInfo.root, target);
  if (!isFilesystemPathWithin(packageInfo.root, absolute, false)) {
    return undefined;
  }
  return absolute;
}

async function createEngineWorkspaceResolver(projectRoot: string): Promise<Plugin | undefined> {
  const binding = await readEngineBinding(projectRoot);
  if (!binding.ok) {
    throw new Error(`${binding.error.code}: ${binding.error.hint}`);
  }
  const localRoot = binding.value?.path;
  if (localRoot !== undefined) {
    const inspected = await inspectEngineWorkspace(localRoot);
    if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.hint}`);
  }
  const packages = await engineWorkspacePackages(localRoot);
  if (packages.size === 0) return undefined;
  let conditions: readonly string[] | undefined;
  return {
    name: 'forgeax:devkit-engine-workspace-resolver',
    enforce: 'pre',
    async config(_config, environment) {
      if (environment.command !== 'serve') return;
      if (localRoot === undefined) {
        try {
          createRequire(resolve(projectRoot, 'package.json')).resolve(
            '@forgeax/engine/package.json',
          );
          return;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          // Hidden metadata still proves a project-owned package is installed.
          if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return;
          if (code !== 'MODULE_NOT_FOUND') throw cause;
        }
      }
      const app = packages.get('@forgeax/engine-app');
      if (app === undefined) return;
      // The workspace resolver supplies Engine to projects without an install.
      // Its same App closure must seed dependency discovery before the first page.
      return {
        optimizeDeps: {
          entries: [
            '**/*.html',
            'execution-bootstrap.ts',
            ...(await runtimeDependencyEntries(resolve(app.root, 'package.json'))),
          ],
        },
      };
    },
    configResolved(config) {
      conditions = [...config.resolve.conditions, 'import', 'default'];
    },
    async resolveId(source, importer) {
      const bareSource = source.split('?', 1)[0] ?? source;
      if (!bareSource.startsWith('@forgeax/engine')) return null;
      if (localRoot !== undefined) return engineWorkspaceImport(bareSource, packages, conditions);
      try {
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved !== null) return resolved;
      } catch {
        // Fall through to the Engine workspace only when the external project
        // has no installed copy of this package.
      }
      return engineWorkspaceImport(bareSource, packages, conditions);
    },
  };
}

/**
 * Reuse the production host's workspace fallback when a second bundle pass
 * resolves Engine packages from a source checkout.
 */
export async function createEngineWorkspaceResolverForProject(
  projectRoot: string,
): Promise<Plugin | undefined> {
  return createEngineWorkspaceResolver(projectRoot);
}

async function consumerEngineAliases(
  projectRoot: string,
): Promise<readonly { readonly find: string; readonly replacement: string }[]> {
  const root = resolve(projectRoot, 'node_modules', '.pnpm', 'node_modules', '@forgeax');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('engine-'))
      .map((entry) => ({
        find: `@forgeax/${entry.name}`,
        replacement: resolve(root, entry.name),
      }))
      .sort((a, b) => a.find.localeCompare(b.find));
  } catch {
    return [];
  }
}

async function hostEngineAliases(
  projectRoot: string,
  binding: DevKitHostBinding | undefined,
): Promise<
  readonly {
    readonly find: string;
    readonly replacement: string;
    readonly customResolver: (id: string) => string | null;
  }[]
> {
  const hostRoot = binding?.backend.context.get('devkitBackend')?.hostPackageRoot;
  if (hostRoot === undefined) return [];
  const hostManifest = JSON.parse(await readFile(resolve(hostRoot, 'package.json'), 'utf8'));
  // An Engine-aware presentation borrows the executing source Host's vocabulary.
  // Its installed dependency supplies the default when no source workspace runs.
  if (hostManifest.dependencies?.['@forgeax/engine'] === undefined) return [];
  const presentationRequire = createRequire(resolve(hostRoot, 'package.json'));
  const engineRoot =
    (await engineWorkspacePackages()).get('@forgeax/engine')?.root ??
    dirname(presentationRequire.resolve('@forgeax/engine/package.json'));
  const manifest = JSON.parse(await readFile(resolve(engineRoot, 'package.json'), 'utf8'));
  const engineRequire = createRequire(resolve(engineRoot, 'package.json'));
  const local = await readEngineBinding(projectRoot);
  if (!local.ok) hostBindingError(`${local.error.code}: ${local.error.hint}`);
  const localPackages = local.value
    ? await engineWorkspacePackages(local.value.path)
    : new Map<string, EngineWorkspacePackage>();
  const projectRequire = createRequire(resolve(projectRoot, 'package.json'));
  const projectEngineRequire = local.value?.path
    ? undefined
    : createRequire(projectRequire.resolve('@forgeax/engine/package.json'));
  const aliases = [];
  for (const name of [
    '@forgeax/engine',
    ...Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith('@forgeax/engine-'),
    ),
  ]) {
    const selected = await realpath(dirname(engineRequire.resolve(`${name}/package.json`)));
    const target =
      localPackages.get(name)?.root ??
      dirname(
        projectEngineRequire?.resolve(`${name}/package.json`) ??
          projectRequire.resolve(`${name}/package.json`),
      );
    const actual = await realpath(target);
    if (
      actual !== selected &&
      (await enginePackageRuntimeIdentity(actual)) !==
        (await enginePackageRuntimeIdentity(selected))
    ) {
      hostBindingError(
        `frontend Engine source conflict for ${name}: host=${selected}; project=${actual}. Select the same Engine build before opening this target.`,
      );
    }
    const selectedManifest = JSON.parse(await readFile(resolve(selected, 'package.json'), 'utf8'));
    const selectedPackages = new Map([[name, { root: selected, manifest: selectedManifest }]]);
    aliases.push({
      find: name,
      replacement: name,
      customResolver: (id: string) => engineWorkspaceImport(id, selectedPackages) ?? null,
    });
  }
  return aliases.sort((a, b) => b.find.length - a.find.length);
}

async function hostFrontendModuleAlias(
  binding: DevKitHostBinding | undefined,
): Promise<{ readonly find: string; readonly replacement: string } | undefined> {
  const specifier = binding?.frontendModule?.specifier;
  const packageRoot = binding?.backend.context.get('devkitBackend')?.hostPackageRoot;
  if (
    specifier === undefined ||
    packageRoot === undefined ||
    specifier.startsWith('.') ||
    isAbsolute(specifier) ||
    specifier.includes(':')
  )
    return undefined;
  try {
    return {
      find: specifier,
      replacement: await realpath(
        createRequire(resolve(packageRoot, 'package.json')).resolve(specifier),
      ),
    };
  } catch (cause) {
    hostBindingError(
      `host package cannot resolve frontend module ${specifier} from ${packageRoot}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function resolveCanonicalKit(): Promise<CanonicalKitLocation> {
  const packageJson = hostRequire.resolve('@forgeax/engine-preview/package.json');
  const root = resolve(packageJson, '..', 'assets/canonical-kit');
  if (!existsSync(root)) throw new Error(`canonical preview kit root is missing: ${root}`);
  const receiptPath = resolve(root, 'cook-receipt.json');
  const receipt = validateCanonicalKitReceipt(JSON.parse(await readFile(receiptPath, 'utf8')));
  if (!receipt.ok) {
    throw new Error(`${receipt.error.code}: ${receipt.error.detail.field}`);
  }
  const sourcePath = resolve(root, receipt.value.transport.source);
  const metaPath = resolve(root, receipt.value.transport.meta);
  if (!existsSync(sourcePath) || !existsSync(metaPath)) {
    throw new Error('canonical preview kit source and Meta must be package-owned files');
  }
  const [source, meta] = await Promise.all([readFile(sourcePath), readFile(metaPath)]);
  for (const [file, bytes, expectedDigest] of [
    [receipt.value.transport.source, source, receipt.value.source.digest],
    [receipt.value.transport.meta, meta, receipt.value.source.metaDigest],
  ] as const) {
    const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actualDigest !== expectedDigest) {
      throw Object.assign(new Error(`preview-kit-source-mismatch: ${file}`), {
        code: 'preview-kit-source-mismatch',
        expected: 'canonical preview kit source and Meta bytes to match their cook receipt',
        hint: 'Run the canonical kit producer and publish its source, Meta, and receipt together.',
        detail: { file, expectedDigest, actualDigest },
      });
    }
  }
  return { root, guid: receipt.value.source.guid };
}

export function devKitHostBridge(
  binding?: DevKitHostBinding,
  assemblyInput?: HostAssembly | (() => Promise<HostAssembly>),
): Plugin & { releaseForRestart(): Promise<void> } {
  let dispose: ((restore?: boolean) => Promise<void>) | undefined;
  return {
    async releaseForRestart() {
      await dispose?.(false);
    },
    name: 'forgeax:devkit-backend-host',
    async configureServer(server) {
      const assembly =
        typeof assemblyInput === 'function'
          ? await assemblyInput()
          : (assemblyInput ??
            (binding
              ? composeBoundHostAssembly(binding, createHostAssembly())
              : createHostAssembly()));
      if (binding) validateHostBinding(binding);
      const http = server.httpServer;
      if (!http) return;
      const httpEvents: EventEmitter = http;
      const projected =
        binding?.frontendAssembly !== undefined || binding?.workspace?.execution === 'game';
      const previous = binding?.backend.assembly.current;
      const transport = binding?.backend.transport ?? createHostTransport();
      const backend = binding?.backend ?? (await createBackendHost({ assembly, transport }));
      if (binding && previous && !projected)
        await backend.update(assembly, { expectedRevision: previous.revision });
      const published = backend.assembly.current.revision;
      const sockets = new Set<() => void>();
      const socketServer = new WebSocketServer({ noServer: true });
      let workspaceSocket: WebSocket | undefined;
      let admitting = false;
      const projections = new Map<string, () => void>();
      const removeConnect = transport.onClientConnect((caller) => {
        if (admitting && projected)
          projections.set(caller.connectionId, backend.bindProjection(caller, { assembly }));
      });
      const removeDisconnect = transport.onClientDisconnect((caller) => {
        projections.get(caller.connectionId)?.();
        projections.delete(caller.connectionId);
      });
      socketServer.on('connection', (socket: WebSocket) => {
        if (binding?.workspace) {
          workspaceSocket?.close();
          workspaceSocket = socket;
        }
        const workspace = binding?.workspace;
        admitting = true;
        let release: () => void;
        try {
          release = attachHostWebSocketServer(
            socket,
            transport,
            workspace
              ? {
                  kind: 'frontend',
                  sourceId: `forgeax-workspace:${workspace.sessionId}:${workspace.targetId}`,
                }
              : {},
          );
        } finally {
          admitting = false;
        }
        sockets.add(release);
        socket.once('close', () => sockets.delete(release));
      });
      const upgrade = (
        request: import('node:http').IncomingMessage,
        socket: import('node:stream').Duplex,
        head: Buffer,
      ) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__forgeax/host') return;
        const workspace = binding?.workspace;
        if (
          workspace &&
          (url.searchParams.get('forgeaxWorkspaceSession') !== workspace.sessionId ||
            url.searchParams.get('forgeaxWorkspaceTarget') !== workspace.targetId ||
            url.searchParams.get('forgeaxWorkspaceToken') !== workspace.admissionToken)
        ) {
          socket.destroy();
          return;
        }
        socketServer.handleUpgrade(request, socket, head, (client) =>
          socketServer.emit('connection', client, request),
        );
      };
      httpEvents.on('upgrade', upgrade);
      const marker =
        binding && !projected
          ? backend.context.plugin({
              apply(ctx) {
                ctx.provide('devkitHostBinding', binding);
              },
            }).ctx.fiber
          : undefined;
      let disposed = false;
      const removeBackendDispose = binding?.backend.subscribeDispose(() => dispose?.(false));
      dispose = async (restore = true) => {
        if (disposed) return;
        disposed = true;
        httpEvents.off('upgrade', upgrade);
        removeBackendDispose?.();
        removeConnect();
        removeDisconnect();
        for (const release of projections.values()) release();
        projections.clear();
        for (const release of sockets) release();
        sockets.clear();
        socketServer.close();
        await marker?.dispose();
        if (!binding) await backend.dispose();
        else if (
          !projected &&
          restore &&
          previous &&
          backend.assembly.current.revision === published
        ) {
          await backend.update(
            { ...previous, sessionGeneration: backend.assembly.current.sessionGeneration + 1 },
            { expectedRevision: published },
          );
        }
      };
      httpEvents.once('close', () => {
        void dispose?.();
      });
    },
    async closeBundle() {
      await dispose?.();
    },
  };
}

/** The existing input fence identifies this generation, not a Git commit or final bundle. */
function projectSsrIdentity(
  facts: ProjectFacts,
  inventory: PluginSourceInventory,
  generation: {
    readonly command: 'serve' | 'build';
    readonly base: string;
    readonly bootstrapRoot: BootstrapRoot;
    readonly sessionGeneration: number;
    readonly animation: AnimationPlaybackOptions;
    readonly appOptions: DevKitAppOptions;
  },
): SsrAdmissionIdentity {
  const digest = (value: unknown): string =>
    `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  const inputs = [...inventory.sourceInputs]
    .map(([path, revision]) => [relative(facts.root, path).split(sep).join('/'), revision] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const sourceTree = digest(inputs);
  const lockSha256 = digest(
    inputs.filter(([path]) =>
      ['package.json', 'pnpm-lock.yaml', 'bun.lock', 'package-lock.json'].includes(path),
    ),
  );
  return {
    sourceHead: `project:${facts.id}`,
    sourceTree,
    lockSha256,
    buildSha256: digest({
      sourceTree,
      lockSha256,
      roots: Object.entries(facts.roots).sort(([left], [right]) => left.localeCompare(right)),
      ...generation,
    }),
  };
}

function executionBootstrapSource(
  bootstrapRoot: BootstrapRoot,
  sessionGeneration: number,
  ssrIdentity: SsrAdmissionIdentity,
  target?: BuildOptions['target'],
  appOptions: DevKitAppOptions = {},
): string {
  return `import { audioPlugin } from '@forgeax/engine/audio';
import type { GameHost } from '@forgeax/engine/app';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { root, createPrograms } from 'virtual:forgeax/plugin-programs/engine';
import { runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { createRuntimePackOptions${target === 'tauri' ? '' : ', createRuntimePackDeliveryClient'} } from './runtime-packs';
import { createGameVfx } from './game-vfx';
export default async function executionBootstrap(data) {
const vfx = createGameVfx({ isolateViewGraph: data?.isolateVfxViewGraph === true, instanceArenas: data?.vfxInstanceArenas !== false, nativePlanning: data?.vfxNativePlanning !== false, retainedResources: data?.vfxRetainedResources !== false });
${target === 'tauri' ? '' : `let prepareDelivery: ReturnType<typeof createRuntimePackDeliveryClient> = async () => ({ error: 'Runtime Pack page bridge is not ready' });`}
const bridge = {
  name: 'forgeax:worker-game-host', inject: ['world', 'assets', 'executionBootstrapHost'],
  apply(ctx) {
    ${
      target === 'tauri'
        ? ''
        : `const lifetime = new AbortController();
    prepareDelivery = createRuntimePackDeliveryClient(data?.programDeliveryChannel, lifetime.signal);
    ctx.effect(() => () => lifetime.abort(), 'devkit/runtime-pack-delivery');`
    }
    ${gameProjectionSource}
    const inspection = {
      list: () => ({ reads: Array.from(gameProjectionDefinitions.entries()).filter(([, entry]) => entry.kind === 'read').map(([id]) => id) }),
      read: async (id: string) => {
        const entry = gameProjectionDefinitions.get(id);
        if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
        return entry.definition.read();
      },
    };
    if (import.meta.env.DEV) {
      globalThis.__forgeaxGameInspection = inspection;
      ctx.effect(() => () => {
        if (globalThis.__forgeaxGameInspection === inspection) delete globalThis.__forgeaxGameInspection;
        gameProjectionDefinitions.clear();
      }, 'devkit/source-inspection');
    }
    ctx.provide('gameHost', {
      ...(ctx.executionBootstrapHost.canvas === undefined ? {} : { canvas: ctx.executionBootstrapHost.canvas }),
      drawingBufferSize: () => ctx.executionBootstrapHost.drawingBufferSize(),
      assets: ctx.assets,
      ...(ctx.executionBootstrapHost.port === undefined ? {} : { port: ctx.executionBootstrapHost.port }),
      app: { world: ctx.world, assets: ctx.assets },
      ...(import.meta.env.DEV ? { gameProjection } : {}),
      setPointerLockAllowed: (allowed) => ctx.executionBootstrapHost.setPointerLockAllowed(allowed),
    } satisfies GameHost);
  },
};
  const runtimePacks = await createRuntimePackOptions(runtimeBinding.scopeId${target === 'tauri' ? '' : ', () => prepareDelivery()'});
  const pluginPrograms = createPrograms(crypto.randomUUID(), 'engine-worker', ${sessionGeneration}, runtimePacks.programHost);
  return {
    ssrIdentity: ${JSON.stringify(ssrIdentity)},
    ${
      appOptions.standardProfile === undefined
        ? ''
        : `configureRenderer(renderer) {
      const result = renderer.setProfile(${JSON.stringify(appOptions.standardProfile)});
      if (!result.ok) throw result.error;
    },`
    }
    runtimePacks: { ...runtimePacks, programHost: pluginPrograms.programHost ?? runtimePacks.programHost },
    features: [vfx.feature],
    plugins: [audioPlugin(), skinningPlugin(), vfx.plugin, bridge],
    pluginPrograms,
    ...(root === null || ${JSON.stringify(bootstrapRoot === 'resource-bootstrap')} ? {} : {
      root: { guid: root },
    }),
  };
}
`;
}

function pipelineLibraryImports(options: DevKitAppOptions): string {
  return `${options.pipelineLibrary === undefined ? '' : "import pipelineLibraryUrl from './pipeline-library.json?url';\n"}${options.backgroundPipelineLibrary === undefined ? '' : "import backgroundPipelineLibraryUrl from './background-pipeline-library.json?url';\n"}${options.pipelineLibrary === undefined && options.backgroundPipelineLibrary === undefined ? '' : "import { decodeDocumentText } from '@forgeax/engine/codec';\n"}`;
}

function pipelineLibraryOptions(options: DevKitAppOptions): string {
  return `${options.pipelineLibrary === undefined ? '' : 'pipelineLibrary,'}${options.backgroundPipelineLibrary === undefined ? '' : '...(backgroundPipelineLibrary === undefined ? {} : { backgroundPipelineLibrary }),'} `;
}

/** Generated startup-cover binding to the Engine load progress model (see App README). */
function startupProgressSource(appOptions: DevKitAppOptions): string {
  return `// The startup cover renders the Engine load progress model from navigation start.
const startupCover = bootstrapRoot === 'project-bootstrap' && recipeValue === null ? globalThis.__forgeaxStartup : undefined;
let finishStartupFrame;
if (startupCover?.progress !== undefined) {
  beginLoadSession('startup', ENGINE_STARTUP_PHASES, { startedAt: 0 });
  addLoadWork('engine-code', { total: 1, done: 1 });
  const loadingLabels = resolveLoadProgressLabels(${JSON.stringify(appOptions.loadingLabels ?? null)} ?? undefined);
  const stopStartupProgress = subscribeLoadProgress((snapshot) => startupCover.progress(describeLoadProgress(snapshot, loadingLabels)));
  startupCover.onEntered?.(() => {
    finishStartupFrame?.();
    stopStartupProgress();
    endLoadSession('startup');
  });
}
`;
}

function renderTaskYieldSource(value: DevKitAppOptions['renderTaskYield']): string {
  return JSON.stringify(value ?? 'none');
}

function hostSource(
  facts: ProjectFacts,
  bootstrapRoot: BootstrapRoot,
  canonicalEnvironmentGuid?: string,
  binding?: DevKitHostBinding,
  rhiCaptureEnabled = false,
  devMode = false,
  initialAssembly: HostAssembly = createHostAssembly(),
  ssrIdentity?: SsrAdmissionIdentity,
  previewRhiWindow = false,
  animation: AnimationPlaybackOptions = {},
  target: BuildOptions['target'] = 'browser',
  appOptions: DevKitAppOptions = {},
  materialProfile?: BuildOptions['materialProfile'],
): string {
  const boundRoot =
    binding?.workspace?.execution === 'game'
      ? undefined
      : (binding?.frontendAssembly ?? binding?.backend.assembly.current)?.root;
  const plugins =
    bootstrapRoot === 'resource-bootstrap'
      ? []
      : [`webAudioPlugin(mainAudio)`, `audioPlugin()`, `skinningPlugin()`];
  const startupTimeout =
    facts.startupTimeoutMs === undefined
      ? `(import.meta.env.DEV ? ${DEV_EXECUTION_TIMEOUT_MS} : ${PRODUCTION_EXECUTION_TIMEOUT_MS})`
      : JSON.stringify(facts.startupTimeoutMs);
  return `${pipelineLibraryImports(appOptions)}import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createProfiler } from '@forgeax/engine/profiler';
import { activateExecutionRoot, addLoadWork, assembleAssetRuntime, beginLoadSession, beginLoadWork, describeLoadProgress, endLoadSession, ENGINE_STARTUP_PHASES, resolveLoadProgressLabels, subscribeLoadProgress, assembleRuntimePacks, captureEngineWorkspaceAssetBinding, createTextureWorkspacePreview, createWorkspaceMeshDisplay, createWorkspaceMaterialPreview, engineWorkspaceBrowserPlugin, engineWorkspaceInputPlugin, engineWorkspaceResultService, createToolPreviewHost, createToolPreviewRecipe, fitToolPreviewCameraToAabb, gameHostPlugin, loadEngineWorkspaceMaterialSlots, projectEngineWorkspaceAssets, replayToolPreviewCapture, type App } from '@forgeax/engine/app';
import { createApp, syncCanvasDrawingBuffer } from '@forgeax/engine/app/browser';
import { DEFAULT_WEBGPU_STUB_PROFILE } from '@forgeax/engine/rhi-webgpu';
import { inspectUi } from '@forgeax/engine/ui';
import { Context, startNativePlugin } from '@forgeax/engine/plugin';
import { ShaderRegistry } from '@forgeax/engine/shader';
import { textureViewSource } from '@forgeax/engine/preview';
import { createRuntimePackOptions${target === 'tauri' ? '' : ', serveRuntimePackDelivery'} } from './runtime-packs';
import { createGameVfx } from './game-vfx';
import { root as engineRoot, createPrograms as enginePrograms } from 'virtual:forgeax/plugin-programs/engine';
import { root as hostRoot, rootDescriptor as hostDescriptor, createPrograms as hostPrograms } from 'virtual:forgeax/plugin-programs/frontend';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { AssetRegistry, createCatalogSource, createCatalogHotSubscription } from '@forgeax/engine/assets-runtime';
import {
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from 'virtual:forgeax/pack-runtime';
import { createFrontendHost } from '@forgeax/engine/host/frontend';
import { createBrowserFrontendPlatform, createFrontendPlatformPlugin } from '@forgeax/engine/host/platform';
import { createHostAssembly, canonicalHostJson } from '@forgeax/engine/host/protocol';
import { HOST_ASSEMBLY_SERVICE, HOST_ASSEMBLY_CHANGED_TOPIC } from '@forgeax/engine/host/transport';
import { audioPlugin } from '@forgeax/engine/audio';
import { createHostAudioConsumer, WebAudioEngine, webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { physicsComponentsPlugin } from '@forgeax/engine/physics';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { mat4 } from '@forgeax/engine/math';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight, SkyboxBackground, TONEMAP_REINHARD_EXTENDED, materialSampledTextureBudget } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { numMipLevels, type SceneAsset } from '@forgeax/engine/types';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
${
  previewRhiWindow && !rhiCaptureEnabled
    ? `import { attachRecorder } from '@forgeax/engine/rhi-debug';
import { uploadTape } from '@forgeax/engine/rhi-debug/browser';
import { subscribeBrowserFrameSubmitted } from '@forgeax/engine/app';
import { RhiError } from '@forgeax/engine/rhi';
import { err } from '@forgeax/engine/types';`
    : ''
}

const initialAssembly = createHostAssembly({ ...${JSON.stringify(initialAssembly)},
  ...(hostDescriptor === null ? {} : { root: hostDescriptor }) });
const hostContext = new Context();
${
  binding?.frontendModule?.prepare
    ? `const preparedFrontendModule = await import(${JSON.stringify(binding.frontendModule.specifier)});
const preparedFrontend = await startNativePlugin(hostContext, preparedFrontendModule[${JSON.stringify(binding.frontendModule.prepare)}], initialAssembly.root?.config, { timeoutMs: ${startupTimeout} });
if (!preparedFrontend.ok) throw preparedFrontend.error;`
    : ''
}
const preparedPlatform = hostContext.get('frontendPlatform', false);
const frontendPlatform = preparedPlatform ?? createBrowserFrontendPlatform();
const location = frontendPlatform.window.location;
const bootstrapRoot = ${JSON.stringify(bootstrapRoot)};
const canonicalEnvironmentGuid = ${JSON.stringify(canonicalEnvironmentGuid ?? null)};
const query = new URLSearchParams(location.search);
const isolateVfxViewGraph = query.get('forgeax-vfx-view-graph') !== 'monolithic';
const vfxInstanceArenas = query.get('forgeax-vfx-instance-arena') !== 'individual';
const vfxNativePlanning = query.get('forgeax-vfx-planning') !== 'raw';
const vfxRetainedResources = query.get('forgeax-vfx-resources') !== 'declarations';
const resourceValue = query.get('forgeax-resource-preview');
const resource = resourceValue === null ? undefined : JSON.parse(resourceValue);
const executionWorkers = ${JSON.stringify(bootstrapRoot === 'resource-bootstrap' || binding !== undefined ? null : environmentExecutionWorkers())};
const animation = ${JSON.stringify(animation)};
const workerExecution = executionWorkers !== null;
const previewCameraEntities = new WeakMap();
const previewCameraTargets = new WeakMap();
let vfxRuntimeHost;
function ensureVfxRuntimeHost() {
  if (vfxRuntimeHost !== undefined) return vfxRuntimeHost;
  vfxRuntimeHost = makeVfxRuntimeHost();
  return vfxRuntimeHost;
}
function makeVfxRuntimeHost() {
  return createVfxRuntimeHost({
    instanceArenas: vfxInstanceArenas,
    nativePlanning: vfxNativePlanning,
    retainedResources: vfxRetainedResources,
    ...(isolateVfxViewGraph ? { isolateViewGraph: true } : {}),
    camera: {
      read(world) {
        const cameraEntity = previewCameraEntities.get(world);
        if (cameraEntity === undefined) return undefined;
        const transform = world.get(cameraEntity, Transform);
        const camera = world.get(cameraEntity, Camera);
        if (!transform.ok || !camera.ok) return undefined;
        const position = new Float32Array(transform.value.pos);
        const target = previewCameraTargets.get(world) ?? [0, 0, 0];
        return {
          position,
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), camera.value.fov, camera.value.aspect, camera.value.near, camera.value.far), mat4.lookAt(mat4.create(), position, target, [0, 1, 0])),
        };
      },
    },
  });
}
${
  previewRhiWindow && !rhiCaptureEnabled
    ? `async function previewRhiDiagnostic(context, canvas, targetId) {
  const controller = new AbortController();
  const backend = typeof navigator !== 'undefined' && navigator.gpu !== undefined
    ? await import('@forgeax/engine/rhi-webgpu')
    : await import('@forgeax/engine/rhi-wgpu');
  if ('ensureReady' in backend) await backend.ensureReady();
  const attached = attachRecorder(backend);
  if (!attached.ok) throw attached.error;
  const attachment = attached.value;
  let disposed = false;
  let worldIdentity;
  const observation = { targetId, seed: 'omitted', evidence: 'commands-and-bindings', status: 'attached', mapping: 'partial', frames: [] };
  const publish = () => { if (!disposed) { try { canvas.dataset.forgeaxPreviewRhiWindow = JSON.stringify(observation); } catch {} } };
  const remove = subscribeBrowserFrameSubmitted(canvas, (submitted) => {
    if (observation.frames.length >= 4) return;
    const receipt = submitted.receipt;
    const previous = observation.frames.at(-1);
    const valid = receipt !== undefined && worldIdentity !== undefined && submitted.worldIdentity === worldIdentity &&
      receipt.frameId === submitted.frameId && receipt.deviceGeneration === submitted.deviceGeneration &&
      (previous === undefined ? submitted.frameId === 1 : (submitted.frameId === previous.frameId + 1 && submitted.deviceGeneration === previous.deviceGeneration));
    const row = { tapeFrameIndex: observation.frames.length, frameId: submitted.frameId, deviceGeneration: submitted.deviceGeneration,
      worldIdentity: submitted.worldIdentity, presentation: receipt?.presentation, identityValid: valid,
      completion: receipt === undefined ? 'unavailable' : 'pending' };
    observation.frames.push(row);
    observation.mapping = observation.frames.length === 4 && observation.frames.every((frame) => frame.identityValid) ? 'complete' : 'partial';
    publish();
    if (receipt === undefined) return;
    void receipt.completed.then((result) => {
      row.completion = result.ok ? 'fulfilled' : 'error';
      publish();
    }, () => { row.completion = 'rejected'; publish(); });
  });
  context.effect(() => async () => {
    disposed = true;
    controller.abort();
    remove();
    const result = await attachment.dispose();
    if (!result.ok) throw result.error;
  }, 'devkit/preview-rhi-window');
  publish();
  return {
    options: { rhi: attachment.backend.rhi, rhiInstrumentation: {
      resolveSurfaceDevice(device) {
        const resolved = attachment.backend.unwrapDeviceForSurface(device);
        return resolved.ok ? resolved : err(new RhiError({ code: 'rhi-not-available',
          expected: 'The preview recorder resolves its surface device', hint: resolved.error.hint }));
      },
      onFrameBoundary() { void attachment.frameBoundary(); },
      onDeviceLost() { observation.mapping = 'partial'; attachment.deviceLost(); publish(); },
    } },
    async arm(world) {
      worldIdentity = world;
      observation.worldIdentity = world;
      observation.status = 'seeding'; publish();
      const capture = attachment.captureFrames(4, { seed: { maxResourceBytes: 0 }, signal: controller.signal });
      void capture.then(async (result) => {
        if (!result.ok) { observation.status = 'capture-error'; observation.error = result.error; publish(); return; }
        observation.status = 'uploading'; publish();
        const uploaded = await uploadTape(result.value, { signal: controller.signal });
        observation.status = uploaded.ok ? 'uploaded' : 'upload-error';
        if (uploaded.ok) observation.artifact = uploaded.value;
        else observation.error = uploaded.error;
        publish();
      }).catch((cause) => { observation.status = 'capture-error'; observation.error = String(cause); publish(); });
      const seeded = await attachment.frameBoundary();
      if (!seeded.ok) throw seeded.error;
      if (observation.status === 'seeding' && !controller.signal.aborted) observation.status = 'recording';
      publish();
    },
  };
}
`
    : ''
}
const previewVfxHosts = new WeakMap();
if (resource?.kind === 'vfx') ensureVfxRuntimeHost();

${previewVfxBoundsSource}

const canvas = document.querySelector('#app');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('forgeax: missing canvas');
let latestFrameSubmission;
let latestTextureObservation;
canvas.addEventListener('forgeax:frame-submitted', (event) => {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  if (
    detail !== null &&
    typeof detail === 'object' &&
    Number.isSafeInteger(detail.frameId) &&
    Number.isSafeInteger(detail.deviceGeneration)
  ) {
    const frame = {
      frameId: detail.frameId,
      deviceGeneration: detail.deviceGeneration,
    };
    latestFrameSubmission = {
      ...frame,
      ...(detail.receipt?.completed === undefined ? {} : { completed: detail.receipt.completed }),
    };
    // Lock the renderer-owned binding projection at the submit boundary. A
    // later inspect() may already describe another frame or a replaced World;
    // resource observation must never pair those facts with this receipt.
    const currentApp = preparedResourceOwner?.app ?? appState.current;
    latestTextureObservation =
      currentApp?.renderer === undefined ||
      typeof currentApp.renderer.inspect !== 'function'
        ? undefined
        : textureRendererObservation(currentApp.renderer.inspect(), preparedResourceOwner?.binding, frame);
  }
});
// Publish the exact canvas + game UI container to frontend plugins.
// Presentation, reparenting, visibility and restoration belong to its consumer.
const engineWorkspaceSurface = canvas.parentElement ?? canvas;
const resizeCanvas = () => syncCanvasDrawingBuffer(canvas);
const resizeObserver = new ResizeObserver(resizeCanvas);
if (!workerExecution) {
  resizeObserver.observe(canvas);
  resizeCanvas();
}
const runtimeScopeBinding = runtimeBinding;
if (runtimeScopeBinding === undefined) {
  throw new Error('forgeax: Vite Pack runtime binding is required in the generated host');
}
const assetCatalog = createCatalogSource({
  url: import.meta.env.DEV
    ? runtimeScopeBinding.catalogUrl
    : new URL('pack-index.json', document.baseURI).href,
  ...(import.meta.env.DEV ? { expectedScope: runtimeScopeBinding, subscribe: createCatalogHotSubscription(import.meta.hot) } : {}),
});
const bundlerAdapter = forgeaxBundlerAdapter();
const bundler = {
  ...bundlerAdapter,
  // Resolve page-relative deployment URLs before crossing into nested Workers.
  shaderManifestUrl: new URL(bundlerAdapter.shaderManifestUrl, location.href).href,
  ...(import.meta.env.DEV
    ? { importTransport: createRuntimeAssetImportTransport(runtimeScopeBinding) }
    : {}),
};
const assetPreparation = new WeakMap();

function prepareAssetRegistry(assets) {
  const existing = assetPreparation.get(assets);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    // The App/Host asset provider already owns source configuration, including
    // admitted runtime publications. Preparation only joins its current Catalog.
    const catalog = await assets.enumerateCatalog();
    if (!catalog.ok) throw catalog.error;
  })();
  assetPreparation.set(assets, pending);
  return pending;
}

function previewStable(value) {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer:' + JSON.stringify(Array.from(new Uint8Array(value)));
  if (ArrayBuffer.isView(value)) return value.constructor.name + ':' + JSON.stringify(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  if (Array.isArray(value)) return '[' + value.map(previewStable).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + previewStable(record[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

async function previewDigest(value) {
  const bytes = new TextEncoder().encode(previewStable(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function textureDimensions(payload) {
  const extent = payload?.shape?.extent;
  const width = extent?.width;
  const height = extent?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('TextureAsset shape.extent must provide positive width and height');
  }
  return [width, height];
}

function textureMipCount(payload) {
  const mips = payload?.mips;
  if (mips?.kind === 'packed') {
    if (!Number.isSafeInteger(mips.levelCount) || mips.levelCount <= 0) {
      throw new Error('TextureAsset packed mips must provide a positive levelCount');
    }
    return mips.levelCount;
  }
  if (mips?.kind !== 'generate') return 1;
  const [width, height] = textureDimensions(payload);
  const depth = payload?.shape?.viewDimension === '3d' ? payload.shape.extent.depth : 1;
  return numMipLevels({ width, height }, Number.isSafeInteger(depth) && depth > 0 ? depth : 1);
}

function texturePayloadClass(payload) {
  const data = payload?.data;
  const bytes =
    data instanceof Uint8Array || data instanceof Uint8ClampedArray
      ? Array.from(data)
      : Array.isArray(data) && data.every((value) => typeof value === 'number')
        ? data
        : undefined;
  if (bytes === undefined || bytes.length === 0) return undefined;
  const format = String(payload?.format ?? '').toLowerCase();
  const singleChannel = format.startsWith('r') && !format.startsWith('rg');
  if (bytes.every((value) => value === 0)) return 'black';
  if (singleChannel) return 'single-channel';
  if (format.startsWith('rgba') || format.startsWith('bgra')) {
    const alpha = bytes.filter((_, index) => (index + 1) % 4 === 0);
    if (alpha.length > 0 && alpha.every((value) => value === 0)) return 'transparent';
  }
  return 'color';
}

function selectedMaterialPass(payload) {
  const passes = Array.isArray(payload?.passes) ? payload.passes : [];
  return passes.find((pass) => {
    const tags = pass?.renderState?.tags;
    const mode = tags?.LightMode ?? pass?.name;
    return !/shadow|depth/i.test(String(mode));
  }) ?? passes[0];
}

function textureRendererObservation(inspection, expected, frame) {
  const inspectedFrame = inspection?.frame;
  if (
    frame === undefined ||
    inspectedFrame?.frameId !== frame.frameId ||
    inspectedFrame?.deviceGeneration !== frame.deviceGeneration
  ) {
    return { rendererTextureResident: false, textureHandleCount: 0 };
  }
  const bindings = Array.isArray(inspection?.meshMaterialBindings)
    ? inspection.meshMaterialBindings
    : [];
  const selectedBinding =
    expected === undefined
      ? undefined
      : bindings.find(
          (binding) =>
            binding.entityKey === expected.entityKey &&
            (expected.worldIdentity === undefined ||
              binding.worldIdentity === expected.worldIdentity),
        );
  const selectedMaterialIndex =
    selectedBinding === undefined || expected?.materialHandle === undefined
      ? -1
      : selectedBinding.bindings.findIndex((binding) => binding.handle === expected.materialHandle);
  const selectedResidency =
    selectedMaterialIndex >= 0 ? selectedBinding?.residency[selectedMaterialIndex] : undefined;
  const selectedTexture =
    selectedResidency === undefined || expected?.textureHandle === undefined
      ? undefined
      : selectedResidency.textures.find((texture) => texture.handle === expected.textureHandle);
  const resident =
    selectedResidency !== undefined &&
    (selectedResidency.readiness === 'ready' || selectedResidency.readiness === 'last-known-good') &&
    selectedTexture !== undefined;
  return {
    rendererTextureResident: resident,
    textureHandleCount: selectedResidency?.textures.length ?? 0,
  };
}

async function previewOwnerFacts(assets, resource, payload, textureBudget) {
  if (resource.kind === 'material') {
    const primaryPass = selectedMaterialPass(payload);
    const program = primaryPass?.program?.module;
    const pass = primaryPass?.name;
    return {
      ...(textureBudget === undefined
        ? {}
        : {
            sampledTextureLimit: textureBudget.limit,
            sampledTextureRequired: textureBudget.required,
            sampledTextureTransmission: textureBudget.transmission,
            sampledTextureConflicts: textureBudget.conflicts.join(','),
          }),
      subjectDigest: await previewDigest(payload),
      bindingsDigest: await previewDigest(payload.passes),
      closureDigest: await previewDigest(payload.values ?? payload.passes),
      ...(typeof program === 'string' ? { program } : {}),
      ...(typeof pass === 'string' ? { pass } : {}),
    };
  }
  if (resource.kind === 'mesh') {
    return {
      subjectDigest: await previewDigest(payload),
      vertexDigest: await previewDigest(payload.vertices),
      indexDigest: await previewDigest(payload.indices ?? []),
      submeshDigest: await previewDigest(payload.submeshes),
      aabbDigest: await previewDigest(payload.aabb),
    };
  }
  if (resource.kind === 'texture') {
    const [width, height] = textureDimensions(payload);
    const mipCount = textureMipCount(payload);
    const filter = 'linear';
    const payloadClass = texturePayloadClass(payload);
    return {
      subjectDigest: await previewDigest(payload),
      boundDigest: await previewDigest({ width, height, format: payload.format }),
      uvDigest: await previewDigest({ offset: [0, 0], scale: [1, 1], rotation: 0 }),
      bindingDigest: await previewDigest({ format: payload.format, colorSpace: payload.colorSpace, filter, mipCount }),
      format: payload.format,
      colorSpace: payload.colorSpace,
      filter,
      mipCount,
      dimensions: [width, height],
      ...(payloadClass === undefined ? {} : { payloadClass }),
    };
  }
  return undefined;
}

${gameProjectionSource}
// Development play advance: pause, step whole frames of explicit game time
// (yielding only while a frame credit is in flight), then resume. No input is
// synthesized; the input sampled at each stepped frame is whatever is held.
// Unless render is true, every frame but the last runs the World update only.
async function advanceGameTime(app, { seconds, stepSeconds, timeoutMs, render = false }) {
  if (!import.meta.env.DEV) return { ok: false, frames: 0, error: 'advance runs only on a development host' };
  const frames = Math.ceil(seconds / stepSeconds - 1e-9);
  const deadline = performance.now() + timeoutMs;
  const channel = new MessageChannel();
  const yieldTask = () => new Promise((resolve) => { channel.port1.onmessage = resolve; channel.port2.postMessage(0); });
  const paused = app.pause().ok;
  let stepped = 0;
  try {
    while (stepped < frames) {
      const delta = Math.min(stepSeconds, seconds - stepped * stepSeconds);
      const result = app.stepFrame(delta, { render: render || stepped === frames - 1 });
      if (result.ok) { stepped += 1; continue; }
      if (result.error.detail?.reason !== 'credit' || performance.now() > deadline)
        return { ok: false, frames: stepped, error: result.error.code + ' ' + JSON.stringify(result.error.detail) };
      await yieldTask();
    }
    return { ok: true, frames: stepped };
  } finally {
    channel.port1.close();
    if (paused) app.resume();
  }
}
function exposeGameInspection(app) {
  const rendererErrors = trackRendererErrors(app, import.meta.env.DEV);
  const inspection = {
    advance: request => advanceGameTime(app, request),
    ui: request => inspectUi(globalThis.__forgeaxGameInspection === inspection && appState.current === app ? document.body : undefined, request),
    list() {
      return {
        reads: Array.from(gameProjectionDefinitions.entries())
          .filter(([, entry]) => entry.kind === 'read')
          .map(([id]) => id),
      };
    },
    async read(id) {
      const entry = gameProjectionDefinitions.get(id);
      if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
      return entry.definition.read();
    },
    renderer() {
      const inspection = app.renderer.inspect();
      return {
        state: inspection.state,
        frameId: inspection.frame.frameId,
        frame: inspection.frame,
        capabilities: inspection.capabilities,
        limits: inspection.limits,
        execution: app.execution.report(),
        lastError: app.lastError,
        rendererError: rendererErrors.read(),
      };
    },
  };
  globalThis.__forgeaxGameInspection = inspection;
}
// Renderer failures (GPU validation, submit, device loss) leave the game loop
// and DOM HUD running while the canvas stops presenting. Keep the latest one
// with its frame and count for capture/play, and log each distinct one once
// as a warning: capture/play judge it by recency, not as a browser error.
// The root cause is the innermost coded detail.cause (a Render Worker error
// arrives inside app-system-update-failed, a GPU error inside
// device-operation-failed); App-level errors are not renderer errors.
function rendererErrorSource(error) {
  let source;
  for (let entry = error, depth = 0; entry !== null && typeof entry === 'object' && depth < 8; entry = entry.detail?.cause, depth += 1)
    if (typeof entry.code === 'string' && !entry.code.startsWith('app-')) source = entry;
  return source;
}
function trackRendererErrors(app, log) {
  let latest = null;
  let count = 0;
  const logged = new Set();
  const completed = () => app.execution.report().frame.completed;
  const unsubscribe = app.onError((error) => {
    const source = rendererErrorSource(error);
    if (source === undefined) return;
    count += 1;
    latest = { code: source.code, message: String(source.hint ?? source.message ?? '').slice(0, 2000), frame: completed() };
    const key = latest.code + ' ' + latest.message;
    if (!log || logged.has(key) || logged.size >= 16) return;
    logged.add(key);
    console.warn('[forgeax] renderer error ' + latest.code + ' at frame ' + latest.frame + ': ' + latest.message + ' (logged once; __forgeaxGameInspection.renderer().rendererError counts repeats)');
  });
  return {
    read: () => latest === null ? null : { ...latest, framesAgo: Math.max(0, completed() - latest.frame), count },
    unsubscribe,
  };
}

let preparedResourceOwner;
${resourcePresentationSource}

async function prepareProject(app) {
await prepareAssetRegistry(app.assets);
if (resource === undefined) return;
preparedResourceOwner = await prepareResourcePreview(app, resource);
return preparedResourceOwner.facts;
}
const gpuPassTiming = query.get('forgeax-gpu-pass-timing') === '1' ? {} : undefined;
const shadowWorkload = query.get('forgeax-shadow-workload') === '1' ? true : undefined;
const geometryLane = query.get('forgeax-geometry-lane') === 'direct' ? 'direct' : undefined;
const featureReadOnlyDepthBatchDiagnostic = (() => {
  const values = query.getAll('forgeax-feature-read-only-depth-batch');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || (values[0] !== '0' && values[0] !== '1'))
    throw new Error('Read-only depth batching diagnostic requires exactly one 0 or 1');
  return values[0] === '1';
})();
const gbufferBatchOrderDiagnostic = (() => {
  const order = query.get('forgeax-gbuffer-order');
  const encoded = query.get('forgeax-gbuffer-program-digests');
  if (order === null && encoded === null) return undefined;
  if ((order !== 'near' && order !== 'far') || encoded === null)
    throw new Error('GBuffer ordering diagnostic requires near/far order and audited program digests');
  const programDigests = JSON.parse(encoded);
  if (!Array.isArray(programDigests) || programDigests.length > 128 ||
      !programDigests.every(digest => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)))
    throw new Error('GBuffer ordering diagnostic program digests must be SHA-256 values');
  return { order, programDigests };
})();
const renderTaskYield = query.get('forgeax-render-task-yield') === 'features' ? 'features' : query.get('forgeax-render-task-yield') === 'completion' ? 'completion' : query.get('forgeax-render-task-yield') === 'none' ? 'none' : ${renderTaskYieldSource(appOptions.renderTaskYield)};
const renderPipelineCapacity = query.get('forgeax-render-pipeline-capacity') === '4' ? 4 : query.get('forgeax-render-pipeline-capacity') === '3' ? 3 : query.get('forgeax-render-pipeline-capacity') === '2' ? 2 : ${JSON.stringify(appOptions.renderPipelineCapacity ?? 3)};
const dynamicGeometryMeshBudgetBytes = query.has('forgeax-dynamic-mesh-budget-bytes')
  ? Number(query.get('forgeax-dynamic-mesh-budget-bytes')) : ${JSON.stringify(appOptions.dynamicGeometryMeshBudgetBytes)};
const cpuProfileRequested = query.get('forgeax-cpu-profile') === '1';
const rhiCaptureRequested =
  query.get('forgeax-rhi-capture') === '1' || ${JSON.stringify(rhiCaptureEnabled)};
// CPU-only diagnostics on hosts without a usable GPU: keep the WebGPU path, drop GPU work.
const gpuStub = query.get('forgeax-gpu-stub') === '1' ? DEFAULT_WEBGPU_STUB_PROFILE : undefined;
// A profiler is an inert, bounded capability until a caller starts a capture.
// Create it in both live execution placements so the persistent CLI can inspect the
// actual realm; the Worker receives only the structured diagnostics switches.
const profiler = ${JSON.stringify(devMode)} || cpuProfileRequested ? createProfiler() : undefined;
const workspaceTarget = query.has('forgeaxWorkspace') && !workerExecution && bootstrapRoot === 'project-bootstrap';
const workspaceGame = workspaceTarget && query.get('forgeaxWorkspace') === 'game';
const workspaceMode = workspaceTarget && !workspaceGame;
const recipeValue = query.get('forgeax-tool-recipe');
${startupProgressSource(appOptions)}const snapshotValue = query.get('forgeax-tool-snapshot');
const runIdValue = query.get('forgeax-tool-run-id');
const appState: { current?: App | import('@forgeax/engine/app').ExecutionApp } = {};
let disposeFrontendHost;
let activateGameHost: (() => Promise<void>) | undefined;
let removeStartupErrorListener;
let removeStartupInputBinding;
let activateWorkspace;
const notifyWorkspacePageLost =
  workspaceTarget
    ? () => {
        if (hostTransport === undefined) return;
        void hostTransport
          .request(engineWorkspaceResultService(query.get('forgeaxWorkspaceTarget')), {
            kind: 'lost',
            id: 'page-lost:' + (query.get('forgeaxWorkspaceSession') ?? 'forgeax-workspace-session'),
            sessionId: query.get('forgeaxWorkspaceSession') ?? 'forgeax-workspace-session',
            targetId: query.get('forgeaxWorkspaceTarget') ?? 'forgeax-workspace-target',
          })
          .catch(() => {});
      }
    : undefined;
const appBootstrapPlugin = {
  name: 'forgeax:generated-app-bootstrap',
  inject: workspaceGame ? ['engineWorkspaceInput'] : [],
  async apply(ctx) {
    const ownsPageLifecycle =
      bootstrapRoot !== 'resource-bootstrap' && resource === undefined && recipeValue === null;
    let pageHidden = false;
    ctx.effect(() => {
      const onPageHide = () => {
        pageHidden = true;
        notifyWorkspacePageLost?.();
        resizeObserver.disconnect();
        if (disposeFrontendHost !== undefined) void disposeFrontendHost();
        else void appState.current?.dispose();
      };
      if (ownsPageLifecycle) window.addEventListener('pagehide', onPageHide, { once: true });
      return () => {
        if (ownsPageLifecycle) window.removeEventListener('pagehide', onPageHide);
      };
    }, 'devkit/generated-page-lifecycle');
    const pointerLockAllowed =
      query.has('forgeaxCapture') || recipeValue !== null ? () => false : undefined;
    let touchControls = window.matchMedia('(pointer: coarse)').matches;
    const controlModeListeners = new Set<() => void>();
    const controlMode: NonNullable<import('@forgeax/engine/app').GameHost['controlMode']> = {
      read: () => document.pointerLockElement === canvas ? 'pointer-locked' : touchControls ? 'touch' : 'pointer',
      subscribe: listener => {
        controlModeListeners.add(listener);
        return () => { controlModeListeners.delete(listener); };
      },
    };
    ctx.effect(() => {
      const notify = () => { for (const listener of controlModeListeners) listener(); };
      const pointer = (event: PointerEvent) => {
        if (event.pointerType !== 'touch' && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
        const next = event.pointerType === 'touch';
        if (next === touchControls) return;
        touchControls = next;
        notify();
      };
      // Observe the real input modality across both the canvas and authored UI.
      // Pointer acquisition and gameplay state remain in their existing owners.
      document.addEventListener('pointerdown', pointer, { capture: true });
      document.addEventListener('pointerlockchange', notify);
      return () => {
        document.removeEventListener('pointerdown', pointer, { capture: true });
        document.removeEventListener('pointerlockchange', notify);
        controlModeListeners.clear();
      };
    }, 'devkit/game-control-mode');
    if (profiler !== undefined) ctx.provide('profiler', profiler);
    ${
      target === 'tauri'
        ? ''
        : `const programDeliveryChannel = workerExecution ? crypto.randomUUID() : undefined;
    if (programDeliveryChannel !== undefined)
      ctx.effect(() => serveRuntimePackDelivery(programDeliveryChannel), 'devkit/runtime-pack-delivery');`
    }
    const gameChannel = workerExecution || (bootstrapRoot === 'project-bootstrap' && !workspaceMode)
      ? new MessageChannel() : undefined;
    if (gameChannel !== undefined) {
      ctx.effect(() => () => {
        gameChannel.port1.close();
        // Covers failure before handoff; App closes the Engine end after handoff.
        gameChannel.port2.close();
      }, 'devkit/game-channel');
    }
    ${
      appOptions.backgroundPipelineLibrary === undefined
        ? ''
        : `// Compiled after renderer readiness. Its fetch overlaps startup, and a
    // failure only leaves those pipelines to compile on first use.
    const backgroundPipelineLibraryLoad = fetch(backgroundPipelineLibraryUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error('Background pipeline library load failed: ' + response.status);
        const text = await decodeDocumentText(new Uint8Array(await response.arrayBuffer()));
        if (!text.ok) throw new Error('Background pipeline library decode failed: ' + text.error.code);
        return JSON.parse(text.value);
      })
      .catch((cause) => {
        console.warn('[forgeax] background pipeline library unavailable', cause);
        return undefined;
      });`
    }
    const runtimePacks = workerExecution ? undefined : await createRuntimePackOptions(runtimeScopeBinding.scopeId${target === 'tauri' ? '' : ", undefined, ctx.get('frontendPlatform', false)?.createPackProgramHost"});
    const pluginPrograms = workerExecution ? undefined : enginePrograms(crypto.randomUUID(), 'engine-main', initialAssembly.sessionGeneration, runtimePacks.programHost);
    const gameVfx = !workerExecution && bootstrapRoot === 'project-bootstrap' && !workspaceMode && resource === undefined && recipeValue === null
      ? createGameVfx({ isolateViewGraph: isolateVfxViewGraph, instanceArenas: vfxInstanceArenas, nativePlanning: vfxNativePlanning, retainedResources: vfxRetainedResources }) : undefined;
    let hostAudio: ReturnType<typeof createHostAudioConsumer> | undefined;
    const mainAudio = workerExecution || bootstrapRoot === 'resource-bootstrap' ? undefined : new WebAudioEngine();
    ${
      appOptions.pipelineLibrary === undefined
        ? ''
        : `const finishPipelineLibraryRead = beginLoadWork('downloads', 'pipeline-library.json');
    const pipelineLibraryResponse = await fetch(pipelineLibraryUrl);
    if (!pipelineLibraryResponse.ok) throw new Error('Pipeline library load failed: ' + pipelineLibraryResponse.status);
    const pipelineLibraryBytes = new Uint8Array(await pipelineLibraryResponse.arrayBuffer());
    finishPipelineLibraryRead();
    const pipelineLibraryText = await decodeDocumentText(pipelineLibraryBytes);
    if (!pipelineLibraryText.ok) throw new Error('Pipeline library decode failed: ' + pipelineLibraryText.error.code);
    const pipelineLibrary = JSON.parse(pipelineLibraryText.value);`
    }
    ${appOptions.backgroundPipelineLibrary === undefined ? '' : 'const backgroundPipelineLibrary = await backgroundPipelineLibraryLoad;'}
    const result = await createApp(
      canvas,
      workerExecution
        ? {
            uiRoot: document.querySelector('#game-ui') ?? document.body,
            animation,
            dynamicGeometryMeshBudgetBytes,
            ${appOptions.assetBudgetBytes === undefined ? '' : `assetBudgetBytes: ${JSON.stringify(appOptions.assetBudgetBytes)},`}
            ${appOptions.time === undefined ? '' : `time: ${JSON.stringify(appOptions.time)},`}
            ${pipelineLibraryOptions(appOptions)}
            execution: {
              createHostAudio: () => {
                hostAudio = (ctx.get('executionHostAudioFactory') ?? createHostAudioConsumer)();
                return hostAudio;
              },
              workers: executionWorkers,
              bootstrapData: ${target === 'tauri' ? '{ isolateVfxViewGraph, vfxInstanceArenas, vfxNativePlanning, vfxRetainedResources }' : '{ programDeliveryChannel, isolateVfxViewGraph, vfxInstanceArenas, vfxNativePlanning, vfxRetainedResources }'},
              ...(gameChannel === undefined ? {} : { bootstrapPort: gameChannel.port2 }),
              frameTimeoutMs: ${facts.frameTimeoutMs === undefined ? 'undefined' : JSON.stringify(facts.frameTimeoutMs)},
              // Development includes cold Vite compilation before the native Worker handshake.
              startupTimeoutMs: ${startupTimeout},
              bootstrap: new URL(
                import.meta.env.DEV ? './execution-bootstrap.ts' : './execution-bootstrap.js',
                import.meta.url,
              ),
              assetCatalog: {
                url: import.meta.env.DEV
                  ? runtimeScopeBinding.catalogUrl
                  : new URL('pack-index.json', document.baseURI).href,
                ...(import.meta.env.DEV
                  ? { expectedScope: runtimeScopeBinding, runtimeBinding: runtimeScopeBinding }
                  : {}),
              },
              diagnostics: {
                profiler: import.meta.env.DEV || cpuProfileRequested,
                rhiCapture: rhiCaptureRequested,
                ...(gpuPassTiming === undefined ? {} : { gpuPassTiming }),
                ...(shadowWorkload === undefined ? {} : { shadowWorkload }),
                ...(geometryLane === undefined ? {} : { geometryLane }),
                ...(gbufferBatchOrderDiagnostic === undefined ? {} : { gbufferBatchOrderDiagnostic }),
                ...(featureReadOnlyDepthBatchDiagnostic === undefined ? {} : { featureReadOnlyDepthBatchDiagnostic }),
                renderTaskYield,
                renderPipelineCapacity,
              },
            },
            ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
            ...(gpuStub === undefined ? {} : { gpuStub }),
          }
        : {
            uiRoot: document.querySelector('#game-ui') ?? document.body,
            animation,
            dynamicGeometryMeshBudgetBytes,
            ${appOptions.assetBudgetBytes === undefined ? '' : `assetBudgetBytes: ${JSON.stringify(appOptions.assetBudgetBytes)},`}
            ${appOptions.time === undefined ? '' : `time: ${JSON.stringify(appOptions.time)},`}
            ${pipelineLibraryOptions(appOptions)}
            standardProfile: ${JSON.stringify(appOptions.standardProfile)},
            context: ctx.root,
            ${ssrIdentity === undefined ? '' : `ssrIdentity: ${JSON.stringify(ssrIdentity)},`}
            assetCatalog,
            pluginPrograms,
            runtimePacks: { ...runtimePacks, programHost: pluginPrograms.programHost ?? runtimePacks.programHost },
            gpuPassTiming,
            ...(shadowWorkload === undefined ? {} : { shadowWorkload }),
            profiler,
            ...(workspaceGame ? { input: ctx.engineWorkspaceInput.game } : {}),
            plugins: [${plugins.join(', ')}${plugins.length > 0 ? ', ' : ''}...(workspaceMode ? [physicsComponentsPlugin()] : []), ...(gameVfx === undefined ? [] : [gameVfx.plugin])],
            ...(workspaceMode ? { features: [ensureVfxRuntimeHost().feature] } : gameVfx === undefined ? {} : { features: [gameVfx.feature] }),
            ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
            ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
            ...(gpuStub === undefined ? {} : { gpuStub }),
          },
      workerExecution ? { ...bundler, importTransport: undefined } : bundler,
    );
    if (!result.ok) throw result.error;
    const app = result.value;
    if (!workerExecution && (gbufferBatchOrderDiagnostic !== undefined || featureReadOnlyDepthBatchDiagnostic !== undefined)) {
      const selected = app.renderer.setProfile({ ...app.renderer.inspect().profile, ...(gbufferBatchOrderDiagnostic === undefined ? {} : { gbufferBatchOrderDiagnostic }), ...(featureReadOnlyDepthBatchDiagnostic === undefined ? {} : { featureReadOnlyDepthBatchDiagnostic }) });
      if (!selected.ok) throw selected.error;
    }
    appState.current = app;
    ctx.effect(() => async () => {
      (await app.dispose()).unwrap();
      if (appState.current === app) appState.current = undefined;
    }, 'devkit/generated-app-resource');
    ${materialBuildCapabilityGuard(materialProfile)}
    // Engine plugins can apply before createApp completes. A page that left
    // during startup must release this late App before publishing more services.
    if (pageHidden) throw new Error('forgeax: page left during App startup');
    if (workerExecution) {
      // DOM plugins load POD assets through the same catalog without a GPU or
      // a second World. Host UI never downloads the renderer shader manifest.
      const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }), importTransport: bundler.importTransport });
      // assembleAssetRuntime installs the page catalog source; a second source would
      // download and parse the complete catalog again.
      const assembly = assembleAssetRuntime(assets, [], {
        ownsRegistry: true,
        catalogSource: assetCatalog,
        ...(import.meta.env.DEV ? { runtimeBinding: runtimeScopeBinding } : {}),
      });
      if (!assembly.ok) { await app.dispose(); throw assembly.error; }
      const uiRoot = document.querySelector('#game-ui');
      ctx.provide('assets', assets);
      const host = {
        app, assets,
        get audio() { return hostAudio?.engine; },
        ...(gameChannel === undefined ? {} : { port: gameChannel.port1 }),
        get canvas() { return ('canvas' in app ? app.canvas : undefined) ?? canvas; },
        drawingBufferSize: () => {
          const current = ('canvas' in app ? app.canvas : undefined) ?? canvas;
          return { width: current.width, height: current.height };
        },
        uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
        controlMode,
        setPointerLockAllowed: (allowed: boolean) => app.input?.setPointerLockAllowed?.(allowed),
      } satisfies import('@forgeax/engine/app').GameHost;
      ctx.provide('gameHost', host);
      ctx.effect(() => () => assembly.value.dispose(), 'devkit/host-assets');
      if (import.meta.env.DEV || cpuProfileRequested || ${JSON.stringify(target === 'tauri')}) {
        const localInspection = globalThis.__forgeaxGameInspection;
        const sourceRead = (method: 'list' | 'read', id?: string) => app.remoteEval === undefined
          ? localInspection?.[method](id)
          : app.remoteEval('globalThis.__forgeaxGameInspection.' + method + '(' + (id === undefined ? '' : JSON.stringify(id)) + ')');
        const inspection = {
          advance: request => advanceGameTime(app, request),
          ui: request => inspectUi(globalThis.__forgeaxGameInspection === inspection && appState.current === app ? document.body : undefined, request),
          list: () => import.meta.env.DEV ? sourceRead('list') : { reads: [] },
          read: (id: string) => sourceRead('read', id),
          renderer: () => {
            const execution = app.execution.report();
            const local = 'renderer' in app ? app.renderer.inspect() : undefined;
            return { state: execution.render?.state ?? local?.state ?? (execution.engine.health === 'running' ? 'alive' : execution.engine.health), frameId: execution.render?.completedFrame ?? execution.frame.completed, ...(local === undefined ? {} : { frame: local.frame }), execution, lastError: app.lastError, rendererError: rendererErrors.read() };
          },
        };
        const rendererErrors = trackRendererErrors(app, import.meta.env.DEV);
        globalThis.__forgeaxGameInspection = inspection;
        ctx.effect(() => () => {
          rendererErrors.unsubscribe();
          if (globalThis.__forgeaxGameInspection === inspection) delete globalThis.__forgeaxGameInspection;
        }, 'devkit/host-inspection');
      }
    }
    if (workspaceTarget) {
      activateWorkspace = async () => {
        if (hostTransport === undefined || workerExecution) throw new Error('Workspace requires its main-realm Host transport');
        const extent = (name, fallback) => { const value = Number(query.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : fallback; };
        const fiber = await ctx.plugin(engineWorkspaceBrowserPlugin, {
          app, canvas, surface: engineWorkspaceSurface, transport: hostTransport,
          ...(workspaceMode ? { createPreviewApp: async ({ context, canvas: previewCanvas, asset, targetId }) => {
            const vfx = asset.kind === 'vfx' ? makeVfxRuntimeHost() : undefined;
            ${previewRhiWindow && !rhiCaptureEnabled ? "const diagnostic = ['mesh', 'texture', 'equirect'].includes(asset.kind) ? await previewRhiDiagnostic(context, previewCanvas, targetId) : undefined;" : ''}
            const created = await createApp(previewCanvas, {
              context, assetCatalog: app.pluginContext.get('runtimePacks')?.catalog ?? assetCatalog, plugins: [physicsComponentsPlugin()],
              ${previewRhiWindow && !rhiCaptureEnabled ? '...diagnostic?.options,' : ''}
              ...(vfx ? { features: [vfx.feature] } : {}),
              ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
              pointerLockAllowed: () => false,
            }, bundler);
            if (!created.ok) throw created.error;
            ${previewRhiWindow && !rhiCaptureEnabled ? 'if (diagnostic !== undefined) await diagnostic.arm(created.value.world.identity);' : ''}
            if (vfx) previewVfxHosts.set(created.value, vfx);
            return created.value;
          } } : {}),
          ...(workspaceGame ? { input: ctx.engineWorkspaceInput } : {}),
          project: { id: ${JSON.stringify(facts.id)}, root: ${JSON.stringify(facts.root)}, name: ${JSON.stringify(facts.name)}, assetRoots: ${JSON.stringify(facts.assetRoots)} },
          target: {
            sessionId: query.get('forgeaxWorkspaceSession'), targetId: query.get('forgeaxWorkspaceTarget'),
            worldId: app.world.identity, headed: query.get('forgeaxWorkspaceHeaded') !== '0',
            width: extent('forgeaxWorkspaceWidth', 1280), height: extent('forgeaxWorkspaceHeight', 720), url: (() => { const value = new URL(location.href); value.searchParams.delete(${JSON.stringify(LIVE_BRIDGE_OWNER_PARAM)}); return value.href; })(),
          },
          openResourcePreview: async ({ app: previewApp, asset, canvas: previewCanvas }) => {
            const owner = await prepareResourcePreview(previewApp, { kind: asset.kind, guid: asset.guid }, previewCanvas);
            return { close: owner.close, assetBinding: owner.assetBinding, ...(owner.material === undefined ? {} : { material: owner.material }), ...(owner.texture === undefined ? {} : { texture: owner.texture }), ...(owner.display === undefined ? {} : { display: owner.display }) };
          },
        });
        await fiber.await();
      };
    }
    if (bootstrapRoot === 'project-bootstrap' && recipeValue === null && (!workspaceTarget || workspaceGame)) {
      const startup = globalThis.__forgeaxStartup;
      startup?.bindSession?.(app.execution.report().world.identity);
      removeStartupErrorListener = app.onError((error) => {
        // A refused pointer lock leaves the game running unlocked and the next
        // trusted click retries it; only unrecoverable errors stop the game.
        if (error.code === 'app-pointer-lock-failed') {
          console.warn(error);
          return;
        }
        startup?.fail?.(error, app.execution.report());
      });
      removeStartupInputBinding = startup?.bindInput?.((enabled) => {
        app.input?.setInputAllowed?.(enabled);
        if (!enabled) app.input?.clear?.();
      });
    }
    if (workspaceMode) await activateWorkspace?.();
    if ((import.meta.env.DEV || cpuProfileRequested || ${JSON.stringify(target === 'tauri')}) && !workerExecution) exposeGameInspection(app as App);
    let gameHostFiber;
    let engineRootFiber;
    ctx.effect(
      () => {
        return async () => {
          resizeObserver.disconnect();
          await engineRootFiber?.dispose();
          await gameHostFiber?.dispose();
          removeStartupErrorListener?.();
          removeStartupErrorListener = undefined;
          removeStartupInputBinding?.();
          removeStartupInputBinding = undefined;
        };
      },
      'devkit/generated-app',
    );
    if (
      bootstrapRoot !== 'resource-bootstrap' &&
      !workerExecution &&
      !workspaceMode
    ) {
      activateGameHost = async () => {
        const assets = app.assets;
        await prepareAssetRegistry(assets);
        if (assets === undefined) throw new Error('forgeax: generated App did not provide assets');
        const uiRoot = document.querySelector('#game-ui');
        gameHostFiber = await ctx.root.plugin(gameHostPlugin({
          app,
          assets,
          canvas,
          renderer: app.renderer,
          ...(mainAudio === undefined ? {} : { audio: mainAudio }),
          drawingBufferSize: () => ({ width: canvas.width, height: canvas.height }),
          ...(gameChannel === undefined ? {} : { port: gameChannel.port2, presentationPort: gameChannel.port1 }),
          uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
          controlMode,
          setPointerLockAllowed: (allowed) => app.input?.setPointerLockAllowed?.(allowed),
          startupTimeoutMs: ${startupTimeout},
          ...(import.meta.env.DEV ? { gameProjection } : {}),
        }));
        if (engineRoot !== null) {
          const mounted = await activateExecutionRoot(ctx, {
            guid: engineRoot,
          }, { timeoutMs: ${startupTimeout} });
          engineRootFiber = mounted.fiber;
        }
      };
    }
  },
};
let removeWorkspaceAssemblySubscription;
const hostLifecyclePlugin = {
  name: 'forgeax:generated-host-lifecycle',
  apply(ctx) {
    ctx.effect(
      () => async () => {
        // Release the borrowed connection and the separately prepared platform Fiber.
        removeWorkspaceAssemblySubscription?.();
        await hostTransport?.close('generated frontend host disposed');
        if (${JSON.stringify(target === 'tauri')} && globalThis.__forgeaxTauriDispose === disposeFrontendHost) delete globalThis.__forgeaxTauriDispose;
        ${binding?.frontendModule?.prepare ? 'await preparedFrontend.value.dispose();' : ''}
      },
      'devkit/generated-host-lifecycle',
    );
  },
};
const hostTransport = import.meta.env.DEV
  ? await (frontendPlatform.connectHost)(
      (() => {
        const hostUrl = new URL(
          (location.protocol === 'https:' ? 'wss:' : 'ws:') +
            '//' + location.host + '/__forgeax/host',
        );
        if (workspaceTarget) {
          const session = query.get('forgeaxWorkspaceSession');
          const target = query.get('forgeaxWorkspaceTarget');
          const token = query.get('forgeaxWorkspaceToken');
          if (session !== null) hostUrl.searchParams.set('forgeaxWorkspaceSession', session);
          if (target !== null) hostUrl.searchParams.set('forgeaxWorkspaceTarget', target);
          if (token !== null) hostUrl.searchParams.set('forgeaxWorkspaceToken', token);
        }
        return hostUrl.href;
      })(),
    )
  : undefined;
const frontendHost = await createFrontendHost({
  context: hostContext,
  startupTimeoutMs: ${startupTimeout},
  startupPlugins: [...(preparedPlatform ? [] : [createFrontendPlatformPlugin(frontendPlatform)]), hostLifecyclePlugin, ...(workspaceGame ? [{ name: 'forgeax:workspace-input-bootstrap', async apply(ctx) { const fiber = ctx.plugin(engineWorkspaceInputPlugin, { canvas }); await fiber.await(); } }] : []), ...(workspaceMode ? [] : [appBootstrapPlugin])],
  assembly: initialAssembly,
  activateRoot: async (ctx, descriptor, signal, startupTimeoutMs) => {
    ${
      boundRoot
        ? `if (canonicalHostJson(descriptor) === canonicalHostJson(${JSON.stringify(boundRoot)})) {
      const module = await import(${JSON.stringify(binding?.frontendModule?.specifier)});
      const plugin = module[${JSON.stringify(binding?.frontendModule?.export ?? 'default')}];
      ${binding?.frontendModule?.prepare ? `if (plugin === preparedFrontendModule[${JSON.stringify(binding.frontendModule.prepare)}]) return { fiber: preparedFrontend.value, dispose: () => preparedFrontend.value.dispose() };` : ''}
      if (!ctx.registry.resolve(plugin)) throw new Error('external frontend module is missing its selected native plugin export');
      const started = await startNativePlugin(ctx, plugin, descriptor.config, {
        signal,
        timeoutMs: startupTimeoutMs,
      });
      if (!started.ok) throw started.error;
      return { fiber: started.value, dispose: () => started.value.dispose() };
    }`
        : ''
    }
    if (hostRoot === null || canonicalHostJson(descriptor) !== canonicalHostJson(hostDescriptor)) throw new Error('host root/program snapshot mismatch');
    const scope = ctx.isolate('assets').isolate('pluginPrograms').isolate('runtimePacks');
    const provider = scope.plugin({ provide: ['assets', 'pluginPrograms', 'runtimePacks'], async apply(ctx) {
      const assembly = assembleAssetRuntime(new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) }), [], { catalogSource: assetCatalog, ownsRegistry: true }).unwrap();
      ctx.effect(() => () => assembly.dispose());
      const options = await createRuntimePackOptions(runtimeScopeBinding.scopeId${target === 'tauri' ? '' : ", undefined, ctx.get('frontendPlatform', false)?.createPackProgramHost"});
      const pluginPrograms = hostPrograms(crypto.randomUUID(), 'frontend', initialAssembly.sessionGeneration, options.programHost);
      ctx.provide('pluginPrograms', pluginPrograms);
      const runtimePacks = assembleRuntimePacks(ctx, assembly, { ...options, programHost: pluginPrograms.programHost ?? options.programHost });
      ctx.provide('runtimePacks', runtimePacks);
      const reader = new AssetRegistry({ catalog: runtimePacks.catalog, fetcher: runtimePacks.fetcher, scopeId: runtimeScopeBinding.scopeId });
      ctx.provide('assets', reader);
      ctx.effect(() => () => reader.dispose());
    } });
    await provider.await();
    return activateExecutionRoot(scope, {
      guid: hostRoot,
    }, { signal, timeoutMs: startupTimeoutMs });
  },
  ...(hostTransport === undefined ? {} : { transport: hostTransport }),
  autoActivate: false,
});
disposeFrontendHost = () => frontendHost.dispose();
if (${JSON.stringify(target === 'tauri')}) globalThis.__forgeaxTauriDispose = disposeFrontendHost;
if (workspaceMode) {
  // UI and connection plugins activate independently of the optional renderer.
  await frontendHost.activate();
  const appFiber = hostContext.plugin(appBootstrapPlugin);
  try {
    await appFiber.await();
  } catch (error) {
    await appFiber.dispose();
    globalThis.__forgeaxStartup?.fail?.(error);
    await hostTransport?.request(engineWorkspaceResultService(query.get('forgeaxWorkspaceTarget')), {
      kind: 'failed', id: 'workspace-bootstrap-failed',
      sessionId: query.get('forgeaxWorkspaceSession'), targetId: query.get('forgeaxWorkspaceTarget'),
      error: { code: error?.code ?? 'engine-workspace-bootstrap-failed', expected: error?.expected ?? 'the workspace renderer to initialize', hint: error?.hint ?? String(error), detail: error?.detail ?? {} },
    });
  }
}
const app = appState.current;
let appStarted = false;
if (app !== undefined) {
try {
  if (app === undefined) throw new Error('forgeax: generated App bootstrap did not complete');
  await activateGameHost?.();
  if (!workspaceMode && bootstrapRoot !== 'resource-bootstrap') {
    // The Engine realm and its plugins are ready when createApp returns. Open
    // frame credit before Host plugins load runtime assets so their async
    // startup can never depend on a frame that this activation is withholding.
    app.start().unwrap();
    appStarted = true;
    await frontendHost.activate();
  }
  const pluginProjectionBridge = globalThis.__forgeaxPluginProjection;
  if (pluginProjectionBridge !== undefined) {
    pluginProjectionBridge.current = { inspect() {
      const live = frontendHost.assembly.inspection;
      return { desired: initialAssembly.root ? [initialAssembly.root] : [], live, entries: live, liveState: 'attached' };
    } };
  }
} catch (error) {
  if (appStarted) app.stop();
  await frontendHost.dispose().catch(() => {});
  throw error;
}

// The backend remains the assembly authority after the initial workspace boot.
// Its workspace bridge publishes only workspace-safe project entries.
if (workspaceMode && hostTransport !== undefined) {
  let queue = Promise.resolve();
  const applyWorkspaceAssembly = (assembly) => {
    queue = queue.then(async () => {
      if (assembly.revision !== frontendHost.assembly.current.revision) {
        await frontendHost.update(assembly);
      }
    }).catch((error) => hostTransport.close(error));
    return queue;
  };
  removeWorkspaceAssemblySubscription = hostTransport.subscribe(HOST_ASSEMBLY_CHANGED_TOPIC, applyWorkspaceAssembly);
  await applyWorkspaceAssembly(await hostTransport.request(HOST_ASSEMBLY_SERVICE, undefined));
}

// A workspace App stays stopped until its first preview is instantiated. This
// avoids running a camera-less frame loop between page readiness and the
// user's first asset selection; the selected SceneAsset (or resource owner)
// supplies the observation camera before any frame is submitted.

if (query.has('forgeax-tool-replay')) {
  globalThis.__forgeaxToolReplayHost = {
    ready: true,
    async run(capture) {
      const result = await replayToolPreviewCapture(capture);
      return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
    },
  };
} else if (recipeValue !== null) {
  const previewRecipe = createToolPreviewRecipe(JSON.parse(recipeValue));
  const host = await createToolPreviewHost({
    ...(runIdValue === null ? {} : { runId: runIdValue }),
    recipe: previewRecipe,
    snapshot: JSON.parse(snapshotValue ?? 'null'),
    ...(resource === undefined ? {} : { resource }),
    canvas,
    app: {
      plugins: [${plugins.join(', ')}],
      ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
      ...(vfxRuntimeHost === undefined ? {} : { features: [vfxRuntimeHost.feature] }),
    },
    bundler,
    prepare: prepareProject,
    async collectResourceFacts(app, current) {
      if (current === undefined) return current;
      if (resource?.kind !== 'vfx') {
        if (resource?.kind === 'material' || resource?.kind === 'mesh' || resource?.kind === 'texture') {
          if (resource.kind === 'mesh') {
            const asset = current.asset;
            const aabb = asset?.aabb;
            const submeshes = asset?.submeshes;
            const materialSlots = asset?.materialSlots;
            if (!Array.isArray(aabb) || aabb.length !== 6 || !Array.isArray(submeshes) || !Array.isArray(materialSlots)) {
              return current;
            }
            return {
              ...current,
              observation: {
                ...current.ownerFacts,
                aabb,
                submeshCount: submeshes.length,
                materialSlotCount: materialSlots.length,
              },
            };
          }
          if (resource.kind === 'texture') {
            let textureObservation = latestTextureObservation ?? {
              rendererTextureResident: false,
              textureHandleCount: 0,
            };
            const completion = latestFrameSubmission?.completed;
            if (completion === undefined) {
              textureObservation = { rendererTextureResident: false, textureHandleCount: 0 };
            } else {
              try {
                const completed = await completion;
                if (completed?.ok !== true) {
                  textureObservation = { rendererTextureResident: false, textureHandleCount: 0 };
                }
              } catch {
                textureObservation = { rendererTextureResident: false, textureHandleCount: 0 };
              }
            }
            return {
              ...current,
              observation: {
                ...current.ownerFacts,
                ...textureObservation,
              },
            };
          }
          return {
            ...current,
            observation: current.ownerFacts,
          };
        }
        return current;
      }
      if (vfxRuntimeHost === undefined) return current;
      const hostInspection = vfxRuntimeHost.inspect(app.world);
      const player = hostInspection?.players.find(
        (candidate) => candidate.assetGuid.toLowerCase() === resource.guid.toLowerCase(),
      );
      const renderObservation = vfxRuntimeHost.feature.inspect();
      if (player === undefined || renderObservation.frameNumber < 0) {
        return current;
      }
      const bounds = previewVfxBounds(current.asset);
      if (bounds === undefined) return current;
      const emitterDigest = JSON.stringify(player.emitters.map(({ id, module, capacity }) => ({ id, module, capacity })));
      const sampleDigest = JSON.stringify(player.emitters.map(({ id, schedule }) => ({ id, schedule })));
      const boundsDigest = JSON.stringify(player.emitters.map(({ id, bounds: emitterBounds }) => ({ id, bounds: emitterBounds })));
      const computeDigest = player.programFingerprint;
      const indirectDigest = JSON.stringify(player.emitters.map(({ id, renderers }) => ({ id, renderers: renderers.map(({ kind, enabled }) => ({ kind, enabled })) })));
      return {
        ...current,
        observation: {
          subjectDigest: current.asset.programFingerprint,
          programFingerprint: player.programFingerprint,
          emitterDigest,
          sampleDigest,
          boundsDigest,
          computeDigest,
          indirectDigest,
          authoredBounds: bounds.aabb,
          seed: player.seed,
          fixedDelta: player.fixedDelta,
          timelineFrames: previewRecipe.frames,
          dispatches: renderObservation.dispatches,
          indirectDraws: renderObservation.indirectDraws,
          subjectOutputs: renderObservation.subjectOutputs,
        },
      };
    },
    onDispose: async () => {
      const owner = preparedResourceOwner;
      preparedResourceOwner = undefined;
      await owner?.close?.();
    },
    executeAction(action) {
      return !globalThis.dispatchEvent(new CustomEvent('forgeax-tool-action', {
        detail: action,
        cancelable: true,
      }));
    },
  });
  if (!host.ok) {
    globalThis.__forgeaxStartup?.fail?.(host.error);
    globalThis.__forgeaxToolHost = {
      ready: true,
      capture: async () => ({ ok: false, error: host.error }),
      run: async () => ({ ok: false, error: host.error }),
      dispose: async () => undefined,
    };
  } else {
    globalThis.__forgeaxToolHost = {
      ready: true,
      async capture() {
        const result = await host.value.capture();
        return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
      },
      async run() {
        const result = await host.value.run();
        return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
      },
      dispose: () => host.value.dispose(),
    };
    window.addEventListener('pagehide', () => void host.value.dispose(), { once: true });
  }
} else if (!workspaceMode) {
  if (bootstrapRoot === 'project-bootstrap' && recipeValue === null) {
    (
      globalThis as typeof globalThis & {
        __forgeaxStartup?: { readonly prepare?: () => void };
      }
    ).__forgeaxStartup?.prepare?.();
    finishStartupFrame = beginLoadWork('first-frame');
  }
  if (workspaceGame) await activateWorkspace?.();
  if (!appStarted) app.start().unwrap();
  if (query.has('forgeaxCapture')) {
    document.documentElement.dataset.forgeaxCaptureReady = 'true';
  }
}
}
`;
}

function htmlSource(
  title: string,
  startupScreen = true,
  labels: LoadProgressLabels = DEFAULT_LOAD_PROGRESS_LABELS,
): string {
  return hostStartupDocument(title, labels).replace(
    '  </body>',
    `    <script>${hostStartupScript(startupScreen, 'undefined', labels)}</script>
    <script>
      (() => {
        // This inert marker keeps generated pages inspectable by older hosts
        // that only parse the fatal diagnostic hook.
        const startupFailureText = 'ForgeaX game failed to start.\\n' + 'Unable to start the game.';
        void startupFailureText;
      })();
    </script>
    <script type="module">
      try {
        await import('./main.ts');
      } catch (error) {
        globalThis.__forgeaxStartup?.fail?.(error);
      }
    </script>
  </body>`,
  );
}

export async function materializeViteDevPort(port: number): Promise<number> {
  if (port !== 0) return port;
  const reservation = createNetServer();
  await once(reservation.listen(0, '127.0.0.1'), 'listening');
  const address = reservation.address();
  const assigned = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    reservation.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (assigned === 0) throw new Error('OS did not assign an ephemeral preview port');
  return assigned;
}

/** Await one build command; producer plugins retain their own lifecycle owners. */
export async function buildProject(
  options: BuildOptions = {},
  initialSources?: PluginSourceInventory,
): Promise<CommandResult<unknown>> {
  const previous = process.cwd();
  try {
    const facts = await readProjectFacts(options.root);
    if (!facts.ok) return facts;
    const base = options.base ?? (options.target === 'tauri' ? './' : '/');
    const outDir = resolve(facts.value.root, options.outDir ?? 'dist');
    process.chdir(facts.value.root);
    // Cooking is command work, not readiness of a persistent Host service.
    // Await the actual operation and its producer cleanup before returning.
    await viteBuild(
      await createViteConfig(facts.value, 'build', base, {
        outDir,
        ...(initialSources === undefined ? {} : { initialSources }),
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.animation === undefined ? {} : { animation: options.animation }),
        ...(options.sourcemap === undefined ? {} : { sourcemap: options.sourcemap }),
        ...(options.materialProfile === undefined
          ? {}
          : { materialProfile: options.materialProfile }),
      }),
    );
    if (options.target === 'wechat') await writeWechatProject(facts.value, options, outDir);
    if (options.target === 'tauri') await writeTauriProject(facts.value, outDir);
    const manifest = await writeDistManifest(
      facts.value,
      base,
      outDir,
      options.target,
      options.materialProfile,
    );
    if (options.target === 'wechat') await verifyWechatPackageBudget(outDir);
    return { ok: true, value: manifest };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-build-failed') };
  } finally {
    process.chdir(previous);
  }
}

/** Start the Vite development service under one backend Host business plugin. */
export async function startDevProjectWithHost(
  options: ProjectCommandOptions & {
    /**
     * A stable serving root and Vite dependency cache for an owner that runs one
     * server at a time (the live dev owner's sequential project children). The
     * unchanged dependency hash keeps optimized module URLs, and so a retained
     * browser's HTTP cache, valid across replacements.
     */
    readonly reuse?: { readonly generatedRoot: string; readonly viteCacheDir: string };
  } = {},
  observeInputs?: (paths: readonly string[]) => void,
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let started = false;
  let host: BackendHost | undefined;
  try {
    const startupPolicy = await readProjectStartupTimeoutMs(options.root);
    if (!startupPolicy.ok) return startupPolicy;
    host = await createBackendHost({
      startupTimeoutMs:
        startupPolicy.value === undefined ? DEV_PREPARATION_TIMEOUT_MS : startupPolicy.value,
      startupPlugins: [
        {
          name: 'forgeax:devkit-dev-server',
          async apply(ctx) {
            const facts = await readProjectFacts(options.root);
            if (!facts.ok) {
              result = facts;
              return;
            }
            const previous = process.cwd();
            let changedDirectory = false;
            let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
            let closed = false;
            const closeServer = async (): Promise<void> => {
              if (closed) return;
              closed = true;
              await server?.close();
              if (changedDirectory) process.chdir(previous);
            };
            try {
              const port = resolveProjectPort(options.port);
              const vitePort = {
                ...port,
                host: '127.0.0.1' as const,
                port: await materializeViteDevPort(port.port),
              };
              process.chdir(facts.value.root);
              changedDirectory = true;
              const config = await createViteConfig(facts.value, 'serve', '/', {
                server: vitePort,
                ...(options.reuse === undefined
                  ? {}
                  : { generatedRoot: options.reuse.generatedRoot }),
              });
              server = await createViteServer(
                options.reuse === undefined
                  ? config
                  : { ...config, cacheDir: options.reuse.viteCacheDir },
              );
              // Vite invokes configureServer before listen but does not wait
              // for async producer work started by that hook. The Pack plugin
              // owns the accepted Catalog/DDC generation; fence the dev host
              // on that owner before exposing a URL to the live browser. This
              // prevents a slow software adapter from observing the raw scan
              // (Catalog row present, Pack body absent) during cold startup.
              const packPlugin = server.config.plugins.find(
                (plugin) => plugin.name === 'forgeax:pack',
              ) as { readonly ready?: () => Promise<void> } | undefined;
              await packPlugin?.ready?.();
              ctx.effect(() => closeServer, 'devkit/dev-server');
              await server.listen(vitePort.port);
              const projectSession = server.config.plugins.find(
                (plugin) => plugin.name === 'forgeax:project-session',
              ) as (Plugin & { inputPaths(): readonly string[] }) | undefined;
              if (projectSession) observeInputs?.(projectSession.inputPaths());
              if (options.json !== true) server.printUrls();
              result = {
                ok: true,
                value: {
                  root: facts.value.root,
                  urls: server.resolvedUrls,
                  mode: 'dev',
                  serves: 'source',
                  capabilities: {
                    'rhi.capture': {
                      available: false,
                      realm: 'host',
                      reason: 'standalone-dev-server-has-no-live-app-cli-attachment',
                    },
                  },
                },
              };
              started = true;
            } catch (cause) {
              await closeServer().catch(() => {});
              result = { ok: false, error: commandError(cause, 'dev-server-failed') };
            }
          },
        },
      ],
    });
    const finalResult =
      result ??
      ({
        ok: false,
        error: {
          code: 'dev-server-failed',
          expected: 'the DevKit development plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      } satisfies CommandResult<unknown>);
    if (started) activeDevKitHosts.add(host);
    else await host.dispose();
    return finalResult;
  } catch (cause) {
    await host?.dispose();
    return { ok: false, error: commandError(cause, 'dev-server-failed') };
  }
}

/** Start static dist preview under one DevKit plugin and verify its manifest first. */
export async function startPreviewProjectWithHost(
  options: PreviewOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let started = false;
  let host: BackendHost | undefined;
  try {
    const startupPolicy = await readProjectStartupTimeoutMs(options.root);
    if (!startupPolicy.ok) return startupPolicy;
    host = await createBackendHost({
      startupTimeoutMs:
        startupPolicy.value === undefined ? DEV_PREPARATION_TIMEOUT_MS : startupPolicy.value,
      startupPlugins: [
        {
          name: 'forgeax:devkit-preview-server',
          async apply(ctx) {
            const root = resolve(options.root ?? process.cwd());
            const distRoot = resolve(root, options.dist ?? 'dist');
            const verified = await verifyDist(distRoot);
            if (!verified.ok) {
              result = verified;
              return;
            }
            if (verified.value.target !== undefined && verified.value.target !== 'browser') {
              result = {
                ok: false,
                error: {
                  code: 'preview-target-unavailable',
                  expected: 'a browser distribution for the HTTP preview server',
                  hint:
                    verified.value.target === 'wechat'
                      ? 'Open the built WeChat project in WeChat Developer Tools.'
                      : 'Run the Tauri project in the output directory.',
                  detail: { target: verified.value.target },
                },
              };
              return;
            }
            try {
              const port = resolveProjectPort(options.port);
              const server = await vitePreview({
                root,
                configFile: false,
                base: verified.value.base,
                plugins: [await preparePreviewHttpArtifacts(distRoot, verified.value)],
                preview: {
                  open: false,
                  ...port,
                  headers: {
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                    'Cross-Origin-Resource-Policy': 'cross-origin',
                  },
                },
                build: { outDir: distRoot },
              });
              ctx.effect(() => () => server.close(), 'devkit/preview-server');
              if (options.json !== true) server.printUrls();
              result = {
                ok: true,
                value: {
                  root,
                  urls: server.resolvedUrls,
                  mode: 'preview',
                  serves: distRoot,
                  capabilities: {
                    'rhi.capture': {
                      available: false,
                      realm: 'host',
                      reason: 'static-dist-host-does-not-install-dev-capture',
                    },
                  },
                },
              };
              started = true;
            } catch (cause) {
              result = { ok: false, error: commandError(cause, 'preview-server-failed') };
            }
          },
        },
      ],
    });
    const finalResult =
      result ??
      ({
        ok: false,
        error: {
          code: 'preview-server-failed',
          expected: 'the DevKit preview plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      } satisfies CommandResult<unknown>);
    if (started) activeDevKitHosts.add(host);
    else await host.dispose();
    return finalResult;
  } catch (cause) {
    await host?.dispose();
    return { ok: false, error: commandError(cause, 'preview-server-failed') };
  }
}

/** Stage timing for Play, build progress or opted-in workspace diagnostics; silent otherwise. */
function createViteConfigTiming(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  host: DevKitHostBinding | undefined,
): (stage: string) => void {
  const startedAt = performance.now();
  let previousAt = startedAt;
  return (stage: string): void => {
    const game = host?.workspace?.execution === 'game';
    const build = command === 'build' && process.env.FORGEAX_BUILD_PROGRESS === '1';
    if (!game && !build && (process.env.FORGEAX_WORKSPACE_TIMING !== '1' || !host?.workspace))
      return;
    const now = performance.now();
    console.error(
      build ? '[forgeax.build]' : game ? '[forgeax.play]' : '[forgeax.vite-config.timing]',
      JSON.stringify({
        root: facts.root,
        targetId: host?.workspace?.targetId,
        execution: game ? 'game' : 'preview',
        stage,
        totalMs: Math.round(now - startedAt),
        stageMs: Math.round(now - previousAt),
      }),
    );
    previousAt = now;
  };
}

function addWorkspaceTimingPlugins(
  plugins: Plugin[],
  host: DevKitHostBinding | undefined,
  timing: (stage: string) => void,
): void {
  if (
    host?.workspace?.execution !== 'game' &&
    (process.env.FORGEAX_WORKSPACE_TIMING !== '1' || !host?.workspace)
  )
    return;
  plugins.unshift({
    name: 'forgeax:workspace-vite-timing-start',
    configResolved() {
      timing('vite-config-resolved');
    },
    configureServer() {
      timing('vite-configure-server-start');
    },
  });
  plugins.push({
    name: 'forgeax:workspace-vite-timing-end',
    configureServer() {
      timing('vite-configure-server-end');
    },
  });
}

// The CI browser profile keeps the normal producer and catalog contracts,
// but may defer materialization until the first real GUID request. This
// shortens cold smoke startup without changing build mode or local defaults.
// Plugin roots must be materialized before their program modules activate.
// Deferring the owning pack can create a cycle between program import and
// the first plugin-definition read. Asset-only projects keep the cheaper
// on-demand path used by browser CI.
function devPackReadinessOptions(facts: ProjectFacts): {
  readonly producerReadiness?: 'on-demand';
} {
  const hasPluginRoots = facts.roots.engine !== undefined || facts.roots.frontend !== undefined;
  return process.env.FORGEAX_DEV_PACK_READINESS === 'on-demand' && !hasPluginRoots
    ? { producerReadiness: 'on-demand' }
    : {};
}

function assertMaterialProfileTarget(
  materialProfile: BuildOptions['materialProfile'] | undefined,
  target: BuildOptions['target'] | undefined,
): void {
  if (materialProfile !== undefined && target === 'wechat')
    throw new Error('webgpu-storage validation builds require a desktop WebGPU target');
}

/**
 * The generated entry root: each serving host owns a fresh one unless its caller
 * names a stable one; build never overwrites a live page.
 */
async function createGeneratedRoot(
  projectRoot: string,
  serving: boolean,
  stable: string | undefined,
): Promise<string> {
  const generatedBase = resolve(projectRoot, '.forgeax', 'generated');
  await mkdir(generatedBase, { recursive: true });
  if (!serving) return generatedBase;
  if (stable === undefined) return await mkdtemp(resolve(generatedBase, 'serve-'));
  // A previous holder that crashed may have left files; the root starts empty.
  await rm(stable, { recursive: true, force: true });
  await mkdir(stable, { recursive: true });
  return stable;
}

function projectSourceIgnorePath(
  bootstrapRoot: BootstrapRoot,
  failedSources: ReadonlySet<string>,
): (path: string) => boolean {
  const ignoreSource =
    bootstrapRoot === 'resource-bootstrap'
      ? isResourcePreviewIgnoredPath
      : isProjectSourceIgnoredPath;
  return (path: string) => ignoreSource(path) || failedSources.has(path);
}

function createBuiltinCookers(
  roots: readonly string[],
  materialProfile: BuildOptions['materialProfile'] | undefined,
) {
  return [
    createMaterialPackCooker(
      roots,
      materialProfile === undefined ? {} : { profile: materialProfile },
    ),
    createParticleCodeNativeCookerFromRoots(roots),
  ];
}

/** Observes and digests the project's material sources so the snapshot captures them. */
async function digestMaterialSources(
  sourceSnapshot: PluginSourceInventory['sourceSnapshot'],
  projectRoot: string,
  projectRoots: readonly string[],
): Promise<void> {
  const shaderPaths = await sourceSnapshot.observePaths(projectRoot, () =>
    listMaterialSourcePaths(projectRoots),
  );
  for (const path of shaderPaths) await sourceSnapshot.digest(path);
}

/** A workspace target that previews resources rather than playing the game. */
function isWorkspacePreview(host: DevKitHostBinding | undefined): boolean {
  return host?.workspace !== undefined && host.workspace.execution !== 'game';
}

async function assertHostBindingAdmission(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  bootstrapRoot: BootstrapRoot,
  host: DevKitHostBinding | undefined,
): Promise<void> {
  if (host === undefined) return;
  if (command !== 'serve' || bootstrapRoot !== 'project-bootstrap')
    hostBindingError('host binding requires a main-thread project development server');
  validateHostBinding(host);
  const externalRoot = (host.frontendAssembly ?? host.backend.assembly.current).root;
  // Only a binding outside any workspace composes its frontend with the project's own root.
  if (host.workspace === undefined && externalRoot && facts.roots.frontend)
    hostBindingError('compose external and project frontend roots explicitly before binding');
  await host.backend.context.get('devkitBackend')?.assertCurrent();
}

async function admitInitialSourceSnapshot(
  facts: ProjectFacts,
  initialSources: PluginSourceInventory | undefined,
  metadataCache?: ScriptablePackMetadataCache,
): Promise<PluginSourceInventory['sourceSnapshot']> {
  if (initialSources === undefined) return createScriptablePackSourceSnapshot({ metadataCache });
  await assertPluginSourceInputs(initialSources, facts.root);
  return initialSources.sourceSnapshot;
}

function previewSourceFailureOptions(
  reportFailures: boolean,
  failedSources: Set<string>,
): { readonly onSourceFailure?: (path: string, error: PackError) => void } {
  if (!reportFailures) return {};
  return {
    onSourceFailure: (path: string, error: PackError) => {
      failedSources.add(path);
      process.stderr.write(`[pack-source] ${JSON.stringify({ path, error })}\n`);
    },
  };
}

/** Canonical-kit texture-view material packs, served only to resource previews. */
function textureViewMaterialPackages(
  canonicalKit: CanonicalKitLocation | undefined,
  resourcePreview: boolean,
): string[] {
  if (canonicalKit === undefined || !resourcePreview) return [];
  const textureViewRoot = resolve(canonicalKit.root, '..', '..', 'dist', 'texture-view');
  return ['2d', '2d-array', '3d'].map((dimension) =>
    resolve(textureViewRoot, `${dimension}.pack.json`),
  );
}

function packRoots(
  sourceRoots: readonly string[],
  canonicalKit: CanonicalKitLocation | undefined,
): string[] {
  return [...sourceRoots, ...(canonicalKit === undefined ? [] : [canonicalKit.root])];
}

/** A bound non-Play host composes the project assembly into its own; otherwise the project's serves. */
function servedHostAssembly(
  host: DevKitHostBinding | undefined,
  sessionGeneration = 1,
): HostAssembly {
  const projectAssembly = createHostAssembly({ sessionGeneration });
  return host && host.workspace?.execution !== 'game'
    ? composeBoundHostAssembly(host, projectAssembly)
    : projectAssembly;
}

async function resolveConsumerEngineAliases(
  projectRoot: string,
  host: DevKitHostBinding | undefined,
): Promise<readonly { readonly find: string; readonly replacement: string }[]> {
  const selectedAliases = await hostEngineAliases(projectRoot, host);
  return selectedAliases.length ? selectedAliases : await consumerEngineAliases(projectRoot);
}

function engineDedupe(aliases: readonly { readonly find: string }[]): string[] {
  return aliases.length ? aliases.map((alias) => alias.find) : ['@forgeax/engine'];
}

function writePreviewBatchEntry(generated: string): Promise<void>[] {
  return [
    writeFile(
      resolve(generated, 'preview-batch.html'),
      '<!doctype html><html><body><canvas></canvas><script type="module" src="./preview-batch.ts"></script></body></html>',
    ),
    writeFile(resolve(generated, 'preview-batch.ts'), previewBatchEntrySource()),
  ];
}

async function writePipelineLibrary(
  generated: string,
  appOptions: DevKitAppOptions,
): Promise<void> {
  await Promise.all([
    appOptions.pipelineLibrary === undefined
      ? undefined
      : writeFile(
          resolve(generated, 'pipeline-library.json'),
          JSON.stringify(appOptions.pipelineLibrary),
        ),
    appOptions.backgroundPipelineLibrary === undefined
      ? undefined
      : writeFile(
          resolve(generated, 'background-pipeline-library.json'),
          JSON.stringify(appOptions.backgroundPipelineLibrary),
        ),
  ]);
}

async function runtimePacksModuleSource(
  facts: ProjectFacts,
  sourceInventory: PluginSourceInventory,
  target: BuildOptions['target'],
): Promise<string> {
  if (target !== 'tauri') return runtimePacksSource;
  return `${await staticPackProgramsSource(facts, sourceInventory)}
import type { RuntimePackOptions } from '@forgeax/engine/app';
export async function createRuntimePackOptions(scopeId: string): Promise<RuntimePackOptions> {
  return { scopeId, imports, programHost };
}
`;
}

function assertNoBuiltinImporterOverride(importers: readonly Importer[]): void {
  const builtinImporterKeys = new Set(DEFAULT_IMPORTERS.map((importer) => importer.key));
  for (const importer of importers)
    if (builtinImporterKeys.has(importer.key))
      throw new TypeError(`duplicate builtin/project importer ${importer.key}`);
}

function previewInputsPlugin(pack: ReturnType<typeof pluginPack>): Plugin {
  let previewProducer: Promise<string> | undefined;
  return {
    name: 'forgeax:preview-inputs',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__forgeax/preview-inputs', (_request, response) => {
        previewProducer ??= previewProducerIdentity();
        void previewProducer.then(
          (producer) => {
            response.setHeader('Content-Type', 'application/json');
            response.setHeader('Cache-Control', 'no-store');
            response.end(
              JSON.stringify({
                producer,
                catalog: encodeCatalogWire(pack.catalogSnapshot()),
              }),
            );
          },
          (cause) => {
            response.statusCode = 500;
            response.end(JSON.stringify({ error: String(cause) }));
          },
        );
      });
    },
  };
}

function projectSourceWatchPlugin(projectWatchPaths: readonly string[]): Plugin {
  let injectedWatchDependencies: string[] = [];
  return {
    name: 'forgeax:project-source-watch',
    enforce: 'pre' as const,
    configResolved(config: ResolvedConfig) {
      const existing = new Set(config.configFileDependencies);
      injectedWatchDependencies = projectWatchPaths.filter((path) => !existing.has(path));
      config.configFileDependencies.push(...injectedWatchDependencies);
    },
    configureServer(server: ViteDevServer) {
      // Vite constructs its watcher from configFileDependencies before configureServer.
      // Keep project sources out of Vite's later config-restart classification so their
      // edits reach the project-session HMR owner below.
      const temporary = new Set(injectedWatchDependencies);
      const dependencies = server.config.configFileDependencies;
      for (let index = dependencies.length - 1; index >= 0; index--)
        if (temporary.has(dependencies[index] ?? '')) dependencies.splice(index, 1);
      injectedWatchDependencies = [];
    },
  };
}

function generatedHostOwnerPlugin(generated: string): Plugin {
  // Vite creates the replacement server before closing the old one during restart.
  let generatedServers = 0;
  return {
    name: 'forgeax:generated-host-owner',
    configureServer() {
      generatedServers += 1;
    },
    // Every closing dev environment runs this on both close and restart. Vite's
    // native resolver can retain closed environments; release their payloads.
    // Worker sub-builds run the hook without an environment.
    closeBundle() {
      const environment = this.environment as Environment | undefined;
      if (environment?.mode === 'dev') environment.moduleGraph.invalidateAll();
    },
    // Runs once per retiring server, after its environments are torn down.
    async closeServer() {
      generatedServers -= 1;
      if (generatedServers === 0) await rm(generated, { recursive: true, force: true });
    },
  };
}

function rhiDebugPlugins(projectRoot: string): Plugin[] {
  const engineDebug = process.env.FORGEAX_ENGINE_RHI_DEBUG === '1';
  const previewWindow = process.env.FORGEAX_PREVIEW_RHI_WINDOW === '1';
  if (!engineDebug && !previewWindow) return [];
  return [
    {
      ...vitePluginRhiDebug({
        rootDir:
          previewWindow && !engineDebug
            ? (process.env.FORGEAX_EVIDENCE_DIR ?? projectRoot)
            : projectRoot,
      }),
      ...(engineDebug
        ? {}
        : {
            config: () => ({
              define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify('0') },
            }),
          }),
    } as Plugin,
  ];
}

function viteResolveOptions(
  native: boolean,
  frontendAlias: { readonly find: string; readonly replacement: string } | undefined,
  consumerAliases: readonly { readonly find: string; readonly replacement: string }[],
): NonNullable<InlineConfig['resolve']> {
  return {
    ...(native
      ? { conditions: ['forgeax-native', 'module', 'browser', 'development|production'] }
      : {}),
    alias: [...(frontendAlias === undefined ? [] : [frontendAlias]), ...consumerAliases],
    dedupe: engineDedupe(consumerAliases),
  };
}

function viteServerOptions(
  port: ProjectPortOptions | undefined,
  servedRoots: readonly string[],
  engineWorkspaceRoot: string | undefined,
  frontendAlias: { readonly find: string; readonly replacement: string } | undefined,
): NonNullable<InlineConfig['server']> {
  return {
    ...port,
    // FSEventStreamStop can block the macOS event loop during backend disposal.
    ...(process.platform === 'darwin' ? { watch: { useFsEvents: false } } : {}),
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
    fs: {
      allow: [
        ...servedRoots,
        ...(engineWorkspaceRoot === undefined ? [] : [engineWorkspaceRoot]),
        ...(frontendAlias === undefined ? [] : [dirname(frontendAlias.replacement)]),
      ],
    },
  };
}

function viteBuildOptions(
  wechat: Awaited<ReturnType<typeof prepareWechatBuild>> | undefined,
  realGeneratedRoot: string,
  projectRoot: string,
  output: { readonly sourcemap?: BuildOptions['sourcemap']; readonly outDir?: string },
): NonNullable<InlineConfig['build']> {
  return {
    // Syntax capabilities only: lower optional chains/class fields but keep native BigInt.
    target: wechat ? 'chrome70' : 'esnext',
    sourcemap: output.sourcemap ?? false,
    outDir: output.outDir ?? resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      // Portable plugin entries declare strict signatures individually.
      preserveEntrySignatures: wechat ? 'strict' : 'allow-extension',
      input: wechat
        ? { game: wechat.entry }
        : {
            index: resolve(realGeneratedRoot, 'index.html'),
            'execution-bootstrap': resolve(realGeneratedRoot, 'execution-bootstrap.ts'),
          },
      output: {
        ...(wechat ? { format: 'cjs' as const, chunkFileNames: 'assets/[name]-[hash].js' } : {}),
        entryFileNames: (chunk) =>
          wechat
            ? 'game.js'
            : chunk.name === 'execution-bootstrap'
              ? 'assets/execution-bootstrap.js'
              : 'assets/[name]-[hash].js',
      },
    },
  };
}

/** Releases what a failed preparation already owns, then rethrows its cause. */
async function failProjectPreparation(
  cause: unknown,
  disposePreparation: (() => Promise<void>) | undefined,
  ownsGeneratedRoot: boolean,
  generated: string,
): Promise<never> {
  const failures: unknown[] = [cause];
  try {
    await disposePreparation?.();
  } catch (error) {
    failures.push(error);
  }
  if (ownsGeneratedRoot) {
    try {
      await rm(generated, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  throw failures.length === 1
    ? cause
    : new AggregateError(failures, 'Project preparation and cleanup failed');
}

const projectRebuilds = new WeakMap<ViteDevServer, { tail: Promise<void>; generation: number }>();

/** Shader build options a project's facts select; point shadows are an explicit opt-in. */
export function projectShaderOptions(
  facts: Pick<ProjectFacts, 'pointShadows'>,
  materialPackages: readonly string[],
): Parameters<typeof forgeaxShader>[0] {
  return {
    materialPackages,
    ...(facts.pointShadows === true ? { engineEntries: { pointShadows: true } } : {}),
  };
}

export async function createViteConfig(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  base = '/',
  options: {
    readonly initialSources?: PluginSourceInventory;
    readonly materialProfile?: BuildOptions['materialProfile'];
    readonly bootstrapRoot?: BootstrapRoot;
    readonly outDir?: string;
    readonly sourcemap?: BuildOptions['sourcemap'];
    readonly server?: ProjectPortOptions;
    readonly host?: DevKitHostBinding;
    readonly sessionGeneration?: number;
    readonly animation?: AnimationPlaybackOptions;
    readonly target?: BuildOptions['target'];
    /**
     * A serving root reused across sessions by one owner at a time (project play
     * holds its lock). Vite's dependency-cache hash includes the root, so a fresh
     * `serve-*` root re-optimizes dependencies on every start.
     */
    readonly generatedRoot?: string;

    /** Owner-lifetime reuse keyed by each new snapshot's freshly digested closure. */
    readonly scriptablePackMetadata?: ScriptablePackMetadataCache;
  } = {},
): Promise<InlineConfig> {
  assertMaterialProfileTarget(options.materialProfile, options.target);
  const animation =
    options.animation === undefined
      ? environmentAnimationPlayback()
      : animationPlayback(options.animation);
  const timing = createViteConfigTiming(facts, command, options.host);
  const bootstrapRoot = options.bootstrapRoot ?? 'project-bootstrap';
  await assertHostBindingAdmission(facts, command, bootstrapRoot, options.host);
  // The canonical kit ships the engine's default environment (sky.hdr equirect).
  // Authored scenes (e.g. the default game template) reference it as a Skylight /
  // SkyboxBackground dependency, so a self-contained standalone build must catalog
  // it on the game path too — not only the tool-preview (resource-bootstrap) path.
  const canonicalKit = await resolveCanonicalKit();
  timing('canonical-kit');
  const serving = command === 'serve';
  const generated = await createGeneratedRoot(facts.root, serving, options.generatedRoot);
  let disposePreparation: (() => Promise<void>) | undefined;
  try {
    const realProjectRoot = await realpath(facts.root);
    const realGeneratedRoot = await realpath(generated);
    const projectRoots = facts.assetRoots.map((root) => resolve(facts.root, root));
    const libraryRoots = facts.assetLibraries.map((library) => library.root);
    const sourceRoots = [...projectRoots, ...libraryRoots];
    const workspacePreview = isWorkspacePreview(options.host);
    const failedSources = new Set<string>();
    const ignorePath = projectSourceIgnorePath(bootstrapRoot, failedSources);
    const sourceSnapshot = await admitInitialSourceSnapshot(
      facts,
      options.initialSources,
      options.scriptablePackMetadata,
    );
    // Both operations read current disk state and own no shared mutable
    // preparation. Keep their lifetime within this invocation: a later Play
    // must discover fresh project and Engine sources even without a watcher.
    // Only metadata of a byte-identical source closure crosses invocations.
    timing('project-inventory-start');
    const [scanned, engineWorkspaceResolver] = await Promise.all([
      scanInventory(sourceRoots, {
        ignorePath: (path) =>
          isPluginAssetSourceIgnoredPath(
            owningAssetLibrary(facts.assetLibraries, path)?.root ?? facts.root,
            path,
          ),
        scriptablePack: {
          ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
          metadataOnly: true,
          sourceSnapshot,
        },
        ...previewSourceFailureOptions(serving && workspacePreview, failedSources),
      }),
      createEngineWorkspaceResolver(facts.root),
    ]);
    timing('project-inventory-and-engine-resolver');
    if (!scanned.ok) throw scanned.error;
    const engineWorkspacePlugins =
      engineWorkspaceResolver === undefined ? [] : [engineWorkspaceResolver];
    const inventory = {
      declarations: new Map([...scanned.value.declarations].filter(([path]) => !ignorePath(path))),
    };
    // Resource and workspace previews inspect assets; only Play and builds activate authored roots.
    const activatesProjectRoots = bootstrapRoot !== 'resource-bootstrap' && !workspacePreview;
    const materialPackages = [
      ...(await discoverMaterialPackages(inventory)),
      ...textureViewMaterialPackages(canonicalKit, !activatesProjectRoots),
    ];
    timing('material-packages');
    const roots = packRoots(sourceRoots, canonicalKit);
    const builtinCookers = createBuiltinCookers(roots, options.materialProfile);
    const outputVersions = createStandardAssetOutputProducerRegistry(
      [...scanned.value.declarations.values()].flatMap((declaration) =>
        declaration.format === 'pack.ts'
          ? projectScriptablePackSceneComponents(declaration.definition.sceneComponents)
          : [],
      ),
    ).versions();
    const productCache = await createScriptablePackProductCache({
      root: devKitDdcRoots(facts.root).buildCacheRoot,
      identityRoot: facts.root,
      outputVersions,
      cookers: builtinCookers,
    });
    // The plugin scan is a superset of the builtins/material scan. Reuse its
    // validated declarations instead of loading every authored Pack twice.
    timing('plugin-assets-start');
    const sourceInventory =
      options.initialSources ??
      (await discoverPluginAssets(facts, scanned.value, sourceSnapshot, productCache));
    await digestMaterialSources(sourceSnapshot, facts.root, projectRoots);
    timing('plugin-assets');
    const toolProjection = await projectToolProjection(facts.root, sourceInventory);
    timing('tool-projection');
    const projectTools = toolProjection.tools;
    const assembly = servedHostAssembly(options.host, options.sessionGeneration);
    const consumerAliases = await resolveConsumerEngineAliases(facts.root, options.host);
    timing('consumer-aliases');
    const frontendAlias = await hostFrontendModuleAlias(options.host);
    timing('frontend-alias');
    const cookerSession = await loadProjectCookers(
      facts,
      builtinCookers,
      {
        resolve: { alias: consumerAliases, dedupe: engineDedupe(consumerAliases) },
        plugins: engineWorkspacePlugins,
      },
      { inventory: sourceInventory },
    );
    timing('project-cookers');
    disposePreparation = () => cookerSession.dispose();
    const ssrIdentity = projectSsrIdentity(facts, sourceInventory, {
      command,
      base,
      bootstrapRoot,
      sessionGeneration: assembly.sessionGeneration,
      animation,
      appOptions: cookerSession.appOptions,
    });
    await Promise.all([
      ...(serving ? writePreviewBatchEntry(generated) : []),
      writePipelineLibrary(generated, cookerSession.appOptions),
      writeFile(
        resolve(generated, 'index.html'),
        htmlSource(
          facts.name,
          bootstrapRoot === 'project-bootstrap',
          resolveLoadProgressLabels(cookerSession.appOptions.loadingLabels),
        ),
      ),
      writeFile(
        resolve(generated, 'main.ts'),
        hostSource(
          facts,
          bootstrapRoot,
          canonicalKit?.guid,
          options.host,
          process.env.FORGEAX_ENGINE_RHI_DEBUG === '1',
          command === 'serve',
          assembly,
          ssrIdentity,
          command === 'serve' && process.env.FORGEAX_PREVIEW_RHI_WINDOW === '1',
          animation,
          options.target,
          cookerSession.appOptions,
          options.materialProfile,
        ),
      ),
      writeFile(
        resolve(generated, 'runtime-packs.ts'),
        await runtimePacksModuleSource(facts, sourceInventory, options.target),
      ),
      writeFile(resolve(generated, 'game-vfx.ts'), gameVfxSource),
      writeFile(
        resolve(generated, 'execution-bootstrap.ts'),
        executionBootstrapSource(
          bootstrapRoot,
          assembly.sessionGeneration,
          ssrIdentity,
          options.target,
          cookerSession.appOptions,
        ),
      ),
    ]);
    timing('generated-files');
    const wechat =
      options.target === 'wechat'
        ? await prepareWechatBuild(facts, generated, sourceInventory, cookerSession.appOptions)
        : undefined;
    const projectInputPaths = new Set(
      ['forge.json', 'package.json', 'pnpm-lock.yaml', 'bun.lock', 'package-lock.json'].map(
        (file) => resolve(realProjectRoot, file),
      ),
    );
    // Generated files already sit under Vite's root; re-adding them after its initial scan
    // makes Chokidar report setup as edits and can restart the live host during Catalog loads.
    const projectWatchPaths = [
      ...new Set([...roots, ...sourceInventory.sourceInputs.keys(), ...projectInputPaths]),
    ].filter((path) => existsSync(path) && !isFilesystemPathWithin(generated, path));
    const engineWorkspaceRoot = findEngineWorkspaceRoot();
    const runtimeBinding = createStandaloneRuntimeAssetBinding(facts.id);
    let sessionClosed = false;
    assertNoBuiltinImporterOverride(cookerSession.importers);
    let initialSourceSnapshot: typeof sourceSnapshot | undefined = sourceSnapshot;
    const pack = pluginPack({
      roots,
      takeInitialSourceSnapshot: () => {
        const taken = initialSourceSnapshot;
        initialSourceSnapshot = undefined;
        return taken;
      },
      runtimeBinding,
      // The catalog is consumed by project tools and editors, regardless of
      // where this DevKit package or Vite's generated entry lives. Keep
      // project assets rooted in the authored project and mounted libraries
      // under their forge.json specifier; other external dependencies retain
      // their physical identity and the Pack fallback policy.
      sourceIdentityFor: (sourcePath) =>
        assetLibrarySourceIdentity(facts.assetLibraries, sourcePath) ??
        filesystemPathRelative(facts.root, sourcePath, false) ??
        sourcePath,
      ...devPackReadinessOptions(facts),
      ddc: devKitDdcRoots(facts.root),
      watch: false,
      importers: [...DEFAULT_IMPORTERS, ...cookerSession.importers],
      cookers: cookerSession.cookers,
      ignorePath,
    });
    const delivery = wechat === undefined ? 'browser' : 'native';
    const plugins: Plugin[] = [
      ...(serving ? [previewInputsPlugin(pack)] : []),
      ...(wechat === undefined ? [] : [wechat.plugin]),
      ...(serving ? [projectSourceWatchPlugin(projectWatchPaths)] : []),
      executionWorkerEntries(undefined, delivery),
      ...(serving ? [generatedHostOwnerPlugin(generated)] : []),
      ...engineWorkspacePlugins,

      ...(serving ? rhiDebugPlugins(facts.root) : []),
      forgeaxShader(projectShaderOptions(facts, materialPackages)) as Plugin,
      pack,
      ...(serving
        ? [
            devKitHostBridge(options.host, async () => {
              await pack.ready();
              timing('pack-ready');
              const inventory = await publishedPluginInventory(facts.root, sourceInventory, pack);
              timing('published-plugin-inventory');
              const root =
                !activatesProjectRoots || !facts.roots.frontend
                  ? undefined
                  : inventory.assets.get(facts.roots.frontend);
              if (facts.roots.frontend && activatesProjectRoots && !root)
                throw new Error(`host root ${facts.roots.frontend} has no published definition`);
              return createHostAssembly({
                ...assembly,
                ...(root ? { root: pluginRootDescriptor(root.definition) } : {}),
              });
            }),
          ]
        : []),
      pluginRuntimeProjection(facts.root, sourceInventory.sourceInputs),
      pluginProgramsBuild({
        delivery,
        projectRoot: facts.root,
        tools: projectTools,
        roots: activatesProjectRoots ? facts.roots : {},
        inventory: () => publishedPluginInventory(facts.root, sourceInventory, pack),
        binding: runtimeBinding,
        pack,
      }),
      {
        name: 'forgeax:project-session',
        ...{
          inputPaths: () =>
            [
              ...new Set([
                ...sourceInventory.sourceSnapshot.paths,
                ...(sourceInventory.filesystemInputs === undefined ? [] : [realProjectRoot]),
                ...cookerSession.watchFiles,
                ...projectInputPaths,
              ]),
            ]
              .filter(
                (path) =>
                  !isFilesystemPathWithin(generated, path) &&
                  !isFilesystemPathWithin(realGeneratedRoot, path),
              )
              .sort(),
        },
        generateBundle() {
          if (
            command !== 'build' ||
            (options.target ?? 'browser') !== 'browser' ||
            this.environment.name !== 'client' ||
            cookerSession.delivery.bundles === undefined
          )
            return;
          this.emitFile({
            type: 'asset',
            fileName: PLAYER_DELIVERY_FILE,
            source: JSON.stringify(cookerSession.delivery),
          });
        },
        async closeBundle() {
          sessionClosed = true;
          await cookerSession.dispose();
        },
        async hotUpdate(context) {
          const environment = this.environment;
          if (environment.name !== 'client') return [];
          // Vite presents slash-normalized paths; inventories use native paths.
          const sourcePath = resolve(context.file);
          const authoringSource = await notifyAuthoringSourceChange(
            options.host,
            context,
            sourcePath,
          );
          if (sourcePath.startsWith(`${generated}${sep}`)) return [];
          // Sibling Play files cannot invalidate this immutable frontend.
          if (relative(facts.root, sourcePath).split(sep).includes('.forgeax')) return [];
          const definitions = new Set([
            ...[...sourceInventory.assets.values()].flatMap((record) => [
              record.sourcePath,
              record.module,
            ]),
            ...cookerSession.watchFiles,
            ...projectTools.flatMap((tool) => [
              tool.moduleName,
              ...(tool.executor ? [tool.executor] : []),
            ]),
          ]);
          const underRoot = roots.some((root) => sourcePath.startsWith(`${root}${sep}`));
          // A captured asset declaration is publication data, not frontend program identity.
          const assetSource =
            underRoot &&
            !definitions.has(sourcePath) &&
            (inventory.declarations.has(sourcePath) ||
              !sourceInventory.sourceInputs.has(sourcePath));
          const capturedRevision =
            assetSource || authoringSource
              ? undefined
              : sourceInventory.sourceInputs.get(sourcePath);
          if (capturedRevision !== undefined) {
            try {
              const currentRevision = `sha256:${createHash('sha256')
                .update(await readFile(context.file))
                .digest('hex')}`;
              // Dynamically adding an already-existing project root to Vite's watcher can emit
              // initial change events. They are not edits and must not replace the live host.
              if (currentRevision === capturedRevision) return [];
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
            }
          }
          const visited = new Set<import('vite').ModuleNode>();
          const belongsToPlugin = (module: import('vite').ModuleNode): boolean => {
            if (visited.has(module)) return false;
            visited.add(module);
            if (module.file && definitions.has(module.file)) return true;
            return [...module.importers].some(belongsToPlugin);
          };
          const changedModules = context.server.moduleGraph.getModulesByFile(context.file);
          const projectInput = projectInputPaths.has(sourcePath);
          const sessionSource =
            projectInput ||
            (!assetSource && sourceInventory.sourceInputs.has(sourcePath)) ||
            definitions.has(sourcePath) ||
            [...(changedModules ?? [])].some(belongsToPlugin);
          if (
            options.host?.frontendModule &&
            !authoringSource &&
            !assetSource &&
            (sessionSource || (changedModules?.size ?? 0) > 0)
          )
            hostBindingError(
              `external frontend modules are immutable; source changed: ${sourcePath}; supply a new revision/binding and replace the page`,
            );
          if (!authoringSource && !sessionSource && !underRoot) return;
          if (authoringSource || (!sessionSource && underRoot)) {
            void pack
              .rebuildCatalogInPlace([sourcePath])
              .then((published) => {
                if (!published) return;
                try {
                  options.host?.backend.context.get('engineWorkspaceCatalog')?.notePublished();
                } catch {
                  // A game host has no workspace catalog publisher.
                }
              })
              .catch((cause) => {
                const error = cause instanceof Error ? cause : new Error(String(cause));
                context.server.config.logger.error(error.message);
              });
            return [];
          }
          let queue = projectRebuilds.get(context.server);
          if (!queue) {
            queue = { tail: Promise.resolve(), generation: assembly.sessionGeneration };
            projectRebuilds.set(context.server, queue);
          }
          const owner = queue;
          let replacementStarted = false;
          const next = owner.tail
            .catch(() => {})
            .then(async () => {
              // Finish Vite's per-environment dispatch before replacing its environment objects.
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              if (sessionClosed) return;
              const generation = owner.generation + 1;
              const prepareReplacement = async (): Promise<InlineConfig | undefined> => {
                const facts = await readProjectFacts(realProjectRoot);
                if (!facts.ok) throw facts.error;
                await options.host?.backend.context.get('devkitBackend')?.assertCurrent();
                const validated = await discoverPluginAssets(facts.value);
                const candidate = await createViteConfig(facts.value, 'build', base, {
                  sessionGeneration: generation,
                });
                await viteBuild({ ...candidate, build: { ...candidate.build, write: false } });
                if (sessionClosed) return undefined;
                await assertPluginSourceInputs(validated, facts.value.root);
                // Vite creates the replacement before closing this server, so it
                // cannot share a stable root that this server still serves.
                const { generatedRoot: _servedRoot, ...replacement } = options;
                const config = await createViteConfig(facts.value, 'serve', base, {
                  ...replacement,
                  sessionGeneration: generation,
                });
                try {
                  if (sessionClosed)
                    throw new Error('project session closed during candidate preparation');
                  await assertPluginSourceInputs(validated, facts.value.root);
                } catch (cause) {
                  // This prepared server never acquired a Vite close owner.
                  const owner = config.plugins
                    ?.flat()
                    .find(
                      (plugin) =>
                        plugin &&
                        typeof plugin === 'object' &&
                        'name' in plugin &&
                        plugin.name === 'forgeax:project-session',
                    ) as Plugin | undefined;
                  if (typeof owner?.closeBundle === 'function')
                    await owner.closeBundle.call({} as never);
                  if (typeof config.root === 'string')
                    await rm(config.root, { recursive: true, force: true });
                  throw cause;
                }
                return config;
              };
              let config: InlineConfig | undefined;
              try {
                config = await prepareReplacement();
              } catch (cause) {
                const error = commandError(cause, 'project-rebuild-failed');
                const sourceCause = error.detail.cause;
                if (
                  error.code !== 'plugin-bootstrap-failed' ||
                  sourceCause === null ||
                  typeof sourceCause !== 'object' ||
                  !('reason' in sourceCause) ||
                  sourceCause.reason !== 'source changed during plugin compilation'
                )
                  throw cause;
                // A watcher can coalesce the last save while this candidate is
                // compiling. Reject its old snapshot, then prepare once from
                // current source without requiring another filesystem event.
                if (sessionClosed) return;
                config = await prepareReplacement();
              }
              if (config === undefined || sessionClosed) return;
              const bridge = context.server.config.plugins.find(
                (plugin) => plugin.name === 'forgeax:devkit-backend-host',
              ) as (Plugin & { releaseForRestart(): Promise<void> }) | undefined;
              replacementStarted = true;
              await bridge?.releaseForRestart();
              config.server = { ...context.server.config.inlineConfig.server, ...config.server };
              Object.assign(context.server.config.inlineConfig, config);
              await context.server.restart();
              if (resolve(context.server.config.root) !== resolve(config.root ?? realProjectRoot))
                throw new Error('project session replacement failed; start a fresh server');
              owner.generation = generation;
              // Vite's websocket reconnection reloads the page after restart.
            });
          owner.tail = next;
          void next.catch((cause) => {
            if (sessionClosed && !replacementStarted) return;
            const error = cause instanceof Error ? cause : new Error(JSON.stringify(cause));
            context.server.config.logger.error(error.message);
            environment.hot.send({
              type: 'error',
              err: { name: error.name, message: error.message, stack: error.stack ?? '' },
            });
          });
          return [];
        },
      },
    ];
    addWorkspaceTimingPlugins(plugins, options.host, timing);
    return {
      root: generated,
      logLevel: 'warn',
      customLogger: createLogger('warn', {
        allowClearScreen: false,
        console: new Console({ stdout: process.stderr, stderr: process.stderr }),
      }),
      base,
      configFile: false,
      publicDir: false,
      define: { 'import.meta.env.DEV': JSON.stringify(command === 'serve') },
      plugins,
      worker: {
        // Vite builds each nested Worker with a separate plugin graph and conditions.
        plugins: () => [createEngineWorkspaceResolver(facts.root)],
      },
      resolve: viteResolveOptions(wechat !== undefined, frontendAlias, consumerAliases),
      server: viteServerOptions(
        options.server,
        [facts.root, realProjectRoot, generated, realGeneratedRoot, ...roots],
        engineWorkspaceRoot,
        frontendAlias,
      ),
      build: viteBuildOptions(wechat, realGeneratedRoot, facts.root, options),
    };
  } catch (cause) {
    return await failProjectPreparation(cause, disposePreparation, serving, generated);
  }
}
