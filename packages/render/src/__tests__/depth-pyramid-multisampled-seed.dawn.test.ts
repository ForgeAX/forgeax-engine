import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import {
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';

const WIDTH = 8;
const HEIGHT = 4;
const SAMPLES = 4;
const WALL_DEPTH = 0.5;
// Perspective near 1, far 10: the reversed-Z wall sits at 1 / (0.5 + 0.5 * 0.1).
const WALL_DISTANCE = 1 / 0.55;
const EMPTY_DEPTH = 1e30;

const readShader = (name: string) =>
  readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');

async function compileShader(name: string): Promise<string> {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as {
    compileShader(
      source: string,
      options: { id: string; imports: Record<string, string> },
    ): Promise<{ ok: boolean; value?: { wgsl: string }; error?: unknown }>;
  };
  const result = await compiler.compileShader(readShader(name), {
    id: `forgeax_depth_pyramid::multisampled-${name}`,
    imports: {
      'forgeax_view::common': readShader('common'),
      'forgeax_depth_pyramid::sample': readShader('depth-pyramid-sample'),
    },
  });
  if (!result.ok || !result.value) throw new Error(JSON.stringify(result.error));
  return result.value.wgsl;
}

/** A wall whose `mask` selects which samples of each covered pixel it writes. */
function wallPipeline(device: RhiDevice, mask: number) {
  const module = createShaderModuleImmediate(device, {
    code: `
@vertex fn wall_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], ${WALL_DEPTH}, 1.0);
}
@fragment fn wall_fragment() {}`,
  }).unwrap();
  return device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'wall_vertex', buffers: [] },
      // Exercise sample-mask coverage through an explicit fragment stage. Some
      // native depth-only pipelines otherwise write every sample in this fixture.
      fragment: { module, entryPoint: 'wall_fragment', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      multisample: { count: SAMPLES, mask },
    })
    .unwrap();
}

// Occlusion may only trust a texel whose every sample holds the occluder. The
// left half of this 4x MSAA depth holds the wall in all samples; the right half
// only in sample 0, as along a silhouette edge. The furthest seed must keep the
// wall on the left and report the right half EMPTY; a seed that read one sample
// would hide geometry visible through the other three.
it('seeds the furthest pyramid from every sample of multisampled depth', async () => {
  const [seed, reduce] = await Promise.all([
    compileShader('depth-pyramid-seed'),
    compileShader('depth-pyramid-reduce'),
  ]);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const depth = device
    .createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: 'depth32float',
      sampleCount: SAMPLES,
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      size: 256 * HEIGHT,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  try {
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    payload.set([1, 10, 0, 0], 228);
    device.queue.writeBuffer(view, 0, payload).unwrap();

    const edge = wallPipeline(device, 0b0001);
    const solid = wallPipeline(device, 0b1111);
    const depthView = device.createTextureView(depth, {}).unwrap();
    const raster = device.createCommandEncoder().unwrap();
    const pass = raster.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(edge);
    pass.draw(3);
    pass.setPipeline(solid);
    pass.setScissorRect(0, 0, WIDTH / 2, HEIGHT);
    pass.draw(3);
    pass.end();
    device.queue.submit([raster.finish().unwrap()]).unwrap();

    type Frame = { readonly encoder: RhiCommandEncoder };
    const graph = new RenderGraphBuilder<Frame>();
    const importedDepth = graph
      .importTexture(
        'msaa-depth',
        {
          format: 'depth32float',
          size: { width: WIDTH, height: HEIGHT },
          sampleCount: SAMPLES,
          usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        },
        () => depth,
      )
      .unwrap();
    const depthSample = graph
      .view(importedDepth, { label: 'msaa-depth-only', dimension: '2d', aspect: 'depth-only' })
      .unwrap();
    const importedView = graph
      .importBuffer(
        'view',
        { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM },
        () => view,
      )
      .unwrap();
    const projected = addDepthPyramidPasses(graph, {
      depth: depthSample,
      view: importedView,
      width: WIDTH,
      height: HEIGHT,
      reduction: 'furthest',
      multisampled: true,
    }).unwrap();
    const mip0 = projected.pyramid.plan.levels[0];
    const mip0View = projected.pyramid.levels[0];
    if (mip0 === undefined || mip0View === undefined)
      throw new Error('depth pyramid has no level 0');
    graph
      .addCopyPass('pyramid-readback', {
        accesses: [{ resource: mip0View, usage: 'copy-src' }],
        encode: ({ encoder, resources }) => {
          encoder.copyTextureToBuffer(
            { texture: resources.texture(projected.pyramid.texture).unwrap(), mipLevel: 0 },
            { buffer: readback, offset: 0, bytesPerRow: 256, rowsPerImage: mip0.height },
            { width: mip0.width, height: mip0.height, depthOrArrayLayers: 1 },
          );
        },
      })
      .unwrap();
    const compiled = graph
      .compile({ device, surfaceSize: { width: WIDTH, height: HEIGHT } })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    compiled
      .execute({
        encoder,
        runtime: {
          device,
          shaderModuleFactory: {
            createShaderModule: (descriptor: { readonly code: string; readonly label?: string }) =>
              createShaderModuleImmediate(device, descriptor),
          },
        },
        depthPyramidShaders: { seed, reduce },
        bindGroupCounts: { createBindGroup: 0, keys: [] },
      } as Frame)
      .unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const words = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    await compiled.retire();

    expect(mip0).toMatchObject({ width: WIDTH / 2, height: HEIGHT / 2 });
    for (let y = 0; y < mip0.height; y += 1) {
      for (let x = 0; x < mip0.width; x += 1) {
        const texel = words[y * 64 + x] ?? Number.NaN;
        if (x < mip0.width / 2) expect(texel, `texel ${x},${y}`).toBeCloseTo(WALL_DISTANCE, 4);
        else expect(texel, `texel ${x},${y}`).toBeGreaterThanOrEqual(EMPTY_DEPTH);
      }
    }
  } finally {
    device.destroyTexture(depth).unwrap();
    device.destroyBuffer(view).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
