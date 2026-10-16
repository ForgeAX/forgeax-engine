#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { analyzeGameplay, formatAnalysis } from './analyze_gameplay_performance.mjs';
import { nativeReleaseWitness } from './fixtures/gameplay-benchmark/native-release-witness.mjs';
import { createGameplayTimeline, PHASE_NAMES } from './fixtures/gameplay-benchmark/timeline.mjs';
import { selectTarget } from './profile_game_cpu.mjs';
import {
  assertGameplayRegion,
  createCdpContacts,
  executeTimeline,
  geometryFromInspection,
} from './run_gameplay_benchmark.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (code, detail) =>
  Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) });
const codeOf = (error) =>
  /^[a-z][a-z0-9-]+$/.test(error?.code ?? '')
    ? error.code
    : error?.name === 'AbortError'
      ? 'interrupted'
      : 'operation-failed';
const check = (condition, code, detail) => {
  if (!condition) throw failure(code, detail);
};
const pause = (milliseconds, signal) => delay(Math.max(0, milliseconds), undefined, { signal });
const neutral = (player) =>
  player?.controls?.horizontal === 0 &&
  player?.controls?.vertical === 0 &&
  player?.controls?.run === false;
const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);

export function configuration(options) {
  let endpoint;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw failure('invalid-endpoint');
  }
  check(
    ['http:', 'https:'].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      ['/', '/json/list'].includes(endpoint.pathname),
    'invalid-endpoint',
  );
  check(/^s\d+$/.test(options.window ?? ''), 'invalid-window');
  check(/^[a-f0-9]{64}$/.test(options.manifestSha256 ?? ''), 'invalid-manifest-sha256');
  check(options.project && options.out && options.targetPath, 'required-path-missing');
  const targetPath = options.targetPath;
  check(
    targetPath.startsWith(`/game/${options.window}/`) &&
      !targetPath.includes('?') &&
      !targetPath.includes('#') &&
      new URL(targetPath, endpoint).pathname === targetPath,
    'invalid-target-path',
  );
  const phaseMs = Number(options.phaseMs ?? 10000),
    maxLatenessMs = Number(options.maxLatenessMs ?? 100);
  check(Number.isInteger(phaseMs) && phaseMs >= 1000 && phaseMs <= 30000, 'invalid-phase-duration');
  check(
    Number.isFinite(maxLatenessMs) && maxLatenessMs > 0 && maxLatenessMs <= 100,
    'invalid-input-lateness',
  );
  check(
    ['unverified', 'contended'].includes(options.capacityStatus ?? 'unverified'),
    'invalid-capacity-status',
  );
  check(
    options.nativeReleaseWitness === undefined || typeof options.nativeReleaseWitness === 'boolean',
    'invalid-native-release-witness',
  );
  endpoint.pathname = '/json/list';
  return {
    ...options,
    endpoint: endpoint.href,
    targetPath,
    phaseMs,
    maxLatenessMs,
    project: resolve(options.project),
    publication: options.publication ? resolve(options.publication) : undefined,
    out: resolve(options.out),
    canvasSelector: options.canvasSelector ?? 'canvas',
    capacityStatus: options.capacityStatus ?? 'unverified',
  };
}

/** Verify the prepared native observer package, including its original source manifest. */
export async function verifyNativePublication(
  project,
  expectedManifestSha256,
  publication = project,
) {
  project = resolve(project);
  publication = resolve(publication);
  const manifestBytes = await readFile(join(publication, 'forgeax-dist.json'));
  check(sha(manifestBytes) === expectedManifestSha256, 'publication-manifest-mismatch');
  const benchmarkBytes = await readFile(join(publication, 'benchmark-manifest.json'));
  const manifest = JSON.parse(manifestBytes),
    benchmark = JSON.parse(benchmarkBytes);
  check(
    manifest.target === 'wechat' && benchmark.schemaVersion === 'forgeax-gameplay-native/1',
    'native-benchmark-required',
  );
  check(
    Array.isArray(manifest.artifacts) &&
      Array.isArray(benchmark.files) &&
      benchmark.files.length > 0,
    'invalid-publication-inventory',
  );
  check(
    benchmark.source?.diagnosticManifestSha256 === expectedManifestSha256 &&
      /^[a-f0-9]{40}$/.test(benchmark.source?.engineCommit ?? ''),
    'benchmark-source-mismatch',
  );
  const seen = new Map(),
    root = await realpath(publication),
    projectRoot = await realpath(project);
  check(
    (await readFile(join(project, 'benchmark-manifest.json'))).equals(benchmarkBytes),
    'benchmark-manifest-mismatch',
  );
  let configuration;
  for (const row of benchmark.files) {
    check(typeof row.path === 'string' && !seen.has(row.path), 'invalid-publication-inventory');
    seen.set(row.path, row);
    const path = resolve(publication, row.path);
    check(
      path.startsWith(publication + sep) && (await realpath(path)).startsWith(root + sep),
      'publication-path-escape',
    );
    const bytes = await readFile(path);
    check(bytes.length === row.bytes && sha(bytes) === row.sha256, 'publication-file-mismatch', {
      path: row.path,
    });
    const actualPath = resolve(project, row.path);
    check(
      actualPath.startsWith(project + sep) &&
        (await realpath(actualPath)).startsWith(projectRoot + sep),
      'publication-path-escape',
    );
    const actual = root === projectRoot ? bytes : await readFile(actualPath);
    if (row.path === 'project.config.json') {
      const additions = [];
      const extendsOriginal = (original, current, path = '') => {
        if (
          original &&
          current &&
          typeof original === 'object' &&
          typeof current === 'object' &&
          !Array.isArray(original) &&
          !Array.isArray(current)
        ) {
          for (const [key, value] of Object.entries(original)) {
            check(Object.hasOwn(current, key), 'publication-config-value-removed');
            extendsOriginal(
              value,
              current[key],
              `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
            );
          }
          for (const key of Object.keys(current))
            if (!Object.hasOwn(original, key))
              additions.push(`${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        } else check(isDeepStrictEqual(original, current), 'publication-config-value-changed');
      };
      extendsOriginal(JSON.parse(bytes), JSON.parse(actual));
      configuration = {
        declaredSha256: row.sha256,
        actualSha256: sha(actual),
        ideAdditionPaths: additions.sort(),
        policy:
          'Every frozen value retained; only new object fields admitted from an independently verified publication.',
      };
    } else check(actual.equals(bytes), 'project-file-mismatch', { path: row.path });
  }
  check(
    seen.has('forgeax-dist.json') &&
      seen.has('ordinary-forgeax-dist.json') &&
      seen.has('assembly-differences.json'),
    'incomplete-benchmark-inventory',
  );
  check(
    sha(await readFile(join(publication, 'ordinary-forgeax-dist.json'))) ===
      benchmark.source.publicationManifestSha256,
    'ordinary-source-manifest-mismatch',
  );
  for (const row of manifest.artifacts) {
    check(seen.has(row.path), 'untracked-publication-artifact', { path: row.path });
    const observed = seen.get(row.path);
    check(
      observed.bytes === row.bytes && observed.sha256 === row.sha256,
      'publication-artifact-mismatch',
      { path: row.path },
    );
  }
  check(configuration, 'publication-config-missing');
  return {
    source: benchmark.source,
    artifactCount: manifest.artifacts.length,
    verifiedFiles: seen.size,
    configuration,
  };
}

/** Minimal bounded CDP transport; the target selector is shared with the CPU tool. */
export async function connectCdp(url, signal) {
  const socket = new WebSocket(url),
    lifetime = new AbortController(),
    pending = new Map();
  let nextId = 0;
  const retire = (code) => {
    lifetime.abort(failure(code));
    for (const entry of pending.values()) entry.reject(failure(code));
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    let value;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      retire('cdp-invalid-response');
      return;
    }
    if (
      ['Runtime.executionContextsCleared', 'Inspector.detached'].includes(value.method) ||
      (value.method === 'Page.frameNavigated' && !value.params?.frame?.parentId)
    ) {
      retire('cdp-target-replaced');
      return;
    }
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    if (value.error)
      entry.reject(
        Object.assign(
          failure('cdp-command-rejected', { method: entry.method, nativeError: value.error }),
          {
            message: value.error.message ?? 'cdp-command-rejected',
          },
        ),
      );
    else entry.resolve(value.result);
  });
  socket.addEventListener('close', () => retire('cdp-socket-closed'));
  socket.addEventListener('error', () => retire('cdp-socket-error'));
  try {
    await new Promise((done, reject) => {
      const finish = (callback) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        lifetime.signal.removeEventListener('abort', closed);
        socket.removeEventListener('open', opened);
        callback();
      };
      const opened = () => finish(done),
        aborted = () => finish(() => reject(failure('interrupted'))),
        closed = () => finish(() => reject(lifetime.signal.reason));
      const timer = setTimeout(() => finish(() => reject(failure('cdp-connect-timeout'))), 10000);
      socket.addEventListener('open', opened, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
      lifetime.signal.addEventListener('abort', closed, { once: true });
      if (signal?.aborted) aborted();
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    signal: lifetime.signal,
    send(method, params = {}, { signal: operationSignal, timeoutMs = 10000 } = {}) {
      if (operationSignal?.aborted) return Promise.reject(failure('interrupted'));
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(failure('cdp-socket-closed'));
      return new Promise((done, reject) => {
        const id = ++nextId;
        const finish = (callback) => (value) => {
          clearTimeout(timer);
          operationSignal?.removeEventListener('abort', aborted);
          pending.delete(id);
          callback(value);
        };
        const rejected = finish(reject),
          resolved = finish(done),
          aborted = () => rejected(failure('interrupted'));
        const timer = setTimeout(
          () => rejected(failure('cdp-command-timeout', { method })),
          timeoutMs,
        );
        pending.set(id, { method, resolve: resolved, reject: rejected });
        operationSignal?.addEventListener('abort', aborted, { once: true });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch {
          rejected(failure('cdp-send-failed'));
        }
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return true;
      const closed = new Promise((done) => {
        const timer = setTimeout(() => done(false), 2000);
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(timer);
            done(true);
          },
          { once: true },
        );
      });
      socket.close();
      retire('cdp-socket-closed');
      return closed;
    },
  };
}

export async function evaluate(cdp, fn, argument, signal, timeoutMs = 10000) {
  const response = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(${fn.toString()})(${JSON.stringify(argument ?? null)})`,
      returnByValue: true,
      awaitPromise: true,
    },
    { signal, timeoutMs },
  );
  check(!response?.exceptionDetails, 'game-evaluation-failed', response?.exceptionDetails);
  const value = response?.result?.value;
  check(
    typeof value?.failure !== 'object' || value.failure === null,
    value?.failure?.code ?? 'game-evaluation-failed',
    value?.failure?.detail,
  );
  return value;
}

/** Runs only outside the timing window, in the existing simulator page. */
export async function inspectSimulator({
  canvasSelector = 'canvas',
  geometry = false,
  probeToken,
  compact = false,
  inputOnly = false,
} = {}) {
  const fail = (code, detail) => ({ failure: { code, detail } });
  const game = globalThis.GameGlobal?.__gameContextWindow;
  const owner = game?.__forgeaxGameInspection,
    observer = game?.__gameplayBenchmark;
  if (!owner || (!inputOnly && !observer)) return fail('native-benchmark-not-loaded');
  const readInput = async () => {
    const player = await owner.read('game-3d.player');
    const value = {
      player:
        compact || inputOnly
          ? {
              position: player?.position,
              grounded: player?.grounded,
              controls: {
                horizontal: player?.controls?.horizontal,
                vertical: player?.controls?.vertical,
                run: player?.controls?.run,
              },
              camera: { yaw: player?.camera?.yaw, pitch: player?.camera?.pitch },
              simulation: { fixedTick: player?.simulation?.fixedTick },
            }
          : player,
    };
    if (probeToken) {
      const probe = game.__forgeaxSimulatorTouchProbe;
      if (!probe || probe.token !== probeToken) return fail('touch-observer-replaced');
      value.touch = probe.snapshot({ compact: compact || inputOnly });
    }
    return value;
  };
  if (inputOnly) return readInput();
  if (!['status', 'arm', 'abort', 'drain'].every((name) => typeof observer[name] === 'function'))
    return fail('observer-api-unavailable');
  const renderer = owner.renderer();
  if (renderer.startupError || renderer.lastError) {
    const error = renderer.startupError ?? renderer.lastError;
    return fail(
      'ordinary-game-failed',
      JSON.parse(
        JSON.stringify(error, (_key, value) =>
          value && typeof value === 'object' && typeof value.message === 'string'
            ? {
                name: value.name,
                code: value.code,
                message: value.message,
                detail: value.detail,
                cause: value.cause,
              }
            : value,
        ),
      ),
    );
  }
  if ('rhiCapture' in owner) return fail('recorder-attached');
  const status = observer.status();
  const state = {
    targetPath: new URL(globalThis.location.href).pathname,
    renderer: compact
      ? {
          phase: renderer.phase,
          generation: renderer.generation,
          presented: renderer.presented,
          lastCompletion: {
            frameId: renderer.lastCompletion?.frameId,
            presentation: renderer.lastCompletion?.presentation,
            worldIdentity: renderer.lastCompletion?.worldIdentity,
            deviceGeneration: renderer.lastCompletion?.deviceGeneration,
          },
        }
      : renderer,
    observer: compact
      ? {
          readyCompletions: status.readyCompletions,
          failure: status.failure,
          armed: status.armed,
          ended: status.ended,
        }
      : status,
    visible: game.document?.visibilityState ?? globalThis.document?.visibilityState ?? null,
  };
  if (renderer.phase !== 'ready' || status.readyCompletions < 60) return state;
  const input = await readInput();
  if (input.failure) return input;
  Object.assign(state, input);
  const vase = await owner.read('game-3d.runtime-vase');
  state.vase = compact
    ? { vertexCount: vase?.vertexCount, busy: vase?.busy, error: vase?.error }
    : vase;
  if (geometry) {
    const result = owner.ui({ selector: '[data-ui-part]', limit: 512 });
    if (!result.ok) return fail('ui-inspection-failed', result.error);
    state.ui = result.value;
    const doc = globalThis.GameGlobal?.document;
    const canvases = doc?.querySelectorAll?.(canvasSelector);
    if (!canvases || canvases.length !== 1)
      return fail('canvas-ambiguous', { count: canvases?.length ?? null });
    const canvas = canvases[0],
      rect = canvas.getBoundingClientRect?.();
    // The generated Host consumes this realm's wx. DevTools exposes additional
    // wrapper objects; reference inequality does not identify another display.
    if (typeof game.wx?.getWindowInfo !== 'function')
      return fail('game-native-display-unavailable', { source: 'game-realm' });
    const aliases = [];
    for (const [source, api] of [
      ['game-realm', game.wx],
      ['GameGlobal.wx', globalThis.GameGlobal?.wx],
      ['globalThis.wx', globalThis.wx],
    ]) {
      if (typeof api?.getWindowInfo !== 'function') {
        aliases.push({ source, available: false });
        continue;
      }
      let info;
      try {
        info = api.getWindowInfo();
      } catch (error) {
        return fail('native-display-read-failed', {
          source,
          message: error?.message ?? String(error),
        });
      }
      if (
        !info ||
        !['windowWidth', 'windowHeight', 'pixelRatio'].every(
          (key) => Number.isFinite(info[key]) && info[key] > 0,
        )
      )
        return fail('native-display-invalid', { source });
      const dimensions = Object.fromEntries(
        [
          'windowWidth',
          'windowHeight',
          'pixelRatio',
          'screenWidth',
          'screenHeight',
          'statusBarHeight',
        ]
          .filter((key) => info[key] !== undefined)
          .map((key) => [key, info[key]]),
      );
      if (info.safeArea)
        dimensions.safeArea = Object.fromEntries(
          ['left', 'top', 'right', 'bottom', 'width', 'height'].map((key) => [
            key,
            info.safeArea[key],
          ]),
        );
      const expected = aliases[0]?.dimensions;
      if (expected && JSON.stringify(dimensions) !== JSON.stringify(expected))
        return fail('native-display-source-mismatch', {
          source: 'game-realm',
          comparedSource: source,
          expected,
          actual: dimensions,
        });
      aliases.push({ source, available: true, dimensions });
    }
    const display = aliases[0].dimensions;
    state.nativeDisplay = { source: 'game-realm', aliases };
    state.extent = {
      width: display.windowWidth,
      height: display.windowHeight,
      dpr: display.pixelRatio,
      drawingWidth: canvas.width,
      drawingHeight: canvas.height,
    };
    state.canvasRect = rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    state.viewport = { width: globalThis.innerWidth, height: globalThis.innerHeight };
    const gl = canvas.getContext?.('webgl2');
    if (!gl) return fail('native-webgl2-unavailable');
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    state.driver = {
      renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      unmasked: !!extension,
    };
  }
  return state;
}

export function controlGeometry(state) {
  const native = geometryFromInspection(state.ui),
    { extent, canvasRect: rect, viewport } = state;
  check(
    extent &&
      ['width', 'height', 'dpr', 'drawingWidth', 'drawingHeight'].every(
        (key) => Number.isFinite(extent[key]) && extent[key] > 0,
      ),
    'invalid-native-extent',
  );
  check(
    rect &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
      rect.width > 0 &&
      rect.height > 0,
    'canvas-geometry-unavailable',
  );
  check(
    viewport &&
      Number.isInteger(viewport.width) &&
      Number.isInteger(viewport.height) &&
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.width <= viewport.width + 0.5 &&
      rect.y + rect.height <= viewport.height + 0.5,
    'canvas-outside-cdp-viewport',
  );
  check(
    Object.values(native).every(
      (value) =>
        value &&
        ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
        value.width > 4 &&
        value.height > 4 &&
        value.x >= 0 &&
        value.y >= 0 &&
        value.x + value.width <= extent.width &&
        value.y + value.height <= extent.height,
    ),
    'native-controls-outside-extent',
  );
  const css = Object.fromEntries(
    Object.entries(native).map(([role, value]) => [
      role,
      {
        x: rect.x + (value.x * rect.width) / extent.width,
        y: rect.y + (value.y * rect.height) / extent.height,
        width: (value.width * rect.width) / extent.width,
        height: (value.height * rect.height) / extent.height,
      },
    ]),
  );
  return { native, css, coordinateSpace: { unit: 'css-px', ...viewport } };
}

/** Public wx event subscription, never a handler invocation or production hook. */
export function installNativeTouchProbe({ token, maxEvents = 512 }) {
  const game = globalThis.GameGlobal?.__gameContextWindow;
  const fail = (code, detail) => ({ failure: { code, detail } });
  if (!game || game.__forgeaxSimulatorTouchProbe) return fail('touch-observer-already-present');
  const names = ['Start', 'Move', 'End', 'Cancel'];
  const source = game.wx;
  const missing = names
    .flatMap((name) => [`onTouch${name}`, `offTouch${name}`])
    .filter((name) => typeof source?.[name] !== 'function');
  if (missing.length)
    return fail('game-native-touch-unavailable', { source: 'game-realm', missing });
  const events = [],
    active = new Map(),
    leases = [];
  let failure = null,
    released = false;
  const probe = {
    token,
    snapshot: ({ compact = false } = {}) => ({
      source: 'game-realm',
      events: compact ? events.slice(-8) : events.slice(),
      eventCount: events.length,
      active: [...active.values()].slice(0, compact ? 8 : undefined),
      activeCount: active.size,
      failure,
      released,
    }),
    release() {
      for (const [name, listener] of leases.splice(0).reverse()) {
        try {
          source[`offTouch${name}`](listener);
        } catch {
          failure ??= 'touch-observer-release-failed';
        }
      }
      released = failure !== 'touch-observer-release-failed';
      if (game.__forgeaxSimulatorTouchProbe === probe) delete game.__forgeaxSimulatorTouchProbe;
      else failure ??= 'touch-observer-replaced';
      return probe.snapshot();
    },
  };
  game.__forgeaxSimulatorTouchProbe = probe;
  try {
    for (const name of names) {
      const listener = (event) => {
        if (events.length >= maxEvents) {
          failure ??= 'touch-observer-overflow';
          return;
        }
        if (!Array.isArray(event.changedTouches) || event.changedTouches.length > 8) {
          failure ??= 'invalid-native-touch-batch';
          return;
        }
        const touches = event.changedTouches.map((touch) => ({
          id: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
        }));
        if (
          touches.some(
            (touch) =>
              !Number.isSafeInteger(touch.id) ||
              !Number.isFinite(touch.x) ||
              !Number.isFinite(touch.y),
          )
        ) {
          failure ??= 'invalid-native-touch';
          return;
        }
        const phase = name.toLowerCase();
        for (const touch of touches) {
          if (name === 'Start') {
            if (active.has(touch.id)) failure ??= 'duplicate-native-touch-start';
            active.set(touch.id, touch);
          } else if (name === 'Move') {
            if (!active.has(touch.id)) failure ??= 'native-move-without-start';
            active.set(touch.id, touch);
          } else active.delete(touch.id);
        }
        events.push({ phase, atMs: Date.now(), changedTouches: touches });
      };
      leases.push([name, listener]);
      source[`onTouch${name}`](listener);
    }
  } catch {
    const result = probe.release();
    return fail('touch-observer-install-failed', result);
  }
  return { installed: true, token, source: 'game-realm' };
}

export function verifyNativeContacts(touch, contacts, state) {
  check(
    touch && !touch.failure && !touch.released,
    touch?.failure ?? 'native-touch-evidence-missing',
  );
  check(touch.active.length === contacts.length, 'native-touch-cardinality-mismatch', {
    expected: contacts.length,
    actual: touch.active.length,
  });
  const used = new Set(),
    identities = {};
  for (const contact of contacts) {
    const x = ((contact.x - state.canvasRect.x) * state.extent.width) / state.canvasRect.width;
    const y = ((contact.y - state.canvasRect.y) * state.extent.height) / state.canvasRect.height;
    const matches = touch.active.filter(
      (point) => !used.has(point.id) && Math.abs(point.x - x) <= 2 && Math.abs(point.y - y) <= 2,
    );
    check(matches.length === 1, 'native-touch-coordinate-mismatch', { role: contact.role });
    used.add(matches[0].id);
    identities[contact.role] = matches[0].id;
  }
  return identities;
}

function validateState(state, targetPath, identity) {
  check(state?.targetPath === targetPath, 'game-target-mismatch');
  check(state.visible !== 'hidden', 'game-hidden');
  check(
    state.renderer?.phase === 'ready' &&
      state.observer?.readyCompletions >= 60 &&
      !state.observer.failure,
    'game-not-ready',
  );
  const completion = state.renderer.lastCompletion;
  check(
    completion?.presentation === 'ready' &&
      typeof completion.worldIdentity === 'string' &&
      Number.isSafeInteger(completion.deviceGeneration),
    'scene-completion-unproven',
  );
  check(
    Number.isSafeInteger(state.renderer.generation) &&
      Number.isSafeInteger(state.renderer.presented) &&
      state.renderer.presented >= 60,
    'scene-generation-unproven',
  );
  const current = {
    host: state.renderer.generation,
    world: completion.worldIdentity,
    device: completion.deviceGeneration,
  };
  if (identity)
    check(JSON.stringify(current) === JSON.stringify(identity), 'game-identity-changed');
  check(
    state.player?.position?.length === 3 &&
      state.player.position.every(Number.isFinite) &&
      Number.isFinite(state.player.camera?.yaw),
    'player-observation-invalid',
  );
  check(
    state.vase && state.vase.vertexCount > 0 && !state.vase.error && !state.vase.busy,
    'ordinary-vase-unavailable',
  );
  return current;
}

export async function qualifySimulator({
  cdp,
  dispatch,
  config,
  state,
  geometry,
  token,
  signal,
  now = () => performance.now(),
  sleep = pause,
  record = async () => {},
}) {
  let stage = 'initial-state',
    expected = 'Ready ordinary game with stable identity',
    last = null;
  try {
    const identity = validateState(state, config.targetPath),
      rows = [];
    const read = async () => {
      const value = await evaluate(
        cdp,
        inspectSimulator,
        { probeToken: token, compact: true },
        signal,
      );
      last = value;
      validateState(value, config.targetPath, identity);
      return value;
    };
    const send = async (nextStage, contacts) => {
      stage = nextStage;
      expected = { nativeContacts: contacts.map((contact) => ({ ...contact })) };
      await dispatch(contacts);
    };
    const settle = async (nextStage, expectation, predicate) => {
      stage = nextStage;
      expected = expectation;
      const deadline = now() + 15000;
      do {
        const value = await read();
        if (predicate(value)) return value;
        await sleep(80, signal);
      } while (now() < deadline);
      throw failure('gameplay-semantic-timeout');
    };
    const center = (role, id) => ({
      role,
      id,
      x: geometry[role].x + geometry[role].width / 2,
      y: geometry[role].y + geometry[role].height / 2,
    });
    const moving = () => {
      const point = center('move', 1);
      point.y -= Math.min(geometry.move.width, geometry.move.height) * 0.3;
      return point;
    };
    const released = async (prefix) => {
      stage = `${prefix}.release-command`;
      expected = 'All contacts released';
      await dispatch([]);
      const value = await settle(
        `${prefix}.released`,
        'No native contacts; neutral controls and grounded=true',
        (value) =>
          value.touch?.activeCount === 0 && neutral(value.player) && value.player.grounded === true,
      );
      verifyNativeContacts(value.touch, [], state);
      const stopped = await settle(
        `${prefix}.stopped`,
        { additionalCompletions: 3, additionalFixedTicks: 4, from: value.player },
        (next) =>
          next.renderer.presented >= value.renderer.presented + 3 &&
          next.player.simulation.fixedTick >= value.player.simulation.fixedTick + 4,
      );
      check(
        neutral(stopped.player) &&
          stopped.player.grounded === true &&
          distance(stopped.player, value.player) < 0.005 &&
          Math.abs(stopped.player.camera.yaw - value.player.camera.yaw) < 0.005,
        'released-controls-not-stopped',
      );
      verifyNativeContacts(stopped.touch, [], state);
      return stopped;
    };
    const before = await released('independent.initial'),
      move = moving(),
      run = center('run', 3);
    await send('independent.walk-command', [move]);
    const walking = await settle(
      'independent.walk',
      { verticalAbove: 0.5, distanceAbove: 0.02, from: before.player.position },
      (value) =>
        value.player.controls.vertical > 0.5 && distance(value.player, before.player) > 0.02,
    );
    const firstIds = verifyNativeContacts(walking.touch, [move], state);
    await send('independent.run-command', [move, run]);
    const running = await settle(
      'independent.run',
      { run: true, verticalAbove: 0.5 },
      (value) => value.player.controls.run && value.player.controls.vertical > 0.5,
    );
    const heldIds = verifyNativeContacts(running.touch, [move, run], state);
    check(firstIds.move === heldIds.move, 'native-held-contact-replaced');
    await send('independent.run-release-command', [move]);
    const independent = await settle(
      'independent.run-release',
      { run: false, verticalAbove: 0.5, distanceAbove: 0.02, from: running.player.position },
      (value) =>
        !value.player.controls.run &&
        value.player.controls.vertical > 0.5 &&
        distance(value.player, running.player) > 0.02,
    );
    check(
      verifyNativeContacts(independent.touch, [move], state).move === firstIds.move,
      'native-held-contact-replaced',
    );
    rows.push({
      name: 'independent-run-release',
      before,
      walking,
      running,
      independent,
      released: await released('independent.final'),
    });
    await record(rows);
    for (const name of PHASE_NAMES) {
      const before = await released(`${name}.initial`),
        look = center('look', 2);
      const contacts = [
        ...(name === 'jump' ? [] : [moving()]),
        look,
        ...(['run', 'run-jump'].includes(name) ? [center('run', 3)] : []),
      ];
      await send(`${name}.initial-contacts`, contacts);
      await sleep(150, signal);
      const startedIds = verifyNativeContacts((await read()).touch, contacts, state);
      look.x += Math.min(geometry.look.width * 0.15, 30);
      if (name.includes('jump')) contacts.push(center('jump', 4));
      await send(`${name}.active-command`, contacts);
      const active = await settle(
        `${name}.active`,
        {
          newCompletionAndFixedTick: true,
          yawChangeAbove: 0.02,
          run: name.startsWith('run'),
          vertical: name === 'jump' ? 'abs < 0.001' : '> 0.5',
          distanceAbove: name === 'jump' ? null : 0.02,
          airborneAndHeightAbove: name.includes('jump') ? 0.04 : null,
          from: before.player,
        },
        (value) =>
          value.renderer.presented > before.renderer.presented &&
          value.player.simulation.fixedTick > before.player.simulation.fixedTick &&
          Math.abs(value.player.camera.yaw - before.player.camera.yaw) > 0.02 &&
          value.player.controls.run === name.startsWith('run') &&
          (name === 'jump'
            ? Math.abs(value.player.controls.vertical) < 0.001
            : value.player.controls.vertical > 0.5 &&
              distance(value.player, before.player) > 0.02) &&
          (!name.includes('jump') ||
            (value.player.grounded === false &&
              value.player.position[1] > before.player.position[1] + 0.04)),
      );
      const nativeIds = verifyNativeContacts(active.touch, contacts, state);
      check(
        Object.entries(startedIds).every(([role, id]) => nativeIds[role] === id),
        'native-held-contact-replaced',
      );
      const stopped = await released(`${name}.final`);
      rows.push({ name, before, active, nativeIds, released: stopped });
      await record(rows);
    }
    return {
      success: true,
      identity,
      rows,
      scope:
        'Public wx native events and actual ordinary-game controls; CDP ACK alone is not a pass.',
    };
  } catch (error) {
    throw failure(codeOf(error), {
      stage,
      expected,
      last,
      cause: {
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    });
  }
}

async function saveImage(cdp, out, name, signal) {
  const response = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', fromSurface: true, captureBeyondViewport: false },
    { signal },
  );
  check(
    typeof response.data === 'string' && response.data.length <= 32 * 1024 * 1024,
    'screenshot-unavailable',
  );
  const bytes = Buffer.from(response.data, 'base64');
  check(
    bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'screenshot-invalid',
  );
  await writeFile(join(out, name), bytes, { flag: 'wx', mode: 0o600 });
  return {
    file: name,
    sha256: sha(bytes),
    bytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    review: 'pending',
  };
}

export async function runSimulatorGameplayBenchmark(options, dependencies = {}) {
  const config = configuration(options),
    emit = dependencies.emit ?? ((value) => console.log(JSON.stringify(value)));
  const now = dependencies.now ?? (() => performance.now()),
    sleep = dependencies.sleep ?? pause;
  const verify = dependencies.verify ?? verifyNativePublication,
    connect = dependencies.connect ?? connectCdp;
  const discover =
    dependencies.discover ??
    (async (endpoint, signal) => {
      const response = await fetch(endpoint, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      check(response.ok, 'endpoint-unavailable');
      return response.json();
    });
  await mkdir(config.out, { mode: 0o700 });
  const report = {
    schemaVersion: 'forgeax-gameplay-run/1',
    host: 'official-wechat-simulator',
    window: config.window,
    targetPath: config.targetPath,
    toolVerification: false,
    ...(config.nativeReleaseWitness ? { diagnostic: 'native-release-witness' } : {}),
    errors: [],
    success: false,
    startedAtUtc: new Date().toISOString(),
    performanceQualification: {
      status: config.capacityStatus,
      reason:
        'Caller owns simultaneous capacity evidence and image review; this runner cannot promote that evidence.',
    },
    identityScope:
      'Verified local native benchmark bytes plus the selected running window and callback owner; executing script bytes are not independently attested.',
    cleanup: {
      contactsReleased: null,
      nativeContactsReleased: null,
      touchObserverReleased: null,
      drained: null,
      socketClosed: true,
      ...(config.nativeReleaseWitness ? { nativeReleaseObserverReleased: null } : {}),
    },
  };
  const signal = AbortSignal.any([
    dependencies.signal ?? new AbortController().signal,
    AbortSignal.timeout(300000),
  ]);
  let cdp,
    dispatch,
    probeToken,
    releaseToken,
    identity,
    timingEndsAt,
    terminalDispatch,
    armed = false,
    runSignal = signal;
  const json = (name, value) =>
    writeFile(join(config.out, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  // Two bounded post-window samples at most. Native callbacks never acknowledge CDP input.
  const observeNativeRelease = async (stage) => {
    if (!releaseToken || timingEndsAt === undefined || now() < timingEndsAt) return false;
    report.terminalNativeRelease ??= { samples: [] };
    const evidence = report.terminalNativeRelease;
    const sample = { stage };
    evidence.samples.push(sample);
    try {
      sample.touch = await evaluate(
        cdp,
        nativeReleaseWitness,
        { action: 'snapshot', token: releaseToken },
        undefined,
        1500,
      );
      sample.state = await evaluate(cdp, inspectSimulator, { compact: true }, undefined, 1500);
      sample.wire = dispatch.wireMetrics();
      validateState(sample.state, config.targetPath, identity);
      const alignment = report.clockAlignment.nativeRelease,
        nativeEvent = sample.touch.events.at(-1),
        input = report.inputDispatch,
        lastInput = input?.events?.at(-1);
      sample.terminalTiming = {
        dispatch: terminalDispatch ?? null,
        // The native clock was sampled somewhere inside the arm request/response.
        // One extra millisecond conservatively covers clock quantization.
        earliestPageMs:
          terminalDispatch && alignment
            ? terminalDispatch.sentAtRunnerMs + alignment.pageNowMs - alignment.afterRunnerMs - 1
            : null,
        latestPageMs:
          terminalDispatch && alignment
            ? terminalDispatch.sentAtRunnerMs + alignment.pageNowMs - alignment.beforeRunnerMs + 1
            : null,
        eventPageMs: nativeEvent?.pageNowMs ?? null,
        observedPageMs: sample.touch.clock?.pageNowMs ?? null,
      };
      const timing = sample.terminalTiming;
      timing.matched =
        [
          timing.earliestPageMs,
          timing.latestPageMs,
          timing.eventPageMs,
          timing.observedPageMs,
        ].every(Number.isFinite) &&
        Number.isInteger(input?.expectedEvents) &&
        input.sentEvents === input.expectedEvents &&
        Number.isFinite(lastInput?.sentMs) &&
        lastInput.scheduledMs === report.clockAlignment.endMs - report.clockAlignment.startMs &&
        timing.eventPageMs >= timing.latestPageMs &&
        timing.eventPageMs <= timing.observedPageMs;
      report.cleanup.nativeContactsReleased =
        sample.touch.nativeReleased === true && timing.matched;
      const released =
        report.cleanup.nativeContactsReleased &&
        neutral(sample.state.player) &&
        sample.state.player.grounded === true &&
        sample.wire.pendingWireCommands === 0;
      evidence.outcome = released
        ? sample.wire.releaseConfirmed
          ? 'native-released-acknowledged'
          : 'native-released-ack-unconfirmed'
        : sample.touch.failure
          ? 'native-evidence-invalid'
          : sample.touch.starts === 0
            ? 'native-start-not-observed'
            : 'native-release-unproven';
      return released;
    } catch (error) {
      sample.failure = {
        code: codeOf(error),
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      };
      evidence.outcome = 'native-evidence-invalid';
      report.cleanup.nativeContactsReleased = false;
      return false;
    }
  };
  try {
    const publication = await verify(config.project, config.manifestSha256, config.publication);
    report.source = publication.source;
    report.publication = publication;
    let targets;
    try {
      targets = await discover(config.endpoint, signal);
    } catch (error) {
      throw failure(signal.aborted ? 'interrupted' : 'endpoint-unavailable', {
        cause: codeOf(error),
      });
    }
    cdp = await connect(selectTarget(targets, config), signal);
    report.cleanup.socketClosed = false;
    runSignal = AbortSignal.any([signal, cdp.signal]);
    await cdp.send('Runtime.enable', {}, { signal: runSignal });
    await cdp.send('Page.enable', {}, { signal: runSignal });
    dispatch = createCdpContacts({
      send: (method, params) => {
        if (config.nativeReleaseWitness && params.type !== 'touchCancel') {
          // A later gameplay command invalidates an earlier all-up candidate.
          terminalDispatch =
            params.type === 'touchEnd' && params.touchPoints.length === 0
              ? { sentAtRunnerMs: now() }
              : undefined;
        }
        return cdp.send(method, params, {
          signal: params.type === 'touchCancel' ? undefined : runSignal,
          timeoutMs: 5000,
        });
      },
    });
    const deadline = now() + 120000;
    let state;
    for (;;) {
      state = await evaluate(
        cdp,
        inspectSimulator,
        { canvasSelector: config.canvasSelector, geometry: true },
        runSignal,
      );
      if (state.renderer?.phase === 'ready' && state.observer?.readyCompletions >= 60) break;
      check(now() < deadline, 'ordinary-game-readiness-timeout');
      await sleep(250, runSignal);
    }
    identity = validateState(state, config.targetPath);
    check(!state.observer.armed && !state.observer.ended, 'benchmark-realm-already-used');
    const controls = controlGeometry(state);
    report.before = state;
    report.extent = state.extent;
    report.driver = state.driver;
    report.geometry = controls;
    report.images = [await saveImage(cdp, config.out, 'controls.png', runSignal)];
    probeToken = randomUUID();
    await evaluate(cdp, installNativeTouchProbe, { token: probeToken }, runSignal);
    emit({ phase: 'qualifying-native-contacts', window: config.window });
    report.semanticQualification = await (dependencies.qualify ?? qualifySimulator)({
      cdp,
      dispatch,
      config,
      state,
      geometry: controls.css,
      token: probeToken,
      signal: runSignal,
      now,
      sleep,
      record: (rows) =>
        writeFile(join(config.out, 'semantic-progress.json'), JSON.stringify({ rows }, null, 2), {
          mode: 0o600,
        }),
    });
    report.nativeTouch = await evaluate(
      cdp,
      ({ token }) => {
        const probe = globalThis.GameGlobal?.__gameContextWindow?.__forgeaxSimulatorTouchProbe;
        return probe?.token === token
          ? probe.release()
          : { failure: { code: 'touch-observer-replaced' } };
      },
      { token: probeToken },
      runSignal,
    );
    check(
      report.nativeTouch.released && !report.nativeTouch.failure,
      'touch-observer-release-failed',
    );
    report.cleanup.touchObserverReleased = true;
    probeToken = null;
    if (config.nativeReleaseWitness) {
      releaseToken = randomUUID();
      report.cleanup.nativeReleaseObserverReleased = false;
      await evaluate(
        cdp,
        nativeReleaseWitness,
        { action: 'install', token: releaseToken },
        runSignal,
      );
    }
    report.images.push(await saveImage(cdp, config.out, 'before.png', runSignal));
    report.beforeTiming = await evaluate(
      cdp,
      inspectSimulator,
      { canvasSelector: config.canvasSelector, geometry: true },
      runSignal,
    );
    validateState(report.beforeTiming, config.targetPath, identity);
    assertGameplayRegion(report.beforeTiming.player, 8);
    check(
      JSON.stringify(controlGeometry(report.beforeTiming)) === JSON.stringify(controls) &&
        JSON.stringify(report.beforeTiming.extent) === JSON.stringify(state.extent),
      'geometry-changed-before-timing',
    );
    const timeline = createGameplayTimeline({
      geometry: controls.css,
      coordinateSpace: controls.coordinateSpace,
      phaseMs: config.phaseMs,
    });
    report.workload = timeline.workload;
    await json('timeline.json', timeline);
    const beforeArm = now();
    // arm may execute even when its CDP acknowledgement is lost.
    armed = true;
    const timing = await evaluate(
      cdp,
      (value) => {
        const beforeUtcMs = Date.now();
        const timing = globalThis.GameGlobal.__gameContextWindow.__gameplayBenchmark.arm(value);
        const witness = globalThis.__forgeaxNativeReleaseWitness;
        const nativeReleaseClock = value.nativeReleaseToken
          ? witness?.token === value.nativeReleaseToken
            ? witness.clock()
            : null
          : undefined;
        return {
          ...timing,
          wallClock: { beforeUtcMs, afterUtcMs: Date.now() },
          nativeReleaseClock,
        };
      },
      {
        phases: timeline.phases,
        durationMs: timeline.durationMs,
        delayMs: 1500,
        ...(releaseToken ? { nativeReleaseToken: releaseToken } : {}),
      },
      runSignal,
    );
    const afterArm = now(),
      offset = (beforeArm + afterArm) / 2 - timing.nowMs;
    // Use the upper clock-alignment bound before admitting any diagnostic read.
    timingEndsAt = afterArm + timing.endMs - timing.nowMs;
    report.clockAlignment = {
      method: 'CDP request midpoint mapped to the observed Platform clock',
      uncertaintyMs: (afterArm - beforeArm) / 2,
      ...timing,
    };
    if (releaseToken) {
      check(
        Number.isFinite(timing.nativeReleaseClock?.pageNowMs) && !timing.nativeReleaseClock.failure,
        'native-release-clock-unavailable',
      );
      report.clockAlignment.nativeRelease = {
        source: 'observer-page-performance',
        beforeRunnerMs: beforeArm,
        afterRunnerMs: afterArm,
        pageNowMs: timing.nativeReleaseClock.pageNowMs,
        quantizationAllowanceMs: 1,
      };
    }
    check(
      report.clockAlignment.uncertaintyMs <= config.maxLatenessMs,
      'clock-alignment-too-uncertain',
    );
    emit({ phase: 'timing-armed', window: config.window, durationMs: timeline.durationMs });
    report.inputDispatch = await (dependencies.execute ?? executeTimeline)(timeline, dispatch, {
      startAt: offset + timing.startMs,
      maxLatenessMs: config.maxLatenessMs,
      signal: runSignal,
    });
    check(report.inputDispatch.success, 'input-timeline-incomplete', report.inputDispatch.failure);
    await sleep(offset + timing.endMs + 250 - now(), runSignal);
    // No Runtime.evaluate, inspection, capture or profiler ran between arm and here.
    const releaseDeadline = now() + 15000;
    for (;;) {
      report.releaseWitness = await evaluate(cdp, inspectSimulator, {}, runSignal);
      validateState(report.releaseWitness, config.targetPath, identity);
      if (neutral(report.releaseWitness.player) && report.releaseWitness.player.grounded === true)
        break;
      check(now() < releaseDeadline, 'post-window-release-timeout');
      await sleep(80, runSignal);
    }
    assertGameplayRegion(report.releaseWitness.player, 13.59);
    report.capture = await evaluate(
      cdp,
      async () => await globalThis.GameGlobal.__gameContextWindow.__gameplayBenchmark.drain(),
      null,
      runSignal,
      20000,
    );
    report.cleanup.drained = report.capture.drain?.success === true;
    check(
      report.capture.status === 'complete' && report.cleanup.drained,
      'capture-incomplete',
      report.capture.failure,
    );
    report.after = await evaluate(
      cdp,
      inspectSimulator,
      { canvasSelector: config.canvasSelector, geometry: true },
      runSignal,
    );
    validateState(report.after, config.targetPath, identity);
    check(neutral(report.after.player), 'final-input-not-neutral');
    check(report.after.player.grounded === true, 'final-player-not-landed');
    check(
      JSON.stringify(controlGeometry(report.after)) === JSON.stringify(controls),
      'geometry-changed-during-timing',
    );
    report.images.push(await saveImage(cdp, config.out, 'after.png', runSignal));
    report.publicationAfter = await verify(
      config.project,
      config.manifestSha256,
      config.publication,
    );
    report.publicationReverified = true;
    report.success = true;
  } catch (error) {
    report.failure = {
      code: codeOf(error),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  } finally {
    if (dispatch) {
      try {
        const nativeReleased = await observeNativeRelease('before-final-cleanup');
        if (!nativeReleased) {
          try {
            await dispatch.release();
          } finally {
            await observeNativeRelease('after-final-cleanup');
          }
        }
        report.inputCleanup = dispatch.wireMetrics();
        check(report.inputCleanup.releaseConfirmed, 'input-release-unconfirmed');
        if (cdp && probeToken) {
          report.cleanup.nativeContactsReleased = false;
          const deadline = now() + 1500;
          for (;;) {
            report.nativeReleaseWitness = await evaluate(
              cdp,
              inspectSimulator,
              { probeToken, inputOnly: true, compact: true },
              undefined,
              Math.max(1, deadline - now()),
            );
            const witness = report.nativeReleaseWitness;
            check(
              witness.touch && !witness.touch.failure && !witness.touch.released,
              witness.touch?.failure ?? 'native-touch-evidence-missing',
              { stage: 'cleanup.native-input', last: witness },
            );
            if (witness.touch.activeCount === 0 && neutral(witness.player)) {
              report.cleanup.nativeContactsReleased = true;
              break;
            }
            check(now() < deadline, 'native-input-release-timeout', {
              stage: 'cleanup.native-input',
              expected: {
                activeNativeContacts: 0,
                controls: { horizontal: 0, vertical: 0, run: false },
              },
              last: witness,
            });
            await sleep(Math.min(50, deadline - now()));
          }
        }
        report.cleanup.contactsReleased = true;
      } catch (error) {
        report.inputCleanup = dispatch.wireMetrics();
        report.cleanup.contactsReleased = false;
        report.errors.push({
          stage: 'contact-release',
          code: codeOf(error),
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        });
      }
    }
    if (cdp && probeToken) {
      try {
        const result = await evaluate(
          cdp,
          ({ token }) => {
            const probe = globalThis.GameGlobal?.__gameContextWindow?.__forgeaxSimulatorTouchProbe;
            return probe?.token === token
              ? probe.release()
              : { failure: { code: 'touch-observer-replaced' } };
          },
          { token: probeToken },
        );
        report.nativeTouch = result;
        report.cleanup.touchObserverReleased = result.released && !result.failure;
      } catch (error) {
        report.cleanup.touchObserverReleased = false;
        report.errors.push({ stage: 'touch-observer-release', code: codeOf(error) });
      }
    }
    if (cdp && armed && !report.capture) {
      try {
        report.capture = await evaluate(
          cdp,
          async () => {
            const observer = globalThis.GameGlobal.__gameContextWindow.__gameplayBenchmark;
            observer.abort();
            return await observer.drain();
          },
          null,
          undefined,
          20000,
        );
        report.cleanup.drained = report.capture.drain?.success === true;
      } catch (error) {
        report.cleanup.drained = false;
        report.errors.push({ stage: 'drain', code: codeOf(error) });
      }
    }
    if (cdp && releaseToken) {
      try {
        report.nativeReleaseObserver = await evaluate(cdp, nativeReleaseWitness, {
          action: 'release',
          token: releaseToken,
        });
        report.cleanup.nativeReleaseObserverReleased =
          report.nativeReleaseObserver.released === true;
        if (report.nativeReleaseObserver.failure) {
          report.cleanup.nativeContactsReleased = false;
          if (report.terminalNativeRelease)
            report.terminalNativeRelease.outcome = 'native-evidence-invalid';
          report.success = false;
          report.failure ??= {
            code: 'native-release-evidence-invalid',
            detail: report.nativeReleaseObserver.failure,
          };
        }
      } catch (error) {
        report.cleanup.nativeReleaseObserverReleased = false;
        report.errors.push({ stage: 'native-release-observer-release', code: codeOf(error) });
      }
    }
    if (cdp) {
      try {
        report.cleanup.socketClosed = await cdp.close();
      } catch {
        report.cleanup.socketClosed = false;
      }
    }
    if (Object.values(report.cleanup).includes(false)) {
      report.success = false;
      report.failure ??= { code: 'cleanup-incomplete' };
    }
    report.endedAtUtc = new Date().toISOString();
    if (report.capture?.schemaVersion === 'forgeax-gameplay-capture/1') {
      try {
        report.analysis = analyzeGameplay(report);
        if (report.analysis.status !== 'complete') {
          report.success = false;
          report.failure ??= { code: 'analysis-incomplete', detail: report.analysis.errors };
        }
        await json('analysis.json', report.analysis);
        await writeFile(join(config.out, 'analysis.md'), formatAnalysis(report), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        report.success = false;
        report.failure ??= { code: 'analysis-failed' };
        report.errors.push({ stage: 'analysis', code: codeOf(error) });
      }
    }
    await json('report.json', report);
  }
  emit({
    phase: 'complete',
    success: report.success,
    failure: report.failure?.code ?? null,
    performanceQualification: report.performanceQualification.status,
    output: config.out,
  });
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        'endpoint',
        'window',
        'target-path',
        'project',
        'publication',
        'manifest-sha256',
        'out',
        'canvas-selector',
        'phase-ms',
        'max-lateness-ms',
        'capacity-status',
      ]
        .map((name) => [name, { type: 'string' }])
        .concat(['help', 'native-release-witness'].map((name) => [name, { type: 'boolean' }])),
    ),
  });
  if (values.help) {
    console.log(
      'Usage: node run_simulator_gameplay_benchmark.mjs --endpoint http://127.0.0.1:PORT --window sN --target-path /game/sN/.../gamePage.html --project /absolute/IDE-project --publication /absolute/immutable-native-benchmark --manifest-sha256 DIAGNOSTIC_SHA256 --out /new/private/output [--canvas-selector canvas] [--phase-ms 10000] [--max-lateness-ms 100] [--capacity-status unverified|contended] [--native-release-witness]\nRun on the DevTools machine with Node 22+. Reuses one existing authorized target; no CLI/open/restart or viewport/emulation changes. Without --publication, --project must remain byte-exact; with it only additive IDE project.config.json metadata is admitted. Public wx contacts and ordinary gameplay must qualify before natural App completion timing. The prepared native benchmark must include observer.abort(). Images and capacity require caller review; success is collection, never an automatic stable-60 or scanout/GPU-time pass. --native-release-witness adds bounded public Start/End/Cancel diagnosis, retains original ACK failures, and excludes performance acceptance.',
    );
    return;
  }
  const controller = new AbortController(),
    interrupted = () => controller.abort();
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    const result = await runSimulatorGameplayBenchmark(
      {
        endpoint: values.endpoint,
        window: values.window,
        targetPath: values['target-path'],
        project: values.project,
        publication: values.publication,
        manifestSha256: values['manifest-sha256'],
        out: values.out,
        canvasSelector: values['canvas-selector'],
        phaseMs: values['phase-ms'],
        maxLatenessMs: values['max-lateness-ms'],
        capacityStatus: values['capacity-status'],
        nativeReleaseWitness: values['native-release-witness'],
      },
      { signal: controller.signal },
    );
    if (!result.success) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
)
  main().catch((error) => {
    console.log(JSON.stringify({ success: false, failure: { code: codeOf(error) } }));
    process.exitCode = 1;
  });
