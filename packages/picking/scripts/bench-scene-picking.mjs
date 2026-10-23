import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createTorusGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { attachBarrelDistortionCameraFrame, createBarrelDistortionMapping, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { pickDisplay, pickTriangleDisplay } from '../dist/index.mjs';

const width = 1280;
const height = 720;
const samplesPerRound = 500;
const rounds = 3;
const percentile = (values, quantile) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * quantile)];
};

function createWorkload(offRayCount, overlappingCount) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const ring = assets.create(createTorusGeometry(1, 0.25, 40, 40).unwrap()).unwrap();
  const cube = assets.create(createBoxGeometry(0.8, 0.8, 0.8).unwrap()).unwrap();
  const spawn = (assetHandle, x, z) => world.spawn(
    { component: Transform, data: { pos: [x, 0, z] } },
    { component: MeshFilter, data: { assetHandle } },
    { component: MeshRenderer, data: { materials: [] } },
  ).unwrap();
  const foreground = spawn(ring, 0, 0);
  for (let index = 0; index < offRayCount; index++) spawn(ring, 8 + index * 3, 0);
  for (let index = 0; index < overlappingCount; index++) spawn(ring, 0, 0);
  const rear = spawn(cube, 0, -2);
  propagateTransforms(world);
  const viewMatrix = mat4.identity(mat4.create());
  viewMatrix[14] = -5;
  const mapping = attachBarrelDistortionCameraFrame(
    createBarrelDistortionMapping(width, height, { strength: 0 }).unwrap(),
    {
      projection: 'perspective',
      far: 100,
      viewMatrix,
      projectionMatrix: mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, width / height, 0.1, 100),
    },
  );
  return {
    bounds: () => pickDisplay(world, width / 2, height / 2, mapping, width, height)?.entity,
    triangle: () => {
      const result = pickTriangleDisplay(world, width / 2, height / 2, mapping, width, height);
      return result.status === 'hit' ? result.hit.entity : undefined;
    },
    foreground,
    rear,
    meshes: 2 + offRayCount + overlappingCount,
    trianglesPerRing: 40 * 40 * 2,
  };
}

async function measure(name, spec) {
  const workload = createWorkload(spec.offRayCount, spec.overlappingCount);
  if (workload.bounds() !== workload.foreground || workload.triangle() !== workload.rear)
    throw new Error(`${name}: fixture did not distinguish bounds from triangle picking`);
  const calls = { bounds: workload.bounds, triangle: workload.triangle };
  for (let index = 0; index < 100; index++) {
    calls.bounds();
    calls.triangle();
  }
  const elapsed = { bounds: [], triangle: [] };
  for (let round = 0; round < rounds; round++) {
    for (const mode of round % 2 === 0 ? ['bounds', 'triangle'] : ['triangle', 'bounds']) {
      const query = calls[mode];
      for (let sample = 0; sample < samplesPerRound; sample++) {
        const start = performance.now();
        query();
        elapsed[mode].push(performance.now() - start);
      }
    }
  }
  const result = {};
  for (const mode of ['bounds', 'triangle']) {
    const values = elapsed[mode];
    result[mode] = {
      samples: values.length,
      p50Ms: percentile(values, 0.50),
      p95Ms: percentile(values, 0.95),
      p99Ms: percentile(values, 0.99),
    };
  }
  return {
    name,
    ...spec,
    meshes: workload.meshes,
    trianglesPerRing: workload.trianglesPerRing,
    result,
    deltaP95Ms: result.triangle.p95Ms - result.bounds.p95Ms,
  };
}

const workloads = [
  ['game3d-like', { offRayCount: 0, overlappingCount: 0 }],
  ['off-ray pressure', { offRayCount: 128, overlappingCount: 0 }],
  ['overlapping bounds pressure', { offRayCount: 0, overlappingCount: 16 }],
];
const cpu = cpus()[0]?.model ?? 'unknown';
const results = [];
for (const [name, spec] of workloads) results.push(await measure(name, spec));
const engineRoot = resolve(import.meta.dirname, '../../..');
const sourceFiles = ['packages/picking/src/pick-triangle.ts', 'packages/picking/src/display-picking.ts'];
const querySourceDigest = createHash('sha256');
for (const file of sourceFiles) {
  querySourceDigest.update(file).update('\0').update(await readFile(resolve(engineRoot, file))).update('\0');
}
const report = {
  engineHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engineRoot, encoding: 'utf8' }).trim(),
  generatedAt: new Date().toISOString(),
  sourceFiles,
  querySourceSha256: querySourceDigest.digest('hex'),
  environment: { platform: platform(), release: release(), arch: process.arch, cpu, node: process.version },
  width,
  height,
  warmupPerMode: 100,
  samplesPerRound,
  rounds,
  results,
};
const reportPath = resolve(engineRoot, 'packages/picking/reports/scene-triangle-picking-benchmark.json');
await mkdir(resolve(reportPath, '..'), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
