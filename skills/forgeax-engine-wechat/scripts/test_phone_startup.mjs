import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('./phone_startup_prefix.js', import.meta.url), 'utf8');
function fixture(options = {}, initialState) {
  let time = 0, nextId = 0, reads = 0;
  const timers = new Map(), modals = [], logs = [], handlers = {};
  const config = { observeFrames: true, showFrameResult: false, deadlineMs: 30000,
    windowMs: 10000, pollMs: 250, source: { manifestSha256: 'source-manifest', entrySha256: 'source-entry' }, ...options };
  let state = initialState ?? (() => ({ phase: 'ready', state: 'alive', generation: 1,
    completed: 10 + Math.floor(time * 0.05), presented: 5 + Math.floor(time * 0.04) }));
  const context = {
    Date: { now: () => time },
    console: { info: (...args) => logs.push(args), warn() {} },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: { setEnableDebug() {}, getAppBaseInfo: () => ({ SDKVersion: 'probe' }),
      showModal(value) { modals.push({ ...value, at: time }); value.complete?.(); },
      onError(callback) { handlers.error = callback; }, onUnhandledRejection(callback) { handlers.rejection = callback; },
      onHide(callback) { handlers.hide = callback; }, offHide(callback) { if (handlers.hide === callback) delete handlers.hide; } },
    __forgeaxGameInspection: { renderer() { reads++; return state(time); } },
  };
  runInNewContext(source.replaceAll('__FORGEAX_PROBE_MANIFEST__', 'source-manifest').replace('__FORGEAX_PROBE_OPTIONS__', JSON.stringify(config)), context);
  const next = () => [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  return { modals, logs, timers, handlers, context, get reads() { return reads; },
    state(value) { state = value; },
    advance(end) {
      let task;
      while ((task = next()) && task[1].at <= end) {
        timers.delete(task[0]); time = task[1].at; task[1].callback();
      }
      time = end;
    },
    delayedPoll(at) { const task = next(); timers.delete(task[0]); time = at; task[1].callback(); },
    result() { const row = logs.find(([key]) => key === '[forgeax.phone.frames]'); return row ? JSON.parse(row[1]) : undefined; },
  };
}

test('default startup diagnostic keeps its facts/fatal modal and does not poll frames', () => {
  const f = fixture({ observeFrames: false });
  assert.equal(f.modals.length, 1);
  assert.equal(f.modals[0].title, 'ForgeaX native API facts');
  f.handlers.error('original startup failure');
  assert.equal(f.modals[1].title, 'ForgeaX first fatal');
  assert.equal(f.reads, 0);
  assert.equal(f.timers.size, 0);
});

test('GL link observation leaves the ordinary game error dialog unobscured', () => {
  const f = fixture({ observeFrames: false, observeGlLink: true });
  f.handlers.error('original startup failure');
  assert.equal(f.modals.length, 0);
  assert.equal(f.reads, 0);
  assert.equal(f.timers.size, 0);
});

test('counts Renderer receipt deltas over an independent wall-clock window without startup modal', () => {
  const f = fixture();
  f.advance(9999);
  assert.equal(f.result(), undefined);
  assert.equal(f.modals.length, 0);
  f.advance(10000);
  const result = f.result();
  assert.equal(result.phase, 'complete');
  assert.equal(result.elapsedMs, 10000);
  assert.equal(result.completedDelta, 500);
  assert.equal(result.presentedDelta, 400);
  assert.equal(result.completedFps, 50);
  assert.equal(result.presentedFps, 40);
  assert.equal(result.generation, 1);
  assert.deepEqual(result.source, { manifestSha256: 'source-manifest', entrySha256: 'source-entry' });
  assert.equal(f.timers.size, 0);
  assert.equal(f.handlers.hide, undefined);
});

test('uses actual delayed elapsed time and only shows an explicitly requested final result', () => {
  const f = fixture({ showFrameResult: true });
  assert.equal(f.modals.length, 0);
  f.delayedPoll(10250);
  const result = f.result();
  assert.equal(result.elapsedMs, 10250);
  assert.equal(result.completedFps, result.completedDelta / 10.25);
  assert.equal(f.modals.length, 1);
  assert.equal(f.modals[0].at, 10250);
});

test('invalidates replacement, stopped state, native error and backgrounding without FPS output', () => {
  for (const mode of ['generation', 'stopped', 'error', 'hidden', 'regression']) {
    const f = fixture();
    f.advance(1000);
    if (mode === 'error') f.handlers.error('native failure');
    else if (mode === 'hidden') f.handlers.hide();
    else f.state(() => ({ phase: mode === 'stopped' ? 'stopped' : 'ready', state: 'alive',
      generation: mode === 'generation' ? 2 : 1, completed: mode === 'regression' ? 1 : 80, presented: 1 }));
    f.advance(2000);
    assert.equal(f.result().phase, 'failed', mode);
    assert.equal(f.result().completedFps, undefined, mode);
    assert.equal(f.result().presentedFps, undefined, mode);
    assert.equal(f.timers.size, 0, mode);
    assert.equal(f.modals.length, 0, mode);
  }
});

test('waits for a real scene presentation before baseline and bounds startup', () => {
  const f = fixture({}, () => ({ phase: 'initializing' }));
  f.advance(15000);
  assert.equal(f.result().reason, 'startup-timeout');
  assert.equal(f.result().completedFps, undefined);
  assert.equal(f.timers.size, 0);
});

test('starts the full measurement window only after the first actual scene receipt', () => {
  const f = fixture({}, now => ({ phase: 'ready', state: 'alive', generation: 3,
    completed: now < 1000 ? 0 : 1 + Math.floor((now - 1000) * 0.03),
    presented: now < 1000 ? 0 : 1 + Math.floor((now - 1000) * 0.03) }));
  f.advance(10000);
  assert.equal(f.result(), undefined);
  f.advance(11000);
  assert.equal(f.result().startupElapsedMs, 1000);
  assert.equal(f.result().elapsedMs, 10000);
  assert.equal(f.result().completedFps, 30);
  assert.equal(f.result().presentedFps, 30);
  assert.equal(f.result().generation, 3);
});
