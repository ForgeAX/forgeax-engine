import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeMeshDistanceField } from '../../../packages/geometry/src/distance-field-artifact.ts';
import { createTriangleQuery } from '../../../packages/geometry/src/triangle-query.ts';

// Generic six-view geometry probes. Source material opacity is deliberately not an oracle here.
const cardsPath = resolve(process.argv[2]),
  fieldRoot = resolve(process.argv[3]),
  output = resolve(process.argv[4]);
await mkdir(output, { recursive: true });
const cardsBytes = await readFile(cardsPath);
const sources = JSON.parse(cardsBytes).sources;
const audit = JSON.parse(await readFile(resolve(fieldRoot, 'report.json'), 'utf8'));
const rows = [],
  size = Number(process.argv[5] ?? 32);
assert(Number.isInteger(size) && size >= 8 && 6 * size * size + 1 <= 65536);
if (audit.rows.some((r) => r.status === 'sampled-visibility'))
  assert.equal(createHash('sha256').update(cardsBytes).digest('hex'), audit.sourceSha256);
const point = (m, p, w) =>
  [0, 1, 2].map((a) => m[a] * p[0] + m[a + 4] * p[1] + m[a + 8] * p[2] + w * m[a + 12]);
for (const row of audit.rows.filter(
  (r) => r.status === 'qualified-distance-samples' || r.status === 'sampled-visibility',
)) {
  const source = sources.find((s) => s.instance.geometryId === row.section);
  assert(source, `missing imported section ${row.section}`);
  const { instance, layout } = source;
  const artifact = await readFile(resolve(fieldRoot, `section-${row.section}.bin`));
  assert.equal(createHash('sha256').update(artifact).digest('hex'), row.artifactSha256);
  const field = (await decodeMeshDistanceField(artifact, layout.meshDigest)).unwrap();
  const triangles = [];
  for (let i = 0; i < instance.indices.length; i += 3)
    triangles.push(
      [0, 1, 2].map((v) =>
        instance.positions.slice(instance.indices[i + v] * 3, instance.indices[i + v] * 3 + 3),
      ),
    );
  const oracle = createTriangleQuery(triangles),
    rays = [],
    exact = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      const extent = field.dimensions.map((n) => (n - 1) * field.spacing);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const p = field.origin.slice(),
            d = [0, 0, 0];
          p[axis] += side > 0 ? extent[axis] + field.spacing : -field.spacing;
          p[u] += (extent[u] * (x + 0.5)) / size;
          p[v] += (extent[v] * (y + 0.5)) / size;
          d[axis] = -side;
          const worldDirection = point(instance.transform, d, 0),
            scale = Math.hypot(...worldDirection);
          const hit = { primitive: -1, distance: 0, frontFace: false };
          const max = extent[axis] + field.spacing * 2;
          exact.push(oracle.trace(hit, p, d, 0, max) ? hit.distance * scale : null);
          rays.push({
            origin: point(instance.transform, p, 1),
            direction: worldDirection.map((c) => c / scale),
            tMin: 0,
            tMax: max * scale,
            mask: instance.mask,
          });
        }
    }
  const { positions, indices, normals, tangents, uvSets, ...ids } = instance;
  // A zero visibility mask must independently remove the same geometry.
  rays.push({ ...rays[Math.floor(rays.length / 2)], mask: 0 });
  const file = `section-${row.section}.json`;
  await writeFile(
    resolve(output, file),
    JSON.stringify({
      instance: ids,
      meshDigest: field.meshDigest,
      fieldFile: `section-${row.section}.bin`,
      rays,
      exact,
    }),
  );
  await writeFile(resolve(output, `section-${row.section}.bin`), artifact);
  rows.push({
    section: row.section,
    file,
    rays: rays.length,
    exactHits: exact.filter((t) => t !== null).length,
    artifactSha256: row.artifactSha256,
    policy: field.policy.kind,
    worldVoxel:
      field.spacing *
      Math.max(
        ...[0, 4, 8].map((a) => Math.hypot(...Array.from(instance.transform).slice(a, a + 3))),
      ),
  });
}
await writeFile(
  resolve(output, 'probes.json'),
  JSON.stringify(
    {
      size,
      views: ['-X', '+X', '-Y', '+Y', '-Z', '+Z'],
      sourceSha256: audit.sourceSha256,
      rows,
      scope:
        'Six orthographic views per isolated source geometry; exact geometry oracle, no opacity, inter-instance occlusion or GI.',
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    sections: rows.length,
    rays: rows.reduce((n, r) => n + r.rays, 0),
    exactHits: rows.reduce((n, r) => n + r.exactHits, 0),
  }),
);
