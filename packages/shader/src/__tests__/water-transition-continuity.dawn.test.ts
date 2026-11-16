import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waterMeshContinuityVertex } from '../../../water/src/water-mesh-continuity.js';
import {
  continuityComputeSource,
  continuityMorphCase,
  continuityMorphComputeSource,
  continuityShaderDefines,
  continuityShaderImports,
  continuityTilePayload,
} from './water-transition-continuity.fixture.js';

let device: GPUDevice;
const errors: string[] = [];
beforeAll(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('requires actual Dawn adapter');
  device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
});
afterAll(() => {
  device?.destroy();
  expect(errors).toEqual([]);
});
async function execute(enabled: boolean) {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as typeof import('../../../shader-compiler/src/index.js');
  const compiled = (
    await compiler.compileShader(continuityComputeSource, {
      id: 'water-transition-continuity',
      imports: continuityShaderImports(),
      defines: continuityShaderDefines,
    })
  ).unwrap();
  const module = device.createShaderModule({ code: compiled.wgsl });
  expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
    [],
  );
  const allocated: GPUBuffer[] = [];
  function buffer(data: ArrayBufferView, uniform = false) {
    const b = device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST,
    });
    allocated.push(b);
    device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  }
  const body = new Uint8Array(256),
    view = new DataView(body.buffer);
  for (let i = 0; i < 2; i++) {
    view.setUint32(i * 128 + 4, i === 1 ? 1 : 0, true);
    new Float32Array(body.buffer, i * 128 + 16, 4).set(i === 1 ? [0.3, 0.1, 4, 1] : [9, 8, 4, 1]);
    new Float32Array(body.buffer, i * 128 + 64, 4).set([20971.52, 4, 0, 0]);
    new Float32Array(body.buffer, i * 128 + 80, 4).set(i === 0 ? [30, 12, 2.8, 0] : [0, 12, 0, 0]);
    new Uint32Array(body.buffer, i * 128 + 96, 4).set([0, 0, 0, 0]);
  }
  const output = device.createBuffer({
    size: 5 * 8 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  allocated.push(output);
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  allocated.push(readback);
  const resources = new Map<string, GPUBindingResource>([
    ['0:0', { buffer: output }],
    ['1:0', { buffer: buffer(new Float32Array([10.24, 1, 0, 0]), true) }],
    ['2:16', { buffer: buffer(body) }],
    [
      '2:17',
      { buffer: buffer(new Float32Array([1, 0, 0.5, 8, 0.25, Math.PI / 4, 1, 1, 0, 0, 0, 0])) },
    ],
    ['2:21', { buffer: buffer(new Uint32Array([0, 0, 0, 0]), true) }],
    ['2:22', { buffer: buffer(continuityTilePayload(enabled)) }],
  ]);
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const reads = compiled.reflection.entryPoints?.find((p) => p.name === 'main')?.bindings ?? [];
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const group of new Set(reads.map((b) => b.group))) {
      const entries = reads
        .filter((b) => b.group === group)
        .map((b) => {
          const resource = resources.get(`${group}:${b.binding}`);
          if (!resource) throw Error(`missing production binding ${group}:${b.binding}`);
          return { binding: b.binding, resource };
        });
      pass.setBindGroup(
        group,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }),
      );
    }
    pass.dispatchWorkgroups(5);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    return data;
  } finally {
    for (const b of allocated) b.destroy();
  }
}
describe('production terminal continuity numeric support on Dawn', () => {
  it('closes all actual boundary triangle vertices and interpolation, keeps source flow/depth and target clock', async () => {
    const values = await execute(true);
    expect(Array.from(values).every(Number.isFinite)).toBe(true);
    for (let i = 0; i < 4; i++) {
      const offset = i * 32;
      expect(values[offset + 3]).toBeCloseTo(1, 6);
      for (const axis of [0, 1, 2])
        expect(values[offset + axis]).toBeCloseTo(values[offset + 12 + axis] ?? NaN, 5);
      expect(values[offset + 11]).toBe(12);
      expect(values[offset + 15]).toBeCloseTo(0.3, 6);
      expect(values[offset + 7]).toBeCloseTo(0.1, 6);
      for (const axis of [0, 1, 2])
        expect(values[offset + 4 + axis]).toBeCloseTo(values[offset + 28 + axis] ?? NaN, 5);
      expect(values[offset + 16]).toBeCloseTo(2.8, 6);
      expect(values[offset + 18]).toBe(0);
      expect(values[offset + 19]).toBe(1);
    }
    // Upstream is outside the authored reach: 30 m source plane remains untouched.
    expect(values[4 * 32 + 1]).toBe(30);
    expect(values[4 * 32 + 3]).toBe(0);
  });
  it('omitted policy preserves legacy deformation and demonstrates the opt-in repair against full target reference', async () => {
    const values = await execute(false);
    for (let i = 0; i < 5; i++) {
      const offset = i * 32;
      for (const axis of [0, 1, 2]) expect(values[offset + axis]).toBe(values[offset + 8 + axis]);
      expect(values[offset + 3]).toBe(0);
    }
    expect(Math.abs((values[1] ?? 0) - (values[13] ?? 0))).toBeGreaterThan(20);
  });
});

it.each([
  0.5, 1,
])('matches CPU support vertices with production WGSL for heightMorph %s', async (heightMorph01) => {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as typeof import('../../../shader-compiler/src/index.js');
  const compiled = (
    await compiler.compileShader(continuityMorphComputeSource, {
      id: 'water-continuity-morph-parity',
      imports: continuityShaderImports(),
      defines: continuityShaderDefines,
    })
  ).unwrap();
  const input = continuityMorphCase(heightMorph01);
  const tileBuffer = device.createBuffer({
    size: input.bytes.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const drawMeta = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    device.queue.writeBuffer(tileBuffer, 0, input.bytes);
    device.queue.writeBuffer(drawMeta, 0, new Uint32Array([0, 0, 0, 0]));
    const module = device.createShaderModule({ code: compiled.wgsl });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
    );
    pass.setBindGroup(
      1,
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] }),
    );
    pass.setBindGroup(
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 21, resource: { buffer: drawMeta } },
          { binding: 22, resource: { buffer: tileBuffer } },
        ],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const expected = waterMeshContinuityVertex(input.tile, 1, 0);
    expect(actual[0]).toBeCloseTo(expected[0], 6);
    expect(actual[2]).toBeCloseTo(expected[1], 6);
    expect(actual[0]).toBeLessThan(0.51);
  } finally {
    tileBuffer.destroy();
    drawMeta.destroy();
    output.destroy();
    readback.destroy();
  }
});
