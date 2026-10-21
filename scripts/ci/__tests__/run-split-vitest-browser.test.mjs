import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { runGroups } from '../../lib/run-bounded-groups.mjs';
import hostFiles from '../browser-host-files.json' with { type: 'json' };
import { browserProcessCacheDir } from '../browser-process-cache.mjs';
import {
  assignBrowserGroupsToShards,
  browserConfigForGroup,
  browserGroupIsHostOnly,
  browserGroupRequiresExclusiveRunner,
  browserGroupRunOrder,
  browserGroupWeight,
  browserProducerReadiness,
  browserTestFiles,
  ciBrowserShardTailSeconds,
  parseArgs,
} from '../run-split-vitest-browser.mjs';

test('browser host contracts never share a GPU owner group', () => {
  assert.equal(new Set(hostFiles).size, hostFiles.length);
  assert.ok(
    hostFiles.includes('packages/audio-webaudio/src/__tests__/music-transport.browser.test.ts'),
  );
  assert.ok(
    hostFiles.includes('packages/audio-webaudio/src/__tests__/acoustic-regions.browser.test.ts'),
  );
  assert.equal(browserGroupIsHostOnly([]), false);
  assert.equal(browserGroupIsHostOnly(['new-owner.browser.test.ts']), false);
  assert.equal(browserGroupIsHostOnly([...hostFiles, 'new-owner.browser.test.ts']), false);
  assert.ok(hostFiles.every((file) => browserTestFiles().includes(file)));
  for (const size of [1, 8, 24]) {
    const groups = dryRunGroups(size);
    for (const file of hostFiles) {
      const owners = groups.filter((group) => group.includes(file));
      assert.equal(owners.length, 1);
      assert.ok(
        owners[0].every((owner) => hostFiles.includes(owner)),
        owners[0].join(','),
      );
    }
  }
});

test('render worker preload uses its pinned optimizer fixture in an exclusive process', () => {
  const workerFile = 'packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts';
  const transformationsFile =
    'apps/learn-render/1.getting-started/5.transformations/src/__tests__/onerror-gate.browser.test.ts';
  assert.equal(browserGroupRequiresExclusiveRunner([workerFile]), true);
  assert.equal(
    browserConfigForGroup([workerFile]),
    'config/vitest.render-preload-fixture.config.ts',
  );
  assert.equal(
    browserConfigForGroup([
      workerFile,
      'packages/runtime/src/__tests__/multi-camera.browser.test.ts',
    ]),
    'config/vitest.browser.config.ts',
  );
  assert.equal(browserGroupRequiresExclusiveRunner([transformationsFile]), true);
  for (const size of [1, 8, 24]) {
    const groups = dryRunGroups(size);
    for (const file of [workerFile, transformationsFile]) {
      assert.deepEqual(
        groups.filter((group) => group.includes(file)),
        [[file]],
      );
    }
  }
});

test('Three output, rendering and texture journeys do not share one process deadline', () => {
  const files = ['output', 'render', 'texture'].map(
    (name) => `packages/three/src/__tests__/${name}.browser.test.ts`,
  );
  for (const size of [8, 24, 1]) {
    const groups = dryRunGroups(size);
    const owners = files.map((file) => {
      const matches = groups.filter((group) => group.includes(file));
      assert.equal(matches.length, 1);
      return matches[0];
    });
    assert.equal(new Set(owners).size, files.length);
  }
  for (const file of files) assert.ok(browserGroupWeight([file]) > 5);
});

test('Three authored-light shadow journeys retain three complete independent processes', () => {
  const targets = ['directional', 'point', 'spot'].map(
    (kind) => `packages/three/src/__tests__/shadow-${kind}.browser.test.ts`,
  );
  for (const size of [8, 24, 1]) {
    const groups = dryRunGroups(size);
    assert.deepEqual(
      groups.filter((group) => group.some((file) => targets.includes(file))).sort(),
      targets.map((target) => [target]).sort(),
    );
  }
  assert.ok(targets.every((target) => browserGroupWeight([target]) > 5));
});

test('host groups keep their deadline and start without Python or a GPU lease', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-browser-host-'));
  const fixture = join(temporary, 'vitest.mjs');
  writeFileSync(fixture, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const module = new URL('../run-split-vitest-browser.mjs', import.meta.url).href;
  const program = `import { runGroup } from ${JSON.stringify(module)};
    await runGroup({cliPath:process.argv[1],group:JSON.parse(process.argv[2]),groupIndex:1,groupCount:1,maxWorkers:1});`;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', program, fixture, JSON.stringify(hostFiles.slice(0, 1))],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, PATH: temporary, FORGEAX_LOCAL_GPU_LEASE: '1' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /config\/vitest.browser-host.config.ts/);
    assert.doesNotMatch(result.stderr, /\[local-gpu\]/);
    const prefix = '[browser-gate] process-start ';
    const line = result.stderr.split('\n').find((value) => value.startsWith(prefix));
    assert.equal(JSON.parse(line.slice(prefix.length)).timeoutMs, 300_000);
    // Windows uses its absolute PowerShell holder, so hiding Python cannot
    // reject native admission there. Its real holder/lease controls live in
    // local-gpu-lease.test.mjs; this negative checks the POSIX Python route.
    if (process.platform === 'win32') return;
    const native = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        program,
        fixture,
        JSON.stringify(['packages/runtime/src/__tests__/multi-camera.browser.test.ts']),
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, PATH: temporary, FORGEAX_LOCAL_GPU_LEASE: '1' },
      },
    );
    assert.equal(native.status, 1);
    assert.match(native.stderr, /ENOENT|POSIX/);
    assert.doesNotMatch(native.stdout, /config\/vitest.browser.config.ts/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('completed browser attempts retire only their own optimizer cache on pass and failure', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-browser-cache-'));
  const fixture = join(temporary, 'vitest.mjs');
  const cacheModule = new URL('../browser-process-cache.mjs', import.meta.url).href;
  const module = new URL('../run-split-vitest-browser.mjs', import.meta.url).href;
  const neighbor = browserProcessCacheDir(process.cwd(), process.pid);
  mkdirSync(neighbor, { recursive: true });
  writeFileSync(join(neighbor, 'live-owner'), 'preserve');
  writeFileSync(
    fixture,
    `import {mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {browserProcessCacheDir} from ${JSON.stringify(cacheModule)};
    const cache=browserProcessCacheDir(process.cwd(),process.pid);
    mkdirSync(join(cache,'host'),{recursive:true});
    mkdirSync(join(cache,'renderer'),{recursive:true});
    writeFileSync(join(cache,'host','compiled'),'host');
    writeFileSync(join(cache,'renderer','compiled'),'renderer');
    console.log('owned-cache='+JSON.stringify({pid:process.pid,cache}));
    if (process.env.FORGEAX_CACHE_FIXTURE_EXIT === '1') console.error('Browser connection was closed');
    process.exitCode=Number(process.env.FORGEAX_CACHE_FIXTURE_EXIT);`,
  );
  const program = `import {runGroup} from ${JSON.stringify(module)};
    await runGroup({cliPath:process.argv[1],group:JSON.parse(process.argv[2]),groupIndex:1,groupCount:1,maxWorkers:1});`;
  try {
    for (const exit of [0, 1]) {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', program, fixture, JSON.stringify(hostFiles.slice(0, 1))],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, FORGEAX_CACHE_FIXTURE_EXIT: String(exit) },
        },
      );
      assert.equal(result.status, exit, result.stderr);
      assert.equal(
        result.stdout.split('\n').filter((line) => line.startsWith('owned-cache=')).length,
        1,
        'a failed group must remain failed without a second process',
      );
      const line = result.stdout.split('\n').find((line) => line.startsWith('owned-cache='));
      assert.ok(line, result.stderr);
      const owned = JSON.parse(line.slice('owned-cache='.length));
      assert.notEqual(owned.pid, process.pid);
      assert.equal(owned.cache, browserProcessCacheDir(process.cwd(), owned.pid));
      assert.throws(() => readFileSync(join(owned.cache, 'host', 'compiled')), { code: 'ENOENT' });
      assert.throws(() => readFileSync(join(owned.cache, 'renderer', 'compiled')), {
        code: 'ENOENT',
      });
      assert.equal(readFileSync(join(neighbor, 'live-owner'), 'utf8'), 'preserve');
    }
  } finally {
    rmSync(neighbor, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('host guard rejects graphics before native acquisition and preserves 2D canvas', () => {
  let acquisitions = 0;
  class Canvas {
    getContext(kind) {
      acquisitions++;
      return kind;
    }
  }
  class Offscreen {
    getContext(kind) {
      acquisitions++;
      return kind;
    }
  }
  const navigator = {
    gpu: {
      requestAdapter() {
        acquisitions++;
      },
    },
  };
  runInNewContext(readFileSync('config/browser-host-guard.mjs', 'utf8'), {
    navigator,
    HTMLCanvasElement: Canvas,
    OffscreenCanvas: Offscreen,
  });
  assert.throws(() => navigator.gpu.requestAdapter(), /host contract requested graphics/);
  for (const canvas of [new Canvas(), new Offscreen()]) {
    for (const kind of ['webgpu', 'webgl', 'webgl2', 'experimental-webgl']) {
      for (const argument of [kind, Object(kind), { [Symbol.toPrimitive]: () => kind }])
        assert.throws(() => canvas.getContext(argument), /host contract requested graphics/);
    }
  }
  assert.equal(acquisitions, 0);
  assert.equal(new Canvas().getContext('2d'), '2d');
  assert.equal(acquisitions, 1);
  let conversions = 0;
  assert.equal(
    new Offscreen().getContext({
      [Symbol.toPrimitive](hint) {
        assert.equal(hint, 'string');
        conversions++;
        return '2d';
      },
    }),
    '2d',
  );
  assert.equal(conversions, 1);
  assert.equal(acquisitions, 2);
  assert.throws(() => new Canvas().getContext(Symbol('webgl')), /Cannot convert a Symbol/);
  assert.equal(acquisitions, 2);
});

test('Preview child execution receives its documented preparation deadline', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-browser-deadline-'));
  const fixture = join(temporary, 'vitest.mjs');
  writeFileSync(fixture, "process.stdout.write('coordinator child completed\\n');");
  const module = new URL('../run-split-vitest-browser.mjs', import.meta.url).href;
  const program = `import { runGroup } from ${JSON.stringify(module)};
    await runGroup({cliPath:process.argv[1],group:JSON.parse(process.argv[2]),groupIndex:1,groupCount:1,maxWorkers:1});`;
  try {
    for (const [file, expected] of [
      ['apps/preview/__tests__/preview.browser.test.ts', 420_000],
      ['packages/runtime/src/__tests__/multi-camera.browser.test.ts', 300_000],
      ['packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts', 300_000],
      ['packages/runtime/src/__tests__/solar-atmosphere-fog-time.browser.test.ts', 300_000],
      ['packages/runtime/src/__tests__/solar-atmosphere-mesh-occlusion.browser.test.ts', 300_000],
      [
        'packages/runtime/src/__tests__/solar-atmosphere-transparent-forward.browser.test.ts',
        300_000,
      ],
      [
        'packages/runtime/src/__tests__/solar-atmosphere-transparent-deferred.browser.test.ts',
        300_000,
      ],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', program, fixture, JSON.stringify([file])],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const prefix = '[browser-gate] process-start ';
      const line = result.stderr.split('\n').find((value) => value.startsWith(prefix));
      assert.ok(line, 'the real coordinator must start its bounded child');
      assert.equal(JSON.parse(line.slice(prefix.length)).timeoutMs, expected);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('native worker asset-owner loss receives isolation without changing other browser headers', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-browser-isolation-'));
  const fixture = join(temporary, 'vitest.mjs');
  writeFileSync(fixture, 'console.log(process.env.FORGEAX_BROWSER_CROSS_ORIGIN_ISOLATED);');
  const module = new URL('../run-split-vitest-browser.mjs', import.meta.url).href;
  const program = `import { runGroup } from ${JSON.stringify(module)};
    await runGroup({cliPath:process.argv[1],group:JSON.parse(process.argv[2]),groupIndex:1,groupCount:1,maxWorkers:1});`;
  try {
    for (const [file, isolated] of [
      ['packages/app/__tests__/engine-worker-asset-loss.browser.test.ts', '1'],
      ['packages/app/__tests__/worker-policy.browser.test.ts', '1'],
      ['packages/app/__tests__/render-worker.browser.test.ts', '0'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', program, fixture, JSON.stringify([file])],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), isolated);
      const prefix = '[browser-gate] process-start ';
      const line = result.stderr.split('\n').find((value) => value.startsWith(prefix));
      assert.ok(line, 'the official coordinator starts the bounded native child');
      assert.equal(JSON.parse(line.slice(prefix.length)).timeoutMs, 300_000);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('lighting-channel sources and writers conserve both paths in bounded batches', () => {
  const groups = dryRunGroups();
  const files = groups.flat();
  for (const mode of ['world', 'publication'])
    for (const receiver of ['rigid', 'skin'])
      for (const renderPath of ['forward', 'deferred']) {
        const file = `packages/runtime/src/__tests__/lighting-channels-${mode}-${receiver}-${renderPath}.browser.test.ts`;
        assert.equal(files.filter((candidate) => candidate === file).length, 1);
        assert.ok(groups.find((group) => group.includes(file)).length <= 4);
        assert.match(readFileSync(file, 'utf8'), /timeout: 300_000/);
      }
  for (const mode of ['world'])
    for (const receiver of ['sections', 'instances', 'transparent', 'physical']) {
      const file = `packages/runtime/src/__tests__/lighting-channels-${mode}-${receiver}.browser.test.ts`;
      assert.equal(files.filter((candidate) => candidate === file).length, 1);
      assert.ok(groups.find((group) => group.includes(file)).length <= 4);
      assert.match(readFileSync(file, 'utf8'), /timeout: 300_000/);
      assert.ok(
        readFileSync(file, 'utf8').includes(
          `runChannelBrowserCase('${mode}', '${receiver}', 'both')`,
        ),
      );
    }
  assert.equal(
    files.includes('packages/runtime/src/__tests__/lighting-channels.browser.test.ts'),
    false,
  );
  assert.match(
    readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8'),
    /const browserGroupTimeoutMs = 300_000;/,
  );
});

test('short renderer deadlines own an exclusive runner without serializing ordinary groups', () => {
  for (const file of [
    'packages/render/src/__tests__/managed-material-runtime.browser.test.ts',
    'packages/runtime/src/__tests__/barrel-distortion-zero-size.browser.test.ts',
    'packages/runtime/src/__tests__/clamp-to-last.e2e.browser.test.ts',
    'packages/runtime/src/__tests__/composite-skybox-cross-world.browser.test.ts',
    'apps/learn-render/1.getting-started/4.textures/src/__tests__/onerror-gate.browser.test.ts',
  ]) {
    assert.equal(browserGroupRequiresExclusiveRunner([file]), true);
    assert.deepEqual(
      dryRunGroups().filter((group) => group.includes(file)),
      [[file]],
    );
  }
  assert.equal(browserGroupRequiresExclusiveRunner([]), false);
});

test('the measured video benchmark keeps neighboring render groups outside its memory window', () => {
  assert.equal(
    browserGroupRequiresExclusiveRunner([
      'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
    ]),
    true,
  );
  assert.equal(
    browserGroupRequiresExclusiveRunner([
      'packages/runtime/src/__tests__/wave1-rendering-p0.browser.test.ts',
      'packages/runtime/src/__tests__/wave1-shadow-diagnostic.browser.test.ts',
      'packages/runtime/src/__tests__/weapon-spirit-material.browser.test.ts',
      'packages/ui/src/preview/__tests__/capture-determinism.browser.test.ts',
    ]),
    false,
    'ordinary render groups retain concurrency outside the benchmark',
  );
});

test('the measured color-lighting visual group gets an exclusive runner slot', () => {
  const target =
    'apps/parity/color-lighting/src/visual/__tests__/vertex-color-visual.browser.test.ts';
  const groups = dryRunGroups();
  const ownerGroups = groups.filter((group) => group.includes(target));

  assert.equal(ownerGroups.length, 1, 'the visual owner stays in exactly one group');
  assert.equal(ownerGroups[0].length, 8, 'the measured owner keeps its full existing group');
  assert.equal(browserGroupRequiresExclusiveRunner(ownerGroups[0]), true);
});

test('the complete nine-light owner drains competing browser groups', () => {
  const file = 'packages/runtime/src/__tests__/light-casters-9-light.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(file)),
    [[file]],
  );
  assert.equal(browserGroupRequiresExclusiveRunner([file]), true);
  assert.equal(
    browserGroupRequiresExclusiveRunner([
      'packages/render/src/publication/__tests__/canvas.browser.test.ts',
    ]),
    false,
    'ordinary groups keep their existing concurrency',
  );
});

test('large render-worker owners retain singleton groups with exclusive runner admission', () => {
  const groups = dryRunGroups();
  for (const file of [
    'packages/app/__tests__/engine-worker-asset-loss.browser.test.ts',
    'packages/app/__tests__/render-worker-environment.browser.test.ts',
    'packages/app/__tests__/render-worker-tiles.browser.test.ts',
    'packages/app/__tests__/render-worker-deformation.browser.test.ts',
    'packages/app/__tests__/render-worker-multi-camera.browser.test.ts',
  ]) {
    const owners = groups.filter((group) => group.includes(file));
    assert.deepEqual(owners, [[file]], 'retain the complete existing owner exactly once');
    assert.equal(browserGroupRequiresExclusiveRunner(owners[0]), true, file);
  }
});

test('nested render-worker preload failures own a fresh exclusive browser process', () => {
  const target = 'packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );
  assert.equal(browserGroupRequiresExclusiveRunner([target]), true);
});

test('the complete environment presentation owner keeps its original deadline in a fresh process', () => {
  const target = 'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts';
  const expected = [
    ...browserTestFiles(),
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ].sort();
  for (const groupSize of [4, 8, 16]) {
    const groups = dryRunGroups(groupSize);
    assert.deepEqual(groups.flat().sort(), expected, 'all browser owners remain scheduled once');
    assert.deepEqual(
      groups.filter((group) => group.includes(target)),
      [[target]],
    );
    for (const neighbor of ['framebuffer-snapshot', 'light-casters-9-light', 'material-mrt']) {
      assert.equal(
        groups.flat().filter((file) => file.endsWith(`/${neighbor}.browser.test.ts`)).length,
        1,
      );
    }
  }
  assert.equal(
    browserGroupRequiresExclusiveRunner([target]),
    true,
    'the complete measured environment owner drains neighboring groups',
  );
});

test('floating harness experiments stay outside the Engine browser roster', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-roster-'));
  try {
    const engine = 'packages/render/src/__tests__/owner.browser.test.ts';
    const experiment = '.forgeax-harness/solo/example/evidence/probe.browser.test.ts';
    for (const file of [engine, experiment]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(browserTestFiles(root), [engine]);
    const config = readFileSync('config/vitest-browser-project.ts', 'utf8');
    assert.ok(config.includes("'**/.forgeax-harness/**'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function dryRunGroups(groupSize = 8) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      `--group-size=${groupSize}`,
      '--shard-count=1',
      '--shard-index=0',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(': ') + 2).split(', '));
}

test('browser discovery preserves repository-relative exclusions while retaining Engine owners', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-browser-discovery-'));
  const admitted = ['apps/demo/example.browser.test.ts', 'packages/render/example.browser.test.ts'];
  const excluded = [
    '.forgeax-harness/experiments/probe.browser.test.ts',
    'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts',
    'docs/reports/roi25/raw/frozen-source/packages/runtime/src/__tests__/subsurface.browser.test.ts',
  ];
  try {
    for (const file of [...admitted, ...excluded]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(browserTestFiles(root).sort(), admitted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser discovery skips owned native build outputs without hiding a source directory named target', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-browser-generated-'));
  const owners = ['packages/render/target/owner.browser.test.ts'];
  const generated = [
    'packages/wgpu-wasm/target/generated.browser.test.ts',
    'packages/dawn-node/.native-build/generated.browser.test.ts',
  ];
  try {
    for (const file of [...owners, ...generated]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(browserTestFiles(root), owners);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SSAO onerror gate keeps a bounded lavapipe cold-start budget', () => {
  const source = readFileSync(
    'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
    'utf8',
  );
  assert.match(source, /onerrorGate\('learn-render 5\.9 ssao',[\s\S]*90_000\)/);
});

test('hello triangle retains its bootstrap deadline in a fresh process', () => {
  const target =
    'apps/learn-render/1.getting-started/2.hello-triangle/src/__tests__/onerror-gate.browser.test.ts';
  const expected = [
    ...browserTestFiles(),
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ].sort();
  for (const groupSize of [4, 8, 16]) {
    const groups = dryRunGroups(groupSize);
    assert.deepEqual(groups.flat().sort(), expected);
    assert.deepEqual(
      groups.filter((group) => group.includes(target)),
      [[target]],
    );
  }
  const source = readFileSync(target, 'utf8');
  assert.match(source, /const GATE_TIMEOUT_MS = 30_000;/);
  assert.match(
    source,
    /bootstrapDeadline = performance\.now\(\) \+ GATE_TIMEOUT_MS - GATE_SETTLE_MARGIN_MS;/,
  );
  assert.match(source, /\}, GATE_TIMEOUT_MS\);/);
});

test('preview browser owners are isolated from ordinary bounded groups', () => {
  const groups = dryRunGroups();
  const previewGroup = groups.find((group) =>
    group.some((file) => file.startsWith('apps/preview/')),
  );
  assert.ok(previewGroup);
  assert.deepEqual(previewGroup, ['apps/preview/__tests__/preview.browser.test.ts']);

  const regularGroups = groups.filter((group) => group !== previewGroup);
  assert.ok(regularGroups.every((group) => group.length <= 8));

  const files = groups.flat();
  assert.equal(new Set(files).size, files.length, 'a browser test may belong to only one group');
});

test('all five complete solar scenes conserve the roster and bounded fresh processes', () => {
  const targets = [
    'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-fog-time.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-mesh-occlusion.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-transparent-forward.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-transparent-deferred.browser.test.ts',
  ];
  const target = targets[0];
  const replay = 'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts';
  const r32float =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const groups = dryRunGroups();
  const files = groups.flat();
  const expectedFiles = [...browserTestFiles(), r32float].sort();

  assert.deepEqual([...files].sort(), expectedFiles, 'browser roster must be conserved exactly');
  for (const owner of targets) {
    assert.equal(files.filter((file) => file === owner).length, 1);
    assert.deepEqual(
      groups.filter((group) => group.includes(owner)),
      [[owner]],
    );
    assert.equal(browserGroupRequiresExclusiveRunner([owner]), true);
  }
  assert.deepEqual(
    groups.filter((group) => group.includes(replay)),
    [[replay]],
    'the complete equal-time replay must own a fresh process under its original deadlines',
  );

  assert.equal(browserGroupRequiresExclusiveRunner([target]), true);

  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced');
  const totals = [0, 0, 0, 0];
  for (const [index, group] of groups.entries())
    totals[assignment[index]] += browserGroupWeight(group);
  assert.ok(Math.max(...totals) - Math.min(...totals) < 60, `imbalanced seconds: ${totals}`);
});

for (const target of [
  'packages/runtime/src/__tests__/material-publication.browser.test.ts',
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  'packages/runtime/src/__tests__/standard-gbuffer-replay.browser.test.ts',
  'packages/runtime/src/__tests__/canvas-texture.browser.test.ts',
  'packages/runtime/src/__tests__/lod-transition.browser.test.ts',
  'packages/runtime/src/__tests__/barrel-distortion-output.browser.test.ts',
  'packages/runtime/src/__tests__/barrel-distortion-zero-size.browser.test.ts',
  'packages/runtime/src/__tests__/clamp-to-last.e2e.browser.test.ts',
  'packages/runtime/src/__tests__/composite-skybox-cross-world.browser.test.ts',
  'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
  'packages/runtime/src/__tests__/multi-camera.browser.test.ts',
  'packages/render/src/__tests__/ssr-gpu-dispatch.browser.test.ts',
]) {
  test(`${target} keeps its complete journey in a bounded singleton`, () => {
    const expectedFiles = [
      ...browserTestFiles(),
      'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
    ].sort();
    for (const groupSize of [8, 16]) {
      const groups = dryRunGroups(groupSize);
      assert.deepEqual(groups.flat().sort(), expectedFiles, 'preserve the exact browser roster');
      assert.deepEqual(
        groups.filter((group) => group.includes(target)),
        [[target]],
        'the measured owner must not consume a shared group deadline',
      );
    }
    const runner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
    assert.match(runner, /const browserGroupTimeoutMs = 300_000;/);
  });
}

test('real multi-camera Worker capture and replacement owns a bounded browser process', () => {
  const target = 'packages/app/__tests__/render-worker-multi-camera.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );
  assert.equal(groups.flat().filter((file) => file === target).length, 1);
});

test('runtime and ray rendering groups retain their roster within four-file process budgets', () => {
  const expected = [
    ...browserTestFiles(),
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ].sort();
  for (const groupSize of [8, 16]) {
    const groups = dryRunGroups(groupSize);
    assert.deepEqual(groups.flat().sort(), expected);
    for (const group of groups) {
      if (
        group.some(
          (file) =>
            file.startsWith('packages/runtime/src/__tests__/') ||
            file.startsWith('packages/render/src/__tests__/raytracing/'),
        )
      ) {
        assert.ok(group.length <= 4, `runtime group exceeds its process budget: ${group}`);
        if (group.length > 1)
          assert.ok(
            browserGroupWeight(group) <= 150,
            `serial group leaves too little room inside the 300-second deadline: ${group}`,
          );
      }
    }
  }
});

test('renderer construction owners retain dedicated process boundaries', () => {
  const groups = dryRunGroups();
  const lifecycleHeavy = groups.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\/src\/__tests__\/onerror-gate\.browser\.test\.ts$/.test(
        file,
      ),
    ),
  );
  assert.equal(lifecycleHeavy.length, 4);
  assert.ok(lifecycleHeavy.every((group) => group.length === 1));
  assert.deepEqual(
    lifecycleHeavy
      .map(
        (group) =>
          group[0]?.match(
            /5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\//,
          )?.[0],
      )
      .sort(),
    [
      '5.advanced-lighting/6.hdr/',
      '5.advanced-lighting/7.bloom/',
      '5.advanced-lighting/8.deferred-shading/',
      '5.advanced-lighting/9.ssao/',
    ],
  );
  assert.equal(
    lifecycleHeavy.filter((group) => group.some((file) => file.includes('/7.bloom/'))).length,
    1,
  );
  const thinWrapper = 'packages/app/__tests__/thin-wrapper.browser.test.ts';
  assert.deepEqual(
    groups.filter((group) => group.includes(thinWrapper)),
    [[thinWrapper]],
    'the real createApp(canvas) renderer construction must start from a fresh browser process',
  );
  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /thinWrapperBrowserFile/);
});

test('Wave 1 rendering owners fit within the ordinary browser group budget', () => {
  const groups = dryRunGroups();
  const wave1Files = [
    'packages/runtime/src/__tests__/volumetric-fog-stability.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-dynamic-geometry.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-rendering-materials.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-rendering-p0.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-rendering-recovery.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-shadow-diagnostic.browser.test.ts',
    'packages/runtime/src/__tests__/weapon-spirit-material.browser.test.ts',
    'packages/ui/src/preview/__tests__/capture-determinism.browser.test.ts',
  ];
  const wave1Groups = groups.filter((group) => group.some((file) => wave1Files.includes(file)));
  assert.ok(wave1Groups.every((group) => group.length <= 4));
  assert.deepEqual(
    wave1Groups
      .flat()
      .filter((file) => wave1Files.includes(file))
      .sort(),
    wave1Files.sort(),
    'Wave 1 long owners must be conserved in the bounded groups',
  );
});

test('large instancing acceptance owns an isolated long-lived group', () => {
  const target = 'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /instancingStaticBrowserFile/);
  assert.match(browserRunner, /instancingStaticBrowserGroupTimeoutMs = 900_000/);
  assert.match(browserRunner, /group\.includes\(instancingStaticBrowserFile\)/);
});

test('IBL demos share one bounded on-demand producer boundary', () => {
  const groups = dryRunGroups();
  const iblFiles = [
    'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts',
    'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts',
  ];
  const iblGroup = groups.find((group) => group.includes(iblFiles[0]));
  assert.deepEqual(iblGroup, [
    'apps/hello/topology/src/__tests__/topology.browser.test.ts',
    ...iblFiles,
    'apps/learn-render/6.pbr/4.transmission-refraction/src/__tests__/onerror-gate.browser.test.ts',
  ]);
  assert.ok(iblFiles.every((file) => iblGroup.includes(file)));

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /iblIrradianceBrowserFile/);
  assert.match(browserRunner, /iblSpecularBrowserFile/);
  assert.equal(browserProducerReadiness(iblGroup), 'on-demand');
  assert.doesNotMatch(browserRunner, /advancedLightingSingleton/);
});

test('direct-light browser producer owns an isolated long-lived group', () => {
  const directLightFile =
    'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(directLightFile)),
    [[directLightFile]],
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /directLightBrowserFile/);
  assert.match(browserRunner, /directLightBrowserGroupTimeoutMs = 420_000/);
  assert.match(browserRunner, /group\.includes\(directLightBrowserFile\)/);
});

test('generated LOD capture and replay retain one complete browser owner', () => {
  const file = 'packages/runtime/src/__tests__/generated-lod.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(file)),
    [[file]],
  );
  const runner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(runner, /generatedLodBrowserGroupTimeoutMs = 630_000/);
  assert.match(runner, /group\.includes\(generatedLodBrowserFile\)/);
  assert.match(runner, /browserGroupTimeoutMs = 300_000/);
});

test('color-lighting capture cases stay within the regular browser budget', () => {
  const groups = dryRunGroups(16);
  const colorLightingGroups = groups.filter((group) =>
    group.some((file) => file.startsWith('apps/parity/color-lighting/cases/')),
  );
  assert.ok(colorLightingGroups.length > 1);
  assert.ok(colorLightingGroups.every((group) => group.length <= 4));
  assert.ok(
    colorLightingGroups.every((group) =>
      group.every((file) => file.startsWith('apps/parity/color-lighting/cases/')),
    ),
  );

  const files = groups.flat();
  assert.equal(new Set(files).size, files.length, 'a browser test may belong to only one group');
  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /colorLightingCaseGroupSize = 4/);
});

test('asset-heavy browser owners share one on-demand Pack boundary', () => {
  const groups = dryRunGroups();
  const assetHeavyOwners = groups.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/6\.pbr\/(?:2\.ibl-irradiance|3\.ibl-specular|4\.transmission-refraction)\//.test(
        file,
      ),
    ),
  );
  assert.equal(assetHeavyOwners.length, 1);
  assert.equal(assetHeavyOwners[0].length, 4);
  assert.ok(
    assetHeavyOwners[0].includes('apps/hello/topology/src/__tests__/topology.browser.test.ts'),
  );
  assert.equal(browserProducerReadiness(assetHeavyOwners[0]), 'on-demand');
});

test('ordinary groups cook on demand while Preview requires its catalog', () => {
  assert.equal(
    browserProducerReadiness(['apps/preview/probe.test.ts'], 'on-demand'),
    'before-consume',
  );
  assert.equal(browserProducerReadiness(['packages/app/probe.test.ts']), 'on-demand');
  assert.equal(
    browserProducerReadiness(['packages/app/probe.test.ts'], 'before-consume'),
    'before-consume',
  );
});

test('Render Worker groups own the runner after repeated cgroup OOM beside a neighbor', () => {
  for (const file of [
    'packages/app/__tests__/render-worker.browser.test.ts',
    'packages/app/__tests__/render-worker-contract.browser.test.ts',
    'packages/app/__tests__/render-worker-deformation.browser.test.ts',
  ]) {
    assert.equal(browserGroupRequiresExclusiveRunner([file]), true, file);
  }
});

test('before-consume catalog producers own the runner and are charged every lane', () => {
  const surface = ['packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts'];
  const preview = ['apps/preview/__tests__/preview.browser.test.ts'];
  const ordinary = ['packages/runtime/src/__tests__/multi-camera.browser.test.ts'];
  for (const group of [surface, preview]) {
    assert.equal(browserProducerReadiness(group, 'on-demand'), 'before-consume');
    assert.equal(browserGroupRequiresExclusiveRunner(group), true);
  }
  assert.equal(browserGroupRequiresExclusiveRunner(ordinary), false);
  // One exclusive group on a two-lane runner displaces as much as two equal
  // shared groups, so LPT balances it against them.
  const shared = [ordinary, ordinary];
  const assignment = assignBrowserGroupsToShards([surface, ...shared], 2, 'balanced', {
    concurrency: 2,
  });
  assert.notEqual(assignment[0], assignment[1]);
  assert.equal(assignment[1], assignment[2]);
});

test('Surface provenance owns a singleton with its complete before-consume catalog', () => {
  const target = 'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );
  assert.equal(browserProducerReadiness([target], 'on-demand'), 'before-consume');
  const runner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(runner, /const surfaceProvenanceBrowserGroupTimeoutMs = 360_000;/);
  assert.match(
    runner,
    /group\.includes\(surfaceProvenanceBrowserFile\)\s*\? surfaceProvenanceBrowserGroupTimeoutMs/,
  );
  assert.match(readFileSync(target, 'utf8'), /timeout: 300_000/);
});

test('twelve shadow contact cases retain three independent four-filter processes', () => {
  const targets = ['column', 'centimeter-1024', 'centimeter-2048'].map(
    (name) => `packages/runtime/src/__tests__/shadow-contact-${name}.browser.test.ts`,
  );
  assert.deepEqual(
    dryRunGroups().filter((group) => group.some((file) => file.includes('/shadow-contact'))),
    targets.sort().map((target) => [target]),
  );
});

test('Render Worker pressure and recovery keep all cases in one independent process', () => {
  const target = 'packages/app/__tests__/render-worker.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(target)),
    [[target]],
  );
});

test('Render Worker content owners retain every case in separate complete processes', () => {
  const groups = dryRunGroups();
  for (const name of ['deformation', 'geometry', 'media', 'tiles', 'environment']) {
    const target = `packages/app/__tests__/render-worker-${name}.browser.test.ts`;
    assert.deepEqual(
      groups.filter((group) => group.includes(target)),
      [[target]],
    );
  }
});

test('VFX mesh local lighting and native publication retain independent complete processes', () => {
  const groups = dryRunGroups();
  for (const name of ['vfx-mesh-lighting', 'vfx-mesh-lighting-publication']) {
    const target = `packages/runtime/src/__tests__/${name}.browser.test.ts`;
    assert.deepEqual(
      groups.filter((group) => group.includes(target)),
      [[target]],
    );
  }
});

test('two host-loss recovery cycles own a fresh complete process', () => {
  const target = 'packages/runtime/src/__tests__/wave1-rendering-recovery.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(target)),
    [[target]],
  );
});

test('r32float generation integration is projected into exactly one browser group', () => {
  const target =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const groups = dryRunGroups();
  const matchingGroups = groups.filter((group) => group.includes(target));
  assert.equal(matchingGroups.length, 1);
  assert.equal(groups.flat().filter((file) => file === target).length, 1);

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /r32floatCapabilityGenerationTest/);
  const browserProject = readFileSync('config/vitest-browser-project.ts', 'utf8');
  assert.ok(
    browserProject.includes(`'${target}'`),
    'the browser project must admit the scheduled integration file',
  );
});

test('CI browser shards use deterministic cost balancing without dropping groups', () => {
  const groups = dryRunGroups();
  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced');
  assert.equal(assignment.length, groups.length);
  assert.ok(assignment.every((shard) => Number.isInteger(shard) && shard >= 0 && shard < 4));

  const totals = [0, 0, 0, 0];
  for (const [index, group] of groups.entries())
    totals[assignment[index]] += browserGroupWeight(group);
  const instancing = groups.findIndex((group) =>
    group.includes('apps/parity/instancing-static/src/__tests__/instances.browser.test.ts'),
  );
  assert.ok(Math.max(...totals) - Math.min(...totals) < 60, `imbalanced seconds: ${totals}`);
  assert.notEqual(instancing, -1);

  const directLight = groups.findIndex((group) =>
    group.some((file) => file.includes('direct-light')),
  );
  const reflection = groups.findIndex((group) =>
    group.some((file) => file.includes('render-target-reflection')),
  );
  assert.notEqual(directLight, -1);
  assert.notEqual(reflection, -1);
  // A roster addition can legitimately place these two owners on one shard.
  // LPT promises balanced deterministic assignment, not pairwise separation.
  assert.deepEqual(assignBrowserGroupsToShards(structuredClone(groups), 4, 'balanced'), assignment);

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /--shard-strategy/);
  assert.match(browserRunner, /strategy=\$\{options\.shardStrategy\}/);
});

test('serial CI tails are reserved as concurrency-scaled group seconds', () => {
  const concurrency = 2;
  for (const groupSize of [8, 16]) {
    const groups = dryRunGroups(groupSize);
    const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced', {
      tailSeconds: ciBrowserShardTailSeconds,
      concurrency,
    });
    const laneSeconds = (group) =>
      browserGroupWeight(group) * (browserGroupRequiresExclusiveRunner(group) ? concurrency : 1);
    const groupSeconds = [0, 0, 0, 0];
    for (const [index, group] of groups.entries())
      groupSeconds[assignment[index]] += laneSeconds(group);
    assert.ok(
      groupSeconds.every((seconds) => seconds > 0),
      `idle Vitest lane: ${groupSeconds}`,
    );
    const withTails = groupSeconds.map(
      (seconds, shard) => seconds + (ciBrowserShardTailSeconds[shard] ?? 0) * concurrency,
    );
    const largest = Math.max(...groups.map(laneSeconds));
    assert.ok(
      Math.max(...withTails) - Math.min(...withTails) <= largest,
      `tail-aware lanes are imbalanced: ${withTails}`,
    );
    assert.ok(groupSeconds[2] < groupSeconds[3]);
  }
});

test('CI tail reservations match the shards that run the serial tails', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobStart = ci.indexOf('  vitest-browser-shard:\n');
  const job = ci.slice(jobStart, ci.indexOf('\n  vitest-browser:\n', jobStart));
  assert.match(job, /FORGEAX_BROWSER_FIXED_SMOKE: '1'/);
  assert.match(job, /--group-concurrency=2\n/);
  assert.match(
    job,
    /node scripts\/ci\/run-with-runner-cpu-affinity\.mjs --\s+xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0\s+node scripts\/ci\/run-split-vitest-browser\.mjs/,
  );
  assert.match(job, /--shard-count=4\n/);
  assert.match(job, /shard: \[0, 1, 2, 3\]/);
  assert.match(job, /- name: Verify actual browser test discovery\n\s+if: matrix\.shard == 0\n/);
  assert.match(
    job,
    /- name: Preserve render browser failure evidence\n\s+if: failure\(\) && hashFiles\(/,
  );
  assert.match(
    job,
    /- name: Runtime Pack Worker dev\/build JS\/TS browser gate\n\s+if: matrix\.shard == 1\n/,
  );
  assert.match(
    job,
    /- name: Mesh interchange Catalog and RHI replay browser gate\n\s+if: matrix\.shard == 2\n/,
  );
  assert.match(
    job,
    /node scripts\/ci\/run-with-runner-cpu-affinity\.mjs --\s+xvfb-run -a pnpm --filter @forgeax\/engine-devkit test:runtime-browser/,
  );
  assert.match(
    job,
    /node scripts\/ci\/run-with-runner-cpu-affinity\.mjs --\s+xvfb-run -a pnpm --filter @forgeax\/mesh-io-parity verify/,
  );
  assert.match(
    job,
    /- name: Preserve Runtime Pack Worker evidence\n\s+if: failure\(\) && matrix\.shard == 1\n/,
  );
});

test('measured file seconds cover the current browser roster and drive group weights', () => {
  const table = JSON.parse(readFileSync('scripts/ci/browser-file-seconds.json', 'utf8'));
  assert.ok(table.sourceRuns.length > 0, 'measured seconds name their source runs');
  const roster = new Set(dryRunGroups().flat());
  const measured = Object.keys(table.files);
  assert.deepEqual(
    measured.filter((file) => !roster.has(file)),
    [],
    'a removed or renamed browser file must leave the measured table',
  );
  assert.ok(measured.length >= roster.size * 0.85, 'most of the roster is measured');
  for (const [file, seconds] of Object.entries(table.files)) {
    assert.ok(Number.isFinite(seconds) && seconds > 0, `${file}: ${seconds}`);
    assert.equal(browserGroupWeight([file]), seconds, `${file} includes startup exactly once`);
  }
});

test('fixed-smoke shard remains a real Vitest lane', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      '--group-size=8',
      '--shard-strategy=balanced',
      '--shard-index=0',
      '--shard-count=4',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_BROWSER_FIXED_SMOKE: '1' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /owns fixed post-Vitest smoke work/);
  assert.match(result.stdout, /^group-/m);
});

test('browser group concurrency defaults to one and is bounded at three lanes', () => {
  assert.equal(parseArgs([]).groupConcurrency, 1);
  assert.equal(parseArgs(['--group-concurrency=2']).groupConcurrency, 2);
  assert.throws(() => parseArgs(['--group-concurrency=4']), /--group-concurrency/);
  assert.throws(() => parseArgs(['--group-concurrency=0']), /--group-concurrency/);
});

test('concurrent browser lanes launch the heaviest selected owners first', () => {
  const groups = [
    ['apps/a.browser.test.ts'],
    ['packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts'],
    ['apps/b.browser.test.ts', 'apps/c.browser.test.ts'],
    ['apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts'],
  ];
  const selected = [0, 1, 3];
  assert.equal(browserGroupRunOrder(groups, selected, 1), undefined);
  assert.deepEqual(browserGroupRunOrder(groups, selected, 2), [1, 2, 0]);
});

test('exclusive browser owners do not fragment otherwise concurrent batches', async () => {
  const groups = [
    Array.from({ length: 8 }, (_, index) => `apps/ordinary-${index}.browser.test.ts`),
    ['packages/runtime/src/__tests__/barrel-distortion-zero-size.browser.test.ts'],
    ['apps/game-capability-lab/__tests__/hud-ui.browser.test.ts'],
  ];
  assert.ok(browserGroupWeight(groups[0]) > browserGroupWeight(groups[1]));
  assert.ok(browserGroupWeight(groups[1]) >= browserGroupWeight(groups[2]));
  const selected = [0, 1, 2];
  let ordinaryActive = 0;
  let ordinaryPeak = 0;
  const visited = [];
  await runGroups({
    groups: selected,
    concurrency: 2,
    order: browserGroupRunOrder(groups, selected, 2),
    isExclusive: (index) => browserGroupRequiresExclusiveRunner(groups[index]),
    runGroupImpl: async (index) => {
      const exclusive = browserGroupRequiresExclusiveRunner(groups[index]);
      if (exclusive) assert.equal(ordinaryActive, 0);
      else ordinaryPeak = Math.max(ordinaryPeak, ++ordinaryActive);
      visited.push(index);
      await Promise.resolve();
      if (!exclusive) ordinaryActive -= 1;
    },
  });
  assert.equal(ordinaryPeak, 2);
  assert.deepEqual(visited.toSorted(), selected);
});

test('four Browser shards conserve the complete roster within the runner budget', () => {
  assert.throws(() => parseArgs(['--shard-count=5']), /--shard-count/);
  assert.throws(() => parseArgs(['--shard-index=4']), /--shard-index/);
  const groups = dryRunGroups();
  const assigned = assignBrowserGroupsToShards(groups, 4, 'balanced', {
    tailSeconds: ciBrowserShardTailSeconds,
    concurrency: 2,
  });
  const seen = [];
  for (let shard = 0; shard < 4; shard++) {
    const options = parseArgs(['--shard-count=4', `--shard-index=${shard}`]);
    assert.equal(options.shardIndex, shard);
    const selected = groups.filter((_group, index) => assigned[index] === shard);
    assert.ok(selected.length > 0, `shard ${shard} must carry test work`);
    seen.push(...selected.flat());
  }
  assert.deepEqual(seen.toSorted(), groups.flat().toSorted());
  assert.equal(new Set(seen).size, seen.length);
});

test('isolated renderer owners do not share a native browser lifetime', () => {
  const groups = dryRunGroups();
  for (const file of [
    'packages/runtime/src/__tests__/framebuffer-snapshot.browser.test.ts',
    'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts',
    'packages/runtime/src/__tests__/light-casters-9-light.browser.test.ts',
    'packages/runtime/src/__tests__/material-mrt.browser.test.ts',
    'packages/runtime/src/__tests__/subsurface.browser.test.ts',
  ]) {
    assert.deepEqual(
      groups.filter((group) => group.includes(file)),
      [[file]],
    );
  }
});

test('the native PCM loop owner retains a fresh complete browser process', () => {
  const file = 'packages/audio-webaudio/src/__tests__/pcm-stream.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(file)),
    [[file]],
  );
});

// Run37361872160: both overlapping pairs exceeded their original bounds;
// the environment/calibration neighbors passed their unchanged solo retries.
test('exclusive renderer owners drain neighboring browser groups', async () => {
  const files = [
    'packages/three/src/__tests__/material-output-0.browser.test.ts',
    'packages/three/src/__tests__/material-output-1.browser.test.ts',
    'packages/app/__tests__/subsurface.browser.test.ts',
    'apps/learn-render/1.getting-started/4.textures/src/__tests__/onerror-gate.browser.test.ts',
    'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
    'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-fog-time.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-mesh-occlusion.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-transparent-forward.browser.test.ts',
    'packages/runtime/src/__tests__/solar-atmosphere-transparent-deferred.browser.test.ts',
    'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts',
  ];
  for (const file of files) {
    assert.equal(browserGroupRequiresExclusiveRunner([file]), true, file);
    assert.deepEqual(
      dryRunGroups().filter((group) => group.includes(file)),
      [[file]],
    );
  }
  const groups = [['ordinary-a'], ...files.map((file) => [file]), ['ordinary-b']];
  let active = 0;
  const visited = [];
  await runGroups({
    groups: groups.map((_group, index) => index),
    concurrency: 2,
    isExclusive: (index) => browserGroupRequiresExclusiveRunner(groups[index]),
    runGroupImpl: async (index) => {
      if (browserGroupRequiresExclusiveRunner(groups[index])) assert.equal(active, 0);
      active += 1;
      if (browserGroupRequiresExclusiveRunner(groups[index])) assert.equal(active, 1);
      visited.push(index);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    },
  });
  assert.deepEqual(
    visited.toSorted((a, b) => a - b),
    groups.map((_group, index) => index),
  );
});
