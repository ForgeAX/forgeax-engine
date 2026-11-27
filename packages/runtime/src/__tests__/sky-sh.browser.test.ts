import { halfFloat } from '@forgeax/engine-math';
import {
  createShaderModule,
  createShaderModuleImmediate,
  disposeDevice,
  rhi,
} from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { SKY_SH_WGSL } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { DeviceScope } from '../../../render/src/device/device-scope';
import {
  constantSkySh,
  prepareSkyShProjection,
  SKY_SH_BYTES,
} from '../../../render/src/ibl/sky-sh';

const normals = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 1, 0],
  [-1, -1, 0],
  [0, 1, 1],
  [0, -1, -1],
  [1, 0, 1],
  [-1, 0, -1],
] as const;

it('stores constant radiance in the three constant lanes of the 112-byte polynomial', () => {
  expect(SKY_SH_BYTES).toBe(112);
  const packed = constantSkySh([0.25, 1, 2]);
  expect(packed.byteLength).toBe(112);
  expect(Array.from(packed).filter((lane) => lane !== 0)).toEqual([0.25, 1, 2]);
  expect([packed[3], packed[7], packed[11]]).toEqual([0.25, 1, 2]);
});

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('%s projects constant and directional cube radiance into a packed diffuse polynomial', async (backend) => {
  const canvas = document.createElement('canvas');
  const previousGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const raster = backend === 'wgpu-webgl2';
  if (raster) Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const adapter = await (raster ? wgpu.requestAdapter(undefined, canvas) : rhi.requestAdapter())
    .finally(() => {
      if (!raster) return;
      if (previousGpu === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', previousGpu);
    })
    .then((result) => result.unwrap());
  const device = (await adapter.requestDevice()).unwrap();
  const scope = DeviceScope.create(0, 'sky-sh-test');
  try {
    expect(device.caps.compute).toBe(!raster);
    const validate = raster ? wgpu.createShaderModule : createShaderModule;
    const compile = raster ? wgpu.createShaderModuleImmediate : createShaderModuleImmediate;
    (await validate(device, { code: SKY_SH_WGSL, label: 'sky-sh-validation' })).unwrap();
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
    const side = 17;
    const cube = device
      .createTexture({
        label: 'sky-sh-oracle-cube',
        size: { width: side, height: side, depthOrArrayLayers: 6 },
        format: 'rgba16float',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      })
      .unwrap();
    const view = device.createTextureView(cube, { dimension: 'cube', arrayLayerCount: 6 }).unwrap();
    const output = device
      .createTexture({
        label: 'sky-sh-uniform-consumer',
        size: { width: normals.length, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
      .unwrap();
    const target = device.createTextureView(output, { dimension: '2d' }).unwrap();
    const consumer = compile(device, {
      code: `${SKY_SH_WGSL}
@group(0) @binding(6) var<uniform> packed: SkyShPolynomial;
@fragment fn evaluateUniform(@builtin(position) position: vec4f) -> @location(0) vec4f {
  var n = vec3f(1.0, 0.0, 0.0);
  switch u32(position.x) {
    ${normals.map((n, i) => `case ${i}u: { n = vec3f(${n.map((x) => x.toFixed(1)).join(', ')}); }`).join(' ')}
    default: {}
  }
  return vec4f(evaluateSkyPolynomial(packed, normalize(n)), 0.0);
}`,
    }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 6, visibility: 2, buffer: { type: 'uniform', minBindingSize: SKY_SH_BYTES } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module: consumer, entryPoint: 'sky_sh_fullscreen' },
        fragment: {
          module: consumer,
          entryPoint: 'evaluateUniform',
          targets: [{ format: 'rgba32float' }],
        },
      })
      .unwrap();
    const readback = device
      .createBuffer({
        size: normals.length * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      .unwrap();
    const scratch = scope.createChild('projection');

    for (const directional of [false, true]) {
      const sideScale = 2 / side;
      const expected = new Float64Array(normals.length * 4);
      let totalWeight = 0;
      for (let face = 0; face < 6; face++) {
        const data = new Uint16Array(side * 128);
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            const u = (x + 0.5) * sideScale - 1;
            const v = (y + 0.5) * sideScale - 1;
            const direction = [
              [1, -v, -u],
              [-1, -v, u],
              [u, 1, v],
              [u, -1, -v],
              [u, -v, 1],
              [-u, -v, -1],
            ] as const;
            const xyz = direction[face];
            if (xyz === undefined) throw new Error('invalid cube face');
            const length = Math.hypot(...xyz);
            const nx = xyz[0] / length;
            const ny = xyz[1] / length;
            const nz = xyz[2] / length;
            const colors = directional
              ? [
                  2 - 0.75 * nx - 0.25 * nx * ny + 0.8 * (nx * nx - ny * ny),
                  3 - ny + 0.5 * (3 * nz * nz - 1) + 0.4 * ny * nz,
                  4 + 1.5 * nz - 0.7 * nx * nz,
                ]
              : [0.25, 1, 2];
            const encoded = colors.map(halfFloat.f32ToF16);
            data.set([...encoded, 0x3c00], y * 128 + x * 4);
            const weight = 1 / length ** 3;
            totalWeight += weight;
            // SH addition theorem for the cosine-convolved first three bands.
            // The common 4pi factor cancels against the total solid angle.
            normals.forEach(([tx, ty, tz], i) => {
              const cosine = (nx * tx + ny * ty + nz * tz) / Math.hypot(tx, ty, tz);
              const kernel = 1 + 2 * cosine + (5 / 8) * (3 * cosine * cosine - 1);
              encoded.forEach((color, channel) => {
                const lane = i * 4 + channel;
                expected[lane] =
                  (expected[lane] ?? 0) + halfFloat.f16ToF32(color) * kernel * weight;
              });
            });
          }
        }
        device.queue
          .writeTexture(
            { texture: cube, origin: { x: 0, y: 0, z: face } },
            data,
            { bytesPerRow: 256, rowsPerImage: side },
            { width: side, height: side, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }

      const projection = prepareSkyShProjection(
        device,
        scope,
        scope,
        scratch,
        view,
        sampler,
        false,
        (descriptor) => compile(device, descriptor),
      );
      const encoder = device.createCommandEncoder().unwrap();
      projection.record(encoder);
      const group = device
        .createBindGroup({
          layout,
          entries: [
            {
              binding: 6,
              resource: { kind: 'buffer', value: { buffer: projection.coefficients } },
            },
          ],
        })
        .unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback },
        { width: normals.length, height: 1, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPUBufferUsage.MAP_READ)).unwrap();
      const actual = new Float32Array(mapped.getMappedRange().unwrap());
      expected.forEach((value, i) => {
        const reference = Math.max(value / totalWeight, 0);
        expect(actual[i], `irradiance lane ${i}`).toBeCloseTo(reference, 4);
      });
      mapped.unmap();
    }

    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(cube).unwrap();
    device.destroyTexture(output).unwrap();
  } finally {
    await device.queue.onSubmittedWorkDone();
    scope.dispose();
    if (raster) wgpu.disposeDevice(device);
    else disposeDevice(device);
  }
});
