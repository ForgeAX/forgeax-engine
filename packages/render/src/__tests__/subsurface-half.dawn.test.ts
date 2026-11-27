import { readFileSync } from 'node:fs';
import { halfFloat } from '@forgeax/engine-math';
import { type GraphBuffer, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { scenePipelinePreparations } from '../record/scene-pipeline-preparation';
import type { RenderPipelineFrame } from '../render-pipeline';
import { subsurfaceTopology } from '../subsurface/demand';
import { addSubsurfaceDiffusion } from '../subsurface/graph';
import { nativeDeviceFixture } from './native-device-fixture';

const SIZE = { width: 35, height: 67, depthOrArrayLayers: 1 };
const ROW_BYTES = 512;

it.each([
  false,
  true,
])('executes the native half-resolution graph and preserves mixed cells, emission and empty work (Default GBuffer %s)', async (compact) => {
  const readShader = (name: string) =>
    readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = await compileShader(readShader('subsurface-diffusion'), {
    id: 'forgeax_standard::subsurface_diffusion',
    imports: { 'forgeax_pbr::gbuffer': readShader('standard-gbuffer') },
  });
  if (!compiled.ok) throw compiled.error;
  const { device, native } = await nativeDeviceFixture();
  expect(
    subsurfaceTopology([1], { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' }, device, false),
  ).toEqual({ quality: 'high' });
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const graphBuffers = new Map<string, GraphBuffer>();
  const createBuffer = graph.createBuffer.bind(graph);
  vi.spyOn(graph, 'createBuffer').mockImplementation((label, descriptor) => {
    const buffer = createBuffer(label, descriptor);
    if (buffer.ok) graphBuffers.set(label, buffer.value);
    return buffer;
  });
  const target = (label: string, format: GPUTextureFormat, usage: number) => {
    const texture = device.createTexture({ label, size: SIZE, format, usage }).unwrap();
    const resource = graph
      .importTexture(label, { size: SIZE, format, usage }, () => texture)
      .unwrap();
    return {
      texture,
      target: {
        texture: resource,
        view: graph.view(resource, {}).unwrap(),
        format,
        sampleCount: 1 as const,
      },
    };
  };
  const scene = target(
    'scene',
    'rgba16float',
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  );
  const sampled = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const diffuse = target('diffuse', 'rgba16float', sampled);
  const profileFormat = compact ? 'r32uint' : 'rg32uint';
  const profiles = target('profiles', profileFormat, sampled);
  const normal = target('normal', profileFormat, sampled);
  const depth = target(
    'depth',
    'depth32float',
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  );
  addSubsurfaceDiffusion(graph, {
    scene: scene.target,
    diffuse: diffuse.target,
    profiles: profiles.target.view,
    normal: normal.target.view,
    depth: depth.target.view,
    size: SIZE,
    scale: [1, 1],
    quality: 'high',
    ...(compact ? { compact: true } : {}),
  }).unwrap();
  const argumentsResource = graphBuffers.get('subsurface-indirect');
  if (argumentsResource === undefined) throw new Error('Subsurface commands were not declared');
  const commandRead = device
    .createBuffer({ size: 40, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    .unwrap();
  const colorRead = device
    .createBuffer({
      size: ROW_BYTES * SIZE.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    .unwrap();
  const readArgs = graph
    .importBuffer(
      'read-commands',
      { size: 40, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ },
      () => commandRead,
    )
    .unwrap();
  graph
    .addCopyPass('read-submitted-commands', {
      accesses: [
        { resource: argumentsResource, usage: 'copy-src' },
        { resource: readArgs, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _frame, resources) => {
        encoder.copyBufferToBuffer(
          resources.buffer(argumentsResource).unwrap(),
          0,
          resources.buffer(readArgs).unwrap(),
          0,
          40,
        );
      },
    })
    .unwrap();
  const execution = graph.compile({ device, surfaceSize: SIZE }).unwrap();
  const normalPayload = new Uint32Array((ROW_BYTES * SIZE.height) / 4);
  const profilePayload = new Uint32Array(normalPayload.length);
  const diffusePayload = new Float32Array((ROW_BYTES * SIZE.height) / 2);
  const profileStride = compact ? 1 : 2;
  const rowWords = ROW_BYTES / 4;
  for (let y = 0; y < SIZE.height; y++) {
    for (let x = 0; x < SIZE.width; x++) {
      const offset = y * rowWords + x * profileStride;
      normalPayload[offset] = (compact ? 0 : 0x40000000) | (1023 << 20) | (512 << 10) | 512;
    }
  }
  const write = (texture: typeof scene.texture, bytes: Uint32Array | Uint8Array) => {
    device.queue
      .writeTexture(
        { texture, mipLevel: 0, origin: [0, 0, 0] },
        bytes,
        { offset: 0, bytesPerRow: ROW_BYTES, rowsPerImage: SIZE.height },
        SIZE,
      )
      .unwrap();
  };
  write(normal.texture, normalPayload);
  const seed = createShaderModuleImmediate(device, {
    code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(select(-1.0, 3.0, i == 1u), select(-1.0, 3.0, i == 2u), 0.0, 1.0);
}
@fragment fn fs() -> @builtin(frag_depth) f32 { return 0.8; }
`,
  }).unwrap();
  const depthEdge = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: { module: seed, entryPoint: 'vs', buffers: [] },
      fragment: { module: seed, entryPoint: 'fs', targets: [] },
      depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true },
    })
    .unwrap();
  const compileDiffusion = vi.fn(createShaderModule);
  const shaderModuleFactory = makeShaderDeviceAdapter(
    device,
    { fire: vi.fn() } as never,
    compileDiffusion,
    undefined,
  );
  const commands = {
    runtime: {
      device,
      standardSceneShaders: { subsurface: compiled.value.wgsl },
      shaderModuleFactory,
    },
    camera: { near: 0.1, far: 30, projection: 'orthographic' },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {
      pipelinePreparationPending: false,
      ...(compact ? { compactSubsurfaceProfiles: [255, 65535, 65280] } : {}),
    },
  };
  const render = async (active: boolean, neighborEnergy: number) => {
    profilePayload.fill(0);
    diffusePayload.fill(0);
    if (active) {
      for (let y = 2; y < 38; y++) {
        for (let x = 0; x < 20; x++) {
          profilePayload[y * rowWords + x * profileStride + (profileStride - 1)] =
            ((x === 9 ? 128 : 255) << 24) | (x < 16 ? (compact ? 1 : 255) : compact ? 2 : 65535);
          const offset = y * (ROW_BYTES / 2) + x * 4;
          diffusePayload.set([x < 8 ? 4 : x >= 16 ? neighborEnergy : 0, x % 2, 0, 0], offset);
        }
      }
      const mixed = 18 * rowWords + 24 * profileStride + profileStride - 1;
      profilePayload[mixed] = compact ? 0xff000001 : 0xff0000ff;
      profilePayload[mixed + profileStride] = compact ? 0xff000003 : 0xff00ff00;
      const mixedColors = 18 * (ROW_BYTES / 2) + 24 * 4;
      diffusePayload.set([1, 0.25, 0, 0, 7, 0.5, 0, 0], mixedColors);
    }
    write(profiles.texture, profilePayload);
    write(diffuse.texture, halfFloat.f32ToF16Bytes(new Uint8Array(diffusePayload.buffer)));
    const encoder = device.createCommandEncoder().unwrap();
    const clear = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(scene.texture, {}).unwrap(),
          clearValue: { r: 0.125, g: 0.5, b: 8000, a: 0.75 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: device.createTextureView(depth.texture, {}).unwrap(),
        depthLoadOp: 'clear',
        depthClearValue: 0.5,
        depthStoreOp: 'store',
      },
    });
    clear.end();
    const edge = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: device.createTextureView(depth.texture, {}).unwrap(),
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    edge.setPipeline(depthEdge);
    edge.setScissorRect(8, 33, 1, 1);
    edge.draw(3);
    edge.end();
    execution.execute({ ...commands, encoder } as unknown as RenderPipelineFrame).unwrap();
    encoder.copyTextureToBuffer(
      { texture: scene.texture, mipLevel: 0, origin: [0, 0, 0] },
      { buffer: colorRead, offset: 0, bytesPerRow: ROW_BYTES, rowsPerImage: SIZE.height },
      SIZE,
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await colorRead.mapAsync(GPUMapMode.READ)).unwrap();
    const pixels = new Uint16Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const mappedCommands = (await commandRead.mapAsync(GPUMapMode.READ)).unwrap();
    const indirect = [...new Uint32Array(mappedCommands.getMappedRange().unwrap())];
    mappedCommands.unmap();
    const pixel = (x: number, y: number) => {
      const offset = y * (ROW_BYTES / 2) + x * 4;
      return Array.from(pixels.subarray(offset, offset + 4), halfFloat.f16ToF32);
    };
    return { indirect, pixel };
  };
  native.pushErrorScope('validation');
  let validation: GPUError | null;
  try {
    const prepare = scenePipelinePreparations(graph)[0];
    if (prepare === undefined) throw new Error('Missing subsurface preparation');
    const prepareFrame = () =>
      prepare(commands as unknown as _InternalRenderPipelineContext, new Map());
    expect(compileDiffusion).not.toHaveBeenCalled();
    expect(prepare.kind).toBe('utility');
    prepareFrame();
    prepareFrame();
    expect(commands.frameState.pipelinePreparationPending).toBe(true);
    expect(compileDiffusion).toHaveBeenCalledOnce();
    await shaderModuleFactory.pendingCompletion();
    commands.frameState.pipelinePreparationPending = false;
    prepareFrame();
    expect(commands.frameState.pipelinePreparationPending).toBe(false);
    const first = await render(true, 0);
    const brighterNeighbor = await render(true, 16);
    const empty = await render(false, 0);
    expect(first.indirect.slice(6)).toEqual([3, 1, 0, 0]);
    expect(first.indirect[0]).toBeGreaterThan(0);
    expect(first.indirect[3]).toBeGreaterThan(0);
    expect(first.indirect[0]).toBeGreaterThanOrEqual(first.indirect[3] ?? 0);
    expect(empty.indirect).toEqual(Array(10).fill(0));
    expect(first.pixel(8, 16)[0]).toBeGreaterThan(0.2);
    expect(first.pixel(7, 15)[0]).toBeLessThan(4);
    expect(first.pixel(9, 16)[0]).toBeGreaterThan(0.125);
    expect(first.pixel(9, 16)[0]).toBeLessThan(first.pixel(8, 16)[0] ?? 0);
    expect(brighterNeighbor.pixel(15, 15)).toEqual(first.pixel(15, 15));
    expect(first.pixel(24, 18)).toEqual([1.125, 0.75, 8000, 0.75]);
    expect(first.pixel(25, 18)).toEqual([7.125, 1, 8000, 0.75]);
    expect(first.pixel(34, 66)).toEqual([0.125, 0.5, 8000, 0.75]);
    expect(first.pixel(8, 33)).toEqual([0.125, 0.5, 8000, 0.75]);
    expect(empty.pixel(8, 16)).toEqual([0.125, 0.5, 8000, 0.75]);
    for (let y = 2; y < 38; y++) {
      expect(first.pixel(6, y).slice(2)).toEqual([8000, 0.75]);
      expect(first.pixel(8, y)[1]).toBe(0.5);
      expect(first.pixel(9, y)[1]).toBe(1.5);
    }
    expect(compileDiffusion).toHaveBeenCalledOnce();
  } finally {
    validation = await native.popErrorScope();
    shaderModuleFactory.dispose();
    (await execution.retire()).unwrap();
    native.destroy();
  }
  expect(validation?.message).toBeUndefined();
}, 30000);
