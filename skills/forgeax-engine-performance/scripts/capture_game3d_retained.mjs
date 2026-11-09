/** Intrusive public project-play adapter: actual App pause/drain, serial Worker census, resume. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { moveGame3dWindow } from './game3d_motion.mjs';
import { archiveScreenshot } from './capture_game3d_allocations.mjs';
import { captureTraceWindow } from './capture_trace_window.mjs';
import { inspectGame3dApp } from './inspect_game3d_app.mjs';
import { admitGame3dWorkload, assertGame3dWorkloadStable } from './game3d_workload.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
export default async function retained(play) {
  return captureGame3dHeap(play);
}

export async function captureGame3dHeap(play, traceAllocations = false) {
  const out = traceAllocations ? process.env.FORGEAX_TRACE_OUTPUT : process.env.FORGEAX_RETAINED_OUTPUT;
  assert(out && isAbsolute(out), 'Set FORGEAX_RETAINED_OUTPUT to a new absolute private directory');
  const sourceRoot = await realpath(new URL('../../../', import.meta.url));
  const destination = resolve(await realpath(dirname(out)), out.slice(dirname(out).length + 1));
  assert(
    destination !== sourceRoot && !destination.startsWith(sourceRoot + sep),
    'Raw captures must stay outside source',
  );
  await mkdir(out);
  const { page, signal } = play,
    browser = page.context().browser(),
    root = await browser.newBrowserCDPSession();
  const host = await page.context().newCDPSession(page),
    pending = new Map(),
    realms = [];
  let command = 0,
    callApp,
    paused = false;
  const report = {
    status: 'running',
    kind: traceAllocations ? 'tracked-game3d-allocations' : 'paused-game3d-retained',
    method:
      'Real motion, locate the actual public App in the inspection closure, invoke its public pause, drain inFlight=0, serial Worker forced GC and heap snapshots, resume and require completed frames. Intrusive retained census only; no ordinary allocation-rate or GC-pause claim. Closure scope lookup is a diagnostic requirement and fails if the actual App binding cannot be inspected.',
    realms: [],
  };
  const save = () => writeFile(out + '/report.json', JSON.stringify(report, null, 2) + '\n');
  root.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const data = JSON.parse(message),
      realm = realms.find((r) => r.sessionId === sessionId);
    if (data.method === 'HeapProfiler.addHeapSnapshotChunk' && realm?.chunks) {
      realm.size += Buffer.byteLength(data.params.chunk);
      if (realm.size <= 256 * 1024 * 1024) realm.chunks.push(data.params.chunk);
      else realm.overflow = true;
    }
    const key = sessionId + ':' + data.id,
      request = pending.get(key);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(key);
      data.error
        ? request.reject(new Error(JSON.stringify(data.error)))
        : request.resolve(data.result);
    }
  });
  const send = (sessionId, method, params = {}, timeout = 30000) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const id = ++command,
        key = sessionId + ':' + id,
        timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(method + ' timeout'));
        }, timeout);
      pending.set(key, { resolve, reject, timer });
      root
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => {
          clearTimeout(timer);
          pending.delete(key);
          reject(error);
        });
    });
  const inspect = () => page.evaluate(() => globalThis.__forgeaxGameInspection.renderer());

  try {
    report.workload = await admitGame3dWorkload(play);
    report.workloadHelperSha256 = hash(await readFile(new URL('./game3d_workload.mjs', import.meta.url)));
    report.motionSha256 = hash(await readFile(new URL('./game3d_motion.mjs', import.meta.url)));
    report.appControlSha256 = hash(await readFile(new URL('./inspect_game3d_app.mjs', import.meta.url)));
    report.browser = await root.send('Browser.getVersion');
    for (const target of (await root.send('Target.getTargets')).targetInfos.filter(
      (t) => t.type === 'worker',
    )) {
      const { sessionId } = await root.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: false,
      });
      const r = await send(sessionId, 'Runtime.evaluate', {
        expression: 'globalThis.name',
        returnByValue: true,
      });
      realms.push({ name: r.result.value, target, sessionId });
    }
    const selected = realms.filter((r) =>
      ['forgeax-engine', 'forgeax-render', 'forgeax-frame-clock'].includes(r.name));
    for (const name of ['forgeax-engine', 'forgeax-render'])
      assert.equal(selected.filter((r) => r.name === name).length, 1);
    assert(selected.filter((r) => r.name === 'forgeax-frame-clock').length <= 1);
    report.start = await inspect();
    report.startPlayer = await play.state('game-3d.player');
    report.motion = await moveGame3dWindow({ page, signal, state: name => play.state(name), wait: ms => play.wait(ms) }, 6000);
    report.travel = report.motion.travel;
    report.moved = await play.state('game-3d.player');
    report.movingFrame = await inspect();
    report.pictureBefore = await archiveScreenshot(play, out, 'before-paused-census');
    const control = await inspectGame3dApp(host);
    callApp = control.call;
    report.appScope = control.scope;
    report.capability = control.capability;
    report.pause = await callApp(
      'function(){ const r=this.pause(); return {ok:r.ok,error:r.ok?undefined:r.error.code}; }',
    );
    assert(report.pause.ok);
    paused = true;
    await page.waitForFunction(
      () => globalThis.__forgeaxGameInspection.renderer().execution.frame.inFlight === 0,
      undefined,
      { timeout: 15000, polling: 50 },
    );
    report.drained = await inspect();
    assert.equal(report.drained.execution.frame.inFlight, 0);
    await save();
    if (traceAllocations) {
      report.traceStartDrained = report.drained;
      report.drained = await captureTraceWindow({
        selected, send, out, report, save, inspect,
        resume: async () => {
          assert(await callApp('function(){return this.resume().ok;}'));
          paused = false;
        },
        pause: async () => {
          assert(await callApp('function(){return this.pause().ok;}'));
          paused = true;
          await page.waitForFunction(() => globalThis.__forgeaxGameInspection.renderer().execution.frame.inFlight === 0, undefined, {timeout:15000,polling:50});
        },
        move: ms => moveGame3dWindow({page,signal,state:name=>play.state(name),wait:ms=>play.wait(ms)},ms),
      });
    } else for (const realm of selected) {
      await send(realm.sessionId, 'HeapProfiler.enable');
      await send(realm.sessionId, 'HeapProfiler.collectGarbage', {}, 60000);
      const before = await send(realm.sessionId, 'Runtime.getHeapUsage');
      realm.chunks = [];
      realm.size = 0;
      realm.overflow = false;
      const started = Date.now();
      await send(
        realm.sessionId,
        'HeapProfiler.takeHeapSnapshot',
        { reportProgress: false },
        120000,
      );
      assert(!realm.overflow, 'Snapshot exceeded 256 MiB bound');
      const bytes = Buffer.from(realm.chunks.join(''));
      delete realm.chunks;
      const path = out + '/' + realm.name + '.heapsnapshot';
      await writeFile(path, bytes);
      report.realms.push({
        name: realm.name,
        target: realm.target,
        before,
        after: await send(realm.sessionId, 'Runtime.getHeapUsage'),
        snapshot: { path, bytes: bytes.length, sha256: hash(bytes) },
        snapshotWallMs: Date.now() - started,
      });
      await send(realm.sessionId, 'HeapProfiler.disable');
      await save();
    }
    report.afterSnapshots = await inspect();
    assert.equal(report.afterSnapshots.execution.frame.inFlight, 0);
    assert.equal(
      report.afterSnapshots.execution.frame.completed,
      report.drained.execution.frame.completed,
      'Paused capture must not advance frames',
    );
    report.resume = await callApp(
      'function(){ const r=this.resume(); return {ok:r.ok,error:r.ok?undefined:r.error.code}; }',
    );
    assert(report.resume.ok);
    paused = false;
    await page.waitForFunction(
      (completed) =>
        globalThis.__forgeaxGameInspection.renderer().execution.frame.completed >= completed + 30,
      report.drained.execution.frame.completed,
      { timeout: 15000, polling: 50 },
    );
    report.final = await inspect();
    assert.equal(report.final.execution.world.health, 'healthy');
    assert.equal(report.final.rendererError ?? null, null);
    assert.equal(report.final.execution.fault ?? null, null);
    report.pictureAfter = await archiveScreenshot(play, out, 'after-paused-census');
    report.finalWorkload = await assertGame3dWorkloadStable(play, report.workload);
    report.status = 'complete';
    await save();
    return { status: report.status, report: out + '/report.json' };
  } catch (error) {
    report.status = 'failed';
    report.error = { message: String(error), stack: error.stack, motion: error.motion, workload: error.workload };
    await save();
    throw error;
  } finally {
    if (paused) {
      report.recoveryResume = await callApp('function(){return this.resume().ok;}').catch(
        (error) => ({ error: String(error) }),
      );
      await save();
    }
    for (const r of realms) {
      if (r.tracking) await send(r.sessionId, 'HeapProfiler.disable', {}, 120000).catch(() => {});
      if (r.controlOwned) await send(r.sessionId,'Runtime.evaluate',{expression:'delete globalThis.__forgeaxTraceControl;delete globalThis.__forgeaxTraceRing;delete globalThis.__forgeaxTraceWitness;'}).catch(()=>{});
      await root.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
    }
    for (const r of pending.values()) {
      clearTimeout(r.timer);
      r.reject(new Error('Capture closed'));
    }
    await host
      .send('Runtime.releaseObjectGroup', { objectGroup: 'game3d-app-inspection' })
      .catch(() => {});
    await host.detach();
    await root.detach();
  }
}
