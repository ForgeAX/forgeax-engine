import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { main } from '../ci/prepare-ci-inputs.mjs';

const roots: string[] = [];
const repo = resolve(import.meta.dirname, '../..');
const contract = JSON.parse(
  readFileSync(join(repo, 'scripts/ci/build-artifact-contract.json'), 'utf8'),
);

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, value: string | object) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-input-recovery-'));
  roots.push(root);
  write(join(root, 'scripts/ci/build-artifact-contract.json'), contract);
  return root;
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

function recoveryFixture({ staleShared = false, failShard = false, corruptCore = false } = {}) {
  const root = fixture();
  for (const app of [
    'hello/triangle',
    'hello/multithreaded-execution',
    'learn-render/3.model-loading/1.model-loading',
    'shadertoy/cloud',
    'collectathon',
    'bevy/sprite',
    'perf/scene',
    'hello-multi-uv',
    'perf/10k-cubes-lights',
    'perf/shadow-stress',
  ]) {
    write(join(root, 'apps', app, 'package.json'), { scripts: { build: 'fixture' } });
  }
  const calls: string[][] = [];
  const shared = (target: string, fingerprint = 'current') =>
    write(join(target, 'shared-app-inputs/manifest.json'), { inputFingerprint: fingerprint });
  const runCommand = vi.fn(async (command: string[]) => {
    const args = command.slice(1);
    calls.push(args);
    switch (args[0]) {
      case 'scripts/ci/download-artifact-with-retry.mjs': {
        const ids = option(args, '--artifact-ids');
        if (ids === 'core')
          write(join(option(args, '--path'), 'packages/core/dist/index.js'), 'core');
        else expect(ids).toBe('shared');
        break;
      }
      case 'scripts/ci/unpack-shared-app-inputs.mjs':
        shared(option(args, '--root'), staleShared ? 'stale' : 'current');
        break;
      case 'scripts/ci/verify-build-artifact-input.mjs':
        if (corruptCore && option(args, '--root') !== root)
          return { status: 1, failure: 'corrupt core artifact' };
        expect(existsSync(join(option(args, '--root'), 'shared-app-inputs/manifest.json'))).toBe(
          true,
        );
        break;
      case 'scripts/ci/build-shared-app-inputs.mjs':
        shared(root);
        break;
      case 'scripts/ci/build-app-shard.mjs':
        expect(readFileSync(join(root, 'shared-app-inputs/manifest.json'), 'utf8')).toContain(
          'current',
        );
        if (failShard) return { status: 1, failure: 'shard build failed' };
        break;
      default:
        expect(args[0]).toMatch(
          /^(?:packages\/(?:wgpu-wasm|fbx|codec|ui-blitz)\/scripts\/ensure-wasm|scripts\/build|scripts\/ci\/materialize-app-shader-manifests)\.mjs$/,
        );
    }
    return { status: 0 };
  });
  const run = (consumer = 'smoke-fleet') =>
    main(
      [
        '--consumer',
        consumer,
        '--artifact-ids',
        '',
        '--core-artifact-ids',
        'core',
        '--shared-artifact-id',
        'shared',
        '--input-fingerprint',
        'current',
      ],
      { root, runCommand },
    );
  vi.stubEnv('EXPECTED_PRODUCT_SHA', 'a'.repeat(40));
  return { root, calls, run };
}

test('missing app transfer reuses verified core/shared inputs and builds bounded compact shards', async () => {
  const { root, calls, run } = recoveryFixture();
  expect(await run()).toMatchObject({ source: 'build' });
  expect(readFileSync(join(root, 'packages/core/dist/index.js'), 'utf8')).toBe('core');
  expect(calls.some(([script]) => script === 'scripts/build.mjs')).toBe(false);
  expect(
    calls.some(([script]) => script === 'scripts/ci/materialize-app-shader-manifests.mjs'),
  ).toBe(false);
  const shards = calls.filter(([script]) => script === 'scripts/ci/build-app-shard.mjs');
  expect(shards.map((args) => option(args, '--shard-index'))).toEqual(['0', '1', '2']);
  for (const args of shards) {
    expect(option(args, '--shard-count')).toBe('3');
    expect(args).toContain('--retain-artifact-only');
    expect(option(args, '--skip-build-app')).toBe('learn-render/3.model-loading/1.model-loading');
    expect(args.filter((_, index) => args[index - 1] === '--app').sort()).toEqual([
      'collectathon',
      'hello-multi-uv',
      'hello/multithreaded-execution',
      'hello/triangle',
      'learn-render/3.model-loading/1.model-loading',
      'perf/10k-cubes-lights',
      'perf/shadow-stress',
      'shadertoy/cloud',
    ]);
    expect(existsSync(option(args, '--output-dir'))).toBe(false);
  }
  expect(calls.at(-1)?.slice(0, 3)).toEqual([
    'scripts/ci/verify-build-artifact-input.mjs',
    '--consumer',
    'smoke-fleet',
  ]);
});

test.each([
  false,
  true,
])('shared Browser source recovery reuses only valid shared inputs (stale=%s) without app-shard builds', async (staleShared) => {
  const { root, calls, run } = recoveryFixture({ staleShared });
  expect(await run('shared-inputs-browser')).toMatchObject({ source: 'build' });
  const shards = calls.filter(([script]) => script === 'scripts/ci/build-app-shard.mjs');
  expect(shards).toHaveLength(0);
  const core = calls.findIndex(([script]) => script === 'scripts/build.mjs');
  const shared = calls.findIndex(([script]) => script === 'scripts/ci/build-shared-app-inputs.mjs');
  const shaders = calls.findIndex(
    ([script]) => script === 'scripts/ci/materialize-app-shader-manifests.mjs',
  );
  expect(core).toBeGreaterThan(-1);
  expect(calls.slice(0, core)).toContainEqual(['packages/ui-blitz/scripts/ensure-wasm.mjs']);
  if (staleShared) {
    expect(shared).toBeGreaterThan(core);
    expect(shaders).toBeGreaterThan(shared);
  } else {
    expect(shared).toBe(-1);
    const admission = calls.findIndex(
      ([script, ...args]) =>
        script === 'scripts/ci/verify-build-artifact-input.mjs' &&
        args.includes('--transfer-artifact') &&
        option(args, '--transfer-artifact') === 'shared-app-inputs',
    );
    expect(admission).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(admission);
  }
  expect(shaders).toBeGreaterThan(core);
  expect(readFileSync(join(root, 'shared-app-inputs/manifest.json'), 'utf8')).toContain('current');
  expect(calls[shaders]).not.toContain('--app-root');
  expect(calls.at(-1)?.slice(0, 3)).toEqual([
    'scripts/ci/verify-build-artifact-input.mjs',
    '--consumer',
    'shared-inputs-browser',
  ]);
});

test.each([
  { staleShared: true },
  { corruptCore: true },
])('invalid shared/core admission rebuilds before app recovery: %j', async (scenario) => {
  const { root, calls, run } = recoveryFixture(scenario);
  await run();
  expect(existsSync(join(root, 'packages/core/dist/index.js'))).toBe(!scenario.corruptCore);
  if (scenario.staleShared)
    expect(readFileSync(join(root, 'packages/core/dist/index.js'), 'utf8')).toBe('core');
  const coreAdmission = calls.findIndex(
    ([script, ...args]) =>
      script === 'scripts/ci/verify-build-artifact-input.mjs' &&
      args.includes('--transfer-artifact') &&
      option(args, '--transfer-artifact') === 'core-build',
  );
  const base = calls.findIndex(([script]) => script === 'scripts/build.mjs');
  expect(coreAdmission).toBeGreaterThan(-1);
  expect(base).toBeGreaterThan(coreAdmission);
  const app = calls.findIndex(([script]) => script === 'scripts/ci/build-app-shard.mjs');
  expect(base).toBeGreaterThan(-1);
  expect(app).toBeGreaterThan(base);
  expect(
    calls.some(([script]) => script === 'scripts/ci/materialize-app-shader-manifests.mjs'),
  ).toBe(false);
});

test('failed app recovery stays red and removes temporary shard output', async () => {
  const { calls, run } = recoveryFixture({ failShard: true });
  await expect(run()).rejects.toThrow('CI input preparation failed: shard build failed');
  const shards = calls.filter(([script]) => script === 'scripts/ci/build-app-shard.mjs');
  expect(shards).toHaveLength(1);
  expect(existsSync(option(shards[0], '--output-dir'))).toBe(false);
});

test('source recovery retains app shaders while removing bundles and preserving source files', () => {
  const root = fixture();
  const app = join(root, 'apps/alpha');
  write(join(app, 'package.json'), { name: '@fixture/alpha', scripts: { build: 'fixture' } });
  write(join(app, 'src/main.ts'), 'source');
  write(join(app, 'dist/shaders/manifest.json'), { entries: [], materialShaders: [] });
  write(join(app, 'dist/assets/unneeded.bin'), 'large full-bundle asset');
  write(join(root, 'scripts/build-apps.mjs'), 'process.exit(0);');
  const output = join(root, 'shard-output');
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'scripts/ci/build-app-shard.mjs'),
      '--root',
      root,
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--output-dir',
      output,
      '--retain-artifact-only',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(existsSync(join(app, 'dist/assets/unneeded.bin'))).toBe(false);
  expect(JSON.parse(readFileSync(join(app, 'dist/shaders/manifest.json'), 'utf8'))).toEqual({
    entries: [],
    materialShaders: [],
  });
  expect(readFileSync(join(app, 'src/main.ts'), 'utf8')).toBe('source');
  const report = JSON.parse(result.stdout);
  for (const path of report.artifactInventory) {
    expect(readFileSync(join(root, path))).toEqual(readFileSync(join(output, 'artifacts', path)));
  }
});

test('source recovery never prunes app outputs after a failed build', () => {
  const root = fixture();
  write(join(root, 'apps/alpha/package.json'), {
    name: '@fixture/alpha',
    scripts: { build: 'fixture' },
  });
  write(join(root, 'apps/alpha/dist/sentinel'), 'keep');
  write(join(root, 'scripts/build-apps.mjs'), 'process.exit(1);');
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'scripts/ci/build-app-shard.mjs'),
      '--root',
      root,
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--output-dir',
      join(root, 'shard-output'),
      '--retain-artifact-only',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(readFileSync(join(root, 'apps/alpha/dist/sentinel'), 'utf8')).toBe('keep');
});

test('scoped shard recovery builds and compacts only selected apps without changing ownership', () => {
  const root = fixture();
  for (const app of ['alpha', 'beta', 'gamma', 'omega']) {
    write(join(root, 'apps', app, 'package.json'), { scripts: { build: 'fixture' } });
    write(join(root, 'apps', app, 'dist/shaders/manifest.json'), { entries: [] });
    write(join(root, 'apps', app, 'dist/sentinel'), 'full bundle');
  }
  write(
    join(root, 'scripts/build-apps.mjs'),
    "import { appendFileSync } from 'node:fs'; appendFileSync('builds.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');",
  );
  const reports = [];
  for (const index of [0, 1, 2]) {
    const result = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/ci/build-app-shard.mjs'),
        '--root',
        root,
        '--shard-count',
        '3',
        '--shard-index',
        String(index),
        '--output-dir',
        join(root, `shard-${index}`),
        '--app',
        'alpha',
        '--app',
        'gamma',
        '--retain-artifact-only',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    reports.push(JSON.parse(result.stdout));
  }
  expect(reports.map((report) => report.apps)).toEqual([['alpha'], [], ['gamma']]);
  expect(
    readFileSync(join(root, 'builds.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    ['--app-shard-shader-delta', 'alpha'],
    ['--app-shard-shader-delta', 'gamma'],
  ]);
  for (const app of ['alpha', 'gamma']) {
    expect(existsSync(join(root, 'apps', app, 'dist/sentinel'))).toBe(false);
    expect(existsSync(join(root, 'apps', app, 'dist/shaders/manifest.json'))).toBe(true);
  }
  for (const app of ['beta', 'omega']) {
    expect(readFileSync(join(root, 'apps', app, 'dist/sentinel'), 'utf8')).toBe('full bundle');
  }
});

test('invalid recovery scope fails before building or pruning outputs', () => {
  const root = fixture();
  write(join(root, 'apps/alpha/package.json'), { scripts: { build: 'fixture' } });
  write(join(root, 'apps/alpha/dist/sentinel'), 'keep');
  write(join(root, 'scripts/build-apps.mjs'), "throw new Error('must not build');");
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'scripts/ci/build-app-shard.mjs'),
      '--root',
      root,
      '--app',
      'missing',
      '--output-dir',
      join(root, 'shard-output'),
      '--retain-artifact-only',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).code).toBe('ci-app-shard-app-not-in-roster');
  expect(readFileSync(join(root, 'apps/alpha/dist/sentinel'), 'utf8')).toBe('keep');
});

test('optional uploads get the in-place retry and app consumers receive base artifact IDs', () => {
  const upload = readFileSync(
    join(repo, '.github/actions/upload-artifact-with-retry/action.yml'),
    'utf8',
  );
  for (const name of ['Back off before retry 1', 'Retry artifact transfer in place']) {
    const step = upload.slice(upload.indexOf(`- name: ${name}`)).split('\n    - name:')[0];
    expect(step).toMatch(/if: steps\.upload\.outcome == 'failure'/);
    expect(step).not.toContain('inputs.required');
  }
  const exhausted = upload.slice(upload.indexOf('- name: Fail after exhausted artifact transfer'));
  expect(exhausted).toContain("inputs.required == 'true'");
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  for (const consumer of ['smoke-fleet', 'shared-inputs-browser']) {
    const start = workflow.indexOf(`          consumer: ${consumer}\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const step = workflow.slice(start).split('\n      - ')[0];
    if (consumer === 'smoke-fleet') {
      expect(step).toMatch(
        /core-artifact-ids: \$\{\{ needs\.build-artifacts\.outputs\.core_artifact_ids \}\}/,
      );
    } else {
      expect(step).toMatch(
        /artifact-ids: \$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}/,
      );
      expect(step).toMatch(
        /shared-artifact-id: \$\{\{ needs\.shared-app-inputs\.outputs\.shared_artifact_id \}\}/,
      );
      expect(step).not.toContain('needs.build-artifacts');
    }
  }
});
