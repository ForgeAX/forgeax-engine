import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { type GraphBuffer, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type Buffer, ok, type RenderPipeline, type RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { batchLodLevelCount } from '../gpu-driven/batch-layout';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { FilteredProductionPlan } from '../gpu-driven/production-raster-prepare';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { buildGpuDrivenPbrInstancesBindGroupLayout } from '../pbr-pipeline';
import { worldRenderResources } from '../publication/resource-scope';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { recordGpuDrivenShadowIndirect } from '../record/shadow-pass';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  preparedPbrSnapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';
import { duplicateMeshVertices, editResidentMesh } from './managed-mesh-edit';
import { nativeDeviceFixture } from './native-device-fixture';

// A geometry witness, not a lighting surrogate: real production admission,
// compaction, mesh pipeline/BGs, indirect raster and GPU pixels are exercised.
// Standard PBR/skin lighting remain covered by the existing Dawn roster.
const WITNESS_WGSL = `
@vertex fn vs_scene_index(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(p.xy, p.z * 0.1 + 0.5, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;
async function fixture(mergedSources = false) {
  const { device, native } = await nativeDeviceFixture({
    requiredFeatures: ['depth32float-stencil8'],
  });
  const store = new GpuResidencyCache();
  const configure = () => store.configureGpuDevice(device, undefined, device.caps);
  configure();
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const pods = [-0.5, 0.5].map((x) => {
    const pod = createBoxGeometry(0.5, 0.5, 0.5).unwrap();
    const vertices = new Float32Array(pod.vertices);
    for (let i = 0; i < vertices.length; i += 12) vertices[i] = (vertices[i] ?? 0) + x;
    const position = new Float32Array(defined(pod.attributes.position) as Float32Array);
    for (let i = 0; i < position.length; i += 3) position[i] = (position[i] ?? 0) + x;
    return { ...pod, vertices, attributes: { ...pod.attributes, position } };
  });
  const handles = pods.map((pod) => assets.create(pod).unwrap());
  const meshes = pods.map((pod, index) =>
    store.ensureResident(defined(handles[index]), pod, worldRenderResources(world)).unwrap(),
  );
  const sharedLodMesh = mergedSources
    ? store
        .ensureResident(defined(handles[0]), defined(pods[0]), worldRenderResources(world), [
          {
            ...defined(pods[0]),
            indices: defined(pods[0]?.indices).slice(0, 12),
            submeshes: defined(pods[0]).submeshes.map((submesh) => ({
              ...submesh,
              indexCount: 12,
            })),
          },
        ])
        .unwrap()
    : undefined;
  const projection = new RenderScene();
  let sharedMaterial: MaterialResource | undefined;
  const snapshots = handles.map((handle, index): RenderableSnapshot => {
    const material = new MaterialResource({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
      materialHandle: index + 100,
      passes: [],
    });
    const matrix = mat4.identity(mat4.create());
    const transforms = new Float32Array(8 * 16);
    for (let ordinal = 0; ordinal < 8; ordinal++) transforms.set(matrix, ordinal * 16);
    const prepared = preparedPbrSnapshot({
      worldId: 0,
      entityKey: index + 1,
      assetHandle: Number(mergedSources ? defined(handles[0]) : handle),
      transform: { world: matrix },
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      instances: { transforms, instanceCount: 8, cacheKey: index + 1, archVersion: 1 },
      ...(mergedSources
        ? { lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }] }
        : {}),
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: defined(pods[index]?.indices).length,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'fixture',
          materialResourceClass: 'fixture',
          ...(mergedSources ? { lodRanges: [{ first: 0, count: 12, baseVertex: 0 }] } : {}),
        },
      ],
    });
    if (!mergedSources) return prepared;
    sharedMaterial ??= prepared.material;
    return { ...prepared, material: sharedMaterial, materials: [sharedMaterial] };
  });
  const delta = projection.apply(
    snapshots.map((snapshot) => ({
      kind: 'update' as const,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  const availability = GpuScene.create(device, 16).unwrap();
  if (availability.status !== 'available') throw new Error('Expected native GPU Scene capability');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(
    mergedSources ? 1 : 2,
  );
  const shader = (await rhi.createShaderModule(device, { code: WITNESS_WGSL })).unwrap();
  const selector = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      entries: [0, 1].map((binding) => ({
        binding,
        visibility: 1,
        buffer: { type: 'uniform' as const, hasDynamicOffset: true },
      })),
    })
    .unwrap();
  const materialLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    })
    .unwrap();
  const meshLayout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 1,
          buffer: { type: 'read-only-storage', hasDynamicOffset: true },
        },
      ],
    })
    .unwrap();
  const instancesLayout = buildGpuDrivenPbrInstancesBindGroupLayout(device, device.caps);
  const pipelineLayout = device
    .createPipelineLayout({
      bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
    })
    .unwrap();
  const uniforms = device.createBuffer({ size: 256, usage: 64 | 8 }).unwrap();
  device.queue.writeBuffer(uniforms, 0, new Float32Array(64)).unwrap();
  const entry = (binding: number) => ({
    binding,
    resource: { kind: 'buffer' as const, value: { buffer: uniforms, size: 16 } },
  });
  const viewGroup = device
    .createBindGroup({ layout: viewLayout, entries: [entry(0), entry(1)] })
    .unwrap();
  const materialGroup = device
    .createBindGroup({ layout: materialLayout, entries: [entry(0)] })
    .unwrap();
  const programs = standardPbrInputs(device, shader, viewLayout);
  const artifact = {
    ...programs.materialArtifact,
    program: createMaterialShaderProgram(WITNESS_WGSL),
  } as MaterialShaderArtifact;
  const state = {
    ...defined(programs.materialPipelineState),
    pbrPipelineLayout: pipelineLayout,
    gpuDrivenPbrPipelineLayout: pipelineLayout,
    meshBindGroupLayout: meshLayout,
    instancesBindGroupLayout: instancesLayout,
    gpuDrivenInstancesBindGroupLayout: instancesLayout,
    gpuDrivenPbrPrograms: new Map([
      ['forgeax::default-standard-pbr|color=false', { module: shader, artifact }],
    ]),
  };
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(selector) });
  const bySlot = new Map(
    projection
      .slotsSnapshot()
      .map((slot, index) => [slot.slot, sharedLodMesh ?? defined(meshes[index])]),
  );
  const input = {
    materialArtifact: artifact,
    materialPipelineState: state,
    scene: {
      scene: availability.scene,
      plan: topology.query(topology.sourcePlan(), undefined),
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: bySlot,
    viewBindGroupLayout: viewLayout,
    meshResidencyEpoch: store.meshResidencyEpoch,
  };
  const prepare = () => {
    input.meshResidencyEpoch = store.meshResidencyEpoch;
    const frame = production.prepare(admitGpuFixture(input)).unwrap();
    if (frame === undefined) throw new Error('Expected admitted prepared frame');
    return frame;
  };
  const unrelatedUpload = () => {
    const pod = createBoxGeometry(3, 3, 3).unwrap(),
      handle = assets.create(pod).unwrap();
    return store.ensureResident(handle, pod, worldRenderResources(world)).unwrap();
  };
  return {
    device,
    assets,
    native,
    viewGroup,
    materialGroup,
    snapshots,
    projection,
    scene: availability.scene,
    topology,
    selector,
    store,
    world,
    pods,
    handles,
    meshes,
    bySlot,
    input,
    production,
    configure,
    prepare,
    unrelatedUpload,
    close() {
      production.dispose();
      availability.scene.dispose();
      store.destroyAll();
      assets.dispose();
      device.destroyBuffer(uniforms);
      native.destroy();
    },
  };
}

interface RetainedWitness {
  signature?: string;
  compilations?: number;
  run?: (
    frame: ReturnType<Awaited<ReturnType<typeof fixture>>['prepare']>,
    commands: number[] | undefined,
    commandCount: number,
    offsets: readonly number[],
  ) => Promise<number[]>;
  dispose?: () => Promise<void>;
}

async function pixels(
  f: Awaited<ReturnType<typeof fixture>>,
  frame = f.prepare(),
  commands?: number[],
  commandCount = f.production.inspect().indirectDrawCount,
  retained?: RetainedWitness,
  production = f.production,
  stockRecording = false,
) {
  // Observe the producer's declared physical layout, then read real GPU words
  // in canonical draw order. Stable windows may contain retired holes, so a
  // dense prefix is not a witness for the commands actually submitted.
  const filtered = Reflect.get(production, 'filteredCache') as
    | { readonly value: FilteredProductionPlan }
    | undefined;
  const offsets = defined(filtered).value.plan.batches.flatMap((batch) =>
    Array.from(
      { length: batchLodLevelCount(batch) },
      (_, level) => batch.indirectOffset + level * 20,
    ),
  );
  expect(offsets).toHaveLength(commandCount);
  const signature = stockRecording
    ? (frame._recordingTopologySignature?.() ?? frame.topologySignature())
    : frame.topologySignature();
  if (retained?.run !== undefined && retained.signature === signature)
    return retained.run(frame, commands, commandCount, offsets);
  await retained?.dispose?.();
  let currentFrame = frame;
  const recordedDraws: Array<{ buffer: Buffer; offset: number }> = [];
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const main = frame
    .project(graph, 'rgba8unorm', 1, undefined, undefined, false, stockRecording)
    .unwrap();
  const output = graph
    .createTexture('witness-color', { format: 'rgba8unorm', size: { width: 32, height: 16 } })
    .unwrap();
  const outputView = graph.view(output).unwrap();
  const depth = graph
    .createTexture('witness-depth', {
      format: 'depth32float-stencil8',
      size: { width: 32, height: 16 },
    })
    .unwrap();
  const depthView = graph.view(depth).unwrap();
  const readbackBytes = 4096 + Math.max(64, commandCount * 20);
  const readback = f.device.createBuffer({ size: readbackBytes, usage: 1 | 8 }).unwrap();
  const destination = graph
    .importBuffer('witness-readback', { size: readbackBytes, usage: 1 | 8 }, () => readback)
    .unwrap();
  graph
    .addRasterPass('witness-raster', {
      accesses: [
        ...main.accesses,
        { resource: outputView, usage: 'color-attachment' },
        { resource: depthView, usage: 'depth-stencil-write' },
      ],
      colorAttachments: [
        {
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
      encode: ({ pass, resources }) => {
        const draw = pass.drawIndexedIndirect.bind(pass);
        const spy = vi.spyOn(pass, 'drawIndexedIndirect').mockImplementation((buffer, offset) => {
          recordedDraws.push({ buffer, offset });
          draw(buffer, offset);
        });
        try {
          main.encode(f.viewGroup, pass, resources, {
            ...currentFrame.standardPbrFrameResources,
            prepareMaterialBinding: (
              (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
              (slot: number) => {
                const group = groups[slot];
                return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
              }
            )([f.materialGroup]),
            materialSlotIndicesByBinding: new Map(),
            ...(stockRecording
              ? {
                  bundleDescriptor: {
                    colorFormats: ['rgba8unorm' as const],
                    depthStencilFormat: 'depth32float-stencil8' as const,
                    sampleCount: 1,
                  },
                }
              : {}),
          });
        } finally {
          spy.mockRestore();
        }
      },
    })
    .unwrap();
  graph
    .addCopyPass('witness-copy', {
      accesses: [
        { resource: outputView, usage: 'copy-src' },
        { resource: destination, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) =>
        encoder.copyTextureToBuffer(
          { texture: resources.texture(output).unwrap() },
          {
            buffer: resources.buffer(destination).unwrap(),
            bytesPerRow: 256,
            rowsPerImage: 16,
          },
          { width: 32, height: 16, depthOrArrayLayers: 1 },
        ),
    })
    .unwrap();
  if (commands !== undefined) {
    const indirect = defined(main.accesses.find((access) => access.usage === 'indirect-read'));
    graph
      .addCopyPass('witness-indirect', {
        accesses: [
          { resource: indirect.resource as GraphBuffer, usage: 'copy-src' },
          { resource: destination, usage: 'copy-dst' },
        ],
        // Commands have stable sparse addresses. Read exactly the calls that
        // raster consumed, preserving their canonical draw/LOD order rather
        // than assuming the live commands occupy the first N buffer records.
        encode: ({ encoder }) => {
          for (const [index, draw] of recordedDraws.entries()) {
            if (index >= commandCount) break;
            encoder.copyBufferToBuffer(draw.buffer, draw.offset, readback, 4096 + index * 20, 20);
          }
        },
      })
      .unwrap();
  }
  const compiled = graph
    .compile({ device: f.device, surfaceSize: { width: 32, height: 16 } })
    .unwrap();
  const capture = async (
    submitted: typeof frame,
    readCommands: number[] | undefined,
    count: number,
    submittedOffsets: readonly number[],
  ) => {
    expect(submittedOffsets).toHaveLength(count);
    currentFrame = submitted;
    recordedDraws.length = 0;
    const encoder = f.device.createCommandEncoder().unwrap();
    compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
    submitted._sealResourceReads().unwrap();
    f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completed = f.device.queue.onSubmittedWorkDone();
    submitted._trackSubmittedWork(completed);
    await completed;
    submitted._commitResourceReplacement();
    const mapped = (await readback.mapAsync(1)).unwrap();
    try {
      const result = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
      if (readCommands !== undefined) {
        const words = new Uint32Array(result.buffer, 4096, count * 5);
        for (let i = 0; i < words.length; i += 5)
          readCommands.push(words[i] ?? -1, words[i + 1] ?? -1);
      }
      return Array.from({ length: 16 }, (_, y) =>
        Array.from(result.subarray(y * 256, y * 256 + 128)),
      ).flat();
    } finally {
      mapped.unmap();
    }
  };
  const dispose = async () => {
    try {
      await compiled.retire();
    } finally {
      f.device.destroyBuffer(readback);
    }
  };
  if (retained !== undefined) {
    retained.signature = signature;
    retained.compilations = (retained.compilations ?? 0) + 1;
    retained.run = capture;
    retained.dispose = dispose;
    return capture(frame, commands, commandCount, offsets);
  }
  try {
    return await capture(frame, commands, commandCount, offsets);
  } finally {
    await dispose();
  }
}

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Expected fixture value');
  return value;
}

describe('GPU-driven resident mesh epochs on native Dawn', () => {
  it('keeps one stock graph across destroyed and replaced meshes with changing GPU pixels', async () => {
    const f = await fixture();
    const retained: RetainedWitness = {};
    f.native.pushErrorScope('validation');
    const read = () =>
      pixels(
        f,
        f.prepare(),
        undefined,
        f.production.inspect().indirectDrawCount,
        retained,
        f.production,
        true,
      );
    try {
      const original = await read();
      expect(original.filter((value) => value !== 0).length).toBeGreaterThan(0);
      const firstBundleBuilds = defined(f.production.inspect().preparedBundleBuilds);
      expect(firstBundleBuilds).toBeGreaterThan(0);
      expect(await read()).toEqual(original);
      expect(f.production.inspect().preparedBundleHits).toBeGreaterThan(0);
      const handle = defined(f.handles[0]),
        pod = defined(f.pods[0]),
        old = defined(f.meshes[0]);
      f.store.evictMesh(handle, worldRenderResources(f.world));
      expect(old.vertexBuffer.isDestroyed).toBe(true);
      const vertices = new Float32Array(pod.vertices);
      for (let index = 0; index < vertices.length; index += 12)
        vertices[index] = (vertices[index] ?? 0) + 4;
      const changed = f.store
        .ensureResident(handle, { ...pod, vertices }, worldRenderResources(f.world))
        .unwrap();
      f.bySlot.set(0, changed);
      const moved = await read();
      expect(moved).not.toEqual(original);
      expect(moved.filter((value) => value !== 0).length).toBeLessThan(
        original.filter((value) => value !== 0).length,
      );
      expect(retained.compilations).toBe(1);
      expect(f.production.inspect().preparedBundleBuilds).toBeGreaterThan(firstBundleBuilds);
      f.store.evictMesh(handle, worldRenderResources(f.world));
      expect(changed.vertexBuffer.isDestroyed).toBe(true);
      const restored = f.store.ensureResident(handle, pod, worldRenderResources(f.world)).unwrap();
      f.bySlot.set(0, restored);
      expect(await read()).toEqual(original);
      expect(retained.compilations).toBe(1);
      const validation = await f.native.popErrorScope();
      expect(validation, validation?.message).toBeNull();
    } finally {
      await retained.dispose?.();
      f.close();
    }
  }, 30_000);

  it('submits retained and mutated geometry, replacement, retire/reinsert, view/LOD and device owners with real pixel readback', async () => {
    const f = await fixture();
    const native = f.native;
    native.pushErrorScope('validation');
    try {
      const original = await pixels(f);
      expect(original.filter((v) => v !== 0).length).toBeGreaterThan(0);
      f.unrelatedUpload();
      expect(await pixels(f)).toEqual(original);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      const handle = defined(f.handles[0]),
        pod = defined(f.pods[0]),
        old = defined(f.meshes[0]);
      const firstEpoch = old.contentEpoch;
      const position = pod.attributes.position;
      if (!(position instanceof Float32Array)) throw new Error('Expected box position attribute');
      const movedPosition = new Float32Array(position);
      for (let index = 0; index < movedPosition.length; index += 3)
        movedPosition[index] = (movedPosition[index] ?? 0) + 4;
      editResidentMesh(
        f.assets,
        f.store,
        handle,
        () => {
          f.assets
            .writeRange(handle, { attribute: 'position', first: 0, values: movedPosition })
            .unwrap();
        },
        worldRenderResources(f.world),
      );
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBe(old);
      expect(old.contentEpoch).toBeGreaterThan(firstEpoch);
      const writtenEpoch = old.contentEpoch;
      const moved = await pixels(f);
      expect(moved).not.toEqual(original);
      expect(moved.filter((v) => v !== 0).length).toBeLessThan(
        original.filter((v) => v !== 0).length,
      );
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      const accepted = runtimeAssets(f.assets)
        .borrow<import('@forgeax/engine-types').MeshAsset>(handle)
        .unwrap();
      editResidentMesh(
        f.assets,
        f.store,
        handle,
        () => {
          f.assets.replace(handle, duplicateMeshVertices(accepted)).unwrap();
        },
        worldRenderResources(f.world),
      );
      const replacement = defined(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world)));
      expect(Object.is(replacement, old)).toBe(false);
      expect(replacement.contentEpoch).toBeGreaterThan(writtenEpoch);
      expect(Object.is(replacement.vertexBuffer, old.vertexBuffer)).toBe(false);
      expect(old.vertexBuffer.isDestroyed).toBe(true);
      expect(replacement.indexBuffer).toBe(old.indexBuffer);
      expect(old.indexBuffer?.isDestroyed).toBe(false);
      f.bySlot.set(0, replacement);
      expect(await pixels(f)).toEqual(moved);
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      f.store.evictMesh(handle, worldRenderResources(f.world));
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBeUndefined();
      expect(replacement.vertexBuffer.isDestroyed).toBe(true);
      const restored = editResidentMesh(
        f.assets,
        f.store,
        handle,
        () => {
          f.assets.replace(handle, pod).unwrap();
        },
        worldRenderResources(f.world),
      );
      expect(Object.is(restored, replacement)).toBe(false);
      expect(restored.contentEpoch).toBeGreaterThan(replacement.contentEpoch);
      f.bySlot.set(0, restored);
      expect(await pixels(f)).toEqual(original);
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      // Same-device configuration retains valid entries and their content epoch.
      // Residency destruction must clear the owner map before fresh admission.
      const restoredEpoch = restored.contentEpoch;
      f.configure();
      expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBe(restored);
      expect(restored.contentEpoch).toBe(restoredEpoch);
      expect(await pixels(f)).toEqual(original);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      f.unrelatedUpload();
      expect(await pixels(f)).toEqual(original);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      const beforeDestroy = [...f.bySlot.values()];
      f.store.destroyAll();
      for (const ownedHandle of f.handles)
        expect(
          f.store.getMeshGpuHandles(ownedHandle, worldRenderResources(f.world)),
        ).toBeUndefined();
      for (const entry of beforeDestroy) expect(entry.vertexBuffer.isDestroyed).toBe(true);
      f.bySlot.clear();
      f.configure();
      for (let i = 0; i < f.pods.length; i++) {
        const entry = f.store
          .ensureResident(defined(f.handles[i]), defined(f.pods[i]), worldRenderResources(f.world))
          .unwrap();
        expect(Object.is(entry, beforeDestroy[i])).toBe(false);
        expect(entry.contentEpoch).toBeGreaterThan(defined(beforeDestroy[i]).contentEpoch);
        f.bySlot.set(i, entry);
      }
      expect(await pixels(f)).toEqual(original);
      expect(f.production.inspect().preparedBatchBuilds).toBe(2);
      // View-dependent culling remains live when every resident mesh is
      // unchanged and reused; the geometry witness intentionally does not
      // implement lighting or the camera transform in its vertex stage.
      const camera = f.input.camera;
      const translated = new Float32Array(camera.world);
      translated[12] = 100;
      f.input.camera = { ...camera, world: translated, position: vec3.create(100, 0, 0) };
      expect((await pixels(f)).every((value) => value === 0)).toBe(true);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      f.input.camera = camera;
      expect(await pixels(f)).toEqual(original);
      // Imported LOD selection still uses current view scale and draw ranges
      // after a resident mesh cache hit; read actual GPU commands.
      const source = defined(f.snapshots[0]);
      const draw = defined(source.gpuDrivenDraws?.[0]);
      const lodSource: RenderableSnapshot = {
        ...source,
        lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 0, count: 12, baseVertex: 0 }] }],
      };
      const lower = {
        ...pod,
        indices: defined(pod.indices).slice(0, 12),
        submeshes: pod.submeshes.map((submesh) => ({ ...submesh, indexCount: 12 })),
      };
      const lodMesh = f.store
        .ensureResident(handle, pod, worldRenderResources(f.world), [lower])
        .unwrap();
      f.bySlot.set(0, lodMesh);
      const delta = f.projection.apply([
        {
          kind: 'update',
          worldId: source.worldId,
          entityKey: source.entityKey,
          snapshot: lodSource,
        },
      ]);
      f.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      // Structural publication may move the primitive slot; the producer's
      // current mesh projection follows the freshly extracted slot owner.
      for (const slot of f.projection.slotsSnapshot()) {
        const index = f.handles.findIndex((value) => Number(value) === slot.snapshot.assetHandle);
        f.bySlot.set(
          slot.slot,
          defined(
            f.store.getMeshGpuHandles(defined(f.handles[index]), worldRenderResources(f.world)),
          ),
        );
      }
      f.input.scene = {
        ...f.input.scene,
        plan: f.topology.query(f.topology.sourcePlan(), undefined),
        slots: f.projection.slotsSnapshot(),
      };
      const lodWorld = new Float32Array(camera.world);
      lodWorld[14] = 5;
      f.input.camera = {
        ...camera,
        projection: 'orthographic',
        world: lodWorld,
        position: vec3.create(0, 0, 5),
        orthoLeft: -10,
        orthoRight: 10,
        orthoBottom: -10,
        orthoTop: 10,
      };
      const commands: number[] = [];
      await pixels(f, f.prepare(), commands);
      expect(commands).toEqual([36, 0, 12, 8, 36, 8]);
      f.unrelatedUpload();
      const retainedCommands: number[] = [];
      await pixels(f, f.prepare(), retainedCommands);
      expect(retainedCommands).toEqual(commands);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      const replacementDevice = await fixture();
      const replacementNative = replacementDevice.native;
      replacementNative.pushErrorScope('validation');
      try {
        expect(Object.is(replacementDevice.device, f.device)).toBe(false);
        const replacementEntry = replacementDevice.store.getMeshGpuHandles(
          defined(replacementDevice.handles[0]),
          worldRenderResources(replacementDevice.world),
        );
        expect(replacementEntry).toBe(replacementDevice.meshes[0]);
        expect(Object.is(replacementEntry, restored)).toBe(false);
        expect(Object.is(replacementEntry?.vertexBuffer, restored.vertexBuffer)).toBe(false);
        expect(await pixels(replacementDevice)).toEqual(original);
        const replacementValidation = await replacementNative.popErrorScope();
        expect(replacementValidation, replacementValidation?.message).toBeNull();
      } finally {
        replacementDevice.close();
      }
      const validation = await native.popErrorScope();
      expect(validation, validation?.message).toBeNull();
    } finally {
      f.close();
    }
  }, 30_000);
});

describe('incremental filtered contributions on native Dawn', () => {
  it('matches full projection pixels and indirect membership across source merge, edits, bindings, claims and owner reset', async () => {
    const f = await fixture(true),
      native = f.native;
    native.pushErrorScope('validation');
    let bindings = new Map<string, string>();
    const reference = new GpuDrivenProduction(f.device, {
      createShaderModule: () => ok(f.selector),
    });
    let overrides: Partial<Parameters<GpuDrivenProduction['prepare']>[0]> = {
      materialBindingClasses: bindings,
    };
    const prepareInput = () => ({
      ...f.input,
      ...overrides,
      materialBindingClasses: bindings,
      meshResidencyEpoch: f.store.meshResidencyEpoch,
    });
    const witness = async () => {
      const actual = defined(f.production.prepare(admitGpuFixture(prepareInput())).unwrap());
      const commands: number[] = [];
      const value = await pixels(f, actual, commands, f.production.inspect().indirectDrawCount);
      // Reference traverses every prepared source contribution. Only this
      // synchronous prepare is instrumented; candidate uses its real cache owner.
      const fullUpdate = FilteredPlanContributionOwner.prototype.update;
      const spy = vi
        .spyOn(FilteredPlanContributionOwner.prototype, 'update')
        .mockImplementation((prepared, materialBindings, profile) =>
          fullUpdate.call(new FilteredPlanContributionOwner(), prepared, materialBindings, profile),
        );
      let old: ReturnType<GpuDrivenProduction['prepare']>;
      try {
        old = reference.prepare(admitGpuFixture(prepareInput()));
      } finally {
        spy.mockRestore();
      }
      const oldFrame = defined(old.unwrap()),
        oldCommands: number[] = [];
      expect(
        await pixels(
          f,
          oldFrame,
          oldCommands,
          reference.inspect().indirectDrawCount,
          undefined,
          reference,
        ),
      ).toEqual(value);
      expect(commands).toEqual(oldCommands);
      for (const slot of f.projection.slotsSnapshot())
        for (const [index, draw] of (slot.snapshot.gpuDrivenDraws ?? []).entries())
          expect(actual.selection.owns(slot.snapshot, draw, index)).toBe(
            oldFrame.selection.owns(slot.snapshot, draw, index),
          );
      return { value, commands, frame: actual };
    };
    const publish = (changes: Parameters<RenderScene['apply']>[0]) => {
      const delta = f.projection.apply(changes);
      f.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      f.bySlot.clear();
      for (const slot of f.projection.slotsSnapshot())
        f.bySlot.set(
          slot.slot,
          defined(f.store.getMeshGpuHandles(defined(f.handles[0]), worldRenderResources(f.world))),
        );
      f.input.scene = {
        ...f.input.scene,
        plan: f.topology.query(f.topology.sourcePlan(), undefined),
        slots: f.projection.slotsSnapshot(),
      };
    };
    try {
      const initial = await witness();
      expect(initial.value.some((value) => value !== 0)).toBe(true);
      // Both author sources share one geometry/material binding.
      expect(f.projection.slotsSnapshot()).toHaveLength(2);
      expect(f.input.scene.plan.batches).toHaveLength(1);
      expect(f.production.inspect().batchCount).toBe(1);
      expect(
        initial.commands.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0),
      ).toBe(16);
      f.unrelatedUpload();
      await witness();
      expect(f.production.inspect().filteredBatchBuilds).toBe(0);
      const first = defined(f.snapshots[0]),
        instance = defined(first.instances);
      const reduced = {
        ...first,
        instances: {
          ...instance,
          transforms: instance.transforms.slice(0, 4 * 16),
          instanceCount: 4,
          archVersion: 2,
        },
      };
      publish([
        { kind: 'update', worldId: first.worldId, entityKey: first.entityKey, snapshot: reduced },
      ]);
      const edited = await witness();
      expect(edited.commands.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0)).toBe(
        12,
      );
      // Changing effective binding values in the same mutable Map splits and rejoins groups.
      bindings = new Map(bindings);
      bindings.set(`${first.worldId}:${first.entityKey}`, 'distinct-current-binding');
      await witness();
      expect(f.production.inspect().batchCount).toBe(2);
      bindings = new Map();
      await witness();
      expect(f.production.inspect().batchCount).toBe(1);
      const shadowMaterial = first.material;
      shadowMaterial.adopt({
        ...shadowMaterial.snapshot,
        passes: [
          ...shadowMaterial.snapshot.passes,
          {
            name: 'shadow',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'ShadowCaster' } },
          },
        ],
        materialProgramKeys: {
          ...shadowMaterial.snapshot.materialProgramKeys,
          shadow: 'forgeax::default-standard-pbr',
        },
      });
      f.scene.sync({ ...f.projection.apply([]), materialUpdates: [shadowMaterial] }).unwrap();
      overrides = { ...overrides, shadowViews: true };
      const claims = await witness();
      const claimFrame = defined(f.production.prepare(admitGpuFixture(prepareInput())).unwrap());
      const shadowIdentity = { kind: 'directional' as const, index: 0, layer: 'static' as const };
      const firstSlot = defined(
        f.projection.slotsSnapshot().find((slot) => slot.snapshot.entityKey === first.entityKey),
      );
      const countShadowSources = () => {
        const selection = defined(claimFrame.shadowViewPool?.submission(shadowIdentity)).selection;
        return f.projection
          .slotsSnapshot()
          .filter((slot) => selection.ownsSlot(slot.snapshot, 0, slot.slot, slot.generation))
          .length;
      };
      defined(claimFrame.updateShadowViews)([
        {
          identity: shadowIdentity,
          planes: new Float32Array(24),
          candidatePrimitiveIndices: [firstSlot.slot],
        },
      ]).unwrap();
      expect(countShadowSources()).toBe(1);
      defined(claimFrame.updateShadowViews)([
        { identity: shadowIdentity, planes: new Float32Array(24), candidatePrimitiveIndices: [] },
      ]).unwrap();
      expect(countShadowSources()).toBe(0);
      expect(claims.value).toBeDefined();
      claimFrame._abortResourceReplacement?.();
      publish([{ kind: 'remove', worldId: first.worldId, entityKey: first.entityKey }]);
      expect(
        (await witness()).commands.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0),
      ).toBe(8);
      publish([
        { kind: 'update', worldId: first.worldId, entityKey: first.entityKey, snapshot: first },
      ]);
      const reinserted = await witness();
      expect(reinserted.value).toEqual(initial.value);
      expect(
        reinserted.commands.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0),
      ).toBe(16);
      const camera = f.input.camera,
        translated = new Float32Array(camera.world);
      translated[12] = 100;
      f.input.camera = { ...camera, world: translated, position: vec3.create(100, 0, 0) };
      expect((await witness()).value.every((value) => value === 0)).toBe(true);
      f.input.camera = camera;
      f.configure();
      f.unrelatedUpload();
      expect((await witness()).value).toEqual(initial.value);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      const reset = new GpuDrivenProduction(f.device, { createShaderModule: () => ok(f.selector) });
      try {
        const resetFrame = defined(reset.prepare(admitGpuFixture(prepareInput())).unwrap()),
          resetCommands: number[] = [];
        expect(
          await pixels(
            f,
            resetFrame,
            resetCommands,
            reset.inspect().indirectDrawCount,
            undefined,
            reset,
          ),
        ).toEqual(initial.value);
        expect(resetCommands).toEqual(reinserted.commands);
      } finally {
        reset.dispose();
      }
      const error = await native.popErrorScope();
      expect(error, error?.message).toBeNull();
    } finally {
      reference.dispose();
      f.close();
    }
  }, 30_000);
});

it('reuses one compiled raster across binding order, unused keys and live split/rejoin with native readback', async () => {
  const f = await fixture(true);
  const reference = new GpuDrivenProduction(f.device, { createShaderModule: () => ok(f.selector) });
  const retained: RetainedWitness = {};
  f.native.pushErrorScope('validation');
  try {
    const firstSource = defined(f.snapshots[0]);
    const bindings = new Map<string, string>([
      [`${firstSource.worldId}:${firstSource.entityKey}`, 'split-binding'],
    ]);
    const signatures: string[] = [];
    let baseline: number[] | undefined;
    for (let sequence = 0; sequence < 6; sequence++) {
      if (sequence === 1) bindings.set('99:9999:12345', 'not-consumed');
      if (sequence === 2) bindings.clear();
      if (sequence === 3) {
        bindings.set('99:9999:12345', 'changed-unused');
        bindings.set(`${firstSource.worldId}:${firstSource.entityKey}`, 'split-again');
      }
      if (sequence === 4) bindings.delete('99:9999:12345');
      if (sequence === 5) bindings.clear();
      const materialBindingClasses = new Map(sequence === 4 ? [...bindings].reverse() : bindings);
      const input = { ...f.input, materialBindingClasses };
      const frame = defined(f.production.prepare(admitGpuFixture(input)).unwrap());
      const commands: number[] = [];
      const count = f.production.inspect().indirectDrawCount;
      expect(f.production.inspect().batchCount).toBe(sequence === 2 || sequence === 5 ? 1 : 2);
      expect(count).toBe(sequence === 2 || sequence === 5 ? 2 : 4);
      signatures.push(frame.topologySignature());
      const value = await pixels(f, frame, commands, count, retained);
      baseline ??= value;
      expect(value).toEqual(baseline);
      expect(value.some((byte) => byte !== 0)).toBe(true);
      expect(value.some((byte) => byte === 0)).toBe(true);
      expect(
        commands.filter((_, index) => index % 2 === 1).reduce((sum, count) => sum + count, 0),
      ).toBe(16);
      const fresh = defined(reference.prepare(admitGpuFixture(input)).unwrap());
      const freshCommands: number[] = [];
      expect(
        await pixels(
          f,
          fresh,
          freshCommands,
          reference.inspect().indirectDrawCount,
          undefined,
          reference,
        ),
      ).toEqual(value);
      expect(freshCommands).toEqual(commands);
    }
    expect(retained.compilations).toBe(1);
    expect(new Set(signatures).size).toBe(1);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    try {
      await retained.dispose?.();
    } finally {
      reference.dispose();
      f.close();
    }
  }
}, 30_000);

it('retains main pipelines and shadow depth across unique receipt churn and local program edits for 60 native frames', async () => {
  const f = await fixture();
  const retained: RetainedWitness = {};
  let production = f.production;
  const main = f.input.materialArtifact;
  const receipt = defined(main.receipt);
  const rows = f.snapshots.map((snapshot, index) => {
    const id = `fixture::receipt-churn-${index}`;
    snapshot.material.adopt({
      ...snapshot.material.snapshot,
      materialShaderId: id,
      passes: [
        {
          name: 'forward',
          program: { module: id },
          renderState: { tags: { LightMode: 'Forward' } },
        },
        {
          name: 'shadow',
          program: { module: id },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
      materialProgramKeys: { forward: id, shadow: id },
    });
    return snapshot;
  });
  const delta = f.projection.apply(
    rows.map((snapshot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  f.scene.sync(delta).unwrap();
  f.topology.apply(delta);
  const materials = new Map(
    rows.map((snapshot, index) => [
      defined(snapshot.material.snapshot.materialShaderId),
      {
        ...main,
        material: defined(snapshot.material.snapshot.materialShaderId),
        receipt: { ...receipt, receiptIdentity: `${receipt.receiptIdentity}:${index}` },
      },
    ]),
  );
  const mainModule = (await rhi.createShaderModule(f.device, { code: WITNESS_WGSL })).unwrap();
  const materialPipelineFactory: NonNullable<
    Parameters<GpuDrivenProduction['prepare']>[0]['materialPipelineFactory']
  > = (
    _material,
    _hdr,
    _state,
    topology,
    _index,
    _variant,
    _pass,
    _attributes,
    samples,
    format,
    _uv,
    _depth,
    _layout,
    projection,
  ) => ({
    group2Contract: 'mesh',
    pipeline: f.device
      .createRenderPipeline({
        layout: f.input.materialPipelineState.pbrPipelineLayout,
        vertex: {
          module: mainModule,
          entryPoint: 'vs_scene_index',
          buffers: [
            {
              arrayStride: defined(projection).arrayStride,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        fragment: {
          module: mainModule,
          entryPoint: 'fs_main',
          targets: [{ format: format ?? 'rgba8unorm' }],
        },
        primitive: { topology: topology ?? 'triangle-list', cullMode: 'none' },
        multisample: { count: samples ?? 1 },
        depthStencil: {
          format: 'depth32float-stencil8',
          depthWriteEnabled: true,
          depthCompare: 'greater',
        },
      })
      .unwrap(),
  });
  const depthProgram = (depth: number) =>
    createMaterialShaderProgram(`
    @vertex fn vs_scene_index(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
      return vec4<f32>(p.xy, ${depth}, 1.0);
    }
  `);
  const a = depthProgram(0.25),
    b = depthProgram(0.75);
  const shadows = new Map(
    [...materials].map(([key, artifact]) => [key, { ...artifact, program: a }]),
  );
  const changed = defined([...shadows.values()][1]);
  const views = [0, 1].map((index) => ({
    identity: { kind: 'directional' as const, index, layer: 'static' as const },
    planes: new Float32Array(24),
    candidatePrimitiveIndices: [index],
  }));
  const targets = views.map(() =>
    f.device
      .createTexture({ size: { width: 32, height: 16 }, format: 'depth32float', usage: 16 | 1 })
      .unwrap(),
  );
  const targetViews = targets.map((texture) => f.device.createTextureView(texture, {}).unwrap());
  const readback = f.device.createBuffer({ size: 8192, usage: 1 | 8 }).unwrap();
  const pipelines = new Map<string, RenderPipeline>();
  let compute:
    | ReturnType<
        ReturnType<RenderGraphBuilder<{ encoder: RhiCommandEncoder }>['compile']>['unwrap']
      >
    | undefined;
  let computeSignature: string | undefined;
  let computeBuilds = 0;
  let baseline: number[] | undefined;
  const rasterCounts = [0, 0];
  const pipelineCreates = vi.spyOn(f.device, 'createRenderPipeline');
  f.native.pushErrorScope('validation');
  try {
    for (let index = 0; index < 60; index++) {
      if (index === 30) changed.program = b;
      if (index === 40) changed.program = a;
      if (index === 45) {
        await compute?.retire();
        compute = undefined;
        await retained.dispose?.();
        delete retained.run;
        delete retained.dispose;
        production.dispose();
        production = new GpuDrivenProduction(f.device, {
          createShaderModule: () => ok(f.selector),
        });
      }
      const slots = f.projection.slotsSnapshot();
      const input = {
        ...f.input,
        materialArtifacts: materials,
        materialPipelineFactory,
        shadowMaterialArtifacts: shadows,
        scene: {
          ...f.input.scene,
          plan: f.topology.query(f.topology.sourcePlan(), undefined),
          slots,
        },
        shadowViews: true,
      };
      let frame = defined(production.prepare(admitGpuFixture(input)).unwrap());
      frame
        .updateShadowViews?.(
          views.map((view, viewIndex) => ({
            ...view,
            candidatePrimitiveIndices:
              viewIndex === 1 && index >= 10 && index < 20 ? [] : view.candidatePrimitiveIndices,
          })),
        )
        .unwrap();
      if (index === 40) {
        frame._abortResourceReplacement?.();
        frame = defined(production.prepare(admitGpuFixture(input)).unwrap());
        frame
          .updateShadowViews?.(
            views.map((view, viewIndex) => ({
              ...view,
              candidatePrimitiveIndices:
                viewIndex === 1 && index >= 10 && index < 20 ? [] : view.candidatePrimitiveIndices,
            })),
          )
          .unwrap();
      }
      const pool = defined(frame.shadowViewPool);
      if (compute === undefined || computeSignature !== frame.topologySignature()) {
        await compute?.retire();
        const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
        for (const { identity } of views) pool.project(graph, identity, true).unwrap();
        compute = graph
          .compile({ device: f.device, surfaceSize: { width: 32, height: 16 } })
          .unwrap();
        computeSignature = frame.topologySignature();
        computeBuilds++;
      }
      const encoder = f.device.createCommandEncoder().unwrap();
      compute.execute({ encoder }).unwrap();
      for (const [viewIndex, { identity }] of views.entries()) {
        if (pool.cacheState(identity) !== 'hit') {
          rasterCounts[viewIndex] = (rasterCounts[viewIndex] ?? 0) + 1;
          const submitted = defined(pool.submission(identity));
          const projections = defined(
            frame.shadowBatchProjections?.()?.get(shadowViewIdentityKey(identity)),
          );
          const batches = [];
          for (const batch of submitted.plan.batches) {
            const projection = defined(projections.get(batch.batchId));
            const artifact = projection.shadowArtifact;
            const key = artifact.program.identity;
            let pipeline = pipelines.get(key);
            if (pipeline === undefined) {
              const module = (
                await rhi.createShaderModule(f.device, { code: artifact.program.source })
              ).unwrap();
              pipeline = f.device
                .createRenderPipeline({
                  layout: f.input.materialPipelineState.pbrPipelineLayout,
                  vertex: {
                    module,
                    entryPoint: 'vs_scene_index',
                    buffers: [
                      {
                        arrayStride: projection.mesh.layoutProjection.arrayStride,
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
              pipelines.set(key, pipeline);
            }
            batches.push({
              indirectOffset: batch.indirectOffset,
              pipeline,
              meshBindGroup: projection.meshBindGroup,
              visibleBindGroups: projection.visibleBindGroups,
              deformation: projection.deformation,
              materialGroup: f.materialGroup,
              vertexBuffer: projection.mesh.vertexBuffer.handle,
              indexBuffer: defined(projection.mesh.indexBuffer).handle,
              indexFormat: projection.mesh.indexFormat,
            });
          }
          const pass = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: defined(targetViews[viewIndex]),
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          });
          pass.setBindGroup(0, f.viewGroup, [0, 0]);
          recordGpuDrivenShadowIndirect(pass, { view: submitted.view, batches });
          pass.end();
        }
        encoder.copyTextureToBuffer(
          { texture: defined(targets[viewIndex]) },
          { buffer: readback, offset: viewIndex * 4096, bytesPerRow: 256, rowsPerImage: 16 },
          { width: 32, height: 16, depthOrArrayLayers: 1 },
        );
      }
      f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await f.device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const depths = new Float32Array(mapped.getMappedRange().unwrap());
      try {
        for (let viewIndex = 0; viewIndex < 2; viewIndex++) {
          const depth =
            viewIndex === 0
              ? 0.25
              : index >= 10 && index < 20
                ? 0
                : index >= 30 && index < 40
                  ? 0.75
                  : 0.25;
          const left = viewIndex === 0 ? 4 : 20;
          for (let y = 0; y < 16; y++) {
            const expected = Array.from({ length: 32 }, (_, x) =>
              y >= 6 && y < 10 && x >= left && x < left + 8 ? depth : 0,
            );
            const offset = viewIndex * 1024 + y * 64;
            expect([...depths.subarray(offset, offset + 32)]).toEqual(expected);
          }
        }
      } finally {
        mapped.unmap();
      }
      const value = await pixels(
        f,
        frame,
        undefined,
        production.inspect().indirectDrawCount,
        retained,
        production,
      );
      expect(
        pipelineCreates.mock.calls.filter(
          ([descriptor]) => descriptor.depthStencil?.format === 'depth32float-stencil8',
        ),
      ).toHaveLength(index < 45 ? 4 : 8);
      baseline ??= value;
      expect(value).toEqual(baseline);
      expect(value.some((byte) => byte !== 0)).toBe(true);
    }
    expect(computeBuilds).toBe(2);
    expect(retained.compilations).toBe(2);
    expect(rasterCounts[0]).toBe(2); // First frame and new owner; an unrelated abort keeps its depth.
    expect(rasterCounts[1]).toBe(6); // Plus removal, return, program replacement and aborted reversal.
    expect(
      pipelineCreates.mock.calls.filter(
        ([descriptor]) => descriptor.depthStencil?.format === 'depth32float-stencil8',
      ),
    ).toHaveLength(8);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    pipelineCreates.mockRestore();
    await compute?.retire();
    await retained.dispose?.();
    production.dispose();
    for (const target of targets) f.device.destroyTexture(target).unwrap();
    f.device.destroyBuffer(readback).unwrap();
    f.close();
  }
}, 60_000);
