import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat3, mat4, quat, vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { ValidatedRenderable } from '../../../../render/src/record/frame-snapshot';
import {
  MESH_SSBO_BYTES,
  MESH_UBO_FULL_ARRAY_BYTES,
  uploadMeshSsboBatch,
} from '../../../../render/src/record/mesh-ssbo';

it.each([
  true,
  false,
])('reads the migrated Mesh layout and derives normals on GPU (storage=%s)', async (storage) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = await compiler.compileShader(
    `#define_import_path test::mesh-normal
#import forgeax_view::common::{Mesh, transformNormal}
@group(0) @binding(0) var<${storage ? 'storage, read' : 'uniform'}> rows: array<Mesh, 128>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe() {
  let row = rows[0];
  result[0] = vec4<f32>(normalize(transformNormal(row.worldFromLocal, vec3<f32>(0.3, 0.7, -0.2))), 1.0);
  ${storage ? 'result[1] = row.previousWorldFromLocal[3]; result[2] = row.temporal;' : 'result[1] = row.worldFromLocal[3];'}
  result[3] = vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(row.surface.z));
}`,
    {
      id: 'test::mesh-normal',
      defines: { STORAGE_BUFFER_AVAILABLE: storage },
      imports: {
        'forgeax_view::common': readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8'),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('GPU adapter unavailable');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const bytes = storage ? MESH_SSBO_BYTES * 128 : MESH_UBO_FULL_ARRAY_BYTES;
  const input = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | (storage ? GPUBufferUsage.STORAGE : GPUBufferUsage.UNIFORM),
  });
  const output = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'probe' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input, size: bytes } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const rotated = mat4.compose(
      mat4.create(),
      vec3.create(3, 4, 5),
      quat.fromEuler(quat.create(), 0.2, 0.6, -0.3, 'XYZ'),
      vec3.create(1.5, 0.5, 2),
    );
    const shear = Float32Array.from([1, 0, 0, 0, 0.4, 2, 0, 0, -0.2, 0.3, -3, 0, 3, 4, 5, 1]);
    const singular = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]);
    const small = Float32Array.from([0.004, 0, 0, 0, 0, 0.005, 0, 0, 0, 0, 0.006, 0, 3, 4, 5, 1]);
    for (const world of [mat4.create(), rotated, shear, singular, small]) {
      const previous = mat4.create();
      previous[12] = 17;
      previous[13] = -9;
      const entry = {
        source: {
          transform: { world },
          materials: [],
          lightingChannels: 0x80000001,
          temporal: { previousTransform: { world: previous }, reactive: true, motionValid: false },
        },
      } as unknown as ValidatedRenderable;
      const queue = {
        writeBuffer: (
          _buffer: Buffer,
          offset: number,
          data: Uint8Array,
          dataOffset: number,
          size: number,
        ) => {
          device.queue.writeBuffer(
            input,
            offset,
            data as Uint8Array<ArrayBuffer>,
            dataOffset,
            size,
          );
          return ok(undefined);
        },
      } as unknown as RhiQueue;
      uploadMeshSsboBatch(queue, { buffer: {} as Buffer }, [entry], null, [], undefined, storage);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      expect(new Uint32Array(actual.buffer)[15]).toBe(0x80000001);
      const n = mat3.normalMatrix(mat3.create(), world);
      const expected = [0, 1, 2].map(
        (i) => (n[i] as number) * 0.3 + (n[i + 3] as number) * 0.7 - (n[i + 6] as number) * 0.2,
      );
      const length = Math.hypot(...expected);
      for (let i = 0; i < 3; i++)
        expect(actual[i]).toBeCloseTo((expected[i] as number) / length, 5);
      expect(Array.from(actual.slice(4, 8))).toEqual(
        Array.from((storage ? previous : world).slice(12, 16)),
      );
      if (storage) expect(Array.from(actual.slice(8, 12))).toEqual([1, 0, 0, 0]);
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
}, 60_000);
