import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeMeshDistanceField } from '../../../packages/geometry/src/distance-field-artifact.ts';

// Consume the existing per-geometry cook audit, including its refused fields.
// Missing inputs remain bounded instances; they are never silently dropped.
const cardsPath = resolve(process.argv[2]),
  fieldRoot = resolve(process.argv[3]),
  output = resolve(process.argv[4]);
const spacing = Number(process.argv[5] ?? 0.5);
assert(Number.isFinite(spacing) && spacing > 0);
await mkdir(output, { recursive: true });
const cardsBytes = await readFile(cardsPath),
  auditBytes = await readFile(resolve(fieldRoot, 'report.json'));
const cards = JSON.parse(cardsBytes),
  audit = JSON.parse(auditBytes),
  sources = [],
  fields = new Map();
const lo = [Infinity, Infinity, Infinity],
  hi = [-Infinity, -Infinity, -Infinity];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (audit.rows.some((r) => r.status === 'sampled-visibility'))
  assert.equal(sha(cardsBytes), audit.sourceSha256);
for (const { instance } of cards.sources) {
  const row = audit.rows.find((r) => r.section === instance.geometryId);
  assert(row, `missing cook audit for geometry ${instance.geometryId}`);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < instance.positions.length; i += 3) {
    const p = instance.positions.slice(i, i + 3),
      t = instance.transform;
    for (let a = 0; a < 3; a++) {
      bounds.min[a] = Math.min(bounds.min[a], p[a]);
      bounds.max[a] = Math.max(bounds.max[a], p[a]);
      const world = t[a] * p[0] + t[a + 4] * p[1] + t[a + 8] * p[2] + t[a + 12];
      lo[a] = Math.min(lo[a], world);
      hi[a] = Math.max(hi[a], world);
    }
  }
  const source = {
    instanceId: instance.instanceId,
    geometryId: instance.geometryId,
    mask: instance.mask,
    transform: instance.transform,
  };
  if (row.status === 'qualified-distance-samples' || row.status === 'sampled-visibility') {
    const file = `field-${row.section}.bin`,
      bytes = await readFile(resolve(fieldRoot, `section-${row.section}.bin`));
    assert.equal(sha(bytes), row.artifactSha256);
    const field = (await decodeMeshDistanceField(bytes, row.meshDigest)).unwrap();
    source.fieldFile = file;
    source.meshDigest = field.meshDigest;
    fields.set(file, { sha256: sha(bytes), bytes: bytes.length });
    await writeFile(resolve(output, file), bytes);
  } else source.field = { missing: true, bounds };
  sources.push(source);
}
const origin = lo.map((v) => Math.floor(v / spacing) * spacing - spacing);
const dimensions = hi.map((v, a) => Math.ceil((v + spacing - origin[a]) / spacing) + 1);
assert(
  dimensions.every((n) => n >= 1 && n <= 128),
  'grid exceeds the bounded 128 samples per axis; choose a coarser spacing',
);
const grid = { origin, dimensions, spacing, maxDistance: spacing * 4, coverageDistance: spacing };
const manifest = {
  scope:
    'Admitted mesh fields and explicit missing-source bounds in one frozen world region; no tracing, material opacity, clipmaps, cache lighting or GI.',
  sourceSha256: audit.sourceSha256,
  cardsSha256: sha(cardsBytes),
  auditSha256: sha(auditBytes),
  fields: Object.fromEntries(fields),
  cases: [
    { name: 'complete-roster', grid, sources },
    { name: 'available-only-control', grid, sources: sources.filter((s) => !s.field?.missing) },
    { name: 'masked-control', grid, sources: sources.map((s) => ({ ...s, mask: 0 })) },
  ],
};
await writeFile(resolve(output, 'composition.json'), JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify({
    instances: sources.length,
    admitted: fields.size,
    missing: sources.filter((s) => s.field?.missing).length,
    grid,
  }),
);
