import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const manager =
  process.env.npm_execpath ??
  (process.env.COREPACK_ROOT ? join(process.env.COREPACK_ROOT, 'dist/pnpm.js') : undefined);
assert.ok(manager, 'run this command-transport regression through pnpm');
const command = ['.js', '.cjs', '.mjs'].includes(extname(manager))
  ? [process.execPath, manager]
  : [manager];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax suite % '));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'suite-entry-transport',
      private: true,
      packageManager: manifest.packageManager,
      scripts: {
        'test:browser': manifest.scripts['test:browser'],
        'test:dawn': manifest.scripts['test:dawn'],
        'build:engine': 'node fixture-step.mjs build',
      },
    }),
  );
  write('pnpm-workspace.yaml', readFileSync(resolve('pnpm-workspace.yaml')));
  write(
    'fixture-step.mjs',
    `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({step:process.argv[2],args:process.argv.slice(3),
      visibility:process.env.FORGEAX_BROWSER_ENTITY_VISIBILITY, sample:process.env.FIXTURE_SAMPLE,
      concurrency:process.env.FORGEAX_PACKAGE_BUILD_CONCURRENCY,
      manifest:process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST, options:process.env.NODE_OPTIONS})+'\\n');
    if(process.env.FIXTURE_FAIL===process.argv[2]) { console.error('retained fixture failure'); process.exitCode=7; }
  `,
  );
  write('scripts/ci/run-test-suite.mjs', '');
  copyFileSync(
    resolve('scripts/ci/run-test-suite.mjs'),
    join(root, 'scripts/ci/run-test-suite.mjs'),
  );
  write('scripts/lib/pnpm-command.mjs', '');
  copyFileSync(resolve('scripts/lib/pnpm-command.mjs'), join(root, 'scripts/lib/pnpm-command.mjs'));
  // The downstream GPU tools are outside this transport fixture. Real child
  // processes validate forwarding, serial ownership and failure propagation;
  // this fixture supplies no rendering or GPU acceptance evidence.
  write(
    'scripts/ci/local-gpu-lease.mjs',
    `
    import {spawnSync} from 'node:child_process';
    const result=spawnSync(process.argv[5],process.argv.slice(6),{stdio:'inherit',env:process.env});
    if(result.error) throw result.error; process.exitCode=result.status;
  `,
  );
  write('node_modules/vitest/vitest.mjs', "import '../../fixture-step.mjs';\n");
  write(
    'scripts/ci/run-split-vitest-browser.mjs',
    "process.argv[2]='browser'; await import('../../fixture-step.mjs');\n",
  );
  write(
    'scripts/build-shared-inputs.mjs',
    "process.argv.splice(2,0,'shared'); await import('../fixture-step.mjs');\n",
  );
  write(
    'scripts/ci/run-dawn-gate.mjs',
    "process.argv[2]='dawn'; await import('../../fixture-step.mjs');\n",
  );
  for (const [name, step, script] of [
    ['@forgeax/engine-devkit', 'devkit', 'test:runtime-browser'],
    ['@forgeax/mesh-io-parity', 'mesh-io', 'verify'],
  ])
    write(
      `packages/${step}/package.json`,
      JSON.stringify({
        name,
        private: true,
        scripts: { [script]: `node ../../fixture-step.mjs ${step}` },
      }),
    );
  return root;
}

test('workspace pnpm executes smoke environment assignments and preserves literal arguments', async () => {
  const root = fixture();
  try {
    const fixtureManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    fixtureManifest.scripts['smoke:env'] =
      'FIXTURE_SAMPLE="a b:50%" node fixture-step.mjs env "x y"';
    writeFileSync(join(root, 'package.json'), JSON.stringify(fixtureManifest));
    const result = spawnSync(command[0], [...command.slice(1), 'smoke:env'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, FIXTURE_LOG: join(root, 'steps.jsonl'), NODE_OPTIONS: '' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const row = JSON.parse(readFileSync(join(root, 'steps.jsonl'), 'utf8').trim());
    assert.equal(row.sample, 'a b:50%');
    assert.deepEqual(row.args, ['x y']);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('framebuffer gauntlet uses the selected pnpm entry and stops at the failed child', async () => {
  const root = fixture();
  const directory = 'apps/learn-render/4.advanced-opengl/5.framebuffers';
  try {
    mkdirSync(join(root, directory, 'scripts'), { recursive: true });
    copyFileSync(
      resolve(directory, 'scripts/smoke-gauntlet.mjs'),
      join(root, directory, 'scripts/smoke-gauntlet.mjs'),
    );
    writeFileSync(
      join(root, directory, 'package.json'),
      JSON.stringify({
        name: '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers',
        private: true,
        scripts: Object.fromEntries(
          ['smoke', 'smoke:browser', 'smoke:browser-live'].map((name) => [
            name,
            `node ../../../../fixture-step.mjs ${name}`,
          ]),
        ),
      }),
    );
    for (const failed of ['', 'smoke:browser']) {
      const log = join(root, failed ? 'failure.jsonl' : 'success.jsonl');
      const result = spawnSync(
        process.execPath,
        [join(root, directory, 'scripts/smoke-gauntlet.mjs')],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, FIXTURE_LOG: log, FIXTURE_FAIL: failed, NODE_OPTIONS: '' },
        },
      );
      assert.equal(result.status, failed ? 1 : 0, `${result.stdout}\n${result.stderr}`);
      if (failed) assert.match(result.stderr, /retained fixture failure/);
      const steps = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).step);
      assert.deepEqual(
        steps,
        failed ? ['smoke', 'smoke:browser'] : ['smoke', 'smoke:browser', 'smoke:browser-live'],
      );
    }
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const suite of ['browser', 'dawn'])
  test(`real pnpm ${suite} entry forwards complete ordered commands without shell assignments`, async () => {
    const root = fixture();
    try {
      const result = spawnSync(command[0], [...command.slice(1), `test:${suite}`], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          FIXTURE_LOG: join(root, 'steps.jsonl'),
          FORGEAX_PACKAGE_BUILD_CONCURRENCY: '1',
          NODE_OPTIONS: '',
        },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const steps = readFileSync(join(root, 'steps.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.deepEqual(
        steps.map((row) => row.step),
        suite === 'browser' ? ['run', 'browser', 'devkit', 'mesh-io'] : ['build', 'shared', 'dawn'],
      );
      if (suite === 'browser') {
        assert.equal(steps[0].visibility, '1');
        assert.equal(steps[1].visibility, '0');
        assert.ok(
          steps[0].args.includes(
            'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts',
          ),
        );
      } else {
        assert.equal(steps[0].concurrency, '1');
        assert.deepEqual(steps[1].args, ['--root', '.']);
        assert.equal(steps[2].manifest, 'shared-build-inputs/manifest.json');
        assert.equal(steps[2].options, '--max-old-space-size=4096');
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

for (const [configured, expected] of [
  [undefined, '2'],
  ['1', '1'],
  ['3', '3'],
])
  test(`Dawn preparation preserves package concurrency ${configured ?? 'default'}`, async () => {
    const root = fixture();
    try {
      const env = { ...process.env, FIXTURE_LOG: join(root, 'steps.jsonl'), NODE_OPTIONS: '' };
      delete env.FORGEAX_PACKAGE_BUILD_CONCURRENCY;
      if (configured !== undefined) env.FORGEAX_PACKAGE_BUILD_CONCURRENCY = configured;
      const result = spawnSync(command[0], [...command.slice(1), 'test:dawn'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
        env,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const first = JSON.parse(readFileSync(join(root, 'steps.jsonl'), 'utf8').split('\n')[0]);
      assert.equal(first.concurrency, expected);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

test('a failed owner retains its exit and prevents subsequent suite commands', async () => {
  const root = fixture();
  try {
    const result = spawnSync(command[0], [...command.slice(1), 'test:browser'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        FIXTURE_LOG: join(root, 'steps.jsonl'),
        FIXTURE_FAIL: 'run',
        NODE_OPTIONS: '',
      },
    });
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /retained fixture failure/);
    const steps = readFileSync(join(root, 'steps.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      steps.map((row) => row.step),
      ['run'],
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
