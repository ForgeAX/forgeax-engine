import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { browserCompletionTimingSource } from '../browser_completion_timing.mjs';

function fixture(options) {
  const realm = createContext({});
  runInContext(
    `
    globalThis.calls = [];
    globalThis.failure = { original: true };
    globalThis.performance = { now: () => ++globalThis.clock };
    globalThis.clock = 0;
    globalThis.timerReceiver = {};
    globalThis.timeoutJobs = new Map();
    globalThis.rafJobs = new Map();
    let timeoutId = 0, rafId = 0;
    globalThis.setTimeout = function(callback, delay, ...args) {
      calls.push({ method:'setTimeout', receiver:this, callback, delay, args });
      if (typeof callback === 'symbol') throw failure;
      const id = ++timeoutId; timeoutJobs.set(id, { callback, args }); return id;
    };
    globalThis.clearTimeout = function(id) { calls.push({method:'clearTimeout', id}); timeoutJobs.delete(id); };
    globalThis.requestAnimationFrame = function(callback) {
      calls.push({method:'requestAnimationFrame', receiver:this, callback});
      if (typeof callback !== 'function') throw failure;
      const id = ++rafId; rafJobs.set(id, callback); return id;
    };
    globalThis.cancelAnimationFrame = function(id) { calls.push({method:'cancelAnimationFrame', id}); rafJobs.delete(id); };
    globalThis.fireTimer = (id) => { const job=timeoutJobs.get(id); timeoutJobs.delete(id); return Reflect.apply(job.callback,timerReceiver,job.args); };
    globalThis.fireRaf = (id) => { const callback=rafJobs.get(id); rafJobs.delete(id); return Reflect.apply(callback,timerReceiver,[123.5]); };
    globalThis.WebGL2RenderingContext = class {
      fenceSync(...args) { calls.push({method:'fenceSync',receiver:this,args}); return {}; }
      getSyncParameter(...args) { calls.push({method:'getSyncParameter',receiver:this,args}); if (!(this instanceof WebGL2RenderingContext)) throw failure; return 37145; }
      flush(...args) { calls.push({method:'flush',receiver:this,args}); return undefined; }
      deleteSync(...args) { calls.push({method:'deleteSync',receiver:this,args}); return undefined; }
    };
    globalThis.gl = new WebGL2RenderingContext();
    globalThis.originals = { setTimeout, requestAnimationFrame, flush:WebGL2RenderingContext.prototype.flush };
  `,
    realm,
  );
  runInContext(browserCompletionTimingSource(options), realm);
  return {
    realm,
    run: (code) => runInContext(code, realm),
    trace: realm.__forgeaxCompletionTiming,
  };
}

test('preserves native GL calls, receivers, result and original exception identity', () => {
  const { realm, run, trace } = fixture();
  trace.start();
  run(
    'globalThis.sync = gl.fenceSync(37143,0); globalThis.result=gl.getSyncParameter(sync,37140); gl.flush(); gl.deleteSync(sync);',
  );
  assert.equal(realm.result, 37145);
  assert.throws(
    () => run('WebGL2RenderingContext.prototype.getSyncParameter.call({},sync,37140)'),
    (e) => e === realm.failure,
  );
  const data = trace.stop();
  assert.equal(realm.calls.length, 5, 'Observer must issue no additional GL calls');
  assert.ok(realm.calls.slice(0, 4).every((c) => c.receiver === realm.gl));
  assert.equal(data.events[0].syncId, data.events[1].syncId);
  assert.equal(data.events[3].syncId, data.events[0].syncId);
  assert.equal(data.events[1].value, 37145);
  assert.equal(data.events.at(-1).threw, true);
  assert.equal(data.coverage.untrackedSyncCalls, 0);
  trace.restore();
  assert.equal(realm.WebGL2RenderingContext.prototype.flush, realm.originals.flush);
});

test('preserves scheduling parameters, callback this/arguments and colliding timer/rAF IDs', () => {
  const { realm, run, trace } = fixture();
  trace.start();
  run(`globalThis.delay={ valueOf(){throw failure} }; globalThis.marker={tag:1};
    globalThis.t=setTimeout.call(timerReceiver,function(...args){globalThis.timerThis=this;globalThis.timerArgs=args;return marker},delay,marker,7);
    globalThis.r=requestAnimationFrame(function(t){globalThis.rafThis=this;globalThis.rafTime=t});`);
  assert.equal(realm.t, realm.r, 'Native namespaces deliberately overlap');
  assert.equal(realm.calls[0].delay, realm.delay, 'Observer must not coerce delay again');
  assert.equal(realm.calls[0].receiver, realm.timerReceiver);
  assert.equal(trace.snapshot().pendingAtStop.length, 2);
  assert.equal(run('fireTimer(t)'), realm.marker);
  run('fireRaf(r)');
  assert.equal(realm.timerThis, realm.timerReceiver);
  assert.equal(realm.timerArgs[0], realm.marker);
  assert.equal(realm.timerArgs[1], 7);
  assert.equal(realm.rafThis, realm.timerReceiver);
  assert.equal(realm.rafTime, 123.5);
  const data = trace.stop();
  const timer = data.events.find((e) => e.kind === 'timer-schedule');
  const raf = data.events.find((e) => e.kind === 'raf-schedule');
  assert.notEqual(timer.id, raf.id);
  assert.equal(data.events.find((e) => e.kind === 'timer-fire').id, timer.id);
  assert.equal(data.events.find((e) => e.kind === 'raf-fire').id, raf.id);
  assert.equal(data.pendingAtStop.length, 0);
});

test('cancellation and callback exceptions retain native behavior; string wake is explicit missing data', () => {
  const { realm, run, trace } = fixture();
  trace.start();
  run(`globalThis.cancelled=setTimeout(()=>{},2);clearTimeout(cancelled);
    globalThis.r=requestAnimationFrame(()=>{});cancelAnimationFrame(r);
    globalThis.bad=setTimeout(()=>{throw failure},1);
    setTimeout('globalThis.nativeString=true',3);`);
  assert.throws(
    () => run('fireTimer(bad)'),
    (e) => e === realm.failure,
  );
  assert.throws(
    () => run('setTimeout(Symbol())'),
    (e) => e === realm.failure,
  );
  assert.equal(realm.timeoutJobs.has(realm.cancelled), false);
  assert.equal(realm.rafJobs.has(realm.r), false);
  const data = trace.stop();
  assert.equal(data.coverage.unsupportedTimerCallbacks, 1);
  assert.ok(data.events.some((e) => e.kind === 'timer-cancel' && e.id !== null));
  assert.ok(data.events.some((e) => e.kind === 'raf-cancel' && e.id !== null));
  assert.equal(data.events.filter((e) => e.kind === 'timer-fire').length, 1);
  assert.equal(
    realm.calls.find((c) => typeof c.callback === 'string').callback,
    'globalThis.nativeString=true',
  );
});

test('bounded overflow remains visible while native calls continue; stop/start exports are independent', () => {
  const { realm, run, trace } = fixture({ capacity: 8 });
  trace.start();
  run('for(let i=0;i<12;i++)gl.flush()');
  const first = trace.stop();
  assert.equal(realm.calls.length, 12);
  assert.equal(first.events.length, 8);
  assert.equal(first.overflow.droppedEvents, 4);
  assert.ok(first.overflow.lastAtMs >= first.overflow.firstAtMs);
  run('gl.flush()');
  assert.equal(trace.snapshot().events.length, 8);
  trace.start();
  run('gl.flush()');
  assert.equal(trace.stop().events.length, 1);
  assert.equal(first.events.length, 8);
});

test('restore preserves pending callbacks and a later hook, and removes only its own global', () => {
  const { realm, run, trace } = fixture();
  run('globalThis.early=setTimeout(()=>{globalThis.ran=(globalThis.ran??0)+1},10)');
  assert.equal(trace.start().pendingAtStart, 1);
  run(
    'globalThis.laterFlush=function(){return 42};WebGL2RenderingContext.prototype.flush=laterFlush',
  );
  const restored = trace.restore();
  assert.equal(restored.coverage.restoreConflicts[0].name, 'flush');
  assert.equal(realm.WebGL2RenderingContext.prototype.flush, realm.laterFlush);
  assert.equal(realm.setTimeout, realm.originals.setTimeout);
  assert.equal(realm.__forgeaxCompletionTiming, undefined);
  run('fireTimer(early)');
  assert.equal(realm.ran, 1);
  assert.equal(trace.snapshot().events.length, 0);
  assert.equal(trace.restore().state, 'restored');
});

test('missing WebGL methods are reported and installation never invokes them', () => {
  const realm = createContext({ performance: { now: () => 1 } });
  runInContext(browserCompletionTimingSource(), realm);
  const data = realm.__forgeaxCompletionTiming.stop();
  assert.equal(data.coverage.unavailableHooks.length, 8);
  assert.equal(data.events.length, 0);
  realm.__forgeaxCompletionTiming.restore();
});
