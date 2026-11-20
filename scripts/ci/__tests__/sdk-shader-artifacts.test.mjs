import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  admitSdkShaderInputs,
  sdkCoreBuildRoot,
  seedSdkDeclarations,
} from '../../forgeax/sdk-shader-inputs.mjs';
import {
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../../lib/shared-build-cache.mjs';
import { coreBaseShaderDirectory } from '../restore-core-shader-inputs.mjs';
import { sdkShaderArtifacts } from '../sdk-shader-artifacts.mjs';
import { nativeBundle } from './fixtures/native-compiler.mjs';

test('SDK source export contracts run after their declared dependencies are installed', () => {
  const workflow = parse(readFileSync('.github/workflows/sdk-pr-preflight.yml', 'utf8'));
  const steps = workflow.jobs['build-sdk'].steps;
  const install = steps.findIndex((step) => step.name === 'Install dependencies');
  const contracts = steps.findIndex((step) => step.name === 'Verify source dependency export');
  assert.ok(install >= 0 && contracts > install);
  assert.match(steps[install].run, /prepare-pnpm-workspace\.mjs --install/);
  assert.match(steps[contracts].run, /repository-public-policy\.test\.mjs/);
  assert.match(steps[contracts].run, /sdk-shader-artifacts\.test\.mjs/);
});

test('SDK seed waits for the same-head Core compiler outside its original execution budget', () => {
  const w = parse(readFileSync('.github/workflows/sdk-pr-preflight.yml', 'utf8'));
  const p = w.jobs['shader-producer-inputs'],
    s = w.jobs['build-sdk'];
  assert.ok(p, 'the SDK must admit existing producers before its seed starts');
  assert.equal(s.needs, 'shader-producer-inputs');
  assert.equal(s['timeout-minutes'], 30);
  assert.equal(p['timeout-minutes'], 70);
  assert.equal(w.jobs.consumers['timeout-minutes'], `\${{ matrix.group == 'source' && 40 || 30 }}`);
  assert.equal(
    w.jobs.consumers.strategy.matrix,
    `\${{ fromJSON(needs.shader-producer-inputs.outputs.consumer_matrix) }}`,
  );
  assert.equal(p.outputs.consumer_matrix, `\${{ steps.profile.outputs.matrix }}`);
  assert.equal(p.outputs.consumer_count, `\${{ steps.profile.outputs.consumer_count }}`);
  assert.match(
    w.jobs.aggregate.steps.find((step) => step.name === 'Download required consumer results').run,
    /--expected-count .*needs\.shader-producer-inputs\.outputs\.consumer_count/,
  );
  const restore = s.steps.find((x) => x.name === 'Restore the admitted Core compiler');
  assert.ok(restore);
  assert.equal(
    s.steps.some((step) => step.id === 'wgpu-release'),
    false,
  );
  assert.ok(
    s.steps.indexOf(restore) <
      s.steps.findIndex((step) => step.name === 'Verify wgpu-wasm artifact and provenance'),
  );
  assert.ok(
    s.steps.indexOf(restore) <
      s.steps.findIndex((x) => x.name === 'Build exact PR SDK and npm tarballs once'),
  );
  assert.match(restore.run, /core_artifact_id/);
  assert.match(restore.run, /--compiler-only/);
});

test('Candidate production keeps its original execution budgets with no compiled shader input prerequisite', () => {
  const workflow = parse(readFileSync('.github/workflows/sdk-release-candidate.yml', 'utf8'));
  for (const owner of ['build-sdk', 'reproducibility', 'collision']) {
    const steps = workflow.jobs[owner].steps;
    assert.ok(steps.some((step) => /pnpm (?:sdk:build|build:engine)/.test(step.run ?? '')));
    assert.ok(
      !steps.some((step) => /download-sdk-shader-inputs|--compiled-shaders/.test(step.run ?? '')),
    );
    assert.equal(workflow.jobs[owner]['timeout-minutes'], owner === 'build-sdk' ? 120 : 90);
  }
});

test('Candidate Preview and collision share a source template manifest', {
  skip: process.platform === 'win32',
}, () => {
  const workflow = parse(readFileSync('.github/workflows/sdk-release-candidate.yml', 'utf8'));
  const steps = workflow.jobs.collision.steps;
  const build = steps.find(
    (step) => step.name === 'Build Engine and Preview for full game-3d collision acceptance',
  );
  const journey = steps.find((step) => step.name === 'Run full game-3d collision journey');
  assert.equal(
    journey.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
    `\${{ env.FORGEAX_CANDIDATE_SHADER_MANIFEST }}`,
  );
  for (const restored of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'candidate shader manifest '));
    try {
      const binary = join(root, 'pnpm');
      const trace = join(root, 'commands');
      const environment = join(root, 'environment');
      const workspace = join(root, 'workspace');
      writeFileSync(
        binary,
        `#!/bin/sh
printf "%s\\0" "$@" >> "$PNPM_TRACE"
printf "\\n" >> "$PNPM_TRACE"
if [ "$1" = build:shared ]; then
  mkdir -p "$GITHUB_WORKSPACE/shared-build-inputs"
  printf '{"shaderPublication":"source"}\\n' > "$GITHUB_WORKSPACE/shared-build-inputs/manifest.json"
fi
`,
      );
      chmodSync(binary, 0o755);
      execFileSync('bash', ['-euo', 'pipefail', '-c', build.run], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          PNPM_TRACE: trace,
          GITHUB_ENV: environment,
          GITHUB_WORKSPACE: workspace,
          FORGEAX_SDK_SHADER_INPUTS: restored ? join(root, 'admitted') : '',
        },
      });
      const manifest = join(workspace, 'shared-build-inputs', 'manifest.json');
      const commands = readFileSync(trace, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => line.split('\0').slice(0, -1));
      assert.deepEqual(commands, [
        ['build:engine'],
        ['build:shared'],
        ['build:app', 'preview', '--shared-input-manifest', manifest],
      ]);
      assert.equal(
        readFileSync(environment, 'utf8'),
        `FORGEAX_CANDIDATE_SHADER_MANIFEST=${manifest}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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

test('one source publication and catalog share a capacity-qualified heavy execution owner', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const core = workflow.jobs['core-build'];
  const projection = workflow.jobs['shared-app-inputs'];
  assert.match(core['runs-on'], /heavy/);
  assert.match(projection['runs-on'], /standard/);
  assert.equal(projection.needs, 'core-build');
  assert.ok(
    core.steps.some((step) => step.run?.includes('verify-runner-pool-capacity.mjs --pool heavy')),
  );
  assert.ok(core.steps.some((step) => step.id === 'build-shared-inputs'));
  assert.ok(
    !core.steps.some((step) =>
      /--no-point-shadows|prepare-shader-release-inputs/.test(step.run ?? ''),
    ),
  );
  assert.ok(
    !projection.steps.some((step) => step.uses || /node|pnpm|checkout/.test(step.run ?? '')),
  );
  assert.equal(
    projection.outputs.shared_artifact_id,
    `\${{ needs.core-build.outputs.shared_artifact_id }}`,
  );
  assert.equal(core.steps.find((step) => step.id === 'upload-shared-inputs').with.required, 'true');
});

test('SDK attributes projected point bytes to the real combined Core execution', async () => {
  const f = producerFixture();
  f.jobs[0].steps = [{ name: 'Upload app-shard shared input projection', conclusion: 'success' }];
  f.jobs[1].steps = [{ name: 'Project shared inputs from ci-core', conclusion: 'success' }];
  const result = await sdkShaderArtifacts(f.input, f.api);
  assert.equal(result.core.sourceJobId, 22);
  assert.equal(result.point.sourceJobId, 22);
  assert.equal(result.point.artifactName, 'shared-app-inputs-a1');
});

test('SDK rejects a combined projection without successful execution and upload', async () => {
  for (const change of [
    (f) => {
      f.jobs[1].steps[0].conclusion = 'failure';
    },
    (f) => {
      f.jobs[0].steps = [];
    },
    (f) => {
      f.jobs[0].steps[0].conclusion = 'failure';
    },
    (f) => {
      f.jobs[0].conclusion = 'failure';
    },
    (f) => {
      f.artifacts[1].workflow_run.head_sha = 'c'.repeat(40);
    },
  ]) {
    const f = producerFixture();
    f.jobs[0].steps = [{ name: 'Upload app-shard shared input projection', conclusion: 'success' }];
    f.jobs[1].steps = [{ name: 'Project shared inputs from ci-core', conclusion: 'success' }];
    change(f);
    await assert.rejects(sdkShaderArtifacts(f.input, f.api, { waitMs: 0 }));
  }
});

test('combined publications preserve their original Core execution across a consumer retry', async () => {
  const f = producerFixture();
  f.run.run_attempt = 2;
  const original = {
    ...f.jobs[0],
    run_attempt: 1,
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:01:00Z',
    steps: [{ name: 'Upload app-shard shared input projection', conclusion: 'success' }],
  };
  Object.assign(f.jobs[0], original, { id: 44, run_attempt: 2 });
  f.jobs[1].steps = [{ name: 'Project shared inputs from ci-core', conclusion: 'success' }];
  const api = (endpoint) =>
    endpoint.includes('/jobs?filter=all&')
      ? { total_count: 3, jobs: [original, ...f.jobs] }
      : f.api(endpoint);
  const result = await sdkShaderArtifacts(f.input, api);
  assert.equal(result.core.sourceJobId, 22);
  assert.equal(result.point.sourceJobId, 22);
  assert.equal(result.point.artifactName, 'shared-app-inputs-a1');
});

test('SDK selects successful base and point from one Main run before other jobs terminate', async () => {
  const f = producerFixture(),
    result = await sdkShaderArtifacts(f.input, f.api);
  assert.equal(result.core.sourceRunId, 11);
  assert.equal(result.point.sourceRunId, 11);
  assert.equal(result.core.artifactId, 33);
  assert.equal(result.point.artifactId, 34);
  assert.equal(result.point.sourceJobId, 23);
});

test('SDK admits the original base and retried point without rerunning a successful producer', async () => {
  const f = producerFixture();
  f.run.run_attempt = 2;
  const original = {
    ...f.jobs[0],
    run_attempt: 1,
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:01:00Z',
  };
  Object.assign(f.jobs[0], original, { id: 44, run_attempt: 2 });
  Object.assign(f.jobs[1], { id: 45, run_attempt: 2 });
  f.artifacts[1].name = 'shared-app-inputs-a2';
  const api = (endpoint) =>
    endpoint.includes('/jobs?filter=all&')
      ? { total_count: 3, jobs: [original, ...f.jobs] }
      : f.api(endpoint);
  const result = await sdkShaderArtifacts(f.input, api);
  assert.equal(result.core.sourceJobId, 22);
  assert.equal(result.core.artifactName, 'core-build-a1');
  assert.equal(result.point.sourceJobId, 45);
  assert.equal(result.point.artifactName, 'shared-app-inputs-a2');
});

test('SDK retains the original point execution when a later retry only repairs consumers', async () => {
  const f = producerFixture();
  f.run.run_attempt = 3;
  f.artifacts[0].name = 'core-build-a3';
  f.artifacts[1].name = 'shared-app-inputs-a2';
  const original = {
    ...f.jobs[1],
    id: 45,
    run_attempt: 2,
    started_at: '2026-01-01T00:02:00Z',
    completed_at: '2026-01-01T00:03:00Z',
  };
  Object.assign(f.jobs[1], original, { id: 67, run_attempt: 3 });
  const api = (endpoint) =>
    endpoint.includes('/jobs?filter=all&')
      ? { total_count: 3, jobs: [original, ...f.jobs] }
      : f.api(endpoint);
  const result = await sdkShaderArtifacts(f.input, api);
  assert.equal(result.point.sourceJobId, 45);
  assert.equal(result.point.artifactName, 'shared-app-inputs-a2');
  assert.equal(result.point.artifactDigest, f.artifacts[1].digest);
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

test('SDK reuses one verified Core archive without a compiled shader prerequisite', () => {
  const sdk = readFileSync('scripts/forgeax/build-sdk.mjs', 'utf8');
  const build = readFileSync('scripts/build.mjs', 'utf8');
  const restore = readFileSync('scripts/ci/restore-core-shader-inputs.mjs', 'utf8');
  const preflight = parse(readFileSync('.github/workflows/sdk-pr-preflight.yml', 'utf8'));
  const step = preflight.jobs['build-sdk'].steps.find(
    (entry) => entry.name === 'Restore the admitted Core compiler',
  );
  assert.match(restore, /RUNNER_TEMP/);
  assert.match(restore, /FORGEAX_SDK_CORE_INPUT/);
  assert.match(step.run, /--compiler-only --sdk-core/);
  assert.match(build, /process.env.FORGEAX_SDK_CORE_INPUT/);
  assert.match(sdk, /'build:engine'/);
  assert.doesNotMatch(sdk, /--compiled-shaders|prepare-shader-release-inputs/);
  assert.doesNotMatch(build, /admitSdkShaderInputs|FORGEAX_SDK_SHADER_INPUTS/);
});

test('only PR SDK packaging opts into Three and declaration reuse', () => {
  const preflight = parse(readFileSync('.github/workflows/sdk-pr-preflight.yml', 'utf8'));
  const step = preflight.jobs['build-sdk'].steps.find(
    (entry) => entry.name === 'Build exact PR SDK and npm tarballs once',
  );
  const build = readFileSync('scripts/build.mjs', 'utf8');
  for (const profile of ['pr-consumer', 'pr-expanded']) {
    const invocation = execFileSync(
      'bash',
      ['-c', `pnpm() { printf '%s\\0' "$@"; }\n${step.run}`],
      {
        encoding: 'utf8',
        env: { ...process.env, SDK_ARCHIVE_PROFILE: profile, SDK_PREFLIGHT_VERSION: 'pr-version' },
      },
    )
      .split('\0')
      .slice(0, -1);
    assert.deepEqual(invocation, [
      'sdk:build',
      '--',
      '--version',
      'pr-version',
      '--reuse-core-build',
      ...(profile === 'pr-consumer' ? ['--skip-game-3d-template-cache'] : []),
    ]);
  }
  assert.doesNotMatch(
    readFileSync('.github/workflows/sdk-release-candidate.yml', 'utf8'),
    /--reuse-core-build/,
  );
  assert.match(
    build,
    /if \(sdkCore !== null\) seedSdkDeclarations\(root, sdkCore\);\s*const engineTypes/,
  );
  assert.match(build, /await runStage\('types', process\.execPath, \[/);
});

test('same-head Core only seeds missing declaration inputs without importing JS or build info', () => {
  const f = payloadFixture();
  try {
    const core = sdkCoreBuildRoot(f.root, join(f.staging, 'core'));
    const types = 'packages/types/dist';
    f.write(join(core, types, 'fresh.d.ts'), 'fresh declaration');
    f.write(join(core, types, 'built.d.ts'), 'archived generated declaration');
    f.write(join(core, types, '.tsbuildinfo'), 'cannot suppress current checks');
    f.write(join(core, types, 'fresh.d.ts.map'), 'old map');
    f.write(join(core, types, 'index.mjs'), 'archive JS');
    f.write(join(f.root, types, 'built.d.ts'), 'locally emitted declaration');
    seedSdkDeclarations(f.root, core);
    assert.equal(readFileSync(join(f.root, types, 'fresh.d.ts'), 'utf8'), 'fresh declaration');
    assert.equal(
      readFileSync(join(f.root, types, 'built.d.ts'), 'utf8'),
      'locally emitted declaration',
    );
    for (const path of ['.tsbuildinfo', 'fresh.d.ts.map', 'index.mjs'])
      assert.equal(existsSync(join(f.root, types, path)), false, path);
    f.write(
      join(core, 'engine-prerequisite-build-manifest.json'),
      JSON.stringify({ engineSha: '0'.repeat(40) }),
    );
    assert.throws(() => sdkCoreBuildRoot(f.root, join(f.staging, 'core')), /source SHA mismatch/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Three material preparation projects the two admitted strings without loading the compiler', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-three-materials-'));
  try {
    const recipe = join(root, 'scripts', 'build-materials.mjs');
    const core = join(root, 'core');
    mkdirSync(dirname(recipe));
    mkdirSync(core);
    writeFileSync(recipe, readFileSync('packages/three/scripts/build-materials.mjs'));
    const inputs = new Map([
      ['materials.mjs', 'materialPrograms'],
      ['physical.mjs', 'physicalPrograms'],
    ]);
    for (const [file, name] of inputs)
      writeFileSync(join(core, file), `export const ${name} = "KLUv/AAAA";\n`);
    const run = () =>
      execFileSync(process.execPath, [recipe], {
        env: { ...process.env, FORGEAX_THREE_PROGRAM_INPUT: core },
        stdio: 'pipe',
      });
    run();
    for (const [file, name] of inputs)
      assert.ok(
        readFileSync(join(root, 'src/generated', file), 'utf8').includes(
          `export const ${name} = "KLUv/AAAA";`,
        ),
      );
    writeFileSync(join(core, 'physical.mjs'), 'export const physicalPrograms = "invalid";\n');
    assert.throws(run, /Invalid prepared Three program publication/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the download entry pairs exact Core native bytes and keeps shader paths outside SDK clean', async () => {
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
      if (id === '33') {
        fs.writeFileSync(path.join(dest, 'original-base'), 'base');
        fs.mkdirSync(path.join(dest, 'packages/wgpu-wasm'), { recursive: true });
        fs.cpSync(${JSON.stringify(join(f.directory, 'native'))}, path.join(dest, 'packages/wgpu-wasm/pkg'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'engine-prerequisite-build-manifest.json'), JSON.stringify({ engineSha: process.env.FORGEAX_ARTIFACT_EXPECTED_SHA }));
      }
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
    await nativeBundle(f, join(f.directory, 'native'), 'Core');
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
    assert.equal(
      readFileSync(join(f.root, 'packages/wgpu-wasm/pkg/wgpu_wasm.js'), 'utf8'),
      'Core glue',
    );
    assert.equal(
      readFileSync(join(f.root, 'packages/wgpu-wasm/dist/wgpu_wasm_glue.bytes'), 'utf8'),
      'Core glue',
    );
    assert.equal(existsSync(join(f.root, 'shared-app-inputs')), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('all transferred profile consumers admit the original verified compiler before profile checks', () => {
  const download = readFileSync('scripts/ci/download-sdk-shader-inputs.mjs', 'utf8');
  assert.match(download, /await restoreCoreCompiler\(process.cwd\(\), join\(staging, 'core'\)\)/);
  assert.ok(
    download.indexOf('await restoreCoreCompiler') <
      download.indexOf('appendFileSync(process.env.GITHUB_ENV'),
  );
  const workflow = parse(readFileSync('.github/workflows/webgpu-compatibility.yml', 'utf8'));
  const steps = workflow.jobs.compatibility.steps;
  const portable = steps.findIndex(
    (step) => step.name === 'Prepare verified portable scene inputs',
  );
  const base = steps.findIndex(
    (step) => step.name === 'Restore the admitted Core compiler payload',
  );
  assert.ok(portable >= 0 && portable < base);
  assert.match(steps[portable].run, /prepare-source-checkout.mjs third_party\/wgpu/);
  assert.match(steps[base].run, /restore-core-shader-inputs.mjs/);
  assert.match(steps[base].run, /--compiler-only --build-packages/);
  assert.equal(steps[base]['timeout-minutes'], 5);
  const restore = readFileSync('scripts/ci/restore-core-shader-inputs.mjs', 'utf8');
  assert.ok(
    restore.indexOf('await restoreCoreCompiler(root, staging)') <
      restore.indexOf("'scripts/build-packages.mjs'"),
  );
});
