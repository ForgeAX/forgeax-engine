#!/usr/bin/env node
// Transport is optional. The source checkout and existing build commands own inputs.
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProvenance } from '../../packages/wgpu-wasm/scripts/provenance.mjs';
import { appPackages } from '../build-task-cache.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function prepareInputs({
  restore,
  rebuild,
  verify,
  publish,
  recover = async () => {},
  restoreOnly = false,
  now = Date.now,
}) {
  const start = now();
  let source = 'build';
  try {
    if (await restore()) {
      await verify('restore');
      await publish();
      source = 'artifact';
    }
  } catch (error) {
    if (error.cancelled) throw error;
    console.warn(`[ci-inputs] acceleration unavailable: ${error.message}; rebuilding from source`);
  }
  const restoreMs = now() - start;
  if (source === 'build') {
    await recover();
    if (!restoreOnly) {
      await rebuild();
      await verify('build');
    }
  }
  const receipt = {
    source: source === 'build' && restoreOnly ? 'pending' : source,
    restoreMs: restoreOnly ? now() - start : restoreMs,
    buildMs: source === 'build' && !restoreOnly ? now() - start - restoreMs : 0,
  };
  console.log(`[ci-inputs] ${JSON.stringify(receipt)}`);
  return receipt;
}

// The artifact contract owns source-recovery scope as well as transfer scope.
// Explicit app roots prevent one missing archive from rebuilding every demo.
export function sourceAppBuilds(root, consumer) {
  const roots = consumer.sourceAppRoots;
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    roots.some(
      (value) =>
        typeof value !== 'string' ||
        !value.startsWith('apps/') ||
        value.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  )
    throw new Error('app artifact consumer requires valid sourceAppRoots');
  const apps = appPackages(root).map((app) => app.relativeDirectory.replaceAll('\\', '/'));
  const matches = (app, prefix) => app === prefix || app.startsWith(`${prefix}/`);
  for (const prefix of roots) {
    if (!apps.some((app) => matches(app, prefix)))
      throw new Error(`source app root has no buildable apps: ${prefix}`);
  }
  return { roots, apps: apps.filter((app) => roots.some((prefix) => matches(app, prefix))) };
}

export async function main(
  argv = process.argv.slice(2),
  { root = ROOT, runCommand = runBrowserCommand } = {},
) {
  const options = {};
  const allowed = new Set([
    '--consumer',
    '--artifact-ids',
    '--core-artifact-ids',
    '--shared-artifact-id',
    '--input-fingerprint',
    '--mode',
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || argv[i + 1] === undefined)
      throw new Error(`invalid option: ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const mode = options.mode ?? 'auto';
  if (!['auto', 'restore', 'build'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
  const contract = JSON.parse(readFileSync(join(root, 'scripts/ci/build-artifact-contract.json')));
  const consumer = options.consumer;
  const classes = contract.consumers[consumer]?.requiredArtifactClasses;
  if (!classes) throw new Error(`unknown CI input consumer: ${consumer}`);
  const needsApps = classes.some((name) => name.startsWith('app-dist-'));
  const needsShared = needsApps || classes.some((name) => name.startsWith('shared-'));
  const sourceApps =
    needsApps || contract.consumers[consumer].sourceAppRoots
      ? sourceAppBuilds(root, contract.consumers[consumer])
      : undefined;
  const stage = mkdtempSync(join(tmpdir(), 'forgeax-ci-inputs-'));
  const invoke = async (args, { timeoutMs = 20 * 60_000, env = process.env } = {}) => {
    const result = await runCommand([process.execPath, ...args], {
      cwd: root,
      env,
      timeoutMs,
      label: `ci-inputs consumer=${consumer} command=${args[0]}`,
    });
    if (result.status !== 0) {
      const error = new Error(`CI input preparation failed: ${result.failure}`);
      error.cancelled = result.cancelled || [130, 143].includes(result.status);
      throw error;
    }
  };
  const shared = 'shared-app-inputs';
  let coreRestored = false;
  let sharedRestored = false;
  let sharedRetained = false;
  const publishOutputs = (families) => {
    // Only generated output roots cross the staging boundary; never overlay source.
    const copyOutputs = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name);
        if (
          entry.name === 'dist' ||
          entry.name === 'pkg' ||
          path === join(stage, 'packages/dsh/lib') ||
          path === join(stage, 'packages/preview/assets/canonical-kit')
        ) {
          const destination = join(root, path.slice(stage.length + 1));
          rmSync(destination, { recursive: true, force: true });
          cpSync(path, destination, { recursive: true });
        } else copyOutputs(path);
      }
    };
    for (const family of families)
      if (existsSync(join(stage, family))) copyOutputs(join(stage, family));
  };
  const readSharedInput = async (inputRoot, restored) => {
    const manifest = JSON.parse(readFileSync(join(inputRoot, shared, 'manifest.json')));
    if (restored && manifest.inputFingerprint !== options['input-fingerprint'])
      throw new Error(
        `shared input fingerprint mismatch: consumer=${consumer} expected=${options['input-fingerprint']} observed=${manifest.inputFingerprint}`,
      );
    const compiler = join(inputRoot, shared, 'compiler');
    if (existsSync(compiler)) await verifyProvenance({ pkgDirectory: compiler });
    return manifest;
  };
  const publishSharedInput = () => {
    const compiler = join(stage, shared, 'compiler');
    if (existsSync(compiler)) {
      const destination = join(root, 'packages/wgpu-wasm/pkg');
      rmSync(destination, { recursive: true, force: true });
      cpSync(compiler, destination, { recursive: true });
    }
    rmSync(join(root, shared), { recursive: true, force: true });
    cpSync(join(stage, shared), join(root, shared), { recursive: true });
  };
  try {
    if (existsSync(join(root, '.gitmodules'))) {
      // Persistent Runners may retain existing source at an older gitlink.
      // Synchronize both public owners before comparing artifact provenance.
      await invoke(['scripts/ci/prepare-source-checkout.mjs']);
    }
    return await prepareInputs({
      restoreOnly: mode === 'restore',
      restore: async () => {
        if (mode === 'build') return false;
        if (!options['artifact-ids'] || (needsShared && !options['shared-artifact-id'])) {
          console.warn(
            `[ci-inputs] consumer=${consumer} acceleration unavailable: ${
              !options['artifact-ids'] ? 'missing build artifact IDs' : 'missing shared artifact ID'
            }; rebuilding from source`,
          );
        }
        if (!options['artifact-ids'] && !(needsShared && options['shared-artifact-id']))
          return false;
        if (!/^[0-9a-f]{40}$/.test(process.env.EXPECTED_PRODUCT_SHA ?? ''))
          throw new Error('exact product SHA is required before using acceleration');
        const env = {
          ...process.env,
          FORGEAX_ARTIFACT_EXPECTED_SHA: process.env.EXPECTED_PRODUCT_SHA,
        };
        // Independent archives use disjoint staging paths. Start both within
        // the upstream 120-second bound: serial transfer consumed the shared
        // archive's budget and forced a full app rebuild in run 37078788317.
        const deadline = Date.now() + 120_000;
        const transfers = await Promise.allSettled(
          [
            ...(options['artifact-ids'] ? [[options['artifact-ids'], stage]] : []),
            ...(needsShared && options['shared-artifact-id']
              ? [[options['shared-artifact-id'], join(stage, 'shared-app-inputs-transfer')]]
              : []),
          ].map(async ([ids, path]) => {
            const timeoutMs = deadline - Date.now();
            if (timeoutMs <= 0) throw new Error('artifact acceleration budget exhausted');
            await invoke(
              [
                'scripts/ci/download-artifact-with-retry.mjs',
                '--artifact-ids',
                ids,
                '--path',
                path,
              ],
              { timeoutMs, env },
            );
            if (path === stage) coreRestored = true;
            else {
              await invoke(['scripts/ci/unpack-shared-app-inputs.mjs', '--root', stage]);
              sharedRestored = true;
            }
          }),
        );
        // Drain every writer before verification, recovery or stage deletion.
        // Cancellation takes precedence over an acceleration miss.
        const failure =
          transfers.find((result) => result.status === 'rejected' && result.reason.cancelled) ??
          transfers.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
        return coreRestored && (!needsShared || sharedRestored);
      },
      verify: async (source) => {
        const inputRoot = source === 'restore' ? stage : root;
        const manifest = needsShared
          ? await readSharedInput(inputRoot, source === 'restore')
          : null;
        await invoke([
          'scripts/ci/verify-build-artifact-input.mjs',
          '--consumer',
          consumer,
          '--root',
          inputRoot,
          ...(manifest ? ['--input-fingerprint', manifest.inputFingerprint] : []),
        ]);
      },
      publish: async () => {
        publishOutputs(['packages', ...(needsApps ? ['apps'] : [])]);
        if (needsShared) publishSharedInput();
      },
      recover: async () => {
        if (mode === 'build' && needsShared && existsSync(join(root, shared, 'manifest.json'))) {
          try {
            const manifest = await readSharedInput(root, true);
            await invoke([
              'scripts/ci/verify-build-artifact-input.mjs',
              '--consumer',
              consumer,
              '--root',
              root,
              '--input-fingerprint',
              manifest.inputFingerprint,
              '--transfer-artifact',
              'shared-app-inputs',
            ]);
            sharedRetained = true;
          } catch (error) {
            if (error.cancelled) throw error;
            console.warn(`[ci-inputs] retained shared input unavailable: ${error.message}`);
          }
        }
        if (coreRestored) {
          // A shared transfer failure does not invalidate the independently
          // SHA/digest-admitted core archive. Verify its own declared classes
          // before retaining native bytes for the normal source rebuild.
          try {
            await invoke([
              'scripts/ci/verify-build-artifact-input.mjs',
              '--consumer',
              consumer,
              '--root',
              stage,
              '--transfer-artifact',
              'core-build',
            ]);
            publishOutputs(['packages']);
          } catch (error) {
            if (error.cancelled) throw error;
            console.warn(`[ci-inputs] core recovery unavailable: ${error.message}`);
          }
        }
        if (sharedRestored) {
          try {
            const manifest = await readSharedInput(stage, true);
            await invoke([
              'scripts/ci/verify-build-artifact-input.mjs',
              '--consumer',
              consumer,
              '--root',
              stage,
              '--input-fingerprint',
              manifest.inputFingerprint,
              '--transfer-artifact',
              'shared-app-inputs',
            ]);
            publishSharedInput();
            sharedRetained = true;
          } catch (error) {
            if (error.cancelled) throw error;
            console.warn(`[ci-inputs] shared recovery unavailable: ${error.message}`);
          }
        }
        rmSync(stage, { recursive: true, force: true });
      },
      rebuild: async () => {
        if (needsApps) {
          // A failed app transfer must not discard the independently usable
          // core/shared inputs. Apply their existing verification before reuse.
          await main(
            [
              '--consumer',
              'app-shard',
              '--artifact-ids',
              options['core-artifact-ids'] ?? '',
              '--shared-artifact-id',
              options['shared-artifact-id'] ?? '',
              '--input-fingerprint',
              options['input-fingerprint'] ?? '',
              '--mode',
              mode,
            ],
            { root, runCommand },
          );
          const family = contract.shardFamilies.find((entry) => entry.id === 'app-dist');
          for (const [index, className] of family.members.entries()) {
            if (!classes.includes(className)) continue;
            const output = mkdtempSync(join(tmpdir(), 'forgeax-ci-app-shard-'));
            try {
              await invoke([
                'scripts/ci/build-app-shard.mjs',
                '--root',
                root,
                '--shard-count',
                String(family.members.length),
                '--shard-index',
                String(index),
                '--output-dir',
                output,
                '--shared-input-manifest',
                `${shared}/manifest.json`,
                // This heavy app is built by its owning smoke, as in the producers.
                '--omit-transfer-app',
                'learn-render/3.model-loading/1.model-loading',
                '--skip-build-app',
                'learn-render/3.model-loading/1.model-loading',
                ...sourceApps.apps.flatMap((app) => ['--app', app.slice('apps/'.length)]),
                '--retain-artifact-only',
              ]);
            } finally {
              rmSync(output, { recursive: true, force: true });
            }
          }
          // Match restored artifact layout. The next workflow step expands
          // only this consumer's app roots, not every demo in the repository.
          return;
        } else {
          for (const owner of ['wgpu-wasm', 'fbx', 'codec', 'ui-blitz'])
            await invoke([`packages/${owner}/scripts/ensure-wasm.mjs`]);
          await invoke(['scripts/build.mjs', '--packages-only']);
          if (!needsShared) return;
          if (!sharedRetained)
            await invoke([
              'scripts/ci/build-shared-app-inputs.mjs',
              '--root',
              root,
              '--out',
              shared,
              '--catalog-only',
            ]);
          // App producers build their own shader manifests from the catalog.
          if (consumer === 'app-shard') return;
        }
        await invoke([
          'scripts/ci/materialize-app-shader-manifests.mjs',
          '--root',
          root,
          '--shared-input-manifest',
          `${shared}/manifest.json`,
          ...(sourceApps?.roots ?? []).flatMap((app) => ['--app-root', app]),
        ]);
      },
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((receipt) => {
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `needs-build=${receipt.source === 'pending'}\n`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = error.cancelled ? 130 : 1;
    });
}
