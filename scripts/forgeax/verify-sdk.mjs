import { constants, rmSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { chromium } from 'playwright';
import { reduceTestProject } from '../test/reduce-test-project.mjs';
import testQuality from '../test/render-quality.json' with { type: 'json' };
import {
  artifact,
  assertNoRetiredPackageFiles,
  filesUnder,
  ignoresProjectState,
  isPnpmSqliteStoreArtifact,
  mapConcurrent,
  SDK_CAPABILITIES,
  SDK_MANIFEST_VERSION,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_FORMAT,
  SDK_TEMPLATES,
  sdkResourceManifest,
  sdkTemplateResourceManifest,
  sha256,
  verifySdkArchiveInventory,
  verifySdkViewRuntime,
} from './sdk-lib.mjs';
import { SDK_ARCHIVE_VERIFY_GROUPS, SDK_COMPACT_PREVIEW_FRAMES } from './sdk-pr-preflight.mjs';
import { verifyProjectIdentityReconcile } from './sdk-project-identity.mjs';
import { assertSourceDependencyInventory } from './sdk-source.mjs';
import { sdkGpuStage, sdkStage } from './sdk-stage.mjs';
import { buildCacheEntries, SDK_BUILD_CACHE_SEED } from './sdk-template-cache.mjs';
import { verifySdkModeling } from './verify-sdk-modeling.mjs';
import { createSdkVerifierProcess, readSdkProjectDocument } from './verify-sdk-process.mjs';
import { verifySdkSourceEdit } from './verify-sdk-source-edit.mjs';

let sourcePackageManager;
const processRunner = createSdkVerifierProcess(() => sourcePackageManager);
const execFileAsync = (file, args, { streamOutput = false, ...options } = {}) =>
  sdkStage([file, ...args].join(' ').slice(0, 240), () => {
    return processRunner.execFileAsync(file, args, { streamOutput, ...options });
  });
const args = process.argv.slice(2);
if (process.env.FORGEAX_LOCAL_GPU_LEASE_HELD === '1')
  throw new Error('sdk-outer-gpu-lease-forbidden: use per-owner admission');
const index = args.indexOf('--archive');
if (index < 0 || args[index + 1] === undefined)
  throw new Error('Usage: pnpm sdk:verify --archive <path>');
const archive = resolve(args[index + 1]);
const groupIndex = args.indexOf('--group');
const group = groupIndex < 0 ? 'all' : args[groupIndex + 1];
if (group !== 'all' && !SDK_ARCHIVE_VERIFY_GROUPS.includes(group))
  throw new Error(`sdk-verify-unknown-group:${group}`);
const profileIndex = args.indexOf('--profile');
const profile = profileIndex < 0 ? 'full' : args[profileIndex + 1];
const prPreflight = profile === 'pr-consumer' || profile === 'pr-expanded';
if (
  !['core', 'full', 'pr-consumer', 'pr-expanded'].includes(profile) ||
  (prPreflight && group === 'all')
)
  throw new Error(`sdk-verify-unknown-profile:${profile}`);
const expandedArchive = profile !== 'pr-consumer';
const selected = (owner) => group === 'all' || group === owner;
let projectEvidence = {};
let sourceTemplateEvidence;

const CLEANUP_TIMEOUT_MS = 10_000;
const BROWSER_CLEANUP_TIMEOUT_MS = 30_000;
// Keep SDK live-start polling aligned with the DevKit's bounded cold-project
// build window. The selected game-3d template can legitimately spend this
// time materializing shaders/Packs before it emits the JSON start envelope.
const LIVE_DEV_STARTUP_TIMEOUT_MS = 300_000;
const unpackRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-verify-'));
let unpackRootRemoved = false;
const removeUnpackRoot = () => {
  if (unpackRootRemoved) return;
  unpackRootRemoved = true;
  rmSync(unpackRoot, { force: true, recursive: true });
};
process.once('exit', removeUnpackRoot);
process.once('SIGINT', () => {
  removeUnpackRoot();
  process.exit(130);
});
process.once('SIGTERM', () => {
  removeUnpackRoot();
  process.exit(143);
});
await execFileAsync('unzip', ['-q', archive, '-d', unpackRoot]);
const sdkRoot = resolve(unpackRoot, 'forgeax-sdk');
const manifest = JSON.parse(await readFile(resolve(sdkRoot, 'sdk-manifest.json'), 'utf8'));
const schema = JSON.parse(
  await readFile(resolve(sdkRoot, 'schemas', 'sdk-manifest.schema.json'), 'utf8'),
);
const validate = new Ajv2020({ allErrors: true }).compile(schema);
if (!validate(manifest)) throw new Error(`sdk-manifest-schema: ${JSON.stringify(validate.errors)}`);
if (manifest.schemaVersion !== SDK_MANIFEST_VERSION) throw new Error('sdk-manifest-version');
if (JSON.stringify(manifest.capabilities) !== JSON.stringify(SDK_CAPABILITIES))
  throw new Error('sdk-capability-closure');
await sdkStage('verifySdkArtifactInventory', () =>
  verifySdkArchiveInventory(sdkRoot, manifest.artifacts),
);

for (const entry of manifest.packages) {
  const packageRoot = resolve(sdkRoot, entry.root);
  if (!contained(sdkRoot, packageRoot)) throw new Error(`sdk-package-path: ${entry.name}`);
  const prefix = `${entry.root}/`;
  const packageFiles = manifest.artifacts.filter((file) => file.path.startsWith(prefix));
  const manifestFile = packageFiles.find((file) => file.path === `${prefix}package.json`);
  if (manifestFile === undefined) throw new Error(`sdk-package-manifest: ${entry.name}`);
  const packageManifest = JSON.parse(
    await readFile(
      resolve(
        sdkRoot,
        manifestFile.sourceCopy === true
          ? `${manifest.source.root}/${manifestFile.path}`
          : manifestFile.path,
      ),
      'utf8',
    ),
  );
  if (packageManifest.name !== entry.name || packageManifest.version !== entry.version)
    throw new Error(`sdk-package-identity: ${entry.name}`);
  const packagePaths = packageFiles.map(({ path }) => path.slice(prefix.length));
  if (packagePaths.includes('package/package.json'))
    throw new Error(`sdk-package-wrapper-leaked: ${entry.name}`);
  if (packagePaths.some((path) => path.endsWith('.tgz')))
    throw new Error('sdk-package-archive-leaked');
  assertNoRetiredPackageFiles(entry.name, packagePaths);
  if (packageFiles.length !== entry.fileCount)
    throw new Error(`sdk-package-file-count: ${entry.name}`);
  if (packageFiles.reduce((sum, file) => sum + file.bytes, 0) !== entry.byteCount)
    throw new Error(`sdk-package-byte-count: ${entry.name}`);
}
const tool = manifest.packages.find((entry) => entry.name === '@forgeax/view');
if (
  !tool ||
  tool.role !== 'tool' ||
  tool.root !== 'tools/view' ||
  manifest.packages.filter((entry) => entry.role === 'tool').length !== 1
)
  throw new Error('sdk-view-tool-inventory');
const viewSource = manifest.source.gitDependencies.find((entry) => entry.root === 'tools/view');
if (viewSource?.commit !== manifest.viewCommit) throw new Error('sdk-view-source-identity');
const toolInputs = JSON.parse(
  await readFile(resolve(sdkRoot, 'toolchain/cli-runtime/package.json'), 'utf8'),
);
if (
  JSON.stringify(Object.keys(toolInputs.dependencies).sort()) !==
  JSON.stringify(['@forgeax/engine', '@forgeax/view'])
)
  throw new Error('sdk-tool-runtime-inputs');
if (
  toolInputs.dependencies['@forgeax/engine'] !== manifest.sdkVersion ||
  toolInputs.dependencies['@forgeax/view'] !== 'file:../../tools/view'
)
  throw new Error('sdk-tool-runtime-version');
const embeddedView = JSON.parse(
  await readFile(resolve(sdkRoot, tool.root, 'package.json'), 'utf8'),
);
if (embeddedView.private !== true) throw new Error('sdk-view-tool-must-be-private');
await readFile(resolve(sdkRoot, tool.root, 'LICENSE'));
const archivedSkillIds = (await readdir(resolve(sdkRoot, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(archivedSkillIds) !== JSON.stringify(manifest.skills.map((entry) => entry.id)))
  throw new Error('sdk-skill-manifest');
for (const entry of manifest.skills) {
  const skillRoot = resolve(sdkRoot, entry.root);
  if (!contained(sdkRoot, skillRoot) || basename(skillRoot) !== entry.id)
    throw new Error(`sdk-skill-path: ${entry.id}`);
  await readFile(resolve(skillRoot, 'SKILL.md'));
  const skillFiles = await filesUnder(skillRoot);
  if (skillFiles.length !== entry.fileCount) throw new Error(`sdk-skill-file-count: ${entry.id}`);
  const byteCount = (
    await Promise.all(skillFiles.map(async (path) => (await readFile(path)).byteLength))
  ).reduce((sum, bytes) => sum + bytes, 0);
  if (byteCount !== entry.byteCount) throw new Error(`sdk-skill-byte-count: ${entry.id}`);
  if (
    manifest.artifacts.filter((artifactEntry) => artifactEntry.path.startsWith(`${entry.root}/`))
      .length !== entry.fileCount
  )
    throw new Error(`sdk-skill-artifact-closure: ${entry.id}`);
}
try {
  await access(resolve(sdkRoot, 'docs'));
  throw new Error('sdk-legacy-docs-surface');
} catch (cause) {
  if (cause instanceof Error && cause.message === 'sdk-legacy-docs-surface') throw cause;
}
const expectedTemplates = SDK_TEMPLATES.map(({ id, sourceRoot: root }) => ({ id, root }));
if (JSON.stringify(manifest.templates) !== JSON.stringify(expectedTemplates))
  throw new Error('sdk-template-manifest');
const sourceRoot = resolve(sdkRoot, manifest.source.root);
const sourcePackage = JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8'));
sourcePackageManager = sourcePackage.packageManager;
const sdkPackage = JSON.parse(await readFile(resolve(sdkRoot, 'package.json'), 'utf8'));
if (sdkPackage.packageManager !== sourcePackageManager)
  throw new Error('sdk-root-package-manager-mismatch');
if (typeof sourcePackageManager !== 'string' || !sourcePackageManager.startsWith('pnpm@')) {
  throw new Error('sdk-source-package-manager');
}
const sourcePrefix = `${manifest.source.root}/`;
const sourceArtifacts = manifest.artifacts.filter((entry) => entry.path.startsWith(sourcePrefix));
if (sourceArtifacts.length !== manifest.source.fileCount) throw new Error('sdk-source-file-count');
if (sourceArtifacts.reduce((sum, entry) => sum + entry.bytes, 0) !== manifest.source.byteCount)
  throw new Error('sdk-source-byte-count');
if (manifest.source.format !== SDK_SOURCE_FORMAT) throw new Error('sdk-source-format');
if (JSON.stringify(manifest.source.excluded) !== JSON.stringify(SDK_SOURCE_EXCLUDED_PATHS))
  throw new Error('sdk-source-exclusions');
if (sourceArtifacts.some((entry) => /(^|\/)(node_modules|\.git)(\/|$)/.test(entry.path)))
  throw new Error('sdk-source-unportable-tree');
if (
  sourceArtifacts.some(
    (entry) =>
      entry.path === `${sourcePrefix}.gitmodules` ||
      entry.path.startsWith(`${sourcePrefix}forgeax-engine-assets/`),
  )
)
  throw new Error('sdk-source-private-dependency');
assertSourceDependencyInventory(manifest.source, manifest.artifacts);

function contained(parent, child) {
  const childPath = relative(parent, child);
  return (
    childPath !== '' &&
    childPath !== '..' &&
    !childPath.startsWith(`..${sep}`) &&
    !childPath.startsWith(sep)
  );
}

const expectedResources = sdkResourceManifest();
if (JSON.stringify(manifest.resources) !== JSON.stringify(expectedResources))
  throw new Error('sdk-resource-allowlist-manifest');
for (const resource of manifest.resources) {
  const resourceRoot = resolve(sourceRoot, resource.sourceRoot);
  if (!contained(sourceRoot, resourceRoot))
    throw new Error(`sdk-resource-source-path: ${resource.id}`);
  const actualFiles = (await filesUnder(resourceRoot))
    .map((path) => relative(resourceRoot, path).split(sep).join('/'))
    .sort();
  const expectedFiles = [...resource.files].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    throw new Error(`sdk-resource-allowlist-drift: ${resource.id}`);
  for (const file of resource.files) {
    const path = resolve(resourceRoot, file);
    if (!contained(resourceRoot, path)) throw new Error(`sdk-resource-source-path: ${resource.id}`);
    await readFile(path);
    const artifactPath = `${manifest.source.root}/${resource.sourceRoot}/${file}`;
    if (!manifest.artifacts.some((entry) => entry.path === artifactPath))
      throw new Error(`sdk-resource-unmanifested: ${artifactPath}`);
  }
  const packageEntry = manifest.packages.find((entry) => entry.name === resource.package);
  if (packageEntry === undefined) throw new Error(`sdk-resource-package-missing: ${resource.id}`);
  const packageArchive = resolve(sdkRoot, packageEntry.root);
  if (!contained(sdkRoot, packageArchive))
    throw new Error(`sdk-resource-package-path: ${resource.id}`);
  const packageRootParts = resource.packageRoot.split('/');
  if (resource.packageRoot.startsWith('/') || packageRootParts.includes('..'))
    throw new Error(`sdk-resource-package-path: ${resource.id}`);
  const packageResourceRoot = resolve(packageArchive, resource.packageRoot);
  if (!contained(packageArchive, packageResourceRoot))
    throw new Error(`sdk-resource-package-path: ${resource.id}`);
  const packageResourcePrefix = `${packageEntry.root}/${resource.packageRoot}/`;
  const listing = manifest.artifacts
    .filter(({ path }) => path.startsWith(packageResourcePrefix))
    .map(({ path }) => path.slice(packageResourcePrefix.length))
    .sort();
  if (JSON.stringify(listing) !== JSON.stringify(expectedFiles))
    throw new Error(`sdk-resource-package-drift: ${resource.id}`);
}

const expectedTemplateResources = sdkTemplateResourceManifest();
if (JSON.stringify(manifest.templateResources) !== JSON.stringify(expectedTemplateResources))
  throw new Error('sdk-template-resource-allowlist-manifest');
for (const resource of manifest.templateResources) {
  const sourceResourceRoot = resolve(sourceRoot, resource.root);
  const archiveResourceRoot = resolve(sdkRoot, resource.root);
  if (!contained(sourceRoot, sourceResourceRoot) || !contained(sdkRoot, archiveResourceRoot))
    throw new Error(`sdk-template-resource-path: ${resource.id}`);
  const expectedFiles = [...resource.files].sort();
  for (const [resourceRoot, artifactPrefix] of [
    [sourceResourceRoot, `${manifest.source.root}/${resource.root}`],
    [archiveResourceRoot, resource.root],
  ]) {
    const actualFiles = (await filesUnder(resourceRoot))
      .map((path) => relative(resourceRoot, path).split(sep).join('/'))
      .sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
      throw new Error(`sdk-template-resource-allowlist-drift: ${resource.id}`);
    for (const file of resource.files) {
      const path = resolve(resourceRoot, file);
      if (!contained(resourceRoot, path))
        throw new Error(`sdk-template-resource-path: ${resource.id}`);
      await readFile(path);
      if (!manifest.artifacts.some((entry) => entry.path === `${artifactPrefix}/${file}`))
        throw new Error(`sdk-template-resource-unmanifested: ${artifactPrefix}/${file}`);
    }
  }
}

// Every distributable template gets the same deterministic typecheck and Web
// package-document contract in the archive. Template discovery remains the
// single source of truth; do not hard-code a retired template path here.
const templateTypecheckScript = 'pnpm exec tsc --noEmit';
for (const { id: template } of SDK_TEMPLATES) {
  const templateRoot = resolve(sdkRoot, 'templates', template);
  const packageManifest = JSON.parse(await readFile(resolve(templateRoot, 'package.json'), 'utf8'));
  if (packageManifest.scripts?.typecheck !== templateTypecheckScript) {
    throw new Error(`sdk-template-typecheck-script: ${template}`);
  }
  await readFile(resolve(templateRoot, 'tsconfig.json'));
  await readFile(resolve(templateRoot, 'README.md'));
  await readFile(resolve(templateRoot, 'docs', 'feedback.md'));
  // A new project must not commit DevKit caches and run records.
  if (!ignoresProjectState(await readFile(resolve(templateRoot, '.gitignore'), 'utf8'))) {
    throw new Error(`sdk-template-state-not-ignored: ${template}`);
  }
}

for (const path of [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'bin/forgeax.mjs',
  'skills/forgeax-engine-assets/SKILL.md',
  'skills/forgeax-engine-cli/SKILL.md',
  'skills/forgeax-engine-rhi-debug/SKILL.md',
  'skills/forgeax-engine-sdk/references/api-index.md',
  'skills/forgeax-engine-sdk/references/api/core.md',
  'skills/forgeax-engine-sdk/references/api/play.md',
  'skills/forgeax-engine-sdk/references/feature-catalog.md',
  'templates/empty/AGENTS.md',
  'templates/empty/.gitignore',
  'templates/empty/forge.json',
  'templates/empty/package.json',
  'templates/empty/tsconfig.json',
  'templates/empty/vitest.config.ts',
  'templates/empty/assets/world/world.scene.pack.json',
  'templates/empty/template.json',
  'templates/empty/README.md',
  'templates/empty/docs/feedback.md',
  'templates/game-3d/README.md',
  'templates/game-3d/docs/feedback.md',
  'templates/game-3d/package.json',
]) {
  await readFile(resolve(sdkRoot, path));
}
const forgeaxBin = resolve(sdkRoot, 'bin', 'forgeax');
if (process.platform !== 'win32') {
  await access(forgeaxBin, constants.X_OK);
  const help = await execFileAsync(forgeaxBin, ['help', '--json'], { env: process.env });
  const parsedHelp = JSON.parse(help.stdout);
  const groups = parsedHelp?.value?.nodes?.map((node) => node.name) ?? [];
  if (parsedHelp?.ok !== true || !groups.includes('project') || !groups.includes('dev')) {
    throw new Error('sdk-cli-help');
  }
}
for (const path of [
  '.forgeax-public-distribution',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'rules/forgeax-engine-usage.md',
  'skills/forgeax-engine-cli/SKILL.md',
  'skills/forgeax-engine-sdk/SKILL.md',
]) {
  await readFile(resolve(sourceRoot, path));
}
for (const entry of manifest.source.prebuiltWasm) {
  const packageRoot = resolve(sourceRoot, entry.root);
  if (!contained(sourceRoot, packageRoot))
    throw new Error(`sdk-source-wasm-path: ${entry.package}`);
  for (const file of entry.files) {
    const path = resolve(packageRoot, file);
    if (!contained(packageRoot, path)) throw new Error(`sdk-source-wasm-path: ${entry.package}`);
    await readFile(path);
    const artifactPath = `${manifest.source.root}/${entry.root}/${file}`;
    if (!manifest.artifacts.some((artifactEntry) => artifactEntry.path === artifactPath))
      throw new Error(`sdk-source-wasm-unmanifested: ${artifactPath}`);
  }
}
const checkPath = resolve(dirname(archive), 'SHA256SUMS');
const checksums = await readFile(checkPath, 'utf8');
const digest = sha256(await readFile(archive));
if (!checksums.includes(`${digest}  ${basename(archive)}`)) throw new Error('sdk-archive-checksum');
const project = resolve(unpackRoot, 'game');
const toolBin = resolve(unpackRoot, 'tool-bin');
await mkdir(toolBin);
const pnpmShim = resolve(toolBin, 'pnpm');
await writeFile(pnpmShim, `#!/bin/sh\nexec corepack ${sourcePackageManager} "$@"\n`);
await chmod(pnpmShim, 0o755);
const offlineEnv = {
  ...process.env,
  PATH: `${toolBin}:${process.env.PATH ?? ''}`,
  FORGEAX_SDK_ROOT: sdkRoot,
  npm_config_offline: 'true',
  CI: 'true',
};
const sourceEnv = { ...offlineEnv, PATH: process.env.PATH ?? '' };
delete sourceEnv.FORGEAX_SDK_ROOT;
delete sourceEnv.npm_config_offline;
const sourcePnpm = (args, options) =>
  execFileAsync('corepack', [sourcePackageManager, ...args], options);
// Finish source preparation before consumer tests and native browser probes.
// A rejected consumer must not retire the unpack directory beneath a live
// source build. Source browser smoke still runs later on a fresh X server.
const sourceBuildPnpm = (args) =>
  sourcePnpm(args, {
    streamOutput: true,
    cwd: sourceRoot,
    env: sourceEnv,
    maxBuffer: 128 * 1024 * 1024,
  });
if (selected('source')) {
  await sdkStage('buildSourceSnapshot', async () => {
    await sourceBuildPnpm(['install', '--frozen-lockfile', '--ignore-scripts']);
    await sdkStage('verify single-module source editing', () =>
      verifySdkSourceEdit({ sdkRoot, output: resolve(unpackRoot, 'source-edit'), env: sourceEnv }),
    );
    if (profile === 'pr-consumer') return;
    // Keep the independent cold source-build proof after the seeded-package journey.
    await execFileAsync(process.execPath, ['scripts/clean-build-outputs.mjs'], {
      cwd: sourceRoot,
      env: sourceEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
    await sourceBuildPnpm(['build:engine']);
    if (profile === 'full') await sourceBuildPnpm(['build:tools']);
    // Source Preview starts Vite from source; its template journey never reads
    // apps/preview/dist. Keep the clean Engine/tools proof and let both real
    // source consumers use its independently produced shared inputs.
  });
}
const initializedSdk = await execFileAsync(
  'node',
  [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'project', 'init', '--json'],
  {
    cwd: sdkRoot,
    env: offlineEnv,
    maxBuffer: 64 * 1024 * 1024,
  },
);
const initializedSdkEnvelope = JSON.parse(initializedSdk.stdout.trim());
const authoringGuide = 'skills/forgeax-engine-authoring';
if (
  initializedSdkEnvelope.value?.onboarding?.read?.join('\n') !==
  [resolve(sdkRoot, 'AGENTS.md'), resolve(sdkRoot, authoringGuide, 'SKILL.md')].join('\n')
) {
  throw new Error('sdk-init-agent-onboarding');
}
if (selected('project')) {
  const forbiddenProject = resolve(sdkRoot, 'game');
  let forbiddenResult;
  try {
    await execFileAsync(
      'node',
      [
        resolve(sdkRoot, 'bin', 'forgeax.mjs'),
        'project',
        'new',
        '--root',
        forbiddenProject,
        '--template',
        'empty',
        '--json',
      ],
      { env: offlineEnv, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (cause) {
    const stdout =
      typeof cause === 'object' && cause !== null && 'stdout' in cause ? String(cause.stdout) : '';
    try {
      forbiddenResult = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`sdk-project-target-guard-output: ${stdout}`);
    }
  }
  const forbiddenCode = forbiddenResult?.error?.detail?.code ?? forbiddenResult?.error?.code;
  if (forbiddenCode !== 'project-target-inside-sdk')
    throw new Error(`sdk-project-target-guard: ${JSON.stringify(forbiddenResult)}`);
  let forbiddenProjectExists = true;
  try {
    await access(forbiddenProject);
  } catch {
    forbiddenProjectExists = false;
  }
  if (forbiddenProjectExists) throw new Error('sdk-project-target-guard-mutated-sdk');
  const createdProject = await execFileAsync(
    'node',
    [
      resolve(sdkRoot, 'bin', 'forgeax.mjs'),
      'project',
      'new',
      project,
      '--template',
      'empty',
      '--package-name',
      '@acceptance/renamed-game',
      '--json',
    ],
    {
      env: offlineEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const createdProjectEnvelope = JSON.parse(createdProject.stdout.trim());
  if (
    createdProjectEnvelope.value?.onboarding?.read?.join('\n') !==
    [resolve(project, 'AGENTS.md'), resolve(project, authoringGuide, 'SKILL.md')].join('\n')
  ) {
    throw new Error('sdk-new-agent-onboarding');
  }
  if (createdProjectEnvelope.value?.sdkUpdate?.status !== 'skipped')
    throw new Error('sdk-new-update-check-offline');
  const sharedBuildCache = resolve(sdkRoot, SDK_BUILD_CACHE_SEED);
  const shippedBuildCache = await buildCacheEntries(sharedBuildCache);
  const projectBuildCache = resolve(project, '.forgeax/ddc/build-cache');
  const buildCacheReference = JSON.parse(
    await readFile(resolve(project, '.forgeax/sdk-build-cache.json'), 'utf8'),
  );
  if (
    buildCacheReference !== (await realpath(sharedBuildCache)) ||
    !shippedBuildCache.some((entry) => entry.startsWith('scriptable-pack-products/')) ||
    (await buildCacheEntries(projectBuildCache)).length !== 0
  ) {
    throw new Error('sdk-new-shared-build-cache-missing');
  }
  // The API directory links one file per domain; every link must resolve in the project.
  const apiReferenceRoot = resolve(project, authoringGuide, 'references');
  const apiDirectory = await readFile(resolve(apiReferenceRoot, 'api-index.md'), 'utf8');
  const apiDomainFiles = [...apiDirectory.matchAll(/\]\((api\/[a-z0-9-]+\.md)\)/g)].map(
    (match) => match[1],
  );
  if (apiDomainFiles.length === 0) throw new Error('sdk-api-index-domains-missing');
  for (const file of apiDomainFiles) await readFile(resolve(apiReferenceRoot, file));
  await readFile(resolve(apiReferenceRoot, 'feature-catalog.md'));
  await readFile(resolve(project, authoringGuide, 'SKILL.md'));
  const projectWorkspace = await readFile(resolve(project, 'pnpm-workspace.yaml'), 'utf8');
  if (!projectWorkspace.includes('trustLockfile: true'))
    throw new Error('sdk-game-lockfile-trust-missing');
  if (
    !projectWorkspace.includes('verifyDepsBeforeRun: install') ||
    !projectWorkspace.includes('frozenLockfile: true')
  )
    throw new Error('sdk-game-run-install-policy-missing');
  if (!projectWorkspace.includes('enableGlobalVirtualStore: false'))
    throw new Error('sdk-game-virtual-store-policy-missing');
  const projectManifestPath = resolve(project, 'forge.json');
  const projectManifest = JSON.parse(await readFile(projectManifestPath, 'utf8'));
  const inspectedPlugins = await execFileAsync(
    'pnpm',
    ['exec', 'forgeax', 'asset', 'plugin', 'inspect', '--json'],
    { cwd: project, env: offlineEnv, maxBuffer: 64 * 1024 * 1024 },
  );
  const pluginDefinitions = JSON.parse(inspectedPlugins.stdout.trim()).value.assets;
  const sceneOwner = pluginDefinitions.find(({ guid }) => guid === projectManifest.roots.engine);
  const defaultSceneGuid = sceneOwner?.asset.config?.scene;
  const projectScopeId = projectManifest.id;
  const projectPackagePath = resolve(project, 'package.json');
  const projectPackage = JSON.parse(await readFile(projectPackagePath, 'utf8'));
  if (
    typeof defaultSceneGuid !== 'string' ||
    projectScopeId !== 'game' ||
    projectManifest.name !== 'game' ||
    projectPackage.name !== '@acceptance/renamed-game'
  )
    throw new Error('sdk-template-manifest-identity');
  if (
    projectManifest.entry !== undefined ||
    projectManifest.schemaVersion !== '3.0.0' ||
    typeof projectManifest.roots?.engine !== 'string'
  ) {
    throw new Error('sdk-empty-source-layout-manifest');
  }
  const emptyScenePackage = await readSdkProjectDocument(
    execFileAsync,
    project,
    resolve(project, 'assets', 'world', 'world.scene.pack.json'),
    'direct-pack',
  );
  const emptySceneAsset = emptyScenePackage.assets[0];
  const emptySceneEntities = emptySceneAsset?.payload?.entities;
  const emptySceneEntityValues =
    emptySceneEntities !== null &&
    typeof emptySceneEntities === 'object' &&
    !Array.isArray(emptySceneEntities)
      ? Object.values(emptySceneEntities)
      : [];
  if (
    emptyScenePackage.assets.length !== 1 ||
    emptySceneAsset?.guid !== defaultSceneGuid ||
    emptySceneAsset.kind !== 'scene' ||
    emptySceneAsset.refs?.length !== 0 ||
    emptySceneEntities === null ||
    typeof emptySceneEntities !== 'object' ||
    Array.isArray(emptySceneEntities) ||
    emptySceneEntityValues.length !== 0
  ) {
    throw new Error('sdk-empty-authored-scene-not-empty');
  }
  await readFile(resolve(project, 'assets', '__tests__', 'empty-project.test.ts'));
  for (const retiredPath of ['src', 'src/main.ts', 'src/__tests__']) {
    let exists = true;
    try {
      await access(resolve(project, retiredPath));
    } catch (cause) {
      if (cause?.code === 'ENOENT') exists = false;
      else throw cause;
    }
    if (exists) throw new Error(`sdk-empty-source-layout-retired: ${retiredPath}`);
  }
  // Select the custom package identity before installation through the public
  // CLI. A later package.json identity edit is reconciled once by the project's
  // frozen `verifyDepsBeforeRun: install` policy; see sdk-project-identity.mjs.
  const interactiveLocalEnv = { ...offlineEnv, CI: '' };
  const renamedProjectDoctor = await execFileAsync(
    'pnpm',
    ['exec', 'forgeax', 'project', 'check', '--json'],
    {
      cwd: project,
      env: interactiveLocalEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (renamedProjectDoctor.stderr.includes('node_modules are out of sync'))
    throw new Error('sdk-game-first-command-dependency-drift');
  await verifyProjectIdentityReconcile(project, offlineEnv);
  const helpResult = await execFileAsync(
    'node',
    [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'help', 'dev'],
    {
      cwd: project,
      env: interactiveLocalEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (!helpResult.stdout.includes('forgeax dev') || !helpResult.stdout.includes('capture'))
    throw new Error('sdk-dev-help-output');
  await execFileAsync('pnpm', ['exec', 'forgeax', 'project', 'skill', 'verify', '--json'], {
    cwd: project,
    env: offlineEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  // The custom-base build below exercises the build CLI; packaging produces
  // the default dist used by the catalog and preview assertions.
  for (const script of ['doctor', 'test']) {
    await execFileAsync('pnpm', ['run', script, '--json'], {
      cwd: project,
      env: offlineEnv,
      maxBuffer: 128 * 1024 * 1024,
    });
  }
  await execFileAsync('pnpm', ['run', 'typecheck', '--pretty', 'false'], {
    cwd: project,
    env: offlineEnv,
    maxBuffer: 128 * 1024 * 1024,
  });

  async function verifyStandaloneDocumentBoundary(outputRoot) {
    const scripts = (await filesUnder(outputRoot)).filter((path) => /\.(?:js|mjs)$/.test(path));
    if (scripts.length === 0) throw new Error('sdk-game-javascript-missing');
    for (const path of scripts) {
      const source = await readFile(path, 'utf8');
      if (/\blocation\s*\.\s*(?:assign|replace)\s*\(/.test(source))
        throw new Error(`sdk-game-document-navigation: ${relative(outputRoot, path)}`);
    }
    return scripts.length;
  }

  const staticOutput = resolve(unpackRoot, 'static-game');
  await execFileAsync(
    'pnpm',
    ['run', 'build', '--base', '/games/forgeax-sdk-game/', '--out-dir', staticOutput, '--json'],
    {
      cwd: project,
      env: offlineEnv,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  const cookedBuildCache = await buildCacheEntries(projectBuildCache);
  if (cookedBuildCache.length > 0)
    throw new Error(`sdk-new-shared-build-cache-miss: ${cookedBuildCache.join(', ')}`);
  if (
    JSON.stringify(await buildCacheEntries(sharedBuildCache)) !== JSON.stringify(shippedBuildCache)
  )
    throw new Error('sdk-new-shared-build-cache-mutated');
  const staticManifest = JSON.parse(
    await readFile(resolve(staticOutput, 'forgeax-dist.json'), 'utf8'),
  );
  if (
    staticManifest.base !== '/games/forgeax-sdk-game/' ||
    staticManifest.project?.id !== projectScopeId ||
    !Array.isArray(staticManifest.artifacts) ||
    !staticManifest.artifacts.some((entry) => entry.path === 'index.html') ||
    !staticManifest.artifacts.some((entry) => entry.path === 'pack-index.json') ||
    !staticManifest.artifacts.some((entry) => entry.path === 'shaders/manifest.json')
  ) {
    throw new Error('sdk-static-build-output-closure');
  }

  const staticDocumentScripts = await verifyStandaloneDocumentBoundary(staticOutput);

  async function verifyGamePackage(projectRoot, output) {
    const packageResult = await execFileAsync(
      'pnpm',
      ['exec', 'forgeax', 'project', 'package', '--output', output, '--json'],
      {
        cwd: projectRoot,
        env: offlineEnv,
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    const entries = (await execFileAsync('unzip', ['-Z1', output])).stdout
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0);
    const documents = ['README.md', 'docs/feedback.md'];
    for (const document of documents) {
      if (!entries.includes(document)) throw new Error(`sdk-game-package-document: ${document}`);
      const source = await readFile(resolve(projectRoot, document), 'utf8');
      const archived = await execFileAsync('unzip', ['-p', output, document], {
        maxBuffer: 16 * 1024 * 1024,
      });
      if (archived.stdout !== source)
        throw new Error(`sdk-game-package-document-drift: ${document}`);
    }
    const envelope = JSON.parse(packageResult.stdout.trim().split(/\r?\n/).at(-1) ?? '{}');
    if (JSON.stringify(envelope.value?.documents) !== JSON.stringify(documents))
      throw new Error('sdk-game-package-document-report');
    return {
      output,
      documents,
      documentScriptsWithoutNavigation: await verifyStandaloneDocumentBoundary(
        resolve(projectRoot, 'dist'),
      ),
    };
  }

  const packagedProject = await verifyGamePackage(
    project,
    resolve(unpackRoot, 'empty-game-web.zip'),
  );

  // Resolve the public import from the installed candidate project, rather than
  // the verifier checkout (the package has an ESM-only public entry).
  const readProjectCatalog = (path) =>
    readSdkProjectDocument(execFileAsync, project, path, 'catalog');
  const builtCatalog = await readProjectCatalog(resolve(project, 'dist/pack-index.json'));
  const defaultSceneEntry = Array.isArray(builtCatalog)
    ? builtCatalog.find((entry) => entry.guid === defaultSceneGuid)
    : undefined;
  if (
    defaultSceneEntry?.kind !== 'scene' ||
    defaultSceneEntry.lifecycle !== 'current' ||
    typeof defaultSceneEntry.packageUrl !== 'string'
  ) {
    throw new Error('sdk-scriptable-pack-build-closure');
  }
  const defaultScenePackage = await readSdkProjectDocument(
    execFileAsync,
    project,
    resolve(project, 'dist', defaultSceneEntry.packageUrl.replace(/^\/+/, '')),
  );
  if (
    !Array.isArray(defaultScenePackage.assets) ||
    !defaultScenePackage.assets.some(
      (asset) => asset.guid === defaultSceneGuid && asset.kind === 'scene',
    )
  ) {
    throw new Error('sdk-scriptable-pack-package');
  }
  const generatedHost = await readFile(
    resolve(project, '.forgeax', 'generated', 'main.ts'),
    'utf8',
  );
  if (
    !generatedHost.includes('activateExecutionRoot') ||
    !generatedHost.includes('createPrograms')
  ) {
    throw new Error('sdk-plugin-root-runtime-closure');
  }
  const pluginInventory = JSON.parse(
    await readFile(resolve(project, 'dist/plugin-program-inventory.json'), 'utf8'),
  );
  if (!pluginInventory) throw new Error('sdk-plugin-program-inventory-missing');

  function spawnProjectServer(command, cwd) {
    const detached = process.platform !== 'win32';
    const args =
      command === 'dev' ? ['run', command, '--json'] : ['run', command, '--json', '--port', '0'];
    return processRunner.spawn('pnpm', args, {
      cwd,
      env: offlineEnv,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async function liveProjectUrl(value) {
    const direct = value?.urls?.local?.[0] ?? value?.urls?.network?.[0] ?? value?.url;
    if (typeof direct === 'string') return direct;
    const endpoint = value?.endpoint;
    if (typeof endpoint !== 'string') return undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${endpoint}/status`);
        if (response.ok) {
          const status = await response.json();
          const url = status?.value?.url;
          if (typeof url === 'string') return url;
        }
      } catch {}
      await new Promise((accept) => setTimeout(accept, 100));
    }
    return undefined;
  }

  async function stopLiveProject(value) {
    const endpoint = value?.endpoint;
    if (typeof endpoint !== 'string') return;
    try {
      await fetch(`${endpoint}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {}
  }

  async function verifyDev() {
    const detached = process.platform !== 'win32';
    const child = spawnProjectServer('dev', project);
    const exited = new Promise((accept) => child.once('exit', accept));
    let stdout = '';
    let stderr = '';
    let liveValue;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    try {
      const deadline = Date.now() + LIVE_DEV_STARTUP_TIMEOUT_MS;
      let envelope;
      while (Date.now() < deadline) {
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('{')) continue;
          try {
            const candidate = JSON.parse(line);
            if (candidate.command === 'dev' || candidate.command === 'dev start')
              envelope = candidate;
          } catch {}
        }
        if (envelope !== undefined) break;
        if (child.exitCode !== null) throw new Error(`sdk-dev-exited: ${stdout}\n${stderr}`);
        await new Promise((accept) => setTimeout(accept, 100));
      }
      if (envelope?.ok !== true) throw new Error(`sdk-dev-not-ready: ${stdout}\n${stderr}`);
      liveValue = envelope.value?.value ?? envelope.value;
      const url = await liveProjectUrl(liveValue);
      if (typeof url !== 'string') throw new Error(`sdk-dev-url-missing: ${stdout}\n${stderr}`);
      const catalogUrl = new URL(
        `/__pack/scopes/${encodeURIComponent(projectScopeId)}/1/catalog.json`,
        url,
      ).toString();
      const catalogDeadline = Date.now() + 30_000;
      let snapshot;
      while (Date.now() < catalogDeadline) {
        try {
          const response = await fetch(catalogUrl);
          if (response.ok) {
            const candidate = await response.json();
            if (candidate.authority === 'authoritative') {
              snapshot = candidate;
              break;
            }
          }
        } catch {}
        await new Promise((accept) => setTimeout(accept, 100));
      }
      if (snapshot === undefined) {
        throw new Error(`sdk-scriptable-pack-dev-catalog: ${catalogUrl}`);
      }
      const snapshotPath = resolve(unpackRoot, 'dev-catalog.json');
      await writeFile(snapshotPath, JSON.stringify(snapshot));
      const entries = await readProjectCatalog(snapshotPath);
      if (!entries.some((entry) => entry.guid === defaultSceneGuid && entry.kind === 'scene')) {
        throw new Error(`sdk-scriptable-pack-dev-catalog: ${catalogUrl}`);
      }
      return { url, catalogUrl, defaultSceneGuid };
    } finally {
      await stopLiveProject(liveValue);
      if (child.exitCode === null) {
        if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      }
      await exited;
    }
  }

  const devEvidence = await sdkStage('verifyDev', () => verifyDev());

  async function verifyPreview() {
    const detached = process.platform !== 'win32';
    const child = spawnProjectServer('preview', project);
    const exited = new Promise((accept) => child.once('exit', accept));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    try {
      const deadline = Date.now() + LIVE_DEV_STARTUP_TIMEOUT_MS;
      let envelope;
      while (Date.now() < deadline) {
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('{')) continue;
          try {
            const candidate = JSON.parse(line);
            if (candidate.command === 'preview' || candidate.command === 'project preview')
              envelope = candidate;
          } catch {}
        }
        if (envelope !== undefined) break;
        if (child.exitCode !== null) throw new Error(`sdk-preview-exited: ${stdout}\n${stderr}`);
        await new Promise((accept) => setTimeout(accept, 100));
      }
      if (envelope?.ok !== true) throw new Error(`sdk-preview-not-ready: ${stdout}\n${stderr}`);
      const previewValue = envelope.value?.value ?? envelope.value;
      const url = previewValue?.urls?.local?.[0] ?? previewValue?.urls?.network?.[0];
      if (typeof url !== 'string') throw new Error(`sdk-preview-url-missing: ${stdout}\n${stderr}`);
      const response = await fetch(url);
      const html = await response.text();
      if (!response.ok || !html.includes('<canvas id="app"'))
        throw new Error('sdk-preview-static-closure');
      if (expandedArchive) return { previewUrl: url };
      const previewBrowser = await sdkGpuStage('verifyCompactPreview', () =>
        verifyCompactPreview(url),
      );
      return { previewUrl: url, previewBrowser };
    } finally {
      if (child.exitCode === null) {
        if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      }
      await exited;
    }
  }

  async function verifySelectedTemplate() {
    const selectedProject = resolve(unpackRoot, 'game-3d');
    await execFileAsync(
      'node',
      [
        resolve(sdkRoot, 'bin', 'forgeax.mjs'),
        'project',
        'new',
        selectedProject,
        '--template',
        'game-3d',
        '--json',
      ],
      { env: offlineEnv, maxBuffer: 64 * 1024 * 1024 },
    );
    const selectedManifest = JSON.parse(
      await readFile(resolve(selectedProject, 'forge.json'), 'utf8'),
    );
    const selectedPackage = JSON.parse(
      await readFile(resolve(selectedProject, 'package.json'), 'utf8'),
    );
    if (
      selectedManifest.id !== 'game-3d' ||
      selectedManifest.name !== 'game-3d' ||
      selectedPackage.name !== '@local/game-3d'
    ) {
      throw new Error('sdk-template-selection');
    }
    await execFileAsync('pnpm', ['exec', 'forgeax', 'project', 'skill', 'verify', '--json'], {
      cwd: selectedProject,
      env: offlineEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const script of ['doctor', 'test']) {
      await execFileAsync('pnpm', ['run', script, '--json'], {
        cwd: selectedProject,
        env: offlineEnv,
        maxBuffer: 128 * 1024 * 1024,
      });
    }
    await execFileAsync('pnpm', ['run', 'typecheck', '--pretty', 'false'], {
      cwd: selectedProject,
      env: offlineEnv,
      maxBuffer: 128 * 1024 * 1024,
    });
    // Packaging owns the production build. Check the authored template first,
    // then reduce only the disposable build/browser fixture.
    if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') {
      await reduceTestProject(selectedProject);
    }
    const packageEvidence = await verifyGamePackage(
      selectedProject,
      resolve(unpackRoot, 'game-3d-web.zip'),
    );
    const browser = await sdkGpuStage('verifyProjectBrowser', () =>
      verifyProjectBrowser(selectedProject, selectedManifest.id),
    );
    return {
      id: 'game-3d',
      project: selectedProject,
      commands: [
        'project new',
        'project skill verify',
        'project check',
        'project test',
        'typecheck',
        'project package',
        'dev start',
      ],
      package: packageEvidence,
      browser,
    };
  }

  async function verifyProjectBrowser(projectRoot, scopeId) {
    const detached = process.platform !== 'win32';
    const child = spawnProjectServer('dev', projectRoot);
    const exited = new Promise((accept) => child.once('exit', accept));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const resources = { browser: undefined, page: undefined };
    let operationError;
    let result;
    let cleanupFailure;
    let liveValue;
    const pageErrors = [];
    const consoleErrors = [];
    const failedResponses = [];
    const diagnostics = {
      pageErrors,
      consoleErrors,
      failedResponses,
      serverOutput: () => ({ stdout: boundedTail(stdout), stderr: boundedTail(stderr) }),
    };
    try {
      const deadline = Date.now() + LIVE_DEV_STARTUP_TIMEOUT_MS;
      let envelope;
      while (Date.now() < deadline) {
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('{')) continue;
          try {
            const candidate = JSON.parse(line);
            if (candidate.command === 'dev' || candidate.command === 'dev start')
              envelope = candidate;
          } catch {}
        }
        if (envelope !== undefined) break;
        if (child.exitCode !== null) throw new Error(`sdk-selected-dev-exited: ${stderr}`);
        await new Promise((accept) => setTimeout(accept, 100));
      }
      if (envelope?.ok !== true)
        throw new Error(`sdk-selected-dev-not-ready: ${stdout}\n${stderr}`);
      liveValue = envelope.value?.value ?? envelope.value;
      const url = await sdkStage('selectedBrowser.liveUrl', () => liveProjectUrl(liveValue));
      if (typeof url !== 'string')
        throw new Error(`sdk-selected-dev-url-missing: ${stdout}\n${stderr}`);
      await sdkStage('selectedBrowser.catalog', () => waitForProjectPackCatalog(url, scopeId));
      const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
      const startup = await startSelectedProjectBrowser(
        chromeChannel,
        selectedBrowserArgs(chromeChannel),
        url,
        diagnostics,
        resources,
      );
      const runtime = await sdkStage('selectedBrowser.runtimeProbe', () =>
        resources.page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          const frameId = canvas?.forgeaxFrameProgress?.submitted?.frameId;
          return {
            canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
            engineFrameId: Number.isSafeInteger(frameId) && frameId > 0 ? frameId : null,
          };
        }),
      );
      const before = await readSelectedPlayerProjection(resources.page);
      // Match the real game smoke route: click the rendered canvas center so the
      // activation cannot land on a full-screen UI mount or an unrelated overlay.
      // A locator-relative top-left click is not a reliable gameplay gesture for
      // the generated game-3d host, whose guide UI is mounted above the canvas.
      const canvas = resources.page.locator('canvas').first();
      const canvasBox = await sdkStage('selectedBrowser.canvasBounds', () => canvas.boundingBox());
      if (canvasBox === null || canvasBox.width <= 0 || canvasBox.height <= 0) {
        throw new Error(`sdk-selected-canvas-bounds-missing: ${JSON.stringify(canvasBox)}`);
      }
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;
      await sdkStage('selectedBrowser.pointerMove', () =>
        resources.page.mouse.move(centerX, centerY),
      );
      await sdkStage('selectedBrowser.inputSettle', () => resources.page.waitForTimeout(100));
      await sdkStage('selectedBrowser.pointerClick', () =>
        resources.page.mouse.click(centerX, centerY),
      );
      let after;
      await sdkStage('selectedBrowser.keyDown', () => resources.page.keyboard.down('KeyW'));
      try {
        // Poll from Node so the asynchronous game-owned read is awaited before
        // deciding whether to release KeyW. A Promise-returning waitForFunction
        // predicate can be accepted as a truthy handle before its value resolves.
        // The game-owned position and FixedTick are the semantic witnesses: a
        // software-GPU renderer can stop publishing new submission ids while
        // the ECS simulation and selected player continue to advance correctly.
        const movementDeadline = Date.now() + 120_000;
        let lastWitness;
        while (Date.now() < movementDeadline) {
          await sdkStage('selectedBrowser.inputSettle', () => resources.page.waitForTimeout(100));
          const candidate = await readSelectedPlayerProjection(resources.page, movementDeadline);
          lastWitness = candidate;
          if (
            candidate.position[2] < before.position[2] - 0.01 &&
            candidate.fixedTick > before.fixedTick
          ) {
            after = candidate;
            break;
          }
        }
        if (after === undefined) {
          throw new Error(
            `sdk-selected-third-person-movement-timeout: ${JSON.stringify({ before, lastWitness })}`,
          );
        }
      } finally {
        await sdkStage('selectedBrowser.keyUp', () => resources.page.keyboard.up('KeyW'));
      }
      const movementDelta = after.position.map((value, index) => value - before.position[index]);
      const movementDistance = Math.hypot(...movementDelta);
      if (
        movementDelta[2] >= -0.01 ||
        movementDistance < 0.01 ||
        after.fixedTick <= before.fixedTick
      ) {
        throw new Error(
          `sdk-selected-third-person-static: ${JSON.stringify({ before, after, movementDelta, movementDistance })}`,
        );
      }
      let renderer = await sdkStage('selectedBrowser.rendererHealth', () =>
        resources.page.evaluate(() => globalThis.__forgeaxGameInspection?.renderer()),
      );
      if (canRecoverSelectedBrowser(renderer, startup.recovery)) {
        // Hosted Chrome Beta + lavapipe can lose the external GPU instance after
        // a valid gameplay journey. Match the source-template verifier's
        // fresh-process viability proof before attributing that runner teardown
        // to the archived SDK runtime.
        await sdkStage('selectedBrowser.recovery.closeBrowser', () =>
          closeSelectedBrowser(resources.browser),
        );
        resources.browser = undefined;
        resources.page = undefined;
        resources.browser = await sdkStage('selectedBrowser.launch', () =>
          launchSelectedBrowser(chromeChannel, chromeArgs),
        );
        resources.page = await createProjectPage(resources.browser, 'fresh-process-recovery');
        await waitForProjectPage(resources.page, url, diagnostics, 'fresh-process-recovery');
        renderer = await sdkStage('selectedBrowser.rendererHealth', () =>
          resources.page.evaluate(() => globalThis.__forgeaxGameInspection?.renderer()),
        );
      }
      assertSelectedBrowserHealthy(renderer, diagnostics);
      result = {
        url,
        runtime,
        startupRecovery: startup.recovery,
        movement: { before, after, delta: movementDelta, distance: movementDistance },
        renderer,
        pageErrors: 0,
        consoleErrors: 0,
      };
    } catch (cause) {
      const evidence = await frameTimeoutDiagnostics(resources.page, diagnostics, 'gameplay');
      operationError = new Error(`sdk-selected-gameplay-failed: ${JSON.stringify(evidence)}`, {
        cause,
      });
    } finally {
      const cleanupErrors = [];
      const attemptCleanup = async (label, cleanup) => {
        try {
          await sdkStage(`selectedBrowser.cleanup.${label}`, () => cleanup());
        } catch (cause) {
          cleanupErrors.push(new Error(`${label} cleanup failed`, { cause }));
        }
      };
      // Each resource owns an independent teardown attempt. A page/context
      // rejection must never prevent Chromium, the Vite child, or its exit
      // receipt from being drained before the source-template phase starts.
      await attemptCleanup('page', () => closeSelectedPage(resources.page));
      await attemptCleanup('browser', () => closeSelectedBrowser(resources.browser));
      await attemptCleanup('live daemon', () => stopLiveProject(liveValue));
      if (child.exitCode === null) {
        await attemptCleanup('server signal', () => {
          if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        });
      }
      await attemptCleanup('server exit', () => exited);
      if (cleanupErrors.length > 0) {
        cleanupFailure = new AggregateError(cleanupErrors, 'SDK browser cleanup failed');
      }
    }
    if (operationError !== undefined) {
      if (cleanupFailure !== undefined) {
        throw new AggregateError([operationError, cleanupFailure], String(operationError), {
          cause: operationError,
        });
      }
      throw operationError;
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    return result;
  }

  function assertSelectedBrowserHealthy(renderer, { pageErrors, consoleErrors, failedResponses }) {
    if (renderer?.state !== 'alive' || !Number.isSafeInteger(renderer.frameId)) {
      throw new Error(`sdk-selected-renderer-not-alive: ${JSON.stringify(renderer)}`);
    }
    if (pageErrors.length > 0 || consoleErrors.length > 0 || failedResponses.length > 0) {
      throw new Error(
        `sdk-selected-browser-errors: ${JSON.stringify({ pageErrors, consoleErrors, failedResponses })}`,
      );
    }
  }

  async function waitForProjectPackCatalog(url, scopeId) {
    const catalogUrl = new URL(`/__pack/scopes/${encodeURIComponent(scopeId)}/1/catalog.json`, url);
    const deadline = Date.now() + 30_000;
    let lastFailure = 'no response';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(catalogUrl, { cache: 'no-store' });
        if (response.ok) {
          const catalog = await response.json();
          if (catalog.authority === 'authoritative') return;
          lastFailure = `catalog-authority: ${String(catalog.authority)}`;
        } else {
          lastFailure = `${response.status}: ${await response.text()}`;
        }
      } catch (cause) {
        lastFailure = cause instanceof Error ? cause.message : String(cause);
      }
      await sleep(100);
    }
    throw new Error(`sdk-selected-pack-catalog-not-ready: ${lastFailure}`);
  }

  async function closeSelectedPage(page) {
    if (page === undefined || page.isClosed()) return;
    await closeSelectedResource('page', async () => {
      // The gameplay click owns a native pointer lock. Retire that input lease
      // before Chromium disposes the context; a locked SwiftShader game can
      // otherwise stall Target.disposeBrowserContext after healthy gameplay.
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => document.pointerLockElement === null, undefined, {
        timeout: CLEANUP_TIMEOUT_MS,
      });
      await page.close();
    });
  }

  async function closeSelectedResource(label, close, timeoutMs = CLEANUP_TIMEOUT_MS) {
    const closed = await Promise.race([
      Promise.resolve()
        .then(close)
        .then(() => true),
      sleep(timeoutMs).then(() => false),
    ]);
    if (!closed) throw new Error(`${label} cleanup incomplete after ${timeoutMs}ms`);
  }

  /**
   * Drain every explicitly-created context before closing Chromium. Playwright
   * normally folds this into browser.close(), but headed Chrome's GPU process
   * can outlive that promise on the hosted lavapipe runner. The explicit
   * context/page barrier prevents the next SDK verification phase from sharing
   * stale WebGPU work with the previous project.
   */
  async function closeSelectedBrowser(browser) {
    if (browser === undefined) return;
    const errors = [];
    for (const context of browser.contexts()) {
      try {
        await closeSelectedResource('context', () => context.close());
      } catch (cause) {
        errors.push(cause);
      }
    }
    try {
      await closeSelectedResource('browser', () => browser.close(), BROWSER_CLEANUP_TIMEOUT_MS);
    } catch (cause) {
      errors.push(cause);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'browser/context cleanup failed');
    }
  }

  function canRecoverSelectedBrowser(renderer, startupRecovery) {
    return renderer?.state === 'device-lost' && startupRecovery === undefined;
  }

  async function startSelectedProjectBrowser(channel, args, url, diagnostics, resources) {
    let recovery;
    resources.browser = await sdkStage('selectedBrowser.launch', () =>
      launchSelectedBrowser(channel, args),
    );
    resources.page = await createProjectPage(resources.browser, 'movement');
    try {
      await waitForProjectPage(resources.page, url, diagnostics, 'movement');
    } catch (cause) {
      const renderer = await resources.page
        .evaluate(() => globalThis.__forgeaxGameInspection?.renderer())
        .catch(() => undefined);
      if (
        process.platform !== 'linux' ||
        channel !== 'chrome-beta' ||
        !isHostGpuInstanceLoss(renderer)
      )
        throw cause;
      recovery = {
        reason: 'host-gpu-instance-lost',
        renderer,
        error: String(cause).slice(0, 4_000),
      };
      // Only intermediate recovery retires a browser here. The caller owns
      // terminal diagnostics and cleanup, including a failed fresh startup.
      await sdkStage('selectedBrowser.startupRecovery.closeBrowser', () =>
        closeSelectedBrowser(resources.browser),
      );
      resources.browser = undefined;
      resources.page = undefined;
      resources.browser = await sdkStage('selectedBrowser.startupRecovery.launch', () =>
        launchSelectedBrowser(channel, args),
      );
      resources.page = await createProjectPage(resources.browser, 'fresh-process-startup-recovery');
      await waitForProjectPage(resources.page, url, diagnostics, 'fresh-process-startup-recovery');
    }
    return { recovery };
  }

  function isHostGpuInstanceLoss(renderer) {
    try {
      const loss = JSON.parse(renderer?.execution?.render?.lastLoss?.cause ?? 'null');
      return (
        loss?.code === 'device-operation-failed' &&
        loss.detail?.operation === 'renderer-event' &&
        loss.detail?.cause?.code === 'device-lost' &&
        loss.detail.cause.hint ===
          'device-lost reason: unknown; message: A valid external Instance reference no longer exists.'
      );
    } catch {
      return false;
    }
  }

  function selectedBrowserArgs(chromeChannel) {
    const chromeArgs = [
      '--disable-features=MacAppCodeSignClone',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
    ];
    // Hosted Linux runners have no physical display/GPU. Match the repository's
    // proven Chrome Beta + lavapipe/Xvfb lane so the SDK template smoke checks
    // the real WebGPU compositor instead of silently accepting a static canvas.
    if (process.platform === 'linux' && chromeChannel === 'chrome-beta') {
      chromeArgs.push(
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
        '--enable-pointer-lock',
        '--disable-gpu-driver-bug-workarounds',
        '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
        '--autoplay-policy=no-user-gesture-required',
      );
    }
    return chromeArgs;
  }

  async function verifyCompactPreview(url) {
    const channel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
    const browser = await launchSelectedBrowser(channel, selectedBrowserArgs(channel));
    const errors = [];
    try {
      const page = await createProjectPage(browser, 'compactPreview');
      page.on('pageerror', (error) => appendDiagnostic(errors, error.stack ?? String(error)));
      await page.addInitScript(observeCompactPreviewFrames);
      await page.bringToFront();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const observed = await page.waitForFunction(
        (minimum) => {
          const canvas = document.getElementById('app');
          const readyFrames = globalThis.__forgeaxSdkPreviewFrames.get(canvas)?.size ?? 0;
          return readyFrames >= minimum ? readyFrames : false;
        },
        SDK_COMPACT_PREVIEW_FRAMES,
        { timeout: 120_000 },
      );
      if (errors.length > 0) throw new Error('sdk-compact-preview-page-errors');
      return { readyFrames: await observed.jsonValue() };
    } catch (cause) {
      throw new Error(`sdk-compact-preview-browser: ${JSON.stringify(errors)}`, { cause });
    } finally {
      await closeSelectedBrowser(browser);
    }
  }

  function observeCompactPreviewFrames() {
    const framesByCanvas = new WeakMap();
    globalThis.__forgeaxSdkPreviewFrames = framesByCanvas;
    window.addEventListener(
      'forgeax:frame-completed',
      (event) => {
        const canvas = event.target;
        const { frameId, presentation } = event.detail;
        if (canvas !== document.getElementById('app') || presentation !== 'ready') return;
        const frames = framesByCanvas.get(canvas) ?? new Set();
        frames.add(frameId);
        framesByCanvas.set(canvas, frames);
      },
      { capture: true },
    );
  }

  async function launchSelectedBrowser(channel, args) {
    return chromium.launch({
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
      channel,
      args,
      chromiumSandbox: true,
    });
  }

  const MAX_DIAGNOSTIC_ITEMS = 32;
  const DIAGNOSTIC_TEXT_LIMIT = 4_000;

  function appendDiagnostic(values, value) {
    if (values.length < MAX_DIAGNOSTIC_ITEMS) values.push(value);
  }

  function boundedTail(value) {
    return value.length <= DIAGNOSTIC_TEXT_LIMIT ? value : value.slice(-DIAGNOSTIC_TEXT_LIMIT);
  }

  async function frameTimeoutDiagnostics(page, diagnostics, phase) {
    let runtime;
    try {
      runtime = await sdkStage(
        `selectedPage.${phase}.frameDiagnostics`,
        () =>
          page.evaluate(() => {
            const fatal = document.querySelector('#forgeax-fatal');
            const style = fatal === null ? undefined : getComputedStyle(fatal);
            const inspection = globalThis.__forgeaxGameInspection;
            const progress = document.querySelector('canvas')?.forgeaxFrameProgress;
            const receiptMetadata = (frame) =>
              frame === undefined
                ? null
                : {
                    frameId: frame.frameId,
                    deviceGeneration: frame.deviceGeneration,
                    worldIdentity: frame.worldIdentity,
                    presentation: frame.presentation,
                    presentationPendingReason: frame.presentationPendingReason,
                  };
            let renderer;
            let rendererError;
            try {
              renderer = inspection?.renderer?.() ?? null;
            } catch (error) {
              rendererError = String(error);
            }
            return {
              fatal: {
                visible:
                  fatal !== null &&
                  style?.display !== 'none' &&
                  style?.visibility !== 'hidden' &&
                  fatal.getClientRects().length > 0,
                text: fatal?.textContent?.slice(0, 4_000) ?? null,
              },
              submittedFrameId:
                document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId ?? null,
              frameProgress: {
                submitted: receiptMetadata(progress?.submitted),
                completed: receiptMetadata(progress?.completed),
              },
              startup: globalThis.__forgeaxStartup?.inspect?.() ?? null,
              renderer,
              ...(rendererError === undefined ? {} : { rendererError }),
            };
          }),
        10_000,
      );
    } catch (error) {
      runtime = { evaluationError: String(error) };
    }
    let debugArtifacts;
    try {
      debugArtifacts = await preserveFrameFailureEvidence(page, phase);
    } catch (cause) {
      debugArtifacts = { error: String(cause) };
    }
    return {
      phase,
      pageErrors: diagnostics.pageErrors,
      consoleErrors: diagnostics.consoleErrors,
      failedResponses: diagnostics.failedResponses,
      ...runtime,
      debugArtifacts,
      serverOutput: diagnostics.serverOutput(),
    };
  }

  async function preserveFrameFailureEvidence(page, phase) {
    const evidenceRoot = resolve(dirname(archive), 'rhi-capture', basename(unpackRoot));
    await mkdir(evidenceRoot, { recursive: true });
    const screenshotPath = resolve(evidenceRoot, `${phase}.png`);
    let screenshot;
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshot = relative(dirname(archive), screenshotPath);
    } catch (cause) {
      screenshot = { error: String(cause) };
    }

    // The CLI attachment belongs to the daemon's private browser. This page is
    // independently launched, so that recorder cannot supply its failure tape.
    const capture =
      process.env.FORGEAX_RHI_CAPTURE === '1'
        ? { status: 'unavailable', reason: 'selected-page-has-no-cli-capture-attachment' }
        : { status: 'not-requested' };

    const manifest = { phase, screenshot, capture };
    const manifestPath = resolve(evidenceRoot, `${phase}.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { ...manifest, manifest: relative(dirname(archive), manifestPath) };
  }

  async function createProjectPage(browser, phase) {
    return sdkStage(`selectedPage.${phase}.newPage`, () =>
      browser.newPage(
        process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
          ? { viewport: testQuality.viewport }
          : {},
      ),
    );
  }

  async function waitForProjectPage(page, url, diagnostics, phase) {
    const { pageErrors, consoleErrors, failedResponses } = diagnostics;
    // Worker inspections are admitted at a live frame boundary. Activate the
    // actual page before startup and baseline reads, without synthesizing ticks.
    await sdkStage(`selectedPage.${phase}.focus`, () => page.bringToFront());
    page.on('pageerror', (error) => appendDiagnostic(pageErrors, error.stack ?? String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') appendDiagnostic(consoleErrors, message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        appendDiagnostic(failedResponses, { status: response.status(), url: response.url() });
      }
    });
    const pageUrl = new URL(url);
    if (process.env.FORGEAX_RHI_CAPTURE === '1')
      pageUrl.searchParams.set('forgeax-rhi-capture', '1');
    await sdkStage(`selectedPage.${phase}.navigate`, () =>
      page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    );
    try {
      await sdkStage(`selectedPage.${phase}.canvasReady`, () =>
        page.waitForFunction(
          () => {
            const canvas = document.querySelector('canvas');
            return (canvas?.width ?? 0) > 0 && (canvas?.height ?? 0) > 0;
          },
          undefined,
          { timeout: 30_000, polling: 100 },
        ),
      );
    } catch (cause) {
      throw new Error(
        `sdk-selected-browser-not-ready: ${JSON.stringify({ phase, pageErrors, consoleErrors, failedResponses })}`,
        { cause },
      );
    }
    try {
      await sdkStage(`selectedPage.${phase}.firstFrame`, () =>
        page.waitForFunction(
          () => {
            const fatal = document.querySelector('#forgeax-fatal');
            const style = fatal === null ? undefined : getComputedStyle(fatal);
            if (
              fatal !== null &&
              style?.display !== 'none' &&
              style?.visibility !== 'hidden' &&
              fatal.getClientRects().length > 0
            ) {
              throw new Error(`sdk-selected-startup-failed: ${fatal.textContent?.slice(0, 4_000)}`);
            }
            return (
              (document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId ?? 0) > 0
            );
          },
          undefined,
          { timeout: 120_000, polling: 100 },
        ),
      );
    } catch (cause) {
      const evidence = await frameTimeoutDiagnostics(page, diagnostics, phase);
      throw new Error(`sdk-selected-render-frame-not-submitted: ${JSON.stringify(evidence)}`, {
        cause,
      });
    }
    try {
      // The generated host can submit its first clear frame while the selected
      // game's async plugin is still loading its scene UI and gameplay assets.
      // The game-3d guide mount is the template-owned readiness witness for both
      // independently launched browser runs.
      await sdkStage(`selectedPage.${phase}.gameReady`, () =>
        page.waitForFunction(
          () => (document.querySelector('#game-ui')?.childElementCount ?? 0) > 0,
          undefined,
          { timeout: 120_000, polling: 100 },
        ),
      );
    } catch (cause) {
      throw new Error(`sdk-selected-game-not-ready: ${phase}`, { cause });
    }
    try {
      const projectionDeadline = Date.now() + 120_000;
      while (
        !(await sdkStage(
          `selectedPage.${phase}.inspectionList`,
          () =>
            page.evaluate(
              async () =>
                (
                  await globalThis.__forgeaxGameInspection?.list()
                )?.reads.includes('game-3d.player') === true,
            ),
          Math.max(1, projectionDeadline - Date.now()),
        ))
      ) {
        if (Date.now() >= projectionDeadline) throw new Error('game projection deadline exceeded');
        await sleep(100);
      }
    } catch (cause) {
      throw new Error(`sdk-selected-game-projection-not-ready: ${phase}`, { cause });
    }
    try {
      // The first ready receipt starts the generated page's short fade. Keep the
      // gameplay gesture behind that boundary so the startup input gate cannot
      // intentionally discard a keydown that the smoke then expects to move the
      // selected player.
      await sdkStage(`selectedPage.${phase}.startupEntered`, () =>
        page.waitForFunction(
          () => {
            const loading = document.querySelector('#forgeax-loading');
            if (!(loading instanceof HTMLElement)) return true;
            const style = getComputedStyle(loading);
            return style.display === 'none' && loading.getAttribute('data-fading') !== 'true';
          },
          undefined,
          { timeout: 120_000, polling: 50 },
        ),
      );
    } catch (cause) {
      const evidence = await frameTimeoutDiagnostics(page, diagnostics, phase);
      throw new Error(`sdk-selected-startup-not-entered: ${JSON.stringify(evidence)}`, { cause });
    }
  }

  async function readSelectedPlayerProjection(page, deadline = Date.now() + 120_000) {
    const value = await sdkStage(
      'selectedBrowser.playerRead',
      () => page.evaluate(() => globalThis.__forgeaxGameInspection?.read('game-3d.player')),
      Math.max(1, deadline - Date.now()),
    );
    const position = value?.position;
    const fixedTick = value?.simulation?.fixedTick;
    if (
      !Array.isArray(position) ||
      position.length !== 3 ||
      !position.every(Number.isFinite) ||
      !Number.isSafeInteger(fixedTick) ||
      fixedTick < 0
    ) {
      throw new Error(`sdk-selected-game-projection-invalid: ${JSON.stringify(value)}`);
    }
    return { position, fixedTick };
  }

  const previewEvidence = await sdkStage('verifyPreview', () => verifyPreview());
  const selectedTemplateEvidence = expandedArchive
    ? { selectedTemplate: await sdkStage('verifySelectedTemplate', () => verifySelectedTemplate()) }
    : {};

  projectEvidence = {
    offlineProject: project,
    projectTargetProtection: {
      code: forbiddenResult.error.code,
      sdkRoot,
      rejectedTarget: forbiddenProject,
    },
    projectLayout: {
      roots: projectManifest.roots,
      starterTest: 'assets/__tests__/empty-project.test.ts',
      authoredScene: 'assets/world/world.scene.pack.json',
      retiredRootPaths: ['src', 'src/main.ts', 'src/__tests__'],
    },
    commands: [
      'project new',
      'project skill verify',
      'project check',
      'project test',
      'typecheck',
      'project build',
      'project package',
      'dev start',
      'project preview',
    ],
    package: packagedProject,
    scriptablePack: {
      defaultSceneGuid,
      build: { packageUrl: defaultSceneEntry.packageUrl },
      dev: devEvidence,
    },
    ...selectedTemplateEvidence,
    staticBuild: {
      output: staticOutput,
      base: staticManifest.base,
      artifacts: staticManifest.artifacts.length,
      documentScriptsWithoutNavigation: staticDocumentScripts,
    },
    ...previewEvidence,
  };
}

async function verifySourceTemplate() {
  // Keep the original report, screenshot and RHI diagnostics after unpack cleanup.
  // Each attempt owns a directory so a retry cannot overwrite its failed witness.
  const sourceSmokeDir = resolve(dirname(archive), 'source-template-smoke', basename(unpackRoot));
  const sourceSmokeArgs = ['--filter', '@forgeax/preview', 'smoke:templates'];
  const sourceSmokeOptions = {
    streamOutput: true,
    cwd: sourceRoot,
    env: {
      ...sourceEnv,
      FORGEAX_TEMPLATE_SMOKE_DIR: sourceSmokeDir,
      FORGEAX_TEMPLATE_SMOKE_PORT: '5287',
      FORGEAX_TEMPLATE_SMOKE_SLUGS: SDK_TEMPLATES.map((entry) => basename(entry.sourceRoot)).join(
        ',',
      ),
      FORGEAX_TEMPLATE_SMOKE_GAME3D_COLLISION_MODE: 'omit-sdk-source',
    },
    maxBuffer: 128 * 1024 * 1024,
  };
  // The selected SDK project and the source-distribution template smoke are
  // independent browser journeys. On headed Linux CI, give the second
  // journey a fresh X server so Chrome/lavapipe cannot retain the first
  // journey's external Instance or queue state across the phase boundary.
  if (process.platform === 'linux' && sourceSmokeOptions.env.FORGEAX_BROWSER_HEADLESS === '0') {
    try {
      await execFileAsync(
        'xvfb-run',
        [
          '-a',
          'env',
          'FORGEAX_BROWSER_HEADLESS=0',
          'corepack',
          sourcePackageManager,
          ...sourceSmokeArgs,
        ],
        sourceSmokeOptions,
      );
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
      await sourcePnpm(sourceSmokeArgs, sourceSmokeOptions);
    }
  } else {
    await sourcePnpm(sourceSmokeArgs, sourceSmokeOptions);
  }
  return JSON.parse(await readFile(resolve(sourceSmokeDir, 'report.json'), 'utf8'));
}

if (selected('source') && expandedArchive) {
  sourceTemplateEvidence = await sdkStage('verifySourceTemplate', () => verifySourceTemplate());
  for (const entry of SDK_TEMPLATES) {
    const slug = basename(entry.sourceRoot);
    const evidence = sourceTemplateEvidence.templates?.find((template) => template.slug === slug);
    const expectedStatus = slug === 'game-3d' ? 'passed-with-omissions' : 'passed';
    const unexpectedConsoleErrors = evidence?.consoleErrors.filter(
      (message) => !evidence.expectedConsoleErrors.includes(message),
    );
    if (
      evidence === undefined ||
      evidence.status !== expectedStatus ||
      unexpectedConsoleErrors.length !== 0 ||
      evidence.pageErrors.length !== 0 ||
      evidence.badResponses.length !== 0
    ) {
      throw new Error(`sdk-template-browser-errors:${slug}: ${JSON.stringify(evidence)}`);
    }
  }
  if (sourceTemplateEvidence.status !== 'passed-with-omissions') {
    throw new Error(`sdk-source-template-report-status:${sourceTemplateEvidence.status}`);
  }
  const sourceGame3dEvidence = sourceTemplateEvidence.templates?.find(
    (template) => template.slug === 'game-3d',
  )?.game3d;
  const sourceGame3dCollision = sourceGame3dEvidence?.collision;
  if (
    sourceGame3dCollision?.status !== 'omitted' ||
    sourceGame3dCollision.reason !== 'sdk-source-distribution' ||
    Object.keys(sourceGame3dCollision).sort().join(',') !== 'reason,status'
  ) {
    throw new Error(
      `sdk-source-template-collision-contract:${JSON.stringify(sourceGame3dCollision)}`,
    );
  }
  const sourceHostGpuInstanceLoss = sourceGame3dEvidence?.hostGpuInstanceLoss;
  const expectedHostGpuKeys =
    sourceHostGpuInstanceLoss?.status === 'omitted'
      ? 'eventPhase,eventSequence,fixedTick,freshProcessFrameId,journeyCompleteSequence,lastHealthyFrameId,message,phase,reason,status'
      : 'fixedTick,lastHealthyFrameId,phase,status';
  const sourceJourneyRendererHealth = sourceGame3dEvidence?.rendererHealth;
  const sourceFreshProcessRendererHealth = sourceGame3dEvidence?.freshProcessRendererHealth;
  if (
    (sourceHostGpuInstanceLoss?.status !== 'omitted' &&
      sourceHostGpuInstanceLoss?.status !== 'not-observed') ||
    sourceHostGpuInstanceLoss.phase !== 'journey-complete' ||
    typeof sourceHostGpuInstanceLoss.fixedTick !== 'number' ||
    sourceHostGpuInstanceLoss.fixedTick <= 0 ||
    typeof sourceHostGpuInstanceLoss.lastHealthyFrameId !== 'number' ||
    sourceHostGpuInstanceLoss.lastHealthyFrameId <= 0 ||
    Object.keys(sourceHostGpuInstanceLoss).sort().join(',') !== expectedHostGpuKeys ||
    (sourceHostGpuInstanceLoss.status === 'not-observed'
      ? sourceJourneyRendererHealth?.reason !== 'alive' ||
        sourceFreshProcessRendererHealth !== undefined
      : sourceHostGpuInstanceLoss.reason !== 'sdk-source-host-gpu-instance-loss' ||
        sourceHostGpuInstanceLoss.message !==
          'A valid external Instance reference no longer exists.' ||
        sourceHostGpuInstanceLoss.eventPhase !== 'interaction' ||
        typeof sourceHostGpuInstanceLoss.eventSequence !== 'number' ||
        typeof sourceHostGpuInstanceLoss.journeyCompleteSequence !== 'number' ||
        sourceHostGpuInstanceLoss.eventSequence >=
          sourceHostGpuInstanceLoss.journeyCompleteSequence ||
        sourceJourneyRendererHealth?.reason !== 'device-lost' ||
        sourceFreshProcessRendererHealth?.reason !== 'alive' ||
        typeof sourceHostGpuInstanceLoss.freshProcessFrameId !== 'number' ||
        sourceHostGpuInstanceLoss.freshProcessFrameId <= 0 ||
        sourceFreshProcessRendererHealth.frame?.frameId !==
          sourceHostGpuInstanceLoss.freshProcessFrameId)
  ) {
    throw new Error(
      `sdk-source-host-gpu-instance-loss-contract:${JSON.stringify(sourceHostGpuInstanceLoss)}`,
    );
  }
  // PR core already proves source edits through the embedded View Host and
  // independent cold Engine templates; full/release additionally rebuild View.
  if (profile === 'full') {
    await sdkGpuStage('verifyPublicSourceViewTool', () =>
      execFileAsync(
        process.execPath,
        [resolve(sourceRoot, 'tools/view/scripts/verify-diagnostic-pages-integration.mjs')],
        {
          streamOutput: true,
          backendEvidenceDirectory: resolve(dirname(archive), 'view-source', 'backend'),
          cwd: sourceRoot,
          env: {
            ...sourceEnv,
            FORGEAX_VIEW_ENGINE_SOURCE_ROOT: sourceRoot,
            FORGEAX_VIEW_TOOL_PACKAGE: resolve(sourceRoot, 'tools/view'),
            FORGEAX_VIEW_ENGINE_PACKAGE: resolve(sourceRoot, 'packages/engine'),
            FORGEAX_VIEW_TEMPLATE_ROOT: resolve(sourceRoot, 'templates/game-3d'),
            FORGEAX_VIEW_EVIDENCE_ROOT: resolve(dirname(archive), 'view-source'),
            DEBUG: [sourceEnv.DEBUG, 'pw:browser', 'pw:api'].filter(Boolean).join(','),
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
  }
}

// PRs prove a real clean source template launch and a packaged View consumer.
// The independent full CLI lifecycle belongs to release verification.
const ownsIndependentRun = !prPreflight && selected('project');
if (ownsIndependentRun && expandedArchive) {
  await sdkGpuStage('verifyIndependentRun', () =>
    execFileAsync(
      process.execPath,
      [resolve(import.meta.dirname, '../../packages/devkit/scripts/verify-independent-run.mjs')],
      {
        cwd: sdkRoot,
        env: {
          ...offlineEnv,
          FORGEAX_INDEPENDENT_EVIDENCE_ROOT: resolve(dirname(archive), 'independent-run'),
          FORGEAX_INDEPENDENT_ENGINE_PACKAGE: resolve(
            sdkRoot,
            '.forgeax/cli-runtime/node_modules/@forgeax/engine',
          ),
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    ).then((result) => {
      console.error(result.stderr);
      return result;
    }),
  );
}

if (selected('project') && expandedArchive) {
  // Partitioned release gates retain installed diagnostics with npm. The ZIP
  // checks both installed View languages and reopens a saved JavaScript publication.
  // A standalone, unpartitioned archive verification keeps full diagnostics.
  if (group === 'all')
    await sdkGpuStage('verifyPairedViewTool', () =>
      execFileAsync(
        process.execPath,
        [
          resolve(
            import.meta.dirname,
            '../../tools/view/scripts/verify-diagnostic-pages-integration.mjs',
          ),
        ],
        {
          cwd: sdkRoot,
          env: {
            ...offlineEnv,
            FORGEAX_VIEW_ENGINE_SOURCE_ROOT: sourceRoot,
            FORGEAX_VIEW_TOOL_PACKAGE: resolve(
              sdkRoot,
              '.forgeax/cli-runtime/node_modules/@forgeax/view',
            ),
            FORGEAX_VIEW_ENGINE_PACKAGE: resolve(
              sdkRoot,
              '.forgeax/cli-runtime/node_modules/@forgeax/engine',
            ),
            FORGEAX_VIEW_TEMPLATE_ROOT: resolve(sdkRoot, 'templates/game-3d'),
            FORGEAX_VIEW_EVIDENCE_ROOT: resolve(dirname(archive), 'view-zip'),
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
  if (group !== 'all' && !prPreflight)
    await sdkStage('verifyInstalledViewRuntimeJS', () =>
      verifySdkViewRuntime({
        sdkRoot,
        evidenceRoot: resolve(dirname(archive), 'view-zip'),
        env: offlineEnv,
        group: 'view',
      }),
    );
}

// Keep the live TypeScript publication alongside the JavaScript recovery witness.
// Default release qualification retains the original complete serial order.
if (selected('project') && expandedArchive) {
  await sdkStage('verifyInstalledViewRuntime', () =>
    verifySdkViewRuntime({
      sdkRoot,
      evidenceRoot: resolve(dirname(archive), 'view-zip'),
      env: offlineEnv,
      group,
    }),
  );
}

if (selected('project') && expandedArchive && process.platform === 'linux') {
  projectEvidence.modeling = await sdkGpuStage('verifyInstalledModelingCli', () =>
    verifySdkModeling({
      sdkRoot,
      project,
      evidenceRoot: resolve(dirname(archive), 'modeling-sdk', basename(unpackRoot)),
      env: offlineEnv,
      run: execFileAsync,
    }),
  );
}

await sdkStage('verifyImmutableSdkStore', () =>
  mapConcurrent(
    manifest.artifacts.filter((entry) => entry.path.startsWith('store/')),
    async (expected) => {
      // SQLite index/journal sidecars remain the existing mutable-cache exclusion.
      if (isPnpmSqliteStoreArtifact(expected.path)) return;
      const actual = await artifact(sdkRoot, resolve(sdkRoot, expected.path));
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        throw new Error(`sdk-consumer-mutated-store: ${expected.path}`);
    },
  ),
);

const result = {
  ok: true,
  group,
  profile,
  deferredValidation: [
    ...(profile !== 'full' && selected('source') ? ['cold-source-view-diagnostics'] : []),
    ...(prPreflight && selected('project') ? ['zip-javascript-view-owned-by-npm'] : []),
    ...(!expandedArchive && selected('source')
      ? ['cold-source-fleet', 'source-template-browser']
      : []),
    ...(!expandedArchive && selected('project')
      ? ['zip-game-3d-owned-by-npm', 'independent-run', 'installed-view', 'installed-modeling']
      : []),
  ],
  archive,
  sha256: digest,
  sdkVersion: manifest.sdkVersion,
  engineCommit: manifest.engineCommit,
  viewCommit: manifest.viewCommit,
  capabilities: manifest.capabilities,
  source: manifest.source,
  ...projectEvidence,
  ...(sourceTemplateEvidence === undefined ? {} : { sourceTemplate: sourceTemplateEvidence }),
};
await writeFile(
  resolve(
    dirname(archive),
    group === 'all' ? 'sdk-verify-result.json' : `sdk-verify-${group}-result.json`,
  ),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
