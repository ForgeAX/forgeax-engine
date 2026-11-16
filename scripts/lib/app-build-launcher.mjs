import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pnpmCommand } from './pnpm-command.mjs';
import { runnerResources, shaderProducerHeapSize } from './runner-resources.mjs';

const canonicalBuildScript = 'vite build';
const localProjectWorkers = JSON.stringify({ engine: false, render: false, kernels: false });
const canonicalProjectBuildScript = `FORGEAX_EXECUTION_WORKERS='${localProjectWorkers}' forgeax project build`;

function usesProjectBuild(app) {
  return app.manifest.scripts?.build === canonicalProjectBuildScript;
}
const budgetedBuildScript = 'node ../../../scripts/vite-app.mjs build';

export function validateCanonicalAppBuild(app) {
  const buildScript = app.manifest.scripts?.build;
  if (
    !usesProjectBuild(app) &&
    buildScript !== canonicalBuildScript &&
    buildScript !== budgetedBuildScript
  ) {
    throw new Error(
      `[build-apps] unsupported build script for ${app.manifest.name}: ` +
        `expected ${JSON.stringify(canonicalBuildScript)} or ${JSON.stringify(budgetedBuildScript)}, received ${JSON.stringify(buildScript)}`,
    );
  }
}

export function validateCanonicalAppBuilds(apps) {
  for (const app of apps) {
    if (!usesProjectBuild(app)) validateCanonicalAppBuild(app);
  }
}

export function resolveViteCli(repoRoot) {
  const requireFromRepo = createRequire(resolve(repoRoot, 'package.json'));
  const packageManifestPath = requireFromRepo.resolve('vite/package.json');
  return readJsonBin(packageManifestPath, 'vite');
}

function readJsonBin(packageManifestPath, binName) {
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
  const bin =
    typeof packageManifest.bin === 'string' ? packageManifest.bin : packageManifest.bin?.[binName];
  if (typeof bin !== 'string')
    throw new Error(`[build-apps] installed package has no ${binName} CLI: ${packageManifestPath}`);
  const cliPath = resolve(dirname(packageManifestPath), bin);
  if (!existsSync(cliPath)) throw new Error(`[build-apps] ${binName} CLI not found: ${cliPath}`);
  return cliPath;
}

export function createViteInvocation({
  app,
  viteCliPath,
  viteArgs,
  appFactsDir,
  baseEnv = process.env,
}) {
  const heapOption = `--max-old-space-size=${shaderProducerHeapSize(runnerResources())}`;
  return {
    command: process.execPath,
    args: [viteCliPath, ...viteArgs],
    options: {
      cwd: app.directory,
      stdio: 'inherit',
      shell: false,
      env: {
        ...baseEnv,
        NODE_OPTIONS: [baseEnv.NODE_OPTIONS, heapOption].filter(Boolean).join(' '),
        ...(appFactsDir === undefined ? {} : { FORGEAX_BUILD_METRICS_DIR: appFactsDir }),
      },
    },
  };
}

export function createViteBuildInvocation(options) {
  return createViteInvocation({ ...options, viteArgs: ['build'] });
}

export function createAppBuildInvocation(options) {
  const { app, appFactsDir, baseEnv = process.env } = options;
  if (!usesProjectBuild(app)) {
    validateCanonicalAppBuild(app);
    return createViteBuildInvocation(options);
  }
  const requireFromApp = createRequire(resolve(app.directory, 'package.json'));
  const engineManifestPath = requireFromApp.resolve('@forgeax/engine/package.json');
  const entry = readJsonBin(engineManifestPath, 'forgeax');
  return {
    command: process.execPath,
    args: [entry, 'project', 'build'],
    options: {
      cwd: app.directory,
      stdio: 'inherit',
      shell: false,
      env: {
        ...baseEnv,
        FORGEAX_EXECUTION_WORKERS: localProjectWorkers,
        ...(appFactsDir === undefined ? {} : { FORGEAX_BUILD_METRICS_DIR: appFactsDir }),
      },
    },
  };
}

export function createPrebuildInvocation({ app, baseEnv = process.env }) {
  if (app.manifest.scripts?.prebuild === undefined) return null;
  const [command, ...args] = pnpmCommand(baseEnv);
  return {
    command,
    args: [...args, 'run', 'prebuild'],
    options: {
      cwd: app.directory,
      stdio: 'inherit',
      shell: false,
      env: baseEnv,
    },
  };
}
