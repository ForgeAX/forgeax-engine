import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthoredRuntimePack, EngineConfigurationDefinition } from '@forgeax/engine-app';
import type { Plugin } from 'vite';
import { DIST_MANIFEST_FILE } from '../dist.js';
import {
  engineConfigurationForAppOptions,
  nativeConfigurationControlSource,
} from '../host/engine-configuration.js';
import { gameProjectionSource } from '../host/game-projection-source.js';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import type { DevKitAppOptions } from '../plugin-build.js';
import type { BuildOptions, ProjectFacts } from '../types.js';
import { desktopAddon } from './desktop-addon.js';
import { emitDesktopAudioPayload } from './desktop-audio-payload.js';
import { preflightDesktopStartup } from './desktop-configuration.js';
import { staticPackTaskUrlSpecifier } from './execution-workers.js';
import {
  nativeGameSource,
  nativeHostSource,
  nativeWasmPackages,
  releaseNativePlayerSource,
} from './native-game-source.js';
import { emitNativeUiFonts } from './native-ui-fonts.js';
import { nativeGamePhysicsDimensions, type PluginSourceInventory } from './plugin-assets.js';
import { staticPackProgramsSource } from './static-pack-programs.js';

export async function prepareDesktopBuild(
  facts: ProjectFacts,
  generated: string,
  inventory: PluginSourceInventory,
  options: DevKitAppOptions,
  destination: {
    readonly authoredPacks: readonly AuthoredRuntimePack[];
    readonly platform?: BuildOptions['platform'];
    readonly arch?: BuildOptions['arch'];
  },
): Promise<{ readonly plugin: Plugin; readonly entry: string; readonly adapter: string }> {
  const dimensions = nativeGamePhysicsDimensions(inventory, facts.roots.engine);
  const runtime = fileURLToPath(new URL('./desktop-platform.mjs', import.meta.url));
  const platform =
    destination.platform === undefined
      ? process.platform
      : ({ windows: 'win32', macos: 'darwin', linux: 'linux' } as const)[destination.platform];
  const definition = engineConfigurationForAppOptions(options, 'browser');
  const preflight = preflightDesktopStartup(definition, platform);
  if (!preflight.ok) throw preflight.error;
  const addon = await desktopAddon(platform, destination.arch ?? process.arch);
  const nativeFile = addon.fileName;
  const adapter = existsSync(runtime)
    ? runtime
    : fileURLToPath(new URL('./desktop-platform.ts', import.meta.url));
  const entry = resolve(generated, 'desktop-main.ts');
  const taskWorker = resolve(generated, 'desktop-runtime-pack-worker.ts');
  await Promise.all([
    writeFile(entry, desktopSource(facts, adapter, options, definition, nativeFile, taskWorker)),
    writeFile(
      taskWorker,
      `import { parentPort } from 'node:worker_threads';
import { runtimePackTaskKinds } from '@forgeax/engine/import';
import { serveTaskWorker } from '@forgeax/engine/platform';
if (parentPort === null) throw new Error('Runtime Pack requires a Node Worker');
serveTaskWorker(parentPort, runtimePackTaskKinds);
`,
    ),
    writeFile(
      resolve(generated, 'desktop-game.ts'),
      nativeGameSource('desktop', dimensions, facts),
    ),
    writeFile(
      resolve(generated, 'desktop-programs.ts'),
      await staticPackProgramsSource(facts, inventory, {
        packs: destination.authoredPacks,
        generatedRoot: generated,
      }),
    ),
  ]);
  return {
    entry,
    adapter,
    plugin: {
      name: 'forgeax:desktop-player',
      enforce: 'pre',
      resolveId(id) {
        if (id === '@forgeax/engine-rhi-wgpu-native') return addon.module;
        return null;
      },
      async buildStart() {
        this.emitFile({
          type: 'asset',
          fileName: `native/${nativeFile}`,
          source: await addon.read(),
        });
        await emitDesktopAudioPayload(
          platform,
          destination.arch ?? process.arch,
          (fileName, source) => {
            this.emitFile({ type: 'asset', fileName, source });
          },
        );
        const engine = await this.resolve(
          '@forgeax/engine/package.json',
          resolve(facts.root, 'package.json'),
        );
        if (engine === null || engine.external)
          this.error('The project must resolve @forgeax/engine');
        for (const {
          module: pkg,
          wasm: [path, fileName],
        } of nativeWasmPackages(dimensions)) {
          const selected = await this.resolve(`${pkg}/package.json`, engine.id);
          if (selected === null || selected.external)
            this.error(`The Desktop player requires ${pkg}`);
          this.emitFile({
            type: 'asset',
            fileName,
            source: await readFile(resolve(dirname(selected.id), path)),
          });
        }
        await emitNativeUiFonts((fileName, source) => {
          this.emitFile({ type: 'asset', fileName, source });
        });
      },
    },
  };
}

function desktopSource(
  facts: ProjectFacts,
  adapter: string,
  options: DevKitAppOptions,
  definition: EngineConfigurationDefinition,
  nativeFile: string,
  taskWorker: string,
): string {
  const assembly = nativeHostSource(options, { target: 'desktop' });
  return `import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { audioPlugin } from '@forgeax/engine/audio';
import { WebAudioEngine, webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { decodeDocumentText } from '@forgeax/engine/codec';
import { createNativeWindow, installNavigatorGpu } from '@forgeax/engine-rhi-wgpu-native';
import { createDesktopFileStore, createDesktopGameSaves, createDesktopInput, createDesktopPackageFetcher, createDesktopPlatform, createDesktopPreferenceStorage, createDesktopRuntimePackCache, createDesktopRuntimePackTasks, desktopDeviceFacts, desktopPackageUrl, validateDesktopStartup } from ${JSON.stringify(adapter)};
import taskWorkerUrl from ${JSON.stringify(staticPackTaskUrlSpecifier(taskWorker))};
import { activate } from './desktop-game.ts';
${assembly.imports}

const base = new URL(/* @vite-ignore */ './', import.meta.url);
const fetcher = createDesktopPackageFetcher(fileURLToPath(base));
const wasm = name => ({
  now: () => performance.now(),
  readWasm: () => readFile(new URL('wasm/' + name + '.wasm', base)),
  instantiate: async (imports) => WebAssembly.instantiate(await readFile(new URL('wasm/' + name + '.wasm', base)), imports),
});
const releases = [];
const trace = phase => {
  if (env.FORGEAX_DESKTOP_TRACE === '1') console.info('[forgeax.desktop.startup]', phase);
};
const lifetime = new AbortController();
let stop;
let activation;
let app;
let ready = false;
let input;
let startup;
let completedFrames = 0;
let presentation;
let sceneAdmissions = 0;
let rendererErrors = 0;
let configuration;
const deviceFacts = desktopDeviceFacts(process.platform);
const launch = { id: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
const manifestDigest = readFile(new URL('${DIST_MANIFEST_FILE}', base))
  .then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null);
const projectKey = ${JSON.stringify(Buffer.from(facts.id, 'utf8').toString('base64url'))};
const dataRoot = process.platform === 'win32' ? env.LOCALAPPDATA ?? homedir() : join(homedir(), '.local', 'share');
const dataDirectory = join(dataRoot, 'ForgeaX', projectKey);
const preferences = createDesktopPreferenceStorage(join(dataDirectory, 'quality.json'));
const runtimePackCache = createDesktopRuntimePackCache(join(dataDirectory, 'cache', 'runtime-packs-v1'));
const gameSaves = createDesktopGameSaves(join(dataDirectory, 'saves'));
const files = createDesktopFileStore(join(dataDirectory, 'files-v1'));
releases.push(gameSaves.flush);
const store = createEngineConfigurationStore(preferences);
const definition = ${JSON.stringify(definition)};
function close() {
  if (stop) return stop;
  lifetime.abort();
  app?.stop();
  stop = releaseNativePlayer(releases, 'Desktop player cleanup failed');
  return stop;
}
function fail(error) {
  console.error('ForgeAX desktop player failed', error);
  process.exitCode = 1;
  void close().catch(cleanup => console.error(cleanup));
}
const onSignal = () => void close().catch(fail);
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
releases.push(() => {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
});
${releaseNativePlayerSource}${gameProjectionSource}
try {
  const plan = value(validateDesktopStartup(value(await prepareEngineStartup(definition, {
    readDeviceFacts: () => deviceFacts, store,
  }))));
  const configured = projectEngineStartup(plan);
  const window = value(createNativeWindow({ width: 1280, height: 720, title: ${JSON.stringify(facts.name)},
    addonPath: fileURLToPath(new URL(${JSON.stringify(`native/${nativeFile}`)}, base)),
  }));
  releases.push(() => value(window.close()));
  value(installNavigatorGpu(window.gpu));
  trace('window-open');
  const platform = createDesktopPlatform(window, () => void close().catch(fail), fail,
    (event, pixelRatio) => input?.accept(event, pixelRatio));
  releases.push(() => platform.dispose());
  const display = value(platform.display());
  const ui = await createBlitzUi({
    wasm: wasm('ui'),
    html: ${JSON.stringify(hostStartupDocument(facts.name).replace('</head>', '<link rel="stylesheet" href="ui-fonts/index.css"></head>'))},
    font: await readFile(new URL('ui-fonts/files/noto-sans-sc-latin-wght-normal.woff2', base)),
    fontFamily: 'Noto Sans SC Variable',
    width: display.drawingWidth, height: display.drawingHeight, pixelRatio: display.pixelRatio,
    resources: { baseUrl: desktopPackageUrl, read: async (url, signal) => {
      const response = await fetcher(url, { signal });
      if (!response.ok) throw new Error('Cannot read UI resource: ' + url);
      return new Uint8Array(await response.arrayBuffer());
    } },
  });
  if (lifetime.signal.aborted) { ui.dispose(); throw lifetime.signal.reason; }
  releases.push(() => ui.dispose());
  const preedit = ui.document.createElement('div');
  preedit.setAttribute('aria-hidden', 'true');
  preedit.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#17212d;color:white;padding:2px 5px;font:14px "Noto Sans SC Variable";text-decoration:underline';
  const updatePreedit = event => {
    const area = ui.input.focusedTextArea();
    if (!area || !event.data) return preedit.remove();
    preedit.textContent = ui.input.focusedText()?.type === 'password'
      ? '•'.repeat(Array.from(event.data).length) : event.data;
    preedit.style.left = area[0] + 'px';
    preedit.style.top = area[1] + 'px';
    if (!preedit.isConnected) ui.document.body.append(preedit);
  };
  const clearPreedit = () => preedit.remove();
  ui.document.addEventListener('compositionupdate', updatePreedit);
  ui.document.addEventListener('compositionend', clearPreedit);
  const stopPreeditFocus = ui.input.subscribeFocus(clearPreedit);
  releases.push(() => {
    stopPreeditFocus();
    ui.document.removeEventListener('compositionupdate', updatePreedit);
    ui.document.removeEventListener('compositionend', clearPreedit);
    clearPreedit();
  });
  trace('ui-created');
  const host = { document: ui.document, events: ui.document, surface: () => window.canvas,
    now: () => platform.now().unwrap(), visible: () => platform.visible(),
    reducedMotion: false, reload: () => void close().catch(fail) };
  startup = ${hostStartupScript(true, 'host')};
  releases.push(() => startup.destroy());
  const gamepads = value(window.gamepads()) === null ? undefined : () => value(window.gamepads());
  input = createDesktopInput(ui.input, locked => value(window.setPointerLock(locked)), {
    setImeArea: area => value(window.setImeArea(area)),
    gamepads,
  });
  startup.bindInput(enabled => input.setInputAllowed(enabled));
  releases.push(() => input.detach());
  releases.push(value(platform.subscribe(event => {
    if (event.kind === 'surface-lost') void close().catch(fail);
    if (event.kind === 'display') {
      ui.resize(event.display.drawingWidth, event.display.drawingHeight, event.display.pixelRatio);
      input.refreshImeArea();
    }
    if (event.kind === 'visibility') {
      if (!event.visible) input.clear();
      startup.visibilityChanged();
    }
  })));
  const canvas = window.canvas;
  ${assembly.graphics}
  if (lifetime.signal.aborted) { graphics.renderer.dispose(); throw lifetime.signal.reason; }
  releases.push(() => graphics.renderer.dispose());
  releases.push(graphics.renderer.subscribe(event => {
    if (event.kind === 'error' && env.FORGEAX_DESKTOP_TRACE === '1' && rendererErrors++ < 5)
      console.error('[forgeax.desktop.renderer]', event.error);
    if (event.kind !== 'state-changed' || event.current !== 'device-lost' || lifetime.signal.aborted) return;
    input.clear();
    void Promise.resolve().then(() => graphics.renderer.recover()).then(result => {
      if (lifetime.signal.aborted) return;
      if (!result.ok) fail(result.error);
      else trace('renderer-recovered');
    }).catch(fail);
  }));
  trace('renderer-constructed');
  ${assembly.catalog}
  ${assembly.world}
  const { AudioContext, mediaDevices } = await import(/* @vite-ignore */ new URL('audio/index.js', base).href);
  const audio = new WebAudioEngine({
    context: () => new AudioContext(),
    ownsContext: true,
    fetchStream: fetcher,
    enumerateOutputs: async () => {
      const outputs = new Map([['', { id: '', label: 'System default' }]]);
      for (const device of await mediaDevices.enumerateDevices()) {
        if (device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default') {
          outputs.set(device.deviceId, { id: device.deviceId, label: device.label || device.deviceId });
        }
      }
      return [...outputs.values()];
    },
  });
  releases.push(() => audio.destroy());
  const tasks = createDesktopRuntimePackTasks(taskWorkerUrl);
  releases.push(() => tasks.dispose());
  app = value(await createApp({
    ${assembly.app}
    sceneAdmission: () => {
      if (!ready) return 'ui-only';
      if (env.FORGEAX_DESKTOP_TRACE === '1') sceneAdmissions++;
      return 'scene';
    },
    onFrameSubmitted: detail => {
      configuration?.observe('submitted', { ...detail, presentation: detail.receipt?.presentation });
      startup.submitted(detail);
      if (env.FORGEAX_DESKTOP_TRACE === '1' && detail.receipt) {
        presentation = {
          frameId: detail.receipt.frameId,
          state: detail.receipt.presentation,
          pending: detail.receipt.presentationPendingReason,
        };
      }
    },
    onFrameCompleted: detail => {
      configuration?.observe('completed', detail);
      startup.enter(detail);
      if (ready && detail.presentation === 'ready' && completedFrames < 60 && ++completedFrames === 60) {
        const { capabilities, deviceInfo, diffuseGi } = graphics.renderer.inspect({
          fields: ['capabilities', 'deviceInfo', 'diffuseGi'],
        });
        const gi = diffuseGi === undefined ? null : {
          gather: diffuseGi.gather,
          state: diffuseGi.state,
          traversal: diffuseGi.traversal,
          fallback: diffuseGi.traversalFallback,
        };
        void manifestDigest.then(gameManifestSha256 => {
          console.info('[forgeax.desktop.completed]', JSON.stringify({
            schemaVersion: 1, launch, platform: deviceFacts.platform, arch: process.arch,
            nodeVersion: process.versions.node, projectId: ${JSON.stringify(facts.id)},
            profile: plan.profileId, gameManifestSha256, completedFrames: 60, frame: detail,
            backend: capabilities.backendKind, adapter: deviceInfo?.adapterInfo ?? null,
            rayQuery: capabilities.rayQuery, diffuseGi: gi,
          }));
        });
      }
    },
  }));
  if (lifetime.signal.aborted) { await app.dispose(); throw lifetime.signal.reason; }
  releases.push(async () => value(await app.dispose()));
  configuration = ${nativeConfigurationControlSource('definition', 'store')};
  Object.assign(app, { configuration });
  releases.push(async () => {
    configuration.dispose();
    await preferences.flush();
  });
  startup.bindSession(app.world.identity);
  releases.push(app.onError(error => {
    if (env.FORGEAX_DESKTOP_TRACE === '1') console.error('[forgeax.desktop.app]', error);
    const fault = app.execution.report().fault;
    if (fault !== undefined && fault !== null) fail(error);
  }));
  releases.push(async () => (await activation?.catch(() => undefined))?.dispose());
  value(app.start());
  value(await graphics.initialization);
  trace('renderer-ready');
  lifetime.signal.throwIfAborted();
  activation = activate({
    app, graphics, canvas, ui, input, wasm, audio, gameProjection, saves: gameSaves.saves, files, generation: 1,
    signal: lifetime.signal, active: () => !lifetime.signal.aborted,
  });
  await activation;
  lifetime.signal.throwIfAborted();
  ready = true;
  trace('project-roots-active');
  startup.prepare();
  if (env.FORGEAX_DESKTOP_TRACE === '1') {
    const startupSample = setTimeout(() => {
      if (completedFrames >= 60) return;
      const execution = app.execution.report();
      console.info('[forgeax.desktop.pending]', JSON.stringify({
        frames: execution.frame,
        sceneAdmissions,
        audio: execution.audio,
        renderer: graphics.renderer.state(),
        window: window.facts().unwrap(),
        presentation,
      }));
    }, 6000);
    releases.push(() => clearTimeout(startupSample));
  }
} catch (error) {
  if (!lifetime.signal.aborted) fail(error);
}
`;
}
