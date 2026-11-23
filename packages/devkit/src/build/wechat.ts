import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';
import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import { resolveLoadProgressLabels } from '@forgeax/engine-types';
import type { Plugin } from 'vite';
import { prepareDist } from '../delivery-dist.js';
import { collectDistManifest } from '../dist.js';
import {
  engineConfigurationForAppOptions,
  nativeConfigurationControlSource,
} from '../host/engine-configuration';
import { gameProjectionSource } from '../host/game-projection-source.js';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import { type HostVersions, hostVersions } from '../host/versions.js';
import type { DevKitAppOptions } from '../plugin-build.js';
import type { BuildOptions, ProjectFacts } from '../types.js';
import {
  nativeGameSource,
  nativeHostSource,
  nativeWasmPackages,
  releaseNativePlayerSource,
} from './native-game-source.js';
import { emitNativeUiFonts } from './native-ui-fonts.js';
import { nativeGamePhysicsDimensions, type PluginSourceInventory } from './plugin-assets.js';
import { staticPackProgramsSource } from './static-pack-programs.js';

const STARTUP_PRESENTATION_FILE = 'forgeax-wechat-startup.json';

function nativeFailureDefault(appOptions: DevKitAppOptions): boolean {
  const failure = appOptions.startupUi?.failure;
  return failure === undefined || failure === 'default';
}

/** Consume the build plugin's derived policy before collecting package artifacts. */
async function consumeStartupPresentation(outDir: string): Promise<{
  defaultFailure: boolean;
  packageFailureTitle: string;
  confirm: string;
}> {
  const path = resolve(outDir, STARTUP_PRESENTATION_FILE);
  const defaults = resolveLoadProgressLabels().host;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT')
      return {
        defaultFailure: true,
        packageFailureTitle: defaults.nativePackageFailureTitle,
        confirm: defaults.confirm,
      };
    throw cause;
  }
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('defaultFailure' in value) ||
    typeof value.defaultFailure !== 'boolean'
  ) {
    throw new Error('Invalid WeChat startup presentation handoff');
  }
  await rm(path);
  return {
    defaultFailure: value.defaultFailure,
    packageFailureTitle:
      'packageFailureTitle' in value && typeof value.packageFailureTitle === 'string'
        ? value.packageFailureTitle
        : defaults.nativePackageFailureTitle,
    confirm:
      'confirm' in value && typeof value.confirm === 'string' ? value.confirm : defaults.confirm,
  };
}

/** Native package preparation consumes the same SDK-owned payloads as public source builds. */
export async function prepareWechatBuild(
  facts: ProjectFacts,
  generated: string,
  inventory: PluginSourceInventory,
  appOptions: DevKitAppOptions = {},
  authoredPacks: readonly AuthoredRuntimePack[] = [],
) {
  const labels = resolveLoadProgressLabels(appOptions.loadingLabels);
  const physics = nativeGamePhysicsDimensions(inventory, facts.roots.engine);
  const staging = await realpath(await mkdtemp(resolve(generated, 'wechat-')));
  const native = resolve(staging, 'wgpu');
  await writeFile(
    resolve(generated, 'wechat-main.ts'),
    wechatHostSource(
      facts,
      native,
      process.env.FORGEAX_ENGINE_RHI_DEBUG === '1',
      appOptions,
      process.env.FORGEAX_WECHAT_CPU_PROFILE === '1',
      process.env.FORGEAX_WECHAT_FRAME_TRACE === '1',
      await hostVersions(facts),
    ),
  );
  await writeFile(resolve(generated, 'wechat-game.ts'), nativeGameSource('wechat', physics, facts));
  await writeFile(
    resolve(generated, 'wechat-programs.ts'),
    await staticPackProgramsSource(facts, inventory, {
      packs: authoredPacks,
      generatedRoot: generated,
      localOnly: true,
    }),
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
  console.error('ForgeAX graphics host failed', error);
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
  if (!${nativeFailureDefault(appOptions)}) return;
  let reason = ${JSON.stringify(labels.host.startupFailed)};
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
  wx.showModal?.({ title: ${JSON.stringify(labels.host.nativeStartupFailureTitle)},
    content: reason + '\\n\\n' + ${JSON.stringify(labels.host.nativeReloadHint)},
    confirmText: ${JSON.stringify(labels.reload)}, showCancel: false,
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
      const payloads = await Promise.all(
        nativeWasmPackages(physics).map(async (part) => ({
          ...part,
          root: dirname(await packageManifest(part.module, engineManifest)),
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
      ] as const) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(sourcePath) });
      }
      for (const { root, wasm, evidence } of payloads)
        for (const [path, fileName] of [wasm, ...evidence])
          this.emitFile({
            type: 'asset',
            fileName,
            source: await readFile(resolve(root, path)),
          });
      await emitNativeUiFonts((fileName, source) => {
        this.emitFile({ type: 'asset', fileName, source });
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: STARTUP_PRESENTATION_FILE,
        source: JSON.stringify({
          defaultFailure: nativeFailureDefault(appOptions),
          packageFailureTitle: labels.host.nativePackageFailureTitle,
          confirm: labels.host.confirm,
        }),
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
  const presentation = await consumeStartupPresentation(outDir);
  const entries = await readdir(outDir);
  const payload = resolve(outDir, 'payload');
  const player = await prepareDist(
    outDir,
    await collectDistManifest(facts, options.base ?? '/', outDir, 'wechat', 'compiled'),
    // Native Brotli shares repeated WGSL across Bundle entries. Inner zstd
    // obscures that repetition and increases the deployed package size.
    {
      distribution: 'payload',
      payloadRoot: payload,
      compressDocuments: false,
      compressEntries: false,
    },
  );
  for (const entry of entries) await rm(resolve(outDir, entry), { recursive: true });
  const compress = promisify(brotliCompress);
  const resources = player.manifest.artifacts.flatMap(({ path }) =>
    path.endsWith('.js') ? [] : [resolve(payload, path)],
  );
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
      `const packageLoad = { events: 0, progressAvailable: false };
const inspection = { phase: 'subpackage-loading', error: undefined, renderer: () => ({ state: 'initializing', phase: inspection.phase, lastError: inspection.error, packageLoad: { ...packageLoad } }) };
globalThis.__forgeaxGameInspection = inspection;
console.info('[forgeax.wechat.startup]', 'subpackage-loading');
const task = wx.loadSubpackage({ name: 'payload', success() { if (inspection.phase === 'subpackage-loading') inspection.phase = 'subpackage-loaded'; console.info('[forgeax.wechat.startup]', 'subpackage-loaded'); }, fail(error) {
  const nativeMessage = error && error.errMsg;
  const message = typeof nativeMessage === 'string' ? nativeMessage : String(error);
  inspection.phase = 'failed';
  inspection.error = { operation: 'wx.loadSubpackage', name: 'payload', message, cause: error };
  console.error('ForgeAX package failed', error);
  if (${presentation.defaultFailure}) wx.showModal({ title: ${JSON.stringify(presentation.packageFailureTitle)}, content: message, confirmText: ${JSON.stringify(presentation.confirm)}, showCancel: false });
} });
try {
  packageLoad.progressAvailable = !!task && typeof task.onProgressUpdate === 'function';
  if (packageLoad.progressAvailable && inspection.phase === 'subpackage-loading') task.onProgressUpdate(event => {
    if (inspection.phase !== 'subpackage-loading') return;
    packageLoad.events++;
    packageLoad.lastProgressAt = Date.now();
    try {
      for (const key of ['progress', 'totalBytesWritten', 'totalBytesExpectedToWrite']) {
        const value = event && event[key];
        if (Number.isSafeInteger(value) && value >= 0 && (key !== 'progress' || value <= 100)) packageLoad[key] = value;
        else packageLoad.invalidFields = (packageLoad.invalidFields || 0) + 1;
      }
    } catch (error) { packageLoad.observerError = String(error).slice(0, 512); }
  });
} catch (error) { packageLoad.observerError = String(error).slice(0, 512); }\n`,
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
  cpuProfile = false,
  frameTrace = false,
  versions?: HostVersions,
): string {
  const loadingLabels = resolveLoadProgressLabels(appOptions.loadingLabels);
  const assembly = nativeHostSource(appOptions, { target: 'wechat', rhiDebug, cpuProfile });
  return `import { createWechatPlatform, createWechatWasmHost, createWechatWgpuHost, createWechatInputBackend, createWechatAudioBackend, createWechatPackageFetcher, createWechatRecordStore, createWechatFileStore } from '@forgeax/engine/platform-wechat';
import { inspectUi } from '@forgeax/engine/ui';
import { ensureReady, rhi } from '@forgeax/engine/rhi-wgpu';
import * as nativeWgpu from ${JSON.stringify(resolve(native, 'wgpu-native.mjs'))};
${rhiDebug ? "import { attachRecorder } from '@forgeax/engine/rhi-debug';\nimport { createRhiCapture, createRhiInstrumentation } from '@forgeax/engine/app';\nimport { createShaderModule, createShaderModuleImmediate } from '@forgeax/engine/rhi-wgpu';" : ''}
${cpuProfile ? "import { createProfiler } from '@forgeax/engine/profiler';" : ''}
import { inspectPluginFiber } from '@forgeax/engine/plugin';
import { audioBackendPlugin, audioPlugin } from '@forgeax/engine/audio';
${assembly.imports}
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
  const profiler = ${cpuProfile ? 'createProfiler()' : 'undefined'};
  ${
    frameTrace
      ? `let frameReceiptTrace;
  let frameCaptureSequence = 0;
  const frameTraceStatistics = values => {
    if (values.length === 0) return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
    const sorted = values.slice().sort((a, b) => a - b);
    const percentile = fraction => sorted[Math.floor((sorted.length - 1) * fraction)];
    return { count: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted[sorted.length - 1] };
  };
  const frameTraceState = () => {
    const capture = frameReceiptTrace;
    if (capture === undefined) return { status: 'not-started' };
    const events = capture.events;
    const intervals = events.slice(1).map((event, index) => event.completedAtMs - events[index].completedAtMs);
    const submitToCompletion = events.flatMap(event => event.submitToCompletionMs === undefined ? [] : [event.submitToCompletionMs]);
    const ready = events.filter(event => event.presentation === 'ready');
    const worldIdentities = Array.from(new Set(events.map(event => event.worldIdentity).filter(Boolean)));
    const deviceGenerations = Array.from(new Set(events.map(event => event.deviceGeneration)));
    const first = events[0];
    const last = events[events.length - 1];
    const elapsedMs = first === undefined || last === undefined ? null : last.completedAtMs - first.completedAtMs;
    const complete = !capture.active && events.length === capture.frameLimit;
    const completionSilenceMs = wx.getPerformance().now() - (last?.completedAtMs ?? capture.startedAtMs);
    const status = capture.active
      ? completionSilenceMs > 1000 ? 'stalled' : 'capturing'
      : complete ? 'complete' : 'incomplete';
    return { status,
      captureId: capture.captureId, frameLimit: capture.frameLimit, sampleCount: events.length,
      droppedCount: capture.droppedCount, readyCount: ready.length, startedAtMs: capture.startedAtMs,
      finishedAtMs: capture.finishedAtMs ?? null, elapsedMs, completionSilenceMs,
      stopReason: capture.stopReason ?? null,
      completedFps: elapsedMs !== null && elapsedMs > 0 && events.length > 1 ? (events.length - 1) * 1000 / elapsedMs : null,
      readyFps: ready.length === events.length && elapsedMs !== null && elapsedMs > 0 && ready.length > 1
        ? (ready.length - 1) * 1000 / elapsedMs : null,
      frameIntervalMs: frameTraceStatistics(intervals), submitToCompletionMs: frameTraceStatistics(submitToCompletion),
      worldIdentities, deviceGenerations,
      submissionMatchCount: submitToCompletion.length };
  };
  const recordFrameSubmission = detail => {
    const capture = frameReceiptTrace;
    if (capture?.active !== true) return;
    if (capture.submittedAtMs.size >= 4) {
      capture.submittedAtMs.delete(capture.submittedAtMs.keys().next().value);
      capture.droppedCount++;
    }
    capture.submittedAtMs.set(detail.frameId, wx.getPerformance().now());
  };
  const recordFrameCompletion = detail => {
    const capture = frameReceiptTrace;
    if (capture?.active !== true) return;
    const completedAtMs = wx.getPerformance().now();
    const submittedAtMs = capture.submittedAtMs.get(detail.frameId);
    capture.submittedAtMs.delete(detail.frameId);
    const event = { frameId: detail.frameId, deviceGeneration: detail.deviceGeneration,
      presentation: detail.presentation, worldIdentity: detail.worldIdentity,
      completedAtMs, ...(submittedAtMs === undefined ? {} : { submitToCompletionMs: completedAtMs - submittedAtMs }) };
    capture.events.push(event);
    if (capture.events.length >= capture.frameLimit) {
      capture.active = false;
      capture.finishedAtMs = completedAtMs;
    }
  };`
      : ''
  }
  ${releaseNativePlayerSource}${gameProjectionSource}
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
    list: listGameProjection,
    read: readGameProjection, assets: () => graphics?.assets.inspect(), world: () => app?.world.inspect(),
    plugins: () => {
      const fibers = [];
      if (app === undefined) return { fibers, status: 'not-started' };
      for (const runtime of app.pluginContext.registry.values()) {
        for (const fiber of runtime.fibers) {
          if (fibers.length >= 128) return { fibers, truncated: true };
          fibers.push(inspectPluginFiber(fiber));
        }
      }
      return { fibers, truncated: false };
    },
    runtimePacks: () => app?.pluginContext.runtimePacks?.producer.inspect(),
    ${
      cpuProfile
        ? `profileStart: () => {
      const started = profiler.startCapture({ frameLimit: 180, eventLimit: 16384 });
      return started.ok ? { ok: true, captureId: profiler.activeCaptureId() } : { ok: false, error: started.error };
    }, profileState: () => ({ activeCaptureId: profiler.activeCaptureId(), latest: profiler.latestCapture() }),`
        : ''
    }
    ${
      frameTrace
        ? `frameReceiptTraceStart: () => {
      if (phase !== 'ready') return { ok: false, error: 'scene-not-ready' };
      if (frameReceiptTrace?.active === true) return { ok: false, error: 'capture-active', captureId: frameReceiptTrace.captureId };
      const captureId = identity + '-receipt-' + (++frameCaptureSequence);
      frameReceiptTrace = { captureId, active: true, frameLimit: 600, events: [], submittedAtMs: new Map(),
        droppedCount: 0, startedAtMs: wx.getPerformance().now(), finishedAtMs: undefined };
      return { ok: true, captureId, frameLimit: frameReceiptTrace.frameLimit, clock: 'wx.getPerformance().now' };
    }, frameReceiptTraceStop: () => {
      const capture = frameReceiptTrace;
      if (capture?.active !== true) return { ok: false, error: 'capture-not-active', state: frameTraceState() };
      capture.active = false;
      capture.stopReason = 'operator';
      capture.finishedAtMs = wx.getPerformance().now();
      return { ok: true, state: frameTraceState() };
    }, frameReceiptTraceState: frameTraceState,`
        : ''
    }
    renderer: () => ({ ...(app?.renderer.inspect() ?? { state: 'initializing' }),
    generation: identity, phase, completed, presented, execution: app?.execution.report(),
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
    await releaseNativePlayer(releases, 'WeChat Host cleanup failed', failures);
  };
  dispose = stop;
  try {
  const configurationDefinition = ${JSON.stringify(engineConfigurationForAppOptions(appOptions, 'wechat'))};
  const preferenceKey = ${JSON.stringify(`forgeax:quality:${facts.id}`)};
  const configurationStore = createEngineConfigurationStore({
    read: () => wx.getStorageSync(preferenceKey),
    write: bytes => wx.setStorageSync(preferenceKey, bytes),
  });
  const plan = value(await prepareEngineStartup(configurationDefinition, {
    readDeviceFacts() {
      const device = wx.getDeviceInfo?.() ?? {};
      const platform = device.platform === 'ios' || device.platform === 'android' ? device.platform : 'unknown';
      return { platform, runtime: 'wechat', ...(typeof device.model === 'string' && device.model ? { model: device.model } : {}) };
    },
    store: configurationStore,
  }));
  const configured = projectEngineStartup(plan);
  const unsupportedDomain = plan.settings.audio !== undefined ? 'audio.host/publication' : plan.settings.execution?.taskWorkers !== undefined || Object.values(plan.settings.execution?.workers ?? {}).includes(true) ? 'execution.workers' : configured.renderBackend !== undefined && configured.renderBackend !== 'auto' && configured.renderBackend !== 'webgpu' ? 'rendering.renderBackend' : undefined;
  if (unsupportedDomain !== undefined) throw new EngineConfigurationError('configuration-domain-unavailable', { path: unsupportedDomain, reason: 'the native WeChat Host does not construct this service or backend' });
  let configurationControl;
  advance('platform');
  // WeChat's first Canvas is the display surface, even if Platform admission fails.
  displayCanvas ??= wx.createCanvas();
  const platform = createWechatPlatform({ wx, requestAnimationFrame: callback => requestAnimationFrame(callback), cancelAnimationFrame: handle => cancelAnimationFrame(handle) }, displayCanvas).unwrap();
  releases.push(() => platform.dispose());
  const canvas = platform.canvas;
  const native = { wx, WXWebAssembly };
  const fetcher = createWechatPackageFetcher(wx, { root: 'payload', baseUrl: 'https://forgeax.package/', encoding: 'br' });
  const display = platform.display().unwrap();
  canvas.width = Math.max(1, Math.round(display.width * (configured.canvasPixelRatio ?? display.pixelRatio)));
  canvas.height = Math.max(1, Math.round(display.height * (configured.canvasPixelRatio ?? display.pixelRatio)));
  advance('ui-wasm-and-fonts');
  // Cancel pending UI initialization, but retire a live document after its consumers.
  const uiLifetime = new AbortController();
  releases.push(() => uiLifetime.abort());
  ui = await createBlitzUi({
    wasm: uiWasm ??= createWechatWasmHost(native, 'payload/wasm/ui.wasm.br').unwrap(),
    html: ${JSON.stringify(hostStartupDocument(facts.name, loadingLabels, versions, appOptions.startupUi).replace('</head>', '<link rel="stylesheet" href="ui-fonts/index.css"></head>'))},
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
  startup = ${hostStartupScript(true, 'host', loadingLabels, undefined, appOptions.startupUi)};
  const input = createWechatInputBackend(wx, platform, { ui: ui.input, keyboard: wx,
    onError: error => console.warn('ForgeAX native input failed', error) }).unwrap();
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
  ${assembly.graphics}
  releases.push(() => graphics.renderer.dispose());
  ${assembly.world}
  let game;
  let gameLoading;
  ${assembly.catalog}
  advance('app');
  const records = createWechatRecordStore(wx, ${JSON.stringify(facts.id)}, 'runtime-packs-v1');
  const saves = createRecordGameSaves(createWechatRecordStore(wx, ${JSON.stringify(facts.id)}, 'game-saves-v1'));
  const files = createWechatFileStore(wx, ${JSON.stringify(facts.id)}, 'game-files-v1');
  const runtimePackCache = {
    async read(key, signal) { return (await records.read(key, signal)).unwrap(); },
    async write(key, bytes, signal) {
      if (bytes.byteLength <= 32 * 1024 * 1024) (await records.replace(key, bytes, signal)).unwrap();
    },
  };
  app = (await createApp({
    ${assembly.app}
    ${rhiDebug ? 'rhiCapture,' : ''}
    ${cpuProfile ? 'profiler,' : ''}
    sceneAdmission: () => game !== undefined && startupError === undefined ? 'scene' : 'ui-only',
    onFrameSubmitted: detail => {
      configurationControl?.observe('submitted', { ...detail, presentation: detail.receipt?.presentation });
      if (closed || generation !== identity) return;
      ${frameTrace ? 'recordFrameSubmission(detail);' : ''}
      startup.submitted(detail);
    },
    onFrameCompleted: detail => {
      configurationControl?.observe('completed', detail);
      if (closed || generation !== identity) return;
      ${frameTrace ? 'recordFrameCompletion(detail);' : ''}
      completed += 1; lastCompletion = detail;
      if (game !== undefined && detail.presentation === 'ready') {
        presented += 1;
        if (presented === 60) console.info('[forgeax.wechat.completed]', JSON.stringify({ generation: identity, completed, presented, ...detail }));
      }
      startup.enter(detail);
    },
  })).unwrap();
  configurationControl = ${nativeConfigurationControlSource('configurationDefinition', 'configurationStore')};
  Object.assign(app, { configuration: configurationControl });
  releases.push(async () => { configurationControl.dispose(); (await app.dispose()).unwrap(); });
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
    gameLoading = module.activate({ app, graphics, ui, canvas, gameProjection, saves, files,
      generation: identity, signal: lifetime.signal, active: () => !closed && generation === identity });
    game = await gameLoading;
    if (closed || generation !== identity) { await game.dispose(); return; }
    if (appStartupErrors.length > 0) throw appStartupErrors[0];
    startup.prepare();
    advance('ready');
  } catch (error) { if (!closed && generation === identity) { console.error('ForgeAX game activation failed', error); fail(error); } } })();
  } catch (error) {
    if (closed) return;
    fail(error);
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'WeChat Host startup failed', { cause: error }); }
    throw error;
  }
}
`;
}
