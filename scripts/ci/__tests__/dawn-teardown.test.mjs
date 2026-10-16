import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { teardownDawnInstance } from '../../lib/dawn-teardown.mjs';

test('the actual graphics preflight awaits native teardown before returning a failed probe', async () => {
  const source = readFileSync(new URL('../probe-local-graphics.mjs', import.meta.url), 'utf8');
  const renderProbe = runInNewContext(
    `${source.slice(source.indexOf('async function renderProbe'), source.indexOf('\nconst backend ='))}; renderProbe`,
  );
  const events = [];
  const device = {
    addEventListener() {},
    pushErrorScope() {},
    createTexture() {},
    createShaderModule() {},
    createRenderPipeline() {
      throw new Error('injected pipeline failure');
    },
    destroy: () => events.push('destroy'),
    queue: { onSubmittedWorkDone: () => events.push('drain') },
  };
  let gpu = {
    requestAdapter: async () => ({
      info: {},
      limits: {
        maxDynamicUniformBuffersPerPipelineLayout: 8,
        maxDynamicStorageBuffersPerPipelineLayout: 4,
      },
      requestDevice: async () => device,
    }),
  };
  const result = await renderProbe(gpu, undefined, (ownedDevice) =>
    teardownDawnInstance([ownedDevice], () => {
      gpu = undefined;
      events.push('release');
    }),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'render');
  assert.deepEqual(events, ['destroy', 'drain', 'release']);
  assert.equal(gpu, undefined);
  assert.match(source, /teardownDawnInstance\(device \? \[device\] : \[\]/);
});

test('Dawn teardown drains every completion callback before releasing the native instance', async () => {
  const events = [];
  const completions = [];
  const devices = [0, 1].map((id) => ({
    destroy: () => events.push(`destroy-${id}`),
    queue: {
      onSubmittedWorkDone: () =>
        new Promise((resolve) => {
          events.push(`flush-${id}`);
          completions[id] = resolve;
        }),
    },
  }));
  const done = teardownDawnInstance(devices, () => events.push('release'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['destroy-0', 'destroy-1', 'flush-0']);
  completions[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['destroy-0', 'destroy-1', 'flush-0', 'flush-1']);
  completions[1]();
  await done;
  assert.equal(events.at(-1), 'release');
});

test('strict standalone cleanup releases the instance before reporting a native failure', async () => {
  const events = [];
  const fault = new Error('native destroy fault');
  const device = {
    destroy() {
      events.push('destroy');
      throw fault;
    },
    queue: { onSubmittedWorkDone: () => events.push('flush') },
  };
  await assert.rejects(
    teardownDawnInstance([device], () => events.push('release')),
    (error) => {
      assert.deepEqual(error.errors, [fault]);
      return true;
    },
  );
  assert.deepEqual(events, ['destroy', 'flush', 'release']);
});

test('Vitest cleanup retains its explicit diagnostic channel and drains remaining devices', async () => {
  const reported = [];
  let released = false;
  await teardownDawnInstance(
    [
      {
        destroy() {
          throw new Error('destroy');
        },
        queue: {
          onSubmittedWorkDone() {
            throw new Error('flush');
          },
        },
      },
    ],
    () => {
      released = true;
    },
    (step, error) => reported.push([step, error.message]),
  );
  assert.equal(released, true);
  assert.deepEqual(reported, [
    ['device.destroy', 'destroy'],
    ['onSubmittedWorkDone', 'flush'],
  ]);
});
