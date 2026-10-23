import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodePackagedProfiles,
  PACKAGED_PROFILES_FILE,
  packagedProfilePublication,
} from '../../packages/vite-plugin-shader/dist/packaged-profiles.mjs';
import { engineShaderSourceDigest } from '../../packages/vite-plugin-shader/dist/source-digest.mjs';
import { sharedShaderInputFingerprint } from '../lib/shared-build-cache.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(resolve(process.cwd()), root, 'run from the Engine worktree root');
if (process.platform === 'win32') {
  assert.ok(
    root.includes(' ') && root.includes('%') && /[\u3400-\u9fff]/u.test(root),
    'run from a Windows Engine worktree path containing Chinese, spaces, and %',
  );
}

const sharedInputManifest = 'shared-build-inputs/manifest.json';
const sharedInputManifestPath = resolve(root, sharedInputManifest);
await access(sharedInputManifestPath);
const fixedManifestSha256 = createHash('sha256')
  .update(await readFile(sharedInputManifestPath))
  .digest('hex');
const commandArgs = [
  'scripts/forgeax/prepare-shader-release-inputs.mjs',
  '--build',
  '--shared-input-manifest',
  sharedInputManifest,
];
const result = spawnSync(process.execPath, commandArgs, {
  cwd: root,
  env: {
    ...process.env,
    FORGEAX_BUILD_NO_TASK_CACHE: '1',
    FORGEAX_PACKAGE_BUILD_CONCURRENCY: '2',
    FORGEAX_SHADER_COMPILE_WORKERS: '2',
  },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error !== undefined) throw result.error;
assert.equal(
  result.status,
  0,
  `shader release input script failed with exit ${result.status}:\n${result.stderr}\n${result.stdout}`,
);

const output = result.stdout ?? '';
const reportIndex = output.lastIndexOf('\n{\n  "outputRoot":');
assert.notEqual(reportIndex, -1, 'the real script must emit its final profile report');
const buildReport = JSON.parse(output.slice(reportIndex + 1).trim());
const profiles = ['base-ssao', 'point-ssao'];
const packageOutput = resolve(root, 'packages/vite-plugin-shader/dist/engine-inputs');
assert.equal(
  buildReport.outputRoot,
  packageOutput,
  'the real output must remain under the package dist',
);
assert.deepEqual(buildReport.profiles, profiles, 'both SDK shader profiles must be built');
assert.ok(buildReport.imports > 0, 'the real shader source catalog must be populated');

const allOutput = `${result.stdout}\n${result.stderr}`;
const noCacheRuns = allOutput.match(
  /\[shared-build\] shader reuse disabled by FORGEAX_BUILD_NO_TASK_CACHE/g,
);
assert.equal(
  noCacheRuns?.length ?? 0,
  profiles.length,
  'both compiler processes must bypass cache reuse',
);

const sourceRoot = resolve(root, 'packages/shader/src');
const expectedSourceDigest = engineShaderSourceDigest(sourceRoot);
assert.ok(expectedSourceDigest, 'the fixed Engine shader source set must be present');
const profileResults = [];
let sourceInputFingerprint;
for (const profile of profiles) {
  const pointShadows = profile === 'point-ssao';
  const expectedInputFingerprint = sharedShaderInputFingerprint(root, {
    pointShadows,
    hdrpSsao: true,
  });
  const releaseRoot = resolve(root, 'shared-build-inputs-release', profile);
  const releaseManifestPath = resolve(releaseRoot, 'manifest.json');
  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, 'utf8'));
  const productionFacts = JSON.parse(
    await readFile(resolve(releaseRoot, 'production-facts.json'), 'utf8'),
  );
  assert.equal(
    releaseManifest.shaderBuild.inputFingerprint,
    expectedInputFingerprint,
    `${profile} must retain its real profile flags in the compiled input identity`,
  );
  assert.match(productionFacts.inputFingerprint, /^sha256:[a-f0-9]{64}$/u);
  if (sourceInputFingerprint === undefined) {
    sourceInputFingerprint = productionFacts.inputFingerprint;
  } else {
    assert.equal(productionFacts.inputFingerprint, sourceInputFingerprint);
  }
  assert.equal(productionFacts.engineShaderCompileCount, 1, `${profile} must compile from source`);
  assert.equal(productionFacts.assetCookHitCount, 0);
  assert.equal(productionFacts.assetCookMissCount, 0);
  assert.equal(
    releaseManifest.payload.engineShaderManifest,
    `shared-build-inputs-release/${profile}/shaders/manifest.json`,
  );

  const releaseShaderManifest = resolve(releaseRoot, 'shaders/manifest.json');
  const container = decodePackagedProfiles(
    await readFile(resolve(packageOutput, PACKAGED_PROFILES_FILE)),
  );
  assert.ok(container, 'the packaged profile container must use the current format');
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const releaseHash = sha256(
    JSON.stringify(JSON.parse(await readFile(releaseShaderManifest, 'utf8'))),
  );
  const packagedHash = sha256(JSON.stringify(packagedProfilePublication(container, profile)));
  assert.equal(
    packagedHash,
    releaseHash,
    `${profile} must package the real compiler manifest publication`,
  );
  assert.equal(Object.keys(container.imports).length, buildReport.imports);
  assert.equal(container.shaderSourceDigest, expectedSourceDigest);
  profileResults.push({
    profile,
    pointShadows,
    compileCount: productionFacts.engineShaderCompileCount,
    inputFingerprint: expectedInputFingerprint,
    shaderManifestSha256: packagedHash,
  });
}

process.stdout.write(
  `${JSON.stringify({
    cwd: process.cwd(),
    commandArgs,
    exitCode: result.status,
    outputRoot: buildReport.outputRoot,
    profiles: profileResults,
    fixedManifestSha256: fixedManifestSha256,
    noTaskCache: true,
    packageBuildConcurrency: 2,
    shaderCompileWorkers: 2,
  })}\n`,
);
