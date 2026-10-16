#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  APP_SHADER_MANIFEST_DELTA,
  mergeAppShaderManifest,
  readSharedShaderManifest,
} from './app-shader-manifest.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function repeatedArgument(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value !== undefined && value !== '') values.push(value);
  }
  return values;
}

function fail(code, detail) {
  process.stdout.write(`${JSON.stringify({ code, ...detail })}\n`);
  process.exit(1);
}

const root = resolve(argument('--root', '.'));
const requestedSharedInputManifest = argument(
  '--shared-input-manifest',
  'shared-app-inputs/manifest.json',
);
let shared;
try {
  shared = readSharedShaderManifest(root, requestedSharedInputManifest);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /not valid JSON|incompatible producer metadata/.test(message)
    ? 'ci-app-shader-manifest-shared-input-invalid'
    : 'ci-app-shader-manifest-shared-input-missing';
  fail(code, {
    manifest: requestedSharedInputManifest,
    expected: 'catalog-only shared-app-inputs manifest with engineShaderManifest',
    detail: message,
  });
}
const sharedInputManifestPath = shared.manifestPath;
const source = shared.sourcePath;
const sourceRoot = relative(root, source).split('\\').join('/');

if (relative(root, sharedInputManifestPath).split('\\').join('/') === 'manifest.json') {
  // Read-only consumers download the combined artifact at `.`, so upload-artifact
  // strips the producer directory. Restore the contract path locally without
  // downloading the shared archive a second time.
  const canonicalManifest = join(root, 'shared-app-inputs', 'manifest.json');
  const canonicalShaderManifest = join(root, 'shared-app-inputs', 'shaders', 'manifest.json');
  mkdirSync(dirname(canonicalManifest), { recursive: true });
  mkdirSync(dirname(canonicalShaderManifest), { recursive: true });
  cpSync(sharedInputManifestPath, canonicalManifest);
  cpSync(source, canonicalShaderManifest);
  // The combined artifact is extracted at the repository root for read-only
  // consumers. Its root manifest is only the transport entry point; the
  // canonical copy above is the contract path and keeps the generated file
  // outside repository-wide source checks such as Biome.
  unlinkSync(sharedInputManifestPath);
}

function appDistDirectories(directory, relativeDirectory = '') {
  const result = [];
  const rootManifestPath = join(directory, 'package.json');
  if (existsSync(rootManifestPath)) {
    try {
      const packageManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
      if (typeof packageManifest.scripts?.build === 'string') {
        // An explicitly selected smoke root can itself be the app package
        // (for example apps/collectathon), not only a parent directory such
        // as apps/hello. Treat that root as one app so its shader projection
        // is materialized instead of silently leaving the delta transport in
        // place.
        const app =
          relativeDirectory ||
          relative(root, directory)
            .split('\\')
            .join('/')
            .replace(/^apps\//, '');
        return [{ dist: join(directory, 'dist'), app }];
      }
    } catch {
      return result;
    }
  }
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const next = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const manifestPath = join(directory, entry.name, 'package.json');
    if (existsSync(manifestPath)) {
      let packageManifest;
      try {
        packageManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      if (typeof packageManifest.scripts?.build === 'string') {
        const dist = join(directory, entry.name, 'dist');
        // The shard transfer inventory can contain only Pack carriers. When an
        // app has no carrier of its own, its dist directory is absent even
        // though its smoke still reads the shared shader manifest. Discover
        // from the source package roster so that a projection-only app is not
        // silently skipped.
        result.push({ dist, app: next });
        continue;
      }
    }
    result.push(...appDistDirectories(join(directory, entry.name), next));
  }
  return result;
}

const appsRoot = join(root, 'apps');
if (!existsSync(appsRoot)) fail('ci-app-shader-manifest-apps-missing', { appsRoot });

// Read-only smoke consumers only need the app roots that they will execute.
// The build artifact also contains hundreds of Bevy/editor/demo manifests;
// walking and rewriting those unrelated trees made every fleet leg spend
// ~50s on immutable input preparation. Keep the broad `apps/` default for
// other callers and let the fleet pass its explicit smoke roots.
const requestedAppRoots = repeatedArgument('--app-root');
const appRoots =
  requestedAppRoots.length > 0
    ? requestedAppRoots.map((relativeRoot) => resolve(root, relativeRoot))
    : [appsRoot];
for (const appRoot of appRoots) {
  if (!existsSync(appRoot)) fail('ci-app-shader-manifest-app-root-missing', { appRoot });
}

const materialized = [];
const merged = [];
const materializeSharedManifest = (sourcePath, targetPath) => {
  try {
    // The shared manifest is immutable CI input. A hardlink avoids copying the
    // same large catalog into every app while preserving ordinary-file reads.
    linkSync(sourcePath, targetPath);
  } catch (error) {
    // Artifact extraction can place source and app trees on different mounts;
    // retain the portable copy fallback for those filesystems.
    if (!['EXDEV', 'EPERM', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    cpSync(sourcePath, targetPath);
  }
};
// Every empty delta expands to the same normalized, immutable catalog.
// Serialize it once, then share that ordinary file across these consumers.
let emptyDeltaSource = null;
const fileIdentity = (path) => {
  const { dev, ino } = statSync(path);
  return `${dev}:${ino}`;
};
// Recovery and the consumer can both materialize the same input. Hardlinked
// catalogs are one immutable file, so parse their bytes only once.
const processedManifests = new Set([fileIdentity(source)]);
for (const appRoot of appRoots) {
  for (const { dist, app } of appDistDirectories(appRoot)) {
    const target = join(dist, 'shaders', 'manifest.json');
    if (existsSync(target)) {
      try {
        const identity = fileIdentity(target);
        if (processedManifests.has(identity)) continue;
        const appManifest = JSON.parse(readFileSync(target, 'utf8'));
        if (appManifest?.forgeaxTransport === APP_SHADER_MANIFEST_DELTA) {
          if (
            Array.isArray(appManifest.entries) &&
            appManifest.entries.length === 0 &&
            Array.isArray(appManifest.materialShaders) &&
            appManifest.materialShaders.length === 0
          ) {
            if (emptyDeltaSource === null) {
              const runtimeManifest = mergeAppShaderManifest(shared.manifest, appManifest, target);
              writeFileSync(target, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
              emptyDeltaSource = target;
            } else {
              unlinkSync(target);
              materializeSharedManifest(emptyDeltaSource, target);
            }
          } else {
            const runtimeManifest = mergeAppShaderManifest(shared.manifest, appManifest, target);
            writeFileSync(target, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
          }
          merged.push({ app, path: relative(root, target).split('\\').join('/') });
        }
        processedManifests.add(fileIdentity(target));
      } catch (error) {
        fail('ci-app-shader-manifest-delta-invalid', {
          app,
          manifest: relative(root, target),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    materializeSharedManifest(source, target);
    materialized.push({ app, path: relative(root, target).split('\\').join('/') });
  }
}

materialized.sort((left, right) => left.path.localeCompare(right.path));
merged.sort((left, right) => left.path.localeCompare(right.path));
process.stdout.write(
  `${JSON.stringify({ status: 'success', source: sourceRoot, materialized, merged })}\n`,
);
