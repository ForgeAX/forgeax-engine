#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cachePath,
  hashFiles,
  hashText,
  inventory,
  inventoryMatches,
  packageInputFiles,
  packageOutputDirectory,
  packageOutputFingerprint,
  readReceipt,
  workspaceDependencyNames,
  workspacePackages,
  writeReceipt,
} from './build-task-cache.mjs';
import { pnpmCommand } from './lib/pnpm-command.mjs';
import { runnerResources, workspaceConcurrency } from './lib/runner-resources.mjs';

const root = resolve(process.env.FORGEAX_REPO_ROOT ?? '.');
const packages = workspacePackages(root);
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const knownNames = new Set(packages.map((pkg) => pkg.manifest.name));
const dependencies = new Map(
  packages.map((pkg) => [
    pkg.manifest.name,
    workspaceDependencyNames(pkg.manifest, knownNames, [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]),
  ]),
);
const { cpus, memoryBytes } = runnerResources();
const concurrency = Number(
  process.env.FORGEAX_PACKAGE_BUILD_CONCURRENCY ??
    process.env.FORGEAX_BUILD_CONCURRENCY ??
    workspaceConcurrency({ cpus, memoryBytes, reserveGB: 2, workerGB: 2 }),
);
const noCache = process.env.FORGEAX_BUILD_NO_TASK_CACHE === '1';
const packageRunner = process.env.FORGEAX_PACKAGE_BUILD_RUNNER ?? 'pnpm';
if (packageRunner !== 'pnpm' && packageRunner !== 'bun')
  throw new Error(`unsupported package build runner: ${packageRunner}`);

function runPackage(pkg) {
  return new Promise((resolveRun) => {
    const startedAt = performance.now();
    const args =
      packageRunner === 'bun'
        ? ['run', '--filter', pkg.manifest.name, 'build']
        : ['--filter', pkg.manifest.name, 'run', 'build'];
    const [command, ...prefix] = packageRunner === 'pnpm' ? pnpmCommand() : [packageRunner];
    const child = spawn(command, [...prefix, ...args], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });
    child.once('error', (error) =>
      resolveRun({
        ok: false,
        error,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
      }),
    );
    child.once('exit', (code, signal) =>
      resolveRun({
        ok: code === 0,
        code,
        signal,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
      }),
    );
  });
}

function packagePlan(pkg, dependencyOutputFingerprints) {
  const sourceFingerprint = hashFiles(root, packageInputFiles(root, pkg.directory));
  const dependencyFingerprint = [...(dependencies.get(pkg.manifest.name) ?? [])]
    .sort()
    .map((name) => [name, dependencyOutputFingerprints.get(name) ?? 'unavailable']);
  return {
    inputFingerprint: hashText(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'package-build',
        name: pkg.manifest.name,
        packageRunner,
        sourceFingerprint,
        dependencyFingerprint,
      }),
    ),
    dependencyFingerprint,
  };
}

function isHit(pkg, plan) {
  if (noCache) return null;
  const receipt = readReceipt(root, 'receipts/packages', pkg.manifest.name);
  if (
    receipt?.schemaVersion === 1 &&
    receipt.inputFingerprint === plan.inputFingerprint &&
    inventoryMatches(packageOutputDirectory(pkg), receipt.outputInventory) &&
    receipt.outputFingerprint ===
      packageOutputFingerprint(root, pkg.directory, receipt.outputInventory)
  )
    return receipt;
  return null;
}

async function main() {
  const pending = new Set(packages.map((pkg) => pkg.manifest.name));
  const completed = new Set();
  const outputFingerprints = new Map();
  const results = [];
  const running = new Map();

  while (pending.size > 0 || running.size > 0) {
    let progressed = false;
    for (const name of [...pending]) {
      const deps = dependencies.get(name) ?? new Set();
      if (![...deps].every((dependency) => completed.has(dependency))) continue;
      const pkg = byName.get(name);
      if (pkg === undefined) continue;
      const plan = packagePlan(pkg, outputFingerprints);
      const receipt = isHit(pkg, plan);
      pending.delete(name);
      progressed = true;
      if (receipt !== null) {
        completed.add(name);
        outputFingerprints.set(name, receipt.outputFingerprint);
        results.push({
          name,
          status: 'skipped',
          durationMs: 0,
          outputBytes: receipt.outputInventory.totalBytes,
        });
        console.error(`[build-packages] cache hit ${name}`);
        continue;
      }
      if (running.size >= concurrency) {
        pending.add(name);
        continue;
      }
      const promise = runPackage(pkg).then((run) => ({ pkg, plan, run }));
      running.set(name, promise);
      console.error(`[build-packages] build ${name}`);
    }

    if (running.size === 0) {
      if (!progressed && pending.size > 0)
        throw new Error(
          `package build dependency cycle or unresolved dependency: ${[...pending].join(', ')}`,
        );
      continue;
    }

    const finished = await Promise.race(
      [...running.entries()].map(async ([name, promise]) => ({ name, result: await promise })),
    );
    running.delete(finished.name);
    const { pkg, plan, run } = finished.result;
    if (!run.ok) {
      console.error(`[build-packages] failed ${pkg.manifest.name}`);
      process.exitCode = run.code ?? 1;
      return;
    }
    const output = inventory(packageOutputDirectory(pkg));
    if (output === null || output.fileCount === 0)
      throw new Error(`package build produced no dist output: ${pkg.manifest.name}`);
    const outputFp = packageOutputFingerprint(root, pkg.directory, output);
    outputFingerprints.set(pkg.manifest.name, outputFp);
    writeReceipt(root, 'receipts/packages', pkg.manifest.name, {
      schemaVersion: 1,
      kind: 'package-build',
      producer: 'scripts/build-packages.mjs',
      name: pkg.manifest.name,
      inputFingerprint: plan.inputFingerprint,
      dependencyFingerprint: plan.dependencyFingerprint,
      outputFingerprint: outputFp,
      outputInventory: output,
    });
    results.push({
      name: pkg.manifest.name,
      status: 'built',
      durationMs: run.durationMs,
      outputBytes: output.totalBytes,
    });
    completed.add(pkg.manifest.name);
  }

  const facts = {
    schemaVersion: 1,
    packages: {
      requested: packages.length,
      built: results.filter((result) => result.status === 'built').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      runner: packageRunner,
      concurrency,
      durationMs: Number(
        results.reduce((total, result) => total + result.durationMs, 0).toFixed(1),
      ),
      results: results.sort((a, b) => a.name.localeCompare(b.name)),
    },
    cachePath: cachePath(root, 'receipts/packages', 'example').replace(
      /example\.json$/,
      '<package>.json',
    ),
  };
  const factsPath = process.env.FORGEAX_PACKAGE_FACTS_PATH;
  if (factsPath !== undefined) {
    mkdirSync(resolve(factsPath, '..'), { recursive: true });
    writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`);
  }
  console.error(
    `[build-packages] ${facts.packages.built} built, ${facts.packages.skipped} skipped, concurrency=${concurrency}`,
  );
}

await main();
