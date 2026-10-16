import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CONTRACT_PATH,
  createBuildManifest,
  ENGINE_ROOT,
  loadContract,
  parseArgs,
  validateContract,
} from '../build-editor-prerequisite.mjs';

const cli = resolve(ENGINE_ROOT, 'scripts/ci/build-editor-prerequisite.mjs');

test('contract declares the source-only payload, toolchain, provenance, and failure owners', () => {
  const contract = loadContract();
  assert.equal(contract.schemaVersion, 'forgeax-engine-editor-prerequisite-build-contract/v1');
  assert.equal(contract.sourceOnly, true);
  assert.deepEqual(Object.keys(contract.payloadClasses), [
    'engine-dist',
    'wgpu-wasm',
    'fbx-wasm',
    'wasm-codec',
  ]);
  assert.deepEqual(contract.install.command, [
    'pnpm',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--force',
  ]);
  assert.deepEqual(contract.packageBuild.command, ['pnpm', 'build:packages']);
  assert.ok(contract.recipeInputs.includes('packages/codec/scripts/build-wasm.mjs'));
  assert.ok(contract.recipeInputs.includes('scripts/ci/setup-emscripten-no-xz.py'));
  assert.ok(contract.recipeInputs.includes('scripts/ci/prepare-emscripten-no-xz-archive.py'));
  assert.equal(contract.toolchainInputs.node, '.nvmrc');
  assert.equal(contract.toolchainInputs.pnpm, '.pnpm-version');
  assert.equal(contract.toolchainInputs.wasmPackVersion, '0.14.0');
  for (const code of [
    'engine-source-only-required',
    'engine-source-sha-mismatch',
    'engine-payload-class-unsupported',
    'engine-toolchain-contract-mismatch',
    'engine-frozen-install-failed',
    'engine-source-build-failed',
    'engine-output-incomplete',
  ]) {
    assert.ok(contract.failureCodes.includes(code), `missing failure code ${code}`);
  }
});

test('contract check and manifest digests are deterministic without a wasm toolchain', () => {
  const checked = validateContract();
  assert.equal(checked.sourceOnly, true);
  assert.match(checked.recipeDigest, /^[0-9a-f]{64}$/);

  const input = {
    engineSha: 'a'.repeat(40),
    recursivePins: [{ path: 'forgeax-engine-assets', pin: 'b'.repeat(40) }],
    payloadClasses: ['engine-dist', 'wgpu-wasm'],
    recipeDigest: checked.recipeDigest,
    lockfileDigest: 'c'.repeat(64),
    toolchain: { node: '22.22.3', pnpm: '12.10.1', rust: '1.93.0', wasmPack: '0.14.0' },
  };
  const inventory = [
    {
      payloadClass: 'engine-dist',
      path: 'payload/engine-dist/runtime/dist/index.mjs',
      bytes: 3,
      sha256: 'd'.repeat(64),
    },
  ];
  const recipe = { inputs: [{ path: 'scripts/build.mjs', sha256: 'e'.repeat(64) }] };
  const first = createBuildManifest({ input, inventory, recipe, durationMs: 10 });
  const second = createBuildManifest({ input, inventory, recipe, durationMs: 10 });
  assert.deepEqual(first, second);
  assert.match(first.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(first.outputDigest, /^[0-9a-f]{64}$/);
  assert.equal(first.productionMode, 'source-build');
  assert.equal(first.os, process.platform);
  assert.equal(first.architecture, process.arch);
  assert.deepEqual(first.stageTimingsMs, {});
  assert.notEqual(
    first.outputDigest,
    createBuildManifest({
      input,
      inventory: [{ ...inventory[0], sha256: 'f'.repeat(64) }],
      recipe,
      durationMs: 10,
    }).outputDigest,
  );
});

test('recipe inputs cover every source-build entry and Emscripten bootstrap script', () => {
  const contract = loadContract();
  const recipeInputs = new Set(contract.recipeInputs);
  for (const path of [
    'packages/wgpu-wasm/build.sh',
    'packages/fbx/scripts/fetch-ufbx.mjs',
    'packages/fbx/scripts/build-wasm.mjs',
    'packages/codec/scripts/build-wasm.mjs',
    'scripts/ci/setup-emscripten-no-xz.py',
    'scripts/ci/prepare-emscripten-no-xz-archive.py',
  ]) {
    assert.ok(recipeInputs.has(path), `recipeInputs must cover ${path}`);
  }
  assert.equal(contract.toolchainInputs.basis, 'packages/codec/scripts/fetch-basis.mjs');
});

test('canonical arguments normalize payload order and preserve the exact SHA assertion', () => {
  const sha = 'a'.repeat(40);
  const parsed = parseArgs([
    '--source-only',
    '--engine-sha',
    sha,
    '--payload-classes',
    'wgpu-wasm,engine-dist,fbx-wasm,wgpu-wasm',
    '--output',
    'out',
  ]);
  assert.equal(parsed.sourceOnly, true);
  assert.equal(parsed.engineSha, sha);
  assert.deepEqual(parsed.payloadClasses, ['engine-dist', 'fbx-wasm', 'wgpu-wasm']);
  assert.equal(parsed.output, resolve('out'));
  assert.throws(
    () => parseArgs(['--engine-sha', sha, '--payload-classes', 'engine-dist', '--output', 'out']),
    /Editor CI must explicitly select the source-only contract/,
  );
});

test('source-only recipe has no Engine Actions API or release hydration path', () => {
  const cliText = readFileSync(cli, 'utf8');
  const contractText = readFileSync(CONTRACT_PATH, 'utf8');
  for (const forbidden of [
    'api.github.com',
    'ENGINE_WORKFLOW_PATH',
    'core-build-a',
    'ensure-wasm.mjs',
    'fetch-wasm.mjs',
    'gh api',
  ]) {
    assert.ok(
      !cliText.includes(forbidden),
      `CLI contains forbidden cross-repository path: ${forbidden}`,
    );
    assert.ok(!contractText.includes(forbidden), `contract contains forbidden path: ${forbidden}`);
  }
});

test('Editor action keeps the source-only contract while Engine CI owns its fast artifact producer', () => {
  const workflow = readFileSync(resolve(ENGINE_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const action = readFileSync(
    resolve(ENGINE_ROOT, '.github/actions/editor-prerequisite-build/action.yml'),
    'utf8',
  );
  const coreStart = workflow.indexOf('  core-build:');
  const nextJob = workflow.indexOf('\n  shared-app-inputs:', coreStart);
  const coreBuild = workflow.slice(coreStart, nextJob);
  assert.doesNotMatch(coreBuild, /build-editor-prerequisite\.mjs/);
  assert.match(coreBuild, /uses: \.\/\.github\/actions\/prepare-wgpu-wasm/);
  assert.match(coreBuild, /Hydrate fbx \+ codec pkg\/ from release \(best-effort\)/);
  assert.match(coreBuild, /Build package JavaScript once/);
  assert.match(coreBuild, /Stage core artifact classes[\s\S]*packages\/\*\/dist/);
  assert.match(coreBuild, /for source in[^\n]*packages\/dsh\/lib/);
  assert.match(coreBuild, /engineDistPaths = \[[\s\S]*'packages\/dsh\/lib\/client\.js'/);
  assert.ok(
    JSON.parse(
      readFileSync(resolve(ENGINE_ROOT, 'scripts/ci/build-artifact-contract.json'), 'utf8'),
    ).artifactClasses['engine-dist'].fileClasses.includes('packages/dsh/lib/client.js'),
  );
  assert.match(coreBuild, /Bind core artifact to the checked-out Engine source/);
  assert.match(action, /build-editor-prerequisite\.mjs/);
  assert.match(action, /--source-only/);
  assert.match(action, /--engine-sha "\$ENGINE_SHA"/);
  assert.match(action, /--payload-classes "\$PAYLOAD_CLASSES"/);
  assert.match(action, /--output "\$OUTPUT"/);
  assert.match(action, /needs_codec/);
  assert.match(action, /needs_emscripten/);
  assert.doesNotMatch(action, /ensure-wasm|fetch-wasm|ENGINE_WORKFLOW_PATH|core-build-a|gh api/);
});

test('manifest carries per-file payload ownership and source-build provenance', () => {
  const contract = loadContract();
  const manifest = createBuildManifest({
    input: {
      engineSha: 'a'.repeat(40),
      recursivePins: [],
      payloadClasses: ['wasm-codec'],
      recipeDigest: 'b'.repeat(64),
      lockfileDigest: 'c'.repeat(64),
      toolchain: { node: '22.22.3', pnpm: '12.10.1', emscripten: '6.0.2' },
    },
    inventory: [
      {
        payloadClass: 'wasm-codec',
        path: 'payload/wasm-codec/basis_transcoder.wasm',
        bytes: 4,
        sha256: 'd'.repeat(64),
      },
    ],
    recipe: { inputs: [{ path: contract.recipeInputs[0], sha256: 'e'.repeat(64) }] },
    durationMs: 12,
    stageTimingsMs: { install: 3, 'wasm-codec': 8, staging: 1 },
    environment: { os: 'linux', architecture: 'x64' },
  });
  assert.equal(manifest.productionMode, 'source-build');
  assert.equal(manifest.os, 'linux');
  assert.equal(manifest.architecture, 'x64');
  assert.equal(manifest.inventory[0].payloadClass, 'wasm-codec');
  assert.deepEqual(manifest.stageTimingsMs, { install: 3, 'wasm-codec': 8, staging: 1 });
});

test('package-only build reuses package and declaration stages without shared inputs or apps', () => {
  const build = readFileSync(resolve(ENGINE_ROOT, 'scripts/build.mjs'), 'utf8');
  assert.match(build, /--packages-only/);
  assert.match(build, /mode !== 'packages-only'/);
  assert.match(build, /runStage\('packages'/);
  assert.match(build, /runStage\('types-preflight'/);
  assert.match(build, /runStage\('types'/);
  assert.match(build, /if \(mode === 'full'\)/);
});

test('wrong exact SHA fails before toolchain setup with a structured stable code', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-editor-prerequisite-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        '--source-only',
        '--engine-sha',
        '0'.repeat(40),
        '--payload-classes',
        'engine-dist',
        '--output',
        output,
      ],
      { cwd: ENGINE_ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));
    assert.equal(failure.status, 'failure');
    assert.equal(failure.code, 'engine-source-sha-mismatch');
    assert.equal(failure.expected, '0'.repeat(40));
    assert.match(failure.hint, /exact Editor packages\/engine gitlink/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('ufbx source lock binds both downloaded files by byte length and SHA-256', () => {
  const lock = JSON.parse(
    readFileSync(resolve(ENGINE_ROOT, 'packages/fbx/scripts/ufbx-source.lock.json'), 'utf8'),
  );
  assert.equal(lock.version, 'v0.23.0');
  assert.deepEqual(lock.files, {
    'ufbx.h': {
      sha256: '942481725372d2ac4da5e77a062b47c20054a3440e7ee09a6043f99fe1f130ed',
      bytes: 223898,
    },
    'ufbx.c': {
      sha256: '7d8d6ae4373f71692f295ff49ee0826466306ebcaa80b0e587c13ed047b98cea',
      bytes: 1181162,
    },
  });
  const fetchScript = readFileSync(
    resolve(ENGINE_ROOT, 'packages/fbx/scripts/fetch-ufbx.mjs'),
    'utf8',
  );
  assert.match(fetchScript, /ufbx-source-digest-mismatch/);
  assert.match(fetchScript, /createHash\('sha256'\)/);
});
