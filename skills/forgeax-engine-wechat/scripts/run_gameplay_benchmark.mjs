import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliDecompressSync } from 'node:zlib';
import { analyzeGameplay, formatAnalysis } from './analyze_gameplay_performance.mjs';
import { browserCompletionTimingSource } from './browser_completion_timing.mjs';
import { browserGameplayGpuSource } from './browser_gameplay_gpu.mjs';
import { browserGameplayInputSource } from './browser_gameplay_input.mjs';
import {
  createGameplayTimeline,
  PHASE_NAMES,
  validateTimeline,
} from './fixtures/gameplay-benchmark/timeline.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
const neutral = (value) =>
  value.controls.horizontal === 0 && value.controls.vertical === 0 && value.controls.run === false;
const distance = (a, b) => Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);

/** Caller snapshots are complete; CDP touchEnd names the contacts to release. */
export function createCdpContacts(cdp) {
  let previous = [],
    pendingWire = 0,
    peakWire = 0,
    issuedWire = 0,
    releaseConfirmed = true;
  const point = ({ id, x, y }) => ({ id, x, y, radiusX: 4, radiusY: 4, force: 1 });
  const send = (type, contacts) => {
    const sequence = ++issuedWire;
    releaseConfirmed = false;
    pendingWire++;
    peakWire = Math.max(peakWire, pendingWire);
    try {
      return Promise.resolve(
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: contacts.map(point) }),
      )
        .then((value) => {
          if (
            sequence === issuedWire &&
            (type === 'touchCancel' || (type === 'touchEnd' && contacts.length === 0))
          )
            releaseConfirmed = true;
          return value;
        })
        .finally(() => pendingWire--);
    } catch (error) {
      pendingWire--;
      throw error;
    }
  };
  const dispatch = (next) => {
    const commands = [];
    let retained = previous.filter((contact) => next.some((value) => value.id === contact.id));
    const removed = previous.filter((contact) => !next.some((value) => value.id === contact.id));
    // Explicit touchEnd points are ended, not retained. Empty means release all.
    if (removed.length) commands.push(['touchEnd', retained.length ? removed : []]);
    const added = next.filter((contact) => !retained.some((value) => value.id === contact.id));
    if (added.length) {
      retained = [...retained, ...added];
      commands.push(['touchStart', retained]);
    }
    if (
      next.some((contact) => {
        const old = retained.find((value) => value.id === contact.id);
        return old && (contact.x !== old.x || contact.y !== old.y);
      })
    )
      commands.push(['touchMove', next]);
    // Advance planned state synchronously. A single CDP connection receives the
    // complete wire sequence in order even when acknowledgements overlap.
    previous = next.map((contact) => ({ ...contact }));
    return Promise.all(commands.map(([type, contacts]) => send(type, contacts)));
  };
  // The latest acknowledged all-up is authoritative. Otherwise a DOWN may
  // already be native even when its acknowledgement was lost.
  dispatch.release = () => {
    if (releaseConfirmed && previous.length === 0) return Promise.resolve();
    previous = [];
    return send('touchCancel', []);
  };
  dispatch.resetMetrics = () => {
    assert.equal(pendingWire, 0, 'Previous input acknowledgements must settle');
    peakWire = 0;
  };
  dispatch.wireMetrics = () => ({
    pendingWireCommands: pendingWire,
    peakWireCommands: peakWire,
    releaseConfirmed,
  });
  return dispatch;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Input interrupted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Input interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Input acknowledgement settlement timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** No game inspection is called here. Only real input and host monotonic time. */
export async function executeTimeline(
  timeline,
  dispatch,
  {
    startAt = performance.now(),
    maxLatenessMs = 100,
    maxPending,
    settleTimeoutMs = 3000,
    signal,
  } = {},
) {
  validateTimeline(timeline);
  dispatch.resetMetrics?.();
  assert.ok(
    Number.isFinite(maxLatenessMs) && maxLatenessMs >= 0,
    'Input lateness must be finite and nonnegative',
  );
  if (maxPending === undefined) {
    // Size from one inclusive lateness window of scheduled snapshots.
    // ACK settlement retains its separate timeout.
    // The epsilon only absorbs floating-point schedule boundary rounding.
    maxPending = 1;
    let first = 0;
    for (let index = 0; index < timeline.events.length; index++) {
      while (timeline.events[index].atMs - timeline.events[first].atMs > maxLatenessMs + 1e-7)
        first++;
      maxPending = Math.max(maxPending, index - first + 1);
    }
    maxPending = Math.min(16, maxPending);
  }
  assert.ok(
    Number.isInteger(maxPending) && maxPending >= 1 && maxPending <= 16,
    'Input queue must be bounded',
  );
  const sent = new Float64Array(timeline.events.length),
    acknowledged = new Float64Array(timeline.events.length);
  acknowledged.fill(NaN);
  const pending = new Set();
  let count = 0,
    ackCount = 0,
    peakPending = 0,
    failure,
    failureStage,
    cleanupError;
  try {
    for (const event of timeline.events) {
      if (signal?.aborted) throw new Error('Input interrupted');
      do {
        await abortable(wait(startAt + event.atMs - performance.now()), signal);
      } while (performance.now() < startAt + event.atMs);
      if (failure) throw new Error(failure);
      const at = performance.now();
      if (at - startAt - event.atMs > maxLatenessMs)
        throw new Error(
          `Input late by ${(at - startAt - event.atMs).toFixed(1)} ms at ${event.atMs}`,
        );
      if (pending.size >= maxPending)
        throw new Error(`Input acknowledgement backlog reached ${maxPending}`);
      const index = count++;
      sent[index] = at - startAt;
      const response = Promise.resolve(dispatch(event.contacts))
        .then(
          () => {
            acknowledged[index] = performance.now() - startAt;
            ackCount++;
          },
          (error) => {
            failure ??= error.message;
            failureStage ??= 'event';
          },
        )
        .finally(() => pending.delete(response));
      pending.add(response);
      peakPending = Math.max(peakPending, pending.size);
    }
    await abortable(bounded(Promise.all([...pending]), settleTimeoutMs), signal);
  } catch (error) {
    failure ??= error.message;
    failureStage ??= 'schedule-or-settlement';
  } finally {
    const release = Promise.resolve().then(() =>
      dispatch.release ? dispatch.release() : dispatch([]),
    );
    await bounded(
      Promise.allSettled([...pending, release]).then((results) => {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      }),
      settleTimeoutMs,
    ).catch((error) => {
      failure ??= error.message;
      failureStage ??= 'cleanup';
      cleanupError = error.message;
    });
  }
  const events = timeline.events.slice(0, count).map((event, index) => ({
    scheduledMs: event.atMs,
    sentMs: sent[index],
    acknowledgedMs: Number.isFinite(acknowledged[index]) ? acknowledged[index] : null,
  }));
  const lateness = events.map((event) => Math.max(0, event.sentMs - event.scheduledMs));
  return {
    success: !failure && ackCount === count,
    failure,
    failureStage,
    cleanupError,
    expectedEvents: timeline.events.length,
    sentEvents: count,
    acknowledgedEvents: ackCount,
    droppedEvents: timeline.events.length - count,
    maxLatenessMs: lateness.length ? Math.max(...lateness) : null,
    allowedLatenessMs: maxLatenessMs,
    pendingUnit: 'contact-snapshot',
    maxPending,
    peakPending,
    unsettledEvents: pending.size,
    wireMetrics: dispatch.wireMetrics?.() ?? null,
    events,
  };
}

/** Read and test the resolved value; a Promise is not a readiness witness. */
export async function waitForReleasedPlayer(read, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const deadline = performance.now() + timeoutMs;
  let player;
  do {
    player = await read();
    if (neutral(player) && player.grounded === true) return player;
    if (performance.now() >= deadline) break;
    await wait(intervalMs);
  } while (performance.now() <= deadline);
  throw new Error(`Player did not become neutral and landed: ${JSON.stringify(player)}`);
}

// The ordinary game-3d ground spans +/-14; leave room for its capsule and offset.
export function assertGameplayRegion(player, limit) {
  assert.ok(
    neutral(player) &&
      player.grounded === true &&
      Array.isArray(player.position) &&
      player.position.length === 3 &&
      player.position.every(Number.isFinite) &&
      Math.abs(player.position[0]) <= limit &&
      Math.abs(player.position[2]) <= limit,
    `Gameplay requires a neutral grounded player inside +/-${limit}: ${JSON.stringify(player)}`,
  );
}

async function inspect(page) {
  return page.evaluate(async () => {
    const owner = globalThis.__forgeaxGameInspection;
    const result = owner.ui({ selector: '[data-ui-part]', limit: 512 });
    if (!result.ok) throw new Error(`Blitz inspection failed: ${JSON.stringify(result.error)}`);
    const canvas = document.querySelector('canvas');
    return {
      player: await owner.read('game-3d.player'),
      renderer: owner.renderer(),
      ui: result.value,
      extent: {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        dpr: devicePixelRatio,
        drawingWidth: canvas.width,
        drawingHeight: canvas.height,
      },
      visible: document.visibilityState === 'visible',
    };
  });
}

export function geometryFromInspection(inspection) {
  assert.equal(inspection.truncated, false, 'Blitz inspection may not truncate controls');
  const geometry = {};
  for (const [role, part] of Object.entries({
    move: 'move-stick',
    look: 'look-pad',
    run: 'run',
    jump: 'jump',
  })) {
    const nodes = inspection.nodes.filter((node) => node.attributes['data-ui-part'] === part);
    assert.equal(nodes.length, 1, `Unique Blitz ${part} control required`);
    geometry[role] = nodes[0].rect;
  }
  return geometry;
}

async function qualify(page, dispatch, geometry, out) {
  const rows = [],
    progress = [];
  const read = () =>
    page.evaluate(async () => {
      const inspection = globalThis.__forgeaxGameInspection;
      const player = await inspection.read('game-3d.player'),
        renderer = inspection.renderer();
      if (
        renderer.phase !== 'ready' ||
        renderer.startupError ||
        renderer.lastError ||
        document.visibilityState !== 'visible'
      )
        throw new Error('Ordinary game is not healthy');
      return {
        player,
        completed: renderer.presented,
        worldIdentity: renderer.lastCompletion?.worldIdentity,
        deviceGeneration: renderer.lastCompletion?.deviceGeneration,
      };
    });
  const center = (role, id) => ({
    role,
    id,
    x: geometry[role].x + geometry[role].width / 2,
    y: geometry[role].y + geometry[role].height / 2,
  });
  async function settle(predicate, deadlineMs = 20000) {
    const deadline = performance.now() + deadlineMs;
    let state;
    do {
      state = await read();
      if (predicate(state)) return state;
      await wait(100);
    } while (performance.now() < deadline);
    throw new Error(`Semantic condition timed out: ${JSON.stringify(state)}`);
  }
  await page.evaluate(() => {
    globalThis.__gameplayTrustedEvidence = [];
    globalThis.__gameplayTrustedListener = (event) => {
      if (globalThis.__gameplayTrustedEvidence.length < 200)
        globalThis.__gameplayTrustedEvidence.push({
          type: event.type,
          trusted: event.isTrusted,
          pointerType: event.pointerType,
        });
    };
    for (const kind of ['pointerdown', 'pointermove', 'pointerup'])
      document.addEventListener(kind, globalThis.__gameplayTrustedListener, true);
  });
  try {
    for (const name of PHASE_NAMES) {
      await dispatch([]);
      const before = await settle((state) => neutral(state.player) && state.player.grounded);
      const move = center('move', 1),
        look = center('look', 2),
        run = center('run', 3),
        jump = center('jump', 4);
      move.y -= Math.min(geometry.move.width, geometry.move.height) * 0.3;
      const contacts = [
        ...(name === 'jump' ? [] : [move]),
        look,
        ...(name === 'run' || name === 'run-jump' ? [run] : []),
      ];
      await dispatch(contacts);
      await wait(150);
      look.x += Math.min(geometry.look.width * 0.15, 30);
      if (name === 'jump' || name === 'run-jump') contacts.push(jump);
      await dispatch(contacts);
      const active = await settle(
        (state) =>
          state.completed > before.completed &&
          state.player.simulation.fixedTick > before.player.simulation.fixedTick &&
          Math.abs(state.player.camera.yaw - before.player.camera.yaw) > 0.02 &&
          state.player.controls.run === (name === 'run' || name === 'run-jump') &&
          (name === 'jump'
            ? Math.abs(state.player.controls.vertical) < 0.001
            : state.player.controls.vertical > 0.5 &&
              distance(state.player, before.player) > 0.02) &&
          (!(name === 'jump' || name === 'run-jump') ||
            (!state.player.grounded &&
              state.player.position[1] > before.player.position[1] + 0.04)),
      );
      assert.equal(active.worldIdentity, before.worldIdentity);
      assert.equal(active.deviceGeneration, before.deviceGeneration);
      await dispatch([]);
      const released = await settle(
        (state) =>
          state.completed > active.completed && neutral(state.player) && state.player.grounded,
      );
      const stopped = await settle(
        (state) =>
          state.completed >= released.completed + 3 &&
          state.player.simulation.fixedTick >= released.player.simulation.fixedTick + 4,
      );
      assert.ok(distance(stopped.player, released.player) < 0.005, 'Released move must stop');
      assert.ok(
        Math.abs(stopped.player.camera.yaw - released.player.camera.yaw) < 0.005,
        'Released look must stop',
      );
      assert.ok(stopped.player.position.every(Number.isFinite));
      const row = { name, before, active, released, stopped };
      rows.push(row);
      progress.push({ name, complete: true });
      await writeFile(
        join(out, 'semantic-progress.json'),
        JSON.stringify({ rows, progress }, null, 2),
      );
    }
    const trusted = await page.evaluate(() => globalThis.__gameplayTrustedEvidence);
    assert.ok(
      trusted.length && trusted.every((event) => event.trusted && event.pointerType === 'touch'),
      'Real trusted touch events required',
    );
    return { success: true, rows, trusted };
  } finally {
    await dispatch([]);
    await page.evaluate(() => {
      for (const kind of ['pointerdown', 'pointermove', 'pointerup'])
        document.removeEventListener(kind, globalThis.__gameplayTrustedListener, true);
      delete globalThis.__gameplayTrustedListener;
    });
  }
}

export async function runGameplayBenchmark({
  root,
  out,
  playwright,
  chrome,
  software = false,
  toolVerification = false,
  cpuProfile = false,
  trace = null,
  phaseMs = 10000,
  maxLatenessMs = 100,
}) {
  root = resolve(root);
  out = resolve(out);
  assert.ok(!software || toolVerification, 'Software is only tool verification');
  assert.ok(
    [null, 'completion', 'input', 'gpu'].includes(trace),
    'Trace must be completion, input or gpu',
  );
  assert.ok(!(cpuProfile && trace), 'CPU profiling and trace modes require separate runs');
  const manifestBytes = await readFile(join(root, 'browser-manifest.json')),
    manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 'forgeax-gameplay-browser/1');
  const verify = async () => {
    for (const row of manifest.files) {
      const path = resolve(root, row.path);
      assert.ok(path.startsWith(root + sep));
      const bytes = await readFile(path);
      assert.equal(bytes.length, row.bytes, row.path);
      assert.equal(sha(bytes), row.sha256, row.path);
    }
  };
  await verify();
  await mkdir(out);
  const report = {
    schemaVersion: 'forgeax-gameplay-run/1',
    source: manifest.source,
    browserManifestSha256: sha(manifestBytes),
    extent: manifest.extent,
    toolVerification,
    diagnostic: cpuProfile ? 'cpu-profile' : trace ? `${trace}-trace` : null,
    errors: [],
    startedAtUtc: new Date().toISOString(),
  };
  const cache = new Map();
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname),
        path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      assert.ok(path.startsWith(root + sep));
      let bytes = cache.get(path);
      if (!bytes) {
        try {
          bytes = await readFile(path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          bytes = brotliDecompressSync(await readFile(`${path}.br`));
        }
        cache.set(path, bytes);
      }
      response.setHeader('cross-origin-opener-policy', 'same-origin');
      response.setHeader('cross-origin-embedder-policy', 'require-corp');
      response.setHeader(
        'content-type',
        {
          '.js': 'text/javascript',
          '.mjs': 'text/javascript',
          '.html': 'text/html',
          '.json': 'application/json',
          '.wasm': 'application/wasm',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
        }[extname(path)] ?? 'application/octet-stream',
      );
      response.end(bytes);
    } catch (error) {
      report.errors.push({ source: 'http', path: request.url, message: error.message });
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
  let browser,
    page,
    dispatch,
    captureEndAt,
    profiler,
    traceStarted = false;
  const traceGlobal = {
    completion: '__forgeaxCompletionTiming',
    input: '__forgeaxGameplayInput',
    gpu: '__forgeaxGameplayGpu',
  }[trace];
  const stopTrace = async () => {
    if (!traceStarted) return;
    if (trace === 'gpu') {
      await page.evaluate((name) => globalThis[name].stop(), traceGlobal);
      traceStarted = false;
      return;
    }
    const captured = await page.evaluate((name) => {
      const owner = globalThis[name];
      if (!owner) throw new Error('Passive trace owner was replaced');
      const capture = owner.stop();
      const restored = owner.restore();
      return { capture, restoration: { state: restored.state, coverage: restored.coverage } };
    }, traceGlobal);
    traceStarted = false;
    const bytes = JSON.stringify(captured, null, 2);
    const path = `${trace}-trace.json`;
    await writeFile(join(out, path), bytes);
    report.passiveTrace = {
      path,
      sha256: sha(bytes),
      recordedEvents: captured.capture.recordedEvents,
      overflow: captured.capture.overflow,
      coverage: captured.capture.coverage,
      restoration: captured.restoration,
      scope:
        'Existing native calls/events only; includes arm lead-in and release tail. Instrumented diagnosis excludes FPS acceptance.',
    };
  };
  const collectGpuTrace = async () => {
    if (trace !== 'gpu' || !page) return;
    const drained = report.capture?.drain?.success === true;
    const result = await page.evaluate(
      async ({ name, drained }) => {
        const owner = globalThis[name];
        if (!owner) throw new Error('GPU diagnostic owner unavailable');
        owner.stop();
        let capture, disposal;
        try {
          capture = drained ? await owner.collect() : owner.snapshot();
        } finally {
          const disposed = owner.dispose();
          disposal = { lifecycle: disposed.lifecycle, coverage: disposed.coverage };
        }
        return { capture, disposal, collectionAfterDrain: drained };
      },
      { name: traceGlobal, drained },
    );
    const bytes = JSON.stringify(result, null, 2);
    await writeFile(join(out, 'gpu-trace.json'), bytes);
    report.gpuTrace = {
      path: 'gpu-trace.json',
      sha256: sha(bytes),
      capability: result.capture.capability,
      coverage: result.capture.coverage,
      disposal: result.disposal,
      collectionAfterDrain: drained,
      scope: result.capture.scope,
    };
  };
  const stopProfile = async () => {
    if (!profiler) return;
    const session = profiler;
    profiler = undefined;
    const { profile } = await session.send('Profiler.stop');
    await session.send('Profiler.disable');
    const bytes = JSON.stringify(profile);
    await writeFile(join(out, 'profile.cpuprofile'), bytes);
    report.cpuProfile = {
      path: 'profile.cpuprofile',
      sha256: sha(bytes),
      sampleCount: profile.samples?.length ?? 0,
      durationMs: (profile.endTime - profile.startTime) / 1000,
      scope:
        'V8 sampling includes the arm lead-in and timed gameplay; separate diagnostic, not FPS acceptance.',
    };
  };
  try {
    browser = await chromium.launch({
      ...(chrome ? { executablePath: chrome } : {}),
      headless: true,
      args: software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
      chromiumSandbox: true,
    });
    report.browser = browser.version();
    page = await browser.newPage({
      viewport: { width: manifest.extent.width, height: manifest.extent.height },
      deviceScaleFactor: manifest.extent.dpr,
    });
    if (trace)
      await page.addInitScript({
        content:
          trace === 'completion'
            ? browserCompletionTimingSource()
            : trace === 'gpu'
              ? browserGameplayGpuSource()
              : browserGameplayInputSource(),
      });
    page.on('pageerror', (error) =>
      report.errors.push({ source: 'page', message: error.message, stack: error.stack }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        report.errors.push({ source: 'console', message: message.text() });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(
      () =>
        globalThis.hostBootError ||
        globalThis.__forgeaxGameInspection?.renderer().lastError ||
        globalThis.__forgeaxGameInspection?.renderer().startupError ||
        globalThis.__gameplayBenchmark?.status().readyCompletions >= 60,
      undefined,
      { timeout: 240000 },
    );
    report.bootState = await page.evaluate(() =>
      JSON.parse(
        JSON.stringify(
          {
            bootError: globalThis.hostBootError,
            renderer: globalThis.__forgeaxGameInspection?.renderer(),
          },
          (_key, value) =>
            value instanceof Error
              ? {
                  ...value,
                  name: value.name,
                  message: value.message,
                  stack: value.stack,
                  cause: value.cause,
                }
              : value,
        ),
      ),
    );
    assert.ok(
      !report.bootState.bootError &&
        !report.bootState.renderer?.startupError &&
        !report.bootState.renderer?.lastError,
      JSON.stringify(report.bootState),
    );
    console.log('[gameplay] full scene ready; qualifying trusted controls');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    dispatch = createCdpContacts(cdp);
    const before = await inspect(page);
    report.before = before;
    assert.deepEqual(before.extent, manifest.extent);
    assert.equal(before.renderer.phase, 'ready');
    assert.ok(before.visible);
    assert.ok(!before.renderer.startupError && !before.renderer.lastError);
    report.driver = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      if (!gl) throw new Error('Actual native WebGL2 context required');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      };
    });
    if (!software)
      assert.doesNotMatch(
        report.driver.renderer,
        /swiftshader|llvmpipe|software/i,
        'Hardware WebGL required',
      );
    const geometry = geometryFromInspection(before.ui);
    report.geometry = geometry;
    report.semanticQualification = await qualify(page, dispatch, geometry, out);
    console.log('[gameplay] controls qualified; preparing timed capture');
    await page.screenshot({ path: join(out, 'before.png') });
    report.beforeTiming = await inspect(page);
    assertGameplayRegion(report.beforeTiming.player, 8);
    const actualGeometry = geometryFromInspection(report.beforeTiming.ui);
    assert.deepEqual(actualGeometry, geometry, 'Controls cannot move after qualification');
    const timeline = createGameplayTimeline({
      geometry,
      coordinateSpace: {
        unit: 'css-px',
        width: manifest.extent.width,
        height: manifest.extent.height,
      },
      phaseMs,
    });
    report.workload = timeline.workload;
    await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 2));
    if (cpuProfile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
      profiler = cdp;
      await cdp.send('Profiler.start');
    }
    if (trace) {
      // Mark before evaluation: installation may start even if its ACK is lost.
      traceStarted = true;
      report.traceStart = await page.evaluate((name) => globalThis[name].start(), traceGlobal);
    }
    const armBefore = performance.now();
    const armed = await page.evaluate(
      (value) => {
        const beforeUtcMs = Date.now();
        const timing = globalThis.__gameplayBenchmark.arm(value);
        return {
          ...timing,
          wallClock: { beforeUtcMs, afterUtcMs: Date.now(), timeOriginMs: performance.timeOrigin },
        };
      },
      {
        phases: timeline.phases,
        durationMs: timeline.durationMs,
        delayMs: 1500,
      },
    );
    const armAfter = performance.now();
    const clockOrigin = (armBefore + armAfter) / 2 - armed.nowMs;
    const startAt = clockOrigin + armed.startMs;
    captureEndAt = clockOrigin + armed.endMs;
    report.clockAlignment = {
      method: 'CDP request midpoint; Platform.now uses Browser performance.now',
      uncertaintyMs: (armAfter - armBefore) / 2,
      ...armed,
    };
    // Between arm and drain the only page operations are real CDP touch events.
    report.inputDispatch = await executeTimeline(timeline, dispatch, { startAt, maxLatenessMs });
    await wait(captureEndAt + 250 - performance.now());
    await stopProfile();
    await stopTrace();
    report.releaseWitness = await waitForReleasedPlayer(() =>
      page.evaluate(async () => await globalThis.__forgeaxGameInspection.read('game-3d.player')),
    );
    assert.ok(
      neutral(report.releaseWitness) && report.releaseWitness.grounded === true,
      'Final release must be neutral and landed',
    );
    assertGameplayRegion(report.releaseWitness, 13.59);
    report.capture = await page.evaluate(async () => await globalThis.__gameplayBenchmark.drain());
    report.after = await inspect(page);
    await page.screenshot({ path: join(out, 'after.png') });
    assert.ok(report.inputDispatch.success, report.inputDispatch.failure);
    assert.equal(report.capture.status, 'complete', report.capture.failure);
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    report.success = true;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    await stopProfile().catch((error) =>
      report.errors.push({ source: 'profile-cleanup', message: error.message }),
    );
    await stopTrace().catch((error) =>
      report.errors.push({ source: 'trace-cleanup', message: error.message }),
    );
    if (captureEndAt) await wait(captureEndAt + 250 - performance.now());
    if (page && captureEndAt && !report.capture)
      report.capture = await page
        .evaluate(async () => await globalThis.__gameplayBenchmark.drain())
        .catch((error) => ({ failure: error.message }));
    if (page) {
      report.failureState = await page
        .evaluate(() =>
          JSON.parse(
            JSON.stringify(
              {
                renderer: globalThis.__forgeaxGameInspection?.renderer(),
                observer: globalThis.__gameplayBenchmark?.status(),
              },
              (_key, value) =>
                value instanceof Error
                  ? {
                      ...value,
                      name: value.name,
                      message: value.message,
                      stack: value.stack,
                      cause: value.cause,
                    }
                  : value,
            ),
          ),
        )
        .catch((error) => ({ unavailable: error.message }));
      await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
    }
  } finally {
    if (dispatch)
      await dispatch
        .release()
        .catch((error) => report.errors.push({ source: 'input-cleanup', message: error.message }));
    await stopTrace().catch((error) =>
      report.errors.push({ source: 'trace-cleanup', message: error.message }),
    );
    await collectGpuTrace().catch((error) =>
      report.errors.push({ source: 'gpu-trace-cleanup', message: error.message }),
    );
    if (page)
      await page
        .evaluate(async () => await globalThis.disposeHost?.())
        .catch((error) => report.errors.push({ source: 'dispose', message: error.message }));
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    try {
      await verify();
    } catch (error) {
      report.errors.push({ source: 'artifact-identity', message: error.message });
    }
    if (report.errors.length || report.failure) report.success = false;
    report.endedAtUtc = new Date().toISOString();
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (report.capture?.schemaVersion) {
      report.analysis = analyzeGameplay(report);
      await writeFile(join(out, 'analysis.json'), JSON.stringify(report.analysis, null, 2));
      await writeFile(join(out, 'analysis.md'), formatAnalysis(report));
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      root: { type: 'string' },
      out: { type: 'string' },
      playwright: { type: 'string' },
      chrome: { type: 'string' },
      software: { type: 'boolean' },
      'tool-verification': { type: 'boolean' },
      'cpu-profile': { type: 'boolean' },
      trace: { type: 'string' },
      'phase-ms': { type: 'string' },
      'max-lateness-ms': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(`Usage: node run_gameplay_benchmark.mjs --root <browser-preparation> --out <new-directory> --playwright <module> [options]

Options:
  --trace <completion|input|gpu>  Separate diagnostic run; gpu requires the optional Browser Host seam
  --cpu-profile                 Separate CPU diagnostic; cannot combine with --trace
  --phase-ms <milliseconds>      Duration of each of four phases (default: 10000)
  --max-lateness-ms <ms>         Input scheduling bound (default: 100)
  --chrome <executable>         Chromium executable
  --tool-verification           Mark the run as tool qualification, not performance acceptance
  --software                    Software backend; requires --tool-verification
  -h, --help                    Show this help without opening a browser or acquiring the GPU lease

GPU query durations are intrusive, nonadditive diagnostics; they do not qualify ordinary-loop FPS.`);
    process.exit(0);
  }
  assert.ok(values.root && values.out && values.playwright, '--root --out --playwright required');
  const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const { withLocalGpuLease } = await import(
    pathToFileURL(join(engineRoot, 'scripts/ci/local-gpu-lease.mjs')).href
  );
  const result = await withLocalGpuLease(
    () =>
      runGameplayBenchmark({
        root: values.root,
        out: values.out,
        playwright: values.playwright,
        chrome: values.chrome,
        software: !!values.software,
        toolVerification: !!values['tool-verification'],
        cpuProfile: !!values['cpu-profile'],
        trace: values.trace ?? null,
        phaseMs: Number(values['phase-ms'] ?? 10000),
        maxLatenessMs: Number(values['max-lateness-ms'] ?? 100),
      }),
    { label: 'gameplay-completion-benchmark' },
  );
  console.log(
    JSON.stringify({
      success: result.success ?? false,
      failure: result.failure,
      driver: result.driver,
      analysis: result.analysis?.all,
      strict60Cadence: result.analysis?.target.strict60Cadence.met,
      hardwarePerformanceQualified: result.analysis?.target.hardwarePerformanceQualified,
    }),
  );
  if (!result.success || result.analysis?.status !== 'complete') process.exitCode = 1;
}
