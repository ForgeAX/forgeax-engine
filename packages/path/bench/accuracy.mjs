import { mkdir, writeFile } from 'node:fs/promises';
import { mat4 } from '@forgeax/engine-math';
import { preparePath } from '../dist/index.mjs';
import { arcOracle } from './oracle.mjs';

const curved = [0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0];
const cases = [
  ['line', [0, 0, 0, 0, 0, 10], false, [1, 1, 1]],
  ['high-curvature', curved, false, [1, 1, 1]],
  ['closed', curved, true, [1, 1, 1]],
  ['small', curved.map((v) => v * 0.001), false, [1, 1, 1]],
  ['large', curved.map((v) => v * 1000), false, [1, 1, 1]],
  ['nonuniform', curved, false, [2, 0.5, 3]],
];
const results = [];
for (const [name, points, closed, scale] of cases)
  for (const parameterization of [0, 1, 2]) {
    const definition = {
      points: Float32Array.from(points),
      closed,
      parameterization,
      up: Float32Array.from([0, 1, 0]),
      subdivisions: 2048,
    };
    const reference = arcOracle(definition, scale),
      coarse = arcOracle(definition, scale, 32768);
    for (const subdivisions of [128, 512, 2048, 8192]) {
      const path = preparePath(
        { ...definition, subdivisions },
        mat4.fromScaling(mat4.create(), scale),
      ).unwrap();
      const expected = path.length / 240;
      let previous = 0,
        maxDistance = 0,
        maxSpeed = 0,
        sumSquares = 0,
        wrongMaxSpeed = 0,
        wrongPrevious = 0;
      for (let i = 1; i <= 240; i++) {
        const s = reference.distance(path.parameterAtDistance(expected * i));
        const error = s - previous - expected;
        maxDistance = Math.max(maxDistance, Math.abs(error));
        maxSpeed = Math.max(maxSpeed, Math.abs(error) / expected);
        sumSquares += error * error;
        previous = s;
        const wrong = reference.distance(i / 240);
        wrongMaxSpeed = Math.max(
          wrongMaxSpeed,
          Math.abs(wrong - wrongPrevious - expected) / expected,
        );
        wrongPrevious = wrong;
      }
      results.push({
        name,
        parameterization,
        subdivisions,
        length: path.length,
        referenceLength: reference.length,
        oracleConvergence: Math.abs(reference.length - coarse.length) / reference.length,
        maxDistanceError: maxDistance,
        rmsDistanceError: Math.sqrt(sumSquares / 240),
        maxRelativeSpeedError: maxSpeed,
        rmsRelativeSpeedError: Math.sqrt(sumSquares / 240) / expected,
        uniformParameterFalsifier: wrongMaxSpeed,
      });
    }
  }
const report = {
  contract: {
    steps: 240,
    subdivisions: 2048,
    maxRelativeSpeedError: 0.005,
    referenceSubdivisions: 65536,
    referenceRelativeConvergence: 1e-6,
  },
  results,
};
const outputDirectory = new URL('../../../artifacts/path-bench/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL('accuracy.json', outputDirectory),
  `${JSON.stringify(report, null, 2)}\n`,
);
const failures = results.filter(
  (r) => r.subdivisions === 2048 && (r.maxRelativeSpeedError > 0.005 || r.oracleConvergence > 1e-6),
);
if (failures.length) process.exitCode = 1;
