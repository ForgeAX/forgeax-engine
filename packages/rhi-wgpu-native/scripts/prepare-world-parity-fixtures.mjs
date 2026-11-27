import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hashFiles, inventory, packageInputFiles, packageOutputDirectory,
  packageOutputFingerprint, workspaceDependencyNames, workspacePackages,
} from '../../../scripts/build-task-cache.mjs';
import { buildPackageSelection } from '../../../scripts/lib/build-package-selection.mjs';

const targets = ['@forgeax/engine-geometry', '@forgeax/engine-shader',
  '@forgeax/engine-assets-runtime'];
const fixture = 'packages/render/src/__tests__/raytracing/world-traversal-native.fixture.ts';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function worldParityPreparationPlan(root, directory) {
  assert(isAbsolute(root) && isAbsolute(directory), 'Use absolute owned paths');
  const inside = relative(resolve(root), resolve(directory));
  assert(inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside),
    'Native parity output belongs outside the source checkout');
  const inputs = join(directory, 'inputs.json');
  const payload = join(directory, 'payload.json');
  return {
    root: resolve(root), directory: resolve(directory), inputs, payload,
    commands: [
      [process.execPath, 'scripts/build-packages.mjs', ...targets.map((name) => `--target=${name}`)],
      ['cargo', 'test', '--locked', '--manifest-path', 'packages/rhi-wgpu-native/Cargo.toml',
        '--features', 'conformance,reference', '--lib',
        'world_traversal_parity::export_authored_world_parity_inputs_for_this_host',
        '--', '--exact', '--test-threads', '1'],
    ],
  };
}

function builderIdentity(root) {
  const packages = workspacePackages(root);
  const known = new Set(packages.map((entry) => entry.manifest.name));
  const dependencies = new Map(packages.map((entry) => [entry.manifest.name,
    workspaceDependencyNames(entry.manifest, known)]));
  return buildPackageSelection(packages, dependencies, targets.map((name) => `--target=${name}`))
    .map((entry) => {
      const output = inventory(packageOutputDirectory(entry));
      return {
        name: entry.manifest.name,
        inputFingerprint: hashFiles(root, packageInputFiles(root, entry.directory)),
        outputFingerprint: output === null ? null
          : packageOutputFingerprint(root, entry.directory, output),
      };
    });
}

function command(plan, args, env, rows) {
  const startedAt = new Date().toISOString();
  const child = spawnSync(args[0], args.slice(1), { cwd: plan.root, env, stdio: 'inherit' });
  rows.push({ command: args, cwd: plan.root, startedAt, finishedAt: new Date().toISOString(),
    exitCode: child.status, signal: child.signal, error: child.error?.message });
  writeFileSync(join(plan.directory, 'children.json'), JSON.stringify(rows, null, 2));
  assert.equal(child.status, 0, 'Native parity preparation child failed');
}

async function canonicalPayload(plan, input) {
  const { createServer } = await import('vite');
  const server = await createServer({ root: plan.root, configFile: false, logLevel: 'error',
    cacheDir: join(plan.directory, 'vite-cache'), appType: 'custom',
    server: { middlewareMode: true, watch: null }, optimizeDeps: { noDiscovery: true } });
  try {
    const loaded = await server.ssrLoadModule(`/${fixture}`);
    assert.equal(typeof loaded.prepareNativeWorldParity, 'function');
    return await loaded.prepareNativeWorldParity(input);
  } finally {
    await server.close();
  }
}

export async function prepareWorldParity(root, env = process.env) {
  const inputPath = env.FORGEAX_NATIVE_WORLD_PARITY_INPUTS;
  const payloadPath = env.FORGEAX_NATIVE_WORLD_PARITY_PAYLOAD;
  assert(inputPath && payloadPath, 'Provide both same-host Native parity paths');
  const directory = dirname(inputPath);
  assert.equal(realpathSync(dirname(directory)), resolve(dirname(directory)),
    'Use a canonical owned output parent, not a cross-worktree symlink');
  const plan = worldParityPreparationPlan(realpathSync(root), directory);
  assert.equal(resolve(inputPath), plan.inputs);
  assert.equal(resolve(payloadPath), plan.payload);
  mkdirSync(plan.directory); // A new attempt never adopts somebody else's output.
  const rows = [];
  for (const args of plan.commands) command(plan, args, env, rows);
  assert(statSync(plan.inputs).size <= 1024 * 1024, 'Bounded original Rust input');
  const input = readFileSync(plan.inputs);
  const payload = await canonicalPayload(plan, JSON.parse(input));
  const output = Buffer.from(JSON.stringify(payload));
  assert(output.byteLength <= 64 * 1024 * 1024, 'Bounded canonical fixture payload');
  writeFileSync(plan.payload, output, { flag: 'wx' });
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 << 20 });
    assert.equal(result.status, 0, 'Capture actual Native fixture source identity');
    return result.stdout;
  };
  const receipt = {
    sourceHead: git(['rev-parse', 'HEAD']).toString().trim(),
    sourceDiffSha256: sha(git(['diff', '--binary', 'HEAD'])),
    node: { version: process.version, executable: process.execPath },
    input: { path: plan.inputs, bytes: input.byteLength, sha256: sha(input) },
    payload: { path: plan.payload, bytes: output.byteLength, sha256: sha(output) },
    fixture: { path: fixture, sha256: sha(readFileSync(join(root, fixture))) },
    coordinatorSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    builders: builderIdentity(root), children: rows,
    sameHostPreparation: true, adapterCreated: false, gpuQualified: false,
    requiredEnv: { FORGEAX_NATIVE_WORLD_PARITY_INPUT_SHA256: sha(input),
      FORGEAX_NATIVE_WORLD_PARITY_PAYLOAD_SHA256: sha(output) },
  };
  writeFileSync(join(plan.directory, 'preparation.json'), JSON.stringify(receipt, null, 2));
  if (env.GITHUB_ENV) {
    appendFileSync(env.GITHUB_ENV, Object.entries(receipt.requiredEnv)
      .map(([name, value]) => `${name}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(receipt));
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareWorldParity(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
}
