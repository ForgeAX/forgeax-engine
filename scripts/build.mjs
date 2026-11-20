#!/usr/bin/env node
// Full repository build graph. Package JavaScript, shared engine inputs, app
// projections, and TypeScript declarations are separate observable stages.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCanonicalKit,
  publishCanonicalKit,
} from '../packages/preview/scripts/build-canonical-kit.mjs';
import { readPnpmVersion } from './forgeax/pnpm-version.mjs';
import { sdkCoreBuildRoot, seedSdkDeclarations } from './forgeax/sdk-shader-inputs.mjs';
import { runnerResources, shaderProducerHeapSize } from './lib/runner-resources.mjs';

const root = resolve('.');
const requestedModes = [
  process.argv.includes('--engine') ? 'engine' : null,
  process.argv.includes('--packages-only') ? 'packages-only' : null,
].filter(Boolean);
if (requestedModes.length > 1)
  throw new Error(`build modes are mutually exclusive: ${requestedModes.join(', ')}`);
const mode = requestedModes[0] ?? 'full';
const packageTargets = process.argv.slice(2).filter((argument) => argument.startsWith('--target='));
if (packageTargets.length > 0 && mode !== 'packages-only')
  throw new Error(
    'package targets require --packages-only; Engine and full builds remain complete',
  );
const clean = process.argv.includes('--clean');
const assetsSourceOption = process.argv.indexOf('--assets-source-root');
const assetsSourceRoot = assetsSourceOption === -1 ? null : process.argv[assetsSourceOption + 1];
if (assetsSourceOption !== -1 && (!assetsSourceRoot || assetsSourceRoot.startsWith('--')))
  throw new Error('--assets-source-root requires an assets export directory');
if (process.argv.includes('--compiled-shaders'))
  throw new Error(
    'Use node scripts/forgeax/prepare-shader-release-inputs.mjs --build for an explicit compiled publication',
  );
// A missing required source submodule otherwise surfaces as module-resolution noise
// deep inside the package stage.
if (!existsSync(join(root, 'packages/modeling/package.json'))) {
  console.error(
    '[build] build-source-module-missing: modeling submodule missing: run bun fx setup ' +
      '(or git submodule update --init packages/modeling)',
  );
  process.exit(1);
}
const summaryPath = join(root, 'node_modules/.cache/forgeax-build/summary.json');
const packageFactsPath = join(root, 'node_modules/.cache/forgeax-build/package-facts.json');
// Preview stages the selected environment and its generated receipt together.
// The package receives that complete publication even after a package cache hit.
const canonicalKitOutput =
  process.env.FORGEAX_CANONICAL_KIT_OUTPUT ??
  resolve(root, 'node_modules/.cache/forgeax-build/canonical-kit');
const canonicalKitPackageRoot = resolve(root, 'packages/preview/assets/canonical-kit');
mkdirSync(resolve(summaryPath, '..'), { recursive: true });

const summary = {
  schemaVersion: 2,
  command: clean
    ? 'pnpm build:clean'
    : mode === 'engine'
      ? 'pnpm build:engine'
      : mode === 'packages-only'
        ? 'pnpm build:packages'
        : 'pnpm build',
  engineShaderCompileCount: 0,
  appShaderCompileCount: 0,
  assetCookHitCount: 0,
  assetCookMissCount: 0,
  assetCookWriteFailureCount: 0,
  stageDurationMs: {},
};

function persist() {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function runStage(name, command, args, env = process.env) {
  const startedAt = performance.now();
  return new Promise((resolveStage) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      env,
    });
    child.once('error', (error) => {
      console.error(`[build] ${name} failed to start: ${error.message}`);
      process.exit(1);
    });
    child.once('close', (status) => {
      summary.stageDurationMs[name] = Number((performance.now() - startedAt).toFixed(1));
      if (name === 'apps' && existsSync(summaryPath)) {
        Object.assign(summary, JSON.parse(readFileSync(summaryPath, 'utf8')));
        summary.stageDurationMs[name] = Number((performance.now() - startedAt).toFixed(1));
      }
      persist();
      if (status !== 0) process.exit(status ?? 1);
      resolveStage();
    });
  });
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function ensureCanonicalKitStage() {
  // The compact generated environment is source-owned. Refresh it even when
  // package JavaScript is a cache hit so old library HDR bytes cannot survive.
  await buildCanonicalKit({ outputRoot: canonicalKitOutput });
}

// Record the source identity before build stages so provenance describes the
// checkout that produced the package outputs.
const sourceHead = commandOutput('git', ['rev-parse', 'HEAD']);
const sourceStatus = commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=no']);
const sourceSnapshot = {
  head: sourceHead,
  trackedClean: sourceStatus === null ? null : sourceStatus === '',
};

async function writeEngineBuildProvenance() {
  const devkitEntry = resolve(root, 'packages/devkit/dist/index.mjs');
  if (!existsSync(devkitEntry))
    throw new Error('engine provenance requires the built DevKit entry');
  const { inspectEngineWorkspace } = await import(pathToFileURL(devkitEntry).href);
  const workspace = await inspectEngineWorkspace(root);
  if (!workspace.ok)
    throw new Error(
      `engine provenance workspace inspection failed: ${JSON.stringify(workspace.error)}`,
    );
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'));
  const pnpmVersion = readPnpmVersion(packageJson.packageManager, { cwd: root });
  const provenance = {
    schemaVersion: 1,
    producer: 'scripts/build.mjs',
    command: summary.command,
    source: {
      head: sourceSnapshot.head,
      trackedClean: sourceSnapshot.trackedClean,
    },
    toolchain: {
      node: process.version,
      pnpm: pnpmVersion,
      packageManager: packageJson.packageManager ?? null,
      lockfileDigest: `sha256:${createHash('sha256').update(lockfile).digest('hex')}`,
    },
    workspace: {
      digest: workspace.value.digest,
      packageCount: workspace.value.packageCount,
      builtPackages: workspace.value.builtPackages,
      packages: workspace.value.packages.map((item) => ({
        name: item.name,
        version: item.version,
        entryDigest: item.entryDigest,
        manifestDigest: item.manifestDigest,
        runtimeDigest: item.runtimeDigest,
        runtimeFiles: item.runtimeFiles,
      })),
    },
  };
  writeFileSync(
    resolve(root, 'node_modules/.cache/forgeax-build/engine-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}

persist();
if (clean) await runStage('clean', process.execPath, ['scripts/clean-build-outputs.mjs']);

const coreBuildInput = process.env.FORGEAX_SDK_CORE_INPUT;
const reuseSdkBuild = process.argv.includes('--reuse-core-build');
if (reuseSdkBuild && (mode !== 'engine' || !coreBuildInput))
  throw new Error('--reuse-core-build requires the admitted PR Core archive and the Engine build');
const sdkCore = reuseSdkBuild ? sdkCoreBuildRoot(root, coreBuildInput) : null;
await runStage(
  'packages',
  process.execPath,
  [
    'scripts/build-packages.mjs',
    ...packageTargets,
    ...(assetsSourceRoot === null ? [] : ['--assets-source-root', resolve(assetsSourceRoot)]),
  ],
  {
    ...process.env,
    FORGEAX_REPO_ROOT: root,
    FORGEAX_PACKAGE_FACTS_PATH: packageFactsPath,
    FORGEAX_CANONICAL_KIT_OUTPUT: canonicalKitOutput,
    ...(sdkCore === null
      ? {}
      : { FORGEAX_THREE_PROGRAM_INPUT: join(sdkCore, 'packages/three/dist') }),
  },
);
await ensureCanonicalKitStage();
await publishCanonicalKit(canonicalKitOutput, canonicalKitPackageRoot);
await runStage('package-runtime-dependencies', process.execPath, [
  'scripts/forgeax/check-package-runtime-dependencies.mjs',
]);

async function buildTypes() {
  await runStage('types-preflight', process.execPath, ['scripts/typecheck-output-preflight.mjs'], {
    ...process.env,
    FORGEAX_REPO_ROOT: root,
  });
  await runStage('types', process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '-b',
  ]);
}

// The Engine build can start declarations immediately. The full build shares
// its summary with the app child and records declarations after app output.
if (sdkCore !== null) seedSdkDeclarations(root, sdkCore);
const engineTypes = mode === 'engine' ? buildTypes() : null;

let sharedManifest;
if (mode === 'full') {
  await runStage('producer', process.execPath, [
    `--max-old-space-size=${shaderProducerHeapSize(runnerResources())}`,
    'scripts/build-shared-inputs.mjs',
    '--root',
    root,
  ]);

  sharedManifest = resolve(root, 'shared-build-inputs/manifest.json');
  const producerFactsPath = resolve(root, 'shared-build-inputs/production-facts.json');
  if (!existsSync(sharedManifest) || !existsSync(producerFactsPath))
    throw new Error('shared producer completed without its manifest and facts');
  const producerFacts = JSON.parse(readFileSync(producerFactsPath, 'utf8'));
  summary.engineShaderCompileCount = producerFacts.engineShaderCompileCount ?? 0;
}

if (mode === 'full') {
  await runStage(
    'apps',
    process.execPath,
    ['scripts/build-apps.mjs', '--shared-input-manifest', sharedManifest],
    {
      ...process.env,
      FORGEAX_REPO_ROOT: root,
      FORGEAX_BUILD_PACKAGES_READY: '1',
      FORGEAX_BUILD_SUMMARY_PATH: summaryPath,
    },
  );
  if (existsSync(summaryPath))
    Object.assign(summary, JSON.parse(readFileSync(summaryPath, 'utf8')));
}

await (engineTypes ?? buildTypes());
await writeEngineBuildProvenance();
persist();
console.log(`[build] summary ${summaryPath}`);
