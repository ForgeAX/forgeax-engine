import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { AssetGuid } from '@forgeax/engine-pack/source';
import pack from '../assets/material-id.pack.ts';
import { materialTerrainGuid } from '../src/identity.ts';

const dist = resolve(import.meta.dirname, '../dist');
const dir = resolve(process.env.TERRAIN_ID_COST_ARTIFACT_DIR ?? resolve(import.meta.dirname, '../.forgeax-debug/material-id-cost'));
mkdirSync(dir, { recursive: true });
const start = performance.now();
const source = (await pack.build({ packageId: pack.packageId, readByGuid: async () => {
  throw new Error('this procedural pair has no external reads');
} })).unwrap();
const sourceBuildMs = performance.now() - start;
const byGuid = new Map(Object.entries(source).map(([key, asset]) => [AssetGuid.format(AssetGuid.derive(pack.packageId, key)), asset]));
const packagePath = `assets/${AssetGuid.format(pack.packageId)}.pack.json`;
const publication = JSON.parse(readFileSync(resolve(dist, packagePath)));
const rows = new Map(publication.assets.map(row => [row.guid, row]));
const file = path => {
  const full = resolve(dist, path.startsWith('/') ? `.${path}` : path);
  assert(full.startsWith(dist + sep));
  return { path: full.slice(dist.length + 1), bytes: statSync(full).size };
};
const inventory = guid => {
  const visited = new Set(), queue = [guid], buffers = new Set(), artifactPaths = new Set();
  let logicalMetadataBytes = 0;
  while (queue.length) {
    const id = queue.pop(); if (visited.has(id)) continue; visited.add(id);
    const row = rows.get(id), asset = byGuid.get(id); assert(row && asset);
    queue.push(...row.refs);
    logicalMetadataBytes += Buffer.byteLength(JSON.stringify(row));
    for (const artifact of Object.values(row.artifacts ?? {})) artifactPaths.add(artifact.path.startsWith('/') ? artifact.path : `${dirname(packagePath)}/${artifact.path}`);
    const walk = value => {
      if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return; }
      if (value === null || typeof value !== 'object') return;
      for (const child of Object.values(value)) walk(child);
    };
    walk(asset);
  }
  const artifacts = [...artifactPaths].map(file);
  return { assetCount: visited.size, uniqueTypedBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0), logicalMetadataBytes, artifacts, artifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) };
};
const closures = Object.fromEntries(['weights','ids'].map(kind => [kind, inventory(AssetGuid.format(materialTerrainGuid(kind)))]));
const report = { status: 'PASS', producingHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '../../../..'), encoding: 'utf8' }).trim(), pairedPackageSha256: createHash('sha256').update(readFileSync(resolve(dist, packagePath))).digest('hex'), sourceBuildMs, closures, actualPairedPackage: file(packagePath), actualFullCatalog: file('pack-index.json'), boundary: 'Unique backing ArrayBuffers exclude JS objects, transient compiler/decoder peak and opaque driver residency. Logical per-root metadata/artifact inventories are not standalone published packs. The real carrier publishes both roots in one package, so it does not demonstrate reduced download bytes when selecting IDs. Source generation/Cook excludes shader compilation; no cold-disk bandwidth is claimed.' };
writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, closures: Object.fromEntries(Object.entries(closures).map(([key, {artifacts, ...cost}]) => [key, cost])) }, null, 2));
