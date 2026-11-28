import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundleEngineArchive } from './engine-bundle.mjs';
import { sdkBuildEnvironment } from './sdk-build-environment.mjs';
import { sdkLauncherSource } from './sdk-launcher.mjs';
import {
  artifact,
  assertNoRetiredPackageFiles,
  detectPnpmStoreFormat,
  fetchWithRetry,
  filesUnder,
  isBundledEngineMemberName,
  localSdkDiscoveryLinks,
  mapConcurrent,
  normalizeLicenseReport,
  normalizePackageArchive,
  normalizePnpmStore,
  normalizeSdkRegistryLockfile,
  prepareWasmPackageForPack,
  referenceSdkPackageCopies,
  SDK_CAPABILITIES,
  SDK_MANIFEST_VERSION,
  SDK_RESOURCE_ALLOWLIST,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_FORMAT,
  SDK_SOURCE_ROOT,
  SDK_SOURCE_WASM,
  SDK_TEMPLATE_RESOURCE_ALLOWLIST,
  SDK_TEMPLATES,
  sdkResourceManifest,
  sdkTemplateResourceManifest,
  sha256,
  stable,
  stageSdkCarrier,
  streamFile,
  writePackageArchive,
} from './sdk-lib.mjs';
import { archiveEngineSource, seedSourcePackageBuilds } from './sdk-source.mjs';
import { sdkStage } from './sdk-stage.mjs';
import {
  SDK_BUILD_CACHE_SEED,
  seedTemplateBuildCache,
  stageSdkBuildCache,
} from './sdk-template-cache.mjs';
import {
  pinViewRegistryDependencies,
  stageViewConsumerSkills,
  stageViewToolPackage,
} from './sdk-view.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const engineOnly = args.includes('--engine-only');
const emitEnginePackage = engineOnly || args.includes('--emit-engine-package');
const engineGuideRoot = resolve(root, 'scripts/forgeax/sdk-view-guides');
const sdkViewGuide = engineOnly ? engineGuideRoot : undefined;
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const devkitPackage = JSON.parse(
  await readFile(resolve(root, 'packages/devkit/package.json'), 'utf8'),
);
const sdkVitestVersion = devkitPackage.dependencies?.vitest;
if (typeof sdkVitestVersion !== 'string') throw new Error('sdk-vitest-version-missing');
const packageManager = rootPackage.packageManager;
const packageManagerMatch = /^pnpm@(\d+)\.(\d+)\.(\d+)$/.exec(
  typeof packageManager === 'string' ? packageManager : '',
);
if (packageManagerMatch === null) throw new Error('sdk-package-manager-invalid');
const pnpmVersion = packageManagerMatch.slice(1).join('.');
const version = value('--version') ?? `0.0.0-dev.${await git(['rev-parse', '--short=12', 'HEAD'])}`;
const skipGame3dTemplateCache = args.includes('--skip-game-3d-template-cache');
if (
  skipGame3dTemplateCache &&
  (engineOnly ||
    !args.includes('--reuse-core-build') ||
    !/^0\.0\.0-pr\.[0-9a-f]{40}$/.test(version))
)
  throw new Error('sdk-compact-template-cache-requires-pr-build');
const outputRoot = resolve(
  root,
  value('--output') ?? (engineOnly ? 'artifacts/engine' : 'artifacts/sdk'),
);
const stagingRoot = engineOnly
  ? await mkdtemp(resolve(tmpdir(), 'forgeax-engine-package-'))
  : outputRoot;
const stage = resolve(stagingRoot, 'forgeax-sdk');
const engineStage = engineOnly ? stage : resolve(stagingRoot, '.engine-authoring-stage');
const archive = resolve(outputRoot, `forgeax-sdk-v${version}.zip`);
const sourceRoot = resolve(stage, SDK_SOURCE_ROOT);
const pnpmMetadataCache = resolve(stagingRoot, '.pnpm-metadata-cache');
const npmRoot = resolve(stagingRoot, 'npm');
const packageArchives = resolve(npmRoot, 'packages');
const canonicalKitPackageRoot = resolve(root, 'packages/preview/assets/canonical-kit');
const canonicalKitRoot = resolve(stagingRoot, '.canonical-kit');

async function useEngineTemplateRegistryPolicy(template) {
  const { parse, stringify } = await import('yaml');
  const policy = resolve(template, 'pnpm-workspace.yaml');
  const workspace = parse(await readFile(policy, 'utf8'));
  delete workspace.supportedArchitectures;
  await writeFile(policy, stringify(workspace));
}

function value(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function processInvocation(file, commandArgs) {
  if (process.platform !== 'win32' || (file !== 'corepack' && file !== 'pnpm')) {
    return { file, args: commandArgs };
  }

  // Windows exposes Corepack through .cmd shims, which execFile cannot launch.
  // Invoke the same Corepack JavaScript entrypoint through Node with literal argv.
  const corepackCli = resolve(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js');
  return {
    file: process.execPath,
    args: [corepackCli, ...(file === 'pnpm' ? ['pnpm'] : []), ...commandArgs],
  };
}

async function run(file, commandArgs, options = {}) {
  const { env, streamOutput = false, ...rest } = options;
  const invocation = processInvocation(file, commandArgs);
  return sdkStage([file, ...commandArgs].join(' ').slice(0, 240), () => {
    const pending = execFileAsync(invocation.file, invocation.args, {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      ...rest,
      env: { ...process.env, CI: process.env.CI ?? 'true', ...env },
    });
    if (streamOutput) {
      pending.child.stdout?.on('data', (chunk) => process.stderr.write(chunk));
      pending.child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    }
    return pending;
  });
}

async function git(commandArgs) {
  return (await run('git', commandArgs)).stdout.trim();
}

async function zipWithInputs(commandArgs, cwd, inputs) {
  await new Promise((accept, reject) => {
    const child = spawn('zip', commandArgs, { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? accept() : reject(new Error(`zip exited ${code}`))));
    child.stdin.end(inputs);
  });
}

async function copySdkResources(destination, sourceOverrides = new Map()) {
  for (const entry of SDK_RESOURCE_ALLOWLIST) {
    const overrideRoot = sourceOverrides.get(entry.id);
    for (const file of entry.files) {
      const source =
        overrideRoot === undefined
          ? resolve(root, entry.sourceRoot, file)
          : resolve(overrideRoot, file);
      try {
        await readFile(source);
      } catch (error) {
        throw new Error(`sdk-resource-allowlist-missing: ${entry.id}/${file}`, { cause: error });
      }
      const target = resolve(destination, entry.sourceRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    const resourceRoot = resolve(destination, entry.sourceRoot);
    const actual = (await filesUnder(resourceRoot))
      .map((path) => relative(resourceRoot, path).split(sep).join('/'))
      .sort();
    const expected = [...entry.files].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`sdk-resource-allowlist-drift: ${entry.id}`);
    }
  }
}

async function copySdkTemplateResources(destination) {
  for (const entry of SDK_TEMPLATE_RESOURCE_ALLOWLIST) {
    for (const file of entry.files) {
      const source = resolve(root, entry.sourceRoot, file);
      try {
        await readFile(source);
      } catch (error) {
        throw new Error(`sdk-template-resource-missing: ${entry.id}/${file}`, { cause: error });
      }
      const target = resolve(destination, entry.destinationRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    const resourceRoot = resolve(destination, entry.destinationRoot);
    const actual = (await filesUnder(resourceRoot))
      .map((path) => relative(resourceRoot, path).split(sep).join('/'))
      .sort();
    const expected = [...entry.files].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`sdk-template-resource-allowlist-drift: ${entry.id}`);
    }
  }
}

const status = await git(['status', '--porcelain']);
if (status !== '' && !args.includes('--allow-dirty')) {
  throw new Error(
    `sdk-dirty-checkout: commit or stash all changes before building the SDK\n${status}`,
  );
}
const viewRoot = resolve(root, 'tools/view');
await readFile(resolve(viewRoot, 'LICENSE')).catch((cause) => {
  throw new Error('sdk-view-license-missing: View owner must authorize public distribution', {
    cause,
  });
});
const viewCommit = await git(['rev-parse', 'HEAD:tools/view']);
const actualViewCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: viewRoot })).stdout.trim();
if (
  actualViewCommit !== viewCommit ||
  (await run('git', ['status', '--porcelain'], { cwd: viewRoot })).stdout.trim()
)
  throw new Error('sdk-view-source-mismatch');
// Reject incomplete checked substrate inputs before the expensive source build.
// Packages without install helpers generate their native closure in prebuild.
for (const entry of SDK_SOURCE_WASM.filter((entry) => entry.postinstallScripts?.length !== 0))
  for (const file of entry.files) {
    await readFile(resolve(root, entry.root, file)).catch((cause) => {
      throw new Error(`sdk-source-wasm-path: ${entry.package}/${file}`, { cause });
    });
  }
// Presence alone admits stale pre-DYNAMIC_EXECUTION=0 glue from local caches.
// Run the codec owner's actual restricted-host init gate before copying bytes.
await run(process.execPath, ['packages/codec/scripts/verify-transcoder.mjs']);
await run('node', ['scripts/forgeax/check-engine-skills.mjs']);
const licenseReport = stable(
  normalizeLicenseReport(
    // Fail before the expensive Engine/template build when the contributor
    // workspace or its pnpm store cannot produce the authoritative notice set.
    // Cross-platform optional children can lack pnpm store index rows for the
    // current host; their parent package license remains in this notice set.
    JSON.parse(
      (await run('corepack', [packageManager, 'licenses', 'list', '--json', '--no-optional']))
        .stdout,
    ),
    root,
  ),
);
const engineCommit = await git(['rev-parse', 'HEAD']);
const nativePlayerArtifact = value('--native-player-artifact');
if (
  args.includes('--native-player-artifact') &&
  (nativePlayerArtifact === undefined || nativePlayerArtifact.startsWith('--'))
)
  throw new Error('sdk-native-player-artifact-path-missing');

if (!engineOnly) await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(stage, 'packages'), { recursive: true });
await mkdir(resolve(stage, 'store', 'pnpm'), { recursive: true });
await mkdir(resolve(stage, 'templates'), { recursive: true });
await mkdir(resolve(stage, 'skills'), { recursive: true });
await mkdir(resolve(stage, 'schemas'), { recursive: true });
await mkdir(resolve(stage, 'licenses'), { recursive: true });
await mkdir(resolve(stage, 'toolchain', 'wasm'), { recursive: true });
await mkdir(packageArchives, { recursive: true });
await mkdir(sourceRoot, { recursive: true });

await run('node', ['scripts/clean-build-outputs.mjs']);
const engineBuildArgs = ['build:engine'];
if (args.includes('--reuse-core-build')) engineBuildArgs.push('--reuse-core-build');
await run('pnpm', engineBuildArgs, {
  streamOutput: true,
  // Stage the selected environment and receipt together. The SDK transport
  // variant is overlaid only while the Preview package is packed.
  env: {
    ...sdkBuildEnvironment(),
    FORGEAX_SDK_BUILD: '0',
    FORGEAX_CANONICAL_KIT_OUTPUT: canonicalKitRoot,
  },
});
await run(process.execPath, ['packages/modeling-kernel-wasm/scripts/ensure-dist-wasm.mjs']);
await run(process.execPath, ['packages/render-kernel/scripts/ensure-wasm.mjs']);
// A present WASM can still predate the source's animation contract. Exercise
// the owner's tracked source curves through the rebuilt Cook/playback chain.
await run('node', [
  'scripts/ci/run-vitest-projects.mjs',
  'run',
  '--project',
  '@forgeax/engine-fbx',
  'packages/fbx/src/__tests__/animation-fidelity.integration.test.ts',
  '--maxWorkers=1',
]);
await run('node', ['packages/preview/scripts/build-canonical-kit.mjs'], {
  env: { ...process.env, FORGEAX_SDK_BUILD: '1', FORGEAX_CANONICAL_KIT_OUTPUT: canonicalKitRoot },
});
const publicPackages = [];
for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packagePath = resolve(root, 'packages', entry.name, 'package.json');
  try {
    await readFile(packagePath);
  } catch {
    continue;
  }
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  if (
    manifest.private === true ||
    typeof manifest.name !== 'string' ||
    (manifest.name !== '@forgeax/engine' && !isBundledEngineMemberName(manifest.name))
  )
    continue;
  publicPackages.push({
    name: manifest.name,
    version,
    directory: entry.name,
    role: 'runtime',
    root: dirname(packagePath),
  });
}
// Build the fixed tool source into the same package inventory and publisher.
await run('pnpm', ['build:tools']);
publicPackages.push({
  name: '@forgeax/view',
  version,
  directory: 'view',
  root: viewRoot,
  role: 'tool',
});
publicPackages.sort((a, b) => a.name.localeCompare(b.name));

const wasmPackageConfig = new Map(
  SDK_SOURCE_WASM.map(({ package: packageName, files, postinstallScripts }) => [
    packageName,
    {
      postinstallScripts: postinstallScripts ?? ['scripts/ensure-wasm.mjs'],
      wasmFiles: files.map((file) => `pkg/${file}`),
    },
  ]),
);

// wasm-pack emits pkg/.gitignore; npm pack applies nested ignores even when
// pkg is declared in files, so remove this generated control file first.
await Promise.all(
  publicPackages.map((entry) => rm(resolve(entry.root, 'pkg', '.gitignore'), { force: true })),
);

const canonicalKitBackupRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-canonical-kit-'));
const canonicalKitBackup = resolve(canonicalKitBackupRoot, 'canonical-kit');
await cp(canonicalKitPackageRoot, canonicalKitBackup, { recursive: true });
try {
  await rm(canonicalKitPackageRoot, { recursive: true, force: true });
  await cp(canonicalKitRoot, canonicalKitPackageRoot, { recursive: true });
  // Resolve the workspace once. Serial recursive packing preserves the package
  // work and hooks without starting a fresh workspace scan for every tarball.
  const ordinaryPackages = publicPackages.filter(
    (entry) => entry.role === 'runtime' && !wasmPackageConfig.has(entry.name),
  );
  await run('pnpm', [
    '--recursive',
    '--workspace-concurrency=1',
    ...ordinaryPackages.flatMap((entry) => ['--filter', entry.name]),
    'pack',
    '--pack-destination',
    packageArchives,
  ]);
  for (const entry of publicPackages) {
    const wasm = wasmPackageConfig.get(entry.name);
    if (wasm === undefined) continue;
    const staged = await prepareWasmPackageForPack({
      packageRoot: entry.root,
      helperSource: resolve(root, 'scripts/lib/ensure-wasm-lib.mjs'),
      releaseVersion: version,
      ...wasm,
    });
    try {
      await run('pnpm', ['pack', '--pack-destination', packageArchives], {
        cwd: staged.packageRoot,
      });
    } finally {
      await rm(staged.root, { recursive: true, force: true });
    }
  }
} finally {
  await rm(canonicalKitPackageRoot, { recursive: true, force: true });
  await cp(canonicalKitBackup, canonicalKitPackageRoot, { recursive: true });
  await rm(canonicalKitBackupRoot, { recursive: true, force: true });
}
await stageViewToolPackage(viewRoot, resolve(stage, 'tools/view'), version, sdkViewGuide);
if (engineOnly) await pinViewRegistryDependencies(viewRoot, resolve(stage, 'tools/view'));
for (const path of (await filesUnder(packageArchives)).filter((entry) => entry.endsWith('.tgz'))) {
  const { stdout } = await run('tar', ['-xOf', path, 'package/package.json']);
  const manifest = JSON.parse(stdout);
  const { stdout: archiveList } = await run('tar', ['-tzf', path]);
  assertNoRetiredPackageFiles(manifest.name, archiveList.trim().split('\n'));
  await sdkStage(`normalize package ${manifest.name}`, () =>
    normalizePackageArchive(path, execFileAsync, { releaseVersion: version }),
  );
  const releaseName = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  await rename(path, resolve(packageArchives, releaseName));
}

const tarballs = new Map();
for (const path of (await filesUnder(packageArchives)).filter((entry) => entry.endsWith('.tgz'))) {
  const { stdout } = await run('tar', ['-xOf', path, 'package/package.json']);
  const manifest = JSON.parse(stdout);
  const bytes = await readFile(path);
  tarballs.set(manifest.name, {
    path,
    name: manifest.name,
    version: manifest.version,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  });
}
for (const entry of engineOnly ? [] : publicPackages) {
  if (entry.role === 'tool') continue;
  const archiveEntry = tarballs.get(entry.name);
  if (archiveEntry === undefined) throw new Error(`sdk-package-archive-missing: ${entry.name}`);
  const destination = resolve(stage, 'packages', entry.directory);
  await mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', archiveEntry.path, '-C', destination, '--strip-components=1']);
}

const engineBundle = await sdkStage('bundle complete npm Engine', () =>
  bundleEngineArchive({
    engineArchive: tarballs.get('@forgeax/engine').path,
    members: publicPackages
      .filter((entry) => isBundledEngineMemberName(entry.name))
      .map((entry) => ({ ...entry, archive: tarballs.get(entry.name).path })),
    version,
  }),
);
// Bare SDK package contracts remain inspectable. Only complete delivery units
// enter the public npm roster and template lockfiles.
for (const [name, item] of tarballs) {
  if (isBundledEngineMemberName(name)) {
    await rm(item.path);
    tarballs.delete(name);
  }
}
const engineTarball = tarballs.get('@forgeax/engine');
const engineBytes = await readFile(engineTarball.path);
engineTarball.integrity = `sha512-${createHash('sha512').update(engineBytes).digest('base64')}`;
engineTarball.shasum = createHash('sha1').update(engineBytes).digest('hex');

async function normalizeTemplateLockfile(template) {
  const lockfilePath = resolve(template, 'pnpm-lock.yaml');
  const ownedUrls = [...tarballs.values()].map(
    (item) => `http://127.0.0.1:${port}/tarballs/${engineCommit}/${basename(item.path)}`,
  );
  await writeFile(
    lockfilePath,
    normalizeSdkRegistryLockfile(await readFile(lockfilePath, 'utf8'), ownedUrls),
  );
}

const registry = createServer(async (request, response) => {
  const url = request.url ?? '/';
  if (decodeURIComponent(url.split('?', 1)[0]).startsWith('/@forgeax/view')) {
    response.writeHead(404).end();
    return;
  }
  if (url.startsWith('/tarballs/')) {
    const item = [...tarballs.values()].find((entry) => basename(entry.path) === basename(url));
    if (item === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    streamFile(item.path, response);
    return;
  }
  const name = decodeURIComponent(url.slice(1));
  const item = tarballs.get(name);
  if (item !== undefined) {
    const address = registry.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const body = JSON.stringify({
      name,
      'dist-tags': { latest: item.version },
      versions: {
        [item.version]: {
          ...JSON.parse((await run('tar', ['-xOf', item.path, 'package/package.json'])).stdout),
          dist: {
            tarball: `http://127.0.0.1:${port}/tarballs/${engineCommit}/${basename(item.path)}`,
            integrity: item.integrity,
            shasum: item.shasum,
          },
        },
      },
    });
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }
  try {
    const upstream = await fetchWithRetry(`https://registry.npmjs.org${url}`, {
      headers: { accept: request.headers.accept ?? 'application/json' },
    });
    const headers = Object.fromEntries(
      [...upstream.headers.entries()].filter(
        ([name]) =>
          name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding',
      ),
    );
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, headers);
    response.end(body);
  } catch (cause) {
    response.writeHead(502).end(cause instanceof Error ? cause.message : String(cause));
  }
});
const registryPort = 40_000 + (Number.parseInt(engineCommit.slice(0, 8), 16) % 20_000);
await once(registry.listen(registryPort, '127.0.0.1'), 'listening');
const address = registry.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

const dependencies = { '@forgeax/engine': version };
try {
  if (!engineOnly) {
    const toolRuntime = resolve(stage, 'toolchain/cli-runtime');
    await mkdir(toolRuntime, { recursive: true });
    await writeFile(
      resolve(toolRuntime, 'package.json'),
      JSON.stringify(
        {
          name: 'forgeax-sdk-cli-runtime',
          private: true,
          type: 'module',
          packageManager,
          dependencies: { '@forgeax/engine': version, '@forgeax/view': 'file:../../tools/view' },
        },
        null,
        2,
      ),
    );
    await cp(
      resolve(root, 'templates/pnpm-workspace.yaml'),
      resolve(toolRuntime, 'pnpm-workspace.yaml'),
    );
    await run(
      'corepack',
      [
        packageManager,
        'install',
        // The producer writes this lockfile; the copied project policy freezes
        // it only for consumers.
        '--no-frozen-lockfile',
        '--ignore-scripts',
        '--child-concurrency=1',
        '--registry',
        `http://127.0.0.1:${port}`,
        '--store-dir',
        resolve(stage, 'store/pnpm'),
      ],
      { cwd: toolRuntime, env: { ...process.env, XDG_CACHE_HOME: pnpmMetadataCache } },
    );
    await normalizeTemplateLockfile(toolRuntime);
    await rm(resolve(toolRuntime, 'node_modules'), { recursive: true, force: true });
  }
  for (const sdkTemplate of SDK_TEMPLATES) {
    const sourceTemplate = resolve(root, sdkTemplate.sourceRoot);
    const template = resolve(stage, sdkTemplate.sourceRoot);
    await cp(sourceTemplate, template, {
      recursive: true,
      filter: (source) => {
        const path = relative(sourceTemplate, source).split(sep).join('/');
        return path !== 'AGENTS.md' && !/(^|\/)(node_modules|dist|\.forgeax)(\/|$)/.test(path);
      },
    });
    for (const path of (await filesUnder(template)).filter((entry) =>
      /\.[cm]?[jt]sx?$/.test(entry),
    )) {
      const source = await readFile(path, 'utf8');
      const migrated = source.replace(
        /@forgeax\/engine-([a-z0-9-]+)/g,
        (_match, member) => `@forgeax/engine/${member}`,
      );
      if (migrated !== source) await writeFile(path, migrated);
    }
    for (const name of ['AGENTS.md', 'AGENTS.zh-CN.md'])
      await cp(resolve(root, 'templates', name), resolve(template, name));
    await cp(
      resolve(root, 'templates', 'pnpm-workspace.yaml'),
      resolve(template, 'pnpm-workspace.yaml'),
    );
    if (engineOnly) await useEngineTemplateRegistryPolicy(template);
    const sourceTemplateManifest = JSON.parse(
      await readFile(resolve(template, 'package.json'), 'utf8'),
    );
    const templateManifest = {
      name: sourceTemplateManifest.name,
      version: sourceTemplateManifest.version,
      private: true,
      type: 'module',
      license: sourceTemplateManifest.license,
      packageManager,
      scripts: {
        dev: 'forgeax dev start',
        build: 'forgeax project build',
        package: 'forgeax project package',
        serve: 'forgeax project preview',
        preview: 'forgeax project preview',
        doctor: 'forgeax project check',
        test: 'forgeax project test',
        typecheck: 'pnpm exec tsc --noEmit',
      },
      forgeax: sourceTemplateManifest.forgeax,
      dependencies,
      devDependencies: {
        '@types/node': '20.19.40',
        '@webgpu/types': '0.1.71',
        tsx: '4.23.1',
        typescript: '6.0.3',
        vitest: sdkVitestVersion,
      },
    };
    await writeFile(
      resolve(template, 'package.json'),
      `${JSON.stringify(templateManifest, null, 2)}\n`,
    );
    await run(
      'corepack',
      [
        packageManager,
        'install',
        // This install generates the template lockfile (including its
        // packageManagerDependencies); generated games then install it frozen.
        '--no-frozen-lockfile',
        '--child-concurrency=1',
        '--registry',
        `http://127.0.0.1:${port}`,
        '--store-dir',
        resolve(stage, 'store', 'pnpm'),
      ],
      {
        cwd: template,
        env: { ...process.env, XDG_CACHE_HOME: pnpmMetadataCache },
      },
    );
    // The local registry is only a build-time transport. Published templates
    // must resolve owned packages through the selected consumer registry so the
    // npm carrier can install online; the ZIP's immutable store supplies those same integrities
    // offline under the generated lockfile trust boundary and complete packaged store.
    if (!engineOnly) await normalizeTemplateLockfile(template);
  }
} finally {
  await new Promise((accept, reject) =>
    registry.close((error) => (error === undefined ? accept() : reject(error))),
  );
}
await copySdkTemplateResources(stage);
// Build against one cache so the second template can reuse the first
// template's Engine Content products by their normal semantic key.
const seedBuildCache = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-build-cache-'));
try {
  const excludedEnginePacks = new Set(['019fb7ce-3700-7000-8000-000000000000']);
  for (const sdkTemplate of SDK_TEMPLATES) {
    const template = resolve(stage, sdkTemplate.sourceRoot);
    const compactSdk = skipGame3dTemplateCache && sdkTemplate.id === 'game-3d';
    if (compactSdk) await stageSdkBuildCache(seedBuildCache, resolve(stage, SDK_BUILD_CACHE_SEED));
    if (!compactSdk || emitEnginePackage)
      await seedTemplateBuildCache(template, () =>
        sdkStage(`seed ${sdkTemplate.id} template build cache`, () =>
          execFileAsync(
            process.execPath,
            [
              resolve(template, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs'),
              'project',
              'build',
              '--json',
            ],
            {
              cwd: template,
              maxBuffer: 64 * 1024 * 1024,
              env: {
                ...process.env,
                CI: 'true',
                FORGEAX_DISABLE_UPDATE_CHECK: '1',
                FORGEAX_BUILD_CACHE_DIR: seedBuildCache,
              },
            },
          ),
        ),
      );
    await rm(resolve(template, 'node_modules'), { recursive: true, force: true });
    if (engineOnly) await rm(resolve(template, 'pnpm-lock.yaml'));
  }
  // The single Engine package leaves the large Convoy product to the user's
  // first 3D build. Keep the other template products in the shared seed.
  if (!skipGame3dTemplateCache)
    await stageSdkBuildCache(
      seedBuildCache,
      resolve(stage, SDK_BUILD_CACHE_SEED),
      engineOnly ? excludedEnginePacks : undefined,
    );
  if (emitEnginePackage && !engineOnly)
    await stageSdkBuildCache(
      seedBuildCache,
      resolve(engineStage, SDK_BUILD_CACHE_SEED),
      excludedEnginePacks,
    );
} finally {
  await rm(seedBuildCache, { recursive: true, force: true });
}
await rm(pnpmMetadataCache, { recursive: true, force: true });
const pnpmStoreFormat = engineOnly
  ? undefined
  : await detectPnpmStoreFormat(resolve(stage, 'store', 'pnpm'));
if (!engineOnly) {
  await rm(resolve(stage, 'store', 'pnpm', pnpmStoreFormat, 'projects'), {
    recursive: true,
    force: true,
  });
  await sdkStage('normalize offline store', () =>
    normalizePnpmStore(resolve(stage, 'store', 'pnpm'), pnpmStoreFormat),
  );
  await mkdir(resolve(stage, 'bin'), { recursive: true });
  // The SDK archive intentionally has no root node_modules. Bootstrap a small
  // private CLI runtime from the shipped template lockfile/store on first use,
  // then enter the exact Engine umbrella bin so all package dependencies resolve
  // through one published graph. The generated runtime is disposable SDK state,
  // not an additional user-facing entrypoint.
  await writeFile(resolve(stage, 'bin', 'forgeax.mjs'), sdkLauncherSource(packageManager));
  await writeFile(
    resolve(stage, 'bin', 'forgeax'),
    '#!/bin/sh\nexec node "$(dirname "$0")/forgeax.mjs" "$@"\n',
  );
  await chmod(resolve(stage, 'bin', 'forgeax'), 0o755);
  await writeFile(
    resolve(stage, 'bin', 'forgeax.cmd'),
    '@echo off\r\nnode "%~dp0forgeax.mjs" %*\r\n',
  );

  await Promise.all([
    cp(
      resolve(root, 'schemas/sdk-manifest.schema.json'),
      resolve(stage, 'schemas', 'sdk-manifest.schema.json'),
    ),
    cp(
      resolve(root, 'schemas/forgeax-dist.schema.json'),
      resolve(stage, 'schemas', 'forgeax-dist.schema.json'),
    ),
    cp(resolve(root, 'LICENSE'), resolve(stage, 'licenses', 'ForgeAX-Apache-2.0.txt')),
    cp(
      resolve(root, 'packages', 'codec', 'pkg', 'basis_transcoder.wasm'),
      resolve(stage, 'toolchain', 'wasm', 'basis_transcoder.wasm'),
    ),
    cp(
      resolve(root, 'packages', 'codec', 'pkg', 'encode', 'basis_encoder.wasm'),
      resolve(stage, 'toolchain', 'wasm', 'basis_encoder.wasm'),
    ),
    cp(
      resolve(root, 'packages', 'fbx', 'pkg', 'fbx-wasm.wasm'),
      resolve(stage, 'toolchain', 'wasm', 'fbx-wasm.wasm'),
    ),
    cp(
      resolve(root, 'packages', 'wgpu-wasm', 'pkg', 'wgpu_wasm_bg.wasm'),
      resolve(stage, 'toolchain', 'wasm', 'wgpu_wasm_bg.wasm'),
    ),
  ]);
}
const sdkSkillIds = (await readdir(resolve(root, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && (!engineOnly || entry.name !== 'forgeax-engine-sdk'))
  .map((entry) => entry.name)
  .sort();
for (const id of sdkSkillIds) {
  try {
    await readFile(resolve(root, 'skills', id, 'SKILL.md'));
  } catch (error) {
    throw new Error(`sdk-skill-entry-missing: ${id}/SKILL.md`, { cause: error });
  }
  await cp(resolve(root, 'skills', id), resolve(stage, 'skills', id), { recursive: true });
}
sdkSkillIds.push(
  ...(await stageViewConsumerSkills(viewRoot, resolve(stage, 'skills'), sdkViewGuide)),
);
sdkSkillIds.sort();
// Source-derived SDK discovery is generated into the distribution, not committed documentation.
// `api-index.md` is the directory; each domain file lands beside it under `api/`.
const { writeApiReference } = await import('./sdk-api-index.mjs');
const capabilityFacts = JSON.parse(
  await readFile(resolve(root, 'schemas/engine-capabilities.json'), 'utf8'),
);
for (const id of engineOnly
  ? ['forgeax-engine-authoring']
  : ['forgeax-engine-authoring', 'forgeax-engine-sdk']) {
  const skill = resolve(stage, 'skills', id);
  const references = resolve(skill, 'references');
  await mkdir(references, { recursive: true });
  writeApiReference(references);
  await writeFile(
    resolve(references, 'feature-catalog.md'),
    '# Engine capabilities\n\nGeneration baseline commit: `' +
      capabilityFacts.generationBaselineCommit +
      '`\n\n| Name | Form |\n| --- | --- |\n' +
      capabilityFacts.capabilities.map(({ name, form }) => `| ${name} | ${form} |`).join('\n') +
      '\n',
  );
  for (const name of ['SKILL.md', 'SKILL.zh-CN.md']) {
    const path = resolve(skill, name);
    await writeFile(path, localSdkDiscoveryLinks(await readFile(path, 'utf8'), 'references/'));
  }
}
for (const { sourceRoot } of SDK_TEMPLATES) {
  for (const name of ['AGENTS.md', 'AGENTS.zh-CN.md']) {
    const path = resolve(stage, sourceRoot, name);
    await writeFile(
      path,
      localSdkDiscoveryLinks(
        await readFile(path, 'utf8'),
        'skills/forgeax-engine-authoring/references/',
      ),
    );
  }
}

// The unified `forgeax dev ...` surface owns live inspection. The historical
// standalone relay scripts remain repository-only fixtures for old smoke lanes
// but must not be shipped as runnable SDK skill entries.
for (const relative of [
  'skills/forgeax-engine-cli/scripts/remote-live.mjs',
  'skills/forgeax-engine-cli/scripts/remote-cli-common.mjs',
  'skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs',
  'scripts/dev-live.mjs',
]) {
  await rm(resolve(stage, relative), { force: true });
}
if (emitEnginePackage) {
  const [{ packEngineAuthoring }, { parseAllDocuments }] = await Promise.all([
    import('./engine-authoring-package.mjs'),
    import('yaml'),
  ]);
  const engineSkillIds = sdkSkillIds.filter((id) => id !== 'forgeax-engine-sdk');
  if (!engineOnly) {
    await cp(resolve(stage, 'templates'), resolve(engineStage, 'templates'), { recursive: true });
    for (const { sourceRoot } of SDK_TEMPLATES) {
      const project = resolve(engineStage, sourceRoot);
      await rm(resolve(project, 'pnpm-lock.yaml'), { force: true });
      await useEngineTemplateRegistryPolicy(project);
    }
    for (const id of engineSkillIds) {
      if (id === 'forgeax-view-cli' || id === 'forgeax-view-start') continue;
      await cp(resolve(stage, 'skills', id), resolve(engineStage, 'skills', id), {
        recursive: true,
      });
    }
    await stageViewConsumerSkills(viewRoot, resolve(engineStage, 'skills'), engineGuideRoot);
    const view = resolve(engineStage, 'tools/view');
    await stageViewToolPackage(viewRoot, view, version, engineGuideRoot);
    await pinViewRegistryDependencies(viewRoot, view);
  }
  await mkdir(resolve(engineStage, 'licenses'), { recursive: true });
  await cp(resolve(root, 'LICENSE'), resolve(engineStage, 'licenses', 'ForgeAX-Apache-2.0.txt'));
  await writeFile(
    resolve(engineStage, 'licenses', 'THIRD_PARTY_NOTICES.json'),
    `${JSON.stringify(licenseReport, null, 2)}\n`,
  );
  const filename = `forgeax-engine-${version}.tgz`;
  const stagedArchive = resolve(stagingRoot, filename);
  const pnpmSnapshots = Object.assign(
    {},
    ...parseAllDocuments(await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8')).map(
      (document) => document.toJSON().snapshots,
    ),
  );
  const bytes = await sdkStage('pack Engine with authoring resources', () =>
    packEngineAuthoring({
      engineArchive: engineTarball.path,
      authoringStage: engineStage,
      destination: stagedArchive,
      version,
      engineCommit,
      pnpmVersion,
      pnpmSnapshots,
      templates: SDK_TEMPLATES.map(({ id, sourceRoot }) => ({ id, root: sourceRoot })),
      skillIds: engineSkillIds,
    }),
  );
  const sha = sha256(await readFile(stagedArchive));
  const archiveRoot = engineOnly ? outputRoot : resolve(outputRoot, 'engine-authoring');
  await mkdir(archiveRoot, { recursive: true });
  const archivePath = resolve(archiveRoot, filename);
  await cp(stagedArchive, archivePath, { errorOnExist: true, force: false });
  const result = {
    ok: true,
    package: '@forgeax/engine',
    version,
    engineCommit,
    viewCommit,
    archive: archivePath,
    bytes,
    sha256: sha,
  };
  await writeFile(
    resolve(archiveRoot, 'engine-package.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if (engineOnly) {
    await rm(stagingRoot, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  await rm(engineStage, { recursive: true, force: true });
  await rm(stagedArchive);
}
const gitDependencies = await sdkStage('archive Engine and pinned source dependencies', () =>
  archiveEngineSource({ root, destination: sourceRoot, commit: engineCommit }),
);
for (const relative of [
  'skills/forgeax-engine-cli/scripts/remote-live.mjs',
  'skills/forgeax-engine-cli/scripts/remote-cli-common.mjs',
  'skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs',
  'scripts/dev-live.mjs',
]) {
  await rm(resolve(sourceRoot, relative), { force: true });
}
await copySdkTemplateResources(sourceRoot);
await Promise.all(
  SDK_SOURCE_WASM.flatMap((entry) =>
    entry.files.map(async (file) => {
      const source = resolve(root, entry.root, file);
      const destination = resolve(sourceRoot, entry.root, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
    }),
  ),
);
await copySdkResources(sourceRoot, new Map([['preview-canonical-kit', canonicalKitRoot]]));
await sdkStage('seed editable packages with release builds', () =>
  seedSourcePackageBuilds({ repositoryRoot: root, sdkRoot: stage, sourceRoot }),
);
await writeFile(
  resolve(sourceRoot, '.forgeax-public-distribution'),
  'This marker selects the public SDK source install and build path.\n',
);
await Promise.all([
  cp(resolve(root, 'skills', 'forgeax-engine-sdk', 'SDK-README.md'), resolve(stage, 'README.md')),
  cp(resolve(root, 'skills', 'forgeax-engine-sdk', 'SDK-AGENTS.md'), resolve(stage, 'AGENTS.md')),
  cp(resolve(root, 'skills', 'forgeax-engine-sdk', 'SDK-CLAUDE.md'), resolve(stage, 'CLAUDE.md')),
]);
const discoveryRoot = 'skills/forgeax-engine-sdk/references/';
for (const [file, prefix] of [
  ['README.md', discoveryRoot],
  ['AGENTS.md', discoveryRoot],
]) {
  const entry = resolve(stage, file);
  await writeFile(entry, localSdkDiscoveryLinks(await readFile(entry, 'utf8'), prefix));
}

await writeFile(
  resolve(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: '@forgeax/engine-sdk-root',
      version,
      private: true,
      packageManager,
      engines: { node: '>=22.13.0' },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  resolve(stage, 'licenses', 'THIRD_PARTY_NOTICES.json'),
  `${JSON.stringify(licenseReport, null, 2)}\n`,
);
if (nativePlayerArtifact !== undefined) {
  const { filename, sourceInputs, verifyArtifact } = await import(
    '../../packages/rhi-wgpu-native/scripts/windows-artifact.mjs'
  );
  const input = resolve(nativePlayerArtifact);
  const manifest = verifyArtifact(input, sourceInputs());
  if (manifest.engineCommit !== engineCommit) throw new Error('sdk-native-player-engine-mismatch');
  const destination = resolve(stage, 'native-player/win32-x64');
  await mkdir(destination, { recursive: true });
  for (const file of [filename, 'manifest.json'])
    await cp(resolve(input, file), resolve(destination, file));
}

const artifacts = await sdkStage('hash archive inventory', async () => {
  const paths = (await filesUnder(stage)).filter((path) => !path.endsWith('/sdk-manifest.json'));
  return mapConcurrent(paths, (path) => artifact(stage, path));
});
// Counts and digests describe the same final bytes; do not reread each tree
// once for sizes and then again for the authoritative artifact inventory.
function artifactSummary(prefix) {
  const rows = artifacts.filter((row) => row.path.startsWith(`${prefix}/`));
  return { fileCount: rows.length, byteCount: rows.reduce((sum, row) => sum + row.bytes, 0) };
}
const packageRows = publicPackages.map((item) => {
  const packageRoot = item.role === 'tool' ? 'tools/view' : `packages/${item.directory}`;
  return {
    name: item.name,
    role: item.role,
    version: item.version,
    root: packageRoot,
    ...artifactSummary(packageRoot),
  };
});
const skillRows = sdkSkillIds.map((id) => ({
  id,
  root: `skills/${id}`,
  ...artifactSummary(`skills/${id}`),
}));
const source = {
  root: SDK_SOURCE_ROOT,
  format: SDK_SOURCE_FORMAT,
  excluded: [...SDK_SOURCE_EXCLUDED_PATHS],
  gitDependencies,
  ...artifactSummary(SDK_SOURCE_ROOT),
  prebuiltWasm: SDK_SOURCE_WASM.map(({ package: packageName, root: packageRoot, files }) => ({
    package: packageName,
    root: packageRoot,
    files: [...files],
  })),
};
const sdkManifest = {
  schemaVersion: SDK_MANIFEST_VERSION,
  sdkVersion: version,
  engineCommit,
  viewCommit,
  requirements: { node: '>=22.13.0', pnpm: pnpmVersion, pnpmStoreFormat },
  capabilities: SDK_CAPABILITIES,
  packages: packageRows,
  templates: SDK_TEMPLATES.map(({ id, sourceRoot: templateRoot }) => ({
    id,
    root: templateRoot,
  })),
  skills: skillRows,
  resources: sdkResourceManifest(),
  templateResources: sdkTemplateResourceManifest(),
  source,
  artifacts,
};
await writeFile(resolve(stage, 'sdk-manifest.json'), `${JSON.stringify(sdkManifest, null, 2)}\n`);
// The staging tree also feeds the npm carrier. Only omit ZIP aliases at the
// final file list, once the carrier has its independent inventory.
const archiveArtifacts = referenceSdkPackageCopies(artifacts);
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `forgeax-sdk-v${version}`,
  documentNamespace: `https://github.com/ForgeAX/forgeax-engine/releases/${engineCommit}`,
  packages: packageRows.map((entry, index) => ({
    SPDXID: `SPDXRef-Package-${index}`,
    name: entry.name,
    versionInfo: entry.version,
    downloadLocation: 'NOASSERTION',
  })),
};
await writeFile(
  resolve(outputRoot, `forgeax-sdk-v${version}.spdx.json`),
  `${JSON.stringify(sbom, null, 2)}\n`,
);
await writeFile(
  resolve(outputRoot, `forgeax-sdk-v${version}.provenance.json`),
  `${JSON.stringify({ schemaVersion: '1.0.0', engineCommit, viewCommit, sdkVersion: version, builder: 'scripts/forgeax/build-sdk.mjs' }, null, 2)}\n`,
);

const carrierWorktree = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-carrier-'));
const carrierPackage = resolve(carrierWorktree, 'package');
const carrierArchive = resolve(npmRoot, `forgeax-engine-sdk-${version}.tgz`);
try {
  await mkdir(carrierPackage, { recursive: true });
  const carrierSdkRoot = resolve(carrierPackage, 'sdk');
  // Reuse the exact Engine archive instead of transporting its bytes twice.
  // sdk install materializes the complete writable source baseline.
  await stageSdkCarrier(stage, carrierSdkRoot, engineTarball.path);
  await writeFile(
    resolve(carrierPackage, 'package.json'),
    `${JSON.stringify(
      {
        name: '@forgeax/engine-sdk',
        version,
        license: 'Apache-2.0',
        description: 'On-demand ForgeAX SDK carrier for the forgeax CLI.',
        homepage: 'https://forgeax.github.io/download/engine-ai.md',
        repository: {
          type: 'git',
          url: 'https://github.com/ForgeAX/forgeax-engine.git',
          directory: 'skills/forgeax-engine-sdk',
        },
        keywords: ['forgeax', 'game-engine', 'game-sdk', 'webgpu'],
        engines: { node: '>=22.13.0' },
        files: ['README.md', 'sdk'],
        dependencies: { '@forgeax/engine': version },
      },
      null,
      2,
    )}\n`,
  );
  await cp(resolve(stage, 'README.md'), resolve(carrierPackage, 'README.md'));
  await sdkStage('pack npm carrier', () =>
    writePackageArchive(carrierWorktree, carrierArchive, { releaseVersion: version }),
  );
} finally {
  await rm(carrierWorktree, { recursive: true, force: true });
}

await writeFile(
  resolve(stage, 'sdk-manifest.json'),
  `${JSON.stringify({ ...sdkManifest, artifacts: archiveArtifacts }, null, 2)}\n`,
);
for (const path of await filesUnder(stage)) {
  await (await import('node:fs/promises')).utimes(path, 315532800, 315532800);
}
const zipEntries = [
  'forgeax-sdk/sdk-manifest.json',
  ...archiveArtifacts
    .filter(({ sourceCopy }) => sourceCopy !== true)
    .map(({ path }) => `forgeax-sdk/${path}`),
].sort();
await writeFile(resolve(outputRoot, '.sdk-zip-inputs'), `${zipEntries.join('\n')}\n`);
await sdkStage('zip archive', () =>
  zipWithInputs(['-X', '-q', archive, '-@'], outputRoot, `${zipEntries.join('\n')}\n`),
);
const archiveBytes = await readFile(archive);
const digest = sha256(archiveBytes);
await writeFile(resolve(outputRoot, 'SHA256SUMS'), `${digest}  ${basename(archive)}\n`);
const result = {
  ok: true,
  archive,
  sha256: digest,
  engineCommit,
  viewCommit,
  sdkVersion: version,
  npm: {
    packageArchives,
    packageCount: tarballs.size,
    sdkCarrier: carrierArchive,
    engineBundle,
  },
  capabilities: SDK_CAPABILITIES,
};
await writeFile(
  resolve(outputRoot, 'sdk-build-result.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
