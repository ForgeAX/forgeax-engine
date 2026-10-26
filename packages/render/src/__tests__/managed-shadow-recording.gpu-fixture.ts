import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { BindGroupLayoutEntry } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { MeshChanges, ShadowMeshReads } from '../device/mesh-changes';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import { GpuBuffer } from '../gpu-resource';
import { createSkylightFallback } from '../ibl/skylight-bind-group';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { DirectDrawPhase } from '../record/direct-draw-phase';
import { prepareDirectionalShadowCache } from '../record/directional-shadow-cache';
import { buildDispatchPlan } from '../record/fold-buckets';
import type { RenderFrameState } from '../record/frame-snapshot';
import { recordGeometryDraws } from '../record/main-pass-geometry';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import {
  type FoldBucket,
  flushMeshDrawUploads,
  MESH_PER_ENTITY_STRIDE,
  uploadMeshSsboBatch,
} from '../record/mesh-ssbo';
import type { RenderSystemInternals } from '../record/render-context';
import {
  type _InternalRenderPipelineContext,
  MATERIAL_PER_ENTITY_STRIDE,
  MATERIAL_UNIFORM_BYTES,
} from '../record/render-context';
import { recordShadowCasterDraws } from '../record/shadow-pass';
import { SkinTasks } from '../record/skin-tasks';
import type { DispatchEntry, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialDispatch } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { nativeDeviceFixture } from './native-device-fixture';
import { skinTaskFixture } from './skin-task-fixture';

// Real residual recording and dynamic material offsets, not a PBR lighting surrogate.
// The depth witness also makes two wrong-but-equal empty images fail independently.
export const SHADOW_CACHE_WITNESS = `
struct Material { baseColor: vec4<f32> }
struct Mesh { world: mat4x4<f32> }
@group(1) @binding(0) var<uniform> material: Material;
@group(2) @binding(0) var<uniform> mesh: Mesh;
@vertex fn vs_witness(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  let world = mesh.world * vec4<f32>(p, 1.0);
  return vec4<f32>(world.xy, material.baseColor.x, 1.0);
}
@vertex fn vs_second(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  let world = mesh.world * vec4<f32>(p, 1.0);
  return vec4<f32>(world.xy + vec2<f32>(0.0, 0.5), material.baseColor.x + 0.125, 1.0);
}
`;
const WIDTH = 32,
  HEIGHT = 16,
  ROW_FLOATS = 64;
const SHADER = 'test::shared-roster-depth-witness';
function planes(side: -1 | 0 | 1): Float32Array {
  const value = new Float32Array(24);
  value[0] = side;
  return value;
}
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing witness input');
  return value;
}

async function fixture(entryPoints?: readonly ShaderEntryPointReads[]) {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    const fallback = createSkylightFallback(device, device.queue);
    const meshBuffer = device
      .createBuffer({ size: MESH_PER_ENTITY_STRIDE * 3, usage: 64 | 128 | 8 })
      .unwrap();
    const materialBuffer = device
      .createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE * 2, usage: 64 | 8 })
      .unwrap();
    const identityInstance = device.createBuffer({ size: 64, usage: 128 | 8 }).unwrap();
    device.queue
      .writeBuffer(identityInstance, 0, new Float32Array(mat4.identity(mat4.create())))
      .unwrap();
    const vertex = new GpuBuffer(device, device.createBuffer({ size: 36, usage: 32 | 8 }).unwrap());
    device.queue
      .writeBuffer(vertex.handle, 0, Float32Array.of(-0.16, -0.16, 0, 0.16, -0.16, 0, 0, 0.16, 0))
      .unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const entries: BindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: 1,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MATERIAL_UNIFORM_BYTES },
      },
      { binding: 1, visibility: 2, texture: { viewDimension: 'cube', sampleType: 'float' } },
      { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 3, visibility: 2, texture: { viewDimension: '2d', sampleType: 'float' } },
      { binding: 4, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 5, visibility: 2, texture: { viewDimension: '2d', sampleType: 'float' } },
      { binding: 6, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 47, visibility: 2, texture: { viewDimension: '2d', sampleType: 'float' } },
    ];
    if (transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage))
      entries.push(
        { binding: 7, visibility: 2, sampler: { type: 'filtering' } },
        { binding: 8, visibility: 2, texture: { viewDimension: '2d', sampleType: 'float' } },
      );
    if (device.caps.storageBuffer)
      entries.push({ binding: 46, visibility: 1 | 2, buffer: { type: 'read-only-storage' } });
    const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
    const materialLayout = device.createBindGroupLayout({ entries }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 1,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
          },
        ],
      })
      .unwrap();
    const instanceLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 1, buffer: { type: 'read-only-storage', minBindingSize: 64 } },
        ],
      })
      .unwrap();
    const layout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instanceLayout],
      })
      .unwrap();
    const module = (await rhi.createShaderModule(device, { code: SHADOW_CACHE_WITNESS })).unwrap();
    const makePipeline = (entryPoint: string) =>
      device
        .createRenderPipeline({
          layout,
          vertex: {
            module,
            entryPoint,
            buffers: [
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        })
        .unwrap();
    const pipeline = makePipeline('vs_witness');
    const secondPipeline = makePipeline('vs_second');
    const meshGroup = device
      .createBindGroup({
        layout: meshLayout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: meshBuffer, offset: 0, size: 64 } },
          },
        ],
      })
      .unwrap();
    const target = device
      .createTexture({
        size: { width: WIDTH, height: HEIGHT },
        format: 'depth32float',
        textureBindingViewDimension: '2d',
        usage: 16 | 1,
      })
      .unwrap();
    const targetView = device.createTextureView(target, {}).unwrap();
    const readback = device.createBuffer({ size: 256 * HEIGHT, usage: 1 | 8 }).unwrap();
    const materials = [100, 200].map(
      (materialHandle, slot) =>
        ({
          materialHandle,
          materialShaderId: SHADER,
          baseColor: vec3.create(slot === 0 ? 0.25 : 0.75, 0, 0),
          metallic: 0,
          roughness: 1,
          passes: [
            {
              name: 'shadow',
              program: { module: SHADER, vertexEntry: 'vs_witness' },
              renderState: { tags: { LightMode: 'ShadowCaster' } },
            },
          ],
          materialProgramKeys: { shadow: SHADER },
          ...(entryPoints === undefined ? {} : { materialEntryPoints: { shadow: entryPoints } }),
        }) as MaterialSnapshot,
    );
    const rows = materials.map((material, renderableIndex) => {
      const world = mat4.identity(mat4.create());
      world[12] = renderableIndex === 0 ? -0.5 : 0.5;
      const resource = new MaterialResource(material);
      const source = {
        assetHandle: 7,
        entityKey: renderableIndex + 1,
        worldId: 0,
        material: resource,
        materials: [resource],
        materialBindingSources: ['renderer-override'],
        transform: { world },
        localAabb: Float32Array.of(-0.16, -0.16, 0, 0.16, 0.16, 0),
        gpuDrivenDraws: [
          {
            kind: 'non-indexed',
            first: 0,
            count: 3,
            materialSlot: 0,
            topology: 'triangle-list',
            drawItemIndex: 0,
            geometry: {
              receipt: {
                identity: 'witness',
                vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
                topology: 'triangle-list',
                indexed: false,
              },
              draw: {
                kind: 'non-indexed',
                first: 0,
                count: 3,
                baseVertex: 0,
                topology: 'triangle-list',
              },
              deformation: 'rigid',
            },
          },
        ],
      } as unknown as RenderableSnapshot;
      return {
        renderableIndex,
        meshSlot: renderableIndex,
        source,
        mesh: {
          vertexBuffer: vertex,
          indexed: false,
          indexBuffer: null,
          layoutProjection: { attributes: [] },
          submeshes: [
            {
              topology: 'triangle-list',
              materialSlot: 0,
              vertexCount: 3,
              indexCount: 0,
              indexOffset: 0,
            },
          ],
        },
      };
    });
    const dispatch = materials.map(
      (material, renderableIndex) =>
        ({
          renderableIndex,
          materialHandle: defined(material.materialHandle),
          entityIndex: renderableIndex,
          queue: 2000,
          layer: 0,
          renderState: undefined,
          defines: undefined,
          fragmentEntry: undefined,
          paramSnapshot: undefined,
          materialShaderId: SHADER,
          passIndex: 0,
          tags: { LightMode: 'ShadowCaster' },
          vertexEntry: 'vs_witness',
        }) as DispatchEntry,
    );
    const scene = new RenderScene();
    scene.rebuild(rows.map((row) => row.source));
    const materialDispatch = new MaterialDispatch();
    for (const slot of scene.slotsSnapshot()) materialDispatch.bind(slot.slot, slot.snapshot);
    const topology = new BatchTopology();
    topology.rebuild(scene.slotsSnapshot());
    const pipelineRequests: unknown[][] = [];
    const context = {
      shadowCasterBounds: (
        source: RenderableSnapshot,
        out: import('@forgeax/engine-math').box3.Box3,
      ) => {
        const slot = scene.slot(source.worldId, source.entityKey);
        return slot !== undefined && scene.writeCullingWorldBoundsAt(slot, out);
      },
      dispatch,
      validatedOrdered: rows,
      materialSlotIndices: [[0], [1]],
      materialSlots: materials,
      materialFrame: materialDispatch.materials(),
      shadowSlotForEntity: scene.slot,
      runtime: {
        device,
        getMaterialShaderPipeline: (...args: unknown[]) => {
          pipelineRequests.push(args);
          return args[18] === 'vs_second' ? secondPipeline : pipeline;
        },
        getMaterialShaderPipelineEntry: (...args: unknown[]) => {
          pipelineRequests.push(args);
          return {
            pipeline: args[18] === 'vs_second' ? secondPipeline : pipeline,
            group2Contract: 'mesh',
          };
        },
        getParamSchema: () => [],
        getMaterialBindGroupLayout: () => materialLayout,
        errorRegistry: {
          fire(error: unknown) {
            throw error;
          },
        },
      },
      world: { identity: 'shared-roster-depth-world' },
      store: { materialResourceEpoch: 0 },
      pipelineState: {
        skylightFallback: fallback,
        identityInstanceBuffer: identityInstance,
        instancesBindGroupLayout: instanceLayout,
        materialBindGroupLayout: materialLayout,
        materialUniformBuffer: { buffer: materialBuffer },
        meshStorageBuffer: { buffer: meshBuffer },
        meshBindGroupLayout: meshLayout,
        defaultSampler: fallback.sampler,
        defaultWhiteTextureView: fallback.brdfLutView,
        defaultNormalTextureView: fallback.brdfLutView,
        fallbackTextureView: fallback.brdfLutView,
      },
      frameState: {
        materialBgShared: new Map(),
        instancesBgShared: new WeakMap(),
        meshBindGroupCache: new WeakMap(),
      },
      materialBgAssemblyCache: new MaterialBgAssemblyCache(),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      skylightCount: 0,
    } as unknown as _InternalRenderPipelineContext;
    return {
      device,
      native,
      scene,
      context,
      pipelineRequests,
      materialDispatch,
      topology,
      pipeline,
      viewLayout,
      materialLayout,
      instanceLayout,
      viewGroup,
      meshGroup,
      target,
      targetView,
      readback,
      close() {
        native.destroy();
      },
    };
  } catch (error) {
    native.destroy();
    throw error;
  }
}

async function depth(
  f: Awaited<ReturnType<typeof fixture>>,
  c: _InternalRenderPipelineContext,
  side: -1 | 0 | 1,
  selections?: readonly GpuDrawSelection[],
  reflected = false,
  terrainReceiver?: { readonly worldId: number; readonly entityKey: number },
  geometry = false,
  passKind = 'forward',
  retained = false,
  selectedDispatch?: _InternalRenderPipelineContext['dispatch'],
) {
  const encoder = f.device.createCommandEncoder().unwrap();
  if (!retained) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: f.targetView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    });
    pass.setPipeline(f.pipeline);
    pass.setBindGroup(0, f.viewGroup);
    if (geometry) {
      recordGeometryDraws(
        {
          ...c,
          dispatchCounts: { unlit: 0 },
          viewBindGroup: f.viewGroup,
        },
        pass,
        null,
        c.materialSlotIndices,
        1,
        f.meshGroup,
        f.meshGroup,
        (_slot, material) =>
          defined(c.materialBgAssemblyCache.get(c.world.identity, material.materialHandle, SHADER))
            .bindGroup,
        passKind,
        selectedDispatch,
      );
    } else {
      recordShadowCasterDraws(
        c,
        pass,
        f.pipeline,
        f.meshGroup,
        selections,
        reflected,
        planes(side),
        false,
        terrainReceiver,
      );
    }
    pass.end();
  }
  encoder.copyTextureToBuffer(
    { texture: f.target, aspect: 'depth-only' },
    { buffer: f.readback, bytesPerRow: 256, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  flushMeshDrawUploads(f.device.queue, c.pipelineState.meshStorageBuffer);
  f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await f.device.queue.onSubmittedWorkDone();
  const mapped = (await f.readback.mapAsync(1)).unwrap();
  const bytes = mapped.getMappedRange().unwrap().slice(0);
  mapped.unmap();
  const validation = await f.native.popErrorScope();
  f.native.pushErrorScope('validation');
  expect(validation, validation?.message).toBeNull();
  return new Float32Array(bytes);
}

export async function verifyManagedShadowRecording(): Promise<void> {
  const f = await fixture();
  const sample = (pixels: Float32Array) => [
    pixels[8 * ROW_FLOATS + 8],
    pixels[8 * ROW_FLOATS + 24],
  ];
  try {
    const c = f.context;
    expect(sample(await depth(f, c, -1))).toEqual([0.25, 0]);
    expect(sample(await depth(f, c, 1))).toEqual([0, 0.75]);
    expect(sample(await depth(f, c, 0))).toEqual([0.25, 0.75]);
    const left = defined(c.validatedOrdered[0]);
    const right = defined(c.validatedOrdered[1]);
    // The main view may fold a source while a capture records its original
    // transform. Both byte ranges must coexist before the shared submission.
    const planned = buildDispatchPlan(
      {
        device: f.device,
        metrics: { increment() {} },
        meshSsboState: { meshSlotCount: 3, materialSlotCount: 2 },
        growMeshSsbo: () => {
          throw new Error('Three physical draw rows suffice');
        },
      } as never,
      [left, right],
      [],
      [
        {
          entries: [
            { renderableIndex: left.renderableIndex },
            { renderableIndex: right.renderableIndex },
          ],
          bucketSize: 2,
          transforms: new Float32Array(32),
          materialHandle: 1,
          layer: 0,
          sortKey: 0,
        } as unknown as FoldBucket,
      ],
      [],
      undefined,
      false,
      undefined,
      f.scene,
    );
    expect(planned.validatedOrdered.map((entry) => entry.meshSlot)).toEqual([0, 1]);
    expect(planned.validatedOrdered[0]?.foldedMeshSlot).toBe(2);
    expect(planned.foldDispatchPlan?.foldedBucketCount).toBe(1);
    uploadMeshSsboBatch(
      f.device.queue,
      c.pipelineState.meshStorageBuffer,
      planned.validatedOrdered,
      planned.foldDispatchPlan,
    );
    expect(sample(await depth(f, c, 0))).toEqual([0.25, 0.75]);
    // A reordered capture addresses the same source bytes, independent of its row ordinals.
    expect(
      sample(
        await depth(
          f,
          {
            ...c,
            validatedOrdered: [right, left],
            materialSlotIndices: [[1], [0]],
          },
          0,
          undefined,
          false,
          undefined,
          false,
        ),
      ),
    ).toEqual([0.25, 0.75]);
    const leftSlot = defined(f.scene.slot(0, left.source.entityKey));
    const selected = new GpuDrawSelection(
      f.topology
        .query(f.topology.sourcePlan(), undefined)
        .batches.filter((batch) => batch.binding?.material === left.source.material),
    );
    expect(sample(await depth(f, c, 0, [selected]))).toEqual([0, 0.75]);
    // Independent capture shadows require both casters. The display view
    // keeps the same physical roster but filters its GPU-owned submesh.
    const captureCasters = {
      ...c,
      shadowValidatedOrdered: c.validatedOrdered.map((row) => ({ ...row, submeshIndices: [0] })),
      shadowMaterialRowBase: 0,
    };
    expect(sample(await depth(f, captureCasters, 0, [selected]))).toEqual([0, 0.75]);
    expect(sample(await depth(f, captureCasters, 0))).toEqual([0.25, 0.75]);

    // Source LOD declarations do not prove that the accepted GPU submission
    // has a temporal producer. Test the actual CPU recorder against depth pixels.
    const temporalSources = c.validatedOrdered.map((row) => ({
      ...row.source,
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
    }));
    const temporalScene = new RenderScene();
    temporalScene.rebuild(temporalSources);
    const temporalTopology = new BatchTopology();
    temporalTopology.rebuild(temporalScene.slotsSnapshot());
    for (const levels of [1, 2]) {
      const temporalSelection = new GpuDrawSelection(
        temporalTopology.query(temporalTopology.sourcePlan(), undefined).batches.map((batch) => ({
          ...batch,
          prepared: {
            identity: {
              material: 'forgeax::default-standard-pbr',
              deformation: 'rigid',
              geometry: 'triangle',
            },
          } as PreparedGpuDrivenDraw,
          lod: { coverages: levels === 1 ? [1] : [1, 0.5], ranges: [] },
        })),
      );
      const temporalContext = {
        ...c,
        gpuDrivenSelection: temporalSelection,
        validatedOrdered: c.validatedOrdered.map((row, index) => ({
          ...row,
          source: defined(temporalSources[index]),
        })),
      };
      expect(
        sample(await depth(f, temporalContext, 0, undefined, false, undefined, true, 'temporal')),
        `accepted GPU LOD levels=${levels}`,
      ).toEqual(levels === 1 ? [0.25, 0.75] : [0, 0]);
    }

    // One entity, mixed primitive types, reordered sparse source draw IDs and
    // two material slots. Physical indexed ranges need not match author offsets.
    for (const indexed of [false, true]) {
      const vertices = Float32Array.of(
        0,
        0,
        0,
        0,
        0,
        0,
        -0.66,
        -0.16,
        0,
        -0.34,
        -0.16,
        0,
        -0.5,
        0.16,
        0,
        0.34,
        -0.16,
        0,
        0.66,
        -0.16,
        0,
        0.5,
        0.16,
        0,
      );
      const vertexBuffer = new GpuBuffer(
        f.device,
        f.device.createBuffer({ size: vertices.byteLength, usage: 32 | 8 }).unwrap(),
      );
      f.device.queue.writeBuffer(vertexBuffer.handle, 0, vertices).unwrap();
      const indices = Uint32Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5);
      const indexBuffer = new GpuBuffer(
        f.device,
        f.device.createBuffer({ size: indices.byteLength, usage: 16 | 8 }).unwrap(),
      );
      f.device.queue.writeBuffer(indexBuffer.handle, 0, indices).unwrap();
      const draw = (drawItemIndex: number) => {
        const first = indexed ? 1 + (drawItemIndex - 1) * 3 : 2 + (drawItemIndex - 1) * 3;
        const kind = indexed ? ('indexed' as const) : ('non-indexed' as const);
        return {
          kind,
          first,
          count: 3,
          materialSlot: drawItemIndex - 1,
          topology: 'triangle-list' as const,
          drawItemIndex,
          baseVertex: 0,
          pipelineClass: 'witness',
          materialResourceClass: 'witness',
          geometry: {
            receipt: {
              identity: `multi-${indexed}`,
              indexed,
              topology: 'triangle-list' as const,
              vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
            },
            draw: { kind, first, count: 3, baseVertex: 0, topology: 'triangle-list' as const },
            deformation: 'rigid' as const,
          },
        };
      };
      const source = {
        ...left.source,
        transform: { world: mat4.identity(mat4.create()) },
        localAabb: Float32Array.of(-0.66, -0.16, 0, 0.66, 0.16, 0),
        materials: [left.source.material, right.source.material],
        gpuDrivenDraws: [draw(2), draw(1)],
      } as RenderableSnapshot;
      const scene = new RenderScene();
      scene.rebuild([source]);
      const topology = new BatchTopology();
      topology.rebuild(scene.slotsSnapshot());
      const leftSelection = new GpuDrawSelection(
        topology
          .query(topology.sourcePlan(), undefined)
          .batches.filter((batch) => batch.binding?.material === source.material),
      );
      const row = {
        ...left,
        meshSlot: 5,
        source,
        mesh: {
          ...left.mesh,
          vertexBuffer,
          indexed,
          indexBuffer: indexed ? indexBuffer : null,
          indexFormat: 'uint32' as const,
          submeshes: [
            {
              topology: 'line-list' as const,
              materialSlot: 0,
              vertexCount: 2,
              indexCount: 1,
              indexOffset: 0,
            },
            {
              topology: 'triangle-list' as const,
              materialSlot: 0,
              vertexCount: 3,
              indexCount: 3,
              indexOffset: 1,
            },
            {
              topology: 'triangle-list' as const,
              materialSlot: 1,
              vertexCount: 3,
              indexCount: 3,
              indexOffset: 4,
            },
          ],
          ...(indexed
            ? {
                lodRanges: [
                  [
                    { first: 0, count: 1, baseVertex: 0 },
                    { first: 7, count: 3, baseVertex: 2 },
                    { first: 10, count: 3, baseVertex: 2 },
                  ],
                ],
              }
            : {}),
        },
      };
      const pages = [0, 1].map(() =>
        f.device.createBuffer({ size: 1024, usage: 64 | 128 | 8 }).unwrap(),
      );
      const multi = {
        ...c,
        validatedOrdered: [row],
        shadowSlotForEntity: scene.slot,
        shadowMaterialRowBase: 5,
        materialSlotIndices: [[], [], [], [], [], [0, 1]],
        pipelineState: {
          ...c.pipelineState,
          meshStorageBuffer: {
            buffer: null,
            sizeInBytes: 2048,
            pages: { byteStride: 1024, byteSize: 1024, buffers: pages },
          },
        },
      };
      expect(sample(await depth(f, multi, 0)), `indexed=${indexed}`).toEqual([0.25, 0.75]);
      expect(
        sample(await depth(f, multi, 0, [leftSelection])),
        `partial indexed=${indexed}`,
      ).toEqual([0, 0.75]);
      const sparse = {
        ...multi,
        validatedOrdered: [
          { ...row, source: { ...source, gpuDrivenDraws: [draw(1)] } as RenderableSnapshot },
        ],
      };
      expect(sample(await depth(f, sparse, 0, [leftSelection]))).toEqual([0, 0.75]);
      expect(sample(await depth(f, multi, 0, []))).toEqual([0.25, 0.75]);
      expect(
        sample(
          await depth(
            f,
            { ...multi, shadowMaterialRowBase: 0, materialSlotIndices: [[0, 1]] },
            0,
            undefined,
            false,
            undefined,
            true,
          ),
        ),
        `main indexed=${indexed}`,
      ).toEqual([0.25, 0.75]);

      // Native routing joins the shared execution before reading members. The
      // selected row retains the physical source submesh and paged mesh address.
      const nativeScene = new RenderScene();
      nativeScene.rebuild([source as RenderableSnapshot]);
      const nativeTopology = new BatchTopology();
      nativeTopology.rebuild(nativeScene.slotsSnapshot());
      const nativePlan = nativeTopology.query(nativeTopology.sourcePlan(), undefined);
      const nativeMeshes = new Map(
        nativePlan.batches.map((batch) => [defined(batch.binding), row.mesh]),
      );
      const routeRows = (rightDirect: boolean) =>
        new DirectDrawPhase().sync({
          scene: {
            plan: {
              ...nativePlan,
              batches: nativePlan.batches.map((batch) =>
                batch.binding?.drawItemIndex === 1
                  ? {
                      ...batch,
                      get members(): never {
                        throw new Error('native direct recording visited GPU members');
                      },
                    }
                  : batch,
              ),
            },
            slotAt: nativeScene.slotAt,
            drawSnapshotAt: nativeScene.drawSnapshotAt,
            unbatchedSlots: nativeTopology.unbatchedSlots,
          },
          selection: [],
          select: (binding) =>
            rightDirect && binding.drawItemIndex === 2 ? right.source.material.snapshot : undefined,
          meshes: nativeMeshes,
          worlds: [c.world],
          shadow: true,
          materials: undefined,
          prepareUnbatched: () => {
            throw new Error('no unbatched geometry');
          },
          viewDraws: [],
          lod: (rows) => rows,
        }).rows;
      expect(sample(await depth(f, { ...multi, validatedOrdered: routeRows(true) }, 0))).toEqual([
        0, 0.75,
      ]);
      expect(sample(await depth(f, { ...multi, validatedOrdered: routeRows(false) }, 0))).toEqual([
        0, 0,
      ]);
    }
    const wrongGeneration = {
      ...c,
      shadowSlotForEntity: (world: number, entity: number) => {
        const slot = f.scene.slot(world, entity);
        return slot === undefined ? undefined : { ...slot, generation: slot.generation + 1 };
      },
    };
    expect(sample(await depth(f, wrongGeneration, 0, [selected]))).toEqual([0.25, 0.75]);

    // Terrain sections share their entity identity but keep independent
    // generated geometry, transforms, material resources and physical rows.
    const terrainSections = {
      ...c,
      validatedOrdered: [left, right].map((row) => ({
        ...row,
        source: {
          ...row.source,
          entityKey: left.source.entityKey,
          terrain: {} as NonNullable<RenderableSnapshot['terrain']>,
          gpuDrivenDraws: [],
        },
      })),
    };
    expect(sample(await depth(f, terrainSections, 0, [selected]))).toEqual([0.25, 0.75]);

    // Public geometry records survive an asset edit. A captured frame retains its old Passes.
    const material = left.source.material;
    const original = material.snapshot;
    material.adopt({ ...original, passes: [] });
    f.materialDispatch.adopt(material);
    expect(sample(await depth(f, c, 0))).toEqual([0.25, 0.75]);
    const next = { ...c, materialFrame: f.materialDispatch.materials() };
    expect(sample(await depth(f, next, 0))).toEqual([0, 0.75]);
    const pass = defined(original.passes?.[0]);
    material.adopt({
      ...original,
      passes: [
        pass,
        { ...pass, name: 'second', program: { module: SHADER, vertexEntry: 'vs_second' } },
      ],
      materialProgramKeys: { shadow: SHADER, second: SHADER },
    });
    f.materialDispatch.adopt(material);
    const multipass = { ...c, materialFrame: f.materialDispatch.materials() };
    const requests = f.pipelineRequests.length;
    const twoPassDepth = await depth(f, multipass, 0);
    expect(sample(twoPassDepth)).toEqual([0.25, 0.75]);
    expect([twoPassDepth[4 * ROW_FLOATS + 8], twoPassDepth[4 * ROW_FLOATS + 24]]).toEqual([
      0.375, 0,
    ]);
    expect(f.pipelineRequests.length - requests).toBe(3);
    expect(
      sample(
        await depth(
          f,
          {
            ...multipass,
            validatedOrdered: [{ ...left, source: { ...left.source, shadowCaster: false } }, right],
          },
          0,
        ),
      ),
    ).toEqual([0, 0.75]);
    expect(
      sample(
        await depth(
          f,
          {
            ...multipass,
            validatedOrdered: [
              { ...left, source: { ...left.source, authorVisible: false } },
              right,
            ],
          },
          0,
        ),
      ),
    ).toEqual([0, 0.75]);
    const swapped = {
      ...multipass,
      materialSlotIndices: [[1], [0]],
      validatedOrdered: [
        {
          ...left,
          source: {
            ...left.source,
            material: right.source.material,
            materials: [right.source.material],
          },
        },
        {
          ...right,
          source: {
            ...right.source,
            material: left.source.material,
            materials: [left.source.material],
          },
        },
      ],
    };
    expect(sample(await depth(f, swapped, 0))).toEqual([0.75, 0.25]);

    // Retiring and reusing a slot cannot make the old view suppress a new entity.
    f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: left.source.entityKey }]);
    const replacement = { ...left, source: { ...left.source, entityKey: 3 } };
    f.scene.apply([{ kind: 'update', worldId: 0, entityKey: 3, snapshot: replacement.source }]);
    expect(defined(f.scene.slot(0, 3)).generation).not.toBe(leftSlot.generation);
    expect(
      sample(
        await depth(f, { ...multipass, validatedOrdered: [replacement, right] }, 0, [selected]),
      ),
    ).toEqual([0.25, 0.75]);
    await depth(f, multipass, 0, undefined, true);
    expect(f.pipelineRequests.at(-1)?.[2]).toEqual({ frontFace: 'cw' });
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    f.close();
  }
}

/** Real depth writes plus retained atlas reads; metadata comes from native Naga in the Dawn gate. */
export async function verifyManagedShadowCache(
  entryPoints: readonly ShaderEntryPointReads[],
): Promise<void> {
  const f = await fixture(entryPoints),
    world = new World(),
    lease = createRenderReadLease(world);
  const state = {
    compiledFrameGraph: { topologyKey: 'witness' },
    installedPipelineHandle: 1,
    directionalShadowCache: null,
  } as unknown as RenderFrameState;
  const internals = { assets: { catalogEpoch: 1 } } as unknown as RenderSystemInternals;
  const owner = {};
  const changes = new MeshChanges();
  const reads = new ShadowMeshReads(changes);
  reads.add(changes.create());
  const lights = {
    cascades: {
      cascadeCount: 1,
      lightViewProj: [new Float32Array(16)],
      directionalShadowQuality: { kind: 'pcf', kernel: 3 },
    },
  } as const;
  const c = { ...f.context, materialFrame: defined(f.context.materialFrame) };
  const first = defined(c.validatedOrdered[0]);
  const original = first.source.material.snapshot;
  const oldMaterials = c.materialFrame;
  const render = async (count: number) => {
    let pixels = new Float32Array();
    for (let frame = 0; frame < count; frame++) {
      const decision = prepareDirectionalShadowCache(
        internals,
        state,
        [world].map(worldRenderResources),
        [lease],
        lights as never,
        32,
        { reads, epoch: changes.epoch, change: 'quiet' },
        {
          content: {
            owner,
            materials: c.materialFrame,
            meshes: new MeshFrame(),
            sceneRevision: 0,
            dispatchRevision: 0,
            subsurface: { source: 0, authorVisible: 0, admitted: 0 },
          },
          meshDraws: f.scene,
          renderables: c.validatedOrdered.map((row) => row.source),
          dispatch: [],
          worldBoundsOf: () => false,
        },
      );
      pixels = await depth(
        f,
        c,
        0,
        undefined,
        false,
        undefined,
        false,
        'forward',
        decision.miss === undefined,
      );
      if (decision.next !== null) state.directionalShadowCache = decision.next;
    }
    return [pixels[8 * ROW_FLOATS + 8], pixels[8 * ROW_FLOATS + 24]];
  };
  try {
    expect(await render(20)).toEqual([0.25, 0.75]);
    const requests = f.pipelineRequests.length;
    first.source.material.adopt({ ...original, roughness: 0.2 });
    c.materialFrame = c.materialFrame.with(first.source.material);
    expect(await render(20)).toEqual([0.25, 0.75]);
    expect(f.pipelineRequests).toHaveLength(requests);
    first.source.material.adopt({ ...original, baseColor: vec3.create(0.5, 0, 0) });
    c.materialFrame = c.materialFrame.with(first.source.material);
    expect(await render(20)).toEqual([0.5, 0.75]);
    expect(f.pipelineRequests.length).toBeGreaterThan(requests);
    c.materialFrame = oldMaterials;
    expect(await render(1)).toEqual([0.25, 0.75]);
  } finally {
    reads.release();
    changes.reset();
    lease.dispose();
    f.close();
  }
}

/** The production CPU shadow recorder must exclude primitives without a surface. */
export async function verifyManagedShadowTopology(): Promise<void> {
  const f = await fixture();
  try {
    const right = defined(f.context.validatedOrdered[1]);
    const original = right.mesh.submeshes;
    for (const topology of ['point-list', 'line-list', 'line-strip'] as const) {
      Object.assign(right.mesh, {
        submeshes: original.map((submesh) => ({ ...submesh, topology })),
      });
      const pixels = await depth(f, f.context, 0);
      expect(pixels[8 * ROW_FLOATS + 8]).toBe(0.25);
      expect(pixels[8 * ROW_FLOATS + 24]).toBe(0);
    }
    Object.assign(right.mesh, { submeshes: original });
    const restored = await depth(f, f.context, 0);
    expect(restored[8 * ROW_FLOATS + 24]).toBe(0.75);
  } finally {
    f.close();
  }
}

/** Real World evidence, CSM matrices and depth storage share one retained shadow decision. */
export async function verifyManagedShadowCameraRetention(): Promise<void> {
  const { Transform } = await import('@forgeax/engine-scene');
  const { computeDirectionalCsm } = await import('../render-system-extract');
  const f = await fixture();
  const world = new World();
  const camera = world.spawn({ component: Transform, data: { pos: [0, 0, 5] } }).unwrap();
  const lease = createRenderReadLease(world);
  const state = {
    compiledFrameGraph: { topologyKey: 'camera-retention' },
    installedPipelineHandle: 1,
    directionalShadowCache: null,
  } as unknown as RenderFrameState;
  const internals = {} as RenderSystemInternals;
  const changes = new MeshChanges();
  const reads = new ShadowMeshReads(changes);
  reads.add(changes.create());
  const first = defined(f.context.validatedOrdered[0]);
  const next = defined(f.context.validatedOrdered[1]);
  const c = {
    ...f.context,
    validatedOrdered: [first],
    materialFrame: defined(f.context.materialFrame),
  };
  f.scene.reset([first.source]);
  const direction = vec3.create(0.18, -0.6, 1);
  const config = {
    cascadeCount: 1,
    splitLambda: 0.75,
    cascadeBlend: 0.2,
    mapSize: 512,
    shadowDistance: 100,
    shadowFilter: 3,
    shadowAngularRadius: 0.00465,
    maxPenumbraTexels: 32,
  };
  let retained: readonly Float32Array[] | undefined;
  const render = async () => {
    const transform = world.get(camera, Transform).unwrap();
    const matrix = mat4.identity(mat4.create());
    matrix[12] = transform.pos[0] ?? 0;
    matrix[14] = transform.pos[2] ?? 5;
    const csm = computeDirectionalCsm(
      direction,
      config,
      {
        world: matrix,
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        projection: 'perspective',
        orthoLeft: -1,
        orthoRight: 1,
        orthoBottom: -1,
        orthoTop: 1,
      },
      retained,
    );
    if (csm === null) throw Error('Expected a directional CSM projection');
    retained = csm.lightViewProj;
    const decision = prepareDirectionalShadowCache(
      internals,
      state,
      [world].map(worldRenderResources),
      [lease],
      {
        cascades: {
          cascadeCount: 1,
          lightViewProj: retained,
          directionalShadowQuality: { kind: 'pcf', kernel: 3 },
        },
      } as never,
      512,
      { reads, epoch: changes.epoch, change: 'quiet' },
      {
        content: {
          owner: f.scene,
          materials: c.materialFrame,
          meshes: new MeshFrame(),
          sceneRevision: f.scene.contentRevision,
          dispatchRevision: 0,
          subsurface: { source: 0, authorVisible: 0, admitted: 0 },
        },
        meshDraws: f.scene,
        renderables: c.validatedOrdered.map((row) => row.source),
        dispatch: [],
        worldBoundsOf: () => false,
      },
    );
    const pixels = await depth(
      f,
      c,
      0,
      undefined,
      false,
      undefined,
      false,
      'forward',
      decision.miss === undefined,
    );
    if (decision.next !== null) state.directionalShadowCache = decision.next;
    return {
      miss: decision.miss,
      pixels: [pixels[8 * ROW_FLOATS + 8], pixels[8 * ROW_FLOATS + 24]],
    };
  };
  try {
    expect(await render()).toEqual({ miss: 'first-publication', pixels: [0.25, 0] });
    const requests = f.pipelineRequests.length;
    for (let frame = 1; frame <= 60; frame++) {
      world.set(camera, Transform, { pos: [frame * 0.000001, 0, 5] }).unwrap();
      expect(await render()).toEqual({ miss: undefined, pixels: [0.25, 0] });
    }
    expect(f.pipelineRequests).toHaveLength(requests);
    world.spawn({ component: Transform, data: {} }).unwrap();
    f.scene.apply([
      { kind: 'update', worldId: 0, entityKey: next.source.entityKey, snapshot: next.source },
    ]);
    c.validatedOrdered = [first, next];
    expect(await render()).toEqual({ miss: 'content-changed', pixels: [0.25, 0.75] });
    expect(f.pipelineRequests.length).toBeGreaterThan(requests);
  } finally {
    reads.release();
    changes.reset();
    lease.dispose();
    f.close();
  }
}

/** Same residual recorder and native layouts; missing pose may omit only the Skin Pass. */
export async function verifyMixedSkinPassRecording(): Promise<void> {
  const f = await fixture(),
    shared = skinTaskFixture(),
    tasks = new SkinTasks(f.device, true);
  try {
    const skinLayout = f.device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 1,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
          },
          { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
          {
            binding: 2,
            visibility: 1,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
          },
        ],
      })
      .unwrap();
    const layout = f.device
      .createPipelineLayout({
        bindGroupLayouts: [f.viewLayout, f.materialLayout, skinLayout, f.instanceLayout],
      })
      .unwrap();
    const code = SHADOW_CACHE_WITNESS.replace(
      '@vertex fn vs_second',
      `
@group(2) @binding(1) var<storage, read> taskOutput: array<vec4<u32>>;
@group(2) @binding(2) var<uniform> taskAddress: vec4<u32>;
@vertex fn vs_second`,
    ).replace(
      'let world = mesh.world * vec4<f32>(p, 1.0);\n  return vec4<f32>(world.xy +',
      `let descriptor = taskOutput[taskAddress.y + taskOutput[taskAddress.x + taskAddress.z].x];
  let base = descriptor.z;
  let pose = mat4x4<f32>(bitcast<vec4<f32>>(taskOutput[base]), bitcast<vec4<f32>>(taskOutput[base + 1u]), bitcast<vec4<f32>>(taskOutput[base + 2u]), bitcast<vec4<f32>>(taskOutput[base + 3u]));
  let world = pose * vec4<f32>(p, 1.0);
  return vec4<f32>(world.xy +`,
    );
    const module = (await rhi.createShaderModule(f.device, { code })).unwrap();
    const skinPipeline = f.device
      .createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_second',
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      })
      .unwrap();
    const left = defined(f.context.validatedOrdered[0]);
    const demand = () => tasks.demand(shared.first);
    shared.frames.discardFrame();
    shared.matrix[12] = 0.5;
    shared.skin.joint(0, 19, shared.matrix);
    for (const missing of [false, true]) {
      if (missing) shared.skin.joint(0, 19, undefined);
      const frame = defined(shared.frames.prepareFrame(shared.scene.slotsSnapshot()));
      tasks.begin(frame);
      for (const reverse of [false, true]) {
        const passes = [
          {
            name: 'rigid',
            program: { module: SHADER, vertexEntry: 'vs_witness' },
            renderState: { tags: { LightMode: 'ShadowCaster' } },
          },
          {
            name: 'skin',
            program: { module: SHADER, vertexEntry: 'vs_second' },
            renderState: { tags: { LightMode: 'ShadowCaster' } },
          },
        ];
        if (reverse) passes.reverse();
        const material = new MaterialResource({
          ...left.source.material.snapshot,
          passes,
          materialProgramKeys: { rigid: SHADER, skin: SHADER },
        });
        const c = {
          ...f.context,
          validatedOrdered: [
            {
              ...left,
              source: {
                ...left.source,
                skinBinding: shared.first.snapshot.skinBinding,
                material,
                materials: [material],
              },
            },
          ],
          dispatch: passes.map((pass, passIndex) => ({
            ...defined(f.context.dispatch.at(0)),
            renderableIndex: 0,
            passIndex,
            vertexEntry: pass.program.vertexEntry,
          })),
          materialFrame: new MaterialDispatch().materials().with(material),
          materialSlots: [material.snapshot],
          materialSlotIndices: [[0]],
          pipelineState: { ...f.context.pipelineState, pbrSkinMeshBindGroupLayout: skinLayout },
          runtime: {
            ...f.context.runtime,
            demandSkinTask: demand,
            getMaterialShaderPipelineEntry: (...args: unknown[]) => ({
              pipeline: args[18] === 'vs_second' ? skinPipeline : f.pipeline,
              group2Contract: args[18] === 'vs_second' ? ('skin' as const) : ('mesh' as const),
            }),
          },
        } as _InternalRenderPipelineContext;
        for (const geometry of [false, true]) {
          const pixels = await depth(
            f,
            c,
            0,
            undefined,
            false,
            undefined,
            geometry,
            'forward',
            false,
            c.dispatch,
          );
          expect(
            pixels[8 * ROW_FLOATS + 8],
            `main=${geometry} missing=${missing} reverse=${reverse}`,
          ).toBe(0.25);
          expect(
            pixels[4 * ROW_FLOATS + 24],
            `main=${geometry} missing=${missing} reverse=${reverse}`,
          ).toBe(missing ? 0 : 0.375);
        }
      }
      await tasks.complete();
      shared.frames.discardFrame();
    }
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    await tasks.dispose();
    shared.dispose();
    f.close();
  }
}
