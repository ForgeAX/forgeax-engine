import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat4 } from '@forgeax/engine-math';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

it.each([
  [8, 0],
  [1024, 0],
  [1024, 4],
])('finds depth-texel crossings without extending the silhouette (%i pixels, depth-pyramid mip cap %i)', async (width, pyramidMaxMip) => {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as {
    compileShader(
      source: string,
      options: { id: string; imports: Record<string, string> },
    ): Promise<{ ok: boolean; value?: { wgsl: string }; error?: unknown }>;
  };
  const shader = (name: string) =>
    readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');
  const compiled = await compiler.compileShader(
    `${shader('ssr-trace')}
@group(1) @binding(0) var<storage, read_write> crossingProbe: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_crossing() {
  if (${width}u == 1024u) {
    // A 921.6-pixel projected span: a 512-step march skips texel 598.
    let hit = traceScreenRay(vec3<f32>(-0.8, 0.0, -1.0),
      normalize(vec3<f32>(1.0, 0.0, -0.2)), 6.0, 0.2,
      vec2<u32>(${width}u, 3u), 1.2, ${pyramidMaxMip}u);
    crossingProbe[0] = vec4<f32>(hit.hit, hit.uv, hit.thickness);
    crossingProbe[10] = vec4<f32>(hit.reactivity);
    // Exercise the rescue fraction helper on both projected axes and signs;
    // the trace itself is intentionally horizontal in this fixture.
    crossingProbe[11] = vec4<f32>(
      ssrRayFraction(vec2<f32>(0.3, 0.2), vec2<f32>(0.1, 0.2), vec2<f32>(0.4, 0.0), 0.9, 1.0),
      ssrRayFraction(vec2<f32>(0.6, 0.2), vec2<f32>(0.8, 0.2), vec2<f32>(-0.4, 0.0), 0.9, 1.0),
      ssrRayFraction(vec2<f32>(0.2, 0.4), vec2<f32>(0.2, 0.1), vec2<f32>(0.0, 0.6), 0.9, 1.0),
      ssrRayFraction(vec2<f32>(0.2, 0.5), vec2<f32>(0.2, 0.8), vec2<f32>(0.0, -0.6), 0.9, 1.0),
    );
    return;
  }
  let slopes = array<f32, 6>(0.6, 0.3, 0.75, -0.6, -0.3, -0.75);
  for (var i = 0u; i < 6u; i++) {
    let x = slopes[i];
    let hit = traceScreenRay(vec3<f32>(0.0, 0.0, -1.0),
      vec3<f32>(x, 0.0, -sqrt(1.0 - x*x)), 6.0, 0.2, vec2<u32>(8u, 3u), 2.8, 0u);
    crossingProbe[i] = vec4<f32>(hit.hit, hit.uv, hit.thickness);
    crossingProbe[10u + i] = vec4<f32>(hit.reactivity);
  }
  let nearHit = traceScreenRay(vec3<f32>(0.101, 0.0, -1.01),
    vec3<f32>(0.6, 0.0, -0.8), 6.0, 0.2, vec2<u32>(8u, 3u), 1.01, 0u);
  crossingProbe[6] = vec4<f32>(nearHit.hit, nearHit.uv, nearHit.thickness);
  // Subpixel receiver shifts must not alter confidence on the same plane.
  for (var i = 0u; i < 3u; i++) {
    let shifted = traceScreenRay(vec3<f32>((f32(i) - 1.0) * 0.02, 0.0, -1.0),
      vec3<f32>(0.6, 0.0, -0.8), 6.0, 0.2, vec2<u32>(8u, 3u), 2.8, 0u);
    crossingProbe[7u + i] = vec4<f32>(shifted.hit, shifted.uv, shifted.thickness);
  }
}`,
    {
      id: 'forgeax_ssr::trace',
      imports: {
        'forgeax_view::common': shader('common'),
        'forgeax_pbr::gbuffer': gbufferSource,
        'forgeax_depth_pyramid::sample': shader('depth-pyramid-sample'),
      },
    },
  );
  if (!compiled.ok || !compiled.value) throw new Error(JSON.stringify(compiled.error));
  // Oct12 perturbs the tangent plane. Bound projected error to 1/4095
  // of a texel, while retaining the exact hit/miss and confidence gates.
  const expectUv = (actual: number | undefined, expected: number) =>
    expect(Math.abs((actual ?? NaN) - expected) * width).toBeLessThan(1 / 4095);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const depth = device
    .createTexture({
      size: { width, height: 3, depthOrArrayLayers: 1 },
      format: 'depth32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const normal = device
    .createTexture({
      size: { width, height: 3, depthOrArrayLayers: 1 },
      format: 'r32uint',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const data = device
    .createTexture({
      size: { width, height: 3, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const pyramidWidth = Math.max(1, Math.floor(width / 2));
  const pyramidHeight = 1;
  const pyramidMipLevels = width === 1024 ? 4 : 1;
  const pyramid = device
    .createTexture({
      size: { width: pyramidWidth, height: pyramidHeight, depthOrArrayLayers: 1 },
      mipLevelCount: pyramidMipLevels,
      format: 'r32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const temporal = device
    .createTexture({
      size: { width, height: 3, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const output = device
    .createBuffer({
      size: 256,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      size: 256,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  try {
    const projection = mat4.create();
    const inverse = mat4.create();
    mat4.perspectiveReverseZ(projection, Math.PI / 2, 1, 1, 10);
    mat4.invert(inverse, projection);
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    payload.set(projection, 0);
    payload.set(inverse, 44);
    payload.set([1, 10, 0, 0], 228);
    device.queue.writeBuffer(view, 0, payload).unwrap();
    const seed = createShaderModuleImmediate(device, {
      code: `
@vertex fn seed_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn seed_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  if (${width}u == 1024u) {
    let viewDistance = 2.9 / (3.0 - 598.5 / 1024.0);
    return select(0.0, (10.0 / viewDistance - 1.0) / 9.0, u32(p.x) == 598u && u32(p.y) == 1u);
  }
  // Symmetric texels 2 and 5 contain a wall; their adjacent texels are sky.
  return select(0.0, (10.0 / 2.8 - 1.0) / 9.0, u32(p.x) == 2u || u32(p.x) == 5u);
}
@fragment fn seed_receiver_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  if (u32(p.x) == 4u) { return (10.0 / 1.01 - 1.0) / 9.0; }
  if (u32(p.x) == 5u) { return (10.0 / 1.33 - 1.0) / 9.0; }
  return 0.0;
}
@fragment fn seed_smoothed_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  return select(0.0, (10.0 / 1.33 - 1.0) / 9.0, u32(p.x) == 5u || u32(p.x) == 6u);
}
@fragment fn seed_oblique_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  // Plane z=x-4.15. Its pixel-center view distance is 3.01818,
  // although the reflected ray meets it inside this texel at distance 2.8.
  let viewDistance = 4.15 / (1.0 + (p.x / 8.0 * 2.0 - 1.0));
  return select(0.0, (10.0 / viewDistance - 1.0) / 9.0, u32(p.x) == 5u);
}`,
    }).unwrap();
    const seedPipelineFor = (entryPoint: string) =>
      device
        .createRenderPipeline({
          layout: 'auto',
          vertex: { module: seed, entryPoint: 'seed_vertex', buffers: [] },
          fragment: { module: seed, entryPoint, targets: [] },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        })
        .unwrap();
    const seedPipeline = seedPipelineFor('seed_depth');
    const receiverSeedPipeline = seedPipelineFor('seed_receiver_depth');
    const smoothedSeedPipeline = seedPipelineFor('seed_smoothed_depth');
    const obliqueSeedPipeline = seedPipelineFor('seed_oblique_depth');
    const module = createShaderModuleImmediate(device, { code: compiled.value.wgsl }).unwrap();
    const inputLayout = device
      .createBindGroupLayout({
        entries: [
          ...[0, 1, 6, 7].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: {
              sampleType:
                binding === 1
                  ? ('uint' as const)
                  : binding === 0
                    ? ('depth' as const)
                    : ('unfilterable-float' as const),
              viewDimension: '2d' as const,
            },
          })),
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
          },
          { binding: 5, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const outputLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [inputLayout, outputLayout] })
          .unwrap(),
        compute: { module, entryPoint: 'probe_crossing' },
      })
      .unwrap();
    const depthView = device.createTextureView(depth, {}).unwrap();
    const normalView = device.createTextureView(normal, {}).unwrap();
    const dataView = device.createTextureView(data, {}).unwrap();
    const pyramidView = device.createTextureView(pyramid, {}).unwrap();
    const temporalView = device.createTextureView(temporal, {}).unwrap();
    const inputGroup = device
      .createBindGroup({
        layout: inputLayout,
        entries: [
          ...[0, 1, 6, 7].map((binding) => ({
            binding,
            resource: {
              kind: 'textureView' as const,
              value:
                binding === 1
                  ? normalView
                  : binding === 0
                    ? depthView
                    : binding === 7
                      ? temporalView
                      : dataView,
            },
          })),
          { binding: 3, resource: { kind: 'textureView', value: pyramidView } },
          { binding: 5, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const outputGroup = device
      .createBindGroup({
        layout: outputLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    for (const [name, normalZ, coverage] of [
      ['front-facing', 1, 1],
      ['smooth-normal', 0.9, 1],
      ['back-facing', 0, 1],
      ['moving-back-facing', 0, 1],
      ['reactive-back-facing', 0, 1],
      ['moving-sky', 0, 1],
      ['excluded', 1, 0],
      ['receiver', 1, 1],
      ['oblique', 0.5 + 0.5 * Math.SQRT1_2, 1],
    ] as const) {
      if (width === 1024 && (name === 'receiver' || name === 'oblique' || name === 'smooth-normal'))
        continue;
      // Mirror the production minimum hierarchy for this long-ray probe:
      // the wall is in mip 0 texel 299 and in each ancestor selected by the
      // reduction chain. The trace must descend it back to source x=598.
      for (let level = 0; level < pyramidMipLevels; level += 1) {
        const levelWidth = Math.max(1, pyramidWidth >> level);
        const levelData = new Float32Array(levelWidth).fill(3.402823e38);
        if (width === 1024) {
          const wallCell = Math.min(levelWidth - 1, Math.floor(598 / 2 ** (level + 1)));
          levelData[wallCell] = 2.9 / (3 - 598.5 / 1024);
        }
        device.queue
          .writeTexture(
            { texture: pyramid, mipLevel: level },
            levelData,
            { bytesPerRow: levelWidth * 4, rowsPerImage: 1 },
            { width: levelWidth, height: 1, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }
      device.queue
        .writeTexture(
          { texture: temporal },
          new Float32Array(
            Array.from({ length: width * 3 }, (_, index) => {
              const x = index % width;
              const wall = width === 1024 ? x === 598 : x === 2 || x === 5;
              return [
                (name === 'moving-back-facing' && wall) || (name === 'moving-sky' && !wall)
                  ? 1 / 128
                  : 0,
                0,
                2.8,
                name === 'reactive-back-facing' && wall ? 0.75 : 0,
              ];
            }).flat(),
          ),
          { bytesPerRow: width * 16, rowsPerImage: 3 },
          { width, height: 3, depthOrArrayLayers: 1 },
        )
        .unwrap();
      const normalData = new Float32Array(
        Array.from({ length: width * 3 }, (_, index) => {
          const x = index % width;
          return name === 'receiver' && x === 4
            ? [0.5, 1, 0.5, coverage]
            : [
                name === 'oblique'
                  ? 0.5 - 0.5 * Math.SQRT1_2
                  : name === 'smooth-normal'
                    ? 0.75 + x * 0.01
                    : 0.5,
                0.5,
                normalZ,
                coverage,
              ];
        }).flat(),
      );
      device.queue
        .writeTexture(
          { texture: data },
          normalData,
          { bytesPerRow: width * 16, rowsPerImage: 3 },
          { width, height: 3, depthOrArrayLayers: 1 },
        )
        .unwrap();
      writePackedNormals(device, normal, width, 3, normalData);
      const encoder = device.createCommandEncoder().unwrap();
      const raster = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      raster.setPipeline(
        name === 'receiver'
          ? receiverSeedPipeline
          : name === 'smooth-normal'
            ? smoothedSeedPipeline
            : name === 'oblique'
              ? obliqueSeedPipeline
              : seedPipeline,
      );
      raster.draw(3);
      raster.end();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, inputGroup);
      pass.setBindGroup(1, outputGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 256);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      const pixels = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      for (const ray of width === 1024 ? [0] : [0, 3]) {
        expect(
          pixels[(10 + ray) * 4],
          `${name}: rejected moving occluder must invalidate history without becoming a reflection hit`,
        ).toBe(name === 'moving-back-facing' ? 0.5 : name === 'reactive-back-facing' ? 0.75 : 0);
      }
      if (width === 1024) {
        expect(pixels[0], `${name}: long ray must not skip its only wall texel`).toBe(
          name === 'front-facing' ? 1 : 0,
        );
        if (name === 'front-facing') {
          expect(pixels[1]).toBeCloseTo(598.5 / 1024, 5);
          expectUv(pixels[2], 0.5);
          expect(pixels[3]).toBeGreaterThan(0.99);
        }
        if (name === 'front-facing') {
          expect(pixels[44]).toBeCloseTo(0.5, 6);
          expect(pixels[45]).toBeCloseTo(0.5, 6);
          expect(pixels[46]).toBeCloseTo(0.5, 6);
          expect(pixels[47]).toBeCloseTo(0.5, 6);
        }
        continue;
      }
      if (name === 'receiver') {
        // The coarse sample sees the wall, but a depth-only bisection moves
        // backward onto the receiver. Its differently facing plane must not
        // steal the bracket. Analytic t=(1.33-1.01)/0.8=0.4, x=0.341.
        expect(pixels[24], 'refinement must retain the wall, not the receiver').toBe(1);
        expectUv(pixels[25], 0.5 + (0.5 * 0.341) / 1.33);
        expectUv(pixels[26], 0.5);
        expect(pixels[27]).toBeGreaterThan(0.99);
        continue;
      }
      if (name === 'smooth-normal') {
        // The depth crossing belongs to texel 5. A smooth/normal-mapped
        // shading normal points its tangent correction into adjacent sky;
        // retry with depth geometry must recover the analytic intersection,
        // not merely accept the stair-stepped depth crossing.
        expect(pixels[24], 'shading-normal refinement must retain a valid depth crossing').toBe(1);
        expectUv(pixels[25], 0.5 + (0.5 * 0.341) / 1.33);
        expect(pixels[27]).toBeGreaterThan(0.99);
        continue;
      }
      if (name === 'oblique') {
        expect(pixels[0], 'pixel-center depth must not reject an in-texel oblique-plane hit').toBe(
          1,
        );
        expectUv(pixels[1], 0.5 + (0.5 * 1.35) / 2.8);
        expectUv(pixels[2], 0.5);
        expect(pixels[3], 'an exact tangent-plane hit has no thickness residual').toBeGreaterThan(
          0.9999,
        );
        for (let i = 0; i < 3; i++) {
          const x = (i - 1) * 0.02;
          const distance = (3.15 - x) / 1.4;
          const offset = (7 + i) * 4;
          expect(pixels[offset], 'subpixel shift retains the oblique plane').toBe(1);
          expectUv(pixels[offset + 1], 0.5 + (0.5 * (x + 0.6 * distance)) / (1 + 0.8 * distance));
          expect(
            pixels[offset + 3],
            'confidence is independent of position inside the depth texel',
          ).toBeGreaterThan(0.9999);
        }
        for (const offset of [4, 8, 12, 16, 20]) {
          expect(pixels[offset], 'oblique-plane sky').toBe(0);
        }
        continue;
      }
      for (const offset of [0, 12]) {
        expect(pixels[offset + 4], `${name}: inner sky`).toBe(0);
        expect(pixels[offset + 8], `${name}: outer sky`).toBe(0);
        expect(pixels[offset], `${name}: wall crossing`).toBe(name === 'front-facing' ? 1 : 0);
        if (name === 'front-facing') {
          // Analytic t=(2.8-1)/0.8=2.25, x=+/-1.35, inside texel 5/2.
          const sign = offset === 0 ? 1 : -1;
          expectUv(pixels[offset + 1], 0.5 + (sign * (0.5 * 1.35)) / 2.8);
          expectUv(pixels[offset + 2], 0.5);
          expect(pixels[offset + 3]).toBeGreaterThan(0.99);
        }
      }
    }
  } finally {
    device.destroyTexture(depth).unwrap();
    device.destroyTexture(data).unwrap();
    device.destroyTexture(normal).unwrap();
    device.destroyTexture(pyramid).unwrap();
    device.destroyTexture(temporal).unwrap();
    for (const buffer of [view, output, readback]) device.destroyBuffer(buffer).unwrap();
  }
});
