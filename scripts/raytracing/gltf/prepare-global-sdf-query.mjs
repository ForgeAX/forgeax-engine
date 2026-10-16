import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTriangleQuery } from '../../../packages/geometry/src/triangle-query.ts';

// A frozen world-probe cohort complements existing receiver probes. No origin
// relocation, sign filtering, material opacity or environment lighting is inferred.
const [cardsArg, compositionArg, outputArg, receiverArg] = process.argv.slice(2);
assert(
  cardsArg && compositionArg && outputArg,
  'usage: prepare-global-sdf-query <cards.json> <composition-dir> <output> [receiver.json]',
);
const input = resolve(compositionArg),
  output = resolve(outputArg);
await mkdir(output, { recursive: true });
const cardsBytes = await readFile(resolve(cardsArg));
const manifest = JSON.parse(await readFile(resolve(input, 'composition.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(cardsBytes), manifest.cardsSha256);
const cards = JSON.parse(cardsBytes);
const triangles = [],
  lo = [Infinity, Infinity, Infinity],
  hi = [-Infinity, -Infinity, -Infinity];
for (const { instance } of cards.sources) {
  if (!instance.mask) continue;
  const m = instance.transform,
    positions = instance.positions;
  const world = Array.from({ length: positions.length / 3 }, (_, i) =>
    [0, 1, 2].map((a) => {
      const v = Math.fround(
        m[a] * positions[3 * i] +
          m[a + 4] * positions[3 * i + 1] +
          m[a + 8] * positions[3 * i + 2] +
          m[a + 12],
      );
      lo[a] = Math.min(lo[a], v);
      hi[a] = Math.max(hi[a], v);
      return v;
    }),
  );
  for (let i = 0; i < instance.indices.length; i += 3)
    triangles.push(instance.indices.slice(i, i + 3).map((index) => world[index]));
}
assert(triangles.length > 0);
const oracle = createTriangleQuery(triangles);
const probeAxes = 4,
  directionSize = 8;
// Equal-area square-to-sphere mapping (Clarberg 2008): the public mathematical
// distribution also used by UE Radiance Cache's texel-center IF tracing.
const direction = (x, y) => {
  const u = (2 * (x + 0.5)) / directionSize - 1,
    v = (2 * (y + 0.5)) / directionSize - 1;
  const zSign = 1 - Math.abs(u) - Math.abs(v),
    radius = 1 - Math.abs(zSign);
  const angle = radius === 0 ? 0 : (Math.PI / 4) * ((Math.abs(v) - Math.abs(u)) / radius + 1);
  const radial = radius * Math.sqrt(2 - radius * radius);
  return [
    Math.sign(u) * radial * Math.abs(Math.cos(angle)),
    Math.sign(v) * radial * Math.abs(Math.sin(angle)),
    Math.sign(zSign) * (1 - radius * radius),
  ].map(Math.fround);
};
const rays = [],
  exact = [],
  origins = [];
for (let z = 0; z < probeAxes; z++)
  for (let y = 0; y < probeAxes; y++)
    for (let x = 0; x < probeAxes; x++) {
      const origin = [x, y, z].map((n, a) =>
        Math.fround(lo[a] + ((hi[a] - lo[a]) * (n + 0.5)) / probeAxes),
      );
      origins.push(origin);
      for (let v = 0; v < directionSize; v++)
        for (let u = 0; u < directionSize; u++) {
          const ray = { origin, direction: direction(u, v), tMin: 0, tMax: 80, mask: 255 };
          const hit = { primitive: -1, distance: 0, frontFace: false };
          exact.push(oracle.trace(hit, origin, ray.direction, 0, ray.tMax) ? hit.distance : null);
          rays.push(ray);
        }
    }
const probeBytes = Buffer.from(
  JSON.stringify({ probeAxes, directionSize, bounds: { lo, hi }, origins, rays, exact }),
);
await writeFile(resolve(output, 'world-probes.json'), probeBytes);
for (const [file, metadata] of Object.entries(manifest.fields)) {
  const bytes = await readFile(resolve(input, file));
  assert.equal(sha(bytes), metadata.sha256);
  await copyFile(resolve(input, file), resolve(output, file));
}
const cases = manifest.cases.map((row) => ({ ...row, queryFile: 'world-probes.json' }));
const cohorts = {
  'world-probes.json': {
    sha256: sha(probeBytes),
    rays: rays.length,
    scope:
      '64 fixed world centers; 64 equal-area texel-center directions each; zero TMin; no jitter or relocation.',
  },
};
if (receiverArg) {
  const bytes = await readFile(resolve(receiverArg)),
    receiver = JSON.parse(bytes);
  assert(receiver.rays && receiver.exact);
  // Preserve every original byte, including null exact hits and the zero mask.
  await writeFile(resolve(output, 'receiver.json'), bytes);
  cohorts['receiver.json'] = {
    sha256: sha(bytes),
    rays: receiver.rays.length,
    scope: 'Unchanged original receiver cohort and exact distances.',
  };
  cases.push({ ...manifest.cases[0], name: 'receiver', queryFile: 'receiver.json' });
}
await writeFile(
  resolve(output, 'composition.json'),
  JSON.stringify(
    {
      ...manifest,
      cases,
      cohorts,
      scope:
        'Bounded Global SDF composition and query diagnostics. Approximate hits, negative starts and incomplete regions remain separate. No material opacity, Card mapping, sky, GI or quality acceptance.',
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    triangles: triangles.length,
    probes: origins.length,
    directions: directionSize ** 2,
    rays: rays.length,
    exactHits: exact.filter((t) => t !== null).length,
    cases: cases.length,
    cohorts,
  }),
);
