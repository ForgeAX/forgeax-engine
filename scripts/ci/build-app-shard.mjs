#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { appShardRoster } from './app-build-roster.mjs';
import { projectAppShaderManifest, readSharedShaderManifest } from './app-shader-manifest.mjs';
import { readRoster, resolveRunnableEntries } from './run-dawn-smoke-roster.mjs';

function parseArgs(argv) {
  const result = {
    root: '.',
    shardCount: 3,
    shardIndex: 0,
    dryRun: false,
    mergeDdc: false,
    cacheHit: false,
    snapshotsDir: null,
    ddcOutputDir: null,
    outputDir: null,
    sharedInputManifest: null,
    attempt: null,
    omitTransferApps: [],
    skipBuildApps: [],
    selectedApps: [],
    retainArtifactOnly: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') result.root = argv[++index];
    else if (arg === '--shard-count') result.shardCount = Number(argv[++index]);
    else if (arg === '--shard-index') result.shardIndex = Number(argv[++index]);
    else if (arg === '--output-dir') result.outputDir = argv[++index];
    else if (arg === '--shared-input-manifest') result.sharedInputManifest = argv[++index];
    else if (arg === '--attempt') result.attempt = Number(argv[++index]);
    else if (arg === '--omit-transfer-app') result.omitTransferApps.push(argv[++index]);
    else if (arg === '--skip-build-app') result.skipBuildApps.push(argv[++index]);
    else if (arg === '--app') result.selectedApps.push(argv[++index]);
    else if (arg === '--retain-artifact-only') result.retainArtifactOnly = true;
    else if (arg === '--merge-ddc') result.mergeDdc = true;
    else if (arg === '--cache-hit') result.cacheHit = true;
    else if (arg === '--snapshots-dir') result.snapshotsDir = argv[++index];
    else if (arg === '--ddc-output-dir') result.ddcOutputDir = argv[++index];
    else if (arg === '--dry-run') result.dryRun = true;
  }
  return result;
}

function fail(code, detail) {
  process.stdout.write(`${JSON.stringify({ code, ...detail })}\n`);
  process.exit(1);
}

function failArtifact(code, detail) {
  fail(code, {
    expected: 'declared app-shard artifact closure',
    detail,
    hint: 'Rebuild the app shard and verify its roster-declared Pack closure.',
    ...detail,
  });
}

function isWithin(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

function safeArtifactPath(_root, distDir, rawPath, { code, app, guid }) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '' || rawPath.includes('\\'))
    failArtifact(code, { app, guid, path: rawPath });
  const normalized = rawPath.replace(/^\/+/, '');
  const candidate = resolve(distDir, normalized);
  const distReal = realpathSync(distDir);
  if (
    normalized.split('/').some((part) => part === '..' || part === '.') ||
    !isWithin(distDir, candidate) ||
    !existsSync(candidate) ||
    !isWithin(distReal, realpathSync(candidate))
  )
    failArtifact('ci-app-shard-pack-unsafe-path', { app, guid, path: rawPath });
  return candidate;
}

function packClosureInventory(root, app, packGuids) {
  const appRoot = join(root, 'apps', app);
  const distDir = join(appRoot, 'dist');
  const packIndexPath = join(distDir, 'pack-index.json');
  if (!existsSync(packIndexPath))
    failArtifact('ci-app-shard-pack-index-missing', { app, path: packIndexPath });
  let packIndex;
  try {
    packIndex = decodeCatalogWire(JSON.parse(readFileSync(packIndexPath, 'utf8'))).unwrap();
  } catch {
    failArtifact('ci-app-shard-pack-index-invalid', { app, path: packIndexPath });
  }
  if (!Array.isArray(packIndex))
    failArtifact('ci-app-shard-pack-index-invalid', { app, path: packIndexPath });

  const paths = new Set([`apps/${app}/dist/pack-index.json`]);
  const packageRecords = new Map();
  const reachable = new Set(packGuids);
  const pending = [...reachable];
  for (let index = 0; index < pending.length; index += 1) {
    const guid = pending[index];
    const matches = packIndex.filter((entry) => entry?.guid === guid);
    // Runtime-owned builtin meshes need no Pack file. Authored overrides still
    // resolve through the catalog, and every other missing reference is fatal.
    if (
      matches.length === 0 &&
      !packGuids.includes(guid) &&
      BUILTIN_MESH_ASSETS.some((asset) => asset.guid === guid)
    )
      continue;
    if (matches.length !== 1)
      failArtifact('ci-app-shard-pack-guid-missing', { app, guid, matchCount: matches.length });
    const packageUrl = matches[0].packageUrl;
    if (typeof packageUrl !== 'string' || !packageUrl.startsWith('/assets/'))
      failArtifact('ci-app-shard-pack-unsafe-path', { app, guid, path: packageUrl });
    const packagePath = safeArtifactPath(root, distDir, packageUrl, {
      code: 'ci-app-shard-pack-package-missing',
      app,
      guid,
    });
    let packFile = packageRecords.get(packagePath);
    if (packFile === undefined) {
      try {
        packFile = JSON.parse(readFileSync(packagePath, 'utf8'));
      } catch {
        failArtifact('ci-app-shard-pack-package-invalid', { app, guid, path: packagePath });
      }
      packageRecords.set(packagePath, packFile);
    }
    const assets = packFile?.assets?.filter((asset) => asset?.guid === guid) ?? [];
    if (assets.length !== 1)
      failArtifact('ci-app-shard-pack-guid-missing', { app, guid, matchCount: assets.length });
    paths.add(`apps/${app}/dist/${relative(distDir, packagePath)}`);
    const asset = assets[0];
    for (const ref of asset.refs ?? []) {
      if (typeof ref === 'string' && !reachable.has(ref)) {
        reachable.add(ref);
        pending.push(ref);
      }
    }
    // Artifact identity comes from the Pack declaration, never its suffix.
    // Mesh fields and cooked VFX programs belong to the same transfer closure.
    for (const [name, descriptor] of Object.entries(asset.artifacts ?? {})) {
      const code =
        name === 'body' ? 'ci-app-shard-pack-body-missing' : 'ci-app-shard-pack-artifact-missing';
      const artifactFile = safeArtifactPath(root, dirname(packagePath), descriptor?.path, {
        code,
        app,
        guid,
      });
      paths.add(`apps/${app}/dist/${relative(distDir, artifactFile)}`);
    }
  }
  return [...paths].sort();
}

function rosterPackRequirements(root) {
  const rosterPath = join(root, 'scripts', 'ci', 'dawn-smoke-roster.json');
  if (!existsSync(rosterPath)) return new Map();
  const roster = readRoster(rosterPath);
  const resolved = resolveRunnableEntries({ repoRoot: root, roster });
  const requirements = new Map();
  for (const entry of resolved.declared) {
    const app = entry.path.match(/^apps\/(.+)\/package\.json$/)?.[1];
    if (app === undefined) continue;
    const guids = entry.gates.flatMap((gate) => gate.artifactRequirements?.packGuids ?? []);
    if (guids.length > 0) requirements.set(app, [...new Set(guids)].sort());
  }
  return requirements;
}

function artifactInventory(root, apps) {
  const requirements = rosterPackRequirements(root);
  return apps.flatMap((app) => {
    const manifest = `apps/${app}/dist/shaders/manifest.json`;
    const paths = existsSync(join(root, manifest)) ? [manifest] : [];
    const packGuids = requirements.get(app) ?? [];
    return packGuids.length > 0 ? [...paths, ...packClosureInventory(root, app, packGuids)] : paths;
  });
}

function copyShardArtifacts(root, outputDir, report, sharedShaderManifest) {
  for (const relative of report.artifactInventory) {
    const source = join(root, relative);
    const destination = join(outputDir, 'artifacts', relative);
    mkdirSync(dirname(destination), { recursive: true });
    if (sharedShaderManifest !== null && relative.endsWith('/dist/shaders/manifest.json')) {
      const appManifest = JSON.parse(readFileSync(source, 'utf8'));
      const projected = projectAppShaderManifest(appManifest, sharedShaderManifest, source);
      writeFileSync(destination, `${JSON.stringify(projected, null, 2)}\n`);
    } else {
      cpSync(source, destination, { recursive: true });
    }
  }
}

function completeDdcEntry(path) {
  return existsSync(join(path, 'receipt.json')) && existsSync(join(path, 'integrity.json'));
}

function mergeDdcSnapshots(options) {
  const snapshotsDir = resolve(options.snapshotsDir ?? 'ddc-snapshots');
  const outputDir = resolve(options.ddcOutputDir ?? 'ddc-merged');
  mkdirSync(outputDir, { recursive: true });
  let availableSnapshots = 0;
  if (!options.cacheHit) {
    for (let index = 0; index < options.shardCount; index += 1) {
      const source = join(snapshotsDir, String(index));
      if (!existsSync(source)) continue;
      availableSnapshots += 1;
      const entries = join(source, 'entries');
      if (existsSync(entries)) {
        for (const entry of readdirSync(entries).sort()) {
          const entryPath = join(entries, entry);
          if (!completeDdcEntry(entryPath)) {
            fail('ddc-snapshot-entry-incomplete', { entry });
          }
          cpSync(entryPath, join(outputDir, 'entries', entry), {
            recursive: true,
            force: true,
          });
        }
      }
      for (const entry of readdirSync(source).sort()) {
        if (entry === 'entries' || /^(?:staging|lease|attempt|head)$/.test(entry)) continue;
        cpSync(join(source, entry), join(outputDir, entry), { recursive: true, force: true });
      }
    }
  }
  const status = {
    outcome: options.cacheHit
      ? 'skipped'
      : availableSnapshots === options.shardCount
        ? 'saved'
        : 'partial',
    availableSnapshots,
    shardCount: options.shardCount,
    nextRunWouldHit: options.cacheHit || availableSnapshots > 0,
  };
  writeFileSync(join(outputDir, 'ddc-warm-status.json'), JSON.stringify(status, null, 2));
  process.stdout.write(`${JSON.stringify(status)}\n`);
  process.exit(0);
}

function writeReport(root, outputDir, report, sharedShaderManifest) {
  const output = resolve(outputDir);
  const reportDir = join(output, 'report');
  mkdirSync(reportDir, { recursive: true });
  copyShardArtifacts(root, output, report, sharedShaderManifest);
  writeFileSync(
    join(reportDir, `coverage-${report.shardIndex}-a${report.attempt}.json`),
    JSON.stringify({ ...report, result: 'success' }, null, 2),
  );
  writeFileSync(
    join(reportDir, `artifact-inventory-${report.shardIndex}-a${report.attempt}.json`),
    JSON.stringify(report.artifactInventory, null, 2),
  );
}

function retainArtifactOnly(root, outputDir, apps) {
  // The consumer needs the same compact projection as an artifact download.
  // Drop full app bundles between shards, after every retained file was staged.
  for (const app of apps) {
    const dist = join(root, 'apps', app, 'dist');
    const staged = join(outputDir, 'artifacts', 'apps', app, 'dist');
    rmSync(dist, { recursive: true, force: true });
    if (existsSync(staged)) cpSync(staged, dist, { recursive: true });
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.retainArtifactOnly && !options.outputDir) {
  fail('ci-app-shard-output-dir-required', {
    expected: '--output-dir when retaining only the artifact projection',
  });
}
if (
  !Number.isInteger(options.shardCount) ||
  options.shardCount < 1 ||
  !Number.isInteger(options.shardIndex) ||
  options.shardIndex < 0 ||
  options.shardIndex >= options.shardCount
) {
  fail('ci-app-shard-index-out-of-range', {
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
  });
}

if (options.mergeDdc) {
  mergeDdcSnapshots(options);
}

const root = resolve(options.root);
if (
  options.sharedInputManifest !== null &&
  !existsSync(resolve(root, options.sharedInputManifest))
) {
  fail('ci-app-shard-shared-input-missing', { manifest: options.sharedInputManifest });
}
const attempt = options.attempt ?? Number(process.env.GITHUB_RUN_ATTEMPT ?? 1);
if (!Number.isInteger(attempt) || attempt < 1) fail('ci-app-shard-attempt-invalid', { attempt });
const roster = appShardRoster(root);
const selectedApps = new Set(options.selectedApps);
for (const app of selectedApps) {
  if (!roster.includes(app)) fail('ci-app-shard-app-not-in-roster', { app });
}
// Keep global shard ownership while limiting source recovery to the consumer's apps.
const apps = roster.filter(
  (app, index) =>
    index % options.shardCount === options.shardIndex &&
    (selectedApps.size === 0 || selectedApps.has(app)),
);
// CLI exclusions describe the global roster. Derive their local ownership so
// additions to the sorted roster cannot strand an exclusion on an old shard.
const requestedOmissions = [...new Set(options.omitTransferApps)];
const requestedSkips = [...new Set(options.skipBuildApps)];
const unknownOmittedTransferApp = requestedOmissions.find((app) => !roster.includes(app));
if (unknownOmittedTransferApp !== undefined) {
  fail('ci-app-shard-transfer-app-not-in-shard', {
    app: unknownOmittedTransferApp,
    shardIndex: options.shardIndex,
    expected: roster,
    hint: 'Only omit transfer payloads for apps in the build roster.',
  });
}
const unknownSkippedBuildApp = requestedSkips.find((app) => !roster.includes(app));
if (unknownSkippedBuildApp !== undefined) {
  fail('ci-app-shard-build-app-not-in-shard', {
    app: unknownSkippedBuildApp,
    shardIndex: options.shardIndex,
    expected: roster,
    hint: 'Only skip builds for apps in the build roster.',
  });
}
const skippedTransferApp = requestedSkips.find((app) => !requestedOmissions.includes(app));
if (skippedTransferApp !== undefined) {
  fail('ci-app-shard-skip-build-transfer-required', {
    app: skippedTransferApp,
    expected: 'every skipped build app must also be omitted from transfer',
    hint: 'A skipped build cannot contribute an app-dist payload.',
  });
}
const omittedTransferApps = requestedOmissions.filter((app) => apps.includes(app));
const skippedBuildApps = requestedSkips.filter((app) => apps.includes(app));
const transferApps = apps.filter((app) => !omittedTransferApps.includes(app));
const buildApps = apps.filter((app) => !skippedBuildApps.includes(app));
const shardSizes = Array.from(
  { length: options.shardCount },
  (_, shardIndex) => roster.filter((_, index) => index % options.shardCount === shardIndex).length,
);
const report = {
  shardIndex: options.shardIndex,
  shardCount: options.shardCount,
  attempt,
  apps,
  transferApps,
  omittedTransferApps,
  buildApps,
  skippedBuildApps,
  appCount: apps.length,
  loadImbalance: Math.max(...shardSizes) - Math.min(...shardSizes),
  artifactInventory: options.dryRun ? artifactInventory(root, transferApps) : [],
  dryRun: options.dryRun,
};

const sharedShaderManifest =
  options.sharedInputManifest === null
    ? null
    : readSharedShaderManifest(root, options.sharedInputManifest).manifest;

if (!options.dryRun && buildApps.length > 0) {
  const runner = join(root, 'scripts', 'build-apps.mjs');
  const result = spawnSync(
    process.execPath,
    [
      runner,
      ...(options.sharedInputManifest === null
        ? []
        : ['--shared-input-manifest', resolve(root, options.sharedInputManifest)]),
      '--app-shard-shader-delta',
      ...buildApps,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
report.artifactInventory = artifactInventory(root, transferApps);
if (options.outputDir) writeReport(root, options.outputDir, report, sharedShaderManifest);
if (options.retainArtifactOnly && !options.dryRun) {
  retainArtifactOnly(root, resolve(options.outputDir), transferApps);
}
process.stdout.write(`${JSON.stringify(report)}\n`);
