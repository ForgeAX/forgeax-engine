import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { encodeMeshDistanceField } from '../../../packages/geometry/src/distance-field-artifact.ts';
import { createTriangleQuery } from '../../../packages/geometry/src/triangle-query.ts';
import { buildVisibilityDistanceField } from '../../../packages/geometry/src/visibility-distance-field.ts';

const output = process.argv[2];
assert(output, 'usage: prepare-thin-gap-sdf <output>');
await mkdir(output, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fields = {},
  cohorts = {},
  cases = [],
  scenes = [];
const width = 64,
  height = 24;
const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const grid = {
  origin: [-2.3, -0.3, -0.5],
  dimensions: [47, 27, 19],
  spacing: 0.1,
  maxDistance: 0.4,
  coverageDistance: 0.1,
};
for (const voxelSize of [0.1, 0.05])
  for (const gap of [0.05, 0.2])
    for (const wallZ of [0.2, 0.225]) {
      const name = `v${voxelSize * 1000}-g${gap * 1000}-z${wallZ * 1000}`;
      const positions = [],
        indices = [],
        triangles = [],
        labels = [];
      const quad = (points, label) => {
        const start = positions.length / 3;
        points = points.map((p) => p.map(Math.fround));
        positions.push(...points.flat());
        indices.push(...[0, 1, 2, 0, 2, 3].map((i) => i + start));
        triangles.push([points[0], points[1], points[2]], [points[0], points[2], points[3]]);
        labels.push(label, label);
      };
      quad(
        [
          [-2, 0, -0.2],
          [2, 0, -0.2],
          [2, 0, 1],
          [-2, 0, 1],
        ],
        'receiver',
      );
      quad(
        [
          [-2, 0, wallZ],
          [-gap / 2, 0, wallZ],
          [-gap / 2, 2, wallZ],
          [-2, 2, wallZ],
        ],
        'blocker',
      );
      quad(
        [
          [gap / 2, 0, wallZ],
          [2, 0, wallZ],
          [2, 2, wallZ],
          [gap / 2, 2, wallZ],
        ],
        'blocker',
      );
      quad(
        [
          [-2, 0, 1],
          [2, 0, 1],
          [2, 2, 1],
          [-2, 2, 1],
        ],
        'back',
      );
      const start = performance.now();
      const field = (
        await buildVisibilityDistanceField(positions, indices, {
          voxelSize,
          triangleSidedness: new Uint8Array(labels.length).fill(1),
        })
      ).unwrap();
      const cookMs = performance.now() - start;
      const bytes = (await encodeMeshDistanceField(field)).unwrap(),
        fieldFile = `${name}.bin`;
      await writeFile(`${output}/${fieldFile}`, bytes);
      fields[fieldFile] = { sha256: sha(bytes), bytes: bytes.length };
      const source = {
        instanceId: 0,
        geometryId: 0,
        mask: 255,
        transform,
        meshDigest: field.meshDigest,
        fieldFile,
      };
      const oracle = createTriangleQuery(triangles);
      for (const kind of ['world', 'receiver']) {
        const rays = [],
          exact = [],
          reference = [];
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const origin = [0, kind === 'world' ? 0.35 : 0.0001, 0].map(Math.fround);
            const v = [
              0.6 * ((x + 0.5) / width - 0.5),
              kind === 'world'
                ? -0.05 + (0.2 * (y + 0.5)) / height
                : 0.0001 + (0.3 * (y + 0.5)) / height,
              0.2,
            ];
            const direction = v.map((n) => Math.fround(n / Math.hypot(...v)));
            const ray = { origin, direction, tMin: 0, tMax: 5, mask: 255 };
            const hit = { primitive: -1, distance: 0, frontFace: false };
            assert(oracle.trace(hit, origin, direction, 0, ray.tMax));
            // Independent analytic plane/rectangle reference, including finite bounds.
            const z = Math.fround(wallZ),
              t = z / direction[2],
              px = direction[0] * t,
              py = origin[1] + direction[1] * t;
            const blocker =
              Math.abs(px) >= Math.fround(gap / 2) && Math.abs(px) <= 2 && py >= 0 && py <= 2;
            const expected = (blocker ? z : 1) / direction[2];
            assert(Math.abs(expected - hit.distance) < 1e-9);
            assert.equal(labels[hit.primitive], blocker ? 'blocker' : 'back');
            rays.push(ray);
            exact.push(hit.distance);
            reference.push({
              primitive: hit.primitive,
              surface: labels[hit.primitive],
              distance: hit.distance,
            });
          }
        const queryFile = `${name}-${kind}.json`;
        const payload = Buffer.from(
          JSON.stringify({ width, height, kind, rays, exact, reference }),
        );
        await writeFile(`${output}/${queryFile}`, payload);
        cohorts[queryFile] = { sha256: sha(payload), rays: rays.length };
        cases.push({ name: `${name}-${kind}`, grid, sources: [source], queryFile });
      }
      scenes.push({
        name,
        gap,
        wallZ,
        voxelSize,
        cookMs,
        fieldFile,
        meshDigest: field.meshDigest,
        origin: field.origin,
        dimensions: field.dimensions,
        policy: field.policy,
        quality: field.quality,
        positions,
        indices,
        triangleSidedness: labels.map(() => 1),
        labels,
      });
      console.log(
        JSON.stringify({ name, cookMs, bytes: bytes.length, dimensions: field.dimensions }),
      );
    }
const first = cases[0];
cases.push({
  ...first,
  name: 'masked-control',
  sources: first.sources.map((s) => ({ ...s, mask: 0 })),
});
await writeFile(`${output}/source.json`, JSON.stringify({ width, height, scenes }, null, 2));
await writeFile(
  `${output}/composition.json`,
  JSON.stringify(
    {
      scope:
        'Independent finite two-sided sheets: fixed receiver and world rays, zero TMin, unchanged production SDF queries. Geometry-only coverage, no alpha, shading, bias, cache or GI acceptance.',
      fields,
      cohorts,
      cases,
    },
    null,
    2,
  ),
);
