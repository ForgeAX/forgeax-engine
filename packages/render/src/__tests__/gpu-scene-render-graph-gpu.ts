import { type CompiledRenderGraphInfo, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Buffer, RenderPipeline, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS, GPU_SCENE_WGSL } from '../gpu-scene-schema';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const BUFFER_USAGE_STORAGE = 0x0080;
const COMPUTE_VISIBILITY = 0x4;
const VERTEX_VISIBILITY = 0x1;

const CULL_WGSL = /* wgsl */ `
${GPU_SCENE_WGSL}

@group(0) @binding(0) var<storage, read> primitives: array<GpuScenePrimitive>;
@group(0) @binding(1) var<storage, read> transforms: array<GpuSceneTransform>;
@group(0) @binding(2) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> drawArgs: array<atomic<u32>>;

@compute @workgroup_size(4)
fn cull(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(global_invocation_id) globalId: vec3<u32>,
) {
  if (localId.x == 0u) {
    atomicStore(&drawArgs[0], 3u);
    atomicStore(&drawArgs[1], 0u);
    atomicStore(&drawArgs[2], 0u);
    atomicStore(&drawArgs[3], 0u);
  }
  storageBarrier();
  workgroupBarrier();

  let index = globalId.x;
  let primitive = primitives[index];
  let translationX = transforms[primitive.transformIndex].currentWorld[3].x;
  if ((primitive.flags & 1u) != 0u && abs(translationX) <= 1.0) {
    let compacted = atomicAdd(&drawArgs[1], 1u);
    visibleIndices[compacted] = index;
  }
}
`;

const RASTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> visibleIndices: array<u32>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let halfOffset = select(-0.5, 0.5, instance == 1u);
  let projected = vec2<f32>(positions[vertex].x * 0.5 + halfOffset, positions[vertex].y);
  let compactedIndex = visibleIndices[instance];
  var output: VertexOutput;
  output.position = vec4<f32>(projected, 0.0, 1.0);
  output.color = vec4<f32>(f32((compactedIndex + 1u) * 64u) / 255.0, 1.0, 0.0, 1.0);
  return output;
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

const material = {
  baseColor: new Float32Array([1, 1, 1]),
  metallic: 0,
  roughness: 1,
  materialHandle: 1,
} as MaterialSnapshot;

function snapshot(entityKey: number, translationX: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 100 + entityKey,
    transform: { world },
    localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function bufferBinding(buffer: Buffer) {
  return { kind: 'buffer' as const, value: { buffer } };
}

export interface GpuSceneGraphEvidence {
  readonly graph: CompiledRenderGraphInfo;
  readonly pixels: readonly number[];
}

export async function runGpuSceneGraph(): Promise<GpuSceneGraphEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (!device.caps.compute || !device.caps.storageBuffer || !device.caps.indirectDrawing) {
    throw new Error(`required GPU Scene capabilities unavailable: ${JSON.stringify(device.caps)}`);
  }
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw new Error(availability.reason);
  const scene = availability.scene;
  const projection = new RenderScene();
  scene
    .sync(
      projection.apply([
        updateSnapshot(snapshot(10, -3)),
        updateSnapshot(snapshot(11, -0.5)),
        updateSnapshot(snapshot(12, 0.5)),
        updateSnapshot(snapshot(13, 3)),
      ]),
    )
    .unwrap();

  const cullModule = (await createShaderModule(device, { code: CULL_WGSL })).unwrap();
  const cullLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE_VISIBILITY, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: COMPUTE_VISIBILITY, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
        { binding: 3, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
      ],
    })
    .unwrap();
  const cullPipelineLayout = device
    .createPipelineLayout({ bindGroupLayouts: [cullLayout] })
    .unwrap();
  const cullPipeline = device
    .createComputePipeline({
      layout: cullPipelineLayout,
      compute: { module: cullModule, entryPoint: 'cull' },
    })
    .unwrap();
  const rasterModule = (await createShaderModule(device, { code: RASTER_WGSL })).unwrap();
  const rasterLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VERTEX_VISIBILITY, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const rasterPipelineLayout = device
    .createPipelineLayout({ bindGroupLayouts: [rasterLayout] })
    .unwrap();
  const rasterPipeline: RenderPipeline = device
    .createRenderPipeline({
      layout: rasterPipelineLayout as never,
      vertex: { module: rasterModule as never, entryPoint: 'vs', buffers: [] },
      fragment: {
        module: rasterModule as never,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const readbackBuffer = device
    .createBuffer({
      label: 'gpu-scene-graph-readback',
      size: 256,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  const capacity = scene.inspect().capacity;
  const sceneUsage = BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | 0x0004;
  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const primitives = graph
    .importBuffer(
      'gpu-scene-primitives',
      { size: capacity * GPU_SCENE_LAYOUTS.primitive.stride, usage: sceneUsage },
      () => scene.primitiveBuffer,
    )
    .unwrap();
  const transforms = graph
    .importBuffer(
      'gpu-scene-transforms',
      { size: capacity * GPU_SCENE_LAYOUTS.transform.stride, usage: sceneUsage },
      () => scene.transformBuffer,
    )
    .unwrap();
  const visibleIndices = graph.createBuffer('gpu-scene-visible-indices', { size: 16 }).unwrap();
  const drawArgs = graph.createBuffer('gpu-scene-draw-args', { size: 16 }).unwrap();
  const output = graph
    .createTexture('gpu-scene-output', {
      format: 'rgba8unorm',
      size: { width: 2, height: 1 },
    })
    .unwrap();
  const outputView = graph.view(output, { label: 'gpu-scene-output.view' }).unwrap();
  const readback = graph
    .importBuffer(
      'gpu-scene-readback',
      { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
      () => readbackBuffer,
    )
    .unwrap();

  graph
    .addComputePass('gpu-scene-cull-compact-args', {
      accesses: [
        { resource: primitives, usage: 'storage-read' },
        { resource: transforms, usage: 'storage-read' },
        { resource: visibleIndices, usage: 'storage-write' },
        { resource: drawArgs, usage: 'storage-write' },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: cullLayout,
            entries: [
              { binding: 0, resource: bufferBinding(resources.buffer(primitives).unwrap()) },
              { binding: 1, resource: bufferBinding(resources.buffer(transforms).unwrap()) },
              { binding: 2, resource: bufferBinding(resources.buffer(visibleIndices).unwrap()) },
              { binding: 3, resource: bufferBinding(resources.buffer(drawArgs).unwrap()) },
            ],
          })
          .unwrap();
        pass.setPipeline(cullPipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1);
      },
    })
    .unwrap();
  graph
    .addRasterPass('gpu-scene-indirect-raster', {
      accesses: [
        { resource: visibleIndices, usage: 'storage-read' },
        { resource: drawArgs, usage: 'indirect-read' },
        { resource: outputView, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: outputView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: rasterLayout,
            entries: [
              {
                binding: 0,
                resource: bufferBinding(resources.buffer(visibleIndices).unwrap()),
              },
            ],
          })
          .unwrap();
        pass.setPipeline(rasterPipeline);
        pass.setBindGroup(0, bindings);
        pass.drawIndirect(resources.buffer(drawArgs).unwrap(), 0);
      },
    })
    .unwrap();
  graph
    .addCopyPass('gpu-scene-readback', {
      accesses: [
        { resource: outputView, usage: 'copy-src' },
        { resource: readback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        encoder.copyTextureToBuffer(
          { texture: resources.texture(output).unwrap() as unknown as GPUTexture },
          {
            buffer: resources.buffer(readback).unwrap() as unknown as GPUBuffer,
            bytesPerRow: 256,
            rowsPerImage: 1,
          },
          { width: 2, height: 1, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();

  const compiled = graph.compile({ device, surfaceSize: { width: 2, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-scene-graph-frame' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
  const range = mapped.getMappedRange().unwrap();
  const pixels = [...new Uint8Array(range.slice(0, 8))];
  mapped.unmap();
  const inspected = compiled.inspect();
  (await compiled.retire()).unwrap();
  scene.dispose();
  device.destroyBuffer(readbackBuffer).unwrap();
  return { graph: inspected, pixels };
}
