import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { createReferenceSurfaceMaterialBindings } from '../../raytracing/material-bindings';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { half, readCardPlanes, sdfCubeInstance } from './sdf-cards.fixture';

export async function verifyCardMaterial(fixture: SdfCardsFixture) {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(device),
    errors: string[] = [];
  raw?.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  try {
    const texture = device
      .createTexture({
        size: { width: 8, height: 8 },
        format: 'rgba8unorm',
        textureBindingViewDimension: '2d',
        usage: 6,
      })
      .unwrap();
    const texels = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++)
      texels.set(i % 8 < 4 ? [255, 128, 64, 255] : [64, 255, 128, 255], i * 4);
    device.queue
      .writeTexture({ texture }, texels, { bytesPerRow: 32 }, { width: 8, height: 8 })
      .unwrap();
    const view = device.createTextureView(texture, {}).unwrap(),
      sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }).unwrap();
    const resolve = () => ok({ view, sampler });
    const positions = Array.from(sdfCubeInstance.positions),
      uv0: number[] = [],
      uv1: number[] = [],
      colors: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      uv0.push(0, 0);
      uv1.push(((positions[i] ?? 0) + 1) / 2, ((positions[i + 1] ?? 0) + 1) / 2);
      colors.push(0.5, 1, 0.75, 1);
    }
    const source = {
      instance: { ...sdfCubeInstance, uvSets: [uv0, uv1], colors },
      layout: fixture.layout,
      sections: [
        {
          indexOffset: 0,
          indexCount: sdfCubeInstance.indices.length,
          material: { id: 0, ...fixture.textured.card },
          textureContentKey: 'checker:1',
        },
      ],
    };
    expect(
      (
        await createSurfaceCapture(
          device,
          webgpu.createShaderModule,
          [{ ...source, instance: { ...source.instance, uvSets: [uv0] } }],
          { kind: 'cards', resolution: 16 },
          resolve,
        )
      ).ok,
    ).toBe(false);
    const cards = (
      await createSurfaceCapture(
        device,
        webgpu.createShaderModule,
        [source],
        { kind: 'cards', resolution: 16 },
        resolve,
      )
    ).unwrap();
    const bindings = createReferenceSurfaceMaterialBindings(
      device,
      fixture.textured.ray,
      4,
      resolve,
    ).unwrap();
    const input = new Uint8Array(4 * 224),
      f = new Float32Array(input.buffer),
      u = new Uint32Array(input.buffer);
    const xs = [2, 6, 10, 14],
      projection = cards.entries[0]?.projections[4];
    if (!projection) throw new Error('missing +Z projection');
    for (let i = 0; i < 4; i++) {
      const x = projection.origin[0] + (((xs[i] ?? 0) + 0.5) / 16) * projection.width;
      const y = projection.origin[1] - (8.5 / 16) * projection.height;
      const o = i * 56;
      f.set([x, y, 1, 1], o);
      f.set([x, y, 1, 1], o + 4);
      f.set([0, 0, 1, 1], o + 8);
      f.set([1, 0, 0, 1], o + 12);
      f.set([0, 0, 1, 0], o + 16);
      f.set([0, 0, (x + 1) / 2, (y + 1) / 2], o + 20);
      f.set([0.5, 1, 0.75, 1], o + 36);
      f.set([0.063, 0.063, 0, 0], o + 40);
      f.set([0, 0, 1, 0], o + 48);
      u.set([0, 1, 0, i], o + 52);
    }
    const buffers = [
      device.createBuffer({ size: input.length, usage: 136 }).unwrap(),
      device.createBuffer({ size: 4 * 96, usage: 132 }).unwrap(),
      device.createBuffer({ size: 16, usage: 72 }).unwrap(),
    ];
    const [inputs, outputs, selection] = buffers;
    if (!inputs || !outputs || !selection) throw new Error('missing probe buffer');
    device.queue.writeBuffer(inputs, 0, input).unwrap();
    device.queue.writeBuffer(selection, 0, new Uint8Array(16)).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 4, buffer: { type: 'storage' } },
          { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: buffers.map((buffer, binding) => ({
          binding,
          resource: { kind: 'buffer' as const, value: { buffer } },
        })),
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [layout, bindings.layout] })
          .unwrap(),
        compute: {
          module: (
            await webgpu.createShaderModule(device, { code: fixture.textured.ray.program.wgsl })
          ).unwrap(),
          entryPoint: 'cs_surface',
        },
      })
      .unwrap();
    const e = device.createCommandEncoder({}).unwrap();
    cards.record(e).unwrap();
    const p = e.beginComputePass({});
    p.setPipeline(pipeline);
    p.setBindGroup(0, group);
    p.setBindGroup(1, bindings.group);
    p.dispatchWorkgroups(1);
    p.end();
    device.queue.submit([e.finish().unwrap()]).unwrap();
    const planes = await readCardPlanes(device, cards),
      ray = new Float32Array((await readBuffer(device, outputs, 4 * 96)).buffer);
    for (let i = 0; i < 4; i++) {
      const pixel =
        ((Math.floor(4 / (cards.width / 16)) * 16 + 8) * cards.width +
          (4 % (cards.width / 16)) * 16 +
          (xs[i] ?? 0)) *
        8;
      // All material channels (not geometric depth) agree at the same world/UV point.
      const lanes = [
        [0, 1, 2, 7],
        [-1, -1, -1, -1],
        [8, 9, 10, 11],
        [12, 13, 14, -1],
      ];
      for (let plane = 0; plane < 4; plane++)
        for (let c = 0; c < 4; c++) {
          const lane = lanes[plane]?.[c] ?? -1;
          if (lane >= 0)
            expect(half(planes[plane] ?? new Uint8Array(), pixel + c * 2)).toBeCloseTo(
              ray[i * 24 + lane] ?? 0,
              3,
            );
        }
      // Both encoded normals are +Z for this flat face; depth is the real depth attachment.
      for (let c = 0; c < 4; c++)
        expect(half(planes[1] ?? new Uint8Array(), pixel + c * 2)).toBeCloseTo(0, 3);
      expect(Array.from(ray.slice(i * 24 + 20, i * 24 + 23))).toEqual([0, 0, 1]);
      const red = i < 2 ? 0.4 : (0.4 * 64) / 255;
      expect(ray[i * 24]).toBeCloseTo(red, 5);
    }
    expect(errors).toEqual([]);
    cards.dispose();
    device.destroyBuffer(bindings.uniform);
    for (const b of buffers) device.destroyBuffer(b);
    device.destroyTexture(texture);
  } finally {
    raw?.destroy();
  }
}
