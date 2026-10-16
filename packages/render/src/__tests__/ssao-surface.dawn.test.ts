import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { generateSsaoKernel, generateSsaoNoise } from '../ssao-buffers';

// Analytic tilted plane: y + z + 4 = 0. Every hemisphere sample lies in
// empty space. Exercise the production fragment program, not a CPU AO copy.
for (const algorithm of ['ssao', 'gtao'] as const)
  it.each([
    ['plane', 16],
    ['plane', 32],
    ['plane', 64],
    ['orthographic', 16],
    ['orthographic', 32],
    ['orthographic', 64],
    ...(algorithm === 'gtao'
      ? ([
          ['plane-odd', 64],
          ['plane-jitter', 64],
        ] as const)
      : []),
    ['contact', 64],
    ['distant-edge', 64],
    ['background', 64],
  ] as const)(`production ${algorithm} %s with %i samples`, async (scene, sampleCount) => {
    const compiler = await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    );
    const gbufferSource = readFileSync(
      resolve('packages/shader/src/standard-gbuffer.wgsl'),
      'utf8',
    );
    const compiled = await compiler.compileShader(
      readFileSync(resolve('packages/shader/src/hdrp-ssao.wgsl'), 'utf8'),
      {
        id: 'forgeax_hdrp::ssao',
        imports: {
          'forgeax_pbr::gbuffer': gbufferSource,
          'forgeax_view::common': readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8'),
        },
      },
    );
    if (!compiled.ok) throw compiled.error;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Dawn adapter unavailable');
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const size = scene === 'plane-odd' ? 127 : 128;
    const texture = (format: GPUTextureFormat, width = size, height = size) =>
      device.createTexture({
        size: [width, height],
        format,
        usage:
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING |
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_COPY_DST,
      });
    const depth = texture('depth32float');
    const normal = texture('r32uint');
    const aoSize = Math.ceil(size / 2);
    const raw = texture('rgba8unorm', aoSize, aoSize);
    const blurred = texture('r8unorm', aoSize, aoSize);
    const noise = texture('rgba32float', 4, 4);
    const uniform = device.createBuffer({
      size: 256,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    const kernel = device.createBuffer({
      size: 1024,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    const readback = device.createBuffer({
      size: 256 * aoSize,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    });
    try {
      const projection = mat4.create();
      if (scene === 'orthographic') mat4.orthographicReverseZ(projection, -3, 3, 3, -3, 0.1, 100);
      else mat4.perspectiveReverseZ(projection, Math.PI / 3, 1, 0.1, 100);
      if (scene === 'plane-jitter') {
        const jitter = mat4.identity(mat4.create());
        jitter[12] = 0.017;
        jitter[13] = -0.013;
        mat4.multiply(projection, jitter, projection);
      }
      const inverse = mat4.create();
      mat4.invert(inverse, projection);
      const payload = new Float32Array(64);
      payload.set(mat4.identity(mat4.create()));
      payload.set(projection, 16);
      payload.set(inverse, 32);
      payload.set([1, 0.5, 0.025, sampleCount], 48);
      payload[52] = algorithm === 'gtao' ? 1 : 0;
      device.queue.writeBuffer(uniform, 0, payload);
      device.queue.writeBuffer(
        kernel,
        0,
        new Float32Array(generateSsaoKernel().flatMap((v) => [...v, 0])),
      );
      const noiseRgb = generateSsaoNoise();
      const noiseRgba = new Float32Array(64);
      for (let i = 0; i < 16; i++) noiseRgba.set(noiseRgb.subarray(i * 3, i * 3 + 3), i * 4);
      device.queue.writeTexture({ texture: noise }, noiseRgba, { bytesPerRow: 64 }, [4, 4]);
      const seedModule = device.createShaderModule({
        code: `
      ${gbufferSource.replace(/^#define_import_path[^\n]*\n/m, '')}
      struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
      @vertex fn vs(@builtin(vertex_index) i:u32)->Out {
        let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
        return Out(vec4f(p[i],0,1),p[i]*vec2f(0.5,-0.5)+0.5);
      }
      struct Fragment { @builtin(frag_depth) depth:f32, @location(0) normal:u32 };
      @fragment fn fs(in:Out)->Fragment {
        let rayY = (1.0-2.0*in.uv.y + ${scene === 'plane-jitter' ? '0.013' : '0.0'})*0.577350269;
        let distance = ${scene === 'orthographic' ? '4.0+(1.0-2.0*in.uv.y)*3.0' : scene.startsWith('plane') ? '4.0/(1.0-rayY)' : scene === 'contact' ? 'select(4.0,3.75,in.uv.x>0.5)' : scene === 'distant-edge' ? 'select(4.0,1.0,in.uv.x>0.5)' : '100.0'};
        return Fragment(${scene === 'orthographic' ? '(100.0-distance)/99.9' : scene === 'background' ? '0.0' : '(10.0/distance-0.1)/99.9'},${scene.startsWith('plane') || scene === 'orthographic' ? 'encodeStandardNormalRoughness(vec3f(0,1,1), 1)' : 'encodeStandardNormalRoughness(vec3f(0,0,1), 1)'});
      }`,
      });
      const seed = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: seedModule, entryPoint: 'vs' },
        fragment: { module: seedModule, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      });
      const module = device.createShaderModule({ code: compiled.value.wgsl });
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 2, buffer: { type: 'uniform' } },
          { binding: 2, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
          { binding: 3, visibility: 2, sampler: { type: 'non-filtering' } },
          { binding: 4, visibility: 2, texture: { sampleType: 'uint' } },
          { binding: 5, visibility: 2, texture: { sampleType: 'depth' } },
          { binding: 6, visibility: 2, sampler: { type: 'non-filtering' } },
        ],
      });
      const calc = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs_ssao' },
        fragment: { module, entryPoint: 'fs_ssao_calc', targets: [{ format: 'rgba8unorm' }] },
      });
      const sampler = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat' });
      const bindings = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: kernel } },
          { binding: 2, resource: noise.createView() },
          { binding: 3, resource: sampler },
          { binding: 4, resource: normal.createView() },
          { binding: 5, resource: depth.createView() },
          { binding: 6, resource: device.createSampler() },
        ],
      });
      const encoder = device.createCommandEncoder();
      const seedPass = encoder.beginRenderPass({
        colorAttachments: [{ view: normal.createView(), loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      seedPass.setPipeline(seed);
      seedPass.draw(3);
      seedPass.end();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: raw.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(calc);
      pass.setBindGroup(0, bindings);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer({ texture: raw }, { buffer: readback, bytesPerRow: 256 }, [
        aoSize,
        aoSize,
      ]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
      const values = new Uint8Array(readback.getMappedRange());
      const mean = (x0: number, x1: number) => {
        let sum = 0;
        for (let y = 8; y < aoSize - 8; y++)
          for (let x = x0; x < x1; x++) sum += 1 - (values[y * 256 + x * 4] ?? NaN) / 255;
        return sum / ((aoSize - 16) * (x1 - x0));
      };
      expect(errors).toEqual([]);
      // The blur weights taps by the octahedral normal carried in raw.gb.
      const center = (aoSize >> 1) * 256 + (aoSize >> 1) * 4;
      const ox = ((values[center + 1] ?? NaN) / 255) * 2 - 1;
      const oy = ((values[center + 2] ?? NaN) / 255) * 2 - 1;
      const oz = 1 - Math.abs(ox) - Math.abs(oy);
      const tilted = scene.startsWith('plane') || scene === 'orthographic';
      const expected = tilted ? [0, Math.SQRT1_2, Math.SQRT1_2] : [0, 0, 1];
      const length = Math.hypot(ox, oy, oz);
      expect(
        (ox * (expected[0] ?? 0) + oy * (expected[1] ?? 0) + oz * (expected[2] ?? 0)) / length,
        'raw carries the center world normal',
      ).toBeGreaterThan(0.999);
      if (scene === 'contact') {
        expect(
          mean(aoSize / 2 - 4, aoSize / 2),
          'nearby foreground occludes the contact band',
        ).toBeGreaterThan(0.02);
        expect(mean(8, 16), 'open surface away from contact stays clear').toBeLessThan(
          algorithm === 'gtao' ? 0.00001 : 0.01,
        );
      } else {
        if (scene === 'distant-edge') expect(mean(aoSize / 2 - 4, aoSize / 2)).toBeLessThan(0.005);
        expect(
          mean(8, aoSize - 8),
          'unoccluded surface and distant silhouettes stay clear',
        ).toBeLessThan(algorithm === 'gtao' ? 0.00001 : 0.01);
      }
      readback.unmap();
      const blurLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
          { binding: 4, visibility: 2, texture: { sampleType: 'uint' } },
          { binding: 5, visibility: 2, texture: { sampleType: 'depth' } },
          { binding: 6, visibility: 2, sampler: { type: 'non-filtering' } },
          { binding: 7, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
        ],
      });
      const blurPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [blurLayout] }),
        vertex: { module, entryPoint: 'vs_ssao' },
        fragment: { module, entryPoint: 'fs_ssao_blur', targets: [{ format: 'r8unorm' }] },
      });
      const blurGroup = device.createBindGroup({
        layout: blurLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 4, resource: normal.createView() },
          { binding: 5, resource: depth.createView() },
          { binding: 6, resource: device.createSampler() },
          { binding: 7, resource: raw.createView() },
        ],
      });
      const filterEncoder = device.createCommandEncoder();
      const filter = filterEncoder.beginRenderPass({
        colorAttachments: [{ view: blurred.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      filter.setPipeline(blurPipeline);
      filter.setBindGroup(0, blurGroup);
      filter.draw(3);
      filter.end();
      filterEncoder.copyTextureToBuffer(
        { texture: blurred },
        { buffer: readback, bytesPerRow: 256 },
        [aoSize, aoSize],
      );
      device.queue.submit([filterEncoder.finish()]);
      await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
      const filtered = new Uint8Array(readback.getMappedRange());
      if (scene === 'contact') {
        let foreground = 0;
        for (let y = 8; y < aoSize - 8; y++)
          for (let x = aoSize / 2; x < aoSize / 2 + 3; x++)
            foreground += 1 - (filtered[y * 256 + x] ?? NaN) / 255;
        expect(
          foreground / ((aoSize - 16) * 3),
          'bilateral blur must not bleed contact AO onto the foreground',
        ).toBeLessThan(0.005);
      }
      expect(errors).toEqual([]);
      readback.unmap();
    } finally {
      for (const resource of [depth, normal, raw, blurred, noise, uniform, kernel, readback])
        resource.destroy();
      device.destroy();
    }
  });
