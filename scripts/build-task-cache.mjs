import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const IGNORED_DIRS = new Set([
  '.wasm-build',
  '.cache',
  '.forgeax-debug',
  '.git',
  '.vite',
  'coverage',
  'dist',
  'node_modules',
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function walkFiles(directory, excludedPaths = new Set()) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (excludedPaths.has(path)) continue;
    if (entry.isDirectory()) result.push(...walkFiles(path, excludedPaths));
    else if (entry.isFile()) result.push(path);
    else if (entry.isSymbolicLink()) {
      result.push(path);
    }
  }
  return result;
}

export function hashFiles(root, paths) {
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    const rel = relative(root, path).replaceAll('\\', '/');
    hash.update(rel);
    hash.update('\0');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) hash.update(readFileSync(path, 'utf8'));
    else hash.update(readFileSync(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function hashText(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function inventory(directory) {
  if (!existsSync(directory)) return null;
  const files = walkFiles(directory)
    .map((path) => {
      const stat = statSync(path);
      return {
        path: relative(directory, path).replaceAll('\\', '/'),
        bytes: stat.size,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

export function inventoryMatches(directory, expected) {
  if (expected === null || !existsSync(directory)) return false;
  for (const file of expected.files ?? []) {
    const path = resolve(directory, file.path);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== file.bytes)
      return false;
  }
  return true;
}

export function packageId(name) {
  // Keep cache basenames bounded even when a shared-output locator is a deep
  // absolute path. The complete locator remains in the receipt for identity
  // validation; this digest is only the filesystem-safe index.
  return createHash('sha256').update(name).digest('hex');
}

function receiptKey(kind, name) {
  return { kind, name };
}

export function cachePath(root, kind, name) {
  return resolve(
    root,
    'node_modules/.cache/forgeax-build',
    kind,
    `${packageId(`${kind}\0${name}`)}.json`,
  );
}

export function readReceipt(root, kind, name) {
  const path = cachePath(root, kind, name);
  if (!existsSync(path)) return null;
  const receipt = readJson(path);
  return receipt?.cacheKey?.kind === kind && receipt?.cacheKey?.name === name ? receipt : null;
}

export function writeReceipt(root, kind, name, receipt) {
  const path = cachePath(root, kind, name);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify({ ...receipt, cacheKey: receiptKey(kind, name) }, null, 2)}\n`,
  );
  try {
    renameSync(temp, path);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    rmSync(path, { force: true });
    renameSync(temp, path);
  }
}

export function rootToolchainFiles(root) {
  return ['package.json', 'pnpm-lock.yaml', 'bun.lock', 'tsconfig.base.json', 'config/tsup.base.ts']
    .map((path) => resolve(root, path))
    .filter(existsSync);
}

export function packageInputFiles(root, directory) {
  // Producer scratch is not authored input; keep recipes, patches and outputs
  // under their existing source/provenance and output-inventory checks.
  const excludedPaths = new Set([resolve(root, 'packages/dawn-node/.native-build')]);
  if (existsSync(resolve(directory, 'Cargo.toml'))) excludedPaths.add(resolve(directory, 'target'));
  const producerFiles = ['physics-rapier2d', 'physics-rapier3d'].some(
    (name) => resolve(directory) === resolve(root, 'packages', name),
  )
    ? [resolve(root, 'scripts/forgeax/build-rapier-native.mjs')].filter(existsSync)
    : [];
  return [
    ...walkFiles(directory, excludedPaths),
    ...producerFiles,
    ...rootToolchainFiles(root),
  ].filter((path) => !path.includes('/dist/') && !path.includes('\\dist\\'));
}

function expandDeclaredInput(path) {
  if (!existsSync(path)) return [];
  return statSync(path).isDirectory() ? walkFiles(path) : [path];
}

export function appInputFiles(root, directory, manifest = undefined) {
  // Host programs and installed dependencies are generated app-local state.
  // Explicit asset declarations below still admit authored inputs at these paths.
  const excludedPaths = new Set([
    resolve(directory, '.forgeax'),
    resolve(directory, 'node_modules'),
  ]);
  const config = manifest?.forgeax;
  const declaredRoots = Array.isArray(config?.assetRoots) ? config.assetRoots : [];
  const overrideSources = Object.values(config?.publicAssetOverrides ?? {});
  const declaredInputs = [...declaredRoots, ...overrideSources]
    .filter((path) => typeof path === 'string')
    .flatMap((path) => expandDeclaredInput(resolve(directory, path)));
  return [
    ...walkFiles(directory, excludedPaths),
    ...declaredInputs,
    ...rootToolchainFiles(root),
  ].filter((path) => !path.includes('/dist/') && !path.includes('\\dist\\'));
}

export function workspacePackages(root) {
  const packagesRoot = resolve(root, 'packages');
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(resolve(packagesRoot, entry.name, 'package.json')),
    )
    .map((entry) => {
      const directory = resolve(packagesRoot, entry.name);
      const manifest = readJson(resolve(directory, 'package.json'));
      return { directory, relativeDirectory: relative(root, directory), manifest };
    })
    .filter((pkg) => pkg.manifest.scripts?.build);
}

export function workspaceDependencyNames(
  manifest,
  knownNames,
  fields = ['dependencies', 'optionalDependencies', 'peerDependencies'],
) {
  const names = new Set();
  for (const field of fields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      // Optional peers are runtime-selected integrations, not build-order
      // prerequisites. Excluding them keeps valid interface/backend cycles
      // buildable while the package manifest still publishes the peer contract.
      if (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional) continue;
      if (knownNames.has(name)) names.add(name);
    }
  }
  return names;
}

export function appPackages(root) {
  const result = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      const child = resolve(directory, entry.name);
      const manifestPath = resolve(child, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = readJson(manifestPath);
        if (manifest.scripts?.build) {
          result.push({
            directory: child,
            relativeDirectory: relative(root, child),
            manifest,
          });
        }
        continue;
      }
      visit(child);
    }
  }
  const appsRoot = resolve(root, 'apps');
  if (existsSync(appsRoot)) visit(appsRoot);
  return result;
}

export function packageOutputDirectory(pkg) {
  return resolve(pkg.directory, 'dist');
}

/** Runtime imports and browser exports can reference generated payloads outside dist. */
export function packageOutputFingerprint(root, directory, output) {
  return hashFiles(root, [
    ...output.files.map((file) => resolve(directory, 'dist', file.path)),
    ...walkFiles(resolve(directory, 'pkg')),
    ...walkFiles(resolve(directory, 'lib')),
  ]);
}

export function appOutputDirectory(app) {
  return resolve(app.directory, 'dist');
}

export function appMemoryClass(app, inputFiles) {
  const configured = app.manifest.forgeax?.buildMemoryClass;
  if (configured === 'heavy' || configured === 'light') return configured;
  if (
    app.manifest.forgeax?.assetRoots !== undefined ||
    app.manifest.forgeax?.publicAssetOverrides !== undefined ||
    app.relativeDirectory.includes('learn-render') ||
    inputFiles.some((path) => /\/(?:public|assets)\//.test(path) && statSync(path).size > 1_000_000)
  )
    return 'heavy';
  return 'light';
}

export function memoryCostGB(appClass) {
  return appClass === 'heavy' ? 2 : 0.5;
}
