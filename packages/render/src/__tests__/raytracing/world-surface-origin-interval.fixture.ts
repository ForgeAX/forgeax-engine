import { mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import {
  assessAuthoredSurface,
  describeAuthoredSurface,
  type ExactAuthoredMesh,
  exactAuthoredSurfaces,
} from './world-silhouette-exact.fixture';
import { rasterizeSurfaceOriginVisualization } from './world-surface-origin-visualization.fixture';

type Point = readonly [number, number, number];
interface OriginCase {
  name: string;
  position: Point;
  direction: Point;
  bias: number;
  end: number;
  expectedOwner: number;
}

function originCases(): OriginCase[] {
  const rows: OriginCase[] = [];
  for (const bias of [0.125, 0.25]) {
    for (const direction of [
      [0, 0, 1],
      [0.6, 0, 0.8],
      [0, -0.6, 0.8],
    ] as const)
      for (const position of [
        [0, 0, 0],
        [0.125, 0, 0],
        [0, 0.125, 0],
      ] as const)
        rows.push({
          name: `near-${bias}-${direction.join(',')}-${position.join(',')}`,
          position,
          direction,
          bias,
          end: 1.5,
          expectedOwner: 2,
        });
    rows.push(
      {
        name: `clear-${bias}`,
        position: [0.5, 0, 0],
        direction: [0, 0, 1],
        bias,
        end: 1.5,
        expectedOwner: 3,
      },
      {
        name: `finite-${bias}`,
        position: [0, 0, 0],
        direction: [0, 0, 1],
        bias,
        end: 0.03125,
        expectedOwner: 0,
      },
      {
        name: `miss-${bias}`,
        position: [3, 0, 0],
        direction: [0, 0, 1],
        bias,
        end: 1.5,
        expectedOwner: 0,
      },
    );
  }
  return rows;
}

async function authoredWorld() {
  const sources = [];
  const meshes: ExactAuthoredMesh[] = [];
  // The receiver ends at z=0, the closed blocker spans [7/128,9/128],
  // and the broad target starts at 63/64. These authored dyadic coordinates
  // are independent of the field, the packed inverse, and the GPU hit result.
  for (const [id, width, depth, z] of [
    [1, 4, 0.25, -0.125],
    [2, 0.5, 0.015625, 0.0625],
    [3, 4, 0.03125, 1],
  ] as const) {
    const mesh = createBoxGeometry(width, width, depth).unwrap();
    if (!mesh.indices) throw Error('Complete closed authored cube required');
    const field = (
      await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, mesh.indices, {
        voxelSize: 0.125,
        triangleSidedness: new Uint8Array(mesh.indices.length / 3),
      })
    ).unwrap();
    const transform = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]);
    meshes.push({
      id,
      positions: mesh.attributes.position as Float32Array,
      indices: Uint32Array.from(mesh.indices),
      transform,
    });
    sources.push({ instanceId: id, geometryId: id, mask: 255, field, transform });
  }
  const packed = packGlobalSdfComposition(
    sources,
    {
      origin: [-3, -3, -1],
      dimensions: [25, 25, 13],
      spacing: 0.25,
      maxDistance: 2,
      coverageDistance: 0.25,
    },
    { sourceEpoch: 1 },
  ).unwrap();
  return { packed, meshes };
}

const OBSERVE = `
struct Receiver { positionBias:vec4f, directionEnd:vec4f }
@group(0) @binding(7) var<storage,read> receivers:array<Receiver>;
struct Observation { reference:Hit, shifted:Hit, origin:vec4f, referenceOrigin:vec4f }
@group(0) @binding(8) var<storage,read_write> observed:array<Observation>;
@group(0) @binding(9) var<uniform> expectedWorld:vec4u;
fn worldSceneExpected()->vec4u{return expectedWorld;}
@compute @workgroup_size(64) fn observeOriginInterval(@builtin(global_invocation_id) id:vec3u){
 // Preserve all 48 rays, with one World query per invocation as in production.
 // Each invocation writes disjoint members of its pair's observation.
 if(id.x>=arrayLength(&receivers)*2u){return;}
 let i=id.x/2u;let shiftedQuery=(id.x&1u)!=0u;
 let r=receivers[i];let p=r.positionBias.xyz;let n=vec3f(0,0,1);
 // A separately authored, dyadic point in the open space before the blocker.
 let referenceOrigin=p+n*(1.0/65536.0);
 let shifted=worldSurfaceOrigin(p,n,r.positionBias.w);
 let origin=select(referenceOrigin,shifted,shiftedQuery);
 let hit=traceWorld(Ray(origin,0.0,r.directionEnd.xyz,r.directionEnd.w,vec4u(1u,0u,0u,0u)),256u,1.0);
 if(shiftedQuery){observed[i].shifted=hit;observed[i].origin=vec4f(origin,1);}
 else{observed[i].reference=hit;observed[i].referenceOrigin=vec4f(origin,1);}
}`;

function decodeHit(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);
  const state = Array.from({ length: 4 }, (_, i) => view.getUint32(i * 4, true));
  const values = Array.from({ length: 12 }, (_, i) => view.getFloat32(16 + i * 4, true));
  return {
    state,
    metrics: values.slice(0, 4),
    position: values.slice(4, 8),
    normal: values.slice(8),
  };
}

function exactProof(
  meshes: ExactAuthoredMesh[],
  cases: OriginCase[],
  raw: Uint8Array,
  inputs: Float32Array,
) {
  const records = cases.map((row, i) => ({
    ...row,
    direction: Array.from(inputs.slice(i * 8 + 4, i * 8 + 7)) as unknown as Point,
    reference: decodeHit(raw, i * 160),
    shifted: decodeHit(raw, i * 160 + 64),
    actualOrigin: Array.from(new Float32Array(raw.buffer, i * 160 + 128, 4)),
    actualReferenceOrigin: Array.from(new Float32Array(raw.buffer, i * 160 + 144, 4)),
  }));
  const origin = (row: (typeof records)[number], shifted: boolean): Point =>
    shifted
      ? [row.actualOrigin[0] ?? NaN, row.actualOrigin[1] ?? NaN, row.actualOrigin[2] ?? NaN]
      : [
          row.actualReferenceOrigin[0] ?? NaN,
          row.actualReferenceOrigin[1] ?? NaN,
          row.actualReferenceOrigin[2] ?? NaN,
        ];
  const assess = (shifted: boolean) => {
    const nearest = exactAuthoredSurfaces(
      meshes,
      records.map((row) => ({
        origin: origin(row, shifted),
        direction: row.direction,
        end: row.end,
      })),
    );
    return records.map((row, i) => {
      const actual = shifted ? row.shifted : row.reference;
      const expected = nearest[i];
      if (!expected) throw Error('One exact independent oracle record per actual GPU ray required');
      const surface = assessAuthoredSurface(expected, actual.state, [
        actual.normal[0] ?? NaN,
        actual.normal[1] ?? NaN,
        actual.normal[2] ?? NaN,
      ]);
      const correct =
        expected.length === 0
          ? actual.state[0] === 0
          : surface.identityCorrect && surface.facingCorrect && surface.normalCorrect;
      return { correct, nearest: describeAuthoredSurface(expected), surface };
    });
  };
  const reference = assess(false),
    shifted = assess(true);
  return records.map((row, i) => ({
    ...row,
    exactReference: reference[i],
    exactShifted: shifted[i],
  }));
}

function ownerImage(records: { reference: { state: number[] }; shifted: { state: number[] } }[]) {
  const width = 12 * 16,
    height = 4 * 16,
    image = new Uint8Array(width * height * 4);
  const colors = [
    [0, 0, 0],
    [32, 96, 255],
    [32, 220, 96],
    [255, 160, 32],
  ];
  for (const [i, row] of records.entries()) {
    for (const [panel, hit] of [row.reference, row.shifted].entries()) {
      const owner = hit.state[0] === 0 ? 0 : hit.state[3];
      const color = colors[owner ?? -1] ?? [255, 0, 255];
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const offset =
            (((panel * 2 + Math.floor(i / 12)) * 16 + y) * width + (i % 12) * 16 + x) * 4;
          image.set([...color, 255], offset);
        }
    }
  }
  return encodePng(width, height, image);
}

export async function observeSurfaceOriginIntervals() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Actual GPU required for the production software World seam');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const make = (bytes: Uint8Array, usage: number) => {
    const buffer = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(bytes);
    buffer.unmap();
    buffers.push(buffer);
    return buffer;
  };
  try {
    const { packed: scene, meshes } = await authoredWorld(),
      cases = originCases();
    if (!scene.sourceExpected) throw Error('Independent production source tuple required');
    const inputs = new Float32Array(cases.length * 8);
    for (const [i, row] of cases.entries())
      inputs.set([...row.position, row.bias, ...row.direction, row.end], i * 8);
    const code = worldTraversalWgsl('global-sdf') + OBSERVE;
    const module = device.createShaderModule({ code });
    const compilation = (await module.getCompilationInfo()).messages.filter(
      (m) => m.type === 'error',
    );
    if (compilation.length) throw Error(compilation.map((m) => m.message).join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'observeOriginInterval' },
    });
    const output = make(new Uint8Array(cases.length * 160), 128 | 4);
    const entries = [
      [1, make(scene.data.settings, 64)],
      [2, make(scene.data.instances, 128)],
      [3, make(scene.data.fields, 128)],
      [4, make(scene.data.bounds, 128)],
      [7, make(new Uint8Array(inputs.buffer), 128)],
      [8, output],
      [9, make(new Uint8Array(Uint32Array.from(scene.sourceExpected).buffer), 64)],
    ] as const;
    // The exact World consumer deliberately never samples the coarse voxel
    // hint. Bind only active entries in the inferred layout; no fake binding0.
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    });
    const staging = make(new Uint8Array(output.size), 1 | 8);
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((cases.length * 2) / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const raw = new Uint8Array(staging.getMappedRange()).slice();
    staging.unmap();
    const directory = process.env.FORGEAX_GI_ORIGIN_INTERVAL_ARTIFACTS;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/origin-interval.wgsl`, code);
      writeFileSync(`${directory}/observed.bin`, raw);
      writeFileSync(`${directory}/source-input.bin`, new Uint8Array(inputs.buffer));
      for (const name of ['instances', 'fields', 'bounds', 'settings'] as const)
        writeFileSync(`${directory}/world-${name}.bin`, scene.data[name]);
      for (const mesh of meshes)
        for (const name of ['positions', 'indices', 'transform'] as const)
          writeFileSync(
            `${directory}/authored-${mesh.id}-${name}.bin`,
            new Uint8Array(mesh[name].buffer, mesh[name].byteOffset, mesh[name].byteLength),
          );
    }
    const records = exactProof(meshes, cases, raw, inputs);
    if (directory) {
      writeFileSync(
        `${directory}/observed.json`,
        JSON.stringify({ records, errors, sourceExpected: scene.sourceExpected }, null, 2),
      );
      writeFileSync(`${directory}/owners.png`, ownerImage(records));
      const selected = records.find((row) => row.name === 'near-0.125-0,0,1-0.125,0,0');
      if (!selected)
        throw Error('The fixed off-centre source record is required for visualization');
      const visualization = await rasterizeSurfaceOriginVisualization(device, meshes, selected);
      writeFileSync(`${directory}/authored-scene.png`, visualization.png);
      writeFileSync(
        `${directory}/authored-scene.json`,
        JSON.stringify(visualization.metadata, null, 2),
      );
    }
    return { records, errors };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}
