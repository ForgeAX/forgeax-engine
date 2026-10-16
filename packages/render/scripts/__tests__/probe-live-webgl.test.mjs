import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'vitest';
import { installLiveWebglProbe } from '../probe-live-webgl.mjs';

function fixture(options = {}) {
  let time = 0, nextId = 0;
  const timers = new Map(), microtasks = [], calls = [];
  const state = { generation: 1, frameId: 0, completed: 0, deviceGeneration: 0 };
  const original = {
    clear(...args) { calls.push({ method: 'clear', receiver: this, args }); time += 0.1; return options.clearResult; },
    drawElements(...args) { calls.push({ method: 'drawElements', receiver: this, args }); time += 0.2; if (options.throwDraw) throw options.throwDraw; },
    fenceSync(...args) { calls.push({ method: 'fenceSync', receiver: this, args }); time += 0.1; return {}; },
    flush() { time += 0.05; },
    clientWaitSync(sync, flags, timeout) { calls.push({ method: 'clientWaitSync', receiver: this, args: [sync, flags, timeout] }); time += 0.05; return sync.ready ? 0x911c : 0x911b; },
  };
  const gl = Object.create(original);
  for (const name of ['getParameter', 'getQuery', 'createQuery', 'beginQuery', 'endQuery', 'getSyncParameter', 'getExtension']) gl[name] = () => { throw Error('forbidden query: ' + name); };
  const canvas = { width: 2532, height: 1170, getContext(kind) { assert.equal(kind, 'webgl2'); return gl; } };
  const context = vm.createContext({ performance: { now: () => time }, queueMicrotask(cb) { microtasks.push(cb); },
    setTimeout(callback, ms) { const id = ++nextId; timers.set(id, { callback, at: time + ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
  const readReceipt = () => ({ generation: state.generation, phase: 'ready', completed: state.completed, presented: state.completed,
    frame: { frameId: state.frameId, deviceGeneration: state.deviceGeneration, pendingCompletionCount: state.frameId - state.completed },
    lastCompletion: { frameId: state.completed, deviceGeneration: state.deviceGeneration, presentation: 'ready' } });
  function tick(ms) {
    const end = time + ms; let budget = 10000;
    while (true) {
      while (microtasks.length) microtasks.shift()();
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(budget-- > 0); timers.delete(next[0]); time = Math.max(time, next[1].at); next[1].callback();
    }
    time = Math.max(time, end);
  }
  function frame() {
    gl.clear(256); gl.drawElements(4, 3, 5123, 0); state.frameId++;
    let sync = gl.fenceSync(9117, 0);
    if (options.multipleFences) { gl.flush(); sync = gl.fenceSync(9117, 0); gl.flush(); }
    tick(0);
    gl.clientWaitSync(sync, 0, 0); tick(4);
    sync.ready = true; gl.clientWaitSync(sync, 0, 0); state.completed = state.frameId; tick(26);
  }
  const install = () => vm.runInContext('(' + installLiveWebglProbe.toString() + ')', context)({ canvas, readReceipt });
  const api = () => context.__forgeaxLiveWebglProbe;
  const rows = collection => { const out = []; for (let offset = 0; ; ) { const page = api().read(collection, offset, 4); out.push(...page.rows); if (page.nextOffset === page.total) return out; offset = page.nextOffset; } };
  const restored = () => { assert.equal(gl.clear, original.clear); assert.equal(gl.fenceSync, original.fenceSync); assert.equal(gl.clientWaitSync, original.clientWaitSync); };
  return { context, gl, canvas, state, original, calls, install, tick, frame, api, rows, restored, options };
}

test('natural calls split submission, polling and receipt observations between unhooked controls', () => {
  const f = fixture(); assert.equal(f.install().status, 'running');
  for (let i = 0; i < 260 && f.api().report().status === 'running'; i++) f.frame();
  const report = f.api().report(), frames = f.rows('frames'), segments = f.rows('segments');
  assert.equal(report.status, 'complete'); assert.equal(report.methodsRestored, true); f.restored();
  assert.deepEqual(Array.from(report.windows, w => w.phase), ['control-before', 'instrumented', 'control-after']);
  assert.ok(report.windows.every(w => w.end.completed > w.start.completed));
  assert.ok(frames.length > 80 && frames.length < 110);
  assert.ok(segments.every(frame => frame.draws === 1 && frame.methods.drawElements.count === 1));
  assert.ok(segments.slice(0, -1).every(frame => frame.polls === 2 && frame.timeouts === 1 && frame.signaledAtMs >= frame.fenceReturnedAtMs));
  assert.ok(frames.every(frame => frame.completion?.exact === true));
  assert.ok(segments.every(frame => frame.glCpuMs >= 0.29 && frame.glCpuMs <= 0.31 && frame.submitWallMs >= 0.29 && frame.submitWallMs <= 0.31));
  const bounded = f.api().read('segments', 0, 64);
  assert.ok(bounded.rows.length < 64);
  assert.ok(JSON.stringify(bounded).length < 9000);
  assert.ok(JSON.stringify(JSON.stringify({ ok: true, result: { success: true, result: bounded } }, null, 2)).length + 4096 < 32768);
  for (let offset = 0; offset < frames.length; offset += 4) {
    const page = f.api().read('frames', offset, 4);
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: { success: true, result: page } }, null, 2)) < 32768);
  }
  f.api().release(); assert.equal(f.context.__forgeaxLiveWebglProbe, undefined);
});

test('multiple native fences belong to one observed Renderer frame without inflating frame counts', () => {
  const f = fixture({ multipleFences: true }); f.install();
  for (let i = 0; i < 260 && f.api().report().status === 'running'; i++) f.frame();
  const report = f.api().report();
  assert.equal(report.status, 'complete');
  const frames = f.rows('frames'), segments = f.rows('segments');
  assert.ok(segments.length > 180);
  assert.ok(frames.length < segments.length / 1.5);
  assert.ok(frames.slice(1, -1).every(frame => frame.fenceSerials.length === 2));
  assert.ok(report.summary.groupedRendererFrames === frames.length);
  assert.ok(report.summary.fenceSegments === segments.length);
  assert.ok(report.summary.nativeMethods.some(method => method.name === 'drawElements'));
  f.restored();
});

test('forwards receiver, exact argument objects, return values and native exception identity', () => {
  const returned = {}, sentinel = {}, f = fixture({ clearResult: returned }); f.install(); f.tick(2005);
  const receiver = {}, argument = new Float32Array([1, 2]);
  assert.equal(f.gl.clear.call(receiver, argument), returned);
  assert.equal(f.calls.at(-1).receiver, receiver); assert.equal(f.calls.at(-1).args[0], argument);
  f.options.throwDraw = sentinel;
  assert.throws(() => f.gl.drawElements(4, 3, 5123, 0), value => value === sentinel);
  assert.equal(f.api().report().status, 'aborted'); f.restored();
});

test('generation/extent drift, deadline and cancellation restore every installed method', () => {
  for (const mutate of [f => f.state.generation++, f => f.state.deviceGeneration++, f => f.canvas.width++]) {
    const f = fixture(); f.install(); f.tick(2005); mutate(f); f.tick(20);
    assert.equal(f.api().report().status, 'aborted'); f.restored();
  }
  const f = fixture(); f.install(); f.tick(2005); f.api().cancel(); f.restored(); assert.equal(f.api().report().status, 'cancelled');
  const g = fixture(); g.install(); g.tick(20001); g.restored(); assert.equal(g.api().report().status, 'aborted');
});

test('partial installation rolls back and foreign replacement remains intact with cleanup failure', () => {
  const f = fixture(); Object.defineProperty(f.gl, 'drawElements', { get: () => f.original.drawElements, configurable: false });
  f.install(); f.tick(2005); assert.equal(f.api().report().status, 'aborted'); f.restored();
  const g = fixture(); g.install(); g.tick(2005); const other = () => {}; g.gl.clear = other; g.tick(20);
  assert.equal(g.api().report().status, 'restore-failed'); assert.equal(g.gl.clear, other); assert.equal(g.gl.fenceSync, g.original.fenceSync);
});
