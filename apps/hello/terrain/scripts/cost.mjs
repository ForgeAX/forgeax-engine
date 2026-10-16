import { decodeCatalogWire } from '@forgeax/engine-pack';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import terrainPack from '../assets/terrain.pack.ts';

// Measure the actual procedural source and emitted closure. Do not call OS-cached
// file reads cold IO or descriptor bytes opaque GPU/driver residency.
const dir = resolve(import.meta.dirname, '../.forgeax-debug/cost');
const dist = resolve(import.meta.dirname, '../dist');
mkdirSync(dir, { recursive: true });
const samples = [];
let assets;
for (let i = 0; i < 5; i++) {
  const start = performance.now();
  assets = (await terrainPack.build({ packageId: terrainPack.packageId,
    readByGuid: async () => { throw new Error('this pack has no external reads'); } })).unwrap();
  samples.push(performance.now() - start);
}
const uniqueBytes = (values) => {
  const buffers = new Set();
  const walk = (value) => {
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return; }
    if (value === null || typeof value !== 'object') return;
    for (const child of Object.values(value)) walk(child);
  };
  for (const value of values) walk(value);
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
};
const roots = Object.values(assets).filter((a) => a.kind === 'terrain');
assert.equal(roots.length, 1);
const root = roots[0];
const index = decodeCatalogWire(JSON.parse(readFileSync(resolve(dist, 'pack-index.json'), 'utf8'))).unwrap();
const paths = new Set(['pack-index.json']);
for (const url of new Set(index.map((row) => row.packageUrl))) {
  const path = `.${url}`;
  paths.add(path);
  const pack = JSON.parse(readFileSync(resolve(dist, path), 'utf8'));
  for (const row of pack.assets) for (const artifact of Object.values(row.artifacts ?? {}))
    if (artifact?.path) paths.add(artifact.path.startsWith('/') ? `.${artifact.path}` : `${dirname(path)}/${artifact.path}`);
}
const emitted = [];
const start = performance.now();
for (const path of paths) {
  const full = resolve(dist, path);
  assert(full.startsWith(dist + sep));
  const bytes = readFileSync(full);
  emitted.push({ path, bytes: bytes.byteLength });
  assert.equal(bytes.byteLength, statSync(full).size);
}
const report = {
  status: 'PASS', sourceBuildMs: samples,
  sourceBuildBoundary: 'Procedural author generation plus terrain grid/mip/array derivation. First invocation is process cold; later samples are warm. Shader compilation and filesystem cooking are excluded.',
  samples: { columns: root.columns, rows: root.rows, sections: root.sections.length,
    subsectionVertices: root.subsectionVertices, grids: root.grids.length },
  authorHeightWeightBytes: root.heights.byteLength + root.weights.byteLength,
  uniqueTypedPayloadBytes: uniqueBytes(Object.values(assets)),
  derivedTypedPayloadBytes: uniqueBytes(Object.values(assets).filter((a) => a.kind !== 'terrain')),
  cpuBoundary: 'Unique backing ArrayBuffers in procedural output. JavaScript objects, material metadata, decoder copies and transient cook peak are excluded.',
  emitted, emittedBytes: emitted.reduce((sum, row) => sum + row.bytes, 0),
  emittedReadMs: performance.now() - start,
  ioBoundary: 'Real emitted catalog, pack and body files; OS page-cache state is unknown. This is not a cold-disk bandwidth claim.',
  opaqueDriverResidentBytes: { status: 'unavailable', reason: 'The RHI owner exposes descriptors, not native allocation residency.' },
};
writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
