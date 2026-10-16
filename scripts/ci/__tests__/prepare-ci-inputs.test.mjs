import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { resolveAsset } from '../../../packages/wgpu-wasm/scripts/content-key.mjs';
import { appPackages } from '../../build-task-cache.mjs';
import { main, prepareInputs, sourceAppBuilds } from '../prepare-ci-inputs.mjs';

for (const coreState of ['absent', 'timeout', 'wrong-shared-fingerprint']) {
  for (const mode of ['auto', 'split']) {
    test(`core input loss preserves an independently admitted shared producer: ${coreState}, ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-input-recovery-'));
      const oldSha = process.env.EXPECTED_PRODUCT_SHA;
      process.env.EXPECTED_PRODUCT_SHA = 'a'.repeat(40);
      const put = (directory, file, content) => {
        mkdirSync(join(directory, file, '..'), { recursive: true });
        writeFileSync(join(directory, file), content);
      };
      const contract = join(root, 'scripts/ci/build-artifact-contract.json');
      put(
        root,
        'scripts/ci/build-artifact-contract.json',
        JSON.stringify({
          artifactClasses: {
            'engine-dist': {
              fileClasses: ['packages/fixture/dist'],
              transferArtifact: 'core-build',
            },
            'shared-engine-shaders': {
              fileClasses: ['shared-app-inputs/shaders/manifest.json'],
              transferArtifact: 'shared-app-inputs',
            },
          },
          consumers: {
            fixture: { requiredArtifactClasses: ['engine-dist', 'shared-engine-shaders'] },
          },
        }),
      );
      let rebuilt = 0;
      let compiled = 0;
      let sharedDownloads = 0;
      const validShared = coreState !== 'wrong-shared-fingerprint';
      try {
        const args = [
          '--consumer',
          'fixture',
          '--artifact-ids',
          coreState === 'absent' ? '' : '1',
          '--shared-artifact-id',
          '2',
          '--input-fingerprint',
          'current',
        ];
        const dependencies = {
          root,
          runCommand: async ([, script, ...args]) => {
            if (script.endsWith('download-artifact-with-retry.mjs')) {
              if (args[args.indexOf('--artifact-ids') + 1] === '1')
                return { status: 124, failure: 'core transfer timed out' };
              sharedDownloads++;
            } else if (script.endsWith('unpack-shared-app-inputs.mjs')) {
              const stage = args[args.indexOf('--root') + 1];
              put(
                stage,
                'shared-app-inputs/manifest.json',
                JSON.stringify({
                  inputFingerprint: validShared ? 'current' : 'other source',
                }),
              );
              put(stage, 'shared-app-inputs/shaders/manifest.json', 'verified shared shaders');
            } else if (script.endsWith('verify-build-artifact-input.mjs')) {
              const result = spawnSync(
                process.execPath,
                [resolve(script), ...args, '--contract', contract],
                { encoding: 'utf8' },
              );
              return { status: result.status, failure: result.stdout + result.stderr };
            } else if (script === 'scripts/build.mjs') {
              rebuilt++;
              put(root, 'packages/fixture/dist/index.mjs', 'rebuilt package');
            } else if (script.endsWith('build-shared-app-inputs.mjs')) {
              compiled++;
              put(
                root,
                'shared-app-inputs/manifest.json',
                JSON.stringify({ inputFingerprint: 'current' }),
              );
              put(root, 'shared-app-inputs/shaders/manifest.json', 'rebuilt shared shaders');
            }
            return { status: 0 };
          },
        };
        if (mode === 'split') {
          const restored = await main([...args, '--mode', 'restore'], dependencies);
          assert.equal(restored.source, 'pending');
          assert.equal(rebuilt, 0, 'restoration must not start a source build');
          assert.equal(compiled, 0, 'restoration must not compile shaders');
        }
        const receipt = await main(
          [...args, '--mode', mode === 'split' ? 'build' : 'auto'],
          dependencies,
        );
        assert.equal(receipt.source, 'build');
        assert.equal(sharedDownloads, 1, 'the source phase must not retry artifact transfers');
        assert.equal(rebuilt, 1);
        assert.equal(compiled, validShared ? 0 : 1);
        assert.equal(
          readFileSync(join(root, 'shared-app-inputs/shaders/manifest.json'), 'utf8'),
          validShared ? 'verified shared shaders' : 'rebuilt shared shaders',
        );
      } finally {
        if (oldSha === undefined) delete process.env.EXPECTED_PRODUCT_SHA;
        else process.env.EXPECTED_PRODUCT_SHA = oldSha;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const coreState of ['complete', 'missing', 'interrupted', 'cancelled']) {
  const coreComplete = coreState === 'complete';
  test(`shared transfer timeout retains only complete verified core inputs: ${coreState}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-core-shared-timeout-'));
    const oldSha = process.env.EXPECTED_PRODUCT_SHA;
    process.env.EXPECTED_PRODUCT_SHA = 'a'.repeat(40);
    const contract = {
      artifactClasses: {
        'engine-dist': { fileClasses: ['packages/fixture/dist'], transferArtifact: 'core-build' },
        'wasm-fbx': { fileClasses: ['packages/fbx/pkg'], transferArtifact: 'core-build' },
        'shared-engine-shaders': {
          fileClasses: ['shared-app-inputs/shaders/manifest.json'],
          transferArtifact: 'shared-app-inputs',
        },
      },
      consumers: {
        'app-shard': {
          requiredArtifactClasses: ['engine-dist', 'wasm-fbx', 'shared-engine-shaders'],
        },
      },
    };
    mkdirSync(join(root, 'scripts/ci'), { recursive: true });
    writeFileSync(join(root, 'scripts/ci/build-artifact-contract.json'), JSON.stringify(contract));
    const recovered = [];
    const transfers = [];
    const put = (directory, file, content = 'current source bytes') => {
      mkdirSync(join(directory, file, '..'), { recursive: true });
      writeFileSync(join(directory, file), content);
    };
    try {
      const preparation = main(
        [
          '--consumer',
          'app-shard',
          '--artifact-ids',
          '1',
          '--shared-artifact-id',
          '2',
          '--input-fingerprint',
          'fixture',
        ],
        {
          root,
          runCommand: async (command) => {
            const [, script, ...args] = command;
            if (script.endsWith('download-artifact-with-retry.mjs')) {
              const id = args[args.indexOf('--artifact-ids') + 1];
              transfers.push(`start-${id}`);
              if (id === '2') return { status: 124, failure: 'shared transfer timeout' };
              await new Promise((done) => setImmediate(done));
              transfers.push(`finish-${id}`);
              const stage = args[args.indexOf('--path') + 1];
              put(stage, 'packages/fixture/dist/index.mjs');
              if (coreState !== 'missing') put(stage, 'packages/fbx/pkg/fbx-wasm.mjs');
              if (coreState === 'cancelled')
                return { status: 130, cancelled: 'SIGTERM', failure: 'core transfer cancelled' };
              if (coreState === 'interrupted')
                return { status: 124, failure: 'core extraction interrupted' };
            } else if (script.endsWith('verify-build-artifact-input.mjs')) {
              const result = spawnSync(
                process.execPath,
                [
                  resolve(script),
                  ...args,
                  '--contract',
                  join(root, 'scripts/ci/build-artifact-contract.json'),
                ],
                { encoding: 'utf8' },
              );
              return { status: result.status, failure: result.stdout + result.stderr };
            } else if (script === 'scripts/build.mjs') {
              recovered.push(existsSync(join(root, 'packages/fbx/pkg/fbx-wasm.mjs')));
              assert.equal(
                recovered.at(-1),
                coreComplete,
                'native source input was discarded or incomplete core was published',
              );
              put(root, 'packages/fixture/dist/index.mjs', 'rebuilt');
              put(root, 'packages/fbx/pkg/fbx-wasm.mjs', 'rebuilt native');
            } else if (script.endsWith('build-shared-app-inputs.mjs')) {
              put(root, 'shared-app-inputs/shaders/manifest.json', '{}');
              put(
                root,
                'shared-app-inputs/manifest.json',
                JSON.stringify({ inputFingerprint: 'fixture' }),
              );
            }
            return { status: 0 };
          },
        },
      );
      if (coreState === 'cancelled') {
        await assert.rejects(preparation, (error) => Boolean(error.cancelled));
        assert.deepEqual(recovered, [], 'cancellation must win over the earlier shared timeout');
      } else {
        await preparation;
        assert.deepEqual(recovered, [coreComplete]);
      }
      assert.ok(
        transfers.indexOf('start-2') < transfers.indexOf('finish-1'),
        'shared transfer must not lose its budget while waiting for the core transfer',
      );
    } finally {
      if (oldSha === undefined) delete process.env.EXPECTED_PRODUCT_SHA;
      else process.env.EXPECTED_PRODUCT_SHA = oldSha;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('Bun input fallback runs pnpm commands without replacing the installed dependency tree', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  portability-bun:'));
  const jobEnvironment = job.slice(
    job.indexOf('\n    env:'),
    job.indexOf('\n    timeout-minutes:'),
  );
  const policy = jobEnvironment.match(/^ {6}pnpm_config_verify_deps_before_run: '([^']+)'$/m)?.[1];
  const root = mkdtempSync(join(tmpdir(), 'forgeax-bun-inputs-'));
  try {
    const packageManager = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).packageManager;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'bun-input-fallback',
        private: true,
        packageManager,
        dependencies: { 'fixture-dep': 'file:./dep' },
        scripts: {
          build: 'node -e "require(\'fixture-dep\')"',
          postinstall: "node -e \"require('node:fs').writeFileSync('unexpected-install', '1')\"",
        },
      }),
    );
    mkdirSync(join(root, 'dep'));
    writeFileSync(
      join(root, 'dep/package.json'),
      JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.cjs' }),
    );
    writeFileSync(join(root, 'dep/index.cjs'), 'module.exports = 1;');
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(root, 'dep'), join(root, 'node_modules/fixture-dep'), 'dir');
    const env = { ...process.env, CI: 'true' };
    delete env.pnpm_config_verify_deps_before_run;
    if (policy !== undefined) env.pnpm_config_verify_deps_before_run = policy;
    const command = process.platform === 'darwin' ? '/bin/sh' : 'pnpm';
    const commandArgs =
      process.platform === 'darwin' ? ['-c', 'exec pnpm run build'] : ['run', 'build'];
    const result = spawnSync(command, commandArgs, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    assert.equal(
      existsSync(join(root, 'unexpected-install')),
      false,
      'pnpm reinstalled Bun dependencies',
    );
    assert.equal(
      realpathSync(join(root, 'node_modules/fixture-dep')),
      realpathSync(join(root, 'dep')),
      'pnpm replaced the Bun-owned dependency link',
    );
    const version = spawnSync(
      command,
      process.platform === 'darwin' ? ['-c', 'exec pnpm --version'] : ['--version'],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(version.status, 0, version.error?.message ?? version.stderr);
    assert.equal(version.stdout.trim(), packageManager.split('@').at(-1).split('+')[0]);
    // A matching installed manager does not create a lock; a cold manager may
    // record only its own bootstrap, never the Bun-owned fixture dependency.
    const lockPath = join(root, 'pnpm-lock.yaml');
    if (existsSync(lockPath)) {
      const lockfile = readFileSync(lockPath, 'utf8');
      assert.match(lockfile, /packageManagerDependencies:[\s\S]*pnpm:[\s\S]*12\.10\.1/);
      assert.doesNotMatch(lockfile, /fixture-dep/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reason of [
  'HTTP 404 artifact expired',
  'product SHA mismatch',
  'digest mismatch',
  'artifact acceleration budget exhausted',
]) {
  test(`${reason}: discard acceleration and verify the source rebuild`, async () => {
    const calls = [];
    const result = await prepareInputs({
      restore: async () => {
        throw new Error(reason);
      },
      publish: async () => calls.push('publish'),
      rebuild: async () => calls.push('build'),
      verify: async (source) => calls.push(`verify:${source}`),
    });
    assert.deepEqual(calls, ['build', 'verify:build']);
    assert.equal(result.source, 'build');
  });
}

test('restoration defers source work after preserving verified partial inputs', async () => {
  const calls = [];
  const result = await prepareInputs({
    restoreOnly: true,
    restore: async () => false,
    recover: async () => calls.push('preserve'),
    verify: async () => assert.fail('missing inputs cannot be accepted'),
    publish: async () => assert.fail('missing inputs cannot be published'),
    rebuild: async () => assert.fail('native preparation must precede the deferred build'),
  });
  assert.deepEqual(calls, ['preserve']);
  assert.equal(result.source, 'pending');
});

test('verified acceleration is published once without a rebuild', async () => {
  const calls = [];
  const result = await prepareInputs({
    restoreOnly: true,
    restore: async () => true,
    verify: async (source) => calls.push(source),
    publish: async () => calls.push('publish'),
    rebuild: async () => assert.fail('unexpected rebuild'),
  });
  assert.deepEqual(calls, ['restore', 'publish']);
  assert.equal(result.source, 'artifact');
});

test('incomplete restored inputs never publish and a broken source build stays red', async () => {
  const calls = [];
  await assert.rejects(
    prepareInputs({
      restore: async () => true,
      verify: async () => {
        throw new Error('missing required input');
      },
      publish: async () => calls.push('publish'),
      rebuild: async () => {
        calls.push('build');
        throw new Error('source compile failed');
      },
    }),
    /source compile failed/,
  );
  assert.deepEqual(calls, ['build']);
});

test('cancellation never starts a fallback build', async () => {
  await assert.rejects(
    prepareInputs({
      restore: async () => {
        throw Object.assign(new Error('cancelled'), { cancelled: true });
      },
      verify: async () => assert.fail(),
      publish: async () => assert.fail(),
      rebuild: async () => assert.fail(),
    }),
    /cancelled/,
  );
});

test('source fallback selects only declared roots and rejects empty or unknown scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-ci-source-apps-'));
  try {
    for (const app of ['apps/hello/triangle', 'apps/hello-collision/example', 'apps/bevy/sprite']) {
      mkdirSync(join(root, app), { recursive: true });
      writeFileSync(join(root, app, 'package.json'), '{"scripts":{"build":"fixture"}}');
    }
    assert.deepEqual(sourceAppBuilds(root, { sourceAppRoots: ['apps/hello'] }).apps, [
      'apps/hello/triangle',
    ]);
    assert.deepEqual(sourceAppBuilds(root, { sourceAppRoots: ['apps/hello/triangle'] }).apps, [
      'apps/hello/triangle',
    ]);
    for (const sourceAppRoots of [
      undefined,
      [],
      ['apps/missing'],
      ['apps/../hello'],
      ['hello'],
      ['apps/hello/'],
    ]) {
      assert.throws(
        () => sourceAppBuilds(root, { sourceAppRoots }),
        /sourceAppRoots|no buildable apps/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real artifact consumers retain the complete hello/learn-render fleet', () => {
  const contract = JSON.parse(readFileSync('scripts/ci/build-artifact-contract.json'));
  for (const consumer of Object.values(contract.consumers)) {
    if (consumer.requiredArtifactClasses.some((name) => name.startsWith('app-dist-'))) {
      assert.ok(sourceAppBuilds(process.cwd(), consumer).apps.length > 0);
    }
  }
  const fleet = sourceAppBuilds(process.cwd(), contract.consumers['smoke-fleet']);
  const all = appPackages(process.cwd()).map((app) => app.relativeDirectory);
  assert.deepEqual(
    fleet.apps,
    all.filter((app) =>
      fleet.roots.some((prefix) => app === prefix || app.startsWith(`${prefix}/`)),
    ),
  );
  assert.ok(fleet.apps.length < all.length);
});

test('source app recovery covers every Smoke gate without building unrelated fleets', () => {
  const contract = JSON.parse(readFileSync('scripts/ci/build-artifact-contract.json', 'utf8'));
  const apps = new Set(sourceAppBuilds(process.cwd(), contract.consumers['smoke-fleet']).apps);
  const roster = JSON.parse(readFileSync('scripts/ci/dawn-smoke-roster.json', 'utf8'));
  for (const entry of roster.entries) {
    if (entry.gates.some((gate) => gate.executionClass !== 'excluded')) {
      assert.ok(apps.has(entry.path.replace(/\/package\.json$/, '')), entry.path);
    }
  }
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const smoke = workflow.slice(
    workflow.indexOf('\n  smoke-fleet:'),
    workflow.indexOf('\n  smoke-fleet-required-context:'),
  );
  const manifests = new Map(
    globSync(['apps/**/package.json', 'packages/*/package.json'], {
      exclude: ['**/node_modules/**', '**/dist/**'],
    }).map((path) => {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      return [manifest.name, { manifest, app: path.replace(/\/package\.json$/, '') }];
    }),
  );
  for (const match of smoke.matchAll(
    /pnpm --filter ['"]?(@forgeax\/[^\s'"\n]+)['"]? (?:build|smoke(?:[\w:-]*))/g,
  )) {
    const entry = manifests.get(match[1]);
    assert.ok(entry, `unknown explicit Smoke package: ${match[1]}`);
    if (entry.app.startsWith('apps/') && entry.manifest.scripts?.build)
      assert.ok(apps.has(entry.app), `missing explicit Smoke input: ${match[1]}`);
  }
  assert.equal(
    [...apps].some((app) => app.startsWith('apps/bevy/')),
    false,
  );
  assert.deepEqual(
    [...apps].filter((app) => app.startsWith('apps/perf/')),
    ['apps/perf/10k-cubes-lights', 'apps/perf/shadow-stress'],
  );
  assert.throws(() => sourceAppBuilds(process.cwd(), {}), /requires valid/);
  assert.throws(
    () => sourceAppBuilds(process.cwd(), { sourceAppRoots: ['apps/not-a-real-input'] }),
    /no buildable apps/,
  );
});

for (const mutation of ['none', 'wasm', 'glue', 'source']) {
  test(`shared compiler adoption verifies exact bytes before publishing: ${mutation}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-compiler-'));
    const oldSha = process.env.EXPECTED_PRODUCT_SHA;
    process.env.EXPECTED_PRODUCT_SHA = 'a'.repeat(40);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const source = await resolveAsset();
    const compiler = join(root, 'producer');
    const destination = join(root, 'packages/wgpu-wasm/pkg');
    const put = (path, bytes) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
    };
    const wasm = 'producer-specific wasm bytes';
    const glue = 'producer-specific glue bytes';
    const provenance = {
      schemaVersion: 'wgpu-wasm-provenance/1',
      sourceContentKey: `sha256-${source.sha256}`,
      artifactSha256: hash(wasm),
      artifactBytes: Buffer.byteLength(wasm),
      glueSha256: hash(glue),
      glueBytes: Buffer.byteLength(glue),
      toolchain: {},
      dependencies: {},
    };
    provenance.compilerFingerprint = `sha256-${hash(
      JSON.stringify({
        schemaVersion: provenance.schemaVersion,
        sourceContentKey: provenance.sourceContentKey,
        artifactSha256: provenance.artifactSha256,
        glueSha256: provenance.glueSha256,
        toolchain: provenance.toolchain,
        dependencies: provenance.dependencies,
      }),
    )}`;
    const contract = {
      artifactClasses: {
        'engine-dist': {
          fileClasses: ['packages/fixture/dist', 'packages/dsh/lib/client.js'],
          transferArtifact: 'core-build',
        },
        'shared-engine-shaders': {
          fileClasses: ['shared-app-inputs/shaders/manifest.json'],
          transferArtifact: 'shared-app-inputs',
        },
      },
      consumers: { fixture: { requiredArtifactClasses: ['engine-dist', 'shared-engine-shaders'] } },
    };
    try {
      put(join(root, 'scripts/ci/build-artifact-contract.json'), JSON.stringify(contract));
      put(join(destination, 'wgpu_wasm_bg.wasm'), 'existing core wasm');
      put(join(root, 'packages/dsh/src/client.tsx'), 'authored source');
      put(join(compiler, 'wgpu_wasm_bg.wasm'), mutation === 'wasm' ? 'tampered' : wasm);
      put(join(compiler, 'wgpu_wasm.js'), mutation === 'glue' ? 'tampered' : glue);
      if (mutation === 'source') provenance.sourceContentKey = 'stale source';
      put(join(compiler, 'provenance.json'), JSON.stringify(provenance));
      let stage;
      let recovered = false;
      const preparation = main(
        [
          '--consumer',
          'fixture',
          '--artifact-ids',
          '1',
          '--shared-artifact-id',
          '2',
          '--input-fingerprint',
          'fixture',
        ],
        {
          root,
          runCommand: async ([, script, ...args]) => {
            if (script.endsWith('download-artifact-with-retry.mjs')) {
              const path = args[args.indexOf('--path') + 1];
              if (args[args.indexOf('--artifact-ids') + 1] === '1') {
                stage = path;
                put(join(stage, 'packages/fixture/dist/index.mjs'), 'current build');
                put(join(stage, 'packages/dsh/lib/client.js'), 'generated browser export');
                put(join(stage, 'packages/dsh/src/client.tsx'), 'untrusted staged source');
              }
            } else if (script.endsWith('unpack-shared-app-inputs.mjs')) {
              put(
                join(stage, 'shared-app-inputs/manifest.json'),
                JSON.stringify({ inputFingerprint: 'fixture' }),
              );
              cpSync(compiler, join(stage, 'shared-app-inputs/compiler'), { recursive: true });
            } else if (script === 'scripts/build.mjs') {
              recovered = true;
              throw new Error('source recovery requested');
            }
            return { status: 0 };
          },
        },
      );
      if (mutation === 'none') {
        assert.equal((await preparation).source, 'artifact');
        assert.equal(readFileSync(join(destination, 'wgpu_wasm_bg.wasm'), 'utf8'), wasm);
        assert.equal(readFileSync(join(destination, 'wgpu_wasm.js'), 'utf8'), glue);
        assert.equal(recovered, false);
        assert.equal(
          readFileSync(join(root, 'packages/dsh/lib/client.js'), 'utf8'),
          'generated browser export',
        );
        assert.equal(
          readFileSync(join(root, 'packages/dsh/src/client.tsx'), 'utf8'),
          'authored source',
        );
      } else {
        await assert.rejects(preparation, /source recovery requested/);
        assert.equal(recovered, true);
        assert.equal(
          readFileSync(join(destination, 'wgpu_wasm_bg.wasm'), 'utf8'),
          'existing core wasm',
        );
      }
    } finally {
      if (oldSha === undefined) delete process.env.EXPECTED_PRODUCT_SHA;
      else process.env.EXPECTED_PRODUCT_SHA = oldSha;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
