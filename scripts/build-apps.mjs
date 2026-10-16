#!/usr/bin/env node
// Build app tasks with verified local receipts. Cache hits require both a
// semantic input match and a complete output inventory; a receipt is written
// only after the child exits successfully.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  appInputFiles,
  appMemoryClass,
  appOutputDirectory,
  appPackages,
  cachePath,
  hashFiles,
  hashText,
  inventory,
  inventoryMatches,
  memoryCostGB,
  packageId,
  packageOutputFingerprint,
  readJson,
  readReceipt,
  workspacePackages,
  writeReceipt,
} from './build-task-cache.mjs';
import {
  createPrebuildInvocation,
  createViteBuildInvocation,
  resolveViteCli,
  validateCanonicalAppBuilds,
} from './lib/app-build-launcher.mjs';
import { appBuildConcurrency, runnerResources } from './lib/runner-resources.mjs';

const root = resolve(process.env.FORGEAX_REPO_ROOT ?? '.');
const sharedManifestArg = process.argv.indexOf('--shared-input-manifest');
let sharedInputManifest =
  sharedManifestArg === -1 ? undefined : process.argv[sharedManifestArg + 1];
const appShardShaderDelta = process.argv.includes('--app-shard-shader-delta');
const requestedArgs = process.argv
  .slice(2)
  .filter(
    (argument, index, argv) =>
      argument !== '--shared-input-manifest' &&
      argument !== '--app-shard-shader-delta' &&
      (index === 0 || argv[index - 1] !== '--shared-input-manifest'),
  );

function runSync(command, args, env = process.env) {
  return spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env,
  });
}

if (sharedInputManifest === undefined) {
  if (process.env.FORGEAX_BUILD_PACKAGES_READY !== '1') {
    const packages = runSync(process.execPath, ['scripts/build-packages.mjs'], {
      ...process.env,
      FORGEAX_REPO_ROOT: root,
    });
    if (packages.status !== 0) process.exit(packages.status ?? 1);
  }
  const producer = runSync(process.execPath, ['scripts/build-shared-inputs.mjs', '--root', root]);
  if (producer.status !== 0) process.exit(producer.status ?? 1);
  sharedInputManifest = resolve(root, 'shared-build-inputs/manifest.json');
} else {
  sharedInputManifest = resolve(root, sharedInputManifest);
}
if (!existsSync(sharedInputManifest)) {
  console.error(`[build-apps] shared input manifest not found: ${sharedInputManifest}`);
  process.exit(1);
}

const sharedManifest = readJson(sharedInputManifest);
const { cpus, memoryBytes } = runnerResources();
const explicitConcurrency = process.env.FORGEAX_BUILD_CONCURRENCY;
const maxConcurrent = Number(explicitConcurrency ?? appBuildConcurrency({ cpus, memoryBytes }));
const noCache = process.env.FORGEAX_BUILD_NO_TASK_CACHE === '1';
const metricsRoot = process.env.FORGEAX_BUILD_SUMMARY_PATH
  ? resolve(process.env.FORGEAX_BUILD_SUMMARY_PATH, '..', 'app-facts')
  : undefined;
if (metricsRoot !== undefined) {
  rmSync(metricsRoot, { recursive: true, force: true });
  mkdirSync(metricsRoot, { recursive: true });
}

function resolveRequestedApps(allApps) {
  if (requestedArgs.length === 0) return allApps;
  const byPath = new Map(allApps.map((app) => [app.relativeDirectory.replaceAll('\\', '/'), app]));
  const byName = new Map(allApps.map((app) => [app.manifest.name, app]));
  return requestedArgs.map((value) => {
    const normalized = value.replace(/^apps\//, '').replaceAll('\\', '/');
    const app = byPath.get(`apps/${normalized}`) ?? byPath.get(normalized) ?? byName.get(value);
    if (app === undefined) throw new Error(`unknown app task: ${value}`);
    return app;
  });
}

function packageFingerprintMap() {
  const result = new Map();
  for (const pkg of workspacePackages(root)) {
    const output = inventory(resolve(pkg.directory, 'dist'));
    if (output !== null)
      result.set(pkg.manifest.name, packageOutputFingerprint(root, pkg.directory, output));
  }
  return result;
}

function transitivePackages(app, packagesByName, packageFingerprints) {
  const result = [];
  const queue = [
    ...Object.keys(app.manifest.dependencies ?? {}),
    ...Object.keys(app.manifest.devDependencies ?? {}),
    ...Object.keys(app.manifest.optionalDependencies ?? {}),
  ];
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const pkg = packagesByName.get(name);
    if (pkg === undefined) continue;
    result.push([name, packageFingerprints.get(name) ?? 'missing']);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
      queue.push(...Object.keys(pkg.manifest[field] ?? {}));
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

function taskPlan(app, packageFingerprints, packagesByName) {
  const files = appInputFiles(root, app.directory, app.manifest);
  const inputFingerprint = hashFiles(root, files);
  const packageInputs = transitivePackages(app, packagesByName, packageFingerprints);
  return {
    files,
    inputFingerprint: hashText(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'app-build',
        name: app.manifest.name,
        sourceFingerprint: inputFingerprint,
        packageInputs,
        sharedInputFingerprint: sharedManifest.inputFingerprint,
        sharedManifest: hashFiles(root, [sharedInputManifest]),
        mode: process.env.NODE_ENV ?? 'production',
        shaderManifestMode: appShardShaderDelta ? 'app-shard-delta' : 'full',
      }),
    ),
  };
}

function writeHistory(app, facts) {
  const path = cachePath(root, 'history/apps', app.manifest.name);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
}

function processTable() {
  if (process.platform === 'win32') return null;
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite));
}

function processTreeRss(pid, rows) {
  if (!Number.isInteger(pid) || rows === null) return null;
  const children = new Map();
  for (const [childPid, parentPid, rssKB] of rows) {
    const list = children.get(parentPid) ?? [];
    list.push([childPid, rssKB]);
    children.set(parentPid, list);
  }
  const queue = [pid];
  const seen = new Set();
  let rssKB = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const row = rows.find(([processPid]) => processPid === current);
    if (row !== undefined) rssKB += row[2];
    for (const [childPid] of children.get(current) ?? []) queue.push(childPid);
  }
  return rssKB * 1024;
}

function createProcessSampler() {
  const tracked = new Map();
  const sample = () => {
    const rows = processTable();
    for (const record of tracked.values()) {
      const rss = processTreeRss(record.pid, rows);
      if (rss !== null) record.peakRssBytes = Math.max(record.peakRssBytes, rss);
    }
  };
  const timer = setInterval(sample, 1_000);
  timer.unref();
  return {
    track(pid) {
      const record = { pid, peakRssBytes: 0 };
      tracked.set(pid, record);
      return record;
    },
    finish(record) {
      sample();
      tracked.delete(record.pid);
      return record.peakRssBytes;
    },
    dispose() {
      clearInterval(timer);
    },
  };
}

function runApp(app, className, appFactsDir, viteCliPath, sampler, baseEnv = process.env) {
  return new Promise((resolveRun) => {
    const startedAt = performance.now();
    const prebuild = createPrebuildInvocation({ app, baseEnv });
    if (prebuild !== null) {
      const result = spawnSync(prebuild.command, prebuild.args, prebuild.options);
      if (result.status !== 0) {
        if (result.error)
          console.error(`[build-apps] prebuild startup failed: ${result.error.message}`);
        resolveRun({
          ok: false,
          code: result.status ?? 1,
          signal: result.signal,
          className,
          durationMs: Number((performance.now() - startedAt).toFixed(1)),
          peakRssBytes: 0,
        });
        return;
      }
    }
    const invocation = createViteBuildInvocation({
      app,
      viteCliPath,
      appFactsDir,
      baseEnv,
    });
    const child = spawn(invocation.command, invocation.args, invocation.options);
    const sample = sampler.track(child.pid);
    child.once('error', (error) => {
      resolveRun({
        ok: false,
        error,
        className,
        durationMs: performance.now() - startedAt,
        peakRssBytes: sampler.finish(sample),
      });
    });
    child.once('exit', (code, signal) => {
      resolveRun({
        ok: code === 0,
        code,
        signal,
        className,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        peakRssBytes: sampler.finish(sample),
      });
    });
  });
}

function aggregatePluginFacts(directory) {
  const facts = [];
  if (directory !== undefined && existsSync(directory)) {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json')))
      facts.push(readJson(resolve(directory, name)));
  }
  return facts.reduce(
    (total, factsFile) => ({
      appShaderCompileCount: total.appShaderCompileCount + (factsFile.appShaderCompileCount ?? 0),
      assetCookHitCount: total.assetCookHitCount + (factsFile.assetCookHitCount ?? 0),
      assetCookMissCount: total.assetCookMissCount + (factsFile.assetCookMissCount ?? 0),
      assetCookWriteFailureCount:
        total.assetCookWriteFailureCount + (factsFile.assetCookWriteFailureCount ?? 0),
    }),
    {
      appShaderCompileCount: 0,
      assetCookHitCount: 0,
      assetCookMissCount: 0,
      assetCookWriteFailureCount: 0,
    },
  );
}

async function main() {
  const allApps = appPackages(root);
  validateCanonicalAppBuilds(allApps);
  const apps = resolveRequestedApps(allApps);
  const packageFingerprints = packageFingerprintMap();
  const packagesByName = new Map(workspacePackages(root).map((pkg) => [pkg.manifest.name, pkg]));
  const tasks = apps.map((app) => {
    const plan = taskPlan(app, packageFingerprints, packagesByName);
    const className = appMemoryClass(app, plan.files);
    const receipt = noCache ? null : readReceipt(root, 'receipts/apps', app.manifest.name);
    const cacheHit =
      receipt?.schemaVersion === 1 &&
      receipt.inputFingerprint === plan.inputFingerprint &&
      receipt.sharedInputFingerprint === sharedManifest.inputFingerprint &&
      inventoryMatches(appOutputDirectory(app), receipt.outputInventory);
    return {
      app,
      plan,
      className,
      memoryGB: memoryCostGB(className),
      receipt,
      cacheHit,
    };
  });
  const results = [];
  for (const task of tasks.filter((task) => task.cacheHit)) {
    results.push({
      name: task.app.manifest.name,
      path: task.app.relativeDirectory,
      status: 'skipped',
      cacheHit: true,
      className: task.className,
      memoryGB: task.memoryGB,
      durationMs: 0,
      peakRssBytes: task.receipt.peakRssBytes ?? null,
      outputBytes: task.receipt.outputInventory.totalBytes,
    });
    console.error(`[build-apps] cache hit ${task.app.manifest.name}`);
  }

  const pending = tasks
    .filter((task) => !task.cacheHit)
    // Start larger source closures first so a large app does not run alone last.
    .sort(
      (a, b) =>
        b.plan.files.length - a.plan.files.length ||
        a.app.relativeDirectory.localeCompare(b.app.relativeDirectory),
    );
  const viteCliPath = pending.length === 0 ? undefined : resolveViteCli(root);
  // The producer has already compiled the engine shader manifest. Forward its
  // absolute manifest path to every child Vite process so app builds project
  // the trusted shared payload instead of silently recompiling engine shaders
  // from source (or relying on an undeclared packaged-input residue).
  const appBuildEnv = {
    ...process.env,
    FORGEAX_SHARED_APP_INPUTS_MANIFEST: sharedInputManifest,
    // App shards transfer a shared manifest plus app-local deltas. Avoid
    // serializing and sizing the shared payload once per app in that path.
    ...(appShardShaderDelta
      ? {
          FORGEAX_APP_SHARD_SHADER_DELTA: '1',
          FORGEAX_VITE_REPORT_COMPRESSED_SIZE: '0',
        }
      : {}),
  };
  const running = new Map();
  const sampler = createProcessSampler();

  while (pending.length > 0 || running.size > 0) {
    while (pending.length > 0 && running.size < maxConcurrent) {
      const task = pending.shift();
      const factsDir =
        metricsRoot === undefined
          ? undefined
          : resolve(metricsRoot, packageId(task.app.manifest.name));
      if (factsDir !== undefined) mkdirSync(factsDir, { recursive: true });
      const promise = runApp(
        task.app,
        task.className,
        factsDir,
        viteCliPath,
        sampler,
        appBuildEnv,
      ).then((run) => ({ task, run, factsDir }));
      running.set(task.app.manifest.name, promise);
      console.error(
        `[build-apps] build ${task.app.manifest.name} class=${task.className} memory=${task.memoryGB}GB`,
      );
    }
    if (running.size === 0) {
      continue;
    }
    const finished = await Promise.race(
      [...running.entries()].map(async ([name, promise]) => ({ name, result: await promise })),
    );
    running.delete(finished.name);
    const { task, run, factsDir } = finished.result;
    if (!run.ok) {
      const reason = run.signal ? `signal ${run.signal}` : `exit ${run.code ?? 'unknown'}`;
      const detail = run.error === undefined ? '' : `: ${run.error.message}`;
      console.error(`[build-apps] failed ${task.app.manifest.name} (${reason})${detail}`);
      process.exitCode = run.code ?? 1;
      sampler.dispose();
      return;
    }
    const output = inventory(appOutputDirectory(task.app));
    if (output === null || output.fileCount === 0)
      throw new Error(`app build produced no dist output: ${task.app.manifest.name}`);
    const pluginFacts = aggregatePluginFacts(factsDir);
    writeReceipt(root, 'receipts/apps', task.app.manifest.name, {
      schemaVersion: 1,
      kind: 'app-build',
      producer: 'scripts/build-apps.mjs',
      name: task.app.manifest.name,
      inputFingerprint: task.plan.inputFingerprint,
      sharedInputFingerprint: sharedManifest.inputFingerprint,
      outputInventory: output,
      durationMs: run.durationMs,
      peakRssBytes: run.peakRssBytes,
    });
    writeHistory(task.app, {
      schemaVersion: 1,
      name: task.app.manifest.name,
      className: task.className,
      durationMs: run.durationMs,
      peakRssBytes: run.peakRssBytes,
      updatedAt: new Date().toISOString(),
    });
    results.push({
      name: task.app.manifest.name,
      path: task.app.relativeDirectory,
      status: 'built',
      cacheHit: false,
      className: task.className,
      memoryGB: task.memoryGB,
      durationMs: run.durationMs,
      peakRssBytes: run.peakRssBytes || null,
      outputBytes: output.totalBytes,
      ...pluginFacts,
    });
  }
  sampler.dispose();

  const totals = results.reduce(
    (total, result) => ({
      appShaderCompileCount: total.appShaderCompileCount + (result.appShaderCompileCount ?? 0),
      assetCookHitCount: total.assetCookHitCount + (result.assetCookHitCount ?? 0),
      assetCookMissCount: total.assetCookMissCount + (result.assetCookMissCount ?? 0),
      assetCookWriteFailureCount:
        total.assetCookWriteFailureCount + (result.assetCookWriteFailureCount ?? 0),
    }),
    {
      appShaderCompileCount: 0,
      assetCookHitCount: 0,
      assetCookMissCount: 0,
      assetCookWriteFailureCount: 0,
    },
  );
  const summaryPath = process.env.FORGEAX_BUILD_SUMMARY_PATH;
  if (summaryPath !== undefined) {
    const prior = existsSync(summaryPath) ? readJson(summaryPath) : {};
    writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          ...prior,
          apps: {
            requested: requestedArgs.length === 0 ? 'all' : requestedArgs,
            count: apps.length,
            built: results.filter((result) => result.status === 'built').length,
            skipped: results.filter((result) => result.status === 'skipped').length,
            concurrency: maxConcurrent,
            scheduling: 'fixed-concurrency',
            results: results.sort((a, b) => a.name.localeCompare(b.name)),
          },
          ...totals,
        },
        null,
        2,
      )}\n`,
    );
  }
  console.error(
    `[build-apps] ${results.filter((result) => result.status === 'built').length} built, ` +
      `${results.filter((result) => result.status === 'skipped').length} skipped, ` +
      `concurrency=${maxConcurrent}, scheduling=fixed`,
  );
}

await main();
