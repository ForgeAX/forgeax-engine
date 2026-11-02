import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeIndexedDraws } from '../native-indexed-draws.mjs';

function fixture() {
  const nativeDraws = [];
  const executions = [];
  const observed = [];
  const device = {
    createCommandEncoder() {
      return {
        beginRenderPass() {
          return {
            drawIndexed(...args) { nativeDraws.push(args); },
            executeBundles(bundles) { executions.push([...bundles]); },
          };
        },
      };
    },
    createRenderBundleEncoder() {
      const draws = [];
      return {
        drawIndexed(...args) { draws.push(args); },
        finish() { return { draws }; },
      };
    },
  };
  observeIndexedDraws(device, (count) => observed.push(count));
  return { device, nativeDraws, executions, observed };
}

test('observes inline indexed draws and preserves their native arguments', () => {
  const { device, nativeDraws, observed } = fixture();
  const pass = device.createCommandEncoder().beginRenderPass();
  pass.drawIndexed(6, 23, 2, -1, 9);
  pass.drawIndexed(3);
  assert.deepEqual(observed, [23, 1]);
  assert.deepEqual(nativeDraws, [[6, 23, 2, -1, 9], [3, 1, 0, 0, 0]]);
});

test('counts every execution of a retained folded bundle across frame resets', () => {
  const { device, observed, executions } = fixture();
  const encoder = device.createRenderBundleEncoder();
  encoder.drawIndexed(6, 1024);
  const bundle = encoder.finish();
  assert.deepEqual(observed, [], 'recording alone must not count as execution');
  device.createCommandEncoder().beginRenderPass().executeBundles([bundle]);
  assert.deepEqual(observed, [1024]);
  observed.length = 0;
  device.createCommandEncoder().beginRenderPass().executeBundles([bundle]);
  assert.deepEqual(observed, [1024], 'a cached bundle still executes its folded draw');
  assert.equal(executions[0][0], bundle);
  assert.equal(executions[1][0], bundle);
});

test('preserves one-shot bundle iterables, order and all indexed instance counts', () => {
  const { device, observed, executions } = fixture();
  const first = device.createRenderBundleEncoder();
  first.drawIndexed(6, 12);
  first.drawIndexed(6, 8);
  const a = first.finish();
  const second = device.createRenderBundleEncoder();
  second.drawIndexed(3);
  const b = second.finish();
  function* handles() { yield a; yield b; yield a; }
  device.createCommandEncoder().beginRenderPass().executeBundles(handles());
  assert.deepEqual(executions, [[a, b, a]]);
  assert.deepEqual(observed, [12, 8, 1, 12, 8]);
});

test('rejects an unobserved bundle before accepting incomplete draw counts', () => {
  const { device, executions } = fixture();
  assert.throws(() => device.createCommandEncoder().beginRenderPass().executeBundles([{}]), /unobserved/);
  assert.deepEqual(executions, []);
});
