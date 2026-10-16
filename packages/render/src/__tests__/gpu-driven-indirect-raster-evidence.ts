import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

/**
 * This fixture deliberately exercises only the generic GPU view owner. The
 * production Standard PBR shader is producer-owned and is covered by the
 * renderer integration tests; this small shader makes indirect command and
 * raster submission observable without reintroducing a second material or
 * legacy GPU-driven raster owner.
 */
const INDIRECT_RASTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> view: mat4x4<f32>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec4<f32>, 3>(
    vec4<f32>(-1.0, -1.0, 0.0, 1.0),
    vec4<f32>(3.0, -1.0, 0.0, 1.0),
    vec4<f32>(-1.0, 3.0, 0.0, 1.0),
  );
  var output: VertexOutput;
  output.position = view * positions[index % 3u];
  return output;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.25, 0.5, 0.75, 1.0);
}
`;

function snapshot(entityKey: number, kind: 'indexed' | 'non-indexed'): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  const material = {
    baseColor: new Float32Array([0.25, 0.5, 0.75]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'fixture::indirect-raster',
  } as MaterialSnapshot;
  return {
    assetHandle: entityKey,
    transform: { world: new Float32Array(world) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind,
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'fixture::indirect-raster|triangle-list|null',
        materialResourceClass: 'fixture',
      },
    ],
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

function camera(): CameraSnapshot {
  const world = mat4.identity(mat4.create());
  return {
    position: vec3.create(0, 0, 0),
    world: new Float32Array(world),
    fov: Math.PI / 2,
    aspect: 1,
    near: 0.1,
    far: 10,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSoftKnee: 0.5,
    bloomScatter: 0.7,
    clearColor: [0, 0, 0, 0],
  };
}

function viewPlanes(snapshot: CameraSnapshot): Float32Array {
  const projection = mat4.perspective(
    mat4.create(),
    snapshot.fov,
    snapshot.aspect,
    snapshot.near,
    snapshot.far,
  );
  return frustum.fromViewProjection(
    frustum.create(),
    mat4.multiply(mat4.create(), projection, mat4.invert(mat4.create(), snapshot.world)),
  );
}

export interface GpuDrivenIndirectRasterEvidence {
  readonly pixel: readonly number[];
  readonly passNames: readonly string[];
}

export const GPU_DRIVEN_PRODUCTION_VIEW_BGL_ENTRIES = [
  { binding: 0, visibility: 0x1, buffer: { type: 'uniform', hasDynamicOffset: true } },
  {
    binding: 10,
    visibility: 0x1,
    buffer: { type: 'uniform', hasDynamicOffset: true },
  },
] as const satisfies readonly GPUBindGroupLayoutEntry[];

export async function runGpuDrivenIndirectRasterEvidence(): Promise<GpuDrivenIndirectRasterEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const viewShader = (
    await createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL, label: 'gpu-driven-view' })
  ).unwrap();
  const rasterShader = (
    await createShaderModule(device, {
      code: INDIRECT_RASTER_WGSL,
      label: 'gpu-driven-indirect-raster-fixture',
    })
  ).unwrap();

  const viewLayout = device
    .createBindGroupLayout({
      label: 'gpu-driven-production-view-bgl',
      entries: [...GPU_DRIVEN_PRODUCTION_VIEW_BGL_ENTRIES],
    })
    .unwrap();
  const rasterPipelineLayout = device
    .createPipelineLayout({
      label: 'gpu-driven-indirect-raster-fixture-pl',
      bindGroupLayouts: [viewLayout],
    })
    .unwrap();
  const rasterPipeline = device
    .createRenderPipeline({
      label: 'gpu-driven-indirect-raster-fixture',
      layout: rasterPipelineLayout,
      vertex: { module: rasterShader, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: rasterShader,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();

  const viewUniform = device
    .createBuffer({
      label: 'gpu-driven-production-view',
      size: 64,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const identity = mat4.identity(mat4.create());
  device.queue.writeBuffer(viewUniform, 0, identity).unwrap();
  const viewBindGroup = device
    .createBindGroup({
      label: 'gpu-driven-production-view-bg',
      layout: viewLayout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform } } },
        { binding: 10, resource: { kind: 'buffer', value: { buffer: viewUniform } } },
      ],
    })
    .unwrap();

  const indexBuffer = device
    .createBuffer({
      label: 'gpu-driven-production-indices',
      size: 12,
      usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  device.queue.writeBuffer(indexBuffer, 0, new Uint16Array([0, 1, 2, 0, 1, 2])).unwrap();

  const indexed = snapshot(1, 'indexed');
  const indexedDraw = indexed.gpuDrivenDraws?.[0];
  const nonIndexed = snapshot(2, 'non-indexed');
  const nonIndexedDraw = nonIndexed.gpuDrivenDraws?.[0];
  if (indexedDraw === undefined || nonIndexedDraw === undefined) {
    throw new Error('GPU-driven draw fixture unavailable');
  }
  const renderables = [
    {
      ...indexed,
      gpuDrivenDraws: [indexedDraw, { ...indexedDraw, first: 3 }],
    },
    { ...nonIndexed, gpuDrivenDraws: [nonIndexedDraw] },
  ];
  const projection = new RenderScene();
  const delta = projection.apply(renderables.map((renderable) => updateSnapshot(renderable)));
  const availability = GpuScene.create(device, 2).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const plan = topology.plan();
  const gpuView = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(viewShader) },
  }).unwrap();
  gpuView.update(plan, availability.scene, viewPlanes(camera())).unwrap();

  const readbackBuffer = device
    .createBuffer({
      label: 'gpu-driven-production-readback',
      size: 256,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = gpuView.addPasses(graph).unwrap();
  const output = graph
    .createTexture('gpu-driven-production-output', {
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
    })
    .unwrap();
  const outputView = graph.view(output).unwrap();
  const readback = graph
    .importBuffer(
      'gpu-driven-production-readback',
      { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
      () => readbackBuffer,
    )
    .unwrap();

  graph
    .addRasterPass('gpu-driven.opaque-indirect', {
      accesses: [
        { resource: gpu.indirect, usage: 'indirect-read' },
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
        pass.setPipeline(rasterPipeline);
        pass.setBindGroup(0, viewBindGroup, [0, 0]);
        const indirect = resources.buffer(gpu.indirect).unwrap();
        pass.setIndexBuffer(indexBuffer, 'uint16');
        for (const [batchIndex, batch] of plan.batches.entries()) {
          if (batch.key.drawKind === 'indexed') {
            pass.drawIndexedIndirect(indirect, batchIndex * 20);
          } else {
            pass.drawIndirect(indirect, batchIndex * 20);
          }
        }
      },
    })
    .unwrap();
  graph
    .addCopyPass('gpu-driven.raster-readback', {
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
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();

  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-production-frame' }).unwrap();
  compiled.execute({ encoder } as unknown as RenderPipelineFrame).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
  const pixel = [...new Uint8Array(mapped.getMappedRange().unwrap().slice(0, 4))];
  mapped.unmap();
  const passNames = compiled.inspect().passes.map((pass) => pass.name);

  (await compiled.retire()).unwrap();
  gpuView.dispose();
  availability.scene.dispose();
  for (const buffer of [indexBuffer, viewUniform, readbackBuffer]) {
    device.destroyBuffer(buffer);
  }
  return { pixel, passNames };
}
