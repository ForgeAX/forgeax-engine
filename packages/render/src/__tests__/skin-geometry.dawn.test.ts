import { mat4 } from '@forgeax/engine-math';
import { skinVertexPosition } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { SKIN_BOUNDS_WGSL } from '../gpu-driven/skin-bounds.wgsl';
import { GpuInputArena } from '../gpu-input-arena';
import { skinGeometryEnvelopes } from '../scene/skin-geometry';
import { SkinInputs } from '../scene/skin-inputs';

it('encloses actual weighted world vertices before culling and leaves unsupported poses uncullable', async () => {
  const mesh: MeshAsset = {
    kind: 'mesh',
    vertices: new Float32Array(0),
    submeshes: [],
    materialSlots: [],
    attributes: {
      position: new Float32Array([-2, 1, 0, 3, -1, 2]),
      skinIndex: new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0]),
      skinWeight: new Float32Array([0.25, 0.75, 0, 0, 0.5, 1.5, 0, 0]),
    },
  };
  const envelopes = skinGeometryEnvelopes(mesh);
  if (!envelopes) throw new Error('Missing admitted Skin geometry envelopes');
  const first = mat4.identity(mat4.create()),
    second = mat4.identity(mat4.create());
  first[0] = 2;
  first[5] = 3;
  first[10] = 4;
  first[12] = 7;
  second[0] = -1;
  second[5] = 2;
  second[10] = 0.5;
  second[12] = -2;
  second[13] = 4;
  const palette = new Float32Array(10 * 2 * 16);
  for (let pair = 0; pair < 4; pair++) {
    palette.set(first, pair * 32);
    palette.set(second, pair * 32 + 16);
  }
  palette[32 + 3] = 0.5; // Projective composed pose: no affine enclosure proof.
  palette[3 * 32] = 3e38; // Finite input whose box projection overflows.
  for (let pair = 4; pair < 9; pair++) {
    palette.set(mat4.identity(mat4.create()), pair * 32);
    palette.set(mat4.identity(mat4.create()), pair * 32 + 16);
    palette[pair * 32] = pair === 4 ? 1e-40 : 1e38;
  }
  palette[7 * 32] = 2 ** -126;
  palette[8 * 32] = 1e-34;
  palette[8 * 32 + 4] = -2e-34;
  palette[8 * 32 + 5] = 2 ** -126;
  palette.set(mat4.identity(mat4.create()), 9 * 32);
  palette[9 * 32] = 0.75 * 3.4028234663852886e38;
  palette[9 * 32 + 12] = 1;
  const weighted = new Float32Array([0.01, 0.01, 1, 1, 1e38, 0, 0, 0, 1e38, 0, 0, 0]),
    cancelling = new Float32Array([1e-4, 1e-4, 1, 1, 2e38, 1e38, 0, 0, 2e38, 1e38, 0, 0]);
  const large = new Float32Array([1, 1, 1, 1, 1e38, 0, 0, 0, 1e38, 0, 0, 0]),
    small = new Float32Array([1, 1, 1, 1, 1e-40, 0, 0, 0, 1e-40, 0, 0, 0]),
    origin = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const largeAt = 4 + envelopes.length,
    smallAt = largeAt + large.length,
    originAt = smallAt + small.length,
    weightedAt = originAt + origin.length,
    cancellingAt = weightedAt + weighted.length,
    overflowAt = cancellingAt + cancelling.length;
  const overflow = new Float32Array([2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Missing actual native adapter');
  const device = await adapter.requestDevice(),
    buffers: GPUBuffer[] = [],
    failures: unknown[] = [];
  let scope = false;
  const make = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    device.pushErrorScope('validation');
    scope = true;
    const input = make(
      (overflowAt + overflow.length) * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const poses = make(palette.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const output = make(14 * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = make(14 * 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(input, 0, new Uint32Array([0x7f800000, 0, 0, 0]));
    device.queue.writeBuffer(input, 16, envelopes);
    device.queue.writeBuffer(input, largeAt * 4, large);
    device.queue.writeBuffer(input, smallAt * 4, small);
    device.queue.writeBuffer(input, originAt * 4, origin);
    device.queue.writeBuffer(input, weightedAt * 4, weighted);
    device.queue.writeBuffer(input, cancellingAt * 4, cancelling);
    device.queue.writeBuffer(input, overflowAt * 4, overflow);
    device.queue.writeBuffer(poses, 0, palette);
    const code =
      SKIN_BOUNDS_WGSL +
      `
@group(0) @binding(0) var<storage,read> skinInputs:array<u32>;
@group(0) @binding(1) var<storage,read> skinOutput:array<vec4<u32>>;
@group(0) @binding(2) var<storage,read_write> results:array<vec4<f32>>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id:vec3<u32>) {
  var geometry=select(4u,0u,id.x==4u);
  if (id.x==8u) { geometry=${largeAt}u; }
  if (id.x==9u) { geometry=${smallAt}u; }
  if (id.x==10u) { geometry=${originAt}u; }
  if (id.x==11u) { geometry=${weightedAt}u; }
  if (id.x==12u) { geometry=${cancellingAt}u; }
  if (id.x==13u) { geometry=${overflowAt}u; }
  let count=select(2u,1u,id.x==2u);
  var radius=select(0.0,0.5,id.x==5u);
  if (id.x==6u) { radius=bitcast<f32>(skinInputs[0]); }
  if (id.x==7u) { radius=-1.0; }
  var paletteBase=select(min(id.x,3u)*8u,0u,id.x>=5u);
  if (id.x>=8u) { paletteBase=(id.x-4u)*8u; }
  let bounds=skinEnvelopeBounds(geometry,paletteBase,count,radius);
  results[id.x*2u]=vec4<f32>(bounds.minimum,f32(bounds.valid));
  results[id.x*2u+1u]=vec4<f32>(bounds.maximum,0.0);
}`;
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      compute: { module: device.createShaderModule({ code }), entryPoint: 'probe' },
    });
    const group = device.createBindGroup({
      layout: bgl,
      entries: [input, poses, output].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(14);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 14 * 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    expect(result[3]).toBe(1);
    const point = new Float64Array(4);
    for (let vertex = 0; vertex < 2; vertex++) {
      expect(
        skinVertexPosition(
          point,
          mesh.attributes.position as Float32Array,
          mesh.attributes.skinIndex as Uint16Array,
          mesh.attributes.skinWeight as Float32Array,
          palette.subarray(0, 32),
          vertex,
        ),
      ).toBe(true);
      for (let axis = 0; axis < 3; axis++) {
        expect(result[axis]).toBeLessThanOrEqual(point[axis] as number);
        expect(result[axis + 4]).toBeGreaterThanOrEqual(point[axis] as number);
      }
    }
    const cpuArena = new GpuInputArena(),
      cpuSkin = new SkinInputs(cpuArena),
      source = cpuSkin.source();
    let cpuFrame: ReturnType<SkinInputs['capture']> | undefined;
    try {
      const inverse = new Float32Array(32);
      inverse.set(mat4.identity(mat4.create()));
      inverse.set(mat4.identity(mat4.create()), 16);
      const skeleton = cpuSkin.skeleton(2, inverse);
      cpuSkin.setJoint(source, 17, first);
      cpuSkin.setJoint(source, 29, second);
      cpuSkin.bind(0, source, skeleton, new Uint32Array([17, 29]));
      const fixed = cpuSkin.capture(),
        cpuBounds = new Float32Array(6),
        cpuMatrix = mat4.create(),
        cpuInverse = mat4.create();
      cpuFrame = fixed;
      for (const index of [0, 5]) {
        expect(
          fixed.bounds(0, envelopes, index === 5 ? 0.5 : 0, cpuBounds, cpuMatrix, cpuInverse),
        ).toBe(true);
        for (let axis = 0; axis < 3; axis++) {
          expect(cpuBounds[axis]).toBeLessThanOrEqual(result[index * 8 + axis] as number);
          expect(cpuBounds[axis + 3]).toBeGreaterThanOrEqual(
            result[index * 8 + axis + 4] as number,
          );
        }
      }
    } finally {
      cpuFrame?.release();
      cpuSkin.dispose();
      cpuArena.dispose();
    }
    for (const index of [1, 2, 3, 4, 6, 7]) expect(result[index * 8 + 3]).toBe(0);
    expect(result[13 * 8 + 3]).toBe(0); // Weighted coefficient overflows before multiplying the zero vertex.
    expect(result[8 * 8 + 3]).toBe(0); // Subnormal task coefficients are not a portable cull proof.
    expect(result[9 * 8 + 3]).toBe(0); // Geometry input may flush differently from vertex fetch.
    expect(result[10 * 8 + 3]).toBe(1);
    // Zero received radius can be a legal flush of a tiny positive material radius.
    expect(result[10 * 8]).toBeLessThanOrEqual(-0.01);
    expect(result[10 * 8 + 4]).toBeGreaterThanOrEqual(0.01);
    expect.soft(result[11 * 8 + 3]).toBe(1);
    expect.soft(result[11 * 8]).toBeLessThanOrEqual(0);
    expect.soft(result[11 * 8 + 4]).toBeGreaterThanOrEqual(0);
    const remaining = Math.fround(
      Math.fround(Math.fround(-2e-34) * Math.fround(1e-4)) * Math.fround(1e38),
    );
    expect(remaining).toBeLessThan(-1.9);
    expect.soft(result[12 * 8 + 3]).toBe(1);
    expect.soft(result[12 * 8]).toBeLessThanOrEqual(remaining);
    expect.soft(result[12 * 8 + 4]).toBeGreaterThanOrEqual(remaining);
    expect.soft(result[12 * 8]).toBeLessThanOrEqual(remaining / Math.fround(1e-4));
    expect.soft(result[12 * 8 + 4]).toBeGreaterThanOrEqual(remaining / Math.fround(1e-4));
    expect(result[5 * 8 + 3]).toBe(1);
    const displaced = (mesh.attributes.position as Float32Array).slice();
    const basePositions = mesh.attributes.position as Float32Array;
    for (let corner = 0; corner < 8; corner++) {
      for (let vertex = 0; vertex < 2; vertex++) {
        for (let axis = 0; axis < 3; axis++)
          displaced[vertex * 3 + axis] =
            (basePositions[vertex * 3 + axis] as number) + (corner & (1 << axis) ? 0.5 : -0.5);
        expect(
          skinVertexPosition(
            point,
            displaced,
            mesh.attributes.skinIndex as Uint16Array,
            mesh.attributes.skinWeight as Float32Array,
            palette.subarray(0, 32),
            vertex,
          ),
        ).toBe(true);
        for (let axis = 0; axis < 3; axis++) {
          expect(result[5 * 8 + axis]).toBeLessThanOrEqual(point[axis] as number);
          expect(result[5 * 8 + axis + 4]).toBeGreaterThanOrEqual(point[axis] as number);
        }
      }
    }
  } catch (cause) {
    failures.push(cause);
  } finally {
    try {
      await device.queue.onSubmittedWorkDone();
    } catch (cause) {
      failures.push(cause);
    }
    if (scope) {
      try {
        const error = await device.popErrorScope();
        if (error) failures.push(error);
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const buffer of buffers) {
      try {
        buffer.destroy();
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      device.destroy();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Native Skin envelope qualification failed');
});
