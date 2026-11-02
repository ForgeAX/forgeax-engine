import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice, Texture, TextureFormat } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import {
  createFullscreenPassResources,
  emptyFullscreenPassResources,
} from '../assembly/webgpu-ready-passes';
import { emptyEngineShaderModules } from '../assembly/webgpu-ready-shaders';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { _InternalRenderPipelineContext, PerPassResources } from '../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { addTypedSsaoPasses } from '../typed-render-graph-primitives';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) {
    if (result.error instanceof Error) throw result.error;
    throw new Error(`Unexpected Result failure: ${String(result.error)}`);
  }
  return result.value;
}

function importedTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  texture: Texture,
  format: TextureFormat,
  width: number,
  height: number,
  usage: number,
): RenderPipelineTarget {
  const handle = value(
    graph.importTexture(label, { format, size: { width, height }, usage }, () => texture),
  );
  const graphView = value(graph.view(handle));
  return { texture: handle, view: graphView, format, sampleCount: 1 };
}

function createTexture(
  device: RhiDevice,
  label: string,
  format: TextureFormat,
  width: number,
  height: number,
  usage: number,
): Texture {
  return value(
    device.createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      dimension: '2d',
      format,
      usage,
      mipLevelCount: 1,
      sampleCount: 1,
    }),
  );
}

async function compiledModule(device: RhiDevice, source: string, options: Record<string, unknown>) {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const result = await compiler.compileShader(source, options as never);
  if (!result.ok) throw result.error;
  return value(await createShaderModule(device, { code: result.value.wgsl }));
}

async function rendererReadyPasses(device: RhiDevice) {
  const gbuffer = readFileSync(resolve('packages/shader/src/standard-gbuffer.wgsl'), 'utf8');
  const common = readFileSync(resolve('packages/shader/src/common.wgsl'), 'utf8');
  const ssao = await compiledModule(
    device,
    readFileSync(resolve('packages/shader/src/hdrp-ssao.wgsl'), 'utf8'),
    {
      id: 'forgeax_hdrp::ssao',
      imports: { 'forgeax_pbr::gbuffer': gbuffer, 'forgeax_view::common': common },
    },
  );
  const gtaoCompute = await compiledModule(
    device,
    readFileSync(resolve('packages/shader/src/hdrp-gtao-compute.wgsl'), 'utf8'),
    {
      id: 'forgeax_hdrp::gtao_compute',
      computeEntry: 'cs_gtao_calc',
      imports: {
        'forgeax_hdrp::ssao': readFileSync(resolve('packages/shader/src/hdrp-ssao.wgsl'), 'utf8'),
        'forgeax_pbr::gbuffer': gbuffer,
        'forgeax_view::common': common,
      },
    },
  );
  const empty = emptyEngineShaderModules();
  const modules = { ...empty, ssao, gtaoCompute };
  const provider = {
    createRenderPipeline: (descriptor: Record<string, unknown>) =>
      device.createRenderPipeline(descriptor as never),
  };
  return createFullscreenPassResources(
    device,
    provider,
    new Map(),
    modules,
    'rgba8unorm',
    (descriptor) => device.createBuffer(descriptor),
  );
}

async function seedMaterialNormalsAndDepth(
  device: RhiDevice,
  normal: Texture,
  depth: Texture,
  _width: number,
  _height: number,
) {
  const gbuffer = readFileSync(
    resolve('packages/shader/src/standard-gbuffer.wgsl'),
    'utf8',
  ).replace(/^#define_import_path[^\n]*\n/m, '');
  const module = value(
    await createShaderModule(device, {
      code: `${gbuffer}
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return Out(vec4f(p[i],0,1), p[i]*vec2f(0.5,-0.5)+0.5);
}
struct Fragment { @builtin(frag_depth) depth: f32, @location(0) normal: u32 };
@fragment fn fs(in: Out) -> Fragment {
  let rayY = (1.0-2.0*in.uv.y)*0.577350269;
  let distance = select(4.0, 3.75, in.uv.x > 0.5);
  return Fragment((10.0/distance-0.1)/99.9, encodeStandardNormalRoughness(vec3f(0,0,1), 1));
}`,
      label: 'gtao-graph-material-normal-seed',
    }),
  );
  const pipeline = value(
    device.createRenderPipeline({
      label: 'gtao-graph-material-normal-seed',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: [] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'always',
      },
    }),
  );
  const normalView = value(device.createTextureView(normal, {}));
  const depthView = value(
    device.createTextureView(depth, {
      aspect: 'depth-only',
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    }),
  );
  const encoder = value(device.createCommandEncoder());
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: normalView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    depthStencilAttachment: {
      view: depthView,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
  });
  pass.setPipeline(pipeline);
  pass.draw(3, 1, 0, 0);
  pass.end();
  value(device.queue.submit([value(encoder.finish())]));
  await device.queue.onSubmittedWorkDone();
  return undefined;
}

async function runGraph(
  device: RhiDevice,
  execution: 'fragment' | 'compute',
  inputs: { normal: Texture; depth: Texture },
  resources: Awaited<ReturnType<typeof rendererReadyPasses>>,
  size: { width: number; height: number },
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const normal = importedTarget(
    graph,
    'gtao-graph-material-normal',
    inputs.normal,
    'r32uint',
    size.width,
    size.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  const depth = importedTarget(
    graph,
    'gtao-graph-depth',
    inputs.depth,
    'depth32float',
    size.width,
    size.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  const aoSize = { width: Math.ceil(size.width / 2), height: Math.ceil(size.height / 2) };
  const rawTexture = createTexture(
    device,
    `gtao-graph-${execution}-raw`,
    'rgba8unorm',
    aoSize.width,
    aoSize.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_STORAGE_BINDING |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_SRC,
  );
  const blurredTexture = createTexture(
    device,
    `gtao-graph-${execution}-blurred`,
    'r8unorm',
    aoSize.width,
    aoSize.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_SRC,
  );
  const raw = importedTarget(
    graph,
    `gtao-graph-${execution}-raw`,
    rawTexture,
    'rgba8unorm',
    aoSize.width,
    aoSize.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_STORAGE_BINDING |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_SRC,
  );
  const blurred = importedTarget(
    graph,
    `gtao-graph-${execution}-blurred`,
    blurredTexture,
    'r8unorm',
    aoSize.width,
    aoSize.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_SRC,
  );
  const added = addTypedSsaoPasses(graph, { normal, depth, raw, blurred, execution });
  if (!added.ok) throw added.error;
  const compiled = value(graph.compile({ device, surfaceSize: size }));
  const perPassResources = {
    ...emptyFullscreenPassResources(),
    ...resources,
    ssaoFilteringSampler: null,
    ssaoDepthSampler: null,
    ssaoFallbackRawView: null,
  } as unknown as PerPassResources;
  const errorRegistry = new RhiErrorListenerRegistry();
  const frameState = {
    installedPipelineConfig: { ssao: { enabled: true, algorithm: 'gtao', quality: 'medium' } },
    postProcessBgCache: new WeakMap<object, unknown>(),
  };
  const runtime = { device, errorRegistry };
  const pipelineState = { perPassResources };
  const frame = {
    encoder: value(device.createCommandEncoder()),
    runtime,
    pipelineState,
    frameState,
    camera: makeZeroCameraFallbackSnapshot(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as _InternalRenderPipelineContext;
  try {
    const executionResult = compiled.execute(frame);
    if (!executionResult.ok) throw executionResult.error;
    value(device.queue.submit([value(frame.encoder.finish())]));
    await device.queue.onSubmittedWorkDone();
    const capture = async (texture: Texture, format: TextureFormat, bytesPerTexel: number) => {
      const bytesPerRow = Math.ceil((aoSize.width * bytesPerTexel) / 256) * 256;
      const buffer = value(
        device.createBuffer({
          label: `gtao-graph-${execution}-${format}-readback`,
          size: bytesPerRow * aoSize.height,
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
          mappedAtCreation: false,
        }),
      );
      const encoder = value(device.createCommandEncoder());
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow, rowsPerImage: aoSize.height },
        { width: aoSize.width, height: aoSize.height, depthOrArrayLayers: 1 },
      );
      value(device.queue.submit([value(encoder.finish())]));
      await device.queue.onSubmittedWorkDone();
      const mapped = value(await buffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ));
      const bytes = new Uint8Array(value(mapped.getMappedRange()).slice(0));
      mapped.unmap();
      value(device.destroyBuffer(buffer));
      return { bytes, bytesPerRow, bytesPerTexel };
    };
    const rawBytes = await capture(rawTexture, 'rgba8unorm', 4);
    const blurredBytes = await capture(blurredTexture, 'r8unorm', 1);
    return {
      passes: compiled.inspect().passes.map((pass) => ({ name: pass.name, kind: pass.kind })),
      raw: rawBytes,
      blurred: blurredBytes,
      width: aoSize.width,
      height: aoSize.height,
    };
  } finally {
    await compiled.retire();
  }
}

it('executes the prepared GTAO compute and fragment entries through the production typed graph', async () => {
  const adapter = value(await rhi.requestAdapter());
  const device = value(await adapter.requestDevice());
  const size = { width: 128, height: 128 };
  const normal = createTexture(
    device,
    'gtao-graph-material-normal',
    'r32uint',
    size.width,
    size.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  const depth = createTexture(
    device,
    'gtao-graph-depth',
    'depth32float',
    size.width,
    size.height,
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  );
  await seedMaterialNormalsAndDepth(device, normal, depth, size.width, size.height);
  const inputs = { normal, depth };
  const resources = await rendererReadyPasses(device);
  const compute = await runGraph(device, 'compute', inputs, resources, size);
  const fragment = await runGraph(device, 'fragment', inputs, resources, size);
  expect(compute.passes).toEqual([
    { name: 'gtao-calc-compute', kind: 'compute' },
    { name: 'ssao-blur', kind: 'raster' },
  ]);
  expect(fragment.passes).toEqual([
    { name: 'ssao-calc', kind: 'raster' },
    { name: 'ssao-blur', kind: 'raster' },
  ]);
  let rawMaxDelta = 0;
  let blurredMaxDelta = 0;
  let visibleRawTexels = 0;
  for (let y = 0; y < compute.height; y += 1) {
    for (let x = 0; x < compute.width; x += 1) {
      const rawOffset = y * compute.raw.bytesPerRow + x * 4;
      const fragmentRawOffset = y * fragment.raw.bytesPerRow + x * 4;
      const computeVisibility = compute.raw.bytes[rawOffset] ?? 0;
      const fragmentVisibility = fragment.raw.bytes[fragmentRawOffset] ?? 0;
      rawMaxDelta = Math.max(rawMaxDelta, Math.abs(computeVisibility - fragmentVisibility));
      if (computeVisibility < 253) visibleRawTexels += 1;
      const blurredOffset = y * compute.blurred.bytesPerRow + x;
      const fragmentBlurredOffset = y * fragment.blurred.bytesPerRow + x;
      blurredMaxDelta = Math.max(
        blurredMaxDelta,
        Math.abs(
          (compute.blurred.bytes[blurredOffset] ?? 0) -
            (fragment.blurred.bytes[fragmentBlurredOffset] ?? 0),
        ),
      );
    }
  }
  expect(rawMaxDelta).toBeLessThanOrEqual(1);
  expect(blurredMaxDelta).toBeLessThanOrEqual(1);
  expect(visibleRawTexels).toBeGreaterThan(0);
}, 60_000);
