import { readFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';

const read = (name: string) =>
  readFileSync(new URL(`../../../shader/src/${name}`, import.meta.url), 'utf8');
function valueAt<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw Error(`Missing oracle value at ${index}`);
  return value;
}
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function verifySceneAoPixels(
  actual: Float32Array,
  storedDepths: readonly number[],
  aoBytes: Uint8Array,
  colors: Float32Array,
  width: number,
  height: number,
  halfWidth: number,
  halfHeight: number,
  manual: number,
  fallback: number,
  valid: number,
  previous: number,
): void {
  let maxError = 0,
    nearestError = 0;
  const effectiveExposure = fallback > 0 ? (valid > 0.5 ? previous : fallback) : manual;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const z = x < 4 ? 2 : 10,
        hx = ((x + 0.5) / width) * halfWidth - 0.5,
        hy = ((y + 0.5) / height) * halfHeight - 0.5;
      const fx = hx - Math.floor(hx),
        fy = hy - Math.floor(hy);
      let sum = 0,
        weight = 0;
      for (let k = 0; k < 4; k++) {
        const ox = k & 1,
          oy = k >> 1,
          tx = clamp(Math.floor(hx) + ox, 0, halfWidth - 1),
          ty = clamp(Math.floor(hy) + oy, 0, halfHeight - 1),
          tz = valueAt(storedDepths, ty * halfWidth + tx);
        const w = Math.max(
          1e-5,
          ((ox ? fx : 1 - fx) * (oy ? fy : 1 - fy)) / (0.015 + Math.abs(tz - z) / z),
        );
        sum += (valueAt(aoBytes, ty * halfWidth + tx) / 255) * w;
        weight += w;
      }
      const i = (y * width + x) * 4,
        luma =
          valueAt(colors, i) * 0.2126 +
          valueAt(colors, i + 1) * 0.7152 +
          valueAt(colors, i + 2) * 0.0722;
      const strength = 0.95 * (1 - 0.8 * smoothstep(0.16, 0.85, luma * effectiveExposure));
      const a = x === 0 && y === 0 ? 1 : 1 + (sum / weight - 1) * strength;
      for (let c = 0; c < 3; c++) {
        const expected = valueAt(colors, i + c) * (a + (1 - a) * valueAt([0, 0.03, 0.07], c));
        maxError = Math.max(maxError, Math.abs(valueAt(actual, y * 64 + x * 4 + c) - expected));
      }
      expect(actual[y * 64 + x * 4 + 3]).toBe(0.375);
      if (x === 3) {
        const nearest =
          1 +
          (valueAt(
            aoBytes,
            clamp(Math.floor(((y + 0.5) / height) * halfHeight), 0, halfHeight - 1) * halfWidth + 1,
          ) /
            255 -
            1) *
            strength;
        nearestError = Math.max(
          nearestError,
          Math.abs(valueAt(actual, y * 64 + x * 4) - valueAt(colors, i) * nearest),
        );
      }
    }
  expect(maxError).toBeLessThan(0.00002);
  expect(nearestError).toBeGreaterThan(0.001);
}

it.each([
  ['manual', false, 0.4, 0, 0, 0.4, 1, 8, 4],
  ['accepted-auto', false, 0.4, 0.6, 1, 2, 1, 8, 4],
  ['initial-auto', false, 0.4, 0.6, 0, 2, 1, 8, 4],
  ['orthographic', true, 0.4, 0, 0, 0.4, 1, 8, 4],
  ['msaa-manual', false, 0.4, 0, 0, 0.4, 4, 8, 4],
  ['msaa-accepted-auto', false, 0.4, 0.6, 1, 2, 4, 8, 4],
  ['msaa-initial-auto', false, 0.4, 0.6, 0, 2, 4, 8, 4],
  ['msaa-orthographic', true, 0.4, 0, 0, 0.4, 4, 8, 4],
  ['msaa-odd', false, 0.4, 0, 0, 0.4, 4, 9, 5],
  ['msaa-odd-orthographic', true, 0.4, 0, 0, 0.4, 4, 9, 5],
] as const)('matches independent four-tap depth/exposure/color oracle (%s)', async (_name, orthographic, manual, fallback, valid, previous, sampleCount, width, height) => {
  const halfWidth = Math.round(width * 0.5),
    halfHeight = Math.round(height * 0.5);
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw Error('Scene AO requires a native GPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const projection = orthographic
    ? mat4.orthographicReverseZ(mat4.create(), -3, 3, 3, -3, 0.1, 100)
    : mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, width / height, 0.1, 100);
  const payload = new Float32Array(64);
  payload.set(mat4.identity(mat4.create()));
  payload.set(projection, 16);
  payload.set(mat4.invert(mat4.create(), projection), 32);
  payload[52] = 2;
  payload.set([0.5, 0.95, manual, fallback], 60);
  const uniform = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniform, 0, payload);
  const exposure = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(exposure, 0, new Float32Array([previous, valid, 1, fallback]));
  const source = device.createTexture({
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  const colors = Float32Array.from({ length: width * height * 4 }, (_, i) =>
    i % 4 === 3 ? 0.375 : (Math.floor(i / 4) % 3 === 0 ? 2 : 0.05) * valueAt([1, 0.8, 0.6], i % 4),
  );
  device.queue.writeTexture({ texture: source }, colors, { bytesPerRow: width * 16 }, [
    width,
    height,
  ]);
  const ao = device.createTexture({
    size: [halfWidth, halfHeight],
    format: 'r8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  const aoBytes = Uint8Array.from({ length: halfWidth * halfHeight }, (_, i) =>
    valueAt([32, 192, 64, 240, 224, 48, 160, 96], i % 8),
  );
  device.queue.writeTexture({ texture: ao }, aoBytes, { bytesPerRow: halfWidth }, [
    halfWidth,
    halfHeight,
  ]);
  const depth = device.createTexture({
    size: [width, height],
    format: 'depth32float',
    sampleCount,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const half = device.createTexture({
    size: [halfWidth, halfHeight],
    format: 'r16float',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });
  const output = device.createTexture({
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depthAt = (z: number) =>
    (-Number(projection[10]) * z + Number(projection[14])) / (orthographic ? 1 : z);
  const seedModule = device.createShaderModule({
    code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p:vec4f${sampleCount === 4 ? ',@builtin(sample_index) sample:u32' : ''})->@builtin(frag_depth) f32 {
 if(p.x<1.0 && p.y<1.0){return 0.0;}
 ${sampleCount === 4 ? `if(sample==0u){return ${depthAt(40)};} if(sample==1u){return 0.0;} if(sample==2u){return ${depthAt(80)};}` : ''}
 return select(${depthAt(10)},${depthAt(2)},p.x<4.0);
}`,
  });
  const seedPipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: seedModule, entryPoint: 'vs' },
    fragment: { module: seedModule, entryPoint: 'fs', targets: [] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    multisample: { count: sampleCount },
  });
  const suffix = sampleCount === 4 ? '_msaa' : '';
  const depthBinding = sampleCount === 4 ? 13 : 5;
  const linearEntry = `fs_ssao_linear_depth${suffix}`;
  const colorEntry = `fs_ssao_scene_color${suffix}`;
  const modules = [];
  for (const fragment of [linearEntry, colorEntry]) {
    const compiled = (
      await compileShader(read('hdrp-ssao.wgsl'), {
        imports: {
          'forgeax_view::common': read('common.wgsl'),
          'forgeax_pbr::gbuffer': read('standard-gbuffer.wgsl'),
        },
        renderEntries: { vertex: 'vs_ssao', fragment },
      })
    ).unwrap();
    modules.push(device.createShaderModule({ code: compiled.wgsl }));
  }
  const halfPipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: valueAt(modules, 0), entryPoint: 'vs_ssao' },
    fragment: {
      module: valueAt(modules, 0),
      entryPoint: linearEntry,
      targets: [{ format: 'r16float' }],
    },
  });
  const composite = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: valueAt(modules, 1), entryPoint: 'vs_ssao' },
    fragment: {
      module: valueAt(modules, 1),
      entryPoint: colorEntry,
      targets: [{ format: 'rgba32float' }],
    },
  });
  const views = {
    depth: depth.createView(),
    half: half.createView(),
    source: source.createView(),
    ao: ao.createView(),
    output: output.createView(),
  };
  const encoder = device.createCommandEncoder();
  const seed = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: views.depth,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
  });
  seed.setPipeline(seedPipeline);
  seed.draw(3);
  seed.end();
  const hp = encoder.beginRenderPass({
    colorAttachments: [{ view: views.half, loadOp: 'clear', storeOp: 'store' }],
  });
  hp.setPipeline(halfPipeline);
  hp.setBindGroup(
    0,
    device.createBindGroup({
      layout: halfPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: depthBinding, resource: views.depth },
      ],
    }),
  );
  hp.draw(3);
  hp.end();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: views.output, loadOp: 'clear', storeOp: 'store' }],
  });
  pass.setPipeline(composite);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: composite.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: depthBinding, resource: views.depth },
        { binding: 7, resource: views.ao },
        { binding: 10, resource: views.source },
        { binding: 11, resource: { buffer: exposure } },
        { binding: 12, resource: views.half },
      ],
    }),
  );
  pass.draw(3);
  pass.end();
  const readback = device.createBuffer({
    size: 256 * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [
    width,
    height,
  ]);
  const halfReadback = device.createBuffer({
    size: 256 * halfHeight,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer({ texture: half }, { buffer: halfReadback, bytesPerRow: 256 }, [
    halfWidth,
    halfHeight,
  ]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const actual = new Float32Array(readback.getMappedRange());
  await halfReadback.mapAsync(GPUMapMode.READ);
  const stored = new Uint16Array(halfReadback.getMappedRange());
  const decode = (bits: number) => (1 + (bits & 1023) / 1024) * 2 ** (((bits >> 10) & 31) - 15);
  const storedDepths = Array.from({ length: halfWidth * halfHeight }, (_, i) =>
    decode(valueAt(stored, Math.floor(i / halfWidth) * 128 + (i % halfWidth))),
  );
  storedDepths.forEach((value, i) => {
    const sourceX = Math.floor((((i % halfWidth) + 0.5) / halfWidth) * width);
    const sourceY = Math.floor(((Math.floor(i / halfWidth) + 0.5) / halfHeight) * height);
    const expected = sourceX === 0 && sourceY === 0 ? 300.1 : sourceX < 4 ? 2 : 10;
    expect(Math.abs(value - expected)).toBeLessThanOrEqual(expected / 1024);
  });
  verifySceneAoPixels(
    actual,
    storedDepths,
    aoBytes,
    colors,
    width,
    height,
    halfWidth,
    halfHeight,
    manual,
    fallback,
    valid,
    previous,
  );
  expect(await device.popErrorScope()).toBeNull();
  halfReadback.unmap();
  halfReadback.destroy();
  readback.unmap();
  readback.destroy();
  uniform.destroy();
  exposure.destroy();
  for (const t of [source, ao, depth, half, output]) t.destroy();
  device.destroy();
});
