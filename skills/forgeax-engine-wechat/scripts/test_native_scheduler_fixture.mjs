import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function fixture() {
  let now = 0;
  const pending = [];
  const preferred = [];
  const context = vm.createContext({
    wx: {
      getWindowInfo: () => ({ windowWidth: 844, windowHeight: 390, pixelRatio: 3 }),
      getPerformance: () => ({ now: () => now }),
      createCanvas: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }),
      setPreferredFramesPerSecond: fps => preferred.push(fps),
    },
    requestAnimationFrame: callback => pending.push(callback),
  });
  vm.runInContext(readFileSync(new URL('./native_scheduler_fixture.js', import.meta.url), 'utf8'), context);
  return { api: context.__forgeaxNativeScheduler, preferred,
    advance(count, milliseconds = 1000 / 60) {
      for (let index = 0; index < count; index++) { now += milliseconds; pending.shift()(); }
    } };
}

test('derives native callback cadence from 600 actual timestamps and bounds storage', () => {
  const f = fixture();
  f.api.start();
  f.advance(600);
  const result = f.api.state();
  assert.equal(result.status, 'complete');
  assert.equal(result.sampleCount, 600);
  assert.equal(result.scope, 'native-callback-cadence-only');
  assert.ok(Math.abs(result.callbackFps - 60) < 1e-8);
  f.advance(20);
  assert.equal(f.api.samples().length, 600);
});

test('stopping retains partial timing and the next capture uses only its own callbacks', () => {
  const f = fixture();
  f.api.start();
  f.advance(10, 20);
  assert.equal(f.api.stop().status, 'incomplete');
  f.api.start({ preferredFramesPerSecond: 60 });
  f.advance(600, 25);
  assert.equal(f.api.state().callbackFps, 40);
  assert.deepEqual(f.preferred, [60]);
});
