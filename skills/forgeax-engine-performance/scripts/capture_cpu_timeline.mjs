import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { moveGame3dWindow } from './game3d_motion.mjs';
import { game3dArchiveDrained, inspectGame3dApp } from './inspect_game3d_app.mjs';

const digest = (v) => createHash('sha256').update(v).digest('hex');
export const CPU_CAPTURE_DEFAULTS = Object.freeze({ intervalUs: 1, windowMs: 3000, target: 'all' });

/** Public project-play adapter. Ordinary motion and intrusive CPU sampling are separate. */
function cpuCaptureConfiguration(environment) {
  const output = environment.FORGEAX_CPU_OUTPUT;
  const samplingIntervalUs = Number(
    environment.FORGEAX_CPU_INTERVAL_US ?? CPU_CAPTURE_DEFAULTS.intervalUs,
  );
  const profiledWindowMs = Number(
    environment.FORGEAX_CPU_WINDOW_MS ?? CPU_CAPTURE_DEFAULTS.windowMs,
  );
  const targetSelection = environment.FORGEAX_CPU_TARGET ?? CPU_CAPTURE_DEFAULTS.target;
  assert(
    ['all', 'Host', 'forgeax-engine', 'forgeax-render'].includes(targetSelection),
    'FORGEAX_CPU_TARGET must be all, Host, forgeax-engine or forgeax-render',
  );
  assert(
    Number.isSafeInteger(samplingIntervalUs) && samplingIntervalUs > 0,
    'FORGEAX_CPU_INTERVAL_US must be a positive integer in microseconds',
  );
  assert(
    Number.isSafeInteger(profiledWindowMs) && profiledWindowMs >= 1000 && profiledWindowMs <= 30000,
    'FORGEAX_CPU_WINDOW_MS must be an integer from 1000 through 30000 milliseconds',
  );
  assert(
    output && isAbsolute(output),
    'Set FORGEAX_CPU_OUTPUT to a new private absolute directory',
  );
  return { output, samplingIntervalUs, profiledWindowMs, targetSelection };
}

export default async function captureCpuTimeline(play) {
  const { output, samplingIntervalUs, profiledWindowMs, targetSelection } = cpuCaptureConfiguration(
    process.env,
  );
  await mkdir(output);
  const save = async (name, data) => {
    const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    const path = join(output, name);
    await writeFile(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const page = play.page,
    browser = page.context().browser();
  assert(browser);
  const root = await browser.newBrowserCDPSession(),
    host = await page.context().newCDPSession(page);
  const realms = [],
    pending = new Map();
  let nextId = 0,
    control,
    paused = false,
    observer = false;
  const report = {
    kind: 'game3d-cpu-timeline-capture',
    ok: false,
    gameCommit: process.env.FORGEAX_CPU_ENGINE_COMMIT ?? null,
    engineCommit: process.env.FORGEAX_CPU_ENGINE_COMMIT ?? null,
    method: {
      samplingIntervalUs,
      ordinaryWindows: 3,
      ordinaryWindowMs: 5000,
      profiledWindowMs,
      targetSelection,
      boundary:
        'Real input and ready completion receipts. Ordinary motion has no Profiler/Debugger/heap tracking. CPU sampling is diagnostic; source archiving follows while actual App is paused/drained. No source edits or forced GC.',
    },
    ordinary: [],
    failures: [],
    cpu: { failures: [] },
    host: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      loadBefore: loadavg(),
      freeMemoryBeforeBytes: freemem(),
    },
  };
  const receive = ({ sessionId, message }) => {
    const data = JSON.parse(message),
      realm = realms.find((r) => r.sessionId === sessionId);
    if (data.method === 'Debugger.scriptParsed')
      realm?.scripts.set(data.params.scriptId, data.params);
    const key = sessionId + ':' + data.id,
      request = pending.get(key);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(key);
    if (data.error) request.reject(Error(JSON.stringify(data.error)));
    else request.resolve(data.result);
  };
  root.on('Target.receivedMessageFromTarget', receive);
  const send = (realm, method, params = {}) => {
    if (realm.host) return host.send(method, params);
    return new Promise((resolve, reject) => {
      if (play.signal.aborted) return reject(play.signal.reason);
      const id = ++nextId,
        key = realm.sessionId + ':' + id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(Error(method + ' deadline'));
      }, 15000);
      pending.set(key, { resolve, reject, timer });
      root
        .send('Target.sendMessageToTarget', {
          sessionId: realm.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => {
          clearTimeout(timer);
          pending.delete(key);
          reject(error);
        });
    });
  };
  const evaluate = async (realm, expression) => {
    const reply = await send(realm, 'Runtime.evaluate', { expression, returnByValue: true });
    assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const anchor = async () => {
    const metric = async () =>
      (await host.send('Performance.getMetrics')).metrics.find((m) => m.name === 'Timestamp')
        .value * 1000;
    const chromeBeforeMs = await metric();
    const state = await page.evaluate(() => ({
      now: performance.now(),
      timeOrigin: performance.timeOrigin,
    }));
    const chromeAfterMs = await metric();
    return {
      chromeBeforeMs,
      chromeAfterMs,
      pageNowMs: state.now,
      timeOriginMs: state.timeOrigin,
      offsetLowerMs: chromeBeforeMs - state.now,
      offsetUpperMs: chromeAfterMs - state.now,
    };
  };
  const snapshot = () =>
    page.evaluate(() => {
      const state = globalThis.__forgeaxCpuTimelineObservation;
      const renderer = globalThis.__forgeaxGameInspection.renderer();
      if (
        renderer.state !== 'alive' ||
        renderer.rendererError ||
        renderer.execution.fault ||
        renderer.execution.world.health !== 'healthy'
      )
        throw Error('Runtime is not healthy');
      if (state.overflow) throw Error('Frame observer overflow');
      return { at: performance.now(), ready: state.frames.length, renderer };
    });
  const move = (ms) =>
    moveGame3dWindow(
      { page, signal: play.signal, state: (id) => play.state(id), wait: (ms) => play.wait(ms) },
      ms,
    );
  // Archive the exact public screenshot bytes immediately; its per-script path is reused.
  const screenshot = async (name) => {
    const receipt = await play.screenshot(name),
      bytes = await readFile(receipt.path);
    assert.equal(receipt.digest, 'sha256:' + digest(bytes));
    const path = join(output, name + '.png');
    await writeFile(path, bytes);
    return { ...receipt, path };
  };
  const closeCapture = async () => {
    if (paused && control)
      await control.call('function(){return this.resume();}').catch(() => undefined);
    for (const realm of realms) {
      if (realm.profiling) await send(realm, 'Profiler.stop').catch(() => undefined);
      await send(realm, 'Profiler.disable').catch(() => undefined);
    }
    if (observer)
      await page
        .evaluate(() => {
          const state = globalThis.__forgeaxCpuTimelineObservation;
          if (state) {
            window.removeEventListener('forgeax:frame-completed', state.complete, {
              capture: true,
            });
            window.removeEventListener('forgeax:frame-submitted', state.submit, { capture: true });
            delete globalThis.__forgeaxCpuTimelineObservation;
          }
        })
        .catch(() => undefined);
    await save('capture-report.json', report);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error('Collector closed'));
    }
    root.off('Target.receivedMessageFromTarget', receive);
    await host.detach().catch(() => undefined);
    await root.detach().catch(() => undefined);
  };
  try {
    if (play.release) {
      await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('forgeax-cpu-profile', '1');
        history.replaceState(null, '', url.href);
      });
      await play.reload();
      report.method.releaseDiagnosticHost =
        'Existing forgeax-cpu-profile query enables inspection and an idle Engine recorder; ordinary windows keep V8 Profiler and Debugger off.';
    }
    report.browser = await root.send('Browser.getVersion');
    const system = await root.send('SystemInfo.getInfo');
    report.gpu = { devices: system.gpu.devices, featureStatus: system.gpu.featureStatus };
    report.viewport = page.viewportSize();
    report.url = page.url();
    const { targetInfo } = await host.send('Target.getTargetInfo');
    const info = { ...targetInfo, title: 'Host' };
    const hostRealm = { target: info, host: true, scripts: new Map() };
    realms.push(hostRealm);
    host.on('Debugger.scriptParsed', (script) => hostRealm.scripts.set(script.scriptId, script));
    const workerTargets = (await root.send('Target.getTargets')).targetInfos.filter(
      (t) => t.type === 'worker' && t.browserContextId === info.browserContextId,
    );
    for (const target of workerTargets) {
      const { sessionId } = await root.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: false,
      });
      const realm = { target, sessionId, scripts: new Map() };
      realms.push(realm);
      realm.target = { ...target, title: await evaluate(realm, 'globalThis.name || "Worker"') };
    }
    assert(
      realms.some((r) => r.target.title === 'forgeax-engine'),
      'Engine Worker is required',
    );
    assert(
      realms.some((r) => r.target.title === 'forgeax-render'),
      'Render Worker is required',
    );
    report.targets = realms.map((r) => r.target);
    const sampledRealms = realms.filter(
      (r) => targetSelection === 'all' || r.target.title === targetSelection,
    );
    assert(sampledRealms.length > 0, 'Requested sampling target is unavailable');
    report.cpu.sampledTargets = sampledRealms.map((r) => r.target);
    report.cpu.unsampledTargets = realms
      .filter((r) => !sampledRealms.includes(r))
      .map((r) => r.target);
    await host.send('Performance.enable');
    await page.evaluate(() => {
      if (globalThis.__forgeaxCpuTimelineObservation) throw Error('CPU observer already exists');
      const state = { frames: [], submitted: [], nonReady: 0, overflow: false };
      state.complete = (event) => {
        const d = event.detail;
        if (d.presentation !== 'ready') {
          state.nonReady++;
          return;
        }
        if (state.frames.length >= 12000) {
          state.overflow = true;
          return;
        }
        state.frames.push({
          at: performance.now(),
          frameId: d.frameId,
          worldIdentity: d.worldIdentity,
          deviceGeneration: d.deviceGeneration,
          renderSubmitToCompleteMs: d.renderSubmitToCompleteMs,
        });
      };
      state.submit = (event) => {
        const d = event.detail;
        if (state.submitted.length >= 12000) {
          state.overflow = true;
          return;
        }
        state.submitted.push({
          at: performance.now(),
          frameId: d.frameId,
          worldIdentity: d.worldIdentity,
          deviceGeneration: d.deviceGeneration,
          engineUpdateMs: d.engineUpdateMs,
          renderDrawCpuMs: d.renderDrawCpuMs,
          engineCreditWaitMs: d.engineCreditWaitMs,
          renderDrawIntervalMs: d.renderDrawIntervalMs,
          renderAwaitMs: d.renderAwaitMs,
          renderQueuedMs: d.renderQueuedMs,
          renderStallReason: d.renderStallReason,
        });
      };
      window.addEventListener('forgeax:frame-completed', state.complete, { capture: true });
      window.addEventListener('forgeax:frame-submitted', state.submit, { capture: true });
      globalThis.__forgeaxCpuTimelineObservation = state;
    });
    observer = true;
    report.before = await play.state('game-3d.player');
    report.startScreenshot = await screenshot('performance-start');
    await move(3000);
    for (let i = 0; i < report.method.ordinaryWindows; i++) {
      const before = await snapshot(),
        motion = await move(report.method.ordinaryWindowMs),
        after = await snapshot();
      const count = after.ready - before.ready;
      assert(count > 30, 'Ordinary window needs positive ready-frame progress');
      report.ordinary.push({
        before,
        after,
        motion,
        readyFrames: count,
        durationMs: after.at - before.at,
        completedPerSecond: count / ((after.at - before.at) / 1000),
      });
      await save('capture-report.json', report);
    }
    for (const realm of sampledRealms) {
      await send(realm, 'Profiler.enable');
      await send(realm, 'Profiler.setSamplingInterval', {
        interval: report.method.samplingIntervalUs,
      });
    }
    const anchorsBefore = [];
    for (let i = 0; i < 3; i++) anchorsBefore.push(await anchor());
    await Promise.all(
      sampledRealms.map(async (r) => {
        await send(r, 'Profiler.start');
        r.profiling = true;
      }),
    );
    const before = await snapshot();
    const firstLiveAt = before.at;
    report.profiledMotion = await move(report.method.profiledWindowMs);
    const after = await snapshot(),
      end = after.at;
    const profiles = [];
    await Promise.all(
      sampledRealms.map(async (r) => {
        try {
          const { profile } = await send(r, 'Profiler.stop');
          r.profiling = false;
          r.profile = profile;
        } catch (error) {
          report.cpu.failures.push({ target: r.target, error: error.message });
        }
      }),
    );
    const anchorsAfter = [];
    for (let i = 0; i < 3; i++) anchorsAfter.push(await anchor());
    report.coldFirelineCpu = { anchorsBefore, anchorsAfter }; // Existing CPU-window wire contract.
    const observed = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      frames: globalThis.__forgeaxCpuTimelineObservation.frames,
      submitted: globalThis.__forgeaxCpuTimelineObservation.submitted,
      nonReady: globalThis.__forgeaxCpuTimelineObservation.nonReady,
    }));
    const frames = {
      ...observed,
      firstLiveAt,
      end,
      frames: observed.frames.filter((f) => f.at >= firstLiveAt && f.at <= end),
    };
    assert(frames.frames.length > 30, 'Profiled window needs positive ready-frame receipts');
    await save('sampled-frames.json', frames);
    const pairs = frames.frames.slice(1).map((r, i) => ({
      previous: { ...frames.frames[i], completedAtMs: frames.frames[i].at },
      current: { ...r, completedAtMs: r.at },
      completedGapMs: r.at - frames.frames[i].at,
    }));
    report.windows = {
      sampled: {
        submissionGaps: {
          worstCompletedGaps: pairs
            .filter(
              (p) =>
                p.previous.worldIdentity === p.current.worldIdentity &&
                p.previous.deviceGeneration === p.current.deviceGeneration,
            )
            .sort((a, b) => b.completedGapMs - a.completedGapMs)
            .slice(0, 5),
        },
      },
    };
    report.cpu.commonWindow = {
      startTime: Math.max(...realms.filter((r) => r.profile).map((r) => r.profile.startTime)),
      endTime: Math.min(...realms.filter((r) => r.profile).map((r) => r.profile.endTime)),
    };
    report.profiled = {
      before,
      after,
      readyFrames: after.ready - before.ready,
      durationMs: end - firstLiveAt,
    };
    const afterTargets = (await root.send('Target.getTargets')).targetInfos
      .filter((t) => t.type === 'worker' && t.browserContextId === info.browserContextId)
      .map((t) => t.targetId)
      .sort();
    assert.deepEqual(
      afterTargets,
      workerTargets.map((t) => t.targetId).sort(),
      'Worker population changed during capture',
    );
    for (const r of realms)
      if (r.profile) profiles.push({ target: r.target, profile: r.profile, scriptDigests: [] });
    await save('cpu-profiles.json', { profiles, failures: report.cpu.failures });
    await save('capture-report.json', report);
    report.host.loadAfter = loadavg();
    report.host.freeMemoryAfterBytes = freemem();
    assert.equal(report.cpu.failures.length, 0, 'CPU capture failed');
    control = await inspectGame3dApp(host);
    const pause = await control.call(
      'function(){const r=this.pause();return {ok:r.ok,error:r.ok?undefined:r.error.code};}',
    );
    assert(pause.ok);
    paused = true;
    await page.waitForFunction(
      `(${game3dArchiveDrained.toString()})(globalThis.__forgeaxGameInspection.renderer())`,
      undefined,
      { timeout: 15000 },
    );
    report.archiveBefore = await snapshot();
    report.sources = [];
    for (const realm of sampledRealms) {
      await send(realm, 'Debugger.enable');
      await evaluate(realm, 'void 0');
      const row = profiles.find((p) => p.target.targetId === realm.target.targetId);
      const wanted = new Set(row.profile.nodes.map((n) => n.callFrame.scriptId).filter(Boolean));
      for (const scriptId of wanted) {
        const metadata = realm.scripts.get(scriptId);
        if (!metadata?.url || !/^https?:/.test(metadata.url)) continue;
        const { scriptSource } = await send(realm, 'Debugger.getScriptSource', { scriptId });
        const receipt = await save('script-' + digest(scriptSource) + '.mjs', scriptSource);
        row.scriptDigests.push({ url: metadata.url, sha256: receipt.sha256 });
        report.sources.push({
          targetId: realm.target.targetId,
          scriptId,
          url: metadata.url,
          ...receipt,
        });
      }
      await send(realm, 'Debugger.disable');
      await send(realm, 'Profiler.disable');
    }
    report.archiveAfter = await snapshot();
    assert.equal(
      report.archiveBefore.ready,
      report.archiveAfter.ready,
      'Paused source archive advanced completion',
    );
    await save('cpu-profiles.json', { profiles, failures: report.cpu.failures });
    const resumed = await control.call('function(){const r=this.resume();return {ok:r.ok};}');
    assert(resumed.ok);
    paused = false;
    await play.wait(300);
    report.after = await play.state('game-3d.player');
    report.endScreenshot = await screenshot('performance-end');
    report.recovered = await snapshot();
    assert(report.recovered.ready > report.archiveAfter.ready);
    report.ok = true;
    return {
      output,
      ordinary: report.ordinary.map((r) => ({
        readyFrames: r.readyFrames,
        durationMs: r.durationMs,
        completedPerSecond: r.completedPerSecond,
      })),
      profiled: report.profiled,
      targetCount: realms.length,
    };
  } catch (error) {
    report.failures.push({ message: error.message, motion: error.motion ?? null });
    throw error;
  } finally {
    await closeCapture();
  }
}
