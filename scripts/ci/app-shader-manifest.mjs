#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isShaderEntryPointReads } from '@forgeax/engine-types';
import { SHADER_MANIFEST_PUBLICATION_VERSION } from '../../packages/shader/src/manifest-publication.ts';

export const APP_SHADER_MANIFEST_DELTA = 'forgeax-app-shader-manifest-delta-v1';

function fail(message) {
  throw new Error(message);
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(
      `${description} is not valid JSON: ${path}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function manifestRows(value, path, field) {
  if (!Array.isArray(value?.[field])) fail(`${path} is missing a ${field} array`);
  return value[field];
}

function materialShaderKey(entry) {
  return `${entry?.identifier ?? ''}\0${entry?.sourcePath ?? ''}`;
}

function compactPair(left, right, sourcePath) {
  const compact = (manifest) => {
    const version = manifest?.schemaVersion;
    if (version === SHADER_MANIFEST_PUBLICATION_VERSION) return true;
    if (version === undefined || version === '1.0.0') return false;
    fail(`unsupported shader manifest publication version ${version}: ${sourcePath}`);
  };
  const result = compact(left);
  if (result !== compact(right)) fail(`shader manifest publication versions differ: ${sourcePath}`);
  return result;
}

const compactPools = [
  {
    table: 'receipts',
    reference: 'receiptIndex',
    inline: 'receipt',
    label: 'receipt',
    valid: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  },
  {
    table: 'entryPoints',
    reference: 'entryPointsIndex',
    inline: 'entryPoints',
    label: 'entry reads',
    valid: isShaderEntryPointReads,
  },
];

function remapPoolRows(rows, indices) {
  return rows.map((row) => {
    const references = {};
    for (const pool of compactPools) {
      if (Object.hasOwn(row, pool.inline)) fail(`compact shader row has inline ${pool.label}`);
      if (!Object.hasOwn(row, pool.reference)) continue;
      const index = row[pool.reference];
      if (!Number.isSafeInteger(index) || index < 0 || indices[pool.table][index] === undefined)
        fail(`compact shader ${pool.label} is missing: ${String(index)}`);
      references[pool.reference] = indices[pool.table][index];
    }
    return {
      ...row,
      ...references,
      ...(Array.isArray(row.variants) ? { variants: remapPoolRows(row.variants, indices) } : {}),
    };
  });
}

function poolKeys(publication) {
  return Object.fromEntries(
    compactPools.map((pool) => {
      if (!Array.isArray(publication[pool.table]))
        fail(`compact shader manifest is missing ${pool.table}`);
      return [
        pool.table,
        publication[pool.table].map((value, index) => {
          if (!pool.valid(value)) fail(`compact shader ${pool.label} is invalid: ${String(index)}`);
          return JSON.stringify(value);
        }),
      ];
    }),
  );
}

function compactTables(publication, entries, materialShaders) {
  if (
    !Array.isArray(publication.fragments) ||
    !publication.sources ||
    typeof publication.sources !== 'object' ||
    Array.isArray(publication.sources)
  ) {
    fail('compact shader manifest is missing fragments or sources');
  }
  const digests = new Set([
    ...entries.map((entry) => entry?.sourceDigest),
    ...materialShaders.flatMap((entry) => [
      entry?.sourceDigest,
      ...(Array.isArray(entry?.variants)
        ? entry.variants.map((variant) => variant?.sourceDigest)
        : []),
    ]),
  ]);
  const fragments = [];
  const indicesByFragment = new Map();
  const sources = {};
  for (const digest of [...digests].sort()) {
    if (
      typeof digest !== 'string' ||
      !Array.isArray(publication.sources[digest]) ||
      publication.sources[digest].length === 0
    ) {
      fail(`compact shader source is missing: ${String(digest)}`);
    }
    sources[digest] = publication.sources[digest].map((sourceIndex) => {
      const fragment = publication.fragments[sourceIndex];
      if (!Number.isSafeInteger(sourceIndex) || typeof fragment !== 'string') {
        fail(`compact shader source has an invalid fragment: ${digest}`);
      }
      let index = indicesByFragment.get(fragment);
      if (index === undefined) {
        index = fragments.length;
        fragments.push(fragment);
        indicesByFragment.set(fragment, index);
      }
      return index;
    });
  }
  const rows = [
    ...entries,
    ...materialShaders,
    ...materialShaders.flatMap((row) => row.variants ?? []),
  ];
  const keys = poolKeys(publication);
  const tables = {};
  const indices = {};
  for (const pool of compactPools) {
    const used = new Set(rows.map((row) => row[pool.reference]));
    const values = [];
    const byKey = new Map();
    indices[pool.table] = keys[pool.table].map((key, original) => {
      if (!used.has(original)) return undefined;
      let index = byKey.get(key);
      if (index === undefined) {
        index = values.length;
        values.push(publication[pool.table][original]);
        byKey.set(key, index);
      }
      return index;
    });
    tables[pool.table] = values;
  }
  return {
    fragments,
    sources,
    ...tables,
    entries: remapPoolRows(entries, indices),
    materialShaders: remapPoolRows(materialShaders, indices),
  };
}

function isWithinRoot(root, path) {
  const child = relative(root, path);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

/**
 * Resolve the producer-owned shared shader manifest from either the normal
 * shared-app-inputs extraction layout or the flat layout used by combined
 * build-artifact downloads.
 */
export function readSharedShaderManifest(root, requestedManifest) {
  const requestedPath = resolve(root, requestedManifest);
  const manifestCandidates = [requestedPath, resolve(root, 'manifest.json')].filter(
    (path, index, paths) => paths.indexOf(path) === index,
  );
  const manifestPath = manifestCandidates.find((path) => existsSync(path));
  if (manifestPath === undefined) {
    fail(
      `shared app input manifest is missing: ${manifestCandidates
        .map((path) => relative(root, path))
        .join(', ')}`,
    );
  }

  const wrapper = readJson(manifestPath, 'shared app input manifest');
  const sourceRelative = wrapper?.payload?.engineShaderManifest;
  if (
    !['repo-build-inputs', 'shared-app-inputs'].includes(wrapper?.producer) ||
    typeof sourceRelative !== 'string'
  ) {
    fail(`shared app input manifest has incompatible producer metadata: ${manifestPath}`);
  }

  const sourceCandidates = [
    resolve(root, sourceRelative),
    resolve(dirname(manifestPath), 'shaders/manifest.json'),
  ].filter((path, index, paths) => isWithinRoot(root, path) && paths.indexOf(path) === index);
  const sourcePath = sourceCandidates.find((path) => existsSync(path));
  if (sourcePath === undefined) {
    fail(
      `shared engine shader manifest is missing: ${sourceCandidates
        .map((path) => relative(root, path))
        .join(', ')}`,
    );
  }

  const shaderManifest = readJson(sourcePath, 'shared engine shader manifest');
  manifestRows(shaderManifest, sourcePath, 'entries');
  // Older shared-input manifests did not declare materialShaders because no
  // material-owned rows were present. Treat that form as an empty collection
  // so consumers can still materialize the same runtime manifest.
  const manifest = {
    ...shaderManifest,
    materialShaders: Array.isArray(shaderManifest.materialShaders)
      ? shaderManifest.materialShaders
      : [],
  };
  return { manifestPath, sourcePath, manifest };
}

/**
 * Remove the byte-identical shared engine rows from one app manifest. The
 * marker is transport metadata only; consumers replace it with the merged
 * runtime manifest before any smoke or browser process starts.
 */
export function projectAppShaderManifest(appManifest, sharedManifest, sourcePath = 'app manifest') {
  const compact = compactPair(appManifest, sharedManifest, sourcePath);
  const appEntries = manifestRows(appManifest, sourcePath, 'entries');
  const appMaterialShaders = manifestRows(appManifest, sourcePath, 'materialShaders');
  const sharedEntries = manifestRows(sharedManifest, 'shared engine shader manifest', 'entries');
  const sharedMaterialShaders = manifestRows(
    sharedManifest,
    'shared engine shader manifest',
    'materialShaders',
  );
  // Compare exact pooled facts using shared integer tokens. Expanding entry-read
  // JSON into every variant would recreate the duplication the publication removes.
  const facts = Object.fromEntries(compactPools.map((pool) => [pool.table, new Map()]));
  const comparableRows = (publication, entries, materials) => {
    if (!compact) return { entries, materials };
    const indices = poolKeys(publication);
    for (const pool of compactPools) {
      const byKey = facts[pool.table];
      indices[pool.table] = indices[pool.table].map((key) => {
        if (!byKey.has(key)) byKey.set(key, byKey.size);
        return byKey.get(key);
      });
    }
    return {
      entries: remapPoolRows(entries, indices),
      materials: remapPoolRows(materials, indices),
    };
  };
  const sharedRows = comparableRows(sharedManifest, sharedEntries, sharedMaterialShaders);
  const appRows = comparableRows(appManifest, appEntries, appMaterialShaders);
  const sharedEntryRows = new Map(
    sharedRows.entries.map((entry) => [entry?.hash, JSON.stringify(entry)]),
  );
  const sharedMaterialRows = new Map(
    sharedRows.materials.map((entry) => [materialShaderKey(entry), JSON.stringify(entry)]),
  );

  const entries = appEntries.filter(
    (entry, index) => JSON.stringify(appRows.entries[index]) !== sharedEntryRows.get(entry?.hash),
  );
  const materialShaders = appMaterialShaders.filter(
    (entry, index) =>
      JSON.stringify(appRows.materials[index]) !== sharedMaterialRows.get(materialShaderKey(entry)),
  );
  return {
    forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
    ...(compact
      ? {
          schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
          ...compactTables(appManifest, entries, materialShaders),
        }
      : { entries, materialShaders }),
  };
}

/** Merge one producer delta with the shared engine rows for runtime use. */
export function mergeAppShaderManifest(sharedManifest, deltaManifest, sourcePath = 'app manifest') {
  if (deltaManifest?.forgeaxTransport !== APP_SHADER_MANIFEST_DELTA) {
    fail(`unsupported app shader manifest transport: ${sourcePath}`);
  }
  const deltaEntries = manifestRows(deltaManifest, sourcePath, 'entries');
  const deltaMaterialShaders = manifestRows(deltaManifest, sourcePath, 'materialShaders');
  // A source-less empty delta contributes nothing to the verified shared manifest.
  if (
    deltaManifest.schemaVersion === undefined &&
    sharedManifest.schemaVersion === SHADER_MANIFEST_PUBLICATION_VERSION &&
    deltaEntries.length === 0 &&
    deltaMaterialShaders.length === 0
  ) {
    return sharedManifest;
  }
  const compact = compactPair(sharedManifest, deltaManifest, sourcePath);
  const sharedEntries = manifestRows(sharedManifest, 'shared engine shader manifest', 'entries');
  const sharedMaterialShaders = manifestRows(
    sharedManifest,
    'shared engine shader manifest',
    'materialShaders',
  );
  const sharedIndices = compact ? poolKeys(sharedManifest) : {};
  const deltaIndices = compact ? poolKeys(deltaManifest) : {};
  if (compact) {
    for (const pool of compactPools) {
      const count = sharedIndices[pool.table].length;
      sharedIndices[pool.table] = sharedIndices[pool.table].map((_, index) => index);
      deltaIndices[pool.table] = deltaIndices[pool.table].map((_, index) => index + count);
    }
  }
  const entriesByHash = new Map(
    (compact ? remapPoolRows(sharedEntries, sharedIndices) : sharedEntries).map((entry) => [
      entry?.hash,
      entry,
    ]),
  );
  for (const entry of compact ? remapPoolRows(deltaEntries, deltaIndices) : deltaEntries)
    entriesByHash.set(entry?.hash, entry);
  const materialShadersByKey = new Map(
    (compact ? remapPoolRows(sharedMaterialShaders, sharedIndices) : sharedMaterialShaders).map(
      (entry) => [materialShaderKey(entry), entry],
    ),
  );
  for (const entry of compact
    ? remapPoolRows(deltaMaterialShaders, deltaIndices)
    : deltaMaterialShaders)
    materialShadersByKey.set(materialShaderKey(entry), entry);

  const entries = [...entriesByHash.values()];
  const materialShaders = [...materialShadersByKey.values()];
  let sources;
  if (compact) {
    if (
      !Array.isArray(deltaManifest.fragments) ||
      !deltaManifest.sources ||
      typeof deltaManifest.sources !== 'object' ||
      Array.isArray(deltaManifest.sources)
    ) {
      fail(`compact app shader delta is missing fragments or sources: ${sourcePath}`);
    }
    const fragments = [...sharedManifest.fragments, ...deltaManifest.fragments];
    const mergedSources = { ...sharedManifest.sources };
    for (const [digest, indices] of Object.entries(deltaManifest.sources)) {
      if (!Array.isArray(indices)) fail(`compact app shader delta has invalid source: ${digest}`);
      mergedSources[digest] = indices.map((index) => {
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          typeof deltaManifest.fragments[index] !== 'string'
        )
          fail(`compact app shader delta has invalid source fragment: ${digest}`);
        return index + sharedManifest.fragments.length;
      });
    }
    sources = compactTables(
      {
        fragments,
        sources: mergedSources,
        receipts: [...sharedManifest.receipts, ...deltaManifest.receipts],
        entryPoints: [...sharedManifest.entryPoints, ...deltaManifest.entryPoints],
      },
      entries,
      materialShaders,
    );
  }
  return {
    ...sharedManifest,
    entries,
    materialShaders,
    ...sources,
  };
}
