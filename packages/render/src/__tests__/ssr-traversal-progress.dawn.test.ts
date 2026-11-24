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
import { gbufferSource } from './standard-gbuffer.fixture';

// A nearly vertical ray crosses x=6/13, a coarse mip boundary, by less than
// one full-resolution pixel. The original march revisits the old cell until
// its 64-iteration budget expires. Transposes and signs retain the same oracle.
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('advances rays across odd mip boundaries (orthographic: %s, toward camera: %s)', async (orthographic, towardCamera) => {
  const width = 1706;
  const height = 1140;
  // A closest hierarchy cannot skip a segment already behind its nearest
  // surface. Keep that separate toward-camera projection probe within 64 steps.
  const startHigh = towardCamera ? 0.53 : 0.62;
  const startLow = towardCamera ? 0.47 : 0.38;
  const endLow = towardCamera ? 0.47 : 0.35;
  const endHigh = towardCamera ? 0.53 : 0.65;
  const source = (name: string) =>
    readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');
  const { compileShader } = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = await compileShader(
    `${source('ssr-trace')}
@group(1) @binding(0) var<storage, read_write> progressProbe: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_progress() {
  let boundary = 6.0 / 13.0;
  let starts = array<vec2<f32>, 8>(
    vec2<f32>(boundary + 0.00006, ${startHigh}), vec2<f32>(boundary - 0.00006, ${startLow}),
    vec2<f32>(${startHigh}, 0.5 + 0.00006), vec2<f32>(${startLow}, 0.5 - 0.00006),
    vec2<f32>(boundary, ${startHigh}), vec2<f32>(boundary, ${startLow}),
    vec2<f32>(${startHigh}, 0.5), vec2<f32>(${startLow}, 0.5));
  let ends = array<vec2<f32>, 8>(
    vec2<f32>(boundary - 0.00004, ${endLow}), vec2<f32>(boundary + 0.00004, ${endHigh}),
    vec2<f32>(${endLow}, 0.5 - 0.00004), vec2<f32>(${endHigh}, 0.5 + 0.00004),
    vec2<f32>(boundary, ${endLow}), vec2<f32>(boundary, ${endHigh}),
    vec2<f32>(${endLow}, 0.5), vec2<f32>(${endHigh}, 0.5));
  for (var index = 0u; index < 8u; index++) {
    let nearDepth = select(1.0, 9.0 / 9.9, view.temporalProjection.z > 0.5);
    let farDepth = select(4.0 / 9.0, 8.0 / 9.9, view.temporalProjection.z > 0.5);
    let firstDepth = select(nearDepth, farDepth, ${towardCamera});
    let secondDepth = select(farDepth, nearDepth, ${towardCamera});
    let origin = reconstructWorldPosition(starts[index], firstDepth);
    let end = reconstructWorldPosition(ends[index], secondDepth);
    let direction = normalize(end - origin);
    let hit = traceScreenRay(origin, direction, 6.0, 0.05,
      vec2<u32>(${width}u, ${height}u), 1.8, 10u);
    progressProbe[index] = vec4<f32>(hit.hit, hit.uv, hit.thickness);
    let normal = vec3<f32>(0.0, 1.0, 0.0);
    let receiver = WaterSsrReceiver(true, origin, normal, -reflect(direction, normal), 0.0);
    let water = traceWaterWorldRay(receiver);
    progressProbe[index + 8u] = vec4<f32>(select(0.0, 1.0, water.found), water.uv, water.depth);
  }
}`,
    {
      id: 'forgeax_ssr::trace',
      imports: {
        'forgeax_view::common': source('common'),
        'forgeax_pbr::gbuffer': gbufferSource,
        'forgeax_depth_pyramid::sample': source('depth-pyramid-sample'),
        forgeax_scene_temporal: source('scene-temporal'),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const depth = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'depth32float',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const normal = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'r32uint',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const fallback = device
    .createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const pyramid = device
    .createTexture({
      size: { width: width / 2, height: height / 2, depthOrArrayLayers: 1 },
      mipLevelCount: 10,
      format: 'r32float',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
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
    if (orthographic) mat4.orthographicReverseZ(projection, -1, 1, 1, -1, 0.1, 10);
    else mat4.perspectiveReverseZ(projection, Math.PI / 2, 1, 1, 10);
    mat4.invert(inverse, projection);
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    payload.set(projection, 0);
    payload.set(inverse, 44);
    payload.set([orthographic ? 0.1 : 1, 10, Number(orthographic), 0], 228);
    payload.set([6, 0.05, 1, 1], 236);
    device.queue.writeBuffer(view, 0, payload).unwrap();
    for (let level = 0; level < 10; level++) {
      const w = Math.max(1, (width / 2) >> level);
      const h = Math.max(1, (height / 2) >> level);
      device.queue
        .writeTexture(
          { texture: pyramid, mipLevel: level },
          new Float32Array(w * h).fill(1.8),
          { bytesPerRow: w * 4, rowsPerImage: h },
          { width: w, height: h, depthOrArrayLayers: 1 },
        )
        .unwrap();
    }
    const seed = createShaderModuleImmediate(device, {
      code: `${gbufferSource.replace(/^#define_import_path.*$/gm, '')}
@group(0) @binding(0) var normalOutput: texture_storage_2d<r32uint, write>;
@group(0) @binding(1) var fallbackOutput: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8) fn seed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= textureDimensions(normalOutput))) { return; }
  textureStore(normalOutput, vec2<i32>(id.xy), vec4<u32>(encodeStandardNormalRoughness(vec3<f32>(0.0, 0.0, ${towardCamera ? -1 : 1}.0), 0.0)));
  textureStore(fallbackOutput, vec2<i32>(id.xy), vec4<f32>(0.0, 0.0, 0.0, 1.0));
}`,
    }).unwrap();
    const seedLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            storageTexture: { access: 'write-only', format: 'r32uint', viewDimension: '2d' },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const seedPipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [seedLayout] }).unwrap(),
        compute: { module: seed, entryPoint: 'seed' },
      })
      .unwrap();
    const seedGroup = device
      .createBindGroup({
        layout: seedLayout,
        entries: [normal, fallback].map((texture, binding) => ({
          binding,
          resource: {
            kind: 'textureView' as const,
            value: device.createTextureView(texture, {}).unwrap(),
          },
        })),
      })
      .unwrap();
    const inputLayout = device
      .createBindGroupLayout({
        entries: [
          ...[0, 1, 3, 6, 7].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: {
              viewDimension: '2d' as const,
              sampleType:
                binding === 0
                  ? ('depth' as const)
                  : binding === 1
                    ? ('uint' as const)
                    : ('unfilterable-float' as const),
            },
          })),
          { binding: 5, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const outputLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            buffer: { type: 'storage' },
          },
        ],
      })
      .unwrap();
    const module = createShaderModuleImmediate(device, { code: compiled.value.wgsl }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [inputLayout, outputLayout] })
          .unwrap(),
        compute: { module, entryPoint: 'probe_progress' },
      })
      .unwrap();
    const textures = [
      [0, depth],
      [1, normal],
      [3, pyramid],
      [6, fallback],
      [7, fallback],
    ] as const;
    const inputGroup = device
      .createBindGroup({
        layout: inputLayout,
        entries: [
          ...textures.map(([binding, texture]) => ({
            binding,
            resource: {
              kind: 'textureView' as const,
              value: device.createTextureView(texture, {}).unwrap(),
            },
          })),
          { binding: 5, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const outputGroup = device
      .createBindGroup({
        layout: outputLayout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: output } },
          },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const clear = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: device.createTextureView(depth, {}).unwrap(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: orthographic ? 8.2 / 9.9 : (10 / 1.8 - 1) / 9,
      },
    });
    clear.end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(seedPipeline);
    pass.setBindGroup(0, seedGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, inputGroup);
    pass.setBindGroup(1, outputGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 256);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const boundary = 6 / 13;
    const starts = [
      [boundary + 0.00006, startHigh],
      [boundary - 0.00006, startLow],
      [startHigh, 0.50006],
      [startLow, 0.49994],
      [boundary, startHigh],
      [boundary, startLow],
      [startHigh, 0.5],
      [startLow, 0.5],
    ];
    const ends = [
      [boundary - 0.00004, endLow],
      [boundary + 0.00004, endHigh],
      [endLow, 0.49996],
      [endHigh, 0.50004],
      [boundary, endLow],
      [boundary, endHigh],
      [endLow, 0.5],
      [endHigh, 0.5],
    ];
    const awayWeight = orthographic ? 0.8 : 8 / 9;
    const endWeight = towardCamera ? 1 - awayWeight : awayWeight;
    for (let ray = 0; ray < 16; ray++) {
      expect(
        values[ray * 4],
        `ray ${ray} must reach the continuous plane within its existing budget`,
      ).toBe(1);
      for (let axis = 0; axis < 2; axis++) {
        const expected =
          (starts[ray % 8]?.[axis] ?? NaN) * (1 - endWeight) +
          (ends[ray % 8]?.[axis] ?? NaN) * endWeight;
        expect(values[ray * 4 + 1 + axis]).toBeCloseTo(expected, 5);
      }
    }
  } finally {
    for (const texture of [depth, normal, fallback, pyramid])
      device.destroyTexture(texture).unwrap();
    for (const buffer of [view, output, readback]) device.destroyBuffer(buffer).unwrap();
  }
});
