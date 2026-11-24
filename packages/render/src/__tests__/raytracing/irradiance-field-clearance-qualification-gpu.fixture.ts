import { qualificationBoxes80 } from './irradiance-field-clearance-qualification.fixture';

export const clearanceQuery = `
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField,fieldSegmentVisibility,irradianceField}
@group(0) @binding(0) var<storage,read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn verifyClearanceQualification() {
 let p=vec3f(1.0625,1.5,1.0625);let n=vec3f(-0.6,0,0.8);
 let wedge=irradianceField.bias.y==1.0;let v=select(vec3f(0,0,1),n,wedge);
 let anchor=p+n*0.25;let biased=anchor+v*irradianceField.bias.y;
 results[0]=sampleIrradianceField(p,n,v);
 results[1]=vec4f(fieldSegmentVisibility(biased,anchor),0,0,1);
 results[2]=vec4f(fieldSegmentVisibility(biased,vec3f(0,1,1)),0,0,1);
 if(wedge){
  results[3]=vec4f(fieldSegmentVisibility(anchor,vec3f(0,1,1)),0,0,1);
  results[4]=vec4f(0);results[5]=vec4f(0);
 }else{
  results[3]=vec4f(fieldSegmentVisibility(biased,vec3f(0,2,1)),0,0,1);
  results[4]=vec4f(fieldSegmentVisibility(biased,vec3f(0,1,2)),0,0,1);
  results[5]=vec4f(fieldSegmentVisibility(biased,vec3f(0,2,2)),0,0,1);
 }
}`;
export const clearanceThirdEdgeBlock = `    if (clearanceProof) {
      let anchorSegment = fieldSegmentVisibility(lightingPosition, probePosition);
      if (anchorSegment < 0.0) { (*corners).incomplete = true; return 0.0; }
      if (anchorSegment == 0.0) { continue; }
    }
`;
export const clearanceCaseNames = [
  'pending',
  'inside',
  'untraced',
  'invalid',
  'supported-black',
  'alternative-untraced',
  'bad-anchor',
  'unknown-anchor',
  'across-wall',
  'third-edge-wedge',
] as const;
export type ClearanceCaseName = (typeof clearanceCaseNames)[number];
type Box = readonly [readonly number[], readonly number[]];
function boxDistance(p: readonly number[], box: Box): number {
  const q = p.map(
    (v, i) =>
      Math.abs(v - ((box[0][i] ?? 0) + (box[1][i] ?? 0)) / 2) -
      ((box[1][i] ?? 0) - (box[0][i] ?? 0)) / 2,
  );
  return Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
}
export function clearanceInputs(name: ClearanceCaseName) {
  const field = new Uint8Array(256),
    f = new Float32Array(field.buffer),
    u = new Uint32Array(field.buffer),
    i = new Int32Array(field.buffer);
  f.set([0, 0, 0, 1], 0);
  u.set([4, 4, 4, 64], 4);
  f.set([0.25, 0.1, 3, 0], 8);
  if (name === 'third-edge-wedge') f[9] = 1;
  u.set([1, 64, 0, 1], 12);
  i.set([4, 4, 4, 0], 48);
  const radiance = new Float32Array(64 * 144 * 4),
    moments = new Float32Array(64 * 64 * 2),
    meta = new Uint32Array(64 * 4);
  for (let probe = 0; probe < 64; probe++) {
    meta.set([1, 2, 0, 0], probe * 4);
    for (let t = 0; t < 144; t++)
      radiance.set(
        name === 'supported-black' ? [0, 0, 0, 1] : [0.25, 0.125, 0.5, 1],
        (probe * 144 + t) * 4,
      );
    for (let t = 0; t < 64; t++) moments.set([8, 64], (probe * 64 + t) * 2);
  }
  for (const y of [1, 2]) for (const z of [1, 2]) meta.set([1, 1, 0, 0], (z * 16 + y * 4) * 4);
  const state =
    name === 'inside' || name === 'supported-black'
      ? 2
      : name === 'untraced'
        ? 0
        : name === 'invalid'
          ? 99
          : 3;
  // .25 is exactly binary16 0x3400; z lives in the low half of meta.w.
  meta.set([0, state, 0, 0x3400], 38 * 4);
  if (name === 'alternative-untraced') meta.set([0, 0, 0, 0], 20 * 4);
  if (name === 'third-edge-wedge')
    for (const probe of [24, 36, 40]) meta.set([1, 2, 0, 0], probe * 4);
  const grid = new Uint8Array(48);
  new Float32Array(grid.buffer).set([-1, -1, 0, 0.125]);
  new Uint32Array(grid.buffer).set([33, 41, 33, 33 * 41 * 33], 4);
  return { field, radiance, moments, meta, grid, visibility: clearanceVisibility(name) };
}

function clearanceBoxes(name: ClearanceCaseName): Box[] {
  const boxes: Box[] = qualificationBoxes80.map(
    (box) => box.map((p) => p.map((v) => v / 80)) as unknown as Box,
  );
  if (name === 'bad-anchor')
    boxes.push([
      [-0.5, -1, 1.25],
      [1.5, 4, 1.5],
    ]);
  if (name === 'across-wall')
    boxes.push([
      [0.375, -1, 0],
      [0.625, 4, 4],
    ]);
  if (name === 'third-edge-wedge') {
    boxes.push([
      [0.375, -1, 0.875],
      [0.625, 4, 1.125],
    ]);
    for (const [y, z] of [
      [2, 1],
      [1, 2],
      [2, 2],
    ])
      boxes.push([
        [-0.125, (y ?? 0) - 0.125, (z ?? 0) - 0.125],
        [0.125, (y ?? 0) + 0.125, (z ?? 0) + 0.125],
      ]);
  }
  return boxes;
}

function clearanceVisibility(name: ClearanceCaseName) {
  const boxes = clearanceBoxes(name);
  const visibility = new Float32Array(33 * 41 * 33 * 2);
  for (let z = 0; z < 33; z++)
    for (let y = 0; y < 41; y++)
      for (let x = 0; x < 33; x++) {
        const p = [-1 + x * 0.125, -1 + y * 0.125, z * 0.125];
        const offset = ((z * 41 + y) * 33 + x) * 2;
        visibility.set([Math.min(...boxes.map((box) => boxDistance(p, box))), 1], offset);
        if (
          name === 'unknown-anchor' &&
          x >= 15 &&
          x <= 16 &&
          y >= 20 &&
          y <= 21 &&
          z >= 10 &&
          z <= 11
        )
          visibility[offset + 1] = -1;
      }
  return visibility;
}

export async function runClearanceQualification(
  device: GPUDevice,
  code: string,
  save: (
    name: ClearanceCaseName,
    input: ReturnType<typeof clearanceInputs>,
    output: Uint8Array,
  ) => void,
  cases: readonly ClearanceCaseName[] = clearanceCaseNames,
  phase: (stage: string, name?: ClearanceCaseName) => void = () => {},
) {
  const buffers: GPUBuffer[] = [];
  const buffer = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage });
    buffers.push(b);
    return b;
  };
  const field = buffer(256, 64 | 8),
    radiance = buffer(64 * 144 * 16, 128 | 8),
    moments = buffer(64 * 64 * 8, 128 | 8),
    meta = buffer(64 * 16, 128 | 8),
    grid = buffer(48, 64 | 8),
    output = buffer(96, 128 | 4),
    staging = buffer(96, 1 | 8);
  const texture = device.createTexture({
    size: [33, 41, 33],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  try {
    phase('createShaderModule.begin');
    const module = device.createShaderModule({ code });
    phase('createShaderModule.end');
    const fieldEntries: GPUBindGroupEntry[] = [
      ...[field, radiance, moments, meta, grid].map((b, binding) => ({
        binding,
        resource: { buffer: b },
      })),
      { binding: 5, resource: texture.createView() },
    ];
    const pipelines = new Map<string, { pipeline: GPUComputePipeline; groups: GPUBindGroup[] }>();
    const prepare = async (entryPoint: string) => {
      const cached = pipelines.get(entryPoint);
      if (cached) return cached;
      phase('createComputePipeline.begin');
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint },
      });
      phase('createComputePipeline.end');
      const groups = [
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: output } }],
        }),
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: fieldEntries }),
      ];
      const value = { pipeline, groups };
      pipelines.set(entryPoint, value);
      return value;
    };
    const result: Record<string, number[]> = {};
    for (const name of cases) {
      const { pipeline, groups } = await prepare('verifyClearanceQualification');
      const input = clearanceInputs(name);
      for (const [b, data] of [
        [field, input.field],
        [radiance, input.radiance],
        [moments, input.moments],
        [meta, input.meta],
        [grid, input.grid],
      ] as const)
        device.queue.writeBuffer(
          b,
          0,
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      device.queue.writeTexture(
        { texture },
        input.visibility as Float32Array<ArrayBuffer>,
        { bytesPerRow: 33 * 8, rowsPerImage: 41 },
        [33, 41, 33],
      );
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((g, index) => {
        pass.setBindGroup(index, g);
      });
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, 96);
      phase('submit', name);
      device.queue.submit([encoder.finish()]);
      phase('map.begin', name);
      await staging.mapAsync(1);
      phase('map.end', name);
      const bytes = new Uint8Array(staging.getMappedRange().slice(0));
      staging.unmap();
      save(name, input, bytes);
      result[name] = Array.from(new Float32Array(bytes.buffer));
    }
    return result;
  } finally {
    texture.destroy();
    for (const b of buffers) b.destroy();
  }
}
