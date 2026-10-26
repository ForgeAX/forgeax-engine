import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import {
  type CompiledRenderGraph,
  type GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type { Buffer, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import {
  batchLevelStride,
  batchLodLevelCount,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
} from '../gpu-driven/batch-layout';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { LodViewCamera } from '../gpu-driven/lod-projection.wgsl';
import {
  GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL,
  GPU_DRIVEN_VIEW_WGSL,
  GpuDrivenView,
} from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { SkinFrames, SkinSceneInputs } from '../scene/skin-scene-inputs';
import {
  type SurfaceSubmissionCandidate,
  SurfaceSubmissionObservationOwner,
} from '../surface/submission-observation';
import { updateGpuView } from './helpers/gpu-input-read-domain';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

const GPU_MAP_MODE_READ = 0x0001;

const material = new MaterialResource({
  passes: [],
  baseColor: vec3.create(0.25, 0.5, 0.75),
  metallic: 0.1,
  roughness: 0.9,
});

function snapshot(entityKey: number, x: number): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;

  return {
    assetHandle: 3,
    transform: { world: new Float32Array(world) },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 3,
        count: 36,
        baseVertex: -2,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque-pbr',
        materialResourceClass: 'plain',
        geometry: {
          receipt: {
            identity: 'view-fixture',
            vertexInputs: [],
            topology: 'triangle-list',
            indexed: true,
          },
          draw: { kind: 'indexed', first: 3, count: 36, baseVertex: -2, topology: 'triangle-list' },
          deformation: 'rigid',
        },
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

export interface GpuDrivenViewGpuEvidence {
  readonly visibleInstance: number;
  readonly indexCount: number;
  readonly instanceCount: number;
  readonly firstIndex: number;
  readonly baseVertex: number;
  readonly firstInstance: number;
  readonly overflow: number;
  readonly persistentTranslationX: number;
  readonly firstReadbackFrame: number;
  readonly recoveredReadbackFrame: number;
  readonly firstVisible: number;
  readonly recoveredVisible: number;
}

export interface GpuDrivenViewLifecycleEvidence {
  readonly frames: number;
  readonly bufferRebuilds: number;
  readonly candidateCapacity: number;
}

export async function runGpuDrivenViewLifecycleEvidence(
  frames = 60,
): Promise<GpuDrivenViewLifecycleEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven lifecycle raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_WGSL,
      label: 'gpu-driven-view-lifecycle',
    })
  ).unwrap();
  const projection = new RenderScene();
  const sceneAvailability = GpuScene.create(device, 8).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  const topology = new BatchTopology();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const retirements: Array<Promise<unknown>> = [];
  let activeCount = 0;
  let previous: CompiledRenderGraph<{ readonly encoder: RhiCommandEncoder }> | undefined;
  for (let frame = 0; frame < frames; frame += 1) {
    const targetCount = frame < 4 ? 2 ** frame : frame % 2 === 0 ? 1 : 8;
    const operations: Array<
      | {
          readonly kind: 'update';
          readonly worldId: number;
          readonly entityKey: number;
          readonly snapshot: RenderableSnapshot;
        }
      | { readonly kind: 'remove'; readonly worldId: number; readonly entityKey: number }
    > = [];
    while (activeCount < targetCount) {
      activeCount += 1;
      operations.push(updateSnapshot(snapshot(activeCount, activeCount * 0.05)));
    }
    while (activeCount > targetCount) {
      operations.push({ kind: 'remove', worldId: 0, entityKey: activeCount });
      activeCount -= 1;
    }
    const delta = projection.apply(operations);
    sceneAvailability.scene.sync(delta).unwrap();
    topology.apply(delta);
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      planes,
    ).unwrap();

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    if (previous !== undefined) retirements.push(previous.retire());
    view._commitResourceReplacement();
    const encoder = device
      .createCommandEncoder({ label: `gpu-driven-lifecycle-${frame}` })
      .unwrap();
    compiled.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    previous = compiled;
  }

  await device.queue.onSubmittedWorkDone();
  if (previous !== undefined) retirements.push(previous.retire());
  await Promise.all(retirements);
  const validationError = await rawDevice.popErrorScope();
  if (validationError !== null) {
    throw new Error(`GPU-driven lifecycle validation failed: ${validationError.message}`);
  }
  const inspection = view.inspect();
  view.dispose();
  sceneAvailability.scene.dispose();
  await device.queue.onSubmittedWorkDone();
  return {
    frames,
    bufferRebuilds: inspection.bufferRebuilds,
    candidateCapacity: inspection.candidateCapacity,
  };
}

function lodEvidenceCamera(height: number): LodViewCamera {
  const span = (2 * 0.25 * Math.sqrt(3)) / height;
  return {
    position: new Float32Array([0, 0, 5]),
    projection: 'orthographic',
    fov: 0,
    orthoTop: span / 2,
    orthoBottom: -span / 2,
  } as unknown as LodViewCamera;
}

/** Material routing changes batch execution while both geometry ranges stay resident. */
export async function runGpuDrivenInactiveBatchEvidence() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven routing raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const projection = new RenderScene();
  const delta = projection.apply([
    updateSnapshot(snapshot(1, 0)),
    updateSnapshot({ ...snapshot(2, 0.2), assetHandle: 4 }),
  ]);
  const available = GpuScene.create(device, 2).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = available.scene;
  scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const source = topology.query(topology.sourcePlan(), undefined);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const readback = device
    .createBuffer({ size: 40, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const results: { instances: number[]; sharedInputUploadBytes: number }[] = [];
  try {
    for (const enabled of [true, false, true]) {
      const plan = {
        ...source,
        batches: source.batches.map((batch, index) =>
          index === 0 && !enabled ? { ...batch, visibleCapacity: 0 } : batch,
        ),
      };
      updateGpuView(view, plan, scene, planes).unwrap();
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      view.addPasses(graph).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      view._commitResourceReplacement();
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      const indirect = view.indirectBuffer;
      if (indirect === undefined) throw new Error('Missing indirect commands');
      for (let index = 0; index < source.batches.length; index++) {
        const batch = source.batches.at(index);
        if (batch === undefined) throw new Error('Missing source batch');
        encoder.copyBufferToBuffer(indirect, batch.indirectOffset, readback, index * 20, 20);
      }
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const words = new Uint32Array(mapped.getMappedRange().unwrap());
      results.push({
        instances: [words[1] ?? -1, words[6] ?? -1],
        sharedInputUploadBytes: view.inspect().sharedInputUploadBytes,
      });
      mapped.unmap();
      await compiled.retire();
    }
    const error = await rawDevice.popErrorScope();
    if (error !== null) throw new Error(`GPU-driven routing validation failed: ${error.message}`);
    return results;
  } finally {
    device.destroyBuffer(readback);
    view.dispose();
    scene.dispose();
  }
}

/**
 * A row removed between encoding a frame and mapping its LOD readback: the
 * decoded members still name the (slot, generation) encoded with that copy,
 * and the current scene no longer holds that generation, so joins drop it.
 */
export async function runGpuDrivenLodReadbackGenerationEvidence() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const projection = new RenderScene();
  const delta = projection.apply([
    updateSnapshot(snapshot(1, 0)),
    updateSnapshot(snapshot(2, 0.2)),
  ]);
  const available = GpuScene.create(device, 2).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = available.scene;
  scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  try {
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    updateGpuView(view, topology.query(topology.sourcePlan(), undefined), scene, planes).unwrap();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    view._commitResourceReplacement();
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const encoded = projection.slotsSnapshot();
    const removed = encoded.lookup(0, 1);
    if (removed === undefined) throw new Error('Missing encoded row');
    // The scene moves on before the readback maps; the view keeps its plan.
    scene.sync(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }])).unwrap();
    await device.queue.onSubmittedWorkDone();
    const selection = await view.readLodSelection();
    await compiled.retire();
    const current = projection.slotsSnapshot();
    return {
      removedSlotAllocated: scene.instanceIndexForSlot(removed.slot, 0) !== undefined,
      members: (selection?.actualMembers ?? [])
        .map((member) => ({
          slot: member.primitiveIndex,
          encodedGeneration:
            member.generation === encoded.slotAt(member.primitiveIndex)?.generation,
          current: current.slotAt(member.primitiveIndex)?.generation === member.generation,
        }))
        .sort((left, right) => left.slot - right.slot),
      removedSlot: removed.slot,
    };
  } finally {
    view.dispose();
    scene.dispose();
  }
}

export async function runGpuDrivenViewGpuEvidence(): Promise<GpuDrivenViewGpuEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven evidence raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_WGSL,
      label: 'gpu-driven-view-evidence',
    })
  ).unwrap();
  const projection = new RenderScene();
  const visibleInstance = mat4.identity(mat4.create());
  const culledInstance = mat4.identity(mat4.create());
  culledInstance[12] = 10;
  const instanced = snapshot(1, 0);
  const instancedDraw = instanced.gpuDrivenDraws?.[0];
  if (instancedDraw === undefined) throw new Error('GPU-driven LOD fixture unavailable');
  const instancedWithLod: RenderableSnapshot = {
    ...instanced,
    lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
    gpuDrivenDraws: [
      {
        ...instancedDraw,
        lodRanges: [{ first: 9, count: 12, baseVertex: 4 }],
      },
    ],
  };
  const delta = projection.apply([
    updateSnapshot({
      ...instancedWithLod,
      instances: {
        transforms: new Float32Array([...visibleInstance, ...culledInstance]),
        instanceCount: 2,
        cacheKey: 1,
        archVersion: 1,
      },
    }),
    updateSnapshot(snapshot(2, 10)),
  ]);
  const sceneAvailability = GpuScene.create(device, 2).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  sceneAvailability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  updateGpuView(
    view,
    topology.query(topology.sourcePlan(), undefined),
    sceneAvailability.scene,
    frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    lodEvidenceCamera(0.3),
  ).unwrap();
  const lodBatch = topology
    .query(topology.sourcePlan(), undefined)
    .batches.find((batch) => batch.lod !== undefined);
  if (lodBatch === undefined) throw new Error('GPU-driven LOD batch unavailable');
  // Level 1 owns the batch's second command and second visible segment.
  const lodCommandOffset = lodBatch.indirectOffset + GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
  const lodVisibleByteOffset = (lodBatch.visibleBase + batchLevelStride(lodBatch)) * 16;
  const visible = view.visibleBuffer;
  const indirect = view.indirectBuffer;
  const overflow = view.overflowBuffer;
  if (visible === undefined || indirect === undefined || overflow === undefined) {
    throw new Error('GPU-driven output buffers unavailable');
  }
  const visibleReadback = device
    .createBuffer({
      label: 'gpu-driven-visible-readback',
      size: 4,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const indirectReadback = device
    .createBuffer({
      label: 'gpu-driven-indirect-readback',
      size: 20,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const overflowReadback = device
    .createBuffer({
      label: 'gpu-driven-overflow-readback',
      size: 4,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const persistentTransformReadback = device
    .createBuffer({
      label: 'gpu-driven-persistent-transform-readback',
      size: 64,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const submissionOwner = new SurfaceSubmissionObservationOwner(() => 1);
  const beginSubmission = (frameId: number, indirectOffset: number): SurfaceSubmissionCandidate => {
    const candidate = submissionOwner.begin({
      frameId,
      requestedLane: 'gpu-driven',
      deviceGeneration: 1,
      resourceGeneration: view.inspect().resourceGeneration,
    });
    for (const pass of ['nearest-layer', 'color'] as const) {
      candidate.record(pass, {
        kind: 'draw-indexed-indirect',
        indirectBufferIdentity: getOpaqueResourceIdentity(indirect as object),
        indirectOffset,
        pipelineIdentity: 33,
      });
    }
    return candidate;
  };
  let currentSubmission = beginSubmission(10, lodCommandOffset);
  view.setTelemetrySubmit({ frameId: 1, deviceGeneration: 0 });
  view.addPasses(graph, 'gpu-driven', true, () => currentSubmission).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-evidence' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  encoder.copyBufferToBuffer(visible, lodVisibleByteOffset, visibleReadback, 0, 4);
  encoder.copyBufferToBuffer(indirect, lodCommandOffset, indirectReadback, 0, 20);
  encoder.copyBufferToBuffer(overflow, view.overflowByteOffset, overflowReadback, 0, 4);
  encoder.copyBufferToBuffer(
    sceneAvailability.scene.transformBuffer,
    0,
    persistentTransformReadback,
    0,
    64,
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  currentSubmission.submit(device.queue.onSubmittedWorkDone(), 1);

  // Start observing immediately, then submit the cached graph again before
  // the first mapAsync settles. The second copy must be skipped while the
  // readback is pending; compute/raster work remains submit-able.
  const pendingLodSelection = view.readLodSelection();
  if (view.readLodSelection() !== pendingLodSelection) {
    throw new Error('GPU-driven LOD telemetry did not coalesce concurrent observers');
  }
  const overlappingEncoder = device
    .createCommandEncoder({ label: 'gpu-driven-evidence-overlap' })
    .unwrap();
  compiled.execute({ encoder: overlappingEncoder }).unwrap();
  device.queue.submit([overlappingEncoder.finish().unwrap()]).unwrap();
  const lodSelection = await pendingLodSelection;
  if (lodSelection === undefined) {
    throw new Error('GPU-driven LOD selection readback unavailable or incomplete');
  }
  if (lodSelection.batches.length !== lodSelection.batchCount) {
    throw new Error('GPU-driven LOD selection readback unavailable or incomplete');
  }
  const surfaceIndirectParameters = lodSelection.surfaceIndirectParameters;
  if (surfaceIndirectParameters === undefined || surfaceIndirectParameters.length !== 2) {
    throw new Error('GPU-driven Surface indirect parameter readback unavailable');
  }
  const firstSurfaceCommand = surfaceIndirectParameters[0];
  if (
    firstSurfaceCommand === undefined ||
    firstSurfaceCommand.sequence !== lodSelection.surfaceReadback?.sequence ||
    firstSurfaceCommand.frameId !== lodSelection.surfaceReadback?.frameId ||
    firstSurfaceCommand.deviceGeneration !== lodSelection.surfaceReadback?.deviceGeneration ||
    firstSurfaceCommand.resourceGeneration !== lodSelection.surfaceReadback?.resourceGeneration ||
    firstSurfaceCommand.pass !== 'nearest-layer' ||
    firstSurfaceCommand.indirectOffset !== lodCommandOffset ||
    firstSurfaceCommand.count !== 12 ||
    firstSurfaceCommand.instanceCount !== 1 ||
    firstSurfaceCommand.first !== 9 ||
    firstSurfaceCommand.baseVertex !== 4 ||
    firstSurfaceCommand.firstInstance !== 0
  ) {
    throw new Error(
      `GPU-driven Surface indirect parameters do not match the submitted batch: ${JSON.stringify({
        firstSurfaceCommand,
        surfaceReadback: lodSelection.surfaceReadback,
      })}`,
    );
  }
  if (
    lodSelection.submit === undefined ||
    lodSelection.submit.frameId !== 1 ||
    lodSelection.submit.deviceGeneration !== 0
  ) {
    throw new Error('GPU-driven LOD telemetry lost the copy submit identity');
  }
  await device.queue.onSubmittedWorkDone();

  // After unmap, a later cached-graph submission must restore telemetry
  // observation rather than leaving the latch permanently consumed.
  const recoveryProjection = mat4.identity(mat4.create());
  recoveryProjection[12] = 10;
  updateGpuView(
    view,
    topology.query(topology.sourcePlan(), undefined),
    sceneAvailability.scene,
    frustum.fromViewProjection(frustum.create(), recoveryProjection),
  ).unwrap();
  view.setTelemetrySubmit({ frameId: 2, deviceGeneration: 0 });
  const recoveryEncoder = device
    .createCommandEncoder({ label: 'gpu-driven-evidence-recovery' })
    .unwrap();
  currentSubmission = beginSubmission(11, 32);
  compiled.execute({ encoder: recoveryEncoder }).unwrap();
  device.queue.submit([recoveryEncoder.finish().unwrap()]).unwrap();
  currentSubmission.submit(device.queue.onSubmittedWorkDone(), 1);
  await device.queue.onSubmittedWorkDone();
  const recoveredLodSelection = await view.readLodSelection();
  if (
    recoveredLodSelection === undefined ||
    recoveredLodSelection === lodSelection ||
    recoveredLodSelection.visible === lodSelection.visible ||
    lodSelection.surfaceReadback?.frameId !== 10 ||
    recoveredLodSelection.surfaceReadback?.frameId !== 11
  ) {
    throw new Error('GPU-driven LOD telemetry did not recover after a skipped copy');
  }
  if (
    recoveredLodSelection.surfaceIndirectParameters?.some(
      (command) =>
        command.sequence !== recoveredLodSelection.surfaceReadback?.sequence ||
        command.frameId !== recoveredLodSelection.surfaceReadback?.frameId ||
        command.deviceGeneration !== recoveredLodSelection.surfaceReadback?.deviceGeneration ||
        command.resourceGeneration !== recoveredLodSelection.surfaceReadback?.resourceGeneration,
    )
  ) {
    throw new Error('GPU-driven recovered Surface indirect parameters lost readback identity');
  }
  if (
    recoveredLodSelection.submit === undefined ||
    recoveredLodSelection.submit.frameId !== 2 ||
    recoveredLodSelection.submit.deviceGeneration !== 0
  ) {
    throw new Error('GPU-driven LOD telemetry reused a stale submit identity');
  }
  if (
    lodSelection.surfaceReadback === undefined ||
    recoveredLodSelection.surfaceReadback === undefined
  ) {
    throw new Error('GPU-driven LOD telemetry lost Surface readback identity');
  }
  const validationError = await rawDevice.popErrorScope();
  if (validationError !== null) {
    throw new Error(`GPU-driven telemetry overlap validation failed: ${validationError.message}`);
  }

  const visibleMap = (await visibleReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const visibleValue = new DataView(visibleMap.getMappedRange().unwrap()).getUint32(0, true);
  visibleMap.unmap();
  const indirectMap = (await indirectReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const indirectValue = new DataView(indirectMap.getMappedRange().unwrap().slice(0));
  indirectMap.unmap();
  const overflowMap = (await overflowReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const overflowValue = new DataView(overflowMap.getMappedRange().unwrap()).getUint32(0, true);
  overflowMap.unmap();
  const persistentTransformMap = (
    await persistentTransformReadback.mapAsync(GPU_MAP_MODE_READ)
  ).unwrap();
  const persistentTranslationX = new DataView(
    persistentTransformMap.getMappedRange().unwrap(),
  ).getFloat32(12 * 4, true);
  persistentTransformMap.unmap();

  const evidence = {
    visibleInstance: visibleValue,
    indexCount: indirectValue.getUint32(0, true),
    instanceCount: indirectValue.getUint32(4, true),
    firstIndex: indirectValue.getUint32(8, true),
    baseVertex: indirectValue.getInt32(12, true),
    firstInstance: indirectValue.getUint32(16, true),
    overflow: overflowValue,
    persistentTranslationX,
    firstReadbackFrame: lodSelection.surfaceReadback.frameId,
    recoveredReadbackFrame: recoveredLodSelection.surfaceReadback.frameId,
    firstVisible: lodSelection.visible,
    recoveredVisible: recoveredLodSelection.visible,
  };
  view.dispose();
  sceneAvailability.scene.dispose();
  device.destroyBuffer(visibleReadback);
  device.destroyBuffer(indirectReadback);
  device.destroyBuffer(overflowReadback);
  device.destroyBuffer(persistentTransformReadback);
  return evidence;
}

export interface GpuDrivenViewOcclusionFrame {
  readonly visible: number;
  readonly culled: number;
  readonly late: number;
  readonly bufferRebuilds: number;
  /** Byte offset raster binds the late mirror's first window at. */
  readonly lateVisibleByteOffset: number;
  /** Non-empty late-phase indirect commands and their mirror windows. */
  readonly lateCommands: readonly GpuDrivenViewLateCommand[];
}

export interface GpuDrivenViewLateCommand {
  readonly instanceCount: number;
  readonly firstInstance: number;
  /** The late window holds exactly the union suffix after the early prefix. */
  readonly mirrorMatchesUnion: boolean;
}

const OCCLUSION_PYRAMID_SIZE = 64;

async function readBufferBytes(
  device: RhiDevice,
  source: Buffer,
  size: number,
): Promise<Uint32Array> {
  const readback = device
    .createBuffer({ size, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-occlusion-readback' }).unwrap();
  encoder.copyBufferToBuffer(source, 0, readback, 0, size);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
  const words = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
  mapped.unmap();
  device.destroyBuffer(readback);
  return words;
}

/**
 * Read every non-empty late command and compare its visible window (mirror
 * region, instance zero) against the union suffix the main command draws.
 */
async function readLateCommands(
  device: RhiDevice,
  view: GpuDrivenView,
  topology: BatchTopology,
): Promise<readonly GpuDrivenViewLateCommand[]> {
  const inspection = view.inspect();
  const visibleBuffer = view.visibleBuffer;
  const indirectBuffer = view.indirectBuffer;
  if (visibleBuffer === undefined || indirectBuffer === undefined) {
    throw new Error('GPU-driven occlusion view buffers unavailable');
  }
  const mirrorBase = inspection.visibleBufferCapacity;
  const lateArgsBase = (inspection.indirectCapacity * GPU_DRIVEN_INDIRECT_COMMAND_BYTES) / 4;
  const visible = await readBufferBytes(device, visibleBuffer, mirrorBase * 16 * 2);
  const indirect = await readBufferBytes(
    device,
    indirectBuffer,
    inspection.indirectCapacity * GPU_DRIVEN_INDIRECT_COMMAND_BYTES * 2,
  );
  const commands: GpuDrivenViewLateCommand[] = [];
  for (const batch of topology.query(topology.sourcePlan(), undefined).batches) {
    const stride = batchLevelStride(batch);
    for (let level = 0; level < batchLodLevelCount(batch); level += 1) {
      const args = (batch.indirectOffset + level * GPU_DRIVEN_INDIRECT_COMMAND_BYTES) / 4;
      const unionCount = indirect[args + 1] ?? 0;
      const instanceCount = indirect[lateArgsBase + args + 1] ?? 0;
      if (instanceCount === 0) continue;
      const segment = batch.visibleBase + level * stride;
      const early = unionCount - instanceCount;
      let mirrorMatchesUnion = true;
      for (let item = 0; item < instanceCount * 4; item += 1) {
        const union = visible[(segment + early) * 4 + item];
        const mirror = visible[(mirrorBase + segment) * 4 + item];
        if (union !== mirror) mirrorMatchesUnion = false;
      }
      commands.push({
        instanceCount,
        firstInstance: indirect[lateArgsBase + args + 4] ?? -1,
        mirrorMatchesUnion,
      });
    }
  }
  return commands;
}
const OCCLUSION_EMPTY = 3.402823e38;

type WallCoverage = 'none' | 'left' | 'all';

/**
 * A furthest-depth pyramid whose wall at distance 5 covers no texel, the left
 * half of the screen, or all of it; everything else holds the empty clear.
 */
function createWallPyramid(device: RhiDevice) {
  const levels = Math.log2(OCCLUSION_PYRAMID_SIZE) + 1;
  const descriptor = {
    format: 'r32float',
    size: { width: OCCLUSION_PYRAMID_SIZE, height: OCCLUSION_PYRAMID_SIZE },
    mipLevelCount: levels,
    usage: 0x04 | 0x02,
  } as const;
  const texture = device
    .createTexture({ label: 'gpu-driven-occlusion-pyramid', ...descriptor })
    .unwrap();
  const view = device.createTextureView(texture, { mipLevelCount: levels }).unwrap();
  return {
    write(wall: WallCoverage): void {
      for (let level = 0; level < levels; level += 1) {
        const size = OCCLUSION_PYRAMID_SIZE >> level;
        const texels = new Float32Array(size * size).fill(OCCLUSION_EMPTY);
        // A furthest reduction keeps the wall only where every source texel had it.
        if (wall === 'all') texels.fill(5);
        if (wall === 'left' && size > 1) {
          for (let y = 0; y < size; y += 1) texels.fill(5, y * size, y * size + size / 2);
        }
        device.queue
          .writeTexture(
            { texture, mipLevel: level, origin: [0, 0, 0] },
            texels,
            { offset: 0, bytesPerRow: size * 4, rowsPerImage: size },
            { width: size, height: size, depthOrArrayLayers: 1 },
          )
          .unwrap();
      }
    },
    import<FrameCtx extends { readonly encoder: RhiCommandEncoder }>(
      graph: RenderGraphBuilder<FrameCtx>,
    ): GraphTextureView {
      const imported = graph
        .importTexture('occlusion-evidence-pyramid', descriptor, () => texture)
        .unwrap();
      return graph.importView(imported, { mipLevelCount: levels }, () => view).unwrap();
    },
    dispose(): void {
      device.destroyTexture(texture);
    },
  };
}

/** Reversed-Z orthographic camera at the origin looking down -Z. */
function occlusionEvidenceCamera() {
  const near = 0.1;
  const far = 100;
  const viewProjection = mat4.identity(mat4.create());
  viewProjection[0] = 0.5;
  viewProjection[5] = 0.5;
  viewProjection[10] = 1 / (far - near);
  viewProjection[14] = far / (far - near);
  return {
    viewProjection,
    planes: frustum.fromViewProjection(frustum.create(), viewProjection),
    occlusionCamera: {
      viewProjection: new Float32Array(viewProjection),
      near,
      far,
      orthographic: true,
      historyKey: 'occlusion-evidence',
    },
  };
}

/**
 * Two-phase HZB evidence on the real GPU API. A furthest pyramid whose left
 * half holds a wall at distance 5 fronts three unit cubes at distance 10:
 * one fully behind the wall, one straddling its edge, one beside it. Frame 0
 * has no history; frame 1 runs the full two-phase path; frame 2 removes the
 * wall, so the hidden cube must come back through the late phase. With
 * `grow`, frame 2 keeps the wall and instead adds cubes beside it so the view
 * buffers rebuild; the hidden cube must still skip the early phase.
 */
export async function runGpuDrivenViewOcclusionEvidence(
  options: {
    readonly occlusionFootprintScale?: number;
    readonly grow?: boolean;
    /** Request `indirect-first-instance`; the late phase must not depend on it. */
    readonly firstInstanceIndirect?: boolean;
  } = {},
): Promise<readonly GpuDrivenViewOcclusionFrame[]> {
  const { occlusionFootprintScale, grow = false, firstInstanceIndirect = true } = options;
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(
      firstInstanceIndirect ? { requiredFeatures: ['indirect-first-instance'] } : {},
    )
  ).unwrap();
  if ((device.caps.firstInstanceIndirect === true) !== firstInstanceIndirect) {
    throw new Error('GPU-driven occlusion device capability does not match the request');
  }
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven occlusion raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_WGSL,
      label: 'gpu-driven-view-occlusion',
    })
  ).unwrap();
  const projection = new RenderScene();
  const at = (entityKey: number, x: number) => {
    const value = snapshot(entityKey, x);
    const world = new Float32Array(value.transform.world);
    world[14] = -10;
    return updateSnapshot({ ...value, transform: { world } });
  };
  // Cube bounds span uv x +-0.0625 around 0.25 + x / 4; the wall ends at 0.5.
  // The hidden cube is the last instance so its visible item is never all
  // zeros, which would hide an unwritten late mirror.
  const delta = projection.apply([1, -0.2, -1].map((x, index) => at(index + 1, x)));
  const sceneAvailability = GpuScene.create(device, 16).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  sceneAvailability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
    ...(occlusionFootprintScale === undefined ? {} : { occlusionFootprintScale }),
  }).unwrap();
  const { planes, occlusionCamera } = occlusionEvidenceCamera();
  const pyramid = createWallPyramid(device);

  let lateVisibleBase = 0;
  const compileFrame = () => {
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const importedPyramidView = pyramid.import(graph);
    const resources = view
      .addPasses(graph, 'gpu-driven', true, undefined, undefined, true)
      .unwrap();
    if (resources.addLateOcclusion === undefined) {
      throw new Error('GPU-driven occlusion did not reserve a late phase');
    }
    lateVisibleBase = resources.addLateOcclusion(importedPyramidView).unwrap().lateVisibleBase;
    return graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  };

  const frames: GpuDrivenViewOcclusionFrame[] = [];
  const retirements: Array<Promise<unknown>> = [];
  let compiled: CompiledRenderGraph<{ readonly encoder: RhiCommandEncoder }> | undefined;
  for (const wall of grow ? [true, true, true] : [true, true, false]) {
    if (grow && frames.length === 2) {
      const grown = projection.apply([4, 5, 6, 7, 8].map((entityKey) => at(entityKey, 1)));
      sceneAvailability.scene.sync(grown).unwrap();
      topology.apply(grown);
    }
    pyramid.write(wall ? 'left' : 'none');
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      sceneAvailability.scene,
      planes,
      undefined,
      0,
      undefined,
      undefined,
      occlusionCamera,
    ).unwrap();
    const rebuilds = view.inspect().bufferRebuilds;
    if (compiled === undefined || rebuilds !== frames.at(-1)?.bufferRebuilds) {
      if (compiled !== undefined) retirements.push(compiled.retire());
      compiled = compileFrame();
      view._commitResourceReplacement();
    }
    const encoder = device
      .createCommandEncoder({ label: `gpu-driven-occlusion-${frames.length}` })
      .unwrap();
    compiled.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const selection = await view.readLodSelection();
    if (selection?.occlusion === undefined) {
      throw new Error('GPU-driven occlusion readback lost its late-phase facts');
    }
    frames.push({
      visible: selection.visible,
      culled: selection.occlusion.culled,
      late: selection.occlusion.late,
      bufferRebuilds: rebuilds,
      lateVisibleByteOffset: lateVisibleBase * 16,
      lateCommands: await readLateCommands(device, view, topology),
    });
  }

  if (compiled !== undefined) retirements.push(compiled.retire());
  await Promise.all(retirements);
  const validationError = await rawDevice.popErrorScope();
  view.dispose();
  sceneAvailability.scene.dispose();
  pyramid.dispose();
  if (validationError !== null) {
    throw new Error(`GPU-driven occlusion validation failed: ${validationError.message}`);
  }
  return frames;
}

export interface GpuDrivenShadowCameraCullFrame {
  readonly visible: number;
  readonly cameraCulled: number;
}

/**
 * Shadow-caster camera culling on the real GPU API. Three unit-quarter cubes
 * sit 10 units in front of the evidence camera at x = -1 (fully behind the
 * left-half wall), -0.45 (behind the wall, one PCF footprint from its edge)
 * and +1 (visible). `light: 'camera'` looks along the camera's -Z, so each
 * caster's receiver prism projects onto its own screen rectangle. `light:
 * 'side'` looks along +X, so every prism sweeps across the unwalled right
 * half, where its receivers are visible even though the caster is hidden.
 * `light: 'singular'` is the side light without its depth row.
 */
export async function runGpuDrivenShadowCameraCullEvidence(options: {
  readonly light: 'camera' | 'side' | 'singular';
  readonly wall: WallCoverage;
  /** Omit to leave the cull input unset: the bound kernel must admit all. */
  readonly ndcDilation?: number;
}): Promise<GpuDrivenShadowCameraCullFrame> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('GPU-driven shadow cull raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (
    await rhi.createShaderModule(device, {
      code: GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL,
      label: 'gpu-driven-view-shadow-camera-cull',
    })
  ).unwrap();
  const projection = new RenderScene();
  const delta = projection.apply(
    [-1, -0.45, 1].map((x, index) => {
      const value = snapshot(index + 1, x);
      const world = new Float32Array(value.transform.world);
      world[14] = -10;
      return updateSnapshot({ ...value, transform: { world } });
    }),
  );
  const sceneAvailability = GpuScene.create(device, 16).unwrap();
  if (sceneAvailability.status !== 'available') throw new Error('GPU Scene unavailable');
  sceneAvailability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
    shadowCameraCull: true,
  }).unwrap();
  const { viewProjection, occlusionCamera } = occlusionEvidenceCamera();
  // Reversed-Z orthographic light along +X: ndc = (0.5 (z + 10), 0.5 y, (50 - x) / 100).
  const side = new Float32Array(16);
  side[8] = 0.5;
  side[12] = 5;
  side[5] = 0.5;
  // 'singular' drops the depth row, so the light matrix has no inverse.
  side[2] = options.light === 'singular' ? 0 : -0.01;
  side[14] = 0.5;
  side[15] = 1;
  const lightViewProjection = options.light === 'camera' ? new Float32Array(viewProjection) : side;
  const planes = frustum.fromViewProjection(frustum.create(), lightViewProjection);
  const pyramid = createWallPyramid(device);
  pyramid.write(options.wall);
  updateGpuView(
    view,
    topology.query(topology.sourcePlan(), undefined),
    sceneAvailability.scene,
    planes,
    undefined,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    options.ndcDilation === undefined
      ? undefined
      : {
          camera: occlusionCamera,
          lightViewProjection,
          ndcDilation: options.ndcDilation,
          worldDilation: 0,
        },
  ).unwrap();
  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  view
    .addPasses(graph, 'gpu-driven', true, undefined, undefined, false, pyramid.import(graph))
    .unwrap();
  if (!view.cameraCullBound) throw new Error('GPU-driven shadow cull did not bind the pyramid');
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  view._commitResourceReplacement();
  const encoder = device.createCommandEncoder({ label: 'gpu-driven-shadow-cull' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const selection = await view.readLodSelection();
  if (selection === undefined) throw new Error('GPU-driven shadow cull readback unavailable');
  const submitAgain = () => {
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  submitAgain();
  await device.queue.onSubmittedWorkDone();
  const pendingCounts = view.readCullingCounts();
  // The cached graph must skip its telemetry copy while this map is pending,
  // while retaining all cull and indirect work. Both observations use the
  // same submitted counters, including positive camera-cull fixtures.
  submitAgain();
  const counts = await pendingCounts;
  await device.queue.onSubmittedWorkDone();
  if (
    counts?.cameraCulled !== selection.cameraCulled ||
    counts?.texelCulled !== selection.texelCulled
  ) {
    throw new Error('GPU-driven shadow counter observation differs from full selection');
  }
  await compiled.retire();
  const validationError = await rawDevice.popErrorScope();
  view.dispose();
  sceneAvailability.scene.dispose();
  pyramid.dispose();
  if (validationError !== null) {
    throw new Error(`GPU-driven shadow cull validation failed: ${validationError.message}`);
  }
  return { visible: selection.visible, cameraCulled: selection.cameraCulled };
}

/** Real selector execution: one geometry root changes 1024 candidates without a candidate upload. */
export async function runSharedGeometryCullEvidence() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('shared geometry raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const available = GpuScene.create(device, 4096).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = available.scene;
  const projection = new RenderScene();
  const topology = new BatchTopology();
  const resource = new MaterialResource({
    passes: [],
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    materialParamSchema: [{ name: 'displacementTexture', type: 'texture2d' }],
    paramSnapshot: { displacementScale: 0, displacementBias: 0 },
  });
  const first = new MeshFrame().with(0, 3, {
    ...BUILTIN_CUBE,
    aabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
  });
  const delta = projection.apply(
    Array.from({ length: 1024 }, (_, i) =>
      updateSnapshot({ ...snapshot(i + 1, 5), material: resource, materials: [resource] }),
    ),
  );
  scene.sync({ ...delta, meshes: first }).unwrap();
  topology.apply(delta);
  const source = topology.query(topology.sourcePlan(), undefined);
  const old = scene.captureResources().unwrap();
  const oldGeometry = old.indexForGeometry(0, 3, first.get(0, 3));
  const oldMaterial = old.indexForResource(resource);
  if (oldGeometry === undefined || oldMaterial === undefined)
    throw new Error('shared descriptor unavailable');
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const readback = device
    .createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const frames: { visible: number; sharedInputUploadBytes: number }[] = [];
  const draw = async (geometryAddress: number, materialAddress: number) => {
    const plan = {
      ...source,
      batches: source.batches.map((batch) => ({ ...batch, geometryAddress, materialAddress })),
    };
    updateGpuView(view, plan, scene, planes).unwrap();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    view._commitResourceReplacement();
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder }).unwrap();
    if (view.indirectBuffer === undefined) throw new Error('shared geometry command unavailable');
    encoder.copyBufferToBuffer(view.indirectBuffer, 0, readback, 0, 20);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
    const words = new Uint32Array(mapped.getMappedRange().unwrap());
    frames.push({
      visible: words[1] ?? -1,
      sharedInputUploadBytes: view.inspect().sharedInputUploadBytes,
    });
    mapped.unmap();
    await compiled.retire();
  };
  // Measured edits must not cross an arena capacity doubling, which uploads
  // the whole arena; reserve headroom before the first (full) upload.
  const headroom = scene.inputs.arena.allocateDescriptor(16_384);
  scene.inputs.arena.releaseDescriptor(headroom, 16_384);
  try {
    await draw(oldGeometry, oldMaterial);
    const wide = first.with(0, 3, {
      ...BUILTIN_CUBE,
      aabb: new Float32Array([-6, -0.25, -0.25, 0.25, 0.25, 0.25]),
    });
    const inputBytes = scene.inputs.uploadBytes;
    const tableBytes = scene.sync({ ...projection.apply([]), meshes: wide }).unwrap().bytes;
    const currentGeometry = scene.geometryIndexForResource(0, 3);
    if (currentGeometry === undefined) throw new Error('current geometry unavailable');
    await draw(currentGeometry, oldMaterial);
    const geometryUpload = tableBytes + scene.inputs.uploadBytes - inputBytes;
    await draw(oldGeometry, oldMaterial);
    resource.adopt({
      ...resource.snapshot,
      paramSnapshot: { displacementScale: 8, displacementBias: 0 },
    });
    scene.sync({ ...projection.apply([]), materialUpdates: [resource] }).unwrap();
    const currentMaterial = scene.materialIndexForResource(resource);
    if (currentMaterial === undefined) throw new Error('current material unavailable');
    await draw(oldGeometry, currentMaterial);
    await draw(oldGeometry, oldMaterial);
    const error = await rawDevice.popErrorScope();
    if (error !== null) throw new Error(`shared geometry validation failed: ${error.message}`);
    return { frames, geometryUpload };
  } finally {
    old.release();
    device.destroyBuffer(readback);
    view.dispose();
    scene.dispose();
  }
}

/** The candidate and palette addresses intentionally disagree on a real selector dispatch. */
export async function runGpuDrivenSkinVisibleAddressEvidence() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) throw new Error('Skin visible raw device unavailable');
  rawDevice.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const readback = device
    .createBuffer({
      size: 16,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const projection = new RenderScene();
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw new Error('Skin visible GPU Scene unavailable');
  const scene = available.scene;
  const skin = new SkinSceneInputs(scene.inputs.arena, () => ({
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: mat4.identity(mat4.create()),
  }));
  const skinFrames = new SkinFrames(skin);
  const topology = new BatchTopology();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  let compiled: CompiledRenderGraph<{ readonly encoder: RhiCommandEncoder }> | undefined;
  try {
    const base = snapshot(1, 0);
    const source: RenderableSnapshot = {
      ...base,
      gpuDrivenDraws:
        base.gpuDrivenDraws?.map((draw) => ({
          ...draw,
          pipelineClass: 'skin-pbr',
          geometry: { ...draw.geometry, deformation: 'skin' },
        })) ?? [],
      skinBinding: { skeleton: 7, joints: [19] },
    };
    const background = snapshot(2, 10);
    const draw = background.gpuDrivenDraws?.[0];
    if (draw === undefined) throw new Error('Skin visible background draw unavailable');
    const rigid: RenderableSnapshot = {
      ...background,
      gpuDrivenDraws: [0, 1].map((drawItemIndex) => ({
        ...draw,
        drawItemIndex,
        first: 3 + drawItemIndex * 36,
        geometry: {
          ...draw.geometry,
          draw: { ...draw.geometry.draw, first: 3 + drawItemIndex * 36 },
        },
      })),
    };
    // Two culled submesh executions share physical instance0. The skin is
    // therefore instance1 but candidate2, with independent palette base17.
    const delta = projection.apply([updateSnapshot(rigid), updateSnapshot(source)]);
    skin.apply(delta);
    const pose = mat4.identity(mat4.create());
    pose[12] = 7;
    skin.joint(0, 19, pose);
    const frame = skinFrames.prepareFrame(projection.slotsSnapshot());
    if (frame === undefined) throw new Error('Skin visible fixed input unavailable');
    // Numeric GPU allocation order deliberately differs from true Scene slots.
    scene.sync({ ...delta, createdSlots: [...delta.createdSlots].reverse() }).unwrap();
    topology.apply(delta);
    const plan = topology.query(topology.sourcePlan(), undefined);
    if (plan.candidateCount !== 3 || plan.batches.length !== 3)
      throw new Error('Skin visible fixture must admit three actual draw candidates');
    const skinBatch = plan.batches.find((batch) => batch.binding?.geometry.deformation === 'skin');
    if (skinBatch === undefined) throw new Error('Skin visible actual batch unavailable');
    updateGpuView(
      view,
      plan,
      scene,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      frame,
    ).unwrap();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const visible = view.visibleBuffer;
    if (visible === undefined) throw new Error('Skin visible output unavailable');
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder }).unwrap();
    encoder.copyBufferToBuffer(visible, skinBatch.visibleBase * 16, readback, 0, 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
    const words = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const visibleInstance = words[0];
    if (visibleInstance === undefined || visibleInstance >= 4)
      throw new Error('Skin visible row outside the captured Instance table');
    const validation = await rawDevice.popErrorScope();
    if (validation !== null) throw new Error(`Skin visible validation: ${validation.message}`);
    return {
      visibleInstance,
      candidateIndex: words[2],
      sourceSlot: frame.slots.lookup(0, source.entityKey)?.slot,
      primitiveIndex: scene.primitiveIndexForSlot(1),
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    await compiled?.retire();
    view.dispose();
    skin.dispose();
    scene.dispose();
    device.destroyBuffer(readback).unwrap();
  }
}
