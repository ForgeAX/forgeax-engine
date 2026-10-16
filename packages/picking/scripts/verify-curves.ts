import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { curve3, vec3 } from '@forgeax/engine-math';
const reference = process.argv[2];
if (!reference) throw new Error('Supply extracted Three.js r184 source checkout');
const { CatmullRomCurve3 } = await import(
  pathToFileURL(resolve(reference, 'src/extras/curves/CatmullRomCurve3.js')).href
);
const { Vector3 } = await import(pathToFileURL(resolve(reference, 'src/math/Vector3.js')).href);
const controls = [
  [0, 0, 0],
  [0.05, 0.01, 0],
  [1, 2, 0],
  [5, 2, 1],
  [5.1, 2.1, 1],
];
const p = vec3.create();
const rows: any[] = [];
for (const parameterization of ['uniform', 'centripetal', 'chordal'] as const)
  for (const closed of [false, true]) {
    const curve = new CatmullRomCurve3(
      controls.map((v) => new Vector3(...v)),
      closed,
      parameterization === 'uniform' ? 'catmullrom' : parameterization,
      0.5,
    );
    let maxError = 0;
    const points = [];
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      curve3.catmullRom(p, controls, t, { parameterization, closed });
      const expected = curve.getPoint(t);
      const error = Math.hypot(p[0]! - expected.x, p[1]! - expected.y, p[2]! - expected.z);
      maxError = Math.max(maxError, error);
      points.push({
        t,
        engine: Array.from(p),
        reference: [expected.x, expected.y, expected.z],
        error,
      });
    }
    if (maxError > 2e-6) throw new Error('curve reference budget exceeded');
    rows.push({ parameterization, closed, maxError, points });
  }
const sample = (out: vec3.Vec3, t: number) => curve3.catmullRom(out, controls, t);
const table = curve3.arcLengths(new Float32Array(4097), sample);
const dense = curve3.arcLengths(new Float32Array(65537), sample);
const regular = [],
  distancePoints = [],
  steps = [];
const previous = vec3.create();
sample(previous, 0);
for (let i = 0; i <= 1000; i++) {
  sample(p, i / 1000);
  regular.push(Array.from(p));
  sample(p, curve3.parameterAtDistance(table, ((table.at(-1) ?? 0) * i) / 1000));
  distancePoints.push(Array.from(p));
  if (i > 0) steps.push(vec3.distance(previous, p));
  vec3.copy(previous, p);
}
const maxSpeedVariation = Math.max(...steps) / Math.min(...steps) - 1;
if (maxSpeedVariation > 0.002) throw new Error('distance speed budget exceeded');
mkdirSync('artifacts/picking-curves', { recursive: true });
writeFileSync(
  'artifacts/picking-curves/curves.json',
  JSON.stringify(
    {
      reference,
      referenceSha: 'd3b629c0c2097cec664ad16369bb6eae3b10e335',
      controls,
      rows,
      table: Array.from(table),
      denseLength: dense.at(-1),
      regular,
      distancePoints,
      steps,
      maxSpeedVariation,
      thresholds: { pointError: 2e-6, speedVariation: 0.002 },
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      maxSpeedVariation,
      relativeLengthError: Math.abs((table.at(-1) ?? 0) / (dense.at(-1) ?? 1) - 1),
      comparisons: rows.map(({ points, ...v }) => v),
    },
    null,
    2,
  ),
);
