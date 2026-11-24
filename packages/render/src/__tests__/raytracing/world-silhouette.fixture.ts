import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import { GLOBAL_SDF_COMPOSE_WGSL, packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import {
  assessAuthoredSurface,
  describeAuthoredSurface,
  exactAuthoredSurfaces,
} from './world-silhouette-exact.fixture';

type V = readonly [number, number, number];
const SIZE = 32;
const STEPS = 256;
const WORLD_TOLERANCE = 0.12;
function stage(name: string, flipFacing = false) {
  const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    `${directory}/stages.jsonl`,
    `${JSON.stringify({ name, variant: flipFacing ? 'wrong-facing' : 'production', at: new Date().toISOString() })}\n`,
  );
}
function artifactDirectory(flipFacing: boolean) {
  const base = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
  if (!base) return undefined;
  return flipFacing ? `${base}/wrong-facing` : base;
}
function recordShaderInputs(code: string, flipFacing: boolean) {
  const directory = artifactDirectory(flipFacing);
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/silhouette-production.wgsl`, code, { flag: 'wx' });
  writeFileSync(`${directory}/silhouette-compose.wgsl`, GLOBAL_SDF_COMPOSE_WGSL, { flag: 'wx' });
  stage('shader-inputs:saved', flipFacing);
}
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
interface AuthoredMesh {
  positions: Float32Array;
  indices: Uint32Array;
  transform: Float32Array;
  id: number;
}
/** Float64 Moller-Trumbore over authored triangle bytes, independent of fields and packed inverse matrices. */
function triangleOracle(meshes: readonly AuthoredMesh[], origin: V, direction: V, end: number) {
  let t = end,
    instance = 0;
  for (const mesh of meshes) {
    const point = (index: number): V => {
      const x = mesh.positions[index * 3] ?? NaN,
        y = mesh.positions[index * 3 + 1] ?? NaN,
        z = mesh.positions[index * 3 + 2] ?? NaN,
        m = mesh.transform;
      return [
        (m[0] ?? NaN) * x + (m[4] ?? NaN) * y + (m[8] ?? NaN) * z + (m[12] ?? NaN),
        (m[1] ?? NaN) * x + (m[5] ?? NaN) * y + (m[9] ?? NaN) * z + (m[13] ?? NaN),
        (m[2] ?? NaN) * x + (m[6] ?? NaN) * y + (m[10] ?? NaN) * z + (m[14] ?? NaN),
      ];
    };
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = point(mesh.indices[i] ?? NaN),
        b = point(mesh.indices[i + 1] ?? NaN),
        c = point(mesh.indices[i + 2] ?? NaN),
        ab = sub(b, a),
        ac = sub(c, a),
        p = cross(direction, ac),
        determinant = dot(ab, p);
      if (Math.abs(determinant) < 1e-12) continue;
      const s = sub(origin, a),
        u = dot(s, p) / determinant;
      if (u < -1e-10 || u > 1 + 1e-10) continue;
      const q = cross(s, ab),
        v = dot(direction, q) / determinant;
      if (v < -1e-10 || u + v > 1 + 1e-10) continue;
      const candidate = dot(ac, q) / determinant;
      if (candidate >= 0 && candidate < t) {
        t = candidate;
        instance = mesh.id;
      }
    }
  }
  return { t, instance };
}
const QUERY = `
@group(0) @binding(10) var<uniform> expectedWorld:vec4u;
fn worldSceneExpected()->vec4u{return expectedWorld;}
@group(0) @binding(7) var<storage,read> tests:array<Ray>;
@group(0) @binding(8) var<storage,read_write> result:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> metadata:array<vec4u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.x>=arrayLength(&tests)){return;}let ray=tests[gid.x];
 let world=traceWorld(ray,${STEPS}u,1.0);let coarse=traceGlobal(ray,${STEPS}u,1.0);
 let mesh=traceSdf(ray,grid.dimensionsCount.w,${STEPS}u,false);
 let m=sdfInstanceAt(0u);let b=worldBoundsAt(0u);
 let interval=worldLocalBoundsInterval((m.inverse*vec4f(ray.origin,1)).xyz,(m.inverse*vec4f(ray.direction,0)).xyz,b.lo.xyz,b.hi.xyz,ray.tMin,ray.tMax);
 let base=gid.x*4u;
 result[base]=vec4f(f32(world.state.x),world.metrics.x,world.position.z,f32(world.state.z));
 result[base+1u]=vec4f(f32(coarse.state.x),coarse.metrics.x,coarse.position.z,f32(coarse.state.z));
 result[base+2u]=vec4f(f32(mesh.state.x),mesh.metrics.x,mesh.position.z,f32(mesh.state.z));
 // Deliberately wrong near-geometry oracle: any ray/AABB intersection is a surface.
 result[base+3u]=vec4f(select(0.0,1.0,interval.x<=interval.y),interval.x,interval.y,0);
 metadata[gid.x*2u]=world.state;
 metadata[gid.x*2u+1u]=bitcast<vec4u>(world.normal);
}`;

/** Pipeline shape depends on WGSL and this device, not the future field bytes.
 * Both real compilations stay inside the same test/lease deadline. */
export function worldSilhouetteCode(flipFacing = false) {
  const source = worldTraversalWgsl('global-sdf');
  const marker = '(detail.reserved<<1u)|detail.frontFace;';
  if (source.split(marker).length !== 2)
    throw Error('Exactly one production facing marker is required');
  const production = flipFacing
    ? source.replace(marker, '(detail.reserved<<1u)|(detail.frontFace^1u);')
    : source;
  if (flipFacing && production === source)
    throw Error('The wrong-facing producer must change real WGSL');
  return production + QUERY;
}

function beginWorldPipelines(device: GPUDevice, flipFacing: boolean) {
  const code = worldSilhouetteCode(flipFacing);
  recordShaderInputs(code, flipFacing);
  const composeModule = device.createShaderModule({ code: GLOBAL_SDF_COMPOSE_WGSL });
  const queryModule = device.createShaderModule({ code });
  stage('compose-pipeline:begin', flipFacing);
  const compose = device
    .createComputePipelineAsync({
      layout: 'auto',
      compute: { module: composeModule, entryPoint: 'main' },
    })
    .then((pipeline) => {
      stage('compose-pipeline:done', flipFacing);
      return pipeline;
    });
  stage('query-pipeline:begin', flipFacing);
  const query = device
    .createComputePipelineAsync({
      layout: 'auto',
      compute: { module: queryModule, entryPoint: 'main' },
    })
    .then((pipeline) => {
      stage('query-pipeline:done', flipFacing);
      return pipeline;
    });
  return { code, pending: Promise.allSettled([compose, query]) };
}
async function finishWorldPipelines(work: ReturnType<typeof beginWorldPipelines>) {
  const [compose, query] = await work.pending;
  if (!compose || !query) throw Error('Both real World pipelines are required');
  if (compose.status === 'rejected') throw compose.reason;
  if (query.status === 'rejected') throw query.reason;
  return { compose: compose.value, query: query.value };
}

function silhouetteImage(
  rows: readonly {
    x: number;
    y: number;
    oracle: { instance: number };
    worldCorrect: boolean;
    detailCorrect: boolean;
  }[],
) {
  const image = new Uint8Array(SIZE * 3 * SIZE * 3 * 4);
  for (const [i, row] of rows.entries()) {
    const speedIndex = Math.floor(i / (SIZE * SIZE));
    for (let column = 0; column < 3; column++) {
      const color =
        column === 0
          ? row.oracle.instance === 1
            ? [120, 180, 255]
            : [255, 220, 80]
          : column === 1
            ? row.worldCorrect
              ? [40, 200, 120]
              : [255, 55, 55]
            : row.detailCorrect
              ? [40, 200, 120]
              : [255, 55, 55];
      image.set(
        [...color, 255],
        ((speedIndex * SIZE + row.y) * SIZE * 3 + column * SIZE + row.x) * 4,
      );
    }
  }
  return image;
}

export async function runWorldSilhouetteCases(flipFacing = false) {
  stage('adapter-request', flipFacing);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Real GPU required');
  const device = await adapter.requestDevice();
  stage('device-created', flipFacing);
  const errors: string[] = [],
    owned: GPUBuffer[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const make = (data: Uint8Array, usage: number) => {
    const buffer = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    owned.push(buffer);
    return buffer;
  };
  let pipelineWork: ReturnType<typeof beginWorldPipelines> | undefined;
  try {
    pipelineWork = beginWorldPipelines(device, flipFacing);
    const angle = Math.PI / 6,
      c = Math.cos(angle),
      s = Math.sin(angle);
    const near: AuthoredMesh = {
      id: 1,
      positions: Float32Array.from([1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
      indices: Uint32Array.from([
        4, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 5, 1, 0, 5, 2, 1, 5, 3, 2, 5, 0, 3,
      ]),
      transform: Float32Array.from([
        1.2 * c,
        1.2 * s,
        0,
        0,
        -0.7 * s,
        0.7 * c,
        0,
        0,
        0,
        0,
        0.4,
        0,
        0,
        0,
        0,
        1,
      ]),
    };
    const box = createBoxGeometry(5, 5, 0.1).unwrap();
    if (!box.indices) throw Error('Indexed far receiver required');
    const far: AuthoredMesh = {
      id: 2,
      positions: box.attributes.position as Float32Array,
      indices: Uint32Array.from(box.indices),
      transform: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1]),
    };
    const meshes = [near, far],
      sources = [];
    for (const mesh of meshes) {
      stage(`field-build:${mesh.id}:begin`, flipFacing);
      const field = (
        await buildVisibilityDistanceField(mesh.positions, mesh.indices, {
          voxelSize: 0.04,
          triangleSidedness: new Uint8Array(mesh.indices.length / 3),
        })
      ).unwrap();
      stage(`field-build:${mesh.id}:done`, flipFacing);
      sources.push({
        instanceId: mesh.id,
        geometryId: mesh.id,
        mask: 255,
        transform: mesh.transform,
        field,
      });
    }
    stage('scene-pack:begin', flipFacing);
    const composition = packGlobalSdfComposition(
      sources,
      {
        origin: [-3, -3, -3],
        dimensions: [17, 17, 17],
        spacing: 0.5,
        maxDistance: 1,
        coverageDistance: 0.5,
      },
      { sourceEpoch: 1 },
    ).unwrap();
    stage('scene-pack:done', flipFacing);
    const storage = GPUBufferUsage.STORAGE,
      instances = make(composition.data.instances, storage),
      fields = make(composition.data.fields, storage),
      bounds = make(composition.data.bounds, storage),
      grid = make(composition.data.settings, GPUBufferUsage.UNIFORM),
      voxels = make(composition.data.voxels, storage | GPUBufferUsage.COPY_SRC);
    if (!composition.sourceExpected) throw Error('Accepted producer source tuple is required');
    const expected = make(
      new Uint8Array(Uint32Array.from(composition.sourceExpected).buffer),
      GPUBufferUsage.UNIFORM,
    );
    const cases = [];
    for (const speed of [0.5, 1, 2])
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const origin: V = [
              Math.fround(-1.35 + ((x + 0.5) * 2.7) / SIZE),
              Math.fround(-0.95 + ((y + 0.5) * 1.9) / SIZE),
              -1.5,
            ],
            direction: V = [0, 0, speed],
            end = 5 / speed;
          cases.push({
            x,
            y,
            speed,
            origin,
            direction,
            end,
            oracle: triangleOracle(meshes, origin, direction, end),
          });
        }
    const rayBytes = new Uint8Array(cases.length * 48),
      rv = new DataView(rayBytes.buffer);
    for (const [i, row] of cases.entries()) {
      [...row.origin, 0, ...row.direction, row.end].forEach((v, k) => {
        rv.setFloat32(i * 48 + k * 4, v, true);
      });
      rv.setUint32(i * 48 + 32, 255, true);
    }
    const exact = exactAuthoredSurfaces(meshes, cases);
    const rays = make(rayBytes, storage),
      output = make(new Uint8Array(cases.length * 64), storage | GPUBufferUsage.COPY_SRC),
      metadata = make(new Uint8Array(cases.length * 32), storage | GPUBufferUsage.COPY_SRC),
      metadataStaging = make(
        new Uint8Array(metadata.size),
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      ),
      staging = make(
        new Uint8Array(output.size),
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      );
    const { compose, query } = await finishWorldPipelines(pipelineWork);
    const composeGroup = device.createBindGroup({
      layout: compose.getBindGroupLayout(0),
      entries: [instances, fields, bounds, grid, voxels].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const group = device.createBindGroup({
      layout: query.getBindGroupLayout(0),
      entries: [
        ...[voxels, grid, instances, fields, bounds].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
        { binding: 7, resource: { buffer: rays } },
        { binding: 8, resource: { buffer: output } },
        { binding: 9, resource: { buffer: metadata } },
        { binding: 10, resource: { buffer: expected } },
      ],
    });
    const encoder = device.createCommandEncoder(),
      composePass = encoder.beginComputePass({ label: 'world-silhouette.actual-composition' });
    composePass.setPipeline(compose);
    composePass.setBindGroup(0, composeGroup);
    composePass.dispatchWorkgroups(Math.ceil(composition.voxelCount / 64));
    composePass.end();
    const pass = encoder.beginComputePass({
      label: 'world-silhouette.production-vs-authored-triangles',
    });
    pass.setPipeline(query);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    encoder.copyBufferToBuffer(metadata, 0, metadataStaging, 0, metadata.size);
    device.queue.submit([encoder.finish()]);
    stage('submitted', flipFacing);
    await Promise.all([
      staging.mapAsync(GPUMapMode.READ),
      metadataStaging.mapAsync(GPUMapMode.READ),
    ]);
    stage('readback-mapped', flipFacing);
    const raw = new Uint8Array(staging.getMappedRange()).slice();
    const metadataRaw = new Uint8Array(metadataStaging.getMappedRange()).slice();
    staging.unmap();
    metadataStaging.unmap();
    await device.queue.onSubmittedWorkDone();
    const words = new Uint32Array(metadataRaw.buffer);
    const normals = new Float32Array(metadataRaw.buffer);
    const f = new Float32Array(raw.buffer),
      rows = cases.map((row, i) => {
        const state = Array.from(words.slice(i * 8, i * 8 + 4));
        const normal: V = [
          normals[i * 8 + 4] ?? NaN,
          normals[i * 8 + 5] ?? NaN,
          normals[i * 8 + 6] ?? NaN,
        ];
        const nearest = exact[i];
        if (!nearest?.length) throw Error('Every original ray must have an exact authored surface');
        const surface = assessAuthoredSurface(nearest, state, normal);
        const actual = Array.from(f.slice(i * 16, (i + 1) * 16)),
          error = Math.abs((actual[1] ?? NaN) - row.oracle.t) * row.speed,
          worldCorrect = actual[0] === 1 && error <= WORLD_TOLERANCE,
          detailCorrect =
            actual[8] === 5 &&
            Math.abs((actual[9] ?? NaN) - row.oracle.t) * row.speed <= WORLD_TOLERANCE;
        return {
          ...row,
          actual,
          error,
          worldCorrect,
          detailCorrect,
          state,
          normal,
          surface,
          exact: describeAuthoredSurface(nearest),
        };
      });
    const result = {
      scope:
        'Actual World/Global/Mesh trace against Float64 authored nearest triangles. Rotated nonuniform octahedron and far opaque box; no Card, emission, hardware path, frame or performance acceptance.',
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      grid: composition.grid,
      meshSpacing: 0.04,
      worldTolerance: WORLD_TOLERANCE,
      steps: STEPS,
      flipFacing,
      surfaceScope:
        'Exact dyadic closed-triangle nearest set and facing; normal engineering gates cos^2 >= 0.999999 and length in [0.9999,1.0001]. Unknown World rays remain failures of the original gate.',
      errors,
      cases: rows,
      worldFailures: rows.filter((row) => !row.worldCorrect).length,
      surfaceFailures: rows.filter(
        (row) =>
          row.state[0] === 1 &&
          (!row.surface.identityCorrect ||
            !row.surface.facingCorrect ||
            !row.surface.normalCorrect),
      ).length,
      resolved: rows.filter((row) => row.state[0] === 1).length,
      detailFailures: rows.filter((row) => !row.detailCorrect).length,
      coarseWrongButDetailCorrect: rows.filter((row) => !row.worldCorrect && row.detailCorrect)
        .length,
      aabbNegativeControlCaught: rows.filter(
        (row) => row.oracle.instance === 2 && row.actual[12] === 1,
      ).length,
    };
    const directory = artifactDirectory(flipFacing);
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/silhouette.json`, JSON.stringify(result, null, 2));
      writeFileSync(`${directory}/silhouette.raw`, raw);
      writeFileSync(`${directory}/silhouette-metadata.bin`, metadataRaw);
      writeFileSync(`${directory}/silhouette-rays.bin`, rayBytes);
      for (const mesh of meshes) {
        writeFileSync(
          `${directory}/authored-${mesh.id}-positions.bin`,
          new Uint8Array(mesh.positions.buffer),
        );
        writeFileSync(
          `${directory}/authored-${mesh.id}-indices.bin`,
          new Uint8Array(mesh.indices.buffer),
        );
        writeFileSync(
          `${directory}/authored-${mesh.id}-transform.bin`,
          new Uint8Array(mesh.transform.buffer),
        );
      }
      writeFileSync(
        `${directory}/silhouette-oracle-world-detail.png`,
        encodePng(SIZE * 3, SIZE * 3, silhouetteImage(rows)),
      );
    }
    return result;
  } finally {
    if (pipelineWork) await pipelineWork.pending;
    stage('dispose:begin', flipFacing);
    for (const buffer of owned) buffer.destroy();
    device.destroy();
    stage('dispose:done', flipFacing);
  }
}
