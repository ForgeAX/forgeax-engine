import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';
import type { Plugin } from 'vite';
import { gameProjectionSource } from '../host/game-projection-source.js';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import type { DevKitAppOptions } from '../plugin-build.js';
import type { BuildOptions, ProjectFacts } from '../types.js';
import { type PluginSourceInventory, pluginAssetClosure } from './plugin-assets.js';
import { staticPackProgramsSource } from './static-pack-programs.js';

/** Native package preparation consumes the same SDK-owned payloads as public source builds. */
export async function prepareWechatBuild(
  facts: ProjectFacts,
  generated: string,
  inventory: PluginSourceInventory,
  appOptions: DevKitAppOptions = {},
) {
  const fontRoot = dirname(
    createRequire(import.meta.url).resolve('@fontsource-variable/noto-sans-sc/package.json'),
  );
  const physics = [
    ...new Set(
      pluginAssetClosure(inventory, facts.roots.engine).flatMap((record) => {
        const match = /(?:\/|-)rapier([23])d(?:\.[cm]?js)?$/.exec(record.module);
        return match ? [match[1] as '2' | '3'] : [];
      }),
    ),
  ];
  const staging = await realpath(await mkdtemp(resolve(generated, 'wechat-')));
  const native = resolve(staging, 'wgpu');
  await writeFile(
    resolve(generated, 'wechat-main.ts'),
    wechatHostSource(facts, native, process.env.FORGEAX_ENGINE_RHI_DEBUG === '1', appOptions),
  );
  await writeFile(resolve(generated, 'wechat-game.ts'), wechatGameSource(physics, facts));
  await writeFile(
    resolve(generated, 'wechat-programs.ts'),
    await staticPackProgramsSource(facts, inventory),
  );
  await writeFile(
    resolve(generated, 'wechat-entry.ts'),
    `function launch() {
const entryInspection = globalThis.__forgeaxGameInspection;
if (entryInspection) entryInspection.phase = 'standards-module';
console.info('[forgeax.wechat.startup]', 'standards-module');
import('@forgeax/engine/platform-wechat/standards').then(({ installWechatStandards }) => {
  if (entryInspection) entryInspection.phase = 'standards-installation';
  console.info('[forgeax.wechat.startup]', 'standards-installation');
  installWechatStandards().unwrap();
  if (entryInspection) entryInspection.phase = 'host-module';
  console.info('[forgeax.wechat.startup]', 'host-module');
  return import('./wechat-main.ts');
}).then(module => module.start(launch)).catch(error => {
  console.error('ForgeaX graphics host failed', error);
  const seen = new Set();
  const encoded = JSON.stringify(error, (key, value) => {
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (value instanceof Error) return { ...value, name: value.name, message: value.message, cause: value.cause, errors: value.errors };
    }
    return value;
  });
  const diagnostic = encoded === undefined ? String(error) : JSON.parse(encoded);
  const inspection = globalThis.__forgeaxGameInspection ?? entryInspection;
  if (inspection) { inspection.phase = 'failed'; inspection.error = diagnostic; }
  let reason = 'The game could not start.';
  for (let current = diagnostic, depth = 0; current != null && depth < 16; depth++) {
    if (typeof current === 'string') {
      if (current !== '[circular]' && current.trim()) reason = current;
      break;
    }
    if (typeof current !== 'object') break;
    const message = current.message ?? current.errMsg ?? current.reason ?? current.detail?.reason;
    if (typeof message === 'string' && message.trim()) reason = message;
    current = current.cause ?? current.detail?.cause ?? current.error ?? current.failure ?? current.errors?.[0];
  }
  reason = reason.replace(/\\s+/g, ' ').trim();
  if (reason.length > 160) reason = reason.slice(0, 157) + '...';
  wx.showModal?.({ title: 'Unable to start',
    content: reason + '\\n\\nTap Reload to try again. If it fails again, close and reopen the game.',
    confirmText: 'Reload', showCancel: false,
    success(result) { if (result.confirm) launch(); },
  });
});
}
launch();`,
  );
  let wgpuRequire: NodeRequire | undefined;
  const plugin: Plugin = {
    name: 'forgeax:wechat-package',
    enforce: 'pre',
    resolveId(id, importer) {
      if (importer?.startsWith(native) && id.startsWith('@noble/hashes/'))
        return wgpuRequire?.resolve(id) ?? null;
      return null;
    },
    async buildStart() {
      // Vite selects both glue and native payload owners, including use-local bindings.
      const packageManifest = async (name: string, importer: string): Promise<string> => {
        const id = `${name}/package.json`;
        const selected = await this.resolve(id, importer);
        if (selected === null || selected.external)
          return this.error({
            code: 'UNRESOLVED_IMPORT',
            id,
            message: `Cannot resolve the native WeChat package ${id} from ${importer}`,
          });
        return selected.id;
      };
      const engineManifest = await packageManifest(
        '@forgeax/engine',
        resolve(facts.root, 'package.json'),
      );
      // SDK native owners may be nested dependencies of the selected umbrella.
      const wgpuRoot = dirname(await packageManifest('@forgeax/engine-wgpu-wasm', engineManifest));
      const uiRoot = dirname(await packageManifest('@forgeax/engine-ui-blitz', engineManifest));
      const codecRoot = dirname(await packageManifest('@forgeax/engine-codec', engineManifest));
      const physicsRoots = await Promise.all(
        physics.map(async (dimension) => ({
          dimension,
          root: dirname(
            await packageManifest(`@forgeax/engine-physics-rapier${dimension}d`, engineManifest),
          ),
        })),
      );
      wgpuRequire = createRequire(resolve(wgpuRoot, 'package.json'));
      const { buildNativeWgpu } = await import(
        pathToFileURL(resolve(wgpuRoot, 'scripts/native-build.mjs')).href
      );
      await buildNativeWgpu({ out: native });
      for (const [fileName, sourcePath] of [
        ['wasm/wgpu.wasm', resolve(native, 'wgpu.wasm')],
        ['wasm/wgpu.provenance.json', resolve(native, 'provenance.json')],
        ['wasm/ui.wasm', resolve(uiRoot, 'pkg/ui_blitz_bg.wasm')],
        ['wasm/ui.provenance.json', resolve(uiRoot, 'pkg/provenance.json')],
        ['wasm/ui.LICENSE', resolve(uiRoot, 'LICENSE')],
        ['wasm/basis_transcoder.wasm', resolve(codecRoot, 'pkg/basis_transcoder.wasm')],
        [
          'wasm/basis.provenance.json',
          resolve(codecRoot, 'dist/basis-native-factory.provenance.json'),
        ],
      ] as const) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(sourcePath) });
      }
      for (const { dimension, root } of physicsRoots) {
        for (const [file, name] of [
          ['rapier.wasm', `rapier${dimension}d.wasm`],
          ['provenance.json', `rapier${dimension}d.provenance.json`],
          ['LICENSE', `rapier${dimension}d.LICENSE`],
        ] as const)
          this.emitFile({
            type: 'asset',
            fileName: `wasm/${name}`,
            source: await readFile(resolve(root, 'pkg', file)),
          });
      }
      for (const file of [
        'LICENSE',
        'index.css',
        ...(await readdir(resolve(fontRoot, 'files')))
          .filter((file) => file.endsWith('.woff2'))
          .map((file) => `files/${file}`),
      ])
        this.emitFile({
          type: 'asset',
          fileName: `ui-fonts/${file}`,
          source: await readFile(resolve(fontRoot, file)),
        });
    },
    async closeBundle() {
      await rm(staging, { recursive: true, force: true });
    },
  };
  return { plugin, entry: resolve(generated, 'wechat-entry.ts') };
}

export async function writeWechatProject(
  facts: ProjectFacts,
  options: BuildOptions,
  outDir: string,
) {
  await mkdir(outDir, { recursive: true });
  const entries = await readdir(outDir);
  const payload = resolve(outDir, 'payload');
  await mkdir(payload);
  for (const entry of entries) await rename(resolve(outDir, entry), resolve(payload, entry));
  const compress = promisify(brotliCompress);
  const resources: string[] = [];
  async function publish(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await publish(path);
      else if (!entry.name.endsWith('.js')) resources.push(path);
    }
  }
  await publish(payload);
  // Four independent files bound native compression memory without serializing the package.
  for (let start = 0; start < resources.length; start += 4) {
    await Promise.all(
      resources.slice(start, start + 4).map(async (path) => {
        const source = await readFile(path);
        const compressed = await compress(source, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        });
        await writeFile(`${path}.br`, compressed);
        await rm(path);
      }),
    );
  }
  await Promise.all([
    writeFile(
      resolve(outDir, 'game.js'),
      `const inspection = { phase: 'subpackage-loading', error: undefined, renderer: () => ({ state: 'initializing', phase: inspection.phase, lastError: inspection.error }) };
globalThis.__forgeaxGameInspection = inspection;
console.info('[forgeax.wechat.startup]', 'subpackage-loading');
wx.loadSubpackage({ name: 'payload', success() { if (inspection.phase === 'subpackage-loading') inspection.phase = 'subpackage-loaded'; console.info('[forgeax.wechat.startup]', 'subpackage-loaded'); }, fail(error) { inspection.phase = 'failed'; inspection.error = error; console.error('ForgeaX package failed', error); wx.showModal({ title: 'Unable to load', content: error.errMsg || String(error), showCancel: false }); } });\n`,
    ),
    writeFile(
      resolve(outDir, 'game.json'),
      JSON.stringify(
        {
          deviceOrientation: 'landscape',
          showStatusBar: false,
          subpackages: [{ name: 'payload', root: 'payload/' }],
        },
        null,
        2,
      ),
    ),
    writeFile(
      resolve(outDir, 'project.config.json'),
      JSON.stringify(
        {
          appid: options.appid ?? 'touristappid',
          compileType: 'game',
          projectname: facts.name,
          setting: { es6: false, enhance: false, minified: false },
          libVersion: 'latest',
        },
        null,
        2,
      ),
    ),
  ]);
}

/** Count deployed bytes, including the completed distribution manifest. */
export async function verifyWechatPackageBudget(outDir: string): Promise<void> {
  let total = 0;
  let main = 0;
  async function count(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await count(path);
      else {
        const bytes = (await stat(path)).size;
        total += bytes;
        if (relative(outDir, path).split(sep)[0] !== 'payload') main += bytes;
      }
    }
  }
  await count(outDir);
  if (main > 4 * 1024 * 1024 || total > 20 * 1024 * 1024) {
    throw new Error(
      `WeChat package exceeds deployment limits: main ${main}/4194304 bytes, total ${total}/20971520 bytes`,
    );
  }
}

export function wechatHostSource(
  facts: ProjectFacts,
  native: string,
  rhiDebug = false,
  appOptions: DevKitAppOptions = {},
): string {
  return `import { createWechatPlatform, createWechatWasmHost, createWechatWgpuHost, createWechatInputBackend, createWechatAudioBackend, createWechatPackageFetcher } from '@forgeax/engine/platform-wechat';
import { createBlitzUi, gpuShaders } from '@forgeax/engine/ui-blitz';
import { inspectUi } from '@forgeax/engine/ui';
import { ensureReady, rhi } from '@forgeax/engine/rhi-wgpu';
import * as nativeWgpu from ${JSON.stringify(resolve(native, 'wgpu-native.mjs'))};
import { constructRuntimeRendererHost } from '@forgeax/engine/runtime/internal/renderer-host';
import { createApp, inputPlugin, canvasAspectPlugin } from '@forgeax/engine/app';
${rhiDebug ? "import { attachRecorder } from '@forgeax/engine/rhi-debug';\nimport { createRhiCapture, createRhiInstrumentation } from '@forgeax/engine/app';\nimport { createShaderModule, createShaderModuleImmediate } from '@forgeax/engine/rhi-wgpu';" : ''}
import { World } from '@forgeax/engine/ecs';
import { inputBackendPlugin } from '@forgeax/engine/input';
import { audioBackendPlugin, audioPlugin } from '@forgeax/engine/audio';
import { createCatalogSource } from '@forgeax/engine/assets-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrograms as enginePrograms } from 'virtual:forgeax/plugin-programs/engine';
import { runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { imports, programHost } from './wechat-programs.ts';
import { createGameVfx } from './game-vfx';
const value = result => { if (!result.ok) throw result.error; return result.value; };
let generation = 0;
let displayCanvas;
let uiWasm;
let wgpuHost;
let dispose;
let replacing = Promise.resolve();
export function start(reload) {
  const identity = ++generation;
  replacing = replacing.catch(() => {}).then(async () => { await dispose?.(); await boot(identity, reload); });
  return replacing;
}
async function boot(identity, reload) {
  const releases = [];
  const lifetime = new AbortController();
  let startup;
  let app;
  let graphics;
  let ui;
  let startupError;
  const appStartupErrors = [];
  let completed = 0;
  let presented = 0;
  let lastCompletion;
  let phase;
  ${gameProjectionSource}
  const advance = next => {
    if (phase === next) return;
    phase = next;
    console.info('[forgeax.wechat.startup]', JSON.stringify({ generation: identity, phase }));
  };
  const fail = (error, execution = app?.execution.report()) => {
    if (closed || startupError !== undefined) return;
    const appErrors = appStartupErrors.filter(observed => observed !== error);
    startupError = appErrors.length === 0 ? error : Object.assign(
      new Error('WeChat Host startup failed', { cause: error }), { detail: { appErrors } });
    advance('failed'); startup?.fail(startupError, execution);
  };
  const inspection = { ${rhiDebug ? 'get rhiCapture() { return app?.rhiCapture; },' : ''}
    ui: request => inspectUi(!closed && globalThis.__forgeaxGameInspection === inspection ? ui?.document.body : undefined, request, ui),
    list: () => ({ reads: Array.from(gameProjectionDefinitions.entries()).filter(([, entry]) => entry.kind === 'read').map(([id]) => id) }),
    read: async id => {
      const entry = gameProjectionDefinitions.get(id);
      if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
      return entry.definition.read();
    }, assets: () => graphics?.assets.inspect(), world: () => app?.world.inspect(),
    runtimePacks: () => app?.pluginContext.runtimePacks?.producer.inspect(), renderer: () => ({ ...(app?.renderer.inspect() ?? { state: 'initializing' }),
    generation: identity, phase, completed, presented,
    lastCompletion: lastCompletion === undefined ? undefined : { ...lastCompletion }, startupError, lastError: app?.lastError }) };
  globalThis.__forgeaxGameInspection = inspection;
  releases.push(() => { if (startupError === undefined && globalThis.__forgeaxGameInspection === inspection) delete globalThis.__forgeaxGameInspection; });
  releases.push(() => gameProjectionDefinitions.clear());
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    if (startupError === undefined) advance('disposing');
    lifetime.abort();
    const failures = [];
    try { startup?.destroy(); } catch (error) { failures.push(error); }
    try { if (app?.execution.report().engine.health === 'running') app.pause().unwrap(); } catch (error) { failures.push(error); }
    for (const release of releases.reverse()) { try { await release(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'WeChat Host cleanup failed');
  };
  dispose = stop;
  try {
  advance('platform');
  // WeChat's first Canvas is the display surface, even if Platform admission fails.
  displayCanvas ??= wx.createCanvas();
  const platform = createWechatPlatform({ wx, requestAnimationFrame: callback => requestAnimationFrame(callback), cancelAnimationFrame: handle => cancelAnimationFrame(handle) }, displayCanvas).unwrap();
  releases.push(() => platform.dispose());
  const canvas = platform.canvas;
  const native = { wx, WXWebAssembly };
  const fetcher = createWechatPackageFetcher(wx, { root: 'payload', baseUrl: 'https://forgeax.package/', encoding: 'br' });
  const display = platform.display().unwrap();
  canvas.width = Math.max(1, Math.round(display.width * display.pixelRatio));
  canvas.height = Math.max(1, Math.round(display.height * display.pixelRatio));
  advance('ui-wasm-and-fonts');
  // Cancel pending UI initialization, but retire a live document after its consumers.
  const uiLifetime = new AbortController();
  releases.push(() => uiLifetime.abort());
  ui = await createBlitzUi({
    wasm: uiWasm ??= createWechatWasmHost(native, 'payload/wasm/ui.wasm.br').unwrap(),
    html: ${JSON.stringify(hostStartupDocument(facts.name).replace('</head>', '<link rel="stylesheet" href="ui-fonts/index.css"></head>'))},
    width: canvas.width, height: canvas.height, pixelRatio: display.pixelRatio,
    font: new Uint8Array(await (await fetcher('https://forgeax.package/ui-fonts/files/noto-sans-sc-latin-wght-normal.woff2')).arrayBuffer()),
    fontFamily: 'Noto Sans SC Variable',
    resources: { baseUrl: 'https://forgeax.package/', read: async (url, signal) => new Uint8Array(await (await fetcher(url, { signal })).arrayBuffer()) },
    signal: uiLifetime.signal,
    onError: fail,
  });
  if (closed) { ui.dispose(); return; }
  if (startupError !== undefined) throw startupError;
  const host = { document: ui.document, events: ui.document, surface: () => canvas,
    now: () => platform.now().unwrap(), visible: () => platform.visible(),
    reducedMotion: false, reload };
  startup = ${hostStartupScript(true, 'host')};
  const input = createWechatInputBackend(wx, platform, { ui: ui.input, keyboard: wx,
    onError: error => console.warn('ForgeaX native input failed', error) }).unwrap();
  releases.push(() => input.detach());
  const audio = createWechatAudioBackend(wx, platform, { onError: fail });
  releases.push(() => audio.destroy());
  startup.bindInput(enabled => input.setInputAllowed?.(enabled));
  advance('wgpu');
  await ensureReady({ initFn: async () => { await nativeWgpu.initializeNativeWgpu(wgpuHost ??= createWechatWgpuHost(native, 'payload/wasm/wgpu.wasm.br', [canvas]).unwrap()); return nativeWgpu; } });
  ${
    rhiDebug
      ? `const recorder = value(attachRecorder({ rhi, createShaderModule, createShaderModuleImmediate }));
  releases.push(async () => value(await recorder.dispose()));
  const rhiCapture = createRhiCapture(recorder);`
      : ''
  }
  advance('graphics');
  const gameVfx = createGameVfx();
  graphics = value(await constructRuntimeRendererHost(canvas, {
    ${rhiDebug ? 'rhi: recorder.backend.rhi, rhiInstrumentation: createRhiInstrumentation(recorder),' : 'rhi,'}
    features: [gameVfx.feature],
    dynamicGeometryMeshBudgetBytes: ${JSON.stringify(appOptions.dynamicGeometryMeshBudgetBytes)},
    pipelineLibrary: ${JSON.stringify(appOptions.pipelineLibrary)},
    standardProfile: ${JSON.stringify(appOptions.standardProfile)},
    ui: { kind: 'sparse-strips', shaders: gpuShaders, paint: time => ui.paintGpu(time) },
  }, { ...forgeaxBundlerAdapter(), shaderManifestUrl: 'https://forgeax.package/shaders/manifest.json', readShaderManifest: async url => (await fetcher(url)).text() }));
  releases.push(() => graphics.renderer.dispose());
  const world = new World();
  let game;
  let gameLoading;
  const catalog = createCatalogSource({ url: 'https://forgeax.package/pack-index.json', fetch: fetcher });
  advance('app');
  app = (await createApp({ platform, renderer: graphics.renderer, world, assets: graphics.assets, assetCatalog: catalog,
    ${rhiDebug ? 'rhiCapture,' : ''}
    drawSource: () => game !== undefined && startupError === undefined ? undefined : null,
    pluginPrograms: enginePrograms('wechat-' + identity, 'engine', identity),
    runtimePacks: { scopeId: runtimeBinding.scopeId, imports, programHost },
    plugins: [inputBackendPlugin(input), inputPlugin(), audioBackendPlugin(audio), audioPlugin(), canvasAspectPlugin(() => canvas), gameVfx.plugin],
    onFrameSubmitted: detail => { if (!closed && generation === identity) startup.submitted(detail); },
    onFrameCompleted: detail => {
      if (closed || generation !== identity) return;
      completed += 1; lastCompletion = detail;
      if (game !== undefined && detail.presentation === 'ready') {
        presented += 1;
        if (presented === 60) console.info('[forgeax.wechat.completed]', JSON.stringify({ generation: identity, completed, presented, ...detail }));
      }
      startup.enter(detail);
    },
  })).unwrap();
  releases.push(async () => (await app.dispose()).unwrap());
  startup.bindSession(world.identity);
  releases.push(app.onError(error => {
    // Activation owns its result, including child retirement before rejection.
    // App errors during that transaction must not preempt the primary failure.
    if (game === undefined) appStartupErrors.push(error);
    else {
      const execution = app.execution.report();
      if (execution.fault !== undefined && execution.fault !== null) fail(error, execution);
    }
  }));
  releases.push(platform.subscribe(event => {
    if (event.kind === 'visibility') startup.visibilityChanged();
    if (event.kind === 'display') {
      const next = event.display;
      canvas.width = Math.max(1, Math.round(next.width * next.pixelRatio));
      canvas.height = Math.max(1, Math.round(next.height * next.pixelRatio));
      ui.resize(canvas.width, canvas.height, next.pixelRatio);
    }
  }).unwrap());
  releases.push(async () => { await gameLoading?.catch(() => {}); await game?.dispose(); });
  app.start().unwrap();
  advance('renderer-initialization');
  void (async () => { try {
    value(await graphics.initialization);
    if (closed || generation !== identity) return;
    advance('scene');
    const module = await import('./wechat-game.ts');
    if (closed || generation !== identity) return;
    gameLoading = module.activate({ app, graphics, ui, canvas, gameProjection,
      generation: identity, signal: lifetime.signal, active: () => !closed && generation === identity });
    game = await gameLoading;
    if (closed || generation !== identity) { await game.dispose(); return; }
    if (appStartupErrors.length > 0) throw appStartupErrors[0];
    startup.prepare();
    advance('ready');
  } catch (error) { if (!closed && generation === identity) { console.error('ForgeaX game activation failed', error); fail(error); } } })();
  } catch (error) {
    if (closed) return;
    fail(error);
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'WeChat Host startup failed', { cause: error }); }
    throw error;
  }
}
`;
}

function wechatGameSource(physics: readonly ('2' | '3')[], facts: ProjectFacts): string {
  return `import { activateExecutionRoot, gameHostPlugin } from '@forgeax/engine/app';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { scenePlugin } from '@forgeax/engine/scene';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { renderComponentsPlugin } from '@forgeax/engine/render';
import { animationPlugin } from '@forgeax/engine/animation';
import { statePlugin } from '@forgeax/engine/state';
import { root as engineRoot } from 'virtual:forgeax/plugin-programs/engine';
import { createPrograms as frontendPrograms, root as frontendRoot } from 'virtual:forgeax/plugin-programs/frontend';
import { runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { createWechatWasmHost } from '@forgeax/engine/platform-wechat';
import { initBasisTranscoder } from '@forgeax/engine/codec';
${physics.map((dimension) => `import { initializeNativeRapier${dimension}D } from '@forgeax/engine/physics-rapier${dimension}d/native';`).join('\n')}
export async function activate({ app, graphics, ui, canvas, gameProjection, generation, signal, active }) {
  await initBasisTranscoder(createWechatWasmHost({ wx, WXWebAssembly }, 'payload/wasm/basis_transcoder.wasm.br').unwrap());
  ${physics.map((dimension) => `const physics${dimension} = await initializeNativeRapier${dimension}D(createWechatWasmHost({ wx, WXWebAssembly }, 'payload/wasm/rapier${dimension}d.wasm.br').unwrap()); if (physics${dimension}.code) throw physics${dimension};`).join('\n')}
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const fibers = [];
  const channel = new MessageChannel();
  const assets = graphics.assets;
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true; lifetime.abort(); signal.removeEventListener('abort', abort);
    const failures = [];
    for (const fiber of fibers.reverse()) { try { await fiber.dispose(); } catch (error) { failures.push(error); } }
    channel.port1.close(); channel.port2.close();
    if (failures.length) throw new AggregateError(failures, 'WeChat game cleanup failed');
  };
  try {
  for (const plugin of [renderComponentsPlugin(), scenePlugin(), skinningPlugin(), animationPlugin(), statePlugin(), gameHostPlugin({ app, assets, canvas,
    drawingBufferSize: () => ({ width: canvas.width, height: canvas.height }),
    renderer: app.renderer, port: channel.port1, uiRoot: ui.document.querySelector('#game-ui'), gameProjection,
    startupTimeoutMs: ${JSON.stringify(facts.startupTimeoutMs)},
    controlMode: { read: () => 'touch', subscribe: () => () => {} },
    setPointerLockAllowed: () => {},
  })]) { const fiber = app.pluginContext.plugin(plugin); fibers.push(fiber); await fiber.await(); }
  if (engineRoot !== null) {
    const mounted = await activateExecutionRoot(app.pluginContext, { guid: engineRoot }, { signal: lifetime.signal, timeoutMs: ${JSON.stringify(facts.startupTimeoutMs)} });
    fibers.push(mounted.fiber);
  }
  if (frontendRoot !== null && active()) {
    const frontend = app.pluginContext.isolate('assets').isolate('gameHost').isolate('pluginPrograms');
    const provider = frontend.plugin({ name: 'wechat-frontend', provide: ['assets', 'gameHost', 'pluginPrograms'], apply(ctx) {
      const runtime = app.pluginContext.runtimePacks;
      const reader = new AssetRegistry({ catalog: runtime.catalog, fetcher: runtime.fetcher, scopeId: runtimeBinding.scopeId });
      ctx.provide('assets', reader); ctx.effect(() => () => reader.dispose());
      ctx.provide('gameHost', { ...app.pluginContext.gameHost, port: channel.port2 });
      ctx.provide('pluginPrograms', frontendPrograms('wechat-' + generation, 'frontend', generation));
    } });
    fibers.push(provider); await provider.await();
    const mounted = await activateExecutionRoot(frontend, { guid: frontendRoot }, { signal: lifetime.signal, timeoutMs: ${JSON.stringify(facts.startupTimeoutMs)} });
    fibers.push(mounted.fiber);
  }
  return { dispose: cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'WeChat game activation failed', { cause: error }); }
    throw error;
  }
}
`;
}
