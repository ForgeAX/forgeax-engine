import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

it('preserves native pixels through sparse claims, CPU fallback and replacement devices', async () => {
  for (let generation = 0; generation < 2; generation++) {
    const { device, native } = await nativeDeviceFixture();
    native.pushErrorScope('validation');
    const shader = (await createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
    const f = cpuSetupFixture(device, shader);
    f.add({ entity: 1, instances: 2, claimed: [0, 2] });
    f.add({ entity: 2, instances: 3, claimed: [0, 1, 2], x: 0.1 });
    f.add({ entity: 3, indexed: false, submeshes: 1, x: 1.1 });
    // Same physical mesh after an intervening wholly claimed mesh must retain
    // the preceding real CPU state. The oracle binds every draw explicitly.
    const last = f.add({ entity: 4, submeshes: 1, x: -0.05 });
    f.add({ entity: 5, claimed: [0, 1, 2] });
    const shared = f.add({ entity: 6, submeshes: 1 });
    Object.assign(shared, { mesh: last.mesh });
    const target = device
      .createTexture({ size: { width: 64, height: 32 }, format: 'rgba8unorm', usage: 16 | 1 })
      .unwrap();
    const view = device.createTextureView(target, {}).unwrap();
    const readback = device.createBuffer({ size: 256 * 32, usage: 1 | 8 }).unwrap();
    const identityGroup = device
      .createBindGroup({
        layout: f.instancesLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: f.identity } } }],
      })
      .unwrap();
    const oracle = (pass: RhiRenderPassEncoder, allCpu: boolean, omitLast: boolean) => {
      pass.setPipeline(f.pipeline);
      pass.setBindGroup(1, f.materialGroup, [0]);
      pass.setBindGroup(2, f.meshGroup, [0]);
      pass.setBindGroup(3, identityGroup);
      for (const entry of f.entries) {
        if (omitLast && (entry === last || entry === shared)) continue;
        for (const [submesh, sm] of entry.mesh.submeshes.entries()) {
          if (
            !allCpu &&
            entry.source.gpuDrivenDraws?.some((draw) => draw.drawItemIndex === submesh)
          )
            continue;
          pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
          if (entry.mesh.indexed && entry.mesh.indexBuffer !== null) {
            pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
            pass.drawIndexed(sm.indexCount, 1, sm.indexOffset, 0, 0);
          } else pass.draw(sm.vertexCount, 1, 0, 0);
        }
      }
    };
    const render = async (record: (pass: RhiRenderPassEncoder) => void) => {
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      pass.setBindGroup(0, f.viewGroup);
      record(pass);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 32 },
        { width: 64, height: 32, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const error = await native.popErrorScope();
      native.pushErrorScope('validation');
      expect(error, error?.message).toBeNull();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      return bytes;
    };
    try {
      const claims = [...f.claims];
      let distinct = 0;
      for (let frame = 0; frame < 60; frame++) {
        // Fallback must create buffers for the formerly GPU-only entries;
        // restoring claims must stop their CPU work again.
        const allCpu = frame >= 20 && frame < 40;
        f.claims.clear();
        if (!allCpu) for (const claim of claims) f.claims.add(claim);
        const ownership = f.validateClaims();
        // Dispatch ordering changes after validation; GPU ownership follows
        // each source, while the recorder keeps the current physical slot index.
        if (frame === 5 || frame === 45) f.entries.reverse();
        const actual = await render((pass) => f.record(pass, 'forward', ownership));
        const expected = await render((pass) => oracle(pass, allCpu, false));
        expect(actual).toEqual(expected);
        expect(actual.some((value, index) => index % 4 === 0 && value > 200)).toBe(true);
        if (frame === 0) {
          const missingDraw = await render((pass) => oracle(pass, allCpu, true));
          distinct = actual.filter((value, index) => value !== missingDraw[index]).length;
          expect(distinct).toBeGreaterThan(0);
        }
      }
      expect(distinct).toBeGreaterThan(0);
      expect(f.errors).toEqual([]);
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      f.dispose();
      device.destroyBuffer(readback).unwrap();
      device.destroyTexture(target).unwrap();
      native.destroy();
    }
  }
});

it('restores native geometry after Points/Lines without relying on GPU-only CPU setters', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const shader = (await createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const pointsShader = (
    await createShaderModule(device, {
      code: CPU_SETUP_SHADER.replace('return tint;', 'return vec4<f32>(0.0, 1.0, 0.0, 1.0);'),
    })
  ).unwrap();
  const f = cpuSetupFixture(device, shader);
  const first = f.add({ entity: 1, instances: 2, submeshes: 1 });
  const points = f.add({ entity: 2, submeshes: 1, x: 1.1 });
  f.add({ entity: 3, claimed: [0, 1, 2] });
  const last = f.add({ entity: 4, submeshes: 1 });
  Object.assign(last, { mesh: first.mesh });
  Object.assign(last.source, { instances: first.source.instances });
  Object.assign(points.source, { pointsLines: {}, transform: { world: new Float32Array(16) } });
  // Move the last draw into an otherwise empty region: omitting or inheriting
  // Points/Lines state must visibly differ from the explicit draw oracle.
  device.queue.writeBuffer(f.meshUniformBuffer, 3 * 256, Float32Array.of(0.55, 0, 0, 0)).unwrap();
  const viewBuffer = device.createBuffer({ size: 2048, usage: 64 | 8 }).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      entries: [0, 10].map((binding) => ({
        binding,
        visibility: 1,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      })),
    })
    .unwrap();
  const viewGroup = device
    .createBindGroup({
      layout: viewLayout,
      entries: [0, 10].map((binding) => ({
        binding,
        resource: { kind: 'buffer', value: { buffer: viewBuffer, size: 256 } },
      })),
    })
    .unwrap();
  const pipeline = f.createPipeline(shader, viewLayout);
  const pointsPipeline = f.createPipeline(pointsShader, viewLayout);
  Object.assign(f.c.runtime, {
    getMaterialShaderPipelineEntry: (id: string) => ({
      pipeline: id === 'forgeax::points-lines' ? pointsPipeline : pipeline,
      group2Contract: 'mesh',
    }),
  });
  Object.assign(f.c.pipelineState, { pointsLinesViewBuffer: viewBuffer });
  Object.assign(f.c, {
    camera: makeZeroCameraFallbackSnapshot(),
    targetW: 64,
    targetH: 32,
    viewBindGroup: viewGroup,
    pointsLines: {
      prepare: (entry: unknown) =>
        entry === points
          ? {
              vertexBuffer: points.mesh.vertexBuffer.handle,
              indexBuffer: points.mesh.indexBuffer?.handle,
              layoutProjection: points.mesh.layoutProjection,
              plan: { drawCount: 1, indexCount: 3 },
            }
          : undefined,
    },
  });
  const identityGroup = device
    .createBindGroup({
      layout: f.instancesLayout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: f.identity } } }],
    })
    .unwrap();
  const target = device
    .createTexture({ size: { width: 64, height: 32 }, format: 'rgba8unorm', usage: 16 | 1 })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256 * 32, usage: 1 | 8 }).unwrap();
  const render = async (oracle: boolean, omitLast = false) => {
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setBindGroup(0, viewGroup, [0, 0]);
    if (!oracle) f.record(pass);
    else
      for (const entry of [first, points, ...(omitLast ? [] : [last])]) {
        pass.setPipeline(entry === points ? pointsPipeline : pipeline);
        pass.setBindGroup(1, f.materialGroup, [0]);
        pass.setBindGroup(2, f.meshGroup, [entry === last ? 3 * 256 : 0]);
        pass.setBindGroup(3, identityGroup);
        pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
        if (entry.mesh.indexBuffer === null) throw Error('expected indexed geometry');
        pass.setIndexBuffer(entry.mesh.indexBuffer.handle, 'uint32');
        pass.drawIndexed(3, 1, 0, 0, 0);
      }
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 32 },
      { width: 64, height: 32, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const error = await native.popErrorScope();
    native.pushErrorScope('validation');
    expect(error, error?.message).toBeNull();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return bytes;
  };
  try {
    const expected = await render(true);
    expect(await render(true, true)).not.toEqual(expected);
    for (let frame = 0; frame < 60; frame++) expect(await render(false)).toEqual(expected);
    expect(f.errors).toEqual([]);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    f.dispose();
    device.destroyBuffer(viewBuffer).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(target).unwrap();
    native.destroy();
  }
});
