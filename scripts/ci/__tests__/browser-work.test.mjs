import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBrowserWorkBudget, countBrowserWork } from '../../test/browser-work.mjs';
import {
  browserFixtureSources,
  uncompressedFixtureEncodings,
} from '../browser-evidence-encoding.mjs';
import budgets from '../browser-work-budgets.json' with { type: 'json' };
import { browserTestFiles } from '../run-split-vitest-browser.mjs';

test('native work instrumentation preserves receiver, arguments and promise identity', () => {
  const promise = Promise.resolve('device');
  class Adapter {
    requestDevice(value) {
      assert.equal(this.tag, 'adapter');
      assert.equal(value, 4);
      return promise;
    }
  }
  class Device {
    createShaderModule(value) {
      return value;
    }
    createRenderPipelineAsync() {
      return promise;
    }
  }
  class Buffer {
    mapAsync() {
      return promise;
    }
  }
  class Queue {
    submit(value) {
      return value;
    }
  }
  const original = Adapter.prototype.requestDevice;
  const observed = countBrowserWork({
    GPUAdapter: Adapter,
    GPUDevice: Device,
    GPUBuffer: Buffer,
    GPUQueue: Queue,
  });
  try {
    const adapter = new Adapter();
    adapter.tag = 'adapter';
    assert.equal(adapter.requestDevice(4), promise);
    const device = new Device();
    assert.equal(device.createShaderModule('module'), 'module');
    assert.equal(device.createRenderPipelineAsync(), promise);
    const buffer = new Buffer();
    assert.equal(buffer.mapAsync(1), promise);
    assert.equal(buffer.mapAsync(2), promise);
    assert.equal(new Queue().submit(9), 9);
    assert.deepEqual(observed.counts, {
      realm: 'browser-main',
      available: true,
      deviceRequests: 1,
      shaderModules: 1,
      pipelines: 1,
      readbackMaps: 1,
      submissions: 1,
    });
  } finally {
    observed.restore();
  }
  assert.equal(Adapter.prototype.requestDevice, original);
});

test('work budgets reject unavailable evidence, extra devices and removed cases', () => {
  const owner = Object.keys(budgets)[0];
  const budget = budgets[owner];
  const counts = { available: true, deviceRequests: budget.deviceRequests };
  assert.doesNotThrow(() => checkBrowserWorkBudget(owner, counts, budgets, budget.minimumCases));
  assert.throws(() => checkBrowserWorkBudget(owner, { available: true }, budgets), /Incomplete/);
  assert.throws(
    () => checkBrowserWorkBudget(owner, { ...counts, available: false }, budgets),
    /unavailable/,
  );
  assert.throws(
    () =>
      checkBrowserWorkBudget(
        owner,
        { ...counts, deviceRequests: budget.deviceRequests + 1 },
        budgets,
      ),
    /exceeded/,
  );
  assert.throws(
    () => checkBrowserWorkBudget(owner, counts, budgets, budget.minimumCases - 1),
    /case budget/,
  );
  const roster = browserTestFiles();
  for (const file of Object.keys(budgets))
    assert.ok(roster.includes(file), `stale work budget: ${file}`);
});

test('fixture encoding guard follows the current Browser roster and retains protocol acceptance', () => {
  const sources = browserFixtureSources(process.cwd(), browserTestFiles());
  assert.ok(sources.size > browserTestFiles().length);
  const violations = [...sources].flatMap(([file, text]) =>
    uncompressedFixtureEncodings(file, text),
  );
  assert.deepEqual(violations, [], 'fixture-created tapes must use explicit lossless gzip');
  assert.equal(
    uncompressedFixtureEncodings(
      '/packages/runtime/src/__tests__/new.fixture.ts',
      'encodeTape(tape)',
    ).length,
    1,
  );
  assert.equal(
    uncompressedFixtureEncodings(
      '/packages/runtime/src/__tests__/new.fixture.ts',
      "encodeTape(tape, { compression: 'none' })",
    ).length,
    1,
  );
  assert.deepEqual(
    uncompressedFixtureEncodings(
      '/packages/rhi-debug/src/__tests__/protocol.browser.test.ts',
      'encodeTape(tape)',
    ),
    [],
  );
});

test('fixed replay workloads reject repeated native queue submissions', () => {
  for (const name of ['white-balance', 'texture-generations']) {
    const file = `packages/render/src/__tests__/${name}.browser.test.ts`;
    const counts = { available: true, deviceRequests: 2, submissions: 33 };
    assert.doesNotThrow(() => checkBrowserWorkBudget(file, counts, budgets, 1));
    assert.throws(
      () => checkBrowserWorkBudget(file, { ...counts, submissions: 54 }, budgets, 1),
      /submissions/,
    );
    assert.throws(
      () => checkBrowserWorkBudget(file, { ...counts, submissions: undefined }, budgets, 1),
      /Incomplete/,
    );
    assert.throws(
      () => checkBrowserWorkBudget(file, { ...counts, deviceRequests: 1 }, budgets, 1),
      /cold-device/,
    );
  }
});
