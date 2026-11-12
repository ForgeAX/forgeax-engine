import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { inspectGame3dApp } from './inspect_game3d_app.mjs';
import { admitGame3dWorkload, assertGame3dWorkloadStable } from './game3d_workload.mjs';
import { summarizeAllocationWindow } from './allocation_window.mjs';
import { GAME3D_MOTION_PROTOCOL, moveGame3dWindow } from './game3d_motion.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const REALMS = ['forgeax-engine', 'forgeax-render'];

/** Public play reuses its output path; archive bytes before another run can replace them. */
export async function archiveScreenshot(play, output, name) {
  const captured = await play.screenshot(name);
  const bytes = await readFile(captured.path);
  assert.equal('sha256:' + hash(bytes), captured.digest);
  const path = join(output, name + '.png');
  await writeFile(path, bytes);
  return { ...captured, path };
}

/** Public project-play adapter. Raw output must be outside the source checkout. */
export default async function captureGame3dAllocations(play) {
  const output = process.env.FORGEAX_ALLOCATION_OUTPUT;
  assert(output && isAbsolute(output), 'Set FORGEAX_ALLOCATION_OUTPUT to a new absolute private directory');
  const sourceRoot = await realpath(new URL('../../../', import.meta.url));
  const parent = await realpath(dirname(output));
  const destination = resolve(parent, output.slice(dirname(output).length + 1));
  assert(destination !== sourceRoot && !destination.startsWith(sourceRoot + sep), 'Raw captures must stay outside source');
  await mkdir(output, { recursive: false });
  const save = async (name, value) => {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    await writeFile(join(output, name), bytes);
    return { path: join(output, name), sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
  };
  const { page, signal } = play;
  const browser = page.context().browser();
  assert(browser);
  const root = await browser.newBrowserCDPSession();
  const host = await page.context().newCDPSession(page);
  let control, paused = false;
  const realms = [], pending = new Map();
  let command = 0;
  const receive = ({ sessionId, message }) => {
    const data = JSON.parse(message);
    if (data.method === 'Debugger.scriptParsed') {
      const realm = realms.find(realm => realm.sessionId === sessionId);
      realm?.scripts.set(data.params.scriptId, data.params);
    }
    const key = sessionId + ':' + data.id, request = pending.get(key);
    if (request) {
      pending.delete(key); clearTimeout(request.timer);
      if (data.error) request.reject(new Error(JSON.stringify(data.error)));
      else request.resolve(data.result);
    }
  };
  root.on('Target.receivedMessageFromTarget', receive);
  const send = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = ++command, key = sessionId + ':' + id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' deadline')); }, 30000);
    pending.set(key, { resolve, reject, timer });
    root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch(error => { clearTimeout(timer); pending.delete(key); reject(error); });
  });
  const evaluate = async (realm, expression) => {
    const result = await send(realm.sessionId, 'Runtime.evaluate', { expression, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const report = {
    kind: 'game3d-moving-allocation-capture', status: 'running', sources: [], ordinary: [], windows: [],
    method: { samplingInterval: 16384, includesCollectedByMinorGC: true, includesCollectedByMajorGC: true,
      windowMs: 30000, repetitions: 3, viewport: page.viewportSize(),
      workload: `Real held keyboard W/D/S/A with ${GAME3D_MOTION_PROTOCOL}; no teleport or simulation stepping; verify finite3D trajectory, capsule clearance and travel each window`,
      qualification: 'Intrusive browser Worker allocation sampling, ordinary throughput recorded separately. Decimal bytes. Does not measure exact temporary object counts or after-GC retained object counts.' },
  };
  const snapshot = () => page.evaluate(() => {
    const state = globalThis.__forgeaxAllocationObservation;
    const renderer = globalThis.__forgeaxGameInspection.renderer();
    {
      if (renderer.state !== 'alive' || renderer.rendererError || renderer.execution.fault || renderer.execution.world.health !== 'healthy')
        throw new Error('Game runtime is not healthy');
    }
    if (!renderer.execution.workers.engine.enabled || !renderer.execution.workers.render.enabled)
      throw new Error('Both ordinary Workers are required');
    return { now: performance.now(), ready: state.ready, world: state.world, device: state.device, renderer };
  });
  const moveWindow = ms => moveGame3dWindow({ page, signal, state: name => play.state(name), wait: ms => play.wait(ms) }, ms);
  try {
    report.workload = await admitGame3dWorkload(play);
    report.workloadHelperSha256 = hash(await readFile(new URL('./game3d_workload.mjs', import.meta.url)));
    report.motionSha256 = hash(await readFile(new URL('./game3d_motion.mjs', import.meta.url)));
    report.collectorSha256 = hash(await readFile(new URL(import.meta.url)));
    report.summarySha256 = hash(await readFile(new URL('./allocation_window.mjs', import.meta.url)));
    report.appControlSha256 = hash(await readFile(new URL('./inspect_game3d_app.mjs', import.meta.url)));
    report.method.scriptArchiveSetup = 'actual-app-paused-v1';
    report.browser = await root.send('Browser.getVersion');
    const system = await root.send('SystemInfo.getInfo');
    report.gpu = { devices: system.gpu.devices, featureStatus: system.gpu.featureStatus };
    control = await inspectGame3dApp(host);
    const pause = await control.call('function(){const r=this.pause();return {ok:r.ok,error:r.ok?undefined:r.error.code};}');
    assert(pause.ok);
    paused = true;
    await page.waitForFunction(()=>globalThis.__forgeaxGameInspection.renderer().execution.frame.inFlight===0,undefined,{timeout:15000,polling:50});
    report.scriptArchive = {scope:control.scope,capability:control.capability,pause,drained:await page.evaluate(()=>globalThis.__forgeaxGameInspection.renderer())};
    for (const target of (await root.send('Target.getTargets')).targetInfos.filter(t => t.type === 'worker')) {
      const { sessionId } = await root.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      const realm = { target, sessionId, scripts: new Map() };
      realms.push(realm);
      realm.name = await evaluate(realm, 'globalThis.name');
    }
    const selected = realms.filter(realm => REALMS.includes(realm.name));
    for (const name of REALMS) assert.equal(selected.filter(realm => realm.name === name).length, 1);
    report.realms = selected.map(({ name, target }) => ({ name, target }));
    // Capture actual loaded bytes; frozen intermediate maps are authenticated by symbolize_heap_profile.
    for (const realm of selected) {
      await send(realm.sessionId, 'Debugger.enable');
      await evaluate(realm, 'void 0');
      for (const script of realm.scripts.values()) {
        if (!script.url.startsWith('http')) continue;
        const { scriptSource } = await send(realm.sessionId, 'Debugger.getScriptSource', { scriptId: script.scriptId });
        const receipt = await save('script-' + realm.name + '-' + script.scriptId + '.mjs', scriptSource);
        const source = { realm: realm.name, url: script.url, scriptId: script.scriptId, ...receipt };
        if (script.sourceMapURL) {
          let bytes;
          if (script.sourceMapURL.startsWith('data:')) {
            const at = script.sourceMapURL.indexOf(',');
            bytes = Buffer.from(script.sourceMapURL.slice(at + 1), script.sourceMapURL.slice(0, at).endsWith(';base64') ? 'base64' : 'utf8');
          } else {
            const response = await page.request.get(new URL(script.sourceMapURL, script.url).href);
            assert(response.ok()); bytes = await response.body();
          }
          const path = join(output, 'script-' + realm.name + '-' + script.scriptId + '.map');
          await writeFile(path, bytes); source.map = { path, sha256: hash(bytes), bytes: bytes.length };
        }
        report.sources.push(source);
      }
      await send(realm.sessionId, 'Debugger.disable');
    }
    await page.evaluate(() => {
      if (globalThis.__forgeaxAllocationObservation) throw new Error('Allocation observer already installed');
      const state = { ready: 0, world: undefined, device: undefined };
      state.complete = event => {
        if (event.detail.presentation !== 'ready') return;
        state.ready++; state.world = event.detail.worldIdentity; state.device = event.detail.deviceGeneration;
      };
      window.addEventListener('forgeax:frame-completed', state.complete, { capture: true });
      globalThis.__forgeaxAllocationObservation = state;
    });
    report.scriptArchive.after = await page.evaluate(()=>globalThis.__forgeaxGameInspection.renderer());
    assert.equal(report.scriptArchive.after.execution.frame.inFlight,0);
    assert.equal(report.scriptArchive.after.execution.frame.completed,report.scriptArchive.drained.execution.frame.completed,'Paused script archiving must not advance frames');
    report.scriptArchive.resume = await control.call('function(){const r=this.resume();return {ok:r.ok,error:r.ok?undefined:r.error.code};}');
    assert(report.scriptArchive.resume.ok);
    paused = false;
    await moveWindow(6000);
    report.initial = await snapshot();
    assert(report.initial.ready > 0, 'Completed-frame observer received no ready frames');
    assert.equal(report.initial.renderer.execution.render.capabilities.backendKind, 'webgpu');
    report.startScreenshot = await archiveScreenshot(play, output, 'allocation-moving-start');
    await save('report.json', report);
    for (let index = 0; index < 3; index++) {
      const before = await snapshot(), motion = await moveWindow(30000), after = await snapshot();
      assert(after.ready > before.ready);
      assert.equal(after.world, before.world); assert.equal(after.device, before.device);
      report.ordinary.push({ index, before, after, motion });
      await save('report.json', report);
    }
    for (let index = 0; index < 3; index++) {
      const beforeStart = await snapshot();
      await Promise.all(selected.map(realm => send(realm.sessionId, 'HeapProfiler.startSampling', {
        samplingInterval: 16384, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true,
      })));
      const afterStart = await snapshot(), motion = await moveWindow(30000), beforeStop = await snapshot();
      const profiles = await Promise.all(selected.map(async realm => ({ realm,
        profile: (await send(realm.sessionId, 'HeapProfiler.stopSampling')).profile })));
      const afterStop = await snapshot(), boundaries = { beforeStart, afterStart, beforeStop, afterStop };
      const row = { index, ...boundaries, motion, realms: [] };
      for (const { realm, profile } of profiles) row.realms.push({ name: realm.name,
        ...summarizeAllocationWindow(profile, boundaries),
        profile: await save('window-' + index + '-' + realm.name + '.heapprofile.json', profile) });
      report.windows.push(row); await save('report.json', report);
    }
    report.endScreenshot = await archiveScreenshot(play, output, 'allocation-moving-end');
    report.final = await snapshot();
    const targets = (await root.send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker').map(target => target.targetId).sort();
    assert.deepEqual(targets, realms.map(realm => realm.target.targetId).sort(), 'Worker population changed during capture');
    report.finalWorkload = await assertGame3dWorkloadStable(play, report.workload);
    report.status = 'complete'; await save('report.json', report);
    return { status: report.status, windows: report.windows.map(row => row.realms), report: join(output, 'report.json') };
  } catch (error) {
    report.status = 'failed'; report.failure = { message: String(error), stack: error.stack, motion: error.motion, workload: error.workload };
    await save('report.json', report); throw error;
  } finally {
    if (paused) {
      report.recoveryResume = await control.call('function(){return this.resume().ok;}').catch(error=>({error:String(error)}));
      await save('report.json',report);
    }
    await host.send('Runtime.releaseObjectGroup',{objectGroup:'game3d-app-inspection'}).catch(()=>{});
    await host.detach().catch(()=>{});
    for (const realm of realms) {
      await send(realm.sessionId, 'HeapProfiler.stopSampling').catch(() => {});
      await root.send('Target.detachFromTarget', { sessionId: realm.sessionId }).catch(() => {});
    }
    await page.evaluate(() => {
      const state = globalThis.__forgeaxAllocationObservation;
      if (state) window.removeEventListener('forgeax:frame-completed', state.complete, { capture: true });
      delete globalThis.__forgeaxAllocationObservation;
    }).catch(() => {});
    root.off('Target.receivedMessageFromTarget', receive);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Capture closed')); }
    await root.detach();
  }
}
