import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { halfFloat } from '@forgeax/engine-math';
import type { Texture } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

async function composePixels(
  width: number,
  normals: number[],
  radiance: number[],
  options: {
    mips?: number[][];
    enabled?: number;
    roughnessLimit?: number;
    coverage?: number;
    source?: string;
    height?: number;
  } = {},
) {
  const height = options.height ?? 2;
  const radianceHeight = Math.max(1, Math.floor(height / 2));
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const common = readFileSync(resolve(process.cwd(), 'packages/shader/src/common.wgsl'), 'utf8');
  const viewDeclarations = common.match(/struct (?:AtmosphereMedium|View)\s*\{[\s\S]*?\};/g);
  expect(viewDeclarations).toHaveLength(2);
  if (viewDeclarations?.length !== 2) throw new Error('Shared View declarations missing');
  const viewStruct = viewDeclarations.join('\n');
  const source = (
    options.source ??
    readFileSync(resolve(process.cwd(), 'packages/shader/src/ssr-compose.wgsl'), 'utf8')
  )
    .replace(/^#define_import_path.*$/gm, '')
    .replace('#import forgeax_view::common::View', viewStruct)
    .replace(
      /^#import forgeax_pbr::gbuffer.*$/gm,
      gbufferSource.replace(/^#define_import_path.*$/gm, ''),
    );
  const textures: Texture[] = [];
  const upload = (width: number, height: number, values: number[], mips: number[][] = []) => {
    const texture = device
      .createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        // Match the production resolved pyramid. rgba16float is filterable
        // without requiring the optional float32-filterable feature.
        format: 'rgba16float',
        mipLevelCount: mips.length + 1,
        textureBindingViewDimension: '2d',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
      .unwrap();
    textures.push(texture);
    for (const [level, data] of [values, ...mips].entries()) {
      const bytes = halfFloat.f32ToF16Bytes(new Uint8Array(new Float32Array(data).buffer));
      device.queue
        .writeTexture(
          { texture, mipLevel: level },
          bytes,
          {
            bytesPerRow: Math.max(1, width >> level) * 8,
            rowsPerImage: Math.max(1, height >> level),
          },
          {
            width: Math.max(1, width >> level),
            height: Math.max(1, height >> level),
            depthOrArrayLayers: 1,
          },
        )
        .unwrap();
    }
    return device.createTextureView(texture, {}).unwrap();
  };
  const repeat = (value: number[]) => Array.from({ length: width * height }, () => value).flat();
  const packed = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'r32uint',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  textures.push(packed);
  writePackedNormals(device, packed, width, height, normals);
  const views = [
    upload(width / 2, radianceHeight, radiance, options.mips),
    upload(width, height, repeat([0.1, 0.1, 0.1, options.coverage ?? 1])),
    upload(width, height, repeat([1, 1, 1, 1])),
    device.createTextureView(packed, {}).unwrap(),
  ];
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const viewData = new Float32Array(VIEW_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  viewData[238] = options.roughnessLimit ?? 1;
  viewData[239] = options.enabled ?? 1;
  device.queue.writeBuffer(view, 0, viewData).unwrap();
  const output = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    })
    .unwrap();
  textures.push(output);
  const readback = device
    .createBuffer({
      size: Math.max(512, 256 * height),
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  const sampler = device
    .createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
    })
    .unwrap();
  try {
    const module = createShaderModuleImmediate(device, { code: source }).unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          ...views.map((_, binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: {
              sampleType:
                binding === 3
                  ? ('uint' as const)
                  : binding === 0
                    ? ('float' as const)
                    : ('unfilterable-float' as const),
              viewDimension: '2d' as const,
            },
          })),
          {
            binding: 4,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            sampler: { type: 'filtering' as const },
          },
          {
            binding: 5,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            buffer: { type: 'uniform' as const },
          },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs_ssr_compose', buffers: [] },
        fragment: { module, entryPoint: 'fs_ssr_compose', targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [
          ...views.map((value, binding) => ({
            binding,
            resource: { kind: 'textureView' as const, value },
          })),
          { binding: 4, resource: { kind: 'sampler' as const, value: sampler } },
          { binding: 5, resource: { kind: 'buffer' as const, value: { buffer: view } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(output, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const pixels = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return pixels;
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(view).unwrap();
  }
}

it('does not compose a half-resolution reflection onto a differently facing full-resolution surface', async () => {
  const pixels = await composePixels(
    2,
    [0.5, 1, 0.5, 0.08, 1, 0.5, 0.5, 0.08, 0.5, 1, 0.5, 0.08, 0.5, 0.5, 1, 0.08],
    [1, 0, 0, 1],
  );
  // Zero contribution may have either IEEE sign after multiplying by zero.
  expect(
    pixels.slice(4, 8).every((value) => value === 0),
    'side face',
  ).toBe(true);
  expect(
    pixels.slice(68, 72).every((value) => value === 0),
    'wall face',
  ).toBe(true);
  for (const offset of [0, 64]) {
    expect(pixels[offset]).toBeCloseTo(0.9, 3);
    expect(pixels[offset + 1]).toBeCloseTo(-0.1, 3);
  }
});

it('keeps the rough reflected lobe beyond a mirror miss without admitting disabled or incompatible receivers', async () => {
  // A real confidence-weighted step pyramid: one red hit, then one miss.
  // At full pixel 3, mip zero misses but the rough lobe still covers red.
  const radiance = [1, 0, 0, 1, 0, 0, 0, 0];
  // One exact mip average keeps the numeric oracle independent of backend
  // trilinear LOD quantization; the production shader still selects the LOD.
  const mips = [[0.5, 0, 0, 0.5]];
  // Use the UNORM8-decoded roughness in the independent LOD oracle.
  const normals = Array.from({ length: 8 }, () => [0.5, 1, 0.5, 0.75]).flat();
  const pixels = await composePixels(4, normals, radiance, { mips });
  // The base misses and mip 1 contributes 0.5 * roughness^2 confidence.
  // Decode fallback 0.1 through FP16, then apply the independent delta formula.
  const confidence = 0.5 * (Math.round(0.75 * 255) / 255) ** 2;
  const fallback = 0.0999755859375;
  expect(pixels[12], 'rough lobe red').toBeCloseTo(confidence * (1 - fallback), 4);
  expect(pixels[13], 'weighted fallback replacement').toBeCloseTo(-confidence * fallback, 4);
  for (const options of [
    { enabled: 0 },
    { enabled: Number.NaN },
    { enabled: Infinity },
    { roughnessLimit: 0 },
    { roughnessLimit: 0.65 },
    { roughnessLimit: 0.74 },
    { coverage: 0 },
  ]) {
    const guarded = await composePixels(4, normals, radiance, { ...options, mips });
    // Disabled, over-cutoff, and zero-coverage receivers must not contribute
    // even a signed-zero/quantization residue.
    expect(guarded.slice(12, 16).every((value) => value === 0)).toBe(true);
  }
  const sideNormals = [...normals];
  sideNormals.splice(3 * 4, 3, 1, 0.5, 0.5);
  const side = await composePixels(4, sideNormals, radiance, { mips });
  expect(
    side.slice(12, 16).every((value) => value === 0),
    'no top lobe on side',
  ).toBe(true);
});

it('reconstructs a compatible neighbor instead of dropping reflection at the receiver seam', async () => {
  const row = [1, 0.5, 0.5, 0.08, 0.5, 1, 0.5, 0.08, 0.5, 1, 0.5, 0.08, 0.5, 0.5, 1, 0.08];
  const pixels = await composePixels(4, [...row, ...row], [1, 0, 0, 1, 0, 1, 0, 1]);
  // Pixel 1 lies between a red side-face ray and a green top-face ray.
  // floor(pixel/2) chooses the wrong face, although a compatible ray exists.
  for (const offset of [4, 8, 68, 72]) {
    expect(pixels[offset], 'no side-face red').toBeCloseTo(-0.1, 3);
    expect(pixels[offset + 1], 'compatible top-face reflection').toBeCloseTo(0.9, 3);
  }
  expect(
    pixels.slice(12, 16).every((value) => value === 0),
    'unmatched wall',
  ).toBe(true);
});

it('keeps the receiver gather as four statically ordered manual taps', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/ssr-compose.wgsl'),
    'utf8',
  );
  const receiver = source.match(/fn ssrReceiverSample[\s\S]*?\n}\n\nfn ssrReflectionLod/);
  expect(receiver?.[0]).toBeDefined();
  if (receiver === null || receiver === undefined) throw new Error('Receiver function missing');
  expect(receiver[0]).not.toMatch(/for\s*\(/);
  expect(receiver[0].match(/textureLoad\(radiance/g)).toHaveLength(4);
  expect(receiver[0]).toMatch(/pixel00[\s\S]*pixel10[\s\S]*pixel01[\s\S]*pixel11/);
});

it('matches the loop baseline on the same Dawn inputs within the compose error budget', async () => {
  const source = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/ssr-compose.wgsl'),
    'utf8',
  );
  const baselineReceiver = `fn ssrReceiverSample(uv : vec2<f32>, packedNormal : u32, lod : f32) -> SsrReceiverSample {
  let normal = decodeStandardNormalRoughness(packedNormal).xyz;
  let size = vec2<i32>(textureDimensions(radiance, 0));
  let coordinate = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(coordinate));
  let fraction = fract(coordinate);
  var sum = vec4<f32>(0.0);
  var totalWeight = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let pixel = clamp(first + vec2<i32>(x, y), vec2<i32>(0), size - vec2<i32>(1));
      let tracedNormal = loadStandardNormalRoughness(normalRoughness, pixel * 2).xyz;
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1)
        * ssrReceiverWeight(normal, tracedNormal);
      let sample = textureLoad(radiance, pixel, 0);
      sum += sample * weight;
      totalWeight += weight;
    }
  }
  return SsrReceiverSample(sum / max(totalWeight, 1e-6), totalWeight);
}`;
  const baseline = source.replace(
    /fn ssrReceiverSample[\s\S]*?\n}\n\nfn ssrReflectionLod/,
    `${baselineReceiver}\n\nfn ssrReflectionLod`,
  );
  expect(baseline).not.toBe(source);
  // The fourth channel is source confidence and intentionally differs across
  // all four radiance taps.
  const radiance = [1, 0, 0, 1, 0, 0.5, 0, 0.25, 0, 0, 1, 0.6, 0.5, 1, 0.25, 0.75];
  const mips = [
    [0.5, 0.1, 0.05, 0.625, 0.25, 0.375, 0.1, 0.425],
    [0.3, 0.25, 0.2, 0.55],
  ];
  const directions = [
    [0.5, 1, 0.5],
    [0.5, 1, 0.5],
    [0.5, 0.5, 1],
    [1, 0.5, 0.5],
  ] as const;
  // With three levels, .04/.2 exercise the base-to-mip-1 path while .8 uses
  // the rough mip path.
  for (const roughness of [0.04, 0.2, 0.8]) {
    const normals = Array.from({ length: 4 }, () => directions)
      .flat()
      .flatMap(([x, y, z]) => [x, y, z, roughness]);
    const [expanded, loop] = await Promise.all([
      composePixels(8, normals, radiance, { mips, source }),
      composePixels(8, normals, radiance, { mips, source: baseline }),
    ]);
    const maxDifference = Math.max(
      ...expanded.map((value, index) => Math.abs(value - (loop[index] ?? 0))),
    );
    expect(maxDifference, `roughness ${roughness}`).toBeLessThanOrEqual(0.00025);
  }

  // A separate 2x2, no-mip witness proves that the vertical pair is consumed
  // by the receiver gather, rather than merely matching on a one-row image.
  const twoDimensionalRadiance = [
    1, 0, 0, 1, 0, 0.25, 0, 0.25, 0, 0, 0.5, 0.5, 0.75, 0.75, 0, 0.75,
  ];
  const allCompatibleNormals = Array.from({ length: 4 * 4 }, () => [0.5, 1, 0.5, 0.2])
    .flat()
    .flat();
  const twoDimensionalNormals = [...allCompatibleNormals];
  // Keep the receiver at (1,1) compatible while making its 11 trace normal
  // incompatible; this covers the rejection/renormalization branch too.
  twoDimensionalNormals.splice((2 * 4 + 2) * 4, 3, 1, 0.5, 0.5);
  const [expanded2d, loop2d] = await Promise.all([
    composePixels(4, twoDimensionalNormals, twoDimensionalRadiance, { height: 4, source }),
    composePixels(4, twoDimensionalNormals, twoDimensionalRadiance, {
      height: 4,
      source: baseline,
    }),
  ]);
  const maxDifference2d = Math.max(
    ...expanded2d.map((value, index) => Math.abs(value - (loop2d[index] ?? 0))),
  );
  expect(maxDifference2d, '2x2 receiver taps').toBeLessThanOrEqual(0.00025);

  const wrongTapSource = source.replace(
    'sum += textureLoad(radiance, pixel11, 0) * weight11;',
    'sum += textureLoad(radiance, pixel10, 0) * weight11;',
  );
  expect(wrongTapSource).not.toBe(source);
  const wrong2d = await composePixels(4, allCompatibleNormals, twoDimensionalRadiance, {
    height: 4,
    source: wrongTapSource,
  });
  const wrongDifference2d = Math.max(
    ...(await composePixels(4, allCompatibleNormals, twoDimensionalRadiance, { height: 4 })).map(
      (value, index) => Math.abs(value - (wrong2d[index] ?? 0)),
    ),
  );
  expect(wrongDifference2d, 'wrong 11 tap must be observable').toBeGreaterThan(0.001);
});
