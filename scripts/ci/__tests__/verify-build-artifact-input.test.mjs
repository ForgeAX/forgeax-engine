// verify-build-artifact-input.test.mjs — TDD RED fixtures for
// verify-build-artifact-input.mjs (t3).
//
// Cover: consumer with all paths present exits 0; consumer with missing path
// exits non-zero with structured error; unknown consumer exits non-zero.
// Uses temp directories to simulate artifact extraction results.
//
// Usage: node --test scripts/ci/__tests__/verify-build-artifact-input.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = realpathSync(join(__dirname, '..', '..', '..'));
const verifierPath = join(repoRoot, 'scripts', 'ci', 'verify-build-artifact-input.mjs');

/**
 * Run the verifier and return { exitCode, stdout, stderr }.
 */
function runVerifier(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [verifierPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString()?.trim() ?? '',
      stderr: err.stderr?.toString()?.trim() ?? '',
    };
  }
}

test('core family admission keeps native paths mandatory and does not replace full admission', () => {
  const root = tmpExtraction(
    {
      'packages/fixture/dist': null,
      'packages/wgpu-wasm/pkg': null,
    },
    (contract) => {
      contract.artifactClasses['engine-dist'].transferArtifact = 'core-build';
      contract.artifactClasses['wasm-runtime'].transferArtifact = 'core-build';
      contract.artifactClasses['wasm-fbx'].transferArtifact = 'core-build';
      contract.artifactClasses['app-dist'].transferArtifact = 'app-dist';
      contract.consumers['primary-pnpm'].requiredArtifactClasses.push('wasm-fbx');
    },
  );
  try {
    const contractPath = join(root, 'build-artifact-contract.json');
    const args = ['--consumer', 'primary-pnpm', '--root', root, '--contract', contractPath];
    assert.notEqual(runVerifier([...args, '--transfer-artifact', 'core-build']).exitCode, 0);
    mkdirSync(join(root, 'packages/fbx/pkg'), { recursive: true });
    assert.equal(runVerifier([...args, '--transfer-artifact', 'core-build']).exitCode, 0);
    assert.notEqual(runVerifier(args).exitCode, 0, 'full admission still requires app inputs');
    assert.notEqual(runVerifier([...args, '--transfer-artifact', 'not-declared']).exitCode, 0);
    const malformed = JSON.parse(readFileSync(contractPath, 'utf8'));
    malformed.consumers['primary-pnpm'].requiredArtifactClasses.push('unknown-class');
    writeFileSync(contractPath, JSON.stringify(malformed));
    const invalidClass = runVerifier([...args, '--transfer-artifact', 'core-build']);
    assert.notEqual(
      invalidClass.exitCode,
      0,
      'family filtering must preserve unknown-class rejection',
    );
    assert.equal(JSON.parse(invalidClass.stdout).code, 'ci-artifact-contract-class-unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Create a temp directory structure simulating artifact extraction.
 * Pass an object mapping repo-relative paths to file content (or null for dir).
 */
function tmpExtraction(files, mutateContract = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-input-'));
  // Write a minimal contract into the temp root
  const contract = {
    version: 1,
    extractionRoot: '.',
    artifactClasses: {
      'engine-dist': { fileClasses: ['packages/*/dist'] },
      'wasm-runtime': { fileClasses: ['packages/wgpu-wasm/pkg'] },
      'wasm-fbx': { fileClasses: ['packages/fbx/pkg'] },
      'wasm-codec': { fileClasses: ['packages/codec/pkg'] },
      'app-dist': {
        fileClasses: ['apps/**/dist/shaders/manifest.json'],
      },
    },
    consumers: {
      'vitest-dawn': { requiredArtifactClasses: ['engine-dist', 'wasm-runtime'] },
      'primary-pnpm': {
        requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'app-dist'],
      },
      'publish-fbx-wasm-release': { requiredArtifactClasses: ['wasm-fbx'] },
    },
    provenance: {
      producerRoster: ['core-build', 'app-shard-0', 'app-shard-1', 'app-shard-2'],
      namingTemplate: 'provenance-<producerJobId>-a<runAttempt>',
      mergedClass: 'provenance-merged',
      mergedWriter: 'build-artifacts',
      payloadClasses: ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec', 'app-dist'],
    },
  };
  mutateContract(contract);
  writeFileSync(
    join(root, 'build-artifact-contract.json'),
    JSON.stringify(contract, null, 2),
    'utf-8',
  );

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    if (content === null) {
      mkdirSync(fullPath, { recursive: true });
    } else {
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
  }
  return root;
}

// ============================================================================
// Tests
// ============================================================================

test('shared Browser source recovery needs no app Pack before its own executable builds', () => {
  const repository = JSON.parse(
    readFileSync(join(repoRoot, 'scripts/ci/build-artifact-contract.json'), 'utf8'),
  );
  const consumer = 'shared-inputs-browser';
  const root = tmpExtraction(
    {
      'packages/runtime/dist/index.mjs': 'export {}',
      'packages/dsh/lib/client.js': 'browser export',
      'packages/preview/assets/canonical-kit/present': 'source kit',
      'packages/ui-blitz/pkg/ui_blitz_bg.wasm': 'UI payload',
      'packages/physics-rapier2d/pkg/rapier.wasm': '2D payload',
      'packages/physics-rapier3d/pkg/rapier.mjs': 'WASM payload',
      'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
      'shared-app-inputs/shaders/manifest.json': '{}',
      'apps/hello/multithreaded-execution/dist/shaders/manifest.json': '{}',
    },
    (contract) => {
      contract.artifactClasses = repository.artifactClasses;
      contract.consumers = { [consumer]: repository.consumers[consumer] };
    },
  );
  try {
    const args = [
      '--consumer',
      consumer,
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ];
    const present = runVerifier(args);
    assert.equal(present.exitCode, 0, present.stdout || present.stderr);
    rmSync(join(root, 'shared-app-inputs/shaders/manifest.json'));
    const missing = runVerifier(args);
    assert.notEqual(missing.exitCode, 0);
    assert.equal(JSON.parse(missing.stdout).code, 'ci-artifact-required-path-missing');
    assert.match(JSON.parse(missing.stdout).expected, /shared-engine-shaders/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t3: consumer with all declared paths present exits 0', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/runtime/dist/index.d.ts': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    'packages/wgpu-wasm/pkg/wgpu_wasm.js': 'export {}',
    'apps/hello-triangle/dist/shaders/manifest.json': '{}',
  });
  try {
    const r = runVerifier([
      '--consumer',
      'primary-pnpm',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.strictEqual(r.exitCode, 0, `should pass with all paths present: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('ok') || r.stdout.includes('pass') || r.stdout.includes('verified'),
      'output should indicate ok/pass/verified',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t3: consumer missing a required path exits non-zero with structured error', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    // 'packages/wgpu-wasm/pkg/...' is MISSING
  });
  try {
    const r = runVerifier([
      '--consumer',
      'vitest-dawn',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing required path');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(
      parsed.code,
      'ci-artifact-required-path-missing',
      `expected ci-artifact-required-path-missing but got ${parsed.code}`,
    );
    assert.strictEqual(typeof parsed.consumer, 'string', 'should have consumer field');
    assert.strictEqual(typeof parsed.expected, 'string', 'should have expected field');
    assert.strictEqual(typeof parsed.hint, 'string', 'should have hint field');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t3: consumer name not in contract exits non-zero with structured error', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
  });
  try {
    const r = runVerifier(['--consumer', 'unknown-consumer', '--root', root]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on unknown consumer');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(
      parsed.code,
      'ci-artifact-unknown-consumer',
      `expected ci-artifact-unknown-consumer but got ${parsed.code}`,
    );
    assert.strictEqual(typeof parsed.consumer, 'string', 'should have consumer field');
    assert.ok(parsed.consumer === 'unknown-consumer', 'consumer should be the unknown name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t3: missing --consumer flag produces error', async () => {
  const root = tmpExtraction({});
  try {
    const r = runVerifier(['--root', root]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail on missing --consumer flag');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t3: consumer with no files produces error if required classes exist', async () => {
  // vitest-dawn requires engine-dist and wasm-runtime
  const root = tmpExtraction({});
  try {
    const r = runVerifier(['--consumer', 'vitest-dawn', '--root', root]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail when no required files exist');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.code, 'ci-artifact-required-path-missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t3: consumer with only engine-dist but needs wasm-runtime fails', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/dsh/lib/client.js': 'browser export',
    'packages/preview/assets/canonical-kit/example.json': '{}',
    'packages/ui-blitz/pkg/ui_blitz_bg.wasm': 'UI payload',
    'packages/physics-rapier2d/pkg/rapier.wasm': '2D payload',
    'packages/physics-rapier3d/pkg/rapier.mjs': 'WASM payload',
    // missing packages/wgpu-wasm/pkg
  });
  try {
    const r = runVerifier(['--consumer', 'vitest-dawn', '--root', root]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail when wasm-runtime is missing');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.code, 'ci-artifact-required-path-missing');
    assert.ok(parsed.expected?.includes('wasm-runtime'), 'expected should mention wasm-runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// t8: Consumer download path verification tests
// ============================================================================

test('t8: primary-pnpm with all declared classes present exits 0', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    'apps/hello-triangle/dist/shaders/manifest.json': '{}',
  });
  try {
    const r = runVerifier([
      '--consumer',
      'primary-pnpm',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.strictEqual(r.exitCode, 0, `primary-pnpm should pass: ${r.stderr}`);
    assert.ok(r.stdout.includes('verified'), 'output should indicate verified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t8: app artifact globs match nested body and Pack sidecars', async () => {
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const appDistRoot = 'apps/learn-render/6.pbr/2.ibl-irradiance/dist';
  const appAssetRoot = 'apps/learn-render/6.pbr/2.ibl-irradiance/dist/assets';
  const root = tmpExtraction(
    {
      'packages/runtime/dist/index.mjs': 'export {}',
      'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
      'apps/learn-render/6.pbr/2.ibl-irradiance/dist/shaders/manifest.json': '{}',
      [`${appDistRoot}/pack-index.json`]: '[]',
      [`${appAssetRoot}/${guid}-body.bin`]: 'body',
      [`${appAssetRoot}/${guid}.pack.json`]: '{}',
      [`${appAssetRoot}/${guid}.pack-material.json`]: '{}',
    },
    (contract) => {
      contract.artifactClasses['app-dist'].fileClasses = [
        'apps/**/dist/shaders/manifest.json',
        'apps/**/dist/pack-index.json',
        'apps/**/dist/assets/*-body.bin',
        'apps/**/dist/assets/*.pack*.json',
      ];
    },
  );
  try {
    const r = runVerifier([
      '--consumer',
      'primary-pnpm',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.strictEqual(r.exitCode, 0, `app Pack closure should pass: ${r.stderr || r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t8: vitest-dawn with engine-dist + wasm-runtime only exits 0', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
  });
  try {
    const r = runVerifier([
      '--consumer',
      'vitest-dawn',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.strictEqual(r.exitCode, 0, `vitest-dawn should pass: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t8: publish-fbx-wasm-release with only wasm-fbx exits 0', async () => {
  const root = tmpExtraction({
    'packages/fbx/pkg/fbx-wasm.wasm': 'binary',
  });
  try {
    const r = runVerifier(['--consumer', 'publish-fbx-wasm-release', '--root', root]);
    assert.strictEqual(r.exitCode, 0, `publish-fbx-wasm-release should pass: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t8: primary-pnpm missing app-dist fails with structured error', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    // missing apps/**/dist/shaders/manifest.json
  });
  try {
    const r = runVerifier([
      '--consumer',
      'primary-pnpm',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail when app-dist is missing');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.code, 'ci-artifact-required-path-missing');
    assert.ok(parsed.expected?.includes('app-dist'), 'expected should mention app-dist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t8: consumer with extra undeclared class still passes (contract only enforces minimum)', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    'packages/fbx/pkg/fbx-wasm.wasm': 'extra',
    'packages/codec/pkg/encode/basis_encoder.wasm': 'extra',
    'apps/hello-triangle/dist/shaders/manifest.json': 'extra',
  });
  try {
    const r = runVerifier([
      '--consumer',
      'vitest-dawn',
      '--root',
      root,
      '--contract',
      join(root, 'build-artifact-contract.json'),
    ]);
    assert.strictEqual(r.exitCode, 0, `extra files should not cause failure: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t8: vitest-dawn missing engine-dist fails with structured error', async () => {
  const root = tmpExtraction({
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    // missing packages/*/dist
  });
  try {
    const r = runVerifier(['--consumer', 'vitest-dawn', '--root', root]);
    assert.notStrictEqual(r.exitCode, 0, 'should fail when engine-dist is missing');
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.code, 'ci-artifact-required-path-missing');
    assert.ok(parsed.expected?.includes('engine-dist'), 'expected should mention engine-dist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// t12a: app shards receive every core-build payload before their build starts.
test('t12a: core shard input requires all four core artifact classes', async () => {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    'packages/fbx/pkg/fbx-wasm.wasm': 'binary',
    'packages/codec/pkg/basis_transcoder.wasm': 'binary',
  });
  try {
    const contractPath = join(root, 'build-artifact-contract.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    contract.consumers['app-shard-core-input'] = {
      requiredArtifactClasses: ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec'],
    };
    writeFileSync(contractPath, JSON.stringify(contract), 'utf8');

    const pass = runVerifier([
      '--consumer',
      'app-shard-core-input',
      '--root',
      root,
      '--contract',
      contractPath,
    ]);
    assert.equal(pass.exitCode, 0, pass.stderr || pass.stdout);

    rmSync(join(root, 'packages', 'fbx'), { recursive: true, force: true });
    const missing = runVerifier([
      '--consumer',
      'app-shard-core-input',
      '--root',
      root,
      '--contract',
      contractPath,
    ]);
    assert.notEqual(missing.exitCode, 0);
    const error = JSON.parse(missing.stdout);
    assert.equal(error.code, 'ci-artifact-required-path-missing');
    assert.match(error.expected, /wasm-fbx/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sharedInputFixture(mutate = () => {}) {
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
    'packages/fbx/pkg/fbx-wasm.wasm': 'binary',
    'packages/codec/pkg/basis_transcoder.wasm': 'binary',
    'shared-app-inputs/assets/catalog.json': '{}',
    'shared-app-inputs/assets/payload/texture.bin': 'cooked texture bytes',
    'shared-app-inputs/shaders/manifest.json': '{}',
    'shared-app-inputs/shaders/engine.wgsl': 'compiled shader source',
  });
  const contractPath = join(root, 'build-artifact-contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  contract.version = 2;
  contract.artifactClasses['shared-asset-pack'] = {
    fileClasses: ['shared-app-inputs/assets/catalog.json'],
  };
  contract.artifactClasses['shared-engine-shaders'] = {
    fileClasses: ['shared-app-inputs/shaders/manifest.json'],
  };
  contract.consumers['app-shard'] = {
    requiredArtifactClasses: [
      'engine-dist',
      'wasm-runtime',
      'wasm-fbx',
      'wasm-codec',
      'shared-asset-pack',
      'shared-engine-shaders',
    ],
  };
  contract.sharedInputs = {
    producer: 'shared-app-inputs',
    consumer: 'app-shard',
    schemaVersion: 1,
    manifestPath: 'shared-app-inputs/manifest.json',
    payload: {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      assetPayloadRoot: 'shared-app-inputs/assets/payload',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    },
    payloadClasses: ['shared-asset-pack', 'shared-engine-shaders'],
  };
  mutate(contract, root);
  writeFileSync(contractPath, JSON.stringify(contract), 'utf8');
  const manifestPath = join(root, 'shared-app-inputs', 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      producer: 'shared-app-inputs',
      inputFingerprint: 'fixture-fingerprint',
      inventory: [
        'shared-app-inputs/assets/catalog.json',
        'shared-app-inputs/shaders/manifest.json',
      ],
      payload: contract.sharedInputs.payload,
      payloadInventory: [
        'shared-app-inputs/assets/catalog.json',
        'shared-app-inputs/assets/payload/texture.bin',
        'shared-app-inputs/shaders/manifest.json',
        'shared-app-inputs/shaders/engine.wgsl',
      ],
    }),
    'utf8',
  );
  return { root, contractPath, manifestPath };
}

test('shared payload inventory rejects a missing admitted binding file', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.payloadInventory.push('shared-app-inputs/shaders/missing.bindings.json');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const result = runVerifier([
      '--consumer',
      'app-shard',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--input-fingerprint',
      'fixture-fingerprint',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-shared-input-payload-missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w6: app shard accepts a complete compatible shared input manifest', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture();
  try {
    const result = runVerifier([
      '--consumer',
      'app-shard',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--input-fingerprint',
      'fixture-fingerprint',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w6: app shard accepts catalog-only shared inputs without serialized payload', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture();
  try {
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    contract.sharedInputs.payload = {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    };
    writeFileSync(contractPath, JSON.stringify(contract), 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.payload = contract.sharedInputs.payload;
    delete manifest.payloadInventory;
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = runVerifier([
      '--consumer',
      'app-shard',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--input-fingerprint',
      'fixture-fingerprint',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w6: full shared consumer accepts the producer full payload contract', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture((contract) => {
    contract.consumers['shared-inputs-browser'] = {
      requiredArtifactClasses: [
        'engine-dist',
        'wasm-runtime',
        'shared-asset-pack',
        'shared-engine-shaders',
      ],
    };
    contract.sharedInputs.consumers = ['app-shard', 'shared-inputs-browser'];
    contract.sharedInputs.fullPayload = { ...contract.sharedInputs.payload };
  });
  try {
    const result = runVerifier([
      '--consumer',
      'shared-inputs-browser',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--shared-input-mode',
      'full',
      '--input-fingerprint',
      'fixture-fingerprint',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w6: full shared consumer rejects a catalog-only projection', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture((contract) => {
    contract.consumers['shared-inputs-browser'] = {
      requiredArtifactClasses: [
        'engine-dist',
        'wasm-runtime',
        'shared-asset-pack',
        'shared-engine-shaders',
      ],
    };
    contract.sharedInputs.consumers = ['app-shard', 'shared-inputs-browser'];
    contract.sharedInputs.fullPayload = { ...contract.sharedInputs.payload };
  });
  try {
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    contract.sharedInputs.payload = {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    };
    writeFileSync(contractPath, JSON.stringify(contract), 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.payload = contract.sharedInputs.payload;
    delete manifest.payloadInventory;
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = runVerifier([
      '--consumer',
      'shared-inputs-browser',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--shared-input-mode',
      'full',
      '--input-fingerprint',
      'fixture-fingerprint',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-shared-input-payload-mismatch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w6: app shard rejects missing, stale, or mismatched shared input provenance', () => {
  for (const mutate of [
    (manifest) => delete manifest.inventory,
    (manifest) => (manifest.schemaVersion = 0),
    (manifest) => (manifest.inputFingerprint = 'stale-fingerprint'),
    (manifest) => (manifest.producer = 'core-build'),
  ]) {
    const { root, contractPath, manifestPath } = sharedInputFixture();
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      mutate(manifest);
      writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
      const result = runVerifier([
        '--consumer',
        'app-shard',
        '--root',
        root,
        '--contract',
        contractPath,
        '--shared-input-manifest',
        manifestPath,
        '--input-fingerprint',
        'fixture-fingerprint',
      ]);
      assert.notEqual(result.exitCode, 0);
      const error = JSON.parse(result.stdout);
      assert.match(error.code, /^ci-shared-input-(?:schema|inventory|fingerprint|producer)-/);
      assert.equal(typeof error.expected, 'string');
      assert.equal(typeof error.hint, 'string');
      assert.ok('actual' in error || 'detail' in error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('repair: a stale manifest cannot set its own expected fingerprint', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.inputFingerprint = 'stale-fingerprint';
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = runVerifier([
      '--consumer',
      'app-shard',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--input-fingerprint',
      'trusted-producer-fingerprint',
    ]);
    assert.notEqual(result.exitCode, 0);
    const error = JSON.parse(result.stdout);
    assert.equal(error.code, 'ci-shared-input-fingerprint-mismatch');
    assert.equal(error.expected, 'trusted-producer-fingerprint');
    assert.equal(error.actual, 'stale-fingerprint');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w9 revision: app shard rejects a manifest whose serialized payload is incomplete', () => {
  const { root, contractPath, manifestPath } = sharedInputFixture();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.payloadInventory.push('shared-app-inputs/shaders/missing.bindings.json');
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = runVerifier([
      '--consumer',
      'app-shard',
      '--root',
      root,
      '--contract',
      contractPath,
      '--shared-input-manifest',
      manifestPath,
      '--input-fingerprint',
      'fixture-fingerprint',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-shared-input-payload-missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real core admission rejects a missing Rapier payload even when package dist is present', () => {
  const contract = join(repoRoot, 'scripts/ci/build-artifact-contract.json');
  const root = tmpExtraction({
    'packages/runtime/dist/index.mjs': 'export {}',
    'packages/dsh/lib/client.js': 'browser export',
    'packages/preview/assets/canonical-kit/present': 'source kit',
    'packages/ui-blitz/pkg/ui_blitz_bg.wasm': 'UI payload',
    'packages/physics-rapier2d/pkg/rapier.wasm': '2D payload',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'binary',
  });
  const args = [
    '--consumer',
    'primary-pnpm',
    '--root',
    root,
    '--contract',
    contract,
    '--transfer-artifact',
    'core-build',
  ];
  try {
    const missing = runVerifier(args);
    assert.notEqual(missing.exitCode, 0);
    assert.match(JSON.parse(missing.stdout).expected, /physics-rapier3d\/pkg/);
    mkdirSync(join(root, 'packages/physics-rapier3d/pkg'), { recursive: true });
    writeFileSync(join(root, 'packages/physics-rapier3d/pkg/rapier.mjs'), 'WASM payload');
    const present = runVerifier(args);
    assert.equal(present.exitCode, 0, present.stdout || present.stderr);
    rmSync(join(root, 'packages/dsh/lib/client.js'));
    const missingClient = runVerifier(args);
    assert.notEqual(missingClient.exitCode, 0);
    assert.match(JSON.parse(missingClient.stdout).expected, /dsh\/lib\/client\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
