import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkBrowserWorkBudget, countBrowserWork } from '../../test/browser-work.mjs';
import {
  browserFixtureSources,
  uncompressedFixtureEncodings,
} from '../browser-evidence-encoding.mjs';
import budgets from '../browser-work-budgets.json' with { type: 'json' };
import { implicitShadowWorkloads } from '../browser-workload-policy.mjs';
import { browserTestFiles } from '../run-split-vitest-browser.mjs';

test('GPU creation fixtures declare shadow resolution and directional cascade workload', () => {
  const native = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('.dawn.test.ts'));
  const sources = browserFixtureSources(process.cwd(), [...browserTestFiles(), ...native]);
  assert.ok(
    [...sources.keys()].some((file) => file.endsWith('render-worker-geometry-bootstrap.ts')),
  );
  assert.deepEqual(
    [...sources].flatMap(([file, text]) => implicitShadowWorkloads(file, text)),
    [],
  );
});

test('shadow workload policy rejects omitted product defaults and retains explicit quality cases', () => {
  const creation = (component, data) =>
    `world.spawn({ component: ${component}, data: { ${data} } });`;
  assert.equal(
    implicitShadowWorkloads('fixture.ts', creation('DirectionalLight', 'castShadow: true')).length,
    2,
  );
  for (const declaration of [
    'castShadow',
    'castShadow: enabled',
    'castShadow: enabled ? true : false',
  ])
    assert.equal(
      implicitShadowWorkloads('fixture.ts', creation('DirectionalLight', declaration)).length,
      2,
    );
  assert.equal(
    implicitShadowWorkloads(
      'fixture.ts',
      creation('DirectionalLight', 'castShadow: true, mapSize: 256'),
    ).length,
    1,
  );
  assert.equal(
    implicitShadowWorkloads('fixture.ts', creation('SpotLight', 'castShadow: true')).length,
    1,
  );
  assert.equal(implicitShadowWorkloads('fixture.ts', creation('PointLightShadow', '')).length, 1);
  for (const data of [
    'castShadow: false',
    'intensity: 2',
    'castShadow: true, mapSize, cascadeCount: 4',
  ])
    assert.deepEqual(implicitShadowWorkloads('fixture.ts', creation('DirectionalLight', data)), []);
  assert.deepEqual(
    implicitShadowWorkloads(
      'fixture.ts',
      'world.set(sun, DirectionalLight, { castShadow: true });',
    ),
    [],
  );
});

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

test('IES shares only ordinary assembly and retains independent publication and replay devices', () => {
  const file = 'packages/runtime/src/__tests__/ies-local-lights.browser.test.ts';
  const counts = { available: true, deviceRequests: 19 };
  assert.doesNotThrow(() => checkBrowserWorkBudget(file, counts, budgets, 4));
  assert.throws(
    () => checkBrowserWorkBudget(file, { ...counts, deviceRequests: 20 }, budgets, 4),
    /exceeded/,
  );
  assert.throws(
    () => checkBrowserWorkBudget(file, { ...counts, deviceRequests: 18 }, budgets, 4),
    /cold-device/,
  );
  assert.throws(() => checkBrowserWorkBudget(file, counts, budgets, 3), /case budget/);
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

test('fixture policy follows URL and dynamic-import Worker sources without executing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-browser-workload-'));
  try {
    const directory = join(root, '__tests__');
    mkdirSync(directory);
    writeFileSync(join(directory, 'owner.ts'), `new URL('./worker.ts', import.meta.url);`);
    writeFileSync(
      join(directory, 'worker.ts'),
      `import('./dynamic.ts'); throw Error('not executable');`,
    );
    writeFileSync(join(directory, 'dynamic.ts'), `encodeTape(tape);`);
    const sources = browserFixtureSources(root, ['__tests__/owner.ts']);
    assert.equal(sources.size, 3);
    assert.equal(
      [...sources].flatMap(([file, text]) => uncompressedFixtureEncodings(file, text)).length,
      1,
    );
    assert.equal(
      implicitShadowWorkloads(
        'fixture.ts',
        `({component: Render.DirectionalLight, data: {'castShadow': true}})`,
      ).length,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
