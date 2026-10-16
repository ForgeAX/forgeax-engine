#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = join(root, 'scripts', 'material-contract-inventory.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collect(path)));
    else if (entry.name.endsWith('.wgsl.meta.json')) result.push(path);
  }
  return result;
}

const records = [];
for (const directory of [join(root, 'apps'), join(root, 'packages')]) {
  for (const path of await collect(directory)) {
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    const identifier = metadata.importSettings?.materialShaderIdentifier;
    const hasParamSchema = Array.isArray(metadata.paramSchema);
    const hasMaterialSubAsset =
      Array.isArray(metadata.subAssets) &&
      metadata.subAssets.some((asset) => asset?.kind === 'material-shader');
    if (identifier === undefined && !hasParamSchema && !hasMaterialSubAsset) continue;
    records.push({
      path: relative(root, path).replaceAll('\\', '/'),
      identifier: identifier ?? null,
      paramSchema: hasParamSchema,
      materialSubAsset: hasMaterialSubAsset,
    });
  }
}
records.sort((left, right) => left.path.localeCompare(right.path));

const materialPackages = [];
for (const directory of [join(root, 'apps'), join(root, 'packages')]) {
  for (const path of await collectMaterialPackages(directory)) {
    const pack = JSON.parse(await readFile(path, 'utf8'));
    const materialAssets =
      pack.schemaVersion === '3.0.0' && pack.assets && !Array.isArray(pack.assets)
        ? Object.entries(pack.assets)
            .filter(
              ([sourceKey, asset]) => sourceKey.endsWith('.wgsl') && asset?.kind === 'material',
            )
            .map(([sourceKey, asset]) => ({ ...asset, sourceKey, guid: null }))
        : pack.kind === 'internal-text-package' && Array.isArray(pack.assets)
          ? pack.assets.filter(
              (asset) => asset?.kind === 'material' && typeof asset.sourceKey === 'string',
            )
          : [];
    if (materialAssets.length === 0) continue;
    if (materialAssets.length !== 1) {
      throw new Error(`material pack must contain exactly one material asset: ${path}`);
    }
    const asset = materialAssets[0];
    if (typeof asset.sourceKey !== 'string' || asset.sourceKey.length === 0) {
      throw new Error(`material pack material asset must declare sourceKey: ${path}`);
    }
    // sourceKey is producer identity, not necessarily a filesystem path.
    // Runtime packs such as gltf:material:TransmissionSphere have no sibling
    // WGSL source; their payload and manifest remain the authoritative checks.
    const sourcePath = resolve(path, '..', asset.sourceKey);
    let moduleIds = [];
    let sourceRelative = null;
    try {
      const source = await readFile(sourcePath, 'utf8');
      moduleIds = [...source.matchAll(/^\s*#define_import_path\s+([^\s]+)\s*$/gm)].map(
        (match) => match[1],
      );
      sourceRelative = relative(root, sourcePath).replaceAll('\\', '/');
    } catch (error) {
      if (!asset.sourceKey.includes(':') || error?.code !== 'ENOENT') throw error;
    }
    const passes = asset.payload?.passes ?? [];
    materialPackages.push({
      path: relative(root, path).replaceAll('\\', '/'),
      guid: asset.guid,
      source: sourceRelative,
      modules: passes.map((pass) => pass.program?.module),
      sourceModules: moduleIds,
    });
  }
}
materialPackages.sort((left, right) => left.path.localeCompare(right.path));

const baselinePaths = new Set(baseline.materialSidecars);
const unexpected = records.filter((record) => !baselinePaths.has(record.path));
const packagePaths = new Set(baseline.materialPackages ?? []);
const unexpectedPackages = materialPackages.filter((record) => !packagePaths.has(record.path));
const missingPackages = [...packagePaths].filter(
  (path) => !materialPackages.some((record) => record.path === path),
);
// A material Pack may publish an authored alias while reusing the engine-owned
// Standard template. The alias is the package/catalog identity; the template
// remains the source-of-truth WGSL. Keep the identity check strict for every
// other source/module pair.
const isAuthoredStandardAlias = (record) =>
  record.modules.length === 1 &&
  record.sourceModules.length === 1 &&
  record.modules[0] !== undefined &&
  record.sourceModules[0] !== undefined &&
  record.modules[0] !== record.sourceModules[0] &&
  !record.modules[0].startsWith('forgeax::') &&
  (record.sourceModules[0] === 'forgeax_material::standard' ||
    record.sourceModules[0] === 'forgeax_material::pbr-skin');
const identityMismatches = materialPackages.filter(
  (record) =>
    record.source !== null &&
    !isAuthoredStandardAlias(record) &&
    (record.modules.length !== 1 ||
      record.sourceModules.length !== 1 ||
      record.modules[0] !== record.sourceModules[0]),
);
const duplicateIdentifiers = new Map();
for (const record of records) {
  if (record.identifier === null) continue;
  const paths = duplicateIdentifiers.get(record.identifier) ?? [];
  paths.push(record.path);
  duplicateIdentifiers.set(record.identifier, paths);
}
const duplicates = [...duplicateIdentifiers.entries()].filter(([, paths]) => paths.length > 1);

console.log(
  JSON.stringify(
    {
      materialSidecars: records,
      materialPackages,
      counts: {
        materialSidecars: records.length,
        materialPackages: materialPackages.length,
        identifiers: records.filter((record) => record.identifier !== null).length,
        paramSchemas: records.filter((record) => record.paramSchema).length,
      },
    },
    null,
    2,
  ),
);

if (unexpected.length > 0) {
  console.error(`material contract inventory grew by ${unexpected.length} sidecar(s)`);
  for (const record of unexpected) console.error(`  ${record.path}`);
  process.exitCode = 1;
}
if (unexpectedPackages.length > 0 || missingPackages.length > 0) {
  console.error('material package inventory does not match the migration baseline');
  for (const record of unexpectedPackages) console.error(`  unexpected package: ${record.path}`);
  for (const path of missingPackages) console.error(`  missing package: ${path}`);
  process.exitCode = 1;
}
if (identityMismatches.length > 0) {
  console.error('material packages do not own the WGSL module identity');
  for (const record of identityMismatches) {
    console.error(
      `  ${record.path}: package=${record.modules.join(',')} source=${record.sourceModules.join(',')}`,
    );
  }
  process.exitCode = 1;
}
if (duplicates.length > 0) {
  console.error('material contract inventory contains duplicate runtime identifiers');
  for (const [identifier, paths] of duplicates)
    console.error(`  ${identifier}: ${paths.join(', ')}`);
  process.exitCode = 1;
}

async function collectMaterialPackages(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectMaterialPackages(path)));
    else if (entry.name.endsWith('.pack.json')) result.push(path);
  }
  return result;
}
