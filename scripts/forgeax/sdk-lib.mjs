import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { sdkGpuStage } from './sdk-stage.mjs';

export const SDK_MANIFEST_VERSION = '1.11.0';
export const SDK_NPM_PACKAGE_NAMES = Object.freeze(['@forgeax/engine', '@forgeax/engine-sdk']);
export const SDK_SOURCE_ROOT = 'source/engine';
export const SDK_SOURCE_FORMAT = 'git-archive-public-snapshot';
/** Full-ZIP surfaces the npm carrier omits; games install the same Engine bytes from npm. */
export const SDK_ZIP_ONLY_PATHS = Object.freeze(['store', 'packages', 'toolchain/wasm']);

/** Stage the online SDK from the same immutable inventory as the offline ZIP. */
export async function stageSdkCarrier(sdkRoot, destination, engineArchive) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-engine-reuse-'));
  try {
    await promisify(execFile)('tar', ['-xzf', engineArchive, '-C', temporary]);
    const engineRoot = resolve(temporary, 'package');
    const manifest = JSON.parse(await readFile(resolve(sdkRoot, 'sdk-manifest.json'), 'utf8'));
    const engine = JSON.parse(await readFile(resolve(engineRoot, 'package.json'), 'utf8'));
    if (engine.name !== '@forgeax/engine' || engine.version !== manifest.sdkVersion)
      throw new Error('sdk-carrier-engine-version-mismatch');
    const key = ({ bytes, sha256 }) => `${bytes}:${sha256}`;
    const files = (await filesUnder(engineRoot)).filter(
      // npm may rewrite package metadata and ignore-file names during extraction.
      (path) => !['package.json', '.gitignore', '.npmignore'].includes(path.split(sep).at(-1)),
    );
    const index = new Map();
    for (const entry of await mapConcurrent(files, (path) => artifact(engineRoot, path))) {
      if (!index.has(key(entry))) index.set(key(entry), entry.path);
    }
    manifest.artifacts = manifest.artifacts
      .filter(({ path }) => !SDK_ZIP_ONLY_PATHS.some((prefix) => path.startsWith(`${prefix}/`)))
      .map((entry) => {
        const enginePath = index.get(key(entry));
        return enginePath === undefined ? entry : { ...entry, enginePath };
      });
    const reused = new Set(
      manifest.artifacts
        .filter((entry) => entry.enginePath !== undefined)
        .map(({ path }) => resolve(sdkRoot, path)),
    );
    await cp(sdkRoot, destination, {
      recursive: true,
      filter: (source) =>
        !reused.has(source) &&
        !SDK_ZIP_ONLY_PATHS.some((path) => source === resolve(sdkRoot, path)),
    });
    await writeFile(
      resolve(destination, 'sdk-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const SDK_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Retain the installed-package View journeys separately from contributor source tests. */
export async function verifySdkViewRuntime({ sdkRoot, evidenceRoot, env, group = 'all' }) {
  if (!['all', 'project', 'view', 'game3d'].includes(group))
    throw new Error(`sdk-view-runtime-unknown-group:${group}`);
  if (group === 'game3d' && env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') {
    const destination = resolve(sdkRoot, 'scripts/test');
    await mkdir(destination, { recursive: true });
    for (const name of ['reduce-test-project.mjs', 'render-quality.json']) {
      const from = resolve(SDK_REPOSITORY_ROOT, 'scripts/test', name);
      const to = resolve(destination, name);
      if (existsSync(to)) {
        if (readFileSync(to, 'utf8') !== readFileSync(from, 'utf8'))
          throw new Error(`sdk-lightweight-helper-collision: ${name}`);
      } else await cp(from, to);
    }
  }
  const execute = promisify(execFile);
  const view = resolve(sdkRoot, '.forgeax/cli-runtime/node_modules/@forgeax/view');
  const independentEnv = { ...env };
  for (const key of [
    'NODE_PATH',
    'FORGEAX_SHARED_APP_INPUTS_MANIFEST',
    'FORGEAX_ENGINE_CHECKOUT',
    'FORGEAX_LOCAL_ENGINE',
    'FORGEAX_RUNTIME_PACK_DIRECT',
    'FORGEAX_RUNTIME_PACK_DIAGNOSTIC',
  ])
    delete independentEnv[key];
  const stages = [];
  for (const language of ['js', 'ts'])
    if (group !== 'game3d' && (group === 'all' || language === (group === 'view' ? 'js' : 'ts')))
      for (const cold of [false, true]) {
        const evidence = resolve(evidenceRoot, `runtime-${language}`, cold ? 'cold' : 'live');
        stages.push([
          `runtime-${language}-${cold ? 'cold' : 'live'}`,
          'verify-runtime-content-engine.mjs',
          {
            FORGEAX_RUNTIME_PACK_LANGUAGE: language,
            FORGEAX_EVIDENCE_DIR: evidence,
            FORGEAX_RUNTIME_PACK_SNAPSHOT: cold
              ? resolve(evidenceRoot, `runtime-${language}/live/saved-content.json`)
              : '',
          },
        ]);
      }
  // Only the npm diagnostics owner selects this journey; Engine stays installed.
  if (group === 'game3d')
    stages.push([
      'game3d-installed',
      'verify-game3d-workspace.mjs',
      { FORGEAX_ENGINE_CHECKOUT: sdkRoot },
    ]);
  await mkdir(evidenceRoot, { recursive: true });
  for (const [stage, probe, additionalEnv] of stages) {
    console.info(`[sdk-view] start ${stage}`);
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await sdkGpuStage(`installedView.${stage}`, () =>
        execute(process.execPath, [resolve(view, 'scripts', probe)], {
          cwd: sdkRoot,
          env: { ...independentEnv, ...additionalEnv },
          maxBuffer: 64 * 1024 * 1024,
        }),
      ));
      console.info(`[sdk-view] complete ${stage}`);
    } catch (cause) {
      stdout = cause.stdout ?? '';
      stderr = cause.stderr ?? '';
      throw cause;
    } finally {
      await writeFile(resolve(evidenceRoot, `${stage}.log`), stdout + stderr);
    }
  }
  return stages.map(([stage]) => stage);
}

/** Discover distributable templates from their required template.json files. */
export function discoverSdkTemplates(templatesRoot = resolve(SDK_REPOSITORY_ROOT, 'templates')) {
  const templates = [];
  for (const entry of readdirSync(templatesRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    // Workspace dependency materialization is not a template declaration.
    if (entry.name === 'node_modules') continue;
    const descriptorPath = resolve(templatesRoot, entry.name, 'template.json');
    if (!existsSync(descriptorPath)) {
      throw new Error(`sdk-template-descriptor-missing: ${entry.name}`);
    }
    let descriptor;
    try {
      descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    } catch (cause) {
      throw new Error(
        `sdk-template-descriptor-invalid: ${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (
      descriptor === null ||
      typeof descriptor !== 'object' ||
      typeof descriptor.id !== 'string' ||
      descriptor.id !== entry.name ||
      descriptor.id.length === 0 ||
      descriptor.id.includes('/') ||
      descriptor.id.includes('\\') ||
      typeof descriptor.purpose !== 'string' ||
      descriptor.purpose.trim().length === 0 ||
      descriptor.defaultIdentity === null ||
      typeof descriptor.defaultIdentity !== 'object' ||
      typeof descriptor.defaultIdentity.name !== 'string' ||
      descriptor.defaultIdentity.name.trim().length === 0 ||
      typeof descriptor.defaultIdentity.packageName !== 'string' ||
      descriptor.defaultIdentity.packageName.trim().length === 0 ||
      !Array.isArray(descriptor.journeys) ||
      descriptor.journeys.length === 0 ||
      descriptor.journeys.some(
        (journey) => typeof journey !== 'string' || journey.trim().length === 0,
      )
    ) {
      throw new Error(`sdk-template-descriptor-invalid: ${entry.name}`);
    }
    templates.push(Object.freeze({ id: descriptor.id, sourceRoot: `templates/${entry.name}` }));
  }
  if (templates.length === 0) throw new Error(`sdk-template-descriptor-empty: ${templatesRoot}`);
  return Object.freeze(templates);
}

export const SDK_TEMPLATES = discoverSdkTemplates();
export const SDK_SOURCE_GIT_DEPENDENCIES = Object.freeze([
  'third_party/wgpu',
  'third_party/blitz',
  'tools/view',
]);
export const SDK_SOURCE_EXCLUDED_PATHS = Object.freeze([
  '.gitmodules',
  'forgeax-engine-assets',
  '.github',
  ...SDK_SOURCE_GIT_DEPENDENCIES.map((root) => `${root}/.github`),
]);
export const SDK_RETIRED_PACKAGE_FILES = Object.freeze({
  '@forgeax/engine-vite-plugin-pack': Object.freeze([
    'dist/runtime.d.ts',
    'dist/runtime.d.ts.map',
    'dist/runtime.mjs',
    'dist/runtime.mjs.map',
  ]),
});
// This is the only non-code resource closure copied from the contributor
// checkout into the public source snapshot. Keep paths relative to the Engine
// source root and built package root; never add a private repository path.
export const SDK_RESOURCE_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'preview-canonical-kit',
    package: '@forgeax/engine-preview',
    sourceRoot: 'packages/preview/assets/canonical-kit',
    packageRoot: 'assets/canonical-kit',
    files: Object.freeze(['cook-receipt.json', 'sky.hdr', 'sky.hdr.meta.json']),
  }),
]);
// SDK templates are source-complete. game-3d generates procedural assets from
// ScriptablePack authoring sources and cooks its readable UI source pair through
// the project-owned UI importer, so no contributor-only template resource
// closure is copied into either the ZIP or public source snapshot.
export const SDK_TEMPLATE_RESOURCE_ALLOWLIST = Object.freeze([]);
export const SDK_SOURCE_WASM = Object.freeze([
  ...['2d', '3d'].map((dimension) =>
    Object.freeze({
      package: `@forgeax/engine-physics-rapier${dimension}`,
      root: `packages/physics-rapier${dimension}/pkg`,
      postinstallScripts: Object.freeze([]),
      files: Object.freeze([
        'rapier-native.mjs',
        'rapier-native.d.mts',
        'rapier.wasm',
        'rapier.mjs',
        'rapier.d.mts',
        'LICENSE',
        'provenance.json',
      ]),
    }),
  ),
  Object.freeze({
    package: '@forgeax/engine-ui-blitz',
    root: 'packages/ui-blitz/pkg',
    files: Object.freeze([
      'provenance.json',
      'ui-native.mjs',
      'ui-native.d.mts',
      'ui_blitz.js',
      'ui_blitz.d.ts',
      'ui_blitz_bg.wasm',
      'ui_blitz_bg.wasm.d.ts',
    ]),
  }),
  Object.freeze({
    package: '@forgeax/engine-wgpu-wasm',
    root: 'packages/wgpu-wasm/pkg',
    files: Object.freeze([
      'package.json',
      'provenance.json',
      'README.md',
      'wgpu_wasm.d.ts',
      'wgpu_wasm.js',
      'wgpu_wasm_bg.wasm',
      'wgpu_wasm_bg.wasm.d.ts',
    ]),
  }),
  Object.freeze({
    package: '@forgeax/engine-fbx',
    root: 'packages/fbx/pkg',
    files: Object.freeze(['fbx-wasm.mjs', 'fbx-wasm.wasm']),
  }),
  Object.freeze({
    package: '@forgeax/engine-codec',
    root: 'packages/codec/pkg',
    files: Object.freeze([
      'basis_transcoder.mjs',
      'basis_transcoder.wasm',
      'encode/basis_encoder.mjs',
      'encode/basis_encoder.wasm',
    ]),
  }),
]);

export const SDK_CAPABILITIES = Object.freeze([
  'app',
  'render',
  'assets',
  'shader',
  'physics',
  'audio',
  'vfx',
  'ui',
  'debug',
]);

export function sdkResourceManifest() {
  return SDK_RESOURCE_ALLOWLIST.map(
    ({ id, package: packageName, sourceRoot, packageRoot, files }) => ({
      id,
      package: packageName,
      sourceRoot,
      packageRoot,
      files: [...files],
    }),
  );
}

export function sdkTemplateResourceManifest() {
  return SDK_TEMPLATE_RESOURCE_ALLOWLIST.map(({ id, destinationRoot, files }) => ({
    id,
    root: destinationRoot,
    files: [...files],
  }));
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertNoRetiredPackageFiles(packageName, files) {
  const retired = SDK_RETIRED_PACKAGE_FILES[packageName] ?? [];
  const normalized = new Set(files.map((path) => path.replace(/^package\//, '')));
  const leaked = retired.filter((path) => normalized.has(path));
  if (leaked.length > 0) {
    throw new Error(`sdk-retired-package-file: ${packageName}: ${leaked.join(', ')}`);
  }
}

export async function filesUnder(root, directory = root) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (info.isFile()) files.push(path);
    else if (info.isSymbolicLink()) throw new Error(`sdk-symlink-not-portable: ${path}`);
  }
  return files;
}

export async function prepareWasmPackageForPack({
  packageRoot,
  helperSource,
  postinstallScripts,
  wasmFiles,
  releaseVersion,
}) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-wasm-stage-'));
  const stagedPackageRoot = resolve(root, 'package');
  const producerOnly = new Set(
    ['node_modules', '.git', 'target', '.native-build', '.wasm-build'].map((name) =>
      resolve(packageRoot, name),
    ),
  );
  await cp(packageRoot, stagedPackageRoot, {
    recursive: true,
    // Native producer caches can be several GiB and never belong to npm staging.
    filter: (path) => !producerOnly.has(path),
  });
  for (const controlFile of ['.gitignore', '.npmignore']) {
    await rm(resolve(stagedPackageRoot, controlFile), { force: true });
  }
  // This directory has no workspace or installed dependency links. Apply the
  // same publication identity as the final archive before pnpm resolves it.
  const manifestPath = resolve(stagedPackageRoot, 'package.json');
  const manifest = stablePackageManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    releaseVersion,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (postinstallScripts.length > 0) {
    const helperPath = resolve(stagedPackageRoot, 'scripts', 'ensure-wasm-lib.mjs');
    await cp(helperSource, helperPath);
  }
  for (const script of postinstallScripts) {
    const scriptPath = resolve(stagedPackageRoot, script);
    const source = await readFile(scriptPath, 'utf8');
    const rewritten = source.replace(
      '../../../scripts/lib/ensure-wasm-lib.mjs',
      './ensure-wasm-lib.mjs',
    );
    if (rewritten === source) {
      throw new Error(`sdk-postinstall-helper-import-missing: ${script}`);
    }
    await writeFile(scriptPath, rewritten);
  }
  for (const file of wasmFiles) {
    try {
      await readFile(resolve(stagedPackageRoot, file));
    } catch (error) {
      throw new Error(`sdk-source-wasm-path: ${file}`, { cause: error });
    }
  }
  return { root, packageRoot: stagedPackageRoot };
}

// SDK manifests can contain tens of thousands of source files. Keep digest
// and metadata reads below the host's file-descriptor limit while preserving
// input order for deterministic manifests.
export async function mapConcurrent(items, mapper, concurrency = 32) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`sdk-concurrency-invalid: ${concurrency}`);
  }
  const results = new Array(items.length);
  let next = 0;
  let failure;
  // After the first failure no new item starts, and in-flight work settles
  // before the failure is rethrown so no child process outlives the caller.
  async function worker() {
    while (failure === undefined) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failure !== undefined) throw failure.cause;
  return results;
}

export async function artifact(root, path) {
  const bytes = await readFile(path);
  return {
    path: relative(root, path).split(sep).join('/'),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export function streamFile(path, response) {
  createReadStream(path).pipe(response);
}

export async function fetchWithRetry(input, init, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((accept) => setTimeout(accept, attempt * 250));
      }
    }
  }
  throw lastError;
}

async function probeNpmPublication(item, tag, fetchImpl) {
  const encodedName = encodeURIComponent(item.name);
  const headers = { accept: 'application/json', 'cache-control': 'no-cache' };
  try {
    const metadataResponse = await fetchImpl(
      `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(item.version)}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!metadataResponse.ok) {
      return { ready: false, reason: `metadata-http-${metadataResponse.status}` };
    }
    const metadata = await metadataResponse.json();
    if (metadata.dist?.integrity !== item.integrity) {
      throw new Error(`npm-published-integrity-mismatch: ${item.name}`);
    }
    if (typeof metadata.dist.tarball !== 'string') {
      return { ready: false, reason: 'tarball-url-missing' };
    }
    // Installers resolve versions from the package's install metadata, which the
    // registry can serve after the exact version document; a fresh install in
    // between fails with ERR_PNPM_NO_MATCHING_VERSION.
    const [installResponse, tagsResponse, tarballResponse] = await Promise.all([
      fetchImpl(`https://registry.npmjs.org/${encodedName}`, {
        headers: { ...headers, accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(30_000),
      }),
      tag === undefined
        ? undefined
        : fetchImpl(`https://registry.npmjs.org/-/package/${encodedName}/dist-tags`, {
            headers,
            signal: AbortSignal.timeout(30_000),
          }),
      fetchImpl(metadata.dist.tarball, {
        method: 'GET',
        signal: AbortSignal.timeout(5 * 60_000),
        headers: { 'cache-control': 'no-cache' },
      }),
    ]);
    if (!installResponse.ok) {
      return { ready: false, reason: `install-metadata-http-${installResponse.status}` };
    }
    const installed = (await installResponse.json()).versions?.[item.version];
    if (installed === undefined)
      return { ready: false, reason: 'install-metadata-version-missing' };
    if (installed.dist?.integrity !== item.integrity) {
      throw new Error(`npm-published-integrity-mismatch: ${item.name}`);
    }
    if (tagsResponse !== undefined && !tagsResponse.ok) {
      return { ready: false, reason: `dist-tags-http-${tagsResponse.status}` };
    }
    if (tagsResponse !== undefined) {
      const tags = await tagsResponse.json();
      if (tags[tag] !== item.version) {
        return { ready: false, reason: `dist-tag-${tag}-${tags[tag] ?? 'missing'}` };
      }
    }
    if (!tarballResponse.ok) {
      return { ready: false, reason: `tarball-http-${tarballResponse.status}` };
    }
    const bytes = Buffer.from(await tarballResponse.arrayBuffer());
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== item.integrity) {
      throw new Error(`npm-published-integrity-mismatch: ${item.name}`);
    }
    return { ready: true };
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('npm-published-integrity-mismatch:')) {
      throw cause;
    }
    return { ready: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function waitForNpmPublications(
  items,
  {
    tag,
    fetchImpl = fetch,
    timeoutMs = 20 * 60_000,
    intervalMs = 10_000,
    now = Date.now,
    sleep = (duration) => new Promise((accept) => setTimeout(accept, duration)),
    onProgress = () => {},
  },
) {
  const startedAt = now();
  const pending = new Map(items.map((item) => [item.name, item]));
  const reasons = new Map();
  while (pending.size > 0) {
    const probes = await Promise.all(
      [...pending.values()].map(async (item) => ({
        item,
        result: await probeNpmPublication(item, tag, fetchImpl),
      })),
    );
    for (const { item, result } of probes) {
      if (result.ready) {
        pending.delete(item.name);
        reasons.delete(item.name);
      } else {
        reasons.set(item.name, result.reason);
      }
    }
    const elapsed = now() - startedAt;
    onProgress({
      elapsedMs: elapsed,
      tag,
      verified: items.length - pending.size,
      pending: [...pending.keys()].map((name) => ({ name, reason: reasons.get(name) })),
    });
    if (pending.size === 0) return { verified: items.length, tag };
    if (elapsed >= timeoutMs) {
      const detail = [...pending.keys()]
        .map((name) => `${name}: ${reasons.get(name) ?? 'unknown'}`)
        .join(', ');
      throw new Error(`npm-publication-not-visible: ${detail}`);
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
  return { verified: items.length, tag };
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

/**
 * Normalize workspace prefixes and unordered pnpm license inventory collections.
 * The report is shipped inside the SDK, so absolute checkout paths would make
 * otherwise identical builds differ between self-hosted runners.
 */
export function normalizeLicenseReport(value, workspaceRoot) {
  const root = resolve(workspaceRoot);
  const visit = (entry, field) => {
    if (Array.isArray(entry))
      return entry
        .map((child) => visit(child, field))
        .sort((left, right) => {
          const a = JSON.stringify(stable(left));
          const b = JSON.stringify(stable(right));
          return a < b ? -1 : a > b ? 1 : 0;
        });
    if (entry === null || typeof entry !== 'object') {
      if (field !== 'paths' || typeof entry !== 'string') return entry;
      if (!isAbsolute(entry)) return entry.split(sep).join('/');
      const path = relative(root, entry).split(sep).join('/');
      if (path === '..' || path.startsWith('../')) {
        throw new Error(`sdk-license-path-outside-workspace: ${entry}`);
      }
      return path || '.';
    }
    return Object.fromEntries(
      Object.entries(entry).map(([key, child]) => [key, visit(child, key)]),
    );
  };
  return visit(value, '');
}

function stablePackageManifest(manifest, releaseVersion) {
  if (releaseVersion !== undefined) manifest.version = releaseVersion;
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const value = manifest[section];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    if (releaseVersion !== undefined) {
      for (const name of Object.keys(value)) {
        if (
          name === '@forgeax/engine' ||
          name.startsWith('@forgeax/engine-') ||
          name === '@forgeax/view'
        ) {
          value[name] = releaseVersion;
        }
      }
    }
    manifest[section] = Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return manifest;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeString(header, offset, width, value) {
  header.write(value, offset, Math.min(width, Buffer.byteLength(value)), 'utf8');
}

function tarHeader(path, bytes, mode, type = '0') {
  const segments = path.split('/');
  let name = path;
  const prefixSegments = [];
  while (Buffer.byteLength(name) > 100 && segments.length > 1) {
    prefixSegments.push(segments.shift());
    name = segments.join('/');
  }
  const prefix = prefixSegments.join('/');
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
    throw new Error(`sdk-package-path-too-long: ${path}`);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(mode, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(bytes.byteLength, 12));
  writeString(header, 136, 12, octal(499_162_500, 12));
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function paxPathRecord(path) {
  const body = ` path=${path}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const record = `${length}${body}`;
    const bytes = Buffer.from(record);
    if (bytes.byteLength === length) return bytes;
    length = bytes.byteLength;
  }
}

// Hydrated binary payloads can arrive from a release archive or a local cache
// with different filesystem execute bits.  Execute permission is not part of
// the payload contract, and carrying it into the npm archive would make the
// carrier digest depend on which runner hydrated the bytes.  Keep script and
// CLI permissions intact while giving binary assets one canonical mode.
function packageArchiveMode(archivePath, mode) {
  if (archivePath.endsWith('.wasm')) return 0o644;
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function appendTarEntry(blocks, header, bytes) {
  blocks.push(header, bytes);
  const padding = (512 - (bytes.byteLength % 512)) % 512;
  if (padding > 0) blocks.push(Buffer.alloc(padding));
}

export async function normalizePackageArchive(path, execFileAsync, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-package-'));
  try {
    await execFileAsync('tar', ['-xzf', path, '-C', root]);
    await writePackageArchive(root, path, options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Write an already staged package with the same canonical tar/gzip format. */
export async function writePackageArchive(root, path, options = {}) {
  const manifestPath = resolve(root, 'package', 'package.json');
  const manifest = stablePackageManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    options.releaseVersion,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const blocks = [];
  let fileIndex = 0;
  // TypeScript's incremental build cache is a producer-local implementation
  // detail, not a publishable package surface.  It can encode resolver
  // state that differs between clean runners (for example platform-specific
  // optional dependency paths), which would make an otherwise identical SDK
  // tarball fail the cross-runner reproducibility gate.
  const files = (await filesUnder(resolve(root, 'package'))).filter(
    (file) => !file.endsWith('.tsbuildinfo'),
  );
  for (const file of files) {
    const bytes = await readFile(file);
    const info = await lstat(file);
    const archivePath = relative(root, file).split(sep).join('/');
    const mode = packageArchiveMode(archivePath, info.mode);
    try {
      appendTarEntry(blocks, tarHeader(archivePath, bytes, mode), bytes);
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.startsWith('sdk-package-path-too-long:')) {
        throw cause;
      }
      const pax = paxPathRecord(archivePath);
      appendTarEntry(blocks, tarHeader(`PaxHeaders/${fileIndex}`, pax, 0o644, 'x'), pax);
      appendTarEntry(blocks, tarHeader(`package/.pax-${fileIndex}`, bytes, mode), bytes);
    }
    fileIndex += 1;
  }
  blocks.push(Buffer.alloc(1024));
  // Level 6 preserves the canonical bytes after decompression while avoiding
  // level 9's repeated match search across the large Engine and SDK carriers.
  const compressed = gzipSync(Buffer.concat(blocks), { level: 6, mtime: 0 });
  compressed[9] = 0xff;
  await writeFile(path, compressed);
  await chmod(path, 0o644);
}

/** Keep package integrity while allowing the consumer's selected registry. */
export function normalizeSdkRegistryLockfile(lockfile, ownedTarballUrls) {
  for (const url of ownedTarballUrls) {
    lockfile = lockfile.replaceAll(`, tarball: ${url}`, '');
    if (lockfile.includes(url)) throw new Error('sdk-registry-lockfile-shape');
  }
  return lockfile;
}

/** pnpm's SQLite index and journal sidecars are mutable store state after install. */
export function isPnpmSqliteStoreArtifact(path) {
  return path.startsWith('store/pnpm/') && /\/index\.db(?:-(?:wal|shm))?$/.test(path);
}

export async function normalizePnpmStore(storeRoot, storeFormat = 'v11') {
  // The pinned pnpm owns SQLite's binary page layout and write-ahead log.
  await readFile(resolve(storeRoot, storeFormat, 'index.db'));
  // Shared memory is live coordination state and is recreated on use.
  await rm(resolve(storeRoot, storeFormat, 'index.db-shm'), { force: true });
}

/** Report the store format actually written by pnpm instead of inferring it from its major. */
export async function detectPnpmStoreFormat(storeRoot) {
  const formats = (await readdir(storeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (formats.length !== 1) {
    throw new Error(`sdk-pnpm-store-format-ambiguous: ${formats.join(',') || 'none'}`);
  }
  return formats[0];
}

/** Generated discovery belongs to the installed release; narrative guides retain their owner. */
export function localSdkDiscoveryLinks(source, prefix) {
  return source.replaceAll(/\]\(([^)\s]+)\)/g, (link, target) => {
    const file = target.slice(target.lastIndexOf('/') + 1);
    return target.includes('/references/') &&
      (file === 'api-index.md' || file === 'feature-catalog.md')
      ? `](${prefix}${file})`
      : link;
  });
}
