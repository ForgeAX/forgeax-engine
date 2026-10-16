import { readFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { buildCubeCameraFaceViews } from '../capture/cube-views';
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
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { CAPTURE_VIEW_PROJS, CUBEMAP_FACE_VERTICES } from '../ibl/IblPipelineCache';

// Independent WebGPU cube lookup coordinates, sampled away from face seams.
function direction(face: number, x: number, y: number, size: number) {
  const u = ((x + 0.5) * 2) / size - 1;
  const v = ((y + 0.5) * 2) / size - 1;
  const vector =
    [
      [1, -v, -u],
      [-1, -v, u],
      [u, 1, v],
      [u, -1, -v],
      [u, -v, 1],
      [-u, -v, -1],
    ][face] ?? [];
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

async function shader(file: string) {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = (name: string) => readFileSync(`packages/shader/src/${name}`, 'utf8');
  const compiled = await compiler.compileShader(source(file), {
    id: `forgeax::reflection-orientation-${file}`,
    imports: {
      'forgeax_pbr::brdf': source('brdf.wgsl'),
      'forgeax_pbr::ibl_shared': source('ibl-shared.wgsl'),
    },
  });
  if (!compiled.ok) throw compiled.error;
  return compiled.value.wgsl;
}

function half(bits: number) {
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  return (
    (bits & 32768 ? -1 : 1) *
    (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15))
  );
}

it('preserves asymmetric world directions through cube capture, PMREM and probe lookup', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const size = 16;
  const cube = (format: GPUTextureFormat, usage: number) =>
    device.createTexture({ size: [size, size, 6], format, usage });
  const source = cube('rgba8unorm', GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING);
  const raw = cube(
    'rgba16float',
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  const filtered = cube(
    'rgba16float',
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
  );
  const depth = device.createTexture({
    size: [size, size],
    format: 'depth32float-stencil8',
    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  });
  const readback = device.createBuffer({
    size: 256 * size * 6,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  const captureUniforms = device.createBuffer({
    size: 256 * 6,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const faceUniforms = device.createBuffer({
    size: 256 * 6,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const filterUniforms = device.createBuffer({
    size: 16,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const vertices = device.createBuffer({
    size: CUBEMAP_FACE_VERTICES.byteLength,
    usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
  });
  try {
    const background = device.createShaderModule({
      code: await shader('ibl-probe-background.wgsl'),
    });
    const prefilter = device.createShaderModule({ code: await shader('ibl-prefilter.wgsl') });
    const capturePipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: background, entryPoint: 'probe_background_vs' },
      fragment: {
        module: background,
        entryPoint: 'probe_background_fs',
        targets: [{ format: 'rgba16float' }],
      },
      depthStencil: {
        format: 'depth32float-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
    const filterPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module: prefilter,
        entryPoint: 'cubemap_vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: {
        module: prefilter,
        entryPoint: 'prefilterEnv_fs',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { cullMode: 'none' },
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const sourceView = source.createView({ dimension: 'cube' });
    const rawView = raw.createView({ dimension: 'cube' });
    const filterGroup = device.createBindGroup({
      layout: filterPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: rawView },
        { binding: 1, resource: sampler },
      ],
    });
    device.queue.writeBuffer(vertices, 0, CUBEMAP_FACE_VERTICES);
    device.queue.writeBuffer(filterUniforms, 0, new Float32Array([0, size, 1, 1]));
    const views = buildCubeCameraFaceViews({ position: [3, 5, -7], near: 0.1, far: 100 });
    const encoder = device.createCommandEncoder();
    for (let face = 0; face < 6; face++) {
      const pixels = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const d = direction(face, x, y, size);
          pixels.set(
            [
              Math.round((0.5 + 0.4 * (d[0] ?? 0)) * 255),
              Math.round((0.5 - 0.4 * (d[1] ?? 0)) * 255),
              Math.round((0.5 + 0.4 * (d[2] ?? 0)) * 255),
              255,
            ],
            (y * size + x) * 4,
          );
        }
      device.queue.writeTexture(
        { texture: source, origin: [0, 0, face] },
        pixels,
        { bytesPerRow: size * 4 },
        [size, size],
      );
      const pose = mat4.invert(mat4.create(), views[face]?.view ?? mat4.create());
      device.queue.writeBuffer(
        captureUniforms,
        face * 256,
        new Float32Array([
          ...pose.slice(0, 3),
          0,
          ...pose.slice(4, 7),
          0,
          ...pose.slice(8, 11),
          0,
          0,
          0,
          0,
          1,
          1,
          1,
          1,
          0,
        ]),
      );
      device.queue.writeBuffer(faceUniforms, face * 256, CAPTURE_VIEW_PROJS[face] ?? mat4.create());
      const group = device.createBindGroup({
        layout: capturePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sourceView },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: captureUniforms, offset: face * 256, size: 80 } },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: raw.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      });
      pass.setPipeline(capturePipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    for (let face = 0; face < 6; face++) {
      const group = device.createBindGroup({
        layout: filterPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: faceUniforms, offset: face * 256, size: 64 } },
          { binding: 1, resource: { buffer: filterUniforms } },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: filtered.createView({
              dimension: '2d',
              baseArrayLayer: face,
              arrayLayerCount: 1,
            }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
      });
      pass.setPipeline(filterPipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, filterGroup);
      pass.setVertexBuffer(0, vertices);
      pass.draw(6, 1, face * 6);
      pass.end();
    }
    encoder.copyTextureToBuffer(
      { texture: filtered },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: size },
      [size, size, 6],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const data = new DataView(readback.getMappedRange());
    let maximum = 0;
    for (let face = 0; face < 6; face++)
      for (let y = 2; y < size - 2; y++)
        for (let x = 2; x < size - 2; x++) {
          const d = direction(face, x, y, size);
          for (let channel = 0; channel < 3; channel++)
            maximum = Math.max(
              maximum,
              Math.abs(
                half(data.getUint16((face * size + y) * 256 + x * 8 + channel * 2, true)) -
                  (0.5 + 0.4 * (d[channel] ?? 0)),
              ),
            );
        }
    expect(errors).toEqual([]);
    expect(maximum).toBeLessThan(0.04);
    readback.unmap();
  } finally {
    for (const resource of [
      source,
      raw,
      filtered,
      depth,
      readback,
      captureUniforms,
      faceUniforms,
      filterUniforms,
      vertices,
    ])
      resource.destroy();
    device.destroy();
  }
});
