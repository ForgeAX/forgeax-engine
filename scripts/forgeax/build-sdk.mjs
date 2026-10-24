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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { bundleEngineArchive } from './engine-bundle.mjs';
import { sdkLauncherSource } from './sdk-launcher.mjs';
import {
  artifact,
  assertNoRetiredPackageFiles,
  detectPnpmStoreFormat,
  fetchWithRetry,
  filesUnder,
  mapConcurrent,
  normalizeLicenseReport,
  normalizePackageArchive,
  normalizePnpmStore,
  normalizeSdkRegistryLockfile,
  prepareWasmPackageForPack,
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
import { stageViewToolPackage } from './sdk-view.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
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
const outputRoot = resolve(root, value('--output') ?? 'artifacts/sdk');
const stage = resolve(outputRoot, 'forgeax-sdk');
const archive = resolve(outputRoot, `forgeax-sdk-v${version}.zip`);
const sourceRoot = resolve(stage, SDK_SOURCE_ROOT);
const pnpmMetadataCache = resolve(outputRoot, '.pnpm-metadata-cache');
const npmRoot = resolve(outputRoot, 'npm');
const packageArchives = resolve(npmRoot, 'packages');
const canonicalKitPackageRoot = resolve(root, 'packages/preview/assets/canonical-kit');
const canonicalKitRoot = resolve(outputRoot, '.canonical-kit');

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
  const { env, ...rest } = options;
  const invocation = processInvocation(file, commandArgs);
  return sdkStage([file, ...commandArgs].join(' ').slice(0, 240), () =>
    execFileAsync(invocation.file, invocation.args, {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      ...rest,
      env: { ...process.env, CI: process.env.CI ?? 'true', ...env },
    }),
  );
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
await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(stage, 'packages'), { recursive: true });
await mkdir(resolve(stage, 'store', 'pnpm'), { recursive: true });
await mkdir(resolve(stage, 'templates'), { recursive: true });
await mkdir(resolve(stage, 'skills'), { recursive: true });
await mkdir(resolve(stage, 'schemas'), { recursive: true });
await mkdir(resolve(stage, 'docs'), { recursive: true });
await mkdir(resolve(stage, 'licenses'), { recursive: true });
await mkdir(resolve(stage, 'toolchain', 'wasm'), { recursive: true });
await mkdir(packageArchives, { recursive: true });
await mkdir(sourceRoot, { recursive: true });

// Native Dawn is an input-keyed producer artifact, just like checked WASM.
// Its owner revalidates provenance and SHA before reuse; keep it across the JS
// clean build rather than starting another native compiler/toolchain download.
const nativeInputs = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-native-inputs-'));
const nativeRoot = resolve(root, 'packages/dawn-node/dist/native');
try {
  await cp(nativeRoot, resolve(nativeInputs, 'native'), { recursive: true }).catch((cause) => {
    if (cause.code !== 'ENOENT') throw cause;
  });
  await run('node', ['scripts/clean-build-outputs.mjs']);
  await cp(resolve(nativeInputs, 'native'), nativeRoot, { recursive: true }).catch((cause) => {
    if (cause.code !== 'ENOENT') throw cause;
  });
} finally {
  await rm(nativeInputs, { recursive: true, force: true });
}
await run('pnpm', ['build:engine'], {
  // Stage the selected environment and receipt together. The SDK transport
  // variant is overlaid only while the Preview package is packed.
  env: {
    ...process.env,
    FORGEAX_SDK_BUILD: '0',
    FORGEAX_CANONICAL_KIT_OUTPUT: canonicalKitRoot,
  },
});
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
// Keep generated profile inputs as acceleration. The producer validates the
// current compiler/source/profile and payload bytes before any reuse; disabled
// task caches still compile from source. These inputs never enter the archive.
const preparedShaders = await run('node', [
  'scripts/forgeax/prepare-shader-release-inputs.mjs',
  '--build',
  '--shared-input-manifest',
  'shared-build-inputs/manifest.json',
]);
// Keep cache admission visible without changing the builder's final JSON stdout.
for (const line of preparedShaders.stdout.split('\n')) {
  if (line.startsWith('[shader-profile]')) console.error(line);
}
for (const profile of ['base-ssao', 'point-ssao']) {
  await sdkStage(`admit ${profile} shader publication within memory budget`, () =>
    run('node', [
      '--expose-gc',
      '--max-old-space-size=512',
      'scripts/forgeax/check-shader-publication.mjs',
      'packages/vite-plugin-shader/dist/engine-inputs/profiles.json.gz',
      profile,
    ]),
  );
}
// build:engine already emits the complete declaration graph, including DevKit.
const { createMigrationRoster } = await import(
  pathToFileURL(resolve(root, 'packages/devkit/dist/index.mjs')).href
);
const packageMigrationRoster = {
  schemaVersion: '2.0.0',
  operations: createMigrationRoster().map((entry) => entry.operation),
  source: 'packages/devkit/src/tools/migration.ts',
};

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
    (manifest.name !== '@forgeax/engine' && !manifest.name.startsWith('@forgeax/engine-'))
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
const toolStage = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-view-stage-'));
try {
  const packageRoot = resolve(toolStage, 'package');
  await stageViewToolPackage(viewRoot, packageRoot, version);
  await writePackageArchive(toolStage, resolve(packageArchives, `forgeax-view-${version}.tgz`), {
    releaseVersion: version,
  });
} finally {
  await rm(toolStage, { recursive: true, force: true });
}
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
for (const entry of publicPackages) {
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
      .filter((entry) => entry.name.startsWith('@forgeax/engine-'))
      .map((entry) => ({ ...entry, archive: tarballs.get(entry.name).path })),
    version,
  }),
);
// Bare SDK package contracts remain inspectable. Only complete delivery units
// enter the public npm roster and template lockfiles.
for (const [name, item] of tarballs) {
  if (name.startsWith('@forgeax/engine-')) {
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
        dependencies: { '@forgeax/engine': version, '@forgeax/view': version },
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
    await cp(resolve(root, 'templates', 'AGENTS.md'), resolve(template, 'AGENTS.md'));
    await cp(
      resolve(root, 'templates', 'pnpm-workspace.yaml'),
      resolve(template, 'pnpm-workspace.yaml'),
    );
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
    await normalizeTemplateLockfile(template);
    await rm(resolve(template, 'node_modules'), { recursive: true, force: true });
  }
} finally {
  await new Promise((accept, reject) =>
    registry.close((error) => (error === undefined ? accept() : reject(error))),
  );
}
await copySdkTemplateResources(stage);
await rm(pnpmMetadataCache, { recursive: true, force: true });
const pnpmStoreFormat = await detectPnpmStoreFormat(resolve(stage, 'store', 'pnpm'));
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
await writeFile(
  resolve(stage, 'docs', 'TOOL-MIGRATION-ROSTER.json'),
  `${JSON.stringify(packageMigrationRoster, null, 2)}\n`,
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
  cp(resolve(root, 'packages', 'devkit', 'README.md'), resolve(stage, 'docs', 'DEVKIT.md')),
  cp(resolve(root, 'LICENSE'), resolve(stage, 'licenses', 'ForgeaX-Apache-2.0.txt')),
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
const sdkSkillIds = (await readdir(resolve(root, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
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
const packageRows = publicPackages.map((item) => ({
  name: item.name,
  role: item.role,
  version: item.version,
  root: `packages/${item.directory}`,
  ...artifactSummary(`packages/${item.directory}`),
}));
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
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `forgeax-sdk-v${version}`,
  documentNamespace: `https://github.com/ForgeaX-Games/forgeax-engine/releases/${engineCommit}`,
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
        description: 'On-demand ForgeaX SDK carrier for the forgeax CLI.',
        homepage: 'https://forgeax.github.io/download/engine-ai.md',
        repository: {
          type: 'git',
          url: 'https://github.com/ForgeaX-Games/forgeax-engine.git',
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

for (const path of await filesUnder(stage)) {
  await (await import('node:fs/promises')).utimes(path, 315532800, 315532800);
}
const zipEntries = (await filesUnder(stage))
  .map((path) => relative(outputRoot, path).split(sep).join('/'))
  .sort();
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
