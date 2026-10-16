import type { BindGroupEntry, RhiDevice } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { derive, materialValuesToLinearRuntime } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { packMaterialProgramRow } from '../../material-row';
import {
  collectMaterialTextureCoordinates,
  defaultMaterialSnapshot,
} from '../../render-system-extract';
import type { RayPathFixture } from './path-tracer.commands';
import { readBuffer } from './path-tracer.fixture';

export async function verifySurfaceAndBsdf(fixture: RayPathFixture) {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: string[] = [];
  const raw = webgpu._internal_getRawDevice(device);
  raw?.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const result = {
      surface: await surfaceProbe(device, fixture),
      normalMap: await surfaceProbe(device, fixture, true),
      bsdf: await bsdfProbe(device, fixture.bsdf),
      opposed: await bsdfProbe(device, fixture.bsdf, 'opposed', [0.8, 0, -0.6]),
      opposedNull: await bsdfProbe(device, fixture.bsdf, 'opposedNull', [0, 0, -1]),
      tilted: await bsdfProbe(device, fixture.bsdf, 'tilted', [0.8, 0, 0.6]),
      grazing: await bsdfProbe(device, fixture.bsdf, 'grazing', [0.8, 0, 0.6]),
      backside: await bsdfProbe(device, fixture.bsdf, 'backside', [0.8, 0, 0.6]),
    };
    expect(errors).toEqual([]);
    return result;
  } finally {
    raw?.destroy();
  }
}
async function surfaceProbe(device: RhiDevice, fixture: RayPathFixture, normalMap = false) {
  const slot = normalMap ? 'normalTexture' : 'baseColorTexture';
  const ray = fixture.materials.find((m) => m.name === (normalMap ? 'normalMapped' : 'textured'));
  assert(ray);
  const texture = device
    .createTexture({
      size: { width: 8, height: 8 },
      mipLevelCount: 4,
      format: 'rgba8unorm',
      usage: 6,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device
    .createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
    })
    .unwrap();
  for (let mip = 0; mip < 4; mip++) {
    const size = 8 >> mip;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const v = mip === 0 ? ((i % size) % 2 === 0 ? 0 : 255) : 128;
      data.set(
        normalMap
          ? [mip === 0 ? (v === 0 ? 64 : 191) : 128, mip === 0 ? 159 : 128, 255, 255]
          : [v, v, v, 255],
        i * 4,
      );
    }
    device.queue
      .writeTexture(
        { texture, mipLevel: mip },
        data,
        { bytesPerRow: size * 4 },
        { width: size, height: size },
      )
      .unwrap();
  }
  const d = derive(ray.program.paramSchema);
  const values = materialValuesToLinearRuntime(
    ray.asset.values,
    ray.program.paramSchema,
    ray.asset.colorSpace,
  );
  const row = packMaterialProgramRow(
    ray.program.paramSchema,
    {
      ...defaultMaterialSnapshot(),
      paramSnapshot: values as Record<string, number | number[] | string>,
      textureCoordinates: collectMaterialTextureCoordinates(values),
    },
    Math.max(d.totalBytes, 16),
  );
  assert(row);
  const uniform = device.createBuffer({ size: row.byteLength, usage: 72 }).unwrap();
  device.queue.writeBuffer(uniform, 0, row).unwrap();
  const materialLayout = device
    .createBindGroupLayout({
      entries: d.bglEntries.map((e) => ({
        binding: e.binding,
        visibility: 6,
        ...(e.buffer ? { buffer: e.buffer } : {}),
        ...(e.texture ? { texture: e.texture } : {}),
        ...(e.sampler ? { sampler: e.sampler } : {}),
      })),
    })
    .unwrap();
  const entries: BindGroupEntry[] = [
    { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
  ];
  for (const r of d.resourceBindings)
    entries.push({
      binding: r.binding,
      resource:
        r.kind === 'sampler'
          ? { kind: 'sampler', value: sampler }
          : { kind: 'textureView', value: view },
    });
  const group = device.createBindGroup({ layout: materialLayout, entries }).unwrap();
  const inputs = device.createBuffer({ size: 8 * 224, usage: 136 }).unwrap(),
    outputs = device.createBuffer({ size: 8 * 96, usage: 140 }).unwrap(),
    selector = device.createBuffer({ size: 16, usage: 72 }).unwrap();
  device.queue.writeBuffer(selector, 0, new Uint8Array(16)).unwrap();
  const workLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 7, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 6, buffer: { type: 'storage' } },
        { binding: 2, visibility: 6, buffer: { type: 'uniform' } },
      ],
    })
    .unwrap();
  const work = device
    .createBindGroup({
      layout: workLayout,
      entries: [inputs, outputs, selector].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer', value: { buffer } },
      })),
    })
    .unwrap();
  const layout = device
    .createPipelineLayout({ bindGroupLayouts: [workLayout, materialLayout] })
    .unwrap();
  const compute = device
    .createComputePipeline({
      layout,
      compute: {
        module: (await webgpu.createShaderModule(device, { code: ray.program.wgsl })).unwrap(),
        entryPoint: 'cs_surface',
      },
    })
    .unwrap();
  const shader = (
    await webgpu.createShaderModule(device, {
      code: (normalMap ? fixture.normalRaster : fixture.raster).program.wgsl,
    })
  ).unwrap();
  const raster = device
    .createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: 'vs_probe', buffers: [] },
      fragment: {
        module: shader,
        entryPoint: 'fs_probe',
        targets: [{ format: 'rgba32float' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  // One float row per Surface vec4 keeps exact values within baseline limits.
  const target = device
    .createTexture({ size: { width: 8, height: 4 }, format: 'rgba32float', usage: 17 })
    .unwrap();
  const targetView = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 4 * 256, usage: 12 }).unwrap();
  const outputsByMode = [];
  for (const footprint of [0.125, 1, 0.001]) {
    // Rotation separates authored and physical UV scaling: their componentwise
    // product is not a conservative footprint for this anisotropic composition.
    if (footprint === 0.001) {
      const transformed = packMaterialProgramRow(
        ray.program.paramSchema,
        {
          ...defaultMaterialSnapshot(),
          paramSnapshot: values as Record<string, number | number[] | string>,
          textureCoordinates: new Map([
            [
              slot,
              {
                set: 1,
                transform: { scale: [100, 1], rotation: Math.PI / 2 },
                physicalUvScale: [1, 100],
              },
            ],
          ]),
        },
        Math.max(d.totalBytes, 16),
      );
      assert(transformed);
      device.queue.writeBuffer(uniform, 0, transformed).unwrap();
    }
    const input = new Uint8Array(8 * 224);
    const f = new Float32Array(input.buffer),
      u = new Uint32Array(input.buffer);
    for (let i = 0; i < 8; i++) {
      const start = i * 56;
      // Source smoothing/normal maps may cross the geometric hemisphere.
      f.set([0, 0, normalMap ? -1 : 1, 1], start + 8);
      f.set([1, 0, 0, normalMap && i % 2 === 0 ? -1 : 1], start + 12);
      f.set([0, 0, 1, 0], start + 16);
      f.set([0.01, 0.01, (i + 0.5) * footprint, 0.5], start + 20);
      f.set([0.5, 1, 0.75, 1], start + 36);
      f.set([footprint, footprint, 0, 0], start + 40);
      f.set([0, 0, 1, 0], start + 48);
      u.set([0, 1, 0, i], start + 52);
    }
    device.queue.writeBuffer(inputs, 0, input).unwrap();
    const e = device.createCommandEncoder({}).unwrap();
    const cp = e.beginComputePass({});
    cp.setPipeline(compute);
    cp.setBindGroup(0, work);
    cp.setBindGroup(1, group);
    cp.dispatchWorkgroups(1);
    cp.end();
    device.queue.submit([e.finish().unwrap()]).unwrap();
    const computed = new Float32Array((await readBuffer(device, outputs, 8 * 96)).buffer);
    const r = device.createCommandEncoder({}).unwrap();
    const rp = r.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    rp.setPipeline(raster);
    rp.setBindGroup(0, work);
    rp.setBindGroup(1, group);
    rp.draw(3);
    rp.end();
    device.queue.submit([r.finish().unwrap()]).unwrap();
    const copy = device.createCommandEncoder({}).unwrap();
    copy.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      { width: 8, height: 4 },
    );
    device.queue.submit([copy.finish().unwrap()]).unwrap();
    const data = new Float32Array((await readBuffer(device, readback, 4 * 256)).buffer);
    const rendered = new Float32Array(8 * 24);
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 8; i++) {
        const start = row * 64 + i * 4;
        rendered.set(data.subarray(start, start + 4), i * 24 + row * 4);
      }
    }
    for (let i = 0; i < 8; i++)
      for (let lane = 0; lane < 16; lane++)
        expect(
          computed[i * 24 + lane],
          `footprint=${footprint}, pixel=${i}, lane=${lane}`,
        ).toBeCloseTo(rendered[i * 24 + lane] ?? 0, 5);
    for (let i = 0; i < 8; i++) {
      const expected = footprint === 0.125 ? i % 2 : 128 / 255;
      expect(computed[i * 24]).toBeCloseTo(0.4 * (normalMap ? 1 : expected), 5);
      expect(computed[i * 24 + 2]).toBeCloseTo(0.15 * (normalMap ? 1 : expected), 5);
      if (normalMap) {
        const x = ((footprint === 0.125 ? (i % 2 === 0 ? 64 : 191) : 128) / 255) * 2 - 1;
        const y = ((footprint === 0.125 ? 159 : 128) / 255) * 2 - 1;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)),
          length = Math.hypot(x * 1.2, y * 0.5, z);
        const expectedNormal = [
          (x * 1.2) / length,
          ((y * 0.5) / length) * (i % 2 === 0 ? -1 : 1),
          z / length,
        ];
        for (let c = 0; c < 3; c++)
          expect(computed[i * 24 + 4 + c]).toBeCloseTo(expectedNormal[c] ?? 0, 5);
        expect(new Uint32Array(computed.buffer)[i * 24 + 16]).toBe(1);
      }
    }
    outputsByMode.push(Array.from(computed).filter((_, i) => i % 24 === 0));
  }
  return outputsByMode;
}
async function bsdfProbe(device: RhiDevice, code: string, entryPoint = 'main', normal = [0, 0, 1]) {
  const count = 32768;
  const output = device.createBuffer({ size: count * 64, usage: 132 }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: {
        module: (await webgpu.createShaderModule(device, { code })).unwrap(),
        entryPoint,
      },
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
    })
    .unwrap();
  const e = device.createCommandEncoder({}).unwrap();
  const p = e.beginComputePass({});
  p.setPipeline(pipeline);
  p.setBindGroup(0, group);
  p.dispatchWorkgroups(count / 64);
  p.end();
  device.queue.submit([e.finish().unwrap()]).unwrap();
  const f = new Float32Array((await readBuffer(device, output, count * 64)).buffer);
  expect(Array.from(f).every(Number.isFinite)).toBe(true);
  let mass = 0,
    accepted = 0;
  const sample = [0, 0, 0],
    integral = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const o = i * 16,
      pdf = f[o + 3] ?? 0,
      valid = f[o + 7] ?? 0;
    if ((f[o + 2] ?? 0) < 0) {
      expect(valid).toBe(0);
      expect(pdf).toBe(0);
      for (let c = 0; c < 3; c++) expect(f[o + 4 + c]).toBe(0);
    }
    accepted += valid / count;
    mass += (f[o + 15] ?? 0) / count;
    expect(pdf).toBeCloseTo(f[o + 11] ?? 0, 5);
    for (let c = 0; c < 3; c++) {
      sample[c] = (sample[c] ?? 0) + (f[o + 4 + c] ?? 0) / count;
      integral[c] = (integral[c] ?? 0) + (f[o + 12 + c] ?? 0) / count;
      if (valid)
        expect((f[o + 4 + c] ?? 0) * pdf).toBeCloseTo(
          (f[o + 8 + c] ?? 0) *
            Math.max(
              0,
              (f[o] ?? 0) * (normal[0] ?? 0) +
                (f[o + 1] ?? 0) * (normal[1] ?? 0) +
                (f[o + 2] ?? 0) * (normal[2] ?? 0),
            ),
          5,
        );
    }
  }
  device.destroyBuffer(output).unwrap();
  if (entryPoint === 'backside' || entryPoint === 'opposedNull') {
    expect(accepted).toBe(0);
    expect(mass).toBe(0);
    expect(sample).toEqual([0, 0, 0]);
    expect(integral).toEqual([0, 0, 0]);
    return { accepted, pdfMass: mass, sample, integral, oracle: 0 };
  }
  expect(accepted).toBeLessThan(0.99);
  expect(accepted).toBeGreaterThan(entryPoint === 'opposed' ? 0.01 : 0.2);
  expect(mass + (1 - accepted)).toBeCloseTo(1, 2);
  for (let c = 0; c < 3; c++) expect(sample[c]).toBeCloseTo(integral[c] ?? 0, 2);
  // F0=0 derives F90=0 (F90 = saturate(50 * F0)), so the declared additive
  // Lambert/GGX carries no specular lobe and the integral is the diffuse term.
  const nzNormal = normal[2] ?? 1;
  const oracle = 0;
  for (let c = 0; c < 3; c++) {
    expect(integral[c]).toBeCloseTo((([0.8, 0.4, 0.2][c] ?? 0) * (1 + nzNormal)) / 2, 3);
    expect(integral[c]).toBeLessThan(1.02);
  }
  return { accepted, pdfMass: mass, sample, integral, oracle };
}
