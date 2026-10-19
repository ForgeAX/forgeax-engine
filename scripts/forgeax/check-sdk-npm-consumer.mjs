import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fetchWithRetry, streamFile, verifySdkViewRuntime } from './sdk-lib.mjs';
import { SDK_NPM_PARTITIONS } from './sdk-pr-preflight.mjs';
import { sdkGpuStage, sdkStage } from './sdk-stage.mjs';

/*
 * Cheap release preflight: install the freshly-built user-facing Engine
 * package with npm from a non-workspace temporary project, then use its CLI
 * to install the SDK carrier. This follows the two real consumer paths without
 * inventing a project that directly depends on both distribution surfaces.
 * It catches workspace:/file: leakage and carrier/umbrella metadata errors
 * before browser verification or npm publish spends the long release budget.
 */

const execute = promisify(execFile);
const execFileAsync = (file, args, options) =>
  sdkStage([file, ...args].join(' ').slice(0, 240), () => execute(file, args, options));
const args = process.argv.slice(2);
if (process.env.FORGEAX_LOCAL_GPU_LEASE_HELD === '1')
  throw new Error('sdk-outer-gpu-lease-forbidden: use per-owner admission');
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, value('--output') ?? 'artifacts/sdk');
const version = value('--version');
if (version === undefined) throw new Error('npm-consumer-version-missing');
const partition = value('--partition') ?? 'all';
if (partition !== 'all' && !Object.hasOwn(SDK_NPM_PARTITIONS, partition))
  throw new Error(`npm-consumer-unknown-partition:${partition}`);
const packageRoot = resolve(output, 'npm', 'packages');
const carrierPath = resolve(output, 'npm', `forgeax-engine-sdk-${version}.tgz`);

async function packageArchive(path) {
  const { stdout } = await execFileAsync('tar', ['-xOf', path, 'package/package.json'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const bytes = await readFile(path);
  return {
    path,
    manifest: JSON.parse(stdout),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

const packageArchives = await Promise.all(
  (await readdir(packageRoot))
    .filter((name) => name.endsWith('.tgz'))
    .sort()
    .map((name) => packageArchive(resolve(packageRoot, name))),
);
const carrier = await packageArchive(carrierPath);
const all = [...packageArchives, carrier];
const names = new Set(packageArchives.map(({ manifest }) => manifest.name));
if ([...names].some((name) => name.startsWith('@forgeax/engine-')))
  throw new Error('release-focused-package-forbidden');
const umbrella = packageArchives.find(({ manifest }) => manifest.name === '@forgeax/engine');
if (umbrella === undefined) throw new Error('npm-umbrella-package-missing');
if (!names.has('@forgeax/view')) throw new Error('npm-view-tool-package-missing');
if (carrier.manifest.name !== '@forgeax/engine-sdk') throw new Error('npm-sdk-carrier-name');

for (const item of all) {
  if (item.manifest.version !== version) {
    throw new Error(`npm-package-version-mismatch: ${item.manifest.name}`);
  }
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    for (const [name, range] of Object.entries(item.manifest[section] ?? {})) {
      if (typeof range !== 'string') continue;
      if (/^(workspace|file|link):/.test(range)) {
        throw new Error(`npm-workspace-specifier: ${item.manifest.name} -> ${name}@${range}`);
      }
      if (
        (name === '@forgeax/engine' ||
          name.startsWith('@forgeax/engine-') ||
          name === '@forgeax/view') &&
        range !== version
      ) {
        throw new Error(
          `npm-internal-dependency-version-mismatch: ${item.manifest.name} -> ${name}`,
        );
      }
    }
  }
}
const umbrellaDependencies = new Set(Object.keys(umbrella.manifest.dependencies ?? {}));
for (const name of names) {
  if (name !== '@forgeax/engine' && name !== '@forgeax/view' && !umbrellaDependencies.has(name)) {
    throw new Error(`npm-umbrella-dependency-missing: ${name}`);
  }
}

function metadata(item, registry) {
  const address = registry.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    name: item.manifest.name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...item.manifest,
        dist: {
          tarball: `http://127.0.0.1:${port}/tarballs/${basename(item.path)}`,
          integrity: item.integrity,
          shasum: item.shasum,
        },
      },
    },
  };
}

const archives = new Map(all.map((item) => [item.manifest.name, item]));
const registryRequests = [];
function recordRegistryRequest(request, status, source) {
  // Keep the evidence bounded and deliberately omit headers/query values that
  // could contain credentials. The request path is enough to identify a
  // malformed metadata or tarball lookup in the CI log.
  if (registryRequests.length >= 200) return;
  registryRequests.push({
    method: request.method ?? 'GET',
    path: (request.url ?? '/').split('?', 1)[0],
    status,
    source,
  });
}
const registry = createServer(async (request, response) => {
  try {
    const url = request.url ?? '/';
    if (url.startsWith('/tarballs/') || url.includes('/-/')) {
      const item = [...archives.values()].find(
        (candidate) =>
          basename(candidate.path) === basename(url) ||
          url ===
            `/${candidate.manifest.name}/-/${candidate.manifest.name.split('/').at(-1)}-${candidate.manifest.version}.tgz`,
      );
      if (item === undefined && url.startsWith('/tarballs/')) {
        recordRegistryRequest(request, 404, 'local-tarball');
        response.writeHead(404).end();
        return;
      }
      if (item !== undefined) {
        recordRegistryRequest(request, 200, 'local-tarball');
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        streamFile(item.path, response);
        return;
      }
    }
    const name = decodeURIComponent(url.slice(1).split('?', 1)[0]);
    const item = archives.get(name);
    if (item !== undefined) {
      recordRegistryRequest(request, 200, 'local-metadata');
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(metadata(item, registry)));
      return;
    }
    if (name.startsWith('@forgeax/engine-') && name !== '@forgeax/engine-sdk') {
      recordRegistryRequest(request, 404, 'forbidden-focused-package');
      response.writeHead(404).end();
      return;
    }
    // Third-party dependencies still resolve from the real npm registry. The
    // internal packages above remain pinned to the local build artifacts.
    const upstream = await fetchWithRetry(`https://registry.npmjs.org${url}`, {
      headers: { accept: request.headers.accept ?? 'application/json' },
    });
    const headers = Object.fromEntries(
      [...upstream.headers.entries()].filter(
        ([header]) =>
          header !== 'content-encoding' &&
          header !== 'content-length' &&
          header !== 'transfer-encoding',
      ),
    );
    recordRegistryRequest(request, upstream.status, 'npmjs-upstream');
    response.writeHead(upstream.status, headers);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (cause) {
    recordRegistryRequest(request, 502, 'upstream-error');
    response.writeHead(502).end(cause instanceof Error ? cause.message : String(cause));
  }
});
await once(registry.listen(0, '127.0.0.1'), 'listening');
const address = registry.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
const registryUrl = `http://127.0.0.1:${port}/`;
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-npm-preflight-'));
const npmCache = resolve(temporaryRoot, '.npm-cache');
const npmUserConfig = resolve(temporaryRoot, '.npm-userconfig');
const npmGlobalConfig = resolve(temporaryRoot, '.npm-globalconfig');
const npmVersion = (
  await execFileAsync('npm', ['--version'], { maxBuffer: 1024 * 1024 })
).stdout.trim();
const consumerEnv = {
  ...process.env,
  npm_config_registry: registryUrl,
  NPM_CONFIG_REGISTRY: registryUrl,
  pnpm_config_registry: registryUrl,
  npm_config_cache: npmCache,
  NPM_CONFIG_CACHE: npmCache,
  npm_config_userconfig: npmUserConfig,
  NPM_CONFIG_USERCONFIG: npmUserConfig,
  npm_config_globalconfig: npmGlobalConfig,
  NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
};
const npmInstallArgs = [
  'install',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  // Keep dependencies isolated without npm nested's empty optional-native
  // directories for bundled packages. linked still rejects phantom imports.
  '--install-strategy=linked',
  '--cache',
  npmCache,
  '--userconfig',
  npmUserConfig,
  '--globalconfig',
  npmGlobalConfig,
];
const packageJson = {
  name: 'forgeax-sdk-npm-preflight',
  version: '1.0.0',
  private: true,
  dependencies: {
    '@forgeax/engine': version,
  },
};

async function verifyInstalledNpmOwners(installedSdk, consumerEnv, output, partition) {
  const workloads = [];
  if (partition === 'all' || partition === 'diagnostics') {
    await sdkGpuStage('verifyInstalledNpmDiagnostics', () =>
      execFileAsync(
        process.execPath,
        [resolve(root, 'tools/view-plugins/integration/verify-diagnostic-pages.mjs')],
        {
          cwd: installedSdk,
          env: {
            ...consumerEnv,
            FORGEAX_VIEW_TOOL_PACKAGE: resolve(
              installedSdk,
              '.forgeax/cli-runtime/node_modules/@forgeax/view',
            ),
            FORGEAX_VIEW_ENGINE_PACKAGE: resolve(
              installedSdk,
              '.forgeax/cli-runtime/node_modules/@forgeax/engine',
            ),
            FORGEAX_VIEW_TEMPLATE_ROOT: resolve(installedSdk, 'templates/game-3d'),
            FORGEAX_VIEW_EVIDENCE_ROOT: resolve(output, 'view-registry'),
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    );
    workloads.push('diagnostics');
    workloads.push(
      ...(await verifySdkViewRuntime({
        sdkRoot: installedSdk,
        evidenceRoot: resolve(output, 'view-registry'),
        env: consumerEnv,
        group: 'game3d',
      })),
    );
  }
  if (partition !== 'diagnostics')
    workloads.push(
      ...(await verifySdkViewRuntime({
        sdkRoot: installedSdk,
        evidenceRoot: resolve(output, 'view-registry'),
        env: consumerEnv,
        group: 'view',
      })),
    );
  return workloads;
}

try {
  await writeFile(
    resolve(temporaryRoot, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await writeFile(
    resolve(temporaryRoot, '.npmrc'),
    `registry=${registryUrl}\ncache=${npmCache}\nfund=false\naudit=false\n`,
  );
  await writeFile(npmUserConfig, `registry=${registryUrl}\ncache=${npmCache}\n`);
  await writeFile(npmGlobalConfig, '\n');
  process.stdout.write(
    `${JSON.stringify({
      phase: 'npm-install-start',
      node: process.version,
      npm: npmVersion,
      installStrategy: 'linked',
      registry: 'ephemeral-local-with-npm-upstream-fallback',
      cache: 'isolated-temporary',
      config: 'isolated-temporary',
    })}\n`,
  );
  try {
    await execFileAsync('npm', npmInstallArgs, {
      cwd: temporaryRoot,
      env: consumerEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        phase: 'npm-install',
        node: process.version,
        npm: npmVersion,
        registry: 'ephemeral-local-with-npm-upstream-fallback',
        requestCount: registryRequests.length,
        requests: registryRequests,
        error: cause instanceof Error ? cause.message : String(cause),
      })}\n`,
    );
    throw cause;
  }
  const engineManifest = JSON.parse(
    await readFile(
      resolve(temporaryRoot, 'node_modules', '@forgeax', 'engine', 'package.json'),
      'utf8',
    ),
  );
  if (engineManifest.version !== version) {
    throw new Error('npm-installed-version-mismatch: @forgeax/engine');
  }
  const installedSdk = resolve(temporaryRoot, 'installed-sdk');
  await execFileAsync(
    'node',
    [
      resolve(temporaryRoot, 'node_modules', '@forgeax', 'engine', 'dist', 'bin', 'forgeax.mjs'),
      'sdk',
      'install',
      installedSdk,
      '--version',
      version,
      '--json',
    ],
    {
      cwd: temporaryRoot,
      env: consumerEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const installedSdkManifest = JSON.parse(
    await readFile(resolve(installedSdk, 'sdk-manifest.json'), 'utf8'),
  );
  if (installedSdkManifest.sdkVersion !== version) {
    throw new Error('npm-installed-sdk-version-mismatch');
  }
  await readFile(resolve(installedSdk, 'bin', 'forgeax.mjs'), 'utf8');
  await execFileAsync(
    process.execPath,
    [resolve(installedSdk, 'bin/forgeax.mjs'), 'help', '--json'],
    {
      cwd: installedSdk,
      env: consumerEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const workloads = await verifyInstalledNpmOwners(installedSdk, consumerEnv, output, partition);
  const result = {
    ok: true,
    version,
    group: 'npm',
    partition,
    workloads,
    sha256: JSON.parse(await readFile(resolve(output, 'sdk-build-result.json'), 'utf8')).sha256,
    engineCommit: installedSdkManifest.engineCommit,
    viewCommit: installedSdkManifest.viewCommit,
    packageCount: packageArchives.length,
    carrier: carrier.manifest.name,
    sdkInstall: { version: installedSdkManifest.sdkVersion, source: carrier.manifest.name },
    installed: { '@forgeax/engine': engineManifest.version },
    toolchain: { node: process.version, npm: npmVersion },
    registry: 'ephemeral-local-with-npm-upstream-fallback',
  };
  await writeFile(
    resolve(
      output,
      partition === 'all'
        ? 'sdk-verify-npm-result.json'
        : `sdk-verify-npm-${partition}-result.json`,
    ),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  await new Promise((accept, reject) =>
    registry.close((error) => (error === undefined ? accept() : reject(error))),
  );
}
