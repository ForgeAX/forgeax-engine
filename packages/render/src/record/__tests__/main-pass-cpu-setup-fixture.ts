import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice, RhiRenderPassEncoder, ShaderModule } from '@forgeax/engine-rhi';
import { assert } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { BatchTopology, type GpuDrivenBatchBinding } from '../../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../../gpu-driven/draw-selection';
import { GpuBuffer } from '../../gpu-resource';
import { disposeInstanceBuffers } from '../../instance-buffer-cache';
import { MaterialResource } from '../../material-resource';
import { MaterialFrame } from '../../scene/material-dispatch';
import { RenderScene } from '../../scene/render-scene';
import { recordGeometryDraws } from '../main-pass-geometry';
import { flushMeshDrawUploads } from '../mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../render-context';

type Entry = _InternalRenderPipelineContext['validatedOrdered'][number];
export const CPU_SETUP_SHADER = `
struct Instance { current: mat4x4<f32>, previous: mat4x4<f32> };
@group(1) @binding(0) var<uniform> tint: vec4<f32>;
@group(2) @binding(0) var<uniform> meshWorld: mat4x4<f32>;
@group(3) @binding(0) var<storage, read> instances: array<Instance>;
@vertex fn vertex(@location(0) position: vec3<f32>, @builtin(instance_index) i: u32) -> @builtin(position) vec4<f32> {
 return meshWorld * instances[i].current * vec4<f32>(position, 1.0);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return tint; }
`;
const matrix = (x = 0) => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1);

/** Real record owner and RHI resources; only the material pipeline lookup is supplied. */
export function cpuSetupFixture(device: RhiDevice, module: ShaderModule) {
  const buffers: Buffer[] = [];
  const buffer = (data: Float32Array | Uint32Array, usage: number) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 }).unwrap();
    device.queue.writeBuffer(value, 0, data).unwrap();
    buffers.push(value);
    return value;
  };
  const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const dynamicLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    })
    .unwrap();
  const instancesLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } }],
    })
    .unwrap();
  const createPipeline = (
    shader: ShaderModule,
    viewLayout = emptyLayout,
    depthOnly = false,
    materialLayout = dynamicLayout,
  ) =>
    device
      .createRenderPipeline({
        layout: device
          .createPipelineLayout({
            bindGroupLayouts: [viewLayout, materialLayout, dynamicLayout, instancesLayout],
          })
          .unwrap(),
        vertex: {
          module: shader,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        ...(depthOnly
          ? {
              depthStencil: {
                format: 'depth32float' as const,
                depthWriteEnabled: true,
                depthCompare: 'less' as const,
              },
            }
          : {
              fragment: {
                module: shader,
                entryPoint: 'fragment',
                targets: [{ format: 'rgba8unorm' as const }],
              },
            }),
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      })
      .unwrap();
  const pipeline = createPipeline(module);
  const identity = buffer(Float32Array.from([...matrix(), ...matrix()]), 128);
  const materialData = new Float32Array(4096);
  for (let i = 0; i < 64; i++) materialData.set([1, 0.2, 0, 1], i * 64);
  const material = buffer(materialData, 64);
  const meshData = new Float32Array(4096);
  for (let index = 0; index < 64; index++) meshData.set(matrix(), index * 64);
  const mesh = buffer(meshData, 64 | 128);
  const group = (value: Buffer, size = 16) =>
    device
      .createBindGroup({
        layout: dynamicLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: value, size } } }],
      })
      .unwrap();
  const materialGroup = group(material);
  const meshGroup = group(mesh, 64);
  const viewGroup = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
  const selectedDraws = new Set<GpuDrivenBatchBinding['geometry']>();
  const entries: Entry[] = [];
  const gpuLodLevels = new Map<MaterialResource, number>();
  const prepareSelection = () => {
    const scene = new RenderScene();
    const topology = new BatchTopology();
    topology.apply(
      scene.apply(
        entries.map((entry) => ({
          kind: 'update',
          worldId: 0,
          entityKey: entry.source.entityKey,
          snapshot: entry.source,
        })),
      ),
    );
    return new GpuDrawSelection(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.filter((batch) => {
          const binding = batch.binding;
          if (binding === undefined) return false;
          const source = entries.find(
            (entry) => entry.source.assetHandle === binding.assetHandle,
          )?.source;
          const draw = source?.gpuDrivenDraws?.find(
            (draw, index) => (draw.drawItemIndex ?? index) === binding.drawItemIndex,
          );
          return draw !== undefined && selectedDraws.has(draw.geometry);
        })
        .map((batch) => {
          const binding = batch.binding;
          assert(binding);
          return {
            ...batch,
            prepared: {
              identity: {
                material: binding.material.snapshot.materialShaderId,
                geometry: 'triangle',
                deformation: 'rigid',
              },
            } as never,
            lod: {
              coverages: Array.from(
                { length: gpuLodLevels.get(binding.material) ?? 1 },
                (_, i) => 1 / (i + 1),
              ),
              ranges: [],
            },
          };
        }),
    );
  };
  const receipts: { entity: number; submesh: number | undefined }[] = [];
  const errors: unknown[] = [];
  const c = {
    runtime: {
      device,
      errorRegistry: { fire: (error: unknown) => errors.push(error) },
      getMaterialShaderPipelineEntry: () => ({ pipeline, group2Contract: 'mesh' }),
    },
    pipelineState: {
      identityInstanceBuffer: identity,
      instancesBindGroupLayout: instancesLayout,
      materialUniformBuffer: { buffer: material, sizeInBytes: materialData.byteLength },
      meshStorageBuffer: { buffer: mesh, sizeInBytes: meshData.byteLength },
    },
    frameState: { instanceBuffers: new Map(), instancesBgShared: new WeakMap() },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    dispatchCounts: { unlit: 0, standard: 0 },
    tonemapActive: false,
    msaaActive: false,
    splitLdrSprite: false,
    validatedOrdered: entries,
    materialSlots: [],
    materialSlotIndices: [],
    onRenderableDraw: (entry: Entry, submesh: number | undefined) =>
      receipts.push({ entity: entry.source.entityKey, submesh }),
    viewBindGroup: viewGroup,
  } as unknown as _InternalRenderPipelineContext;
  const acceptMaterials = () => {
    let frame = new MaterialFrame(undefined);
    for (const entry of entries) frame = frame.with(entry.source.material, 1);
    Object.assign(c, {
      materialFrame: frame,
      materialSlots: [...entries]
        .sort((a, b) => a.renderableIndex - b.renderableIndex)
        .map((entry) => entry.source.material.snapshot),
      materialSlotIndices: entries.map((entry) => [entry.renderableIndex]),
    });
  };
  const add = (options: {
    entity: number;
    indexed?: boolean;
    instances?: number;
    claimed?: readonly number[];
    submeshes?: number;
    x?: number;
  }) => {
    const source = receiptRow().source;
    const template = source.gpuDrivenDraws?.[0];
    assert(template);
    const indexed = options.indexed ?? true;
    const count = options.submeshes ?? 3;
    const x = options.x ?? 0;
    const positions = Float32Array.from(
      Array.from({ length: count }, (_, i) => {
        const center = x + (i - 1) * 0.55;
        return [center - 0.18, -0.3, 0, center + 0.18, -0.3, 0, center, 0.3, 0];
      }).flat(),
    );
    const vertex = buffer(positions, 32);
    const index = indexed
      ? buffer(
          Uint32Array.from({ length: count * 3 }, (_, i) => i),
          16,
        )
      : null;
    const materialSnapshot = new MaterialResource({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
      materialHandle: 7,
      materialShaderId: 'forgeax::default-unlit',
      passes: [],
    });
    const submeshes = Array.from({ length: count }, (_, i) => ({
      topology: 'triangle-list' as const,
      materialSlot: 0,
      vertexCount: 3,
      indexCount: 3,
      indexOffset: i * 3,
    }));
    const entry = {
      renderableIndex: entries.length,
      meshSlot: entries.length,
      source: {
        ...source,
        assetHandle: options.entity,
        worldId: 0,
        entityKey: options.entity,
        transform: { world: matrix() },
        material: materialSnapshot,
        materials: [materialSnapshot],
        ...(options.instances === undefined
          ? {}
          : {
              instances: {
                transforms: Float32Array.from(
                  Array.from({ length: options.instances }, () => [...matrix()]).flat(),
                ),
                instanceCount: options.instances,
                cacheKey: options.entity,
                archVersion: 0,
                revision: 0,
              },
            }),
        gpuDrivenDraws: (options.claimed ?? []).map((drawItemIndex) => ({
          ...template,
          geometry: {
            ...template.geometry,
            draw: {
              kind: indexed ? 'indexed' : 'non-indexed',
              first: drawItemIndex * 3,
              count: 3,
              baseVertex: 0,
              topology: 'triangle-list',
            },
          },
          drawItemIndex,
          first: drawItemIndex * 3,
          count: 3,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          kind: indexed ? 'indexed' : 'non-indexed',
        })),
      },
      mesh: {
        vertexBuffer: new GpuBuffer(device, vertex),
        indexBuffer: index === null ? null : new GpuBuffer(device, index),
        indexed,
        indexFormat: 'uint32',
        submeshes,
        layoutProjection: deriveVertexLayoutProjection({ position: positions }),
      },
    } as unknown as Entry;
    entries.push(entry);
    for (const draw of entry.source.gpuDrivenDraws ?? []) selectedDraws.add(draw.geometry);
    Object.assign(c, {
      materialSlots: entries.map((entry) => entry.source.material.snapshot),
      materialSlotIndices: entries.map((entry) => [entry.renderableIndex]),
    });
    acceptMaterials();
    return entry;
  };
  return {
    c,
    entries,
    selectedDraws,
    gpuLodLevels,
    errors,
    receipts,
    add,
    prepareSelection,
    acceptMaterials,
    pipeline,
    createPipeline,
    meshUniformBuffer: mesh,
    meshGroup,
    materialGroup,
    materialLayout: dynamicLayout,
    identity,
    instancesLayout,
    viewGroup,
    record(
      pass: RhiRenderPassEncoder,
      kind: Parameters<typeof recordGeometryDraws>[8] = 'forward',
      selection = prepareSelection(),
      afterRecord?: () => void,
    ) {
      acceptMaterials();
      Object.assign(c, {
        gpuDrivenSelection: selection,
        materialSlots: [...entries]
          .sort((a, b) => a.renderableIndex - b.renderableIndex)
          .map((entry) => entry.source.material.snapshot),
        materialSlotIndices: entries.map((entry) => [entry.renderableIndex]),
      });
      recordGeometryDraws(
        c,
        pass,
        null,
        c.materialSlotIndices,
        1,
        meshGroup,
        meshGroup,
        () => materialGroup,
        kind,
      );
      afterRecord?.();
      flushMeshDrawUploads(device.queue, c.pipelineState.meshStorageBuffer);
    },
    dispose() {
      disposeInstanceBuffers(c.frameState.instanceBuffers);
      for (const value of buffers) device.destroyBuffer(value).unwrap();
    },
  };
}
