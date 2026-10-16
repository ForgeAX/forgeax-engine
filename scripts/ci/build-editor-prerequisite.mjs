#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CONTRACT_PATH = resolve(
  ENGINE_ROOT,
  'scripts/ci/editor-prerequisite-build.contract.json',
);
export const MANIFEST_NAME = 'engine-prerequisite-build-manifest.json';

class BuildFailure extends Error {
  constructor(code, details = {}) {
    super(details.hint ?? code);
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function commandText(command, args) {
  return [command, ...args].join(' ');
}

function run(command, args, { code, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ENGINE_ROOT,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env,
  });
  if (result.error || result.status !== 0) {
    throw new BuildFailure(code, {
      expected: `${commandText(command, args)} exits 0`,
      observed: result.error?.message ?? `exit ${result.status ?? 'unknown'}`,
      hint: `Fix the Engine-owned source-build prerequisite and retry: ${commandText(command, args)}`,
    });
  }
  return capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd() : '';
}

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateContract(contract = loadContract()) {
  const failures = new Set(contract.failureCodes ?? []);
  const requiredCodes = [
    'engine-source-only-required',
    'engine-source-checkout-unavailable',
    'engine-source-sha-mismatch',
    'engine-source-dirty',
    'engine-recursive-pin-unavailable',
    'engine-payload-class-unsupported',
    'engine-output-path-not-empty',
    'engine-toolchain-contract-mismatch',
    'engine-frozen-install-failed',
    'engine-source-build-failed',
    'engine-output-incomplete',
  ];
  const missingFiles = [
    ...contract.recipeInputs,
    contract.toolchainInputs.node,
    contract.toolchainInputs.pnpm,
    contract.toolchainInputs.rust,
    contract.toolchainInputs.emscripten,
    contract.toolchainInputs.ufbx,
    contract.toolchainInputs.basis,
    'pnpm-lock.yaml',
  ].filter((path) => !existsSync(resolve(ENGINE_ROOT, path)));
  const missingCodes = requiredCodes.filter((code) => !failures.has(code));
  if (
    contract.sourceOnly !== true ||
    contract.packageBuild?.entrypoint !== 'scripts/build.mjs' ||
    missingFiles.length > 0 ||
    missingCodes.length > 0
  ) {
    throw new BuildFailure('engine-source-build-failed', {
      expected: 'a complete source-only Engine prerequisite contract',
      observed: { sourceOnly: contract.sourceOnly, missingFiles, missingCodes },
      hint: 'Keep the canonical CLI, recipe inputs, and closed failure union in one Engine-owned contract.',
    });
  }
  return {
    schemaVersion: contract.schemaVersion,
    sourceOnly: true,
    payloadClasses: Object.keys(contract.payloadClasses),
    recipeDigest: recipeDigest(contract).digest,
  };
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-only') {
      values.sourceOnly = true;
      continue;
    }
    if (!['--engine-sha', '--payload-classes', '--output'].includes(arg)) {
      throw new BuildFailure('engine-source-only-required', {
        expected: '--source-only --engine-sha {sha} --payload-classes {classes} --output {path}',
        observed: arg,
        hint: 'Use the canonical source-only Editor prerequisite interface.',
      });
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new BuildFailure('engine-source-only-required', {
        expected: `a value after ${arg}`,
        observed: value ?? 'missing',
        hint: 'Provide every required canonical source-build argument.',
      });
    }
    values[arg.slice(2).replaceAll('-', '_')] = value;
    index += 1;
  }
  if (!values.sourceOnly || !values.engine_sha || !values.payload_classes || !values.output) {
    throw new BuildFailure('engine-source-only-required', {
      expected: '--source-only --engine-sha {sha} --payload-classes {classes} --output {path}',
      observed: values,
      hint: 'Editor CI must explicitly select the source-only contract and all exact inputs.',
    });
  }
  if (!/^[0-9a-f]{40}$/.test(values.engine_sha)) {
    throw new BuildFailure('engine-source-sha-mismatch', {
      expected: 'a lowercase 40-character Engine commit SHA',
      observed: values.engine_sha,
      hint: 'Pass the exact packages/engine gitlink SHA.',
    });
  }
  return {
    sourceOnly: true,
    engineSha: values.engine_sha,
    payloadClasses: [...new Set(values.payload_classes.split(',').map((value) => value.trim()))]
      .filter(Boolean)
      .sort(),
    output: resolve(values.output),
  };
}

function git(args, code = 'engine-source-checkout-unavailable') {
  return run('git', args, { code, capture: true });
}

export function deriveCheckoutIdentity(expectedSha) {
  const engineSha = git(['rev-parse', 'HEAD']).trim();
  if (engineSha !== expectedSha) {
    throw new BuildFailure('engine-source-sha-mismatch', {
      expected: expectedSha,
      observed: engineSha,
      hint: 'Checkout the exact Editor packages/engine gitlink; never substitute a nearby Engine SHA.',
    });
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new BuildFailure('engine-source-dirty', {
      expected: 'no tracked Engine source changes',
      observed: dirty.split('\n'),
      hint: 'Build from an exact clean Engine commit so provenance remains reproducible.',
    });
  }
  const rawPins = git(['submodule', 'status', '--recursive'], 'engine-recursive-pin-unavailable');
  const recursivePins = rawPins
    ? rawPins.split('\n').map((line) => {
        const match = /^(.)([0-9a-f]{40})\s+([^\s]+)/.exec(line);
        if (!match || match[1] !== ' ') {
          throw new BuildFailure('engine-recursive-pin-unavailable', {
            expected: 'every recursive Engine submodule initialized at its indexed commit',
            observed: line,
            hint: 'Run git submodule update --init --recursive with read-only credentials.',
          });
        }
        return { path: match[3], pin: match[2] };
      })
    : [];
  return { engineSha, recursivePins };
}

function expectedRustVersion() {
  const text = readFileSync(resolve(ENGINE_ROOT, 'packages/wgpu-wasm/rust-toolchain.toml'), 'utf8');
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  return channel;
}

function exactVersion(
  label,
  command,
  args,
  expected,
  pattern,
  matchesExpected = (actual) => actual === expected,
) {
  let observed;
  try {
    observed = run(command, args, { code: 'engine-toolchain-contract-mismatch', capture: true });
  } catch (error) {
    if (error instanceof BuildFailure) throw error;
    throw new BuildFailure('engine-toolchain-contract-mismatch', {
      expected,
      observed: error.message,
    });
  }
  const match = pattern.exec(observed);
  if (!match || !matchesExpected(match[1])) {
    throw new BuildFailure('engine-toolchain-contract-mismatch', {
      expected: `${label} ${expected}`,
      observed,
      hint: `Provision the exact ${label} version declared by Engine source.`,
    });
  }
  return match[1];
}

export function inspectToolchain(contract, payloadClasses) {
  const nodeExpected = readFileSync(
    resolve(ENGINE_ROOT, contract.toolchainInputs.node),
    'utf8',
  ).trim();
  if (process.version.slice(1) !== nodeExpected) {
    throw new BuildFailure('engine-toolchain-contract-mismatch', {
      expected: `node ${nodeExpected}`,
      observed: process.version,
      hint: 'Use the Node version pinned by packages/engine/.nvmrc.',
    });
  }
  const pnpmExpected = readFileSync(
    resolve(ENGINE_ROOT, contract.toolchainInputs.pnpm),
    'utf8',
  ).trim();
  const toolchain = {
    node: nodeExpected,
    pnpm: exactVersion('pnpm', 'pnpm', ['--version'], pnpmExpected, /([0-9]+\.[0-9]+\.[0-9]+)/),
  };
  if (payloadClasses.includes('wgpu-wasm')) {
    const rustExpected = expectedRustVersion();
    toolchain.rust = exactVersion(
      'rustc',
      'rustc',
      ['--version'],
      rustExpected,
      /rustc\s+([0-9]+\.[0-9]+\.[0-9]+)/,
      (actual) => actual.split('.').slice(0, 2).join('.') === rustExpected,
    );
  }
  if (payloadClasses.includes('engine-dist')) {
    const rapier = JSON.parse(
      readFileSync(resolve(ENGINE_ROOT, 'packages/physics-rapier3d/scripts/source.json'), 'utf8'),
    );
    toolchain.rapierRust = exactVersion(
      'Rapier rustc',
      'rustc',
      [`+${rapier.rust}`, '--version'],
      rapier.rust,
      /rustc\s+([0-9]+\.[0-9]+\.[0-9]+)/,
    );
  }
  if (payloadClasses.includes('wgpu-wasm') || payloadClasses.includes('engine-dist')) {
    toolchain.wasmPack = exactVersion(
      'wasm-pack',
      'wasm-pack',
      ['--version'],
      contract.toolchainInputs.wasmPackVersion,
      /wasm-pack\s+([0-9]+\.[0-9]+\.[0-9]+)/,
    );
  }
  if (payloadClasses.includes('fbx-wasm') || payloadClasses.includes('wasm-codec')) {
    const emscriptenLock = JSON.parse(
      readFileSync(resolve(ENGINE_ROOT, contract.toolchainInputs.emscripten), 'utf8'),
    );
    toolchain.emscripten = exactVersion(
      'Emscripten',
      'emcc',
      ['--version'],
      emscriptenLock.emscriptenVersion,
      /(?:emcc.*?|emscripten.*?)([0-9]+\.[0-9]+\.[0-9]+)/i,
    );
  }
  return toolchain;
}

function ensureFreshOutput(path) {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new BuildFailure('engine-output-path-not-empty', {
      expected: 'a missing or empty output directory',
      observed: path,
      hint: 'Use a fresh run-scoped output directory; never merge two prerequisite builds.',
    });
  }
}

function packageDirectories() {
  const root = resolve(ENGINE_ROOT, 'packages');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'package.json')))
    .map((entry) => join(root, entry.name))
    .sort();
}

function cleanRequestedOutputs(payloadClasses) {
  if (payloadClasses.includes('engine-dist')) {
    for (const directory of packageDirectories())
      rmSync(join(directory, 'dist'), { recursive: true, force: true });
  }
  if (payloadClasses.includes('wgpu-wasm'))
    rmSync(resolve(ENGINE_ROOT, 'packages/wgpu-wasm/pkg'), { recursive: true, force: true });
  if (payloadClasses.includes('fbx-wasm'))
    rmSync(resolve(ENGINE_ROOT, 'packages/fbx/pkg'), { recursive: true, force: true });
  if (payloadClasses.includes('wasm-codec'))
    rmSync(resolve(ENGINE_ROOT, 'packages/codec/pkg'), { recursive: true, force: true });
}

function ensureTypeScriptShims() {
  const binRoot = resolve(ENGINE_ROOT, 'node_modules/.bin');
  mkdirSync(binRoot, { recursive: true });
  for (const name of ['tsc', 'tsserver']) {
    const target = resolve(ENGINE_ROOT, `node_modules/typescript/bin/${name}`);
    const link = resolve(binRoot, name);
    if (!existsSync(target)) {
      throw new BuildFailure('engine-frozen-install-failed', {
        expected: target,
        observed: 'missing after frozen install',
        hint: 'Repair the Engine lockfile or package-manager contract.',
      });
    }
    if (!existsSync(link))
      symlinkSync(target, link, process.platform === 'win32' ? 'file' : undefined);
  }
}

function runBuild(contract, payloadClasses) {
  const [installCommand, ...installArgs] = contract.install.command;
  const stageTimingsMs = { install: 0 };
  const installStartedAt = Date.now();
  run(installCommand, installArgs, { code: 'engine-frozen-install-failed' });
  ensureTypeScriptShims();
  stageTimingsMs.install = Date.now() - installStartedAt;
  cleanRequestedOutputs(payloadClasses);

  for (const payloadClass of ['wgpu-wasm', 'fbx-wasm', 'wasm-codec']) {
    if (!payloadClasses.includes(payloadClass)) continue;
    const startedAt = Date.now();
    const [command, ...args] = contract.payloadClasses[payloadClass].build;
    run(command, args, {
      code: 'engine-source-build-failed',
      env: {
        ...process.env,
        FORGEAX_WGPU_WASM_OPT_MODE: 'disabled',
      },
    });
    stageTimingsMs[payloadClass] = Date.now() - startedAt;
  }
  if (payloadClasses.includes('engine-dist')) {
    const startedAt = Date.now();
    const [command, ...args] = contract.packageBuild.command;
    run(command, args, {
      code: 'engine-source-build-failed',
      env: { ...process.env, FORGEAX_BUILD_NO_TASK_CACHE: '1' },
    });
    run(
      process.execPath,
      ['scripts/forgeax/prepare-shader-release-inputs.mjs', '--build', '--profile', 'base-ssao'],
      {
        code: 'engine-source-build-failed',
      },
    );
    stageTimingsMs['engine-dist'] = Date.now() - startedAt;
  }
  return stageTimingsMs;
}

const REQUIRED_PAYLOAD_FILES = {
  'wgpu-wasm': ['wgpu_wasm.js', 'wgpu_wasm_bg.wasm'],
  'fbx-wasm': ['fbx-wasm.mjs', 'fbx-wasm.wasm'],
  'wasm-codec': [
    'basis_transcoder.mjs',
    'basis_transcoder.wasm',
    'encode/basis_encoder.mjs',
    'encode/basis_encoder.wasm',
  ],
};

function assertPayloadComplete(source, payloadClass) {
  const required = REQUIRED_PAYLOAD_FILES[payloadClass] ?? [];
  const missing = required.filter((path) => !existsSync(join(source, path)));
  if (missing.length > 0) {
    throw new BuildFailure('engine-output-incomplete', {
      expected: `${payloadClass} required files: ${required.join(', ')}`,
      observed: missing,
      hint: 'Re-run the canonical source build and inspect the payload-specific output stage.',
    });
  }
}

function copyTree(source, target) {
  if (!existsSync(source)) {
    throw new BuildFailure('engine-output-incomplete', {
      expected: source,
      observed: 'missing',
      hint: 'Fix the Engine-owned build recipe; do not substitute another SHA or prebuilt release.',
    });
  }
  cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

function collectInventory(root, payloadClass = null) {
  const inventory = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        inventory.push({
          ...(payloadClass ? { payloadClass } : {}),
          path: relative(root, path).split('\\').join('/'),
          bytes: lstatSync(path).size,
          sha256: fileSha256(path),
        });
      } else {
        throw new BuildFailure('engine-output-incomplete', {
          expected: 'regular files only',
          observed: relative(root, path),
          hint: 'Remove symlink or special-file output from the prerequisite payload.',
        });
      }
    }
  }
  visit(root);
  return inventory;
}

export function stagePayloads(output, payloadClasses) {
  mkdirSync(resolve(output, 'payload'), { recursive: true });
  for (const payloadClass of payloadClasses) {
    const target = resolve(output, 'payload', payloadClass);
    if (payloadClass === 'engine-dist') {
      mkdirSync(target, { recursive: true });
      let count = 0;
      for (const directory of packageDirectories()) {
        const source = join(directory, 'dist');
        if (!existsSync(source)) continue;
        copyTree(source, resolve(target, basename(directory), 'dist'));
        count += 1;
      }
      copyTree(
        resolve(ENGINE_ROOT, 'packages/physics-rapier3d/pkg'),
        resolve(target, 'physics-rapier3d/pkg'),
      );
      if (count === 0) {
        throw new BuildFailure('engine-output-incomplete', {
          expected: 'at least one packages/*/dist directory',
          observed: 'none',
          hint: 'Run the canonical package build and inspect its first failing package.',
        });
      }
    } else if (payloadClass === 'wgpu-wasm') {
      const source = resolve(ENGINE_ROOT, 'packages/wgpu-wasm/pkg');
      assertPayloadComplete(source, payloadClass);
      copyTree(source, target);
    } else if (payloadClass === 'fbx-wasm') {
      const source = resolve(ENGINE_ROOT, 'packages/fbx/pkg');
      assertPayloadComplete(source, payloadClass);
      copyTree(source, target);
    } else if (payloadClass === 'wasm-codec') {
      const source = resolve(ENGINE_ROOT, 'packages/codec/pkg');
      assertPayloadComplete(source, payloadClass);
      copyTree(source, target);
    }
  }
  const inventory = [];
  for (const payloadClass of payloadClasses) {
    const classRoot = resolve(output, 'payload', payloadClass);
    const classInventory = collectInventory(classRoot, payloadClass).map((entry) => ({
      ...entry,
      path: `payload/${payloadClass}/${entry.path}`,
    }));
    inventory.push(...classInventory);
  }
  if (inventory.length === 0) {
    throw new BuildFailure('engine-output-incomplete', {
      expected: 'non-empty source-built payload inventory',
      observed: 0,
      hint: 'Fix the canonical Engine source build before publishing an Editor prerequisite.',
    });
  }
  const verifiedInventory = [];
  for (const payloadClass of payloadClasses) {
    const classRoot = resolve(output, 'payload', payloadClass);
    verifiedInventory.push(
      ...collectInventory(classRoot, payloadClass).map((entry) => ({
        ...entry,
        path: `payload/${payloadClass}/${entry.path}`,
      })),
    );
  }
  if (canonicalJson(inventory) !== canonicalJson(verifiedInventory)) {
    throw new BuildFailure('engine-output-incomplete', {
      expected: 'stable staged payload inventory after write',
      observed: 'inventory changed during verification',
      hint: 'Do not mutate staged payloads after the canonical source build completes.',
    });
  }
  return inventory;
}

function recipeDigest(contract) {
  const toolchainFiles = Object.values(contract.toolchainInputs).filter(
    (value) => typeof value === 'string' && existsSync(resolve(ENGINE_ROOT, value)),
  );
  const inputs = [...contract.recipeInputs, 'pnpm-lock.yaml', ...toolchainFiles];
  const records = [...new Set(inputs)]
    .sort()
    .map((path) => ({ path, sha256: fileSha256(resolve(ENGINE_ROOT, path)) }));
  return { digest: sha256(canonicalJson(records)), inputs: records };
}

export async function buildEditorPrerequisite(options) {
  const contract = loadContract();
  validateContract(contract);
  const unsupported = options.payloadClasses.filter((name) => !contract.payloadClasses[name]);
  if (unsupported.length > 0 || options.payloadClasses.length === 0) {
    throw new BuildFailure('engine-payload-class-unsupported', {
      expected: Object.keys(contract.payloadClasses),
      observed: unsupported.length > 0 ? unsupported : options.payloadClasses,
      hint: 'Request only payload classes declared by the exact Engine source contract.',
    });
  }
  ensureFreshOutput(options.output);
  const checkout = deriveCheckoutIdentity(options.engineSha);
  const toolchain = inspectToolchain(contract, options.payloadClasses);
  const recipe = recipeDigest(contract);
  const lockfileDigest = fileSha256(resolve(ENGINE_ROOT, 'pnpm-lock.yaml'));
  const input = {
    engineSha: checkout.engineSha,
    recursivePins: checkout.recursivePins,
    payloadClasses: options.payloadClasses,
    recipeDigest: recipe.digest,
    lockfileDigest,
    toolchain,
  };
  const startedAt = Date.now();
  const stageTimingsMs = runBuild(contract, options.payloadClasses);
  const stagingStartedAt = Date.now();
  const inventory = stagePayloads(options.output, options.payloadClasses);
  stageTimingsMs.staging = Date.now() - stagingStartedAt;
  const manifest = createBuildManifest({
    input,
    inventory,
    recipe,
    durationMs: Date.now() - startedAt,
    stageTimingsMs,
    environment: {
      os: process.env.RUNNER_OS?.toLowerCase() ?? process.platform,
      architecture: process.env.RUNNER_ARCH?.toLowerCase() ?? process.arch,
    },
  });
  writeFileSync(resolve(options.output, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function createBuildManifest({
  input,
  inventory,
  recipe,
  durationMs,
  stageTimingsMs = {},
  environment = {},
}) {
  return {
    schemaVersion: 'forgeax-engine-editor-prerequisite-build/v1',
    sourceOnly: true,
    status: 'success',
    productionMode: 'source-build',
    os: environment.os ?? process.platform,
    architecture: environment.architecture ?? process.arch,
    ...input,
    inputDigest: sha256(canonicalJson(input)),
    outputDigest: sha256(canonicalJson(inventory)),
    inventory,
    recipeInputs: recipe.inputs,
    stageTimingsMs,
    durationMs,
  };
}

function serializeFailure(error, contract) {
  const code = error instanceof BuildFailure ? error.code : 'engine-source-build-failed';
  const normalizedCode = contract.failureCodes.includes(code) ? code : 'engine-source-build-failed';
  return {
    schemaVersion: 'forgeax-engine-editor-prerequisite-build-failure/v1',
    status: 'failure',
    code: normalizedCode,
    expected: error.details?.expected ?? 'canonical Engine source build succeeds',
    observed: error.details?.observed ?? error.message,
    hint: error.details?.hint ?? 'Fix the Engine-owned source-build recipe or toolchain contract.',
  };
}

async function main() {
  const contract = loadContract();
  try {
    if (process.argv.length === 3 && process.argv[2] === '--contract-check') {
      process.stdout.write(
        `${JSON.stringify({ status: 'success', contract: validateContract(contract) })}\n`,
      );
      return;
    }
    const options = parseArgs(process.argv.slice(2));
    const manifest = await buildEditorPrerequisite(options);
    process.stdout.write(
      `${JSON.stringify({ status: 'success', manifest: resolve(options.output, MANIFEST_NAME), inputDigest: manifest.inputDigest, outputDigest: manifest.outputDigest })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(serializeFailure(error, contract))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
