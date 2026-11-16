import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { admitSdkShaderInputs } from '../../forgeax/sdk-shader-inputs.mjs';
import {
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../../lib/shared-build-cache.mjs';
import { coreBaseShaderDirectory } from '../restore-core-shader-inputs.mjs';
import { sdkShaderArtifacts } from '../sdk-shader-artifacts.mjs';

test('SDK seed waits for same-head core and point publications outside its original execution budget', () => {
  const w = parse(readFileSync('.github/workflows/sdk-pr-preflight.yml', 'utf8'));
  const p = w.jobs['shader-producer-inputs'],
    s = w.jobs['build-sdk'];
  assert.ok(p, 'the SDK must admit existing producers before its seed starts');
  assert.equal(s.needs, 'shader-producer-inputs');
  assert.equal(s['timeout-minutes'], 30);
  assert.equal(p['timeout-minutes'], 70);
  assert.equal(w.jobs.consumers['timeout-minutes'], "${{ matrix.group == 'source' && 35 || 30 }}");
  assert.deepEqual(w.jobs.consumers.strategy.matrix.group, ['project', 'source']);
  assert.equal(w.jobs.consumers.strategy.matrix.include.length, 2);
  const restore = s.steps.find((x) => x.name === 'Restore admitted SDK shader inputs');
  assert.ok(restore);
  assert.ok(
    s.steps.indexOf(restore) <
      s.steps.findIndex((x) => x.name === 'Build exact PR SDK and npm tarballs once'),
  );
  assert.match(restore.run, /core_artifact_id/);
  assert.match(restore.run, /point_artifact_id/);
});

function producerFixture() {
  const repository = 'ForgeAX/forgeax-engine',
    sha = 'a'.repeat(40);
  const pr = { number: 5146, head: { sha, ref: 'repair', repo: { full_name: repository } } };
  const run = {
    id: 11,
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    head_sha: sha,
    head_branch: 'repair',
    head_repository: { full_name: repository },
    pull_requests: [{ number: 5146 }],
    run_attempt: 1,
    status: 'in_progress',
  };
  const jobs = ['ci-core', 'shared-app-inputs'].map((name, i) => ({
    id: 22 + i,
    run_id: 11,
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  const artifacts = ['core-build-a1', 'shared-app-inputs-a1'].map((name, i) => ({
    id: 33 + i,
    name,
    expired: false,
    digest: `sha256:${'b'.repeat(64)}`,
    workflow_run: { id: 11, head_sha: sha },
  }));
  const api = async (endpoint) => {
    if (endpoint.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [run] };
    if (endpoint.includes('/jobs?')) return { total_count: jobs.length, jobs };
    if (endpoint.includes('/artifacts?')) return { total_count: artifacts.length, artifacts };
    if (endpoint.endsWith('/actions/runs/11')) return run;
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  return {
    input: { repository, sha, eventName: 'pull_request', branch: 'repair', pr },
    run,
    jobs,
    artifacts,
    api,
  };
}

test('SDK selects successful base and point from one Main run before other jobs terminate', async () => {
  const f = producerFixture(),
    result = await sdkShaderArtifacts(f.input, f.api);
  assert.equal(result.core.sourceRunId, 11);
  assert.equal(result.point.sourceRunId, 11);
  assert.equal(result.core.artifactId, 33);
  assert.equal(result.point.artifactId, 34);
  assert.equal(result.point.sourceJobId, 23);
});

test('SDK waits for the existing point producer, preserving the shared total waiting bound', async () => {
  const f = producerFixture();
  f.jobs[1].status = 'in_progress';
  let time = 0;
  const result = await sdkShaderArtifacts(f.input, f.api, {
    now: () => time,
    waitMs: 2000,
    wait: async () => {
      time += 1000;
      f.jobs[1].status = 'completed';
    },
  });
  assert.equal(result.point.artifactId, 34);
  assert.equal(time, 1000);
  f.jobs[1].status = 'in_progress';
  time = 0;
  await assert.rejects(
    sdkShaderArtifacts(f.input, f.api, {
      now: () => time,
      waitMs: 2000,
      wait: async () => {
        time += 1000;
      },
    }),
    /point artifact unavailable/,
  );
  assert.equal(time, 2000);
});

test('SDK rejects point producer failure and wrong artifact/run/source identities', async () => {
  for (const change of [
    (f) => {
      f.jobs[1].conclusion = 'failure';
    },
    (f) => {
      f.jobs[1].run_id = 99;
    },
    (f) => {
      f.artifacts[1].name = 'core-build-a1';
    },
    (f) => {
      f.artifacts[1].expired = true;
    },
    (f) => {
      f.artifacts[1].workflow_run.head_sha = 'c'.repeat(40);
    },
    (f) => {
      f.artifacts[1].workflow_run.id = 99;
    },
    (f) => {
      f.artifacts[1].digest = '';
    },
    (f) => {
      f.jobs.push({ ...f.jobs[1] });
    },
    (f) => {
      f.artifacts.push({ ...f.artifacts[1] });
    },
  ]) {
    const f = producerFixture();
    change(f);
    await assert.rejects(sdkShaderArtifacts(f.input, f.api, { waitMs: 0 }));
  }
});

function payloadFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-shader-admission-'));
  const root = join(directory, 'consumer'),
    staging = join(directory, 'download');
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  write(join(root, 'package.json'), '{"type":"module"}');
  write(join(root, 'pnpm-lock.yaml'), 'fixture');
  for (const [owner, manifest] of Object.entries({
    compiler: { name: '@fixture/compiler' },
    'vfx-render': { name: '@forgeax/engine-vfx-render' },
    'vite-plugin-shader': {
      name: '@forgeax/engine-vite-plugin-shader',
      dependencies: { '@fixture/compiler': 'workspace:*' },
    },
  }))
    write(join(root, 'packages', owner, 'package.json'), JSON.stringify(manifest));
  write(join(root, 'packages/compiler/dist/index.js'), 'rebuilt compiler');
  write(join(root, 'packages/shader/src/surface.wgsl'), 'source');
  write(join(root, 'packages/wgpu-wasm/pkg/compiler.wasm'), 'naga');
  for (const file of [
    'scripts/build-shared-inputs.mjs',
    'scripts/lib/shader-source-budget.mjs',
    'scripts/lib/runner-resources.mjs',
    'scripts/ci/build-shared-app-inputs.mjs',
    'scripts/lib/shared-build-cache.mjs',
    'scripts/build-task-cache.mjs',
  ])
    write(join(root, file), file);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  write(
    join(staging, 'core/engine-prerequisite-build-manifest.json'),
    JSON.stringify({ engineSha: sha }),
  );
  const receipts = {};
  for (const [name, producer, path, pointShadows] of [
    ['core', 'repo-build-inputs', coreBaseShaderDirectory, false],
    ['point', 'shared-app-inputs', 'shared-app-inputs', true],
  ]) {
    const archiveRoot = join(staging, name),
      shader = join(archiveRoot, path, 'shaders/manifest.json');
    write(shader, JSON.stringify({ originalProfile: name }));
    const value = {
      producer,
      payload: { engineShaderManifest: `${path}/shaders/manifest.json` },
      shaderBuild: sharedShaderReceipt(
        archiveRoot,
        shader,
        sharedShaderInputFingerprint(root, { pointShadows, hdrpSsao: true }),
      ),
    };
    const receipt = join(archiveRoot, path, 'manifest.json');
    write(receipt, JSON.stringify(value));
    receipts[name] = { receipt, shader, value };
  }
  return { directory, root, staging, write, receipts };
}

test('post-rebuild admission copies exact profile bytes and leaves both compiler and original receipts intact', () => {
  const f = payloadFixture();
  try {
    f.write(join(f.staging, 'core/packages/compiler/dist/index.js'), 'old producer compiler');
    f.write(join(f.staging, 'point/shared-app-inputs/compiler/index.js'), 'old point compiler');
    const before = Object.fromEntries(
      Object.entries(f.receipts).map(([k, v]) => [k, readFileSync(v.receipt)]),
    );
    assert.equal(
      admitSdkShaderInputs(f.root, f.staging),
      join(f.root, 'shared-app-inputs/manifest.json'),
    );
    for (const [name, path] of [
      ['core', coreBaseShaderDirectory],
      ['point', 'shared-app-inputs'],
    ]) {
      assert.deepEqual(readFileSync(join(f.root, path, 'manifest.json')), before[name]);
      assert.deepEqual(
        readFileSync(join(f.root, path, 'shaders/manifest.json')),
        readFileSync(f.receipts[name].shader),
      );
    }
    assert.equal(
      readFileSync(join(f.root, 'packages/compiler/dist/index.js'), 'utf8'),
      'rebuilt compiler',
    );
    assert.equal(existsSync(join(f.root, 'shared-app-inputs/compiler')), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('post-rebuild admission rejects current compiler/source/lock drift, swapped profiles and modified payload bytes', () => {
  for (const change of [
    (f) => f.write(join(f.root, 'packages/compiler/dist/index.js'), 'different compiler'),
    (f) => f.write(join(f.root, 'packages/shader/src/surface.wgsl'), 'different source'),
    (f) => f.write(join(f.root, 'pnpm-lock.yaml'), 'different lock'),
    (f) => f.write(f.receipts.point.shader, 'corrupt payload'),
    (f) => f.write(f.receipts.core.shader, 'corrupt base'),
    (f) =>
      f.write(
        join(f.staging, 'core/engine-prerequisite-build-manifest.json'),
        JSON.stringify({ engineSha: 'c'.repeat(40) }),
      ),
    (f) => {
      f.receipts.point.value.shaderBuild.inputFingerprint = sharedShaderInputFingerprint(f.root, {
        pointShadows: false,
        hdrpSsao: true,
      });
      f.write(f.receipts.point.receipt, JSON.stringify(f.receipts.point.value));
    },
    (f) => {
      f.receipts.point.value.payload.engineShaderManifest = 'other/shaders/manifest.json';
      f.write(f.receipts.point.receipt, JSON.stringify(f.receipts.point.value));
    },
  ]) {
    const f = payloadFixture();
    try {
      change(f);
      assert.throws(() => admitSdkShaderInputs(f.root, f.staging));
      assert.equal(existsSync(join(f.root, 'shared-app-inputs')), false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
});

test('SDK retains base receipt across clean and Engine validates both profiles after rebuilding compiler', () => {
  const sdk = readFileSync('scripts/forgeax/build-sdk.mjs', 'utf8'),
    build = readFileSync('scripts/build.mjs', 'utf8');
  const download = readFileSync('scripts/ci/download-sdk-shader-inputs.mjs', 'utf8');
  assert.match(download, /RUNNER_TEMP/);
  assert.match(download, /FORGEAX_SDK_SHADER_INPUTS/);
  assert.match(sdk, /process.env.FORGEAX_SDK_SHADER_INPUTS/);
  assert.ok(
    build.indexOf("await runStage('packages'") < build.indexOf('admitSdkShaderInputs(root)'),
  );
  assert.match(build, /admitSdkShaderInputs\(root\)/);
  assert.match(sdk, /shared-app-inputs/);
});

test('the download entry keeps original artifact paths outside the SDK clean and forwards exact source identity', () => {
  const f = payloadFixture();
  try {
    f.write(
      join(f.root, 'scripts/ci/download-artifact-with-retry.mjs'),
      `
      import fs from 'node:fs';
      import path from 'node:path';
      import cp from 'node:child_process';
      if (process.env.FORGEAX_ARTIFACT_EXPECTED_SHA !== cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim()) throw Error('wrong source');
      const id = process.argv[process.argv.indexOf('--artifact-ids') + 1];
      const dest = process.argv[process.argv.indexOf('--path') + 1];
      if (id === '33') fs.writeFileSync(path.join(dest, 'original-base'), 'base');
      else if (id === '34') fs.writeFileSync(path.join(dest, 'shared-app-inputs.tar.gz'), 'point');
      else throw Error('wrong artifact');
    `,
    );
    f.write(
      join(f.root, 'scripts/ci/unpack-shared-app-inputs.mjs'),
      `
      import fs from 'node:fs'; import path from 'node:path';
      const root = process.argv[process.argv.indexOf('--root') + 1];
      const archive = process.argv[process.argv.indexOf('--archive') + 1];
      const dest = process.argv[process.argv.indexOf('--destination') + 1];
      if (archive !== 'shared-app-inputs.tar.gz' || dest !== 'shared-app-inputs') throw Error('changed artifact path');
      if (fs.readFileSync(path.join(root, archive), 'utf8') !== 'point') throw Error('wrong archive');
      fs.mkdirSync(path.join(root, dest));
    `,
    );
    const envPath = join(f.directory, 'github-env');
    const script = new URL('../download-sdk-shader-inputs.mjs', import.meta.url);
    execFileSync(
      process.execPath,
      [fileURLToPath(script), '--core-artifact-id', '33', '--point-artifact-id', '34'],
      {
        cwd: f.root,
        env: { ...process.env, RUNNER_TEMP: f.directory, GITHUB_ENV: envPath },
      },
    );
    const staging = readFileSync(envPath, 'utf8').trim().slice('FORGEAX_SDK_SHADER_INPUTS='.length);
    assert.ok(staging.startsWith(f.directory));
    assert.equal(readFileSync(join(staging, 'core/original-base'), 'utf8'), 'base');
    assert.ok(existsSync(join(staging, 'point/shared-app-inputs')));
    assert.equal(existsSync(join(f.root, 'shared-app-inputs')), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
