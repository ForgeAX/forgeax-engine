import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

import {
  decodePackagedProfiles,
  encodePackagedProfiles,
  packagedProfilePublication,
} from '../../../packages/vite-plugin-shader/dist/packaged-profiles.mjs';
import { engineShaderSourceDigest } from '../../../packages/vite-plugin-shader/dist/source-digest.mjs';
import { runnerResources, shaderCompileWorkers } from '../../lib/runner-resources.mjs';
import {
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../../lib/shared-build-cache.mjs';

const script = 'scripts/forgeax/prepare-shader-release-inputs.mjs';

/** A minimal publication whose single fragment names its producer. */
const publication = (marker) =>
  JSON.stringify({
    schemaVersion: '5.0.0',
    receipts: [],
    entryPoints: [],
    fragments: [marker],
    sources: { [createHash('sha256').update(marker).digest('hex')]: [0] },
    entries: [],
    materialShaders: [],
  });
const packaged = (output) => decodePackagedProfiles(readFileSync(join(output, 'profiles.json.gz')));
const profileMarker = (output, name) =>
  packagedProfilePublication(packaged(output), name)?.fragments[0];

test('compatibility restores the core base profile with identical cache and input authority', () => {
  const core = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs['core-build'];
  const compatibility = parse(readFileSync('.github/workflows/webgpu-compatibility.yml', 'utf8'))
    .jobs.compatibility;
  assert.equal(compatibility.env.SHADER_OUTPUT, core.env.SHADER_OUTPUT);
  assert.equal(compatibility.env.SHADER_POINT_SHADOWS, core.env.SHADER_POINT_SHADOWS);
  const fingerprint = compatibility.steps.find((step) => step.id === 'shader-inputs');
  assert.match(fingerprint.run, /build-shared-inputs\.mjs --no-point-shadows --fingerprint/);
  const restore = compatibility.steps.find((step) => step.id === 'shader-cache');
  const coreRestore = core.steps.find((step) => step.id === 'shader-cache');
  assert.equal(restore.uses, coreRestore.uses);
  assert.equal(restore.with.path, coreRestore.with.path);
  assert.equal(restore.with.key, coreRestore.with.key);
  assert.equal(restore['timeout-minutes'], 1);
  assert.equal(restore['continue-on-error'], true);
  const preparation = compatibility.steps.find((step) =>
    step.name?.startsWith('Prepare the source-verified shader publication'),
  );
  assert.equal(preparation['timeout-minutes'], 10);
  assert.match(preparation.run, /prepare-shader-release-inputs\.mjs --build --profile base-ssao/);
  assert.match(preparation.run, /--input packages\/vite-plugin-shader\/dist\/engine-inputs\/ci/);
  const save = compatibility.steps.find((step) => step.uses === 'actions/cache/save@v5');
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, restore.with.key);
  assert.match(save.if, /steps\.shader-cache\.outcome == 'success'/);
  assert.match(save.if, /steps\.shader-cache\.outputs\.cache-hit != 'true'/);
  assert.equal(save['timeout-minutes'], 1);
  assert.equal(save['continue-on-error'], true);
  for (const step of [fingerprint, restore, preparation, save]) {
    assert.match(step.if, /steps\.ci-repair\.outputs\.reused != 'true'/);
    assert.match(step.if, /matrix\.carrier == 'stable' \|\| matrix\.carrier == 'webkit'/);
  }
  const gpu = compatibility.steps.find((step) =>
    step.name?.startsWith('Run actual GPU compatibility'),
  );
  assert.ok(compatibility.steps.indexOf(restore) < compatibility.steps.indexOf(preparation));
  assert.ok(compatibility.steps.indexOf(preparation) < compatibility.steps.indexOf(save));
  assert.ok(compatibility.steps.indexOf(save) < compatibility.steps.indexOf(gpu));
});

test('workflow stance permits bounded cache transport but rejects test and job overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-cache-stance-'));
  const cache = `      - &cache
        uses: actions/cache/restore@v5
        timeout-minutes: 1
        continue-on-error: true
`;
  try {
    for (const [steps, offenses] of [
      [cache + cache.replace('&cache', '&save').replace('/restore@', '/save@'), 0],
      [
        [
          cache.replace('timeout-minutes: 1', 'timeout-minutes: 5'),
          cache.replace('uses: actions/cache/restore@v5', 'run: pnpm test'),
          cache.replace('uses: actions/cache/restore@v5', 'uses: ./test-action'),
          '    continue-on-error: true\n',
        ]
          .join('')
          .replaceAll('&cache', 'name: invalid'),
        4,
      ],
    ]) {
      writeFileSync(join(root, 'ci.yml'), `jobs:\n  probe:\n    steps:\n${steps}`);
      const result = spawnSync(
        process.execPath,
        ['apps/hello/triangle/scripts/ac-08-grep-gate.mjs', '--workflow-dir', root],
        { encoding: 'utf8' },
      );
      const report = result.stdout + result.stderr;
      assert.match(report, new RegExp(`\\(d\\) ${offenses === 0 ? 'PASS' : 'FAIL'}:`));
      assert.equal((report.match(/ci\.yml:\d+:.*continue-on-error/g) ?? []).length, offenses);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preparing one shader profile preserves declarations and other profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shader-profile-test-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  try {
    mkdirSync(join(input, 'point-ssao', 'shaders'), { recursive: true });
    writeFileSync(join(input, 'point-ssao', 'shaders', 'manifest.json'), publication('point'));
    mkdirSync(output, { recursive: true });
    const shaderSourceDigest = engineShaderSourceDigest('packages/shader/src');
    writeFileSync(
      join(output, 'profiles.json.gz'),
      encodePackagedProfiles({
        shaderSourceDigest,
        imports: {},
        publications: { 'base-ssao': JSON.parse(publication('existing base')) },
      }),
    );
    writeFileSync(join(output, 'load-engine-shader-entries.d.ts'), 'existing declaration');
    const args = [script, '--profile', 'point-ssao', '--input', input, '--output', output];
    for (let attempt = 0; attempt < 2; attempt++) {
      execFileSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(profileMarker(output, 'point-ssao'), 'point');
      assert.equal(profileMarker(output, 'base-ssao'), 'existing base');
      assert.equal(
        readFileSync(join(output, 'load-engine-shader-entries.d.ts'), 'utf8'),
        'existing declaration',
      );
      const container = packaged(output);
      assert.ok(Object.keys(container.imports).some((key) => key.includes('slot::surface')));
      assert.equal(container.shaderSourceDigest, shaderSourceDigest);
    }
    const invalid = spawnSync(
      process.execPath,
      [script, '--profile', '../unknown', '--output', output],
      { encoding: 'utf8' },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /unknown shader profile/);
    assert.equal(profileMarker(output, 'point-ssao'), 'point');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SDK and browser use one profile producer and preserve source-build validation', () => {
  const sdk = readFileSync('scripts/forgeax/build-sdk.mjs', 'utf8');
  const browser = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  const producer = readFileSync(script, 'utf8');
  const sourceProducer = readFileSync('scripts/build-shared-inputs.mjs', 'utf8');
  assert.match(sdk, /prepare-shader-release-inputs\.mjs',\s*'--build'/);
  assert.doesNotMatch(sdk, /\['point-base', '--point-shadows'\]/);
  assert.match(
    browser,
    /prepare-shader-release-inputs\.mjs'[\s\S]*'--build'[\s\S]*'--profile',[\s\S]*'point-ssao'/,
  );
  assert.ok(browser.indexOf('const profileInputs =') > browser.indexOf('if (options.dryRun)'));
  assert.ok(
    browser.indexOf('const prepared =') < browser.indexOf('const cliPath = resolveCliPath()'),
  );
  assert.match(producer, /FORGEAX_ENGINE_SHADER_SOURCE_BUILD: '1'/);
  assert.ok(
    sourceProducer.indexOf("process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1'") <
      sourceProducer.indexOf('await build('),
  );
  assert.match(browser, /'--passWithNoTests=false'/);
});

test('point-shadow Smoke prepares its verified profile on the same sole owner', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const fleet = workflow.slice(
    workflow.indexOf('  smoke-fleet:\n'),
    workflow.indexOf('  smoke-fleet-required-context:\n'),
  );
  const preparation = fleet.indexOf('- name: Prepare point-shadow smoke shader profile');
  const smoke = fleet.indexOf('- name: Hello-learn-render-5.3.2-point-shadows smoke');
  assert.ok(preparation >= 0 && preparation < smoke);
  const step = fleet.slice(preparation, smoke);
  const profileStep = parse(workflow).jobs['smoke-fleet'].steps.find(
    (candidate) => candidate.name === 'Prepare point-shadow smoke shader profile',
  );

  assert.match(step, /prepare-shader-release-inputs\.mjs --build --profile point-ssao/);
  assert.match(step, /--shared-input-manifest "\$FORGEAX_SHARED_APP_INPUTS_MANIFEST"/);
  assert.doesNotMatch(step, /FORGEAX_ENGINE_SHADER_SOURCE_BUILD/);
  const roster = fleet.indexOf('- name: Run authoritative Dawn roster shard');
  assert.ok(preparation < roster, 'point profile is prepared before any roster consumer');
  assert.equal(
    profileStep.if,
    "steps.ci-repair.outputs.reused != 'true' && (matrix.group == 0 || matrix.group == 1)",
  );
});

test('Editor prerequisite prepares the default shader profile before recording engine dist', () => {
  const source = readFileSync('scripts/ci/build-editor-prerequisite.mjs', 'utf8');
  const profile = source.indexOf("'scripts/forgeax/prepare-shader-release-inputs.mjs'");
  assert.ok(profile > source.indexOf('contract.packageBuild.command'));
  assert.ok(profile < source.indexOf("stageTimingsMs['engine-dist']"));
  assert.match(source.slice(profile), /'--build', '--profile', 'base-ssao'/);
});

test('profile CLI reuses transferred bytes and rebuilds missing, stale or corrupt acceleration', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shader-cli-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    for (const file of [
      script,
      'scripts/lib/shared-build-cache.mjs',
      'scripts/lib/runner-resources.mjs',
      'scripts/lib/shader-source-budget.mjs',
      'scripts/build-task-cache.mjs',
      'packages/vite-plugin-shader/dist/source-digest.mjs',
      'packages/vite-plugin-shader/dist/packaged-profiles.mjs',
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(file, join(root, file));
    }
    write('package.json', '{"type":"module"}');
    write('packages/compiler/package.json', '{"name":"@fixture/compiler"}');
    write('packages/vfx-render/package.json', '{"name":"@forgeax/engine-vfx-render"}');
    write(
      'packages/vite-plugin-shader/package.json',
      '{"name":"@forgeax/engine-vite-plugin-shader","dependencies":{"@fixture/compiler":"workspace:*"}}',
    );
    write('packages/compiler/dist/index.js', 'original');
    write(
      'packages/shader/src/surface.wgsl',
      '#define_import_path forgeax_material::default_standard_surface\nfn surface() {}',
    );
    write(
      'packages/shader/src/default-standard-pbr.wgsl',
      '#import forgeax_material::slot::surface::surface',
    );
    write('pnpm-lock.yaml', 'fixture');
    write('scripts/ci/build-shared-app-inputs.mjs', 'fixture');
    // A deterministic stand-in for the expensive source compiler. The real
    // producer is exercised separately; this test proves CLI branch/recovery.
    write(
      'scripts/build-shared-inputs.mjs',
      `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { getHeapStatistics } from 'node:v8';
      import { runnerResources, shaderProducerHeapSize } from './lib/runner-resources.mjs';
      const heapMiB = shaderProducerHeapSize(runnerResources());
      if (!process.execArgv.includes('--max-old-space-size=' + heapMiB) ||
          getHeapStatistics().heap_size_limit < heapMiB * 1024 * 1024) {
        throw new Error('Source shader publication requires its runner-sized heap');
      }
      const workers = Number(process.env.FORGEAX_SHADER_COMPILE_WORKERS);
      if (!Number.isInteger(workers) || workers < 1 || workers > 4 ||
          (process.env.FORGEAX_TEST_EXPECTED_SHADER_WORKERS &&
           workers !== Number(process.env.FORGEAX_TEST_EXPECTED_SHADER_WORKERS))) {
        throw new Error('Release shader publication requires its bounded compiler pool');
      }
      const out = process.argv[process.argv.indexOf('--out') + 1];
      mkdirSync(resolve(out, 'shaders'), { recursive: true });
      writeFileSync(resolve(out, 'shaders/manifest.json'), ${JSON.stringify(publication('sourceBuild'))});
      console.log('SOURCE_BUILD_CALLED');
    `,
    );
    const input = join(root, 'local');
    const output = join(root, 'published');
    const sharedPath = join(root, 'shared-app-inputs/manifest.json');
    const shaderPath = join(root, 'shared-app-inputs/shaders/manifest.json');
    const profile = { pointShadows: true, hdrpSsao: true };
    const shared = {
      schemaVersion: 1,
      producer: 'shared-app-inputs',
      payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
    };
    const publish = () => {
      write('shared-app-inputs/shaders/manifest.json', publication('shared'));
      writeFileSync(
        sharedPath,
        JSON.stringify({
          ...shared,
          shaderBuild: sharedShaderReceipt(
            root,
            shaderPath,
            sharedShaderInputFingerprint(root, profile),
          ),
        }),
      );
    };
    publish();
    const args = [
      join(root, script),
      '--build',
      '--profile',
      'point-ssao',
      '--input',
      input,
      '--output',
      output,
      '--shared-input-manifest',
      sharedPath,
    ];
    const invoke = (env = {}) =>
      execFileSync(process.execPath, args, {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=2048',
          FORGEAX_BUILD_NO_TASK_CACHE: '0',
          ...env,
        },
        encoding: 'utf8',
      });
    assert.match(invoke(), /verified shared point-ssao; compile count=0/);
    assert.equal(existsSync(input), false, 'shared hit must not run the local producer');
    assert.equal(profileMarker(output, 'point-ssao'), 'shared');
    for (const mutate of [
      () => rmSync(sharedPath),
      () => writeFileSync(sharedPath, '{}'),
      () => writeFileSync(sharedPath, '{'),
      () => rmSync(shaderPath),
      () => writeFileSync(shaderPath, '{"shared":null}'),
      () => write('packages/compiler/dist/index.js', 'changed'),
      () =>
        write(
          'packages/shader/src/surface.wgsl',
          '#define_import_path forgeax_material::default_standard_surface\nfn changed() {}',
        ),
      () =>
        writeFileSync(
          sharedPath,
          JSON.stringify({
            ...shared,
            shaderBuild: sharedShaderReceipt(
              root,
              shaderPath,
              sharedShaderInputFingerprint(root, { ...profile, pointShadows: false }),
            ),
          }),
        ),
    ]) {
      publish();
      mutate();
      assert.match(invoke(), /SOURCE_BUILD_CALLED/);
      assert.equal(profileMarker(output, 'point-ssao'), 'sourceBuild');
    }
    for (const requested of ['1', '2', '64']) {
      const expected = Math.min(4, shaderCompileWorkers(runnerResources(), requested));
      assert.match(
        invoke({
          FORGEAX_BUILD_NO_TASK_CACHE: '1',
          FORGEAX_SHADER_COMPILE_WORKERS: requested,
          FORGEAX_TEST_EXPECTED_SHADER_WORKERS: String(expected),
        }),
        /SOURCE_BUILD_CALLED/,
      );
    }
    // Restored SDK profile inputs have no local task-cache receipt and may
    // arrive on a different checkout path. Reuse their existing transfer receipt.
    const cachedPath = join(input, 'point-ssao/manifest.json');
    const cachedShader = join(input, 'point-ssao/shaders/manifest.json');
    const publishCached = () => {
      write('local/point-ssao/shaders/manifest.json', publication('cached'));
      writeFileSync(
        cachedPath,
        JSON.stringify({
          producer: 'repo-build-inputs',
          payload: { engineShaderManifest: 'local/point-ssao/shaders/manifest.json' },
          shaderBuild: sharedShaderReceipt(
            root,
            cachedShader,
            sharedShaderInputFingerprint(root, profile),
          ),
        }),
      );
    };
    rmSync(sharedPath, { force: true });
    publishCached();
    assert.match(invoke(), /verified cached point-ssao; compile count=0/);
    assert.equal(profileMarker(output, 'point-ssao'), 'cached');
    const portable = mkdtempSync(join(tmpdir(), 'forgeax-shader-portable-'));
    try {
      cpSync(root, portable, { recursive: true });
      const restored = execFileSync(
        process.execPath,
        args.map((value) => value.replace(root, portable)),
        {
          cwd: portable,
          env: { ...process.env, FORGEAX_BUILD_NO_TASK_CACHE: '0' },
          encoding: 'utf8',
        },
      );
      assert.match(restored, /verified cached point-ssao; compile count=0/);
    } finally {
      rmSync(portable, { recursive: true, force: true });
    }
    for (const mutate of [
      () => rmSync(cachedPath),
      () => writeFileSync(cachedPath, '{}'),
      () => rmSync(cachedShader),
      () => writeFileSync(cachedShader, '{"cached":null}'),
      () => write('packages/compiler/dist/index.js', 'cache compiler changed'),
      () => write('packages/wgpu-wasm/pkg/compiler.wasm', 'cache compiler binary changed'),
      () =>
        write(
          'packages/shader/src/surface.wgsl',
          '#define_import_path forgeax_material::default_standard_surface\nfn cached_changed() {}',
        ),
      () =>
        writeFileSync(
          cachedPath,
          JSON.stringify({
            producer: 'repo-build-inputs',
            payload: { engineShaderManifest: 'local/point-ssao/shaders/manifest.json' },
            shaderBuild: sharedShaderReceipt(
              root,
              cachedShader,
              sharedShaderInputFingerprint(root, { ...profile, pointShadows: false }),
            ),
          }),
        ),
    ]) {
      publishCached();
      mutate();
      assert.match(invoke(), /SOURCE_BUILD_CALLED/);
      assert.equal(profileMarker(output, 'point-ssao'), 'sourceBuild');
    }
    publishCached();
    assert.match(invoke({ FORGEAX_BUILD_NO_TASK_CACHE: '1' }), /SOURCE_BUILD_CALLED/);
    rmSync(input, { recursive: true, force: true });
    publish();
    assert.match(invoke({ FORGEAX_BUILD_NO_TASK_CACHE: '1' }), /SOURCE_BUILD_CALLED/);
    mkdirSync(join(output, 'base-base'), { recursive: true });
    writeFileSync(join(output, 'base-base/manifest.json'), 'obsolete duplicate');
    const allProfiles = execFileSync(
      process.execPath,
      [
        join(root, script),
        '--build',
        '--input',
        input,
        '--output',
        output,
        '--shared-input-manifest',
        sharedPath,
      ],
      { cwd: root, env: { ...process.env, FORGEAX_BUILD_NO_TASK_CACHE: '0' }, encoding: 'utf8' },
    );
    assert.equal((allProfiles.match(/SOURCE_BUILD_CALLED/g) ?? []).length, 1);
    assert.match(allProfiles, /verified shared point-ssao; compile count=0/);
    // Retired per-profile directories, including obsolete no-SSAO copies, go.
    for (const name of ['base-base', 'point-base', 'base-ssao', 'point-ssao']) {
      assert.equal(existsSync(join(output, name)), false);
    }
    assert.equal(profileMarker(output, 'point-ssao'), 'shared');
    assert.equal(profileMarker(output, 'base-ssao'), 'sourceBuild');
    // The core artifact carries a separately validated base profile. A point
    // shared input must never satisfy base admission, nor force every View
    // consumer to repeat the same source compilation.
    const coreDirectory = 'packages/vite-plugin-shader/dist/engine-inputs/ci/base-ssao';
    const coreShader = join(root, coreDirectory, 'shaders/manifest.json');
    const coreManifest = join(root, coreDirectory, 'manifest.json');
    const publishCore = () => {
      write(`${coreDirectory}/shaders/manifest.json`, publication('coreBase'));
      writeFileSync(
        coreManifest,
        JSON.stringify({
          producer: 'repo-build-inputs',
          payload: { engineShaderManifest: `${coreDirectory}/shaders/manifest.json` },
          shaderBuild: sharedShaderReceipt(
            root,
            coreShader,
            sharedShaderInputFingerprint(root, { pointShadows: false, hdrpSsao: true }),
          ),
        }),
      );
    };
    publishCore();
    const baseArgs = args.map((value) => (value === 'point-ssao' ? 'base-ssao' : value));
    const invokeBase = (env = {}) =>
      execFileSync(process.execPath, baseArgs, {
        cwd: root,
        env: { ...process.env, FORGEAX_BUILD_NO_TASK_CACHE: '0', ...env },
        encoding: 'utf8',
      });
    assert.match(invokeBase(), /verified core base-ssao; compile count=0/);
    assert.equal(profileMarker(output, 'base-ssao'), 'coreBase');
    for (const mutate of [
      () => rmSync(coreManifest),
      () => writeFileSync(coreShader, '{"corrupt":true}'),
      () => write('packages/compiler/dist/index.js', 'core compiler changed'),
      () =>
        writeFileSync(
          coreManifest,
          JSON.stringify({
            producer: 'repo-build-inputs',
            payload: { engineShaderManifest: `${coreDirectory}/shaders/manifest.json` },
            shaderBuild: sharedShaderReceipt(
              root,
              coreShader,
              sharedShaderInputFingerprint(root, profile),
            ),
          }),
        ),
    ]) {
      publishCore();
      mutate();
      assert.match(invokeBase(), /SOURCE_BUILD_CALLED/);
    }
    publishCore();
    assert.match(invokeBase({ FORGEAX_BUILD_NO_TASK_CACHE: '1' }), /SOURCE_BUILD_CALLED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
