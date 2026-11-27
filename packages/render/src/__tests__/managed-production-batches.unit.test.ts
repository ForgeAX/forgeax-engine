import { createBoxGeometry } from '@forgeax/engine-geometry';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BatchTopology,
  matchesResidentGroupPlan,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import type { ShadowProjectionSource } from '../gpu-driven/production-raster-shadow';
import { GPU_TASK_HEADER_BYTES } from '../gpu-driven/task-header';
import { GpuScene } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { MaterialResource } from '../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialDispatch, MaterialFrame } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { SkinFrames, SkinSceneInputs } from '../scene/skin-scene-inputs';
import { createRenderWorld } from '../world/render-world';
import {
  type FrameRecording,
  recordFrameTransaction,
  submitFrameRecordings,
} from './frame-recording-driver';
import { observeCandidateReads } from './gpu-driven-candidate-read-observer';
import { mesh, standardPbrInputs } from './gpu-driven-production-fixture';
import { collectWeakOwners } from './weak-owner-collection-fixture';

async function fixture(
  count: number,
  transparent = false,
  shadowCasters: boolean | 'static' = false,
  splitMaterials = false,
  skinned = false,
  residency = false,
  initialMeshes?: MeshFrame,
  acceptedMaterials = false,
) {
  const shadows = shadowCasters !== false;
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'fixture' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const pbr = standardPbrInputs(device, shader, viewLayout);
  const materialPipelineState = pbr.materialPipelineState;
  assert(materialPipelineState);
  const receipt = createStandardPbrArtifactReceipt(skinned);
  if (skinned) {
    const skinLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
          { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
        ],
      })
      .unwrap();
    Object.assign(pbr, { materialArtifact: { ...pbr.materialArtifact, receipt } });
    Object.assign(materialPipelineState, {
      gpuDrivenPbrSkinPipelineLayout: materialPipelineState.gpuDrivenPbrPipelineLayout,
      pbrSkinMeshBindGroupLayout: skinLayout,
      gpuDrivenSkinPrimitiveBindGroupLayout: skinLayout,
    });
  }
  const opaque: MaterialSnapshot = {
    materialHandle: 7,
    materialShaderId: 'forgeax::default-standard-pbr',
    baseColor: vec3.create(1, 0, 0),
    metallic: 0,
    roughness: 0.5,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
      ...(shadows
        ? [
            {
              name: 'shadow',
              program: { module: 'forgeax::default-standard-pbr' },
              renderState: { tags: { LightMode: 'ShadowCaster' } },
            },
          ]
        : []),
    ],
    materialProgramKeys: {
      forward: 'forgeax::default-standard-pbr',
      ...(shadows ? { shadow: 'forgeax::default-standard-pbr' } : {}),
    },
  };
  const blended: MaterialSnapshot = {
    ...opaque,
    transparent: true,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: {
          tags: { LightMode: 'Forward' },
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      },
    ],
  };
  const material = new MaterialResource(transparent ? blended : opaque);
  // A distinct texture binding keeps the second material in its own batch.
  const secondMaterial = new MaterialResource({
    ...opaque,
    materialHandle: 8,
    textureHandles: new Map([['baseColorTexture', 8]]),
  } as unknown as MaterialSnapshot);
  const draw = {
    kind: 'indexed' as const,
    first: 0,
    count: 3,
    baseVertex: 0,
    topology: 'triangle-list' as const,
  };
  const geometry = {
    receipt: {
      identity: 'triangle',
      vertexInputs: receipt.vertexInputs,
      topology: draw.topology,
      indexed: true,
    },
    draw,
    deformation: skinned ? ('skin' as const) : ('rigid' as const),
  };
  const snapshot: RenderableSnapshot = {
    ...(shadowCasters === 'static' ? { mobility: 'static' as const } : {}),
    ...(skinned ? { skinBinding: { skeleton: 7, joints: [19] } } : {}),
    entityKey: 0,
    assetHandle: 3,
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    transform: { world: mat4.identity(mat4.create()) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    gpuDrivenDraws: [
      {
        ...draw,
        materialSlot: 0,
        pipelineClass: 'source',
        materialResourceClass: 'source',
        geometry,
      },
    ],
  };
  const projection = new RenderScene();
  const topology = new BatchTopology();
  const group = residency ? topology.createResidencyGroup() : undefined;
  const delta = projection.apply(
    Array.from({ length: count }, (_, entityKey) => ({
      kind: 'update' as const,
      entityKey,
      snapshot: {
        ...snapshot,
        entityKey,
        ...(group !== undefined && entityKey >= count / 2 ? { residencyGroup: group } : {}),
        ...(splitMaterials && entityKey >= count / 2
          ? { material: secondMaterial, materials: [secondMaterial] }
          : {}),
      },
    })),
  );
  const available = GpuScene.create(device, count).unwrap();
  if (available.status !== 'available') throw new Error('Missing GPU Scene');
  const scene = available.scene;
  scene
    .sync({
      ...delta,
      ...(initialMeshes === undefined ? {} : { meshes: initialMeshes }),
      ...(acceptedMaterials
        ? { materials: new MaterialFrame(undefined).with(material).with(secondMaterial) }
        : {}),
    })
    .unwrap();
  const skinInputs = new SkinSceneInputs(scene.inputs.arena, () => ({
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: mat4.identity(mat4.create()),
  }));
  const skinFrames = new SkinFrames(skinInputs);
  skinInputs.apply(delta);
  skinInputs.joint(19, mat4.identity(mat4.create()));
  const skinFrame = skinFrames.prepareFrame(projection.slotsSnapshot());
  const slots = projection.slotsSnapshot();
  if (residency) topology.apply(delta);
  else topology.rebuild(slots);
  const dispatch = new MaterialDispatch();
  for (const slot of slots) dispatch.bind(slot.slot, slot.snapshot);
  topology.adoptMaterials(dispatch.materials(), projection.slotAt);
  const programs = new GpuDrivenMaterialProgramProjection();
  const gpuMesh = mesh(device);
  const work = { memberReads: 0, candidateReads: 0, sharedMeshReads: 0, slotReads: 0 };
  const meshReads = new Map(
    topology.query(topology.sourcePlan(), initialMeshes).resident.batches.map((batch) => {
      assert(batch.binding);
      return [batch.binding, gpuMesh] as const;
    }),
  );
  const getMesh = meshReads.get.bind(meshReads);
  const meshReadSpy = vi.spyOn(meshReads, 'get').mockImplementation((binding) => {
    work.sharedMeshReads++;
    return getMesh(binding);
  });
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const source = topology.query(topology.sourcePlan(), initialMeshes).active;
  const stopObservingCandidates = observeCandidateReads(
    source.batches.map((batch) => batch.candidates),
    () => {
      work.candidateReads++;
    },
  );
  const plan: SubmissionPlan = {
    ...source,
    batches: source.batches.map((batch) => ({
      ...batch,
      ...(batch.members === undefined
        ? {}
        : {
            members: new Proxy(batch.members, {
              get(target, key, receiver) {
                if (key === Symbol.iterator || (typeof key === 'string' && /^\d+$/.test(key)))
                  work.memberReads++;
                return Reflect.get(target, key, receiver);
              },
            }),
          }),
      candidates: batch.candidates,
    })),
  };
  const state = {
    scene,
    skin: skinFrame,
    plan,
    residentExecution: topology.query(topology.sourcePlan(), initialMeshes).resident,
    slots,
    completeGeometry: topology.completeGeometry,
    slotForEntity: projection.slot,
    slotAt: (slot: number) => {
      work.slotReads++;
      return projection.slotAt(slot);
    },
  };
  if (initialMeshes !== undefined) Object.assign(state, { meshes: initialMeshes });
  let pending: PreparedGpuDrivenFrame | undefined;
  const prepare = (replace = true) => {
    // Repeated fixture calls abandon the previous unsubmitted recording.
    if (replace) pending?._abortResourceReplacement?.();
    const selected = collectGpuDrivenMaterialArtifacts({
      batches: topology.query(topology.sourcePlan(), undefined).active.batches,
      programs: programs.project(
        dispatch.query(slots, undefined, undefined, topology.captureResidencySelection()),
        dispatch.materials(),
      ),
      resolve: () => pbr.materialArtifact,
      clustered: false,
      reflectionFallback: false,
      probeBlend: false,
      demand: shadows ? 'forward-and-shadow' : 'forward',
    });
    const result = production
      .prepare({
        scene: state,
        batchExecutions: selected.batchExecutions,
        shadowViews: shadows,
        materialFrame: dispatch.materials(),
        camera: makeZeroCameraFallbackSnapshot(),
        meshByBinding: meshReads,
        viewBindGroupLayout: viewLayout,
        materialPipelineState,
        ...(selected.firstArtifact === undefined
          ? {}
          : { materialArtifact: selected.firstArtifact }),
        ...(selected.materialArtifacts.size === 0
          ? {}
          : { materialArtifacts: selected.materialArtifacts }),
        ...(shadows ? { shadowMaterialArtifacts: selected.shadowMaterialArtifacts } : {}),
      })
      .unwrap();
    pending = result;
    return result;
  };
  const residentInput = (index = 1, pass: 'forward' | 'shadow' = 'forward', meshes?: MeshFrame) => {
    const source = topology.residentSourcePlan();
    if (meshes !== undefined) {
      Object.assign(state, { meshes });
      scene.sync({ ...projection.apply([]), meshes }).unwrap();
    }
    const plan = topology.query(topology.sourcePlan(), meshes).resident;
    for (const batch of plan.batches)
      if (batch.binding !== undefined) meshReads.set(batch.binding, gpuMesh);
    state.residentExecution = plan;
    const resident = dispatch.queryResident(slots, topology.captureResidentSelection());
    const selected = collectGpuDrivenMaterialArtifacts({
      batches: plan.batches,
      programs: programs.project(resident.dispatch, resident.materials),
      resolve: () => pbr.materialArtifact,
      clustered: false,
      reflectionFallback: false,
      probeBlend: false,
      demand: shadows ? 'forward-and-shadow' : 'forward',
    });
    return {
      scene: state,
      plan,
      index,
      pass,
      executions: selected.batchExecutions,
      meshes: meshReads,
      isCurrent: () => topology.residentSourcePlan() === source,
    };
  };
  const adopt = (snapshot: MaterialSnapshot) => {
    material.adopt(snapshot);
    dispatch.adopt(material);
    topology.adoptMaterials(dispatch.materials(), projection.slotAt);
    scene.sync({ ...projection.apply([]), materialUpdates: [material] }).unwrap();
  };
  const applyScene = (delta: ReturnType<RenderScene['apply']>) => {
    scene.sync(delta).unwrap();
    topology.apply(delta);
    for (const slot of delta.removedSlots) dispatch.remove(slot.slot);
    for (const slot of [...delta.createdSlots, ...delta.updatedSlots, ...delta.recreatedSlots])
      dispatch.bind(slot.slot, slot.snapshot);
    const execution = topology.query(topology.sourcePlan(), undefined);
    state.plan = execution.active;
    state.residentExecution = execution.resident;
    state.slots = projection.slotsSnapshot();
    for (const batch of execution.resident.batches)
      if (batch.binding !== undefined) meshReads.set(batch.binding, gpuMesh);
  };
  const dispose = () => {
    const failures: unknown[] = [];
    for (const release of [
      stopObservingCandidates,
      () => meshReadSpy.mockRestore(),
      () => production.dispose(),
      () => skinInputs.dispose(),
      () => scene.dispose(),
      () => gpuMesh.vertexBuffer.destroy(),
      () => gpuMesh.indexBuffer?.destroy(),
    ])
      try {
        release();
      } catch (cause) {
        failures.push(cause);
      }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Managed fixture retirement failed');
  };
  return {
    device,
    scene,
    setMeshes: (meshes: MeshFrame) => Object.assign(state, { meshes }),
    material,
    useMaterialFrame: (materials: MaterialFrame) =>
      scene.sync({ ...projection.apply([]), materials }).unwrap(),
    prepare,
    residentInput,
    residentTaskInput: () => {
      assert(group);
      const source = topology.residentSourcePlan();
      return {
        topology,
        group,
        read: () => {
          const current = residentInput();
          return { scene: state, executions: current.executions, meshes: meshReads };
        },
        isCurrent: () => topology.residentSourcePlan() === source,
      };
    },
    abortPending: () => {
      pending?._abortResourceReplacement?.();
      pending = undefined;
    },
    adopt,
    updateEntity: (
      entityKey: number,
      inGroup = false,
      changes: Partial<RenderableSnapshot> = {},
    ) => {
      if (inGroup) assert(group);
      applyScene(
        projection.apply([
          {
            kind: 'update',
            entityKey,
            snapshot: {
              ...snapshot,
              ...(inGroup && group !== undefined ? { residencyGroup: group } : {}),
              ...changes,
              entityKey,
            },
          },
        ]),
      );
    },
    removeEntity: (entityKey: number) =>
      applyScene(projection.apply([{ kind: 'remove', entityKey }])),
    opaque,
    secondMaterial,
    blended,
    topology,
    production,
    setResidencyActive: (active: boolean) => {
      if (group === undefined) throw new Error('Fixture has no residency group');
      topology.setResidencyGroupActive(group, active);
      const execution = topology.query(topology.sourcePlan(), undefined);
      state.plan = execution.active;
      state.residentExecution = execution.resident;
    },
    dispose,
    work,
    touchMesh: () => Object.assign(gpuMesh, { contentEpoch: gpuMesh.contentEpoch + 1 }),
  };
}

it('retains physically submitted material versions when the frame generation rejects publication', async () => {
  const f = await fixture(1);
  let complete!: () => void;
  const completed = new Promise<undefined>((resolve) => {
    complete = () => resolve(undefined);
  });
  vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(completed);
  let generation = 0;
  const submit = f.device.queue.submit.bind(f.device.queue);
  vi.spyOn(f.device.queue, 'submit').mockImplementation((...args) => {
    const result = submit(...args);
    generation++;
    return result;
  });
  const aborted = vi.fn();
  const committed = vi.fn();
  try {
    const prepared = f.prepare();
    assert(prepared);
    const address = f.scene.materialIndexForResource(f.material);
    prepared._sealResourceReads().unwrap();
    const recording: FrameRecording = (function* () {
      const result = yield* recordFrameTransaction(
        {
          build: () => ok(undefined),
          execute: () => ok(undefined),
          finish: () => ok(undefined),
          generationFence: { capturedGeneration: generation, currentGeneration: () => generation },
          commit: () => {
            committed();
            prepared._commitResourceReplacement();
          },
          abort: () => {
            aborted();
            prepared._abortResourceReplacement?.();
          },
        },
        {
          onSubmittedWork: (done) => prepared._trackSubmittedWork?.(done),
          reportError: (error) => {
            throw error;
          },
        },
      );
      return result.ok;
    })();
    submitFrameRecordings({ world: createRenderWorld(), device: f.device }, [recording]);
    expect(aborted).toHaveBeenCalledOnce();
    expect(committed).not.toHaveBeenCalled();
    f.adopt({ ...f.opaque, roughness: 0.2 });
    expect(f.scene.materialIndexForResource(f.material)).not.toBe(address);
    const second = f.scene.captureResources().unwrap();
    second.indexForResource(f.material);
    f.adopt({ ...f.opaque, roughness: 0.3 });
    expect(f.scene.materialIndexForResource(f.material)).not.toBe(address);
    complete();
    await completed;
    const third = f.scene.captureResources().unwrap();
    third.indexForResource(f.material);
    f.adopt({ ...f.opaque, roughness: 0.4 });
    expect(f.scene.materialIndexForResource(f.material)).toBe(address);
    second.release();
    third.release();
  } finally {
    complete();
    await completed;
    f.dispose();
  }
});

it('admits initially transparent geometry after only the material Pass changes', async () => {
  const f = await fixture(128, true);
  try {
    const plan = f.topology.query(f.topology.sourcePlan(), undefined).active;
    expect(plan.candidateCount).toBe(128);
    expect(f.prepare()).toBeUndefined();
    f.adopt(f.opaque);
    const ready = f.prepare();
    expect(ready).toBeDefined();
    expect(f.topology.query(f.topology.sourcePlan(), undefined).active).toBe(plan);
  } finally {
    f.dispose();
  }
});

describe('scalar material edits in a populated scene', () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;

  beforeEach(async () => {
    // Run after the candidate observer's setup, within the normal bounded hook
    // budget. The edit below retains its populated scene and default deadline.
    f = await fixture(50_000);
    expect(f.prepare()).toBeDefined();
    expect(f.work.candidateReads).toBeGreaterThan(0);
  });

  afterEach(() => f?.dispose());

  it('does not revisit candidates for a scalar material edit', () => {
    assert(f);
    f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
    f.adopt({ ...f.opaque, roughness: 0.8 });
    expect(f.prepare()).toBeDefined();
    expect(f.work).toEqual({ memberReads: 0, candidateReads: 0, sharedMeshReads: 1, slotReads: 0 });
    expect(f.production.inspect().planRebuildCandidates).toBe(0);
    expect(f.production.inspect().gpuOwnedSnapshotsMaterialized).toBe(0);
  });
});

it('changes the shared Pass lane without reading or copying instance membership', async () => {
  const f = await fixture(10_000);
  try {
    expect(f.prepare()).toBeDefined();
    for (const material of [f.blended, f.opaque]) {
      f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
      f.adopt(material);
      const prepared = f.prepare();
      expect(prepared !== undefined).toBe(material === f.opaque);
      expect(f.work).toEqual({
        memberReads: 0,
        candidateReads: 0,
        sharedMeshReads: 1,
        slotReads: 0,
      });
      expect(f.production.inspect().planRebuildCandidates).toBe(0);
    }
  } finally {
    f.dispose();
  }
});

it('prepares an edited shared mesh without revisiting instance membership', async () => {
  const f = await fixture(10_000);
  try {
    expect(f.prepare()).toBeDefined();
    f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
    f.touchMesh();
    expect(f.prepare()).toBeDefined();
    expect(f.work).toEqual({ memberReads: 0, candidateReads: 0, sharedMeshReads: 1, slotReads: 0 });
    expect(f.production.inspect().planRebuildCandidates).toBe(0);
  } finally {
    f.dispose();
  }
});

it('retains candidate addresses when one of several material batches leaves the GPU lane', async () => {
  const f = await fixture(10_000, false, false, true);
  try {
    expect(f.prepare()).toBeDefined();
    const memberNodes = f.scene.inputs.memberNodesWritten;
    for (const material of [f.blended, f.opaque]) {
      const headers = f.scene.inputs.taskHeadersWritten;
      f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
      f.adopt(material);
      expect(f.prepare()).toBeDefined();
      expect(f.work).toEqual({
        memberReads: 0,
        candidateReads: 0,
        sharedMeshReads: 2,
        slotReads: 0,
      });
      expect(f.scene.inputs.memberNodesWritten).toBe(memberNodes);
      expect(f.scene.inputs.taskHeadersWritten - headers).toBe(1);
      // Mapping pages, material descriptor and the changed execution header; no member bytes.
      expect(f.production.inspect().sharedInputUploadBytes).toBe(
        4 * 1024 + 12 + GPU_TASK_HEADER_BYTES,
      );
      expect(f.production.inspect().indirectDrawCount).toBe(material === f.opaque ? 2 : 1);
    }
  } finally {
    f.dispose();
  }
});

it('uses the captured material frame for shadow projection and invalidates adopted content', async () => {
  const f = await fixture(128, false, true);
  const matrix = mat4.identity(mat4.create());
  const identity = { kind: 'spot' as const, index: 0, layer: 'static' as const };
  const views = [
    {
      identity,
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      matrix,
      targetSize: 64,
    },
  ];
  try {
    const old = f.prepare();
    if (old === undefined) throw new Error('Missing prepared frame');
    old.updateShadowViews?.(views).unwrap();
    old._sealResourceReads().unwrap();
    f.adopt({ ...f.opaque, roughness: 0.8 });
    const first = old.shadowBatchProjections?.()?.values().next().value?.values().next().value;
    expect(first?.material.roughness).toBe(0.5);
    old._commitResourceReplacement?.();
    expect(() => old.updateShadowViews?.(views)).toThrow('open resource frame');
    const next = f.prepare();
    next?.updateShadowViews?.(views).unwrap();
    const current = next?.shadowBatchProjections?.()?.values().next().value?.values().next().value;
    expect(current?.material.roughness).toBe(0.8);
    expect(next?.shadowViewPool?.invalidationReason(identity)).toBe('content-changed');
  } finally {
    f.dispose();
  }
});

it('invalidates shadow depth when the shared mesh changes in place', async () => {
  const f = await fixture(128, false, true);
  const matrix = mat4.identity(mat4.create());
  const identity = { kind: 'spot' as const, index: 0, layer: 'static' as const };
  const views = [
    {
      identity,
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      matrix,
      targetSize: 64,
    },
  ];
  try {
    const old = f.prepare();
    old?.updateShadowViews?.(views).unwrap();
    const first = old?.shadowBatchProjections?.()?.values().next().value?.values().next().value;
    old?._commitResourceReplacement?.();
    const quiet = f.prepare();
    quiet?.updateShadowViews?.(views).unwrap();
    expect(quiet?.shadowViewPool?.invalidationReason(identity)).toBeUndefined();
    quiet?._commitResourceReplacement();
    f.touchMesh();
    const next = f.prepare();
    next?.updateShadowViews?.(views).unwrap();
    const changed = next?.shadowBatchProjections?.()?.values().next().value?.values().next().value;
    expect(changed?.mesh).toBe(first?.mesh);
    expect(changed?.meshContentEpoch).toBe((first?.meshContentEpoch ?? -1) + 1);
    expect(next?.shadowViewPool?.invalidationReason(identity)).toBe('content-changed');
  } finally {
    f.dispose();
  }
});

it('retains shadow candidate ranges across shared material edits through view preparation', async () => {
  const f = await fixture(10_000, false, 'static');
  const matrix = mat4.identity(mat4.create());
  const identity = { kind: 'spot' as const, index: 0, layer: 'static' as const };
  const views = [
    {
      identity,
      matrix,
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      targetSize: 64,
    },
  ];
  try {
    const first = f.prepare();
    first?.updateShadowViews?.(views).unwrap();
    const before = first?.shadowViewPool?.submission(identity)?.plan.batches.at(0)?.candidates;
    expect(before).toHaveLength(10_000);
    first?._commitResourceReplacement();
    f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
    f.adopt({ ...f.opaque, roughness: 0.7 });
    const next = f.prepare();
    next?.updateShadowViews?.(views).unwrap();
    expect(next?.shadowViewPool?.submission(identity)?.plan.batches.at(0)?.candidates).toBe(before);
    expect(f.work).toEqual({ memberReads: 0, candidateReads: 0, sharedMeshReads: 2, slotReads: 0 });
    expect(next?.shadowViewPool?.invalidationReason(identity)).toBe('content-changed');
  } finally {
    f.dispose();
  }
});

it('keeps the ShadowCaster GPU execution when Forward changes to a blended pass', async () => {
  const f = await fixture(10_000, false, true);
  const matrix = mat4.identity(mat4.create());
  const views = [
    {
      identity: { kind: 'spot' as const, index: 0, layer: 'static' as const },
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      matrix,
      targetSize: 64,
    },
  ];
  try {
    expect(f.prepare()).toBeDefined();
    f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
    f.adopt({
      ...f.blended,
      passes: [...(f.blended.passes ?? []), ...(f.opaque.passes?.slice(1) ?? [])],
    });
    const frame = f.prepare();
    expect(frame).toBeDefined();
    expect(f.work).toEqual({ memberReads: 0, candidateReads: 0, sharedMeshReads: 2, slotReads: 0 });
    expect(f.production.inspect().indirectDrawCount).toBe(0);
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    expect(frame?.project(graph, 'rgba8unorm', 1).ok).toBe(true);
    frame?.updateShadowViews?.(views).unwrap();
    expect(frame?.shadowBatchProjections?.()?.values().next().value?.size).toBe(1);
  } finally {
    f.dispose();
  }
});

it('resolves a shared skin palette without reading a representative entity after a material edit', async () => {
  const f = await fixture(10_000, false, false, false, true);
  try {
    expect(f.prepare()).toBeDefined();
    f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
    f.adopt({ ...f.opaque, roughness: 0.8 });
    expect(f.prepare()).toBeDefined();
    expect(f.work).toEqual({ memberReads: 0, candidateReads: 0, sharedMeshReads: 1, slotReads: 0 });
  } finally {
    f.dispose();
  }
});

it('refuses to overwrite a still-unsubmitted frame and accepts a retry after abort', async () => {
  const f = await fixture(128);
  try {
    const first = f.prepare();
    expect(first).toBeDefined();
    f.adopt({ ...f.opaque, roughness: 0.2 });
    expect(() => f.prepare(false)).toThrow('unsubmitted GPU preparation');
    first?._abortResourceReplacement?.();
    expect(f.prepare(false)).toBeDefined();
  } finally {
    f.dispose();
  }
});

it('invalidates final direct depth on material edits without revisiting geometry membership', async () => {
  const f = await fixture(10_000, false, 'static');
  const matrix = mat4.identity(mat4.create());
  const identity = { kind: 'spot' as const, index: 0 };
  const staticIdentity = { ...identity, layer: 'static' as const };
  const views = [
    {
      identity,
      matrix,
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      targetSize: 64,
    },
  ];
  const direct = {
    ...f.opaque,
    passes: f.opaque.passes?.map((pass) =>
      pass.name === 'shadow'
        ? { ...pass, renderState: { ...pass.renderState, depthWriteEnabled: true } }
        : pass,
    ),
  };
  try {
    f.adopt(direct);
    const first = f.prepare();
    assert(first);
    expect(first.shadowDirectRequired).toBe(true);
    first.updateShadowViews?.(views).unwrap();
    first._commitResourceReplacement();
    const initialPlan = first.shadowViewPool?.submission(staticIdentity)?.plan;
    expect(initialPlan?.candidateCount).toBe(10_000);
    for (const [snapshot, castsShadow, membershipChanged] of [
      [{ ...direct, roughness: 0.75 }, true, false],
      [
        { ...f.opaque, passes: f.opaque.passes?.filter((pass) => pass.name !== 'shadow') },
        false,
        true,
      ],
      [direct, true, true],
    ] as const) {
      f.adopt(snapshot);
      f.work.memberReads = f.work.candidateReads = f.work.slotReads = 0;
      const prepared = f.prepare();
      assert(prepared);
      prepared.updateShadowViews?.(views).unwrap();
      expect(prepared.shadowViewPool?.invalidationReason(identity)).toBe(
        membershipChanged ? 'static-layer-changed' : 'content-changed',
      );
      expect(prepared.shadowViewPool?.invalidationReason(staticIdentity)).toBe(
        membershipChanged ? 'content-changed' : undefined,
      );
      expect(prepared.shadowDirectRequired).toBe(castsShadow);
      const plan = prepared.shadowViewPool?.submission(staticIdentity)?.plan;
      expect(plan?.candidateCount).toBe(castsShadow ? 10_000 : 0);
      expect(plan?.batches.at(0)?.candidates).toBe(
        castsShadow ? initialPlan?.batches.at(0)?.candidates : undefined,
      );
      expect(f.work.memberReads).toBe(0);
      expect(f.work.candidateReads).toBe(0);
      expect(f.work.slotReads).toBe(0);
      prepared._commitResourceReplacement();
    }
  } finally {
    f.dispose();
  }
});

it('requires a shared GPU geometry address only for GPU executions', async () => {
  const f = await fixture(1, true);
  try {
    const meshFrame = new MeshFrame().with(3, createBoxGeometry(1, 1, 1).unwrap());
    f.setMeshes(meshFrame);
    expect(f.prepare()).toBeUndefined();
    // The same missing address remains an error once a Pass selects the GPU lane.
    f.adopt(f.opaque);
    expect(() => f.prepare()).toThrow('stale-generation');
  } finally {
    f.dispose();
  }
});

it.each([
  false,
  true,
])('removes absent shadow passes from submission and restores them without revisiting geometry (split=%s)', async (splitMaterials) => {
  const f = await fixture(10_000, false, true, splitMaterials);
  const matrix = mat4.identity(mat4.create());
  const identity = { kind: 'spot' as const, index: 0 };
  const views = [
    {
      identity,
      matrix,
      planes: frustum.fromViewProjection(frustum.create(), matrix),
      targetSize: 64,
    },
  ];
  const source = f.topology.query(f.topology.sourcePlan(), undefined).active;
  const withoutShadow = {
    ...f.opaque,
    passes: f.opaque.passes?.filter((pass) => pass.name !== 'shadow'),
  };
  try {
    const first = f.prepare();
    assert(first);
    first.updateShadowViews?.(views).unwrap();
    first._commitResourceReplacement();
    for (const [snapshot, expectedCasters] of [
      [f.opaque, 10_000],
      [withoutShadow, splitMaterials ? 5_000 : 0],
      [withoutShadow, splitMaterials ? 5_000 : 0],
      [f.opaque, 10_000],
    ] as const) {
      f.adopt(snapshot);
      f.work.memberReads = f.work.candidateReads = f.work.slotReads = 0;
      const frame = f.prepare();
      assert(frame);
      frame.updateShadowViews?.(views).unwrap();
      const batches = [identity, { ...identity, layer: 'static' as const }].flatMap((view) => [
        ...(frame.shadowViewPool?.submission(view)?.plan.batches ?? []),
      ]);
      expect(batches.reduce((sum, batch) => sum + batch.candidates.length, 0)).toBe(
        expectedCasters,
      );
      const channels = f.production
        .inspect()
        .channels.filter((entry) => entry.viewPass === 'spot-shadow');
      expect(channels.reduce((sum, channel) => sum + channel.drawCount, 0)).toBe(expectedCasters);
      expect(
        channels.every((channel) => channel.lane === 'gpu' && channel.residualDrawCount === 0),
      ).toBe(true);
      expect(f.topology.query(f.topology.sourcePlan(), undefined).active).toBe(source);
      expect(f.work.memberReads).toBe(0);
      expect(f.work.candidateReads).toBe(0);
      expect(f.work.slotReads).toBe(0);
      frame._commitResourceReplacement();
    }
  } finally {
    f.dispose();
  }
});

it('retains the complete canonical source encoding through ordinary production preparation and group gates', async () => {
  const f = await fixture(8, false, false, true, false, true);
  try {
    const resident = f.topology.query(f.topology.sourcePlan(), undefined).resident;
    expect(resident.sourceGroups?.length).toBe(2);
    expect(f.topology.sourcePlan().batches.length).toBe(1);
    const initial = f.prepare();
    assert(initial);
    initial._sealResourceReads().unwrap();
    const written = f.scene.inputs.memberNodesWritten;
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(4);
    const read = f.scene.inputs.capture();
    try {
      for (const batch of resident.batches) read.members(batch.candidates);
      expect(f.scene.inputs.memberNodesWritten).toBe(written);
      read.seal().unwrap();
    } finally {
      read.release();
      initial._abortResourceReplacement?.();
    }
    for (let cycle = 0; cycle < 6; cycle++) {
      f.setResidencyActive(cycle % 2 === 0);
      const frame = f.prepare();
      assert(frame);
      frame._sealResourceReads().unwrap();
      frame._abortResourceReplacement?.();
      expect(f.scene.inputs.memberNodesWritten).toBe(written);
      expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(
        cycle % 2 === 0 ? 8 : 4,
      );
    }
  } finally {
    f.dispose();
  }
});

it('retains inactive filtered windows through the actual production gate path', async () => {
  const f = await fixture(8, false, true, false, false, true);
  try {
    f.setResidencyActive(true);
    assert(f.prepare());
    f.abortPending();
    const owners = ['mainFilterContributions', 'shadowFilterContributions'].map((key) =>
      Reflect.get(f.production, key),
    );
    const publications = owners.map((owner) => Reflect.get(owner, 'publication').resident);
    const counters = owners.map((owner) => ({ ...owner.windowCounters }));
    for (const owner of owners) expect(Reflect.get(owner, 'rows').size).toBe(2);
    for (let cycle = 0; cycle < 8; cycle++) {
      const active = cycle % 2 !== 0;
      f.setResidencyActive(active);
      assert(f.prepare());
      expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(active ? 8 : 4);
      for (const [index, owner] of owners.entries()) {
        expect(Reflect.get(owner, 'rows').size).toBe(2);
        expect(Reflect.get(owner, 'publication').resident).toBe(publications[index]);
        expect(owner.windowCounters).toEqual(counters[index]);
      }
      f.abortPending();
    }
  } finally {
    f.dispose();
  }
});

it('prepares a closed resident contribution in the same cache without changing active output', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const first = f.prepare();
    assert(first);
    f.abortPending();
    const input = f.residentInput();
    const result = f.production.prepareResidentBatch(input).unwrap();
    assert(result.kind === 'provisional');
    const batch = input.plan.batches.at(input.index);
    assert(batch);
    expect(result.row.origin).toBe(batch);
    for (let cycle = 0; cycle < 130; cycle++)
      expect(f.production.prepareResidentBatch(input).unwrap().kind).toBe('provisional');
    const next = f.prepare();
    assert(next);
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(2);
    f.abortPending();
    // Active preparation must not prune this closed contribution's cache entry.
    const again = f.production.prepareResidentBatch(input).unwrap();
    assert(again.kind === 'provisional');
    expect(again.row).toBe(result.row);
    f.setResidencyActive(true);
    assert(f.prepare());
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(4);
  } finally {
    f.dispose();
  }
});

it('uses background Filtered descriptors in the ordinary Forward and Shadow paths without rebuilding windows', async () => {
  const f = await fixture(8, false, true, false, false, true);
  try {
    f.setResidencyActive(false);
    assert(f.prepare());
    f.abortPending();
    const prepared = (['forward', 'shadow'] as const).map((pass) => {
      const input = f.residentInput(1, pass);
      const owner = Reflect.get(
        f.production,
        pass === 'forward' ? 'mainFilterContributions' : 'shadowFilterContributions',
      );
      const publication = Reflect.get(owner, 'publication');
      const result = f.production.prepareResidentBatch(input).unwrap();
      assert(result.kind === 'provisional');
      expect(Reflect.get(owner, 'publication')).toBe(publication);
      expect(Reflect.get(owner, 'rows').size).toBe(2);
      const row = Reflect.get(owner, 'rows').get(result.row.source.batchId);
      return { owner, row, publication, counters: { ...owner.windowCounters } };
    });
    assert(f.prepare());
    f.abortPending();
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(4);
    for (const held of prepared) {
      expect(Reflect.get(held.owner, 'publication').active).toBe(held.publication.active);
      expect(Reflect.get(held.owner, 'rows').get(held.row.row.source.batchId).topology[0]).toBe(
        held.row.topology[0],
      );
    }
    f.setResidencyActive(true);
    assert(f.prepare());
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(8);
    for (const held of prepared) {
      expect(Reflect.get(held.owner, 'publication').active.batches).toContain(held.row.batches[0]);
      expect(held.owner.windowCounters).toEqual(held.counters);
    }
  } finally {
    f.dispose();
  }
});

it('rolls back a downstream Filtered refusal without breaking ordinary production', async () => {
  const f = await fixture(8, false, false, false, false, true);
  try {
    f.setResidencyActive(false);
    assert(f.prepare());
    f.abortPending();
    const owner = Reflect.get(f.production, 'mainFilterContributions');
    const previous = Reflect.get(owner, 'publication');
    const ranges = Reflect.get(owner, 'visibleRanges');
    const allocate = ranges.allocate.bind(ranges);
    let current = true;
    const mutation = vi.spyOn(ranges, 'allocate').mockImplementation((count) => {
      const start = allocate(count);
      current = false;
      return start;
    });
    const input = f.residentInput();
    const result = f.production.prepareResidentBatch({
      ...input,
      isCurrent: () => current && input.isCurrent(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('stale-generation');
    expect(Reflect.get(owner, 'publication')).toBe(previous);
    expect(Reflect.get(owner, 'rows').size).toBe(1);
    mutation.mockRestore();
    current = true;
    assert(f.prepare());
    f.abortPending();
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(4);
    f.production.prepareResidentBatch(input).unwrap();
    expect(Reflect.get(owner, 'rows').size).toBe(2);
  } finally {
    f.dispose();
  }
});

it('holds actual background task headers through activation without re-encoding them', async () => {
  const f = await fixture(4, false, false, false, false, true);
  const inputs = f.scene.inputs;
  const held = vi.spyOn(inputs, 'holdHeader');
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    f.setResidencyActive(false);
    const input = f.residentInput();
    const before = inputs.taskHeadersWritten;
    f.production.prepareResidentBatch(input).unwrap();
    expect(inputs.taskHeadersWritten).toBeGreaterThan(before);
    expect(writes).not.toHaveBeenCalled();
    expect(held).toHaveBeenCalled();
    const addresses = held.mock.calls.map(([header]) => header.address);
    const encoded = inputs.taskHeadersWritten;
    f.production.prepareResidentBatch(input).unwrap();
    expect(inputs.taskHeadersWritten).toBe(encoded);
    f.setResidencyActive(true);
    assert(f.prepare());
    const view = Reflect.get(f.production, 'view');
    const activeHeaders = Reflect.get(view, 'encodedTopology').headers;
    expect(
      activeHeaders.some((header: { address: number }) => addresses.includes(header.address)),
    ).toBe(true);
    expect(inputs.taskHeadersWritten - encoded).toBe(1);
  } finally {
    held.mockRestore();
    writes.mockRestore();
    f.dispose();
  }
});

it('rebuilds background header custody on a fresh Scene after the old incarnation terminates', async () => {
  const f = await fixture(4, false, false, false, false, true);
  let replacement: GpuScene | undefined;
  try {
    const input = f.residentInput();
    f.production.prepareResidentBatch(input).unwrap();
    const available = GpuScene.create(f.device, 8).unwrap();
    assert(available.status === 'available');
    replacement = available.scene;
    const slots = [...input.scene.slots];
    replacement
      .sync({
        created: slots.length,
        updated: 0,
        removed: 0,
        recreated: 0,
        ignoredLateUpdates: 0,
        createdSlots: slots,
        updatedSlots: [],
        contentUpdatedSlots: [],
        instanceUpdatedSlots: [],
        removedSlots: [],
        recreatedSlots: [],
        previous: new Map(),
        resynced: 0,
      })
      .unwrap();
    f.scene.dispose();
    input.scene.scene = replacement;
    const result = f.production.prepareResidentBatch(input).unwrap();
    assert(result.kind === 'provisional');
    const rows = Reflect.get(Reflect.get(f.production, 'mainFilterContributions'), 'rows');
    expect(rows.get(result.row.source.batchId).headers.inputs).toBe(replacement.inputs);
    expect(replacement.inputs.taskHeadersWritten).toBeGreaterThan(0);
  } finally {
    try {
      f.dispose();
    } finally {
      replacement?.dispose();
    }
  }
});

it.each([
  false,
  true,
])('continues Production cleanup after unknown background header retirement (after=%s)', async (after) => {
  const f = await fixture(4, false, true, false, false, true);
  assert(f.prepare());
  f.abortPending();
  const acquire = f.scene.inputs.holdHeader.bind(f.scene.inputs);
  const spy = vi.spyOn(f.scene.inputs, 'holdHeader').mockImplementation((header, batch) => {
    const release = acquire(header, batch);
    return () => {
      if (after) release();
      throw Error('unknown background header retirement');
    };
  });
  try {
    for (const pass of ['forward', 'shadow'] as const)
      f.production.prepareResidentBatch(f.residentInput(1, pass)).unwrap();
    const shadows = Reflect.get(f.production, 'shadowViews');
    const disposeShadows = vi.spyOn(shadows, 'dispose');
    expect(() => f.production.dispose()).toThrow(AggregateError);
    expect(disposeShadows).toHaveBeenCalledTimes(1);
    for (const key of ['mainFilterContributions', 'shadowFilterContributions'])
      expect(Reflect.get(Reflect.get(f.production, key), 'failure').headers.size).toBe(1);
    disposeShadows.mockRestore();
  } finally {
    spy.mockRestore();
    expect(() => f.dispose()).toThrow(AggregateError);
    expect(f.scene.inputs.arena.live).toBe(false);
  }
});

it('retires background header custody on a negative Pass contribution', async () => {
  const f = await fixture(4, false, false, false, false, true);
  const inputs = f.scene.inputs;
  try {
    f.setResidencyActive(false);
    const input = f.residentInput();
    f.production.prepareResidentBatch(input).unwrap();
    expect(inputs.taskHeadersWritten).toBeGreaterThan(0);
    const batch = input.plan.batches.at(input.index);
    assert(batch?.binding);
    const execution = input.executions.get(batch.binding);
    assert(execution);
    const executions = new Map(input.executions);
    executions.set(batch.binding, { ...execution, forward: { route: 'none' } });
    f.production.prepareResidentBatch({ ...input, executions }).unwrap();
    expect(inputs.taskHeadersReleased).toBe(inputs.taskHeadersWritten);
  } finally {
    f.dispose();
  }
});

it('does not revive a production owner disposed during downstream Filtered allocation', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    f.setResidencyActive(false);
    assert(f.prepare());
    f.abortPending();
    const owner = Reflect.get(f.production, 'mainFilterContributions');
    const ranges = Reflect.get(owner, 'visibleRanges');
    const allocate = ranges.allocate.bind(ranges);
    vi.spyOn(ranges, 'allocate').mockImplementation((count) => {
      const start = allocate(count);
      f.production.dispose();
      return start;
    });
    const result = f.production.prepareResidentBatch(f.residentInput());
    expect(result.ok).toBe(false);
    expect(Reflect.get(owner, 'publication')).toBeUndefined();
    expect(Reflect.get(owner, 'rows').size).toBe(0);
  } finally {
    f.dispose();
  }
});

it('retains row constructor authority through a real Mesh metadata rebase and downstream preparation', async () => {
  const asset = createBoxGeometry(1, 1, 1).unwrap();
  const firstFrame = new MeshFrame().with(3, asset);
  const f = await fixture(4, false, false, false, false, true, firstFrame);
  try {
    const firstInput = f.residentInput(1, 'forward', firstFrame);
    const first = f.production.prepareResidentBatch(firstInput).unwrap();
    assert(first.kind === 'provisional');
    const oldOrigin = first.row.origin;
    const secondFrame = firstFrame.with(3, asset);
    expect(secondFrame.get(3)).not.toBe(firstFrame.get(3));
    const secondInput = f.residentInput(1, 'forward', secondFrame);
    const origin = secondInput.plan.batches.at(secondInput.index);
    assert(origin);
    expect(origin).not.toBe(oldOrigin);
    expect(origin.candidates).toBe(oldOrigin.candidates);
    expect(origin.key).toEqual(oldOrigin.key);
    expect(origin.generation).toBe(oldOrigin.generation);
    expect(origin.contentEpoch).toBe(oldOrigin.contentEpoch);
    assert(origin.binding && oldOrigin.binding);
    expect(secondInput.meshes.get(origin.binding)).toBe(firstInput.meshes.get(oldOrigin.binding));
    const next = f.production.prepareResidentBatch(secondInput).unwrap();
    assert(next.kind === 'provisional');
    expect(next.row).not.toBe(first.row);
    expect(next.row.origin).toBe(origin);
    expect(next.row.fact).toBe(first.row.fact);
    const owner = Reflect.get(f.production, 'mainFilterContributions');
    expect(Reflect.get(owner, 'rows').get(origin.batchId).row).toBe(next.row);
  } finally {
    f.dispose();
  }
});

it('keeps missing inactive artifacts out of the current required-frame failure', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    assert(f.prepare());
    f.abortPending();
    const input = f.residentInput();
    const batch = input.plan.batches.at(input.index);
    assert(batch?.binding);
    const execution = input.executions.get(batch.binding);
    assert(execution?.forward.route === 'gpu');
    const executions = new Map(input.executions);
    const missing = { ...execution.forward };
    Reflect.deleteProperty(missing, 'artifact');
    executions.set(batch.binding, { ...execution, forward: missing });
    const result = f.production.prepareResidentBatch({ ...input, executions });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-material-receipt');
    assert(f.prepare());
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(2);
  } finally {
    f.dispose();
  }
});

it('rejects stale, copied and overlapping resident preparation inputs before cache acceptance', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    assert(f.prepare());
    const input = f.residentInput();
    expect(f.production.prepareResidentBatch(input).ok).toBe(false);
    f.abortPending();
    const copied = Object.freeze({ ...input.plan });
    expect(f.production.prepareResidentBatch({ ...input, plan: copied }).ok).toBe(false);
    f.topology.rebuild([]);
    const stale = f.production.prepareResidentBatch(input);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('stale-generation');
  } finally {
    f.dispose();
  }
});

it('does not revive a disposed production owner through a resident source guard', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    assert(f.prepare());
    f.abortPending();
    const input = f.residentInput();
    const result = f.production.prepareResidentBatch({
      ...input,
      isCurrent: () => {
        f.production.dispose();
        return input.isCurrent();
      },
    });
    expect(result.ok).toBe(false);
    expect(() => f.prepare()).toThrow('rhi-descriptor-invalid');
  } finally {
    f.dispose();
  }
});

it('records a missing Pass as a completed negative contribution', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const result = f.production.prepareResidentBatch(f.residentInput(1, 'shadow')).unwrap();
    expect(result).toEqual({ kind: 'no-pass' });
    assert(f.prepare());
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(2);
  } finally {
    f.dispose();
  }
});

it('rejects copied membership before reading its task list', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const input = f.residentInput();
    let reads = 0;
    const copy = Object.freeze({
      ...input.plan,
      get batches() {
        reads++;
        return input.plan.batches;
      },
    });
    const result = f.production.prepareResidentBatch({
      ...input,
      scene: { ...input.scene, residentExecution: copy },
      plan: copy,
    });
    expect(result.ok).toBe(false);
    expect(reads).toBe(0);
  } finally {
    f.dispose();
  }
});

it('rechecks the actual source guard receiver after the probe releases its read domain', async () => {
  const f = await fixture(4, false, false, false, false, true);
  const capture = f.scene.captureResources.bind(f.scene);
  const hook = vi.spyOn(f.scene, 'captureResources').mockImplementation(() => {
    const result = capture();
    if (result.ok) {
      const release = result.value.release.bind(result.value);
      result.value.release = () => {
        release();
        f.topology.rebuild([]);
      };
    }
    return result;
  });
  try {
    const input = f.residentInput();
    const source = f.topology.residentSourcePlan();
    const guarded = {
      ...input,
      get sourceVersion() {
        return f.topology.residentSourcePlan();
      },
      isCurrent() {
        return this.sourceVersion === source;
      },
    };
    const result = f.production.prepareResidentBatch(guarded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('stale-generation');
  } finally {
    hook.mockRestore();
    f.dispose();
  }
});

it('advances one group cooperatively and accepts exact Scene-version custody', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const task = f.production.createResidentPreparation(f.residentTaskInput()).unwrap();
    expect(task.step(0).ok).toBe(false);
    let previous = task.inspect();
    for (let index = 0; index < 32 && previous.phase !== 'held'; index++) {
      const current = task.step(1).unwrap();
      expect(current.visitedBatches - previous.visitedBatches).toBeLessThanOrEqual(1);
      expect(current.preparedContributions - previous.preparedContributions).toBeLessThanOrEqual(1);
      previous = current;
    }
    expect(task.inspect()).toMatchObject({
      phase: 'held',
      selectedBatches: 1,
      preparedContributions: 2,
    });
    const held = task.validate().unwrap();
    expect(Object.keys(held).sort()).toEqual(['forward', 'isCurrent', 'shadow']);
    expect(held.isCurrent()).toBe(true);
    expect(held.forward).toHaveLength(1);
    expect(held.shadow).toHaveLength(0);
    assert(f.prepare());
    expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(2);
    f.abortPending();
    task.validate().unwrap();
    task.release();
    expect(task.inspect().phase).toBe('released');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
    expect(Reflect.get(f.production, 'residentRowTasks').size).toBe(0);
  } finally {
    f.dispose();
  }
});

it('keeps task work outside an unfinished ordinary recording', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const input = f.residentTaskInput();
    const read = vi.fn(input.read);
    const task = f.production.createResidentPreparation({ ...input, read }).unwrap();
    assert(f.prepare());
    read.mockClear();
    expect(task.step(16).unwrap().phase).toBe('discover');
    expect(read).not.toHaveBeenCalled();
    f.abortPending();
    expect(task.step(16).unwrap().phase).toBe('held');
    task.release();
  } finally {
    f.dispose();
  }
});

it('keeps a fixed group preparation through unrelated membership changes and preserves new caches', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const task = f.production
      .createResidentPreparation({ ...f.residentTaskInput(), isCurrent: () => true })
      .unwrap();
    while (task.inspect().preparedContributions < 1) task.step(1).unwrap();
    const unrelated = f.secondMaterial;
    f.updateEntity(99, false, { material: unrelated, materials: [unrelated] });
    assert(f.prepare());
    f.abortPending();
    const caches = Reflect.get(f.production, 'preparations').forward.batches as Map<
      number,
      unknown
    >;
    const freshBatch = f
      .residentInput()
      .plan.batches.find((batch) => batch.binding?.material === unrelated);
    assert(freshBatch);
    const cached = caches.get(freshBatch.batchId);
    expect(cached).toBeDefined();
    expect(task.step(32).unwrap().phase).toBe('held');
    const fixed = task.validate().unwrap().forward[0];
    expect(caches.get(freshBatch.batchId)).toBe(cached);
    for (const active of [true, false, true, false]) {
      f.setResidencyActive(active);
      expect(task.validate().unwrap().forward[0]).toBe(fixed);
      assert(f.prepare());
      expect(Reflect.get(f.production, 'view').inspect().candidateCount).toBe(active ? 5 : 3);
      f.abortPending();
    }
    for (let cycle = 0; cycle < 4; cycle++) {
      f.removeEntity(99);
      expect(task.validate().unwrap().forward[0]).toBe(fixed);
      f.updateEntity(99, false, { material: unrelated, materials: [unrelated] });
      expect(task.validate().unwrap().forward[0]).toBe(fixed);
    }
    f.removeEntity(99);
    f.removeEntity(0);
    f.removeEntity(1);
    expect(f.residentInput().plan.batches.at(0)?.key.residencyGroup).toBe(
      f.residentTaskInput().group.id,
    );
    expect(task.validate().unwrap().forward[0]).toBe(fixed);
    f.updateEntity(0);
    f.updateEntity(1);
    expect(task.validate().unwrap().forward[0]).toBe(fixed);
    task.release();
  } finally {
    f.dispose();
  }
});

it.each([
  'hidden',
  'zero',
  'unbatched',
  'add-remove',
])('invalidates the fixed group roster after an otherwise invisible owned claim change (%s)', async (kind) => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const task = f.production
      .createResidentPreparation({ ...f.residentTaskInput(), isCurrent: () => true })
      .unwrap();
    task.step(32).unwrap();
    const changes: Partial<RenderableSnapshot> =
      kind === 'hidden' || kind === 'add-remove'
        ? { authorVisible: false }
        : kind === 'zero'
          ? {
              instances: {
                transforms: new Float32Array(0),
                instanceCount: 0,
                cacheKey: 99,
                archVersion: 0,
              },
            }
          : { gpuDrivenDraws: [] };
    f.updateEntity(99, true, changes);
    if (kind === 'add-remove') f.removeEntity(99);
    expect(task.validate().ok).toBe(false);
    expect(task.inspect().phase).toBe('failed');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
  } finally {
    f.dispose();
  }
});

it.each([
  'hidden',
  'zero',
  'add-remove',
])('does not reuse an empty group proof after owned claims changed (%s)', async (kind) => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const group = f.topology.createResidencyGroup();
    const task = f.production
      .createResidentPreparation({ ...f.residentTaskInput(), group, isCurrent: () => true })
      .unwrap();
    expect(task.step(32).unwrap()).toMatchObject({ phase: 'held', selectedBatches: 0 });
    f.updateEntity(99, false, {
      residencyGroup: group,
      ...(kind === 'zero'
        ? {
            instances: {
              transforms: new Float32Array(0),
              instanceCount: 0,
              cacheKey: 99,
              archVersion: 0,
            },
          }
        : { authorVisible: false }),
    });
    if (kind === 'add-remove') f.removeEntity(99);
    expect(task.validate().ok).toBe(false);
    expect(task.inspect().phase).toBe('failed');
  } finally {
    f.dispose();
  }
});

it('admits group plans only from the exact current resident topology and keeps the original definition', async () => {
  const f = await fixture(4, false, false, false, false, true);
  const other = await fixture(4, false, false, false, false, true);
  try {
    const input = f.residentInput();
    const { group } = f.residentTaskInput();
    const foreign = other.residentInput().plan;
    expect(f.topology.captureResidencyGroupPlan(group, foreign)).toBeUndefined();
    expect(f.topology.captureResidencyGroupPlan(group, f.topology.sourcePlan())).toBeUndefined();
    expect(
      f.topology.captureResidencyGroupPlan(
        group,
        f.topology.query(f.topology.sourcePlan(), undefined).active,
      ),
    ).toBeUndefined();
    const captured = f.topology.captureResidencyGroupPlan(group, input.plan);
    assert(captured);
    expect(matchesResidentGroupPlan(captured, input.plan, input.plan)).toBe(true);
    expect(matchesResidentGroupPlan({ ...captured }, input.plan, input.plan)).toBe(false);
    expect(
      matchesResidentGroupPlan({ plan: input.plan, matches: () => true }, input.plan, input.plan),
    ).toBe(false);
    expect(captured.matches(foreign)).toBe(false);
    expect(f.production.prepareResidentBatch({ ...input, groupPlan: { ...captured } }).ok).toBe(
      false,
    );
    f.updateEntity(99);
    const fresh = f.residentInput().plan;
    expect(captured.matches(input.plan)).toBe(false);
    expect(captured.matches(fresh)).toBe(true);
    expect(captured.plan).toBe(input.plan);
    expect(matchesResidentGroupPlan(captured, fresh, fresh)).toBe(false);
    f.topology.rebuild([]);
    expect(captured.matches(fresh)).toBe(false);
  } finally {
    f.dispose();
    other.dispose();
  }
});

it('rejects target physical LOD relocation even when its source membership root is unchanged', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const { group } = f.residentTaskInput();
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const meshes = new MeshFrame().with(3, mesh);
    const source = f.topology.sourcePlan();
    const initial = f.topology.query(source, meshes).resident;
    const captured = f.topology.captureResidencyGroupPlan(group, initial);
    assert(captured);
    const before = f.topology.inspect().windowRelocations;
    assert(before !== undefined);
    const changed = f.topology.query(
      source,
      meshes.with(3, {
        ...mesh,
        lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
      }),
    ).resident;
    expect(changed.sourceGroups).toBe(initial.sourceGroups);
    expect(f.topology.inspect().windowRelocations).toBeGreaterThan(before);
    expect(
      changed.batches.find((batch) => batch.key.residencyGroup === group.id)?.lod?.coverages,
    ).toHaveLength(2);
    expect(captured.matches(changed)).toBe(false);
  } finally {
    f.dispose();
  }
});

it.each([
  ['prepare', 'forward'],
  ['prepare', 'shadow'],
  ['accept', 'forward'],
  ['accept', 'shadow'],
] as const)('rejects a different group contribution under an otherwise current group credential (%s, %s)', async (operation, pass) => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const initial = f.residentInput(0, pass);
    const contribution = f.production.prepareResidentBatch(initial).unwrap();
    const captured = f.topology.captureResidencyGroupPlan(
      f.residentTaskInput().group,
      initial.plan,
    );
    assert(captured);
    f.updateEntity(99);
    const fresh = f.residentInput(0, pass);
    expect(captured.matches(fresh.plan)).toBe(true);
    const read = vi.spyOn(f.scene, 'captureResources');
    try {
      const input = {
        ...fresh,
        plan: initial.plan,
        groupPlan: captured,
        isCurrent: () => true,
      };
      if (operation === 'prepare') expect(f.production.prepareResidentBatch(input).ok).toBe(false);
      else {
        const accepted = f.production.acceptResidentBatches({
          ...input,
          contributions: [contribution],
        });
        if (accepted.ok) accepted.value.release();
        expect(accepted.ok).toBe(false);
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  } finally {
    f.dispose();
  }
});

it('rejects a target member resize and its physical window replacement', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const { group } = f.residentTaskInput();
    const initial = f.residentInput().plan;
    const captured = f.topology.captureResidencyGroupPlan(group, initial);
    assert(captured);
    const before = f.topology.inspect().windowRelocations;
    assert(before !== undefined);
    const transforms = new Float32Array(129 * 16);
    const matrix = mat4.identity(mat4.create());
    for (let ordinal = 0; ordinal < 129; ordinal++) transforms.set(matrix, ordinal * 16);
    f.updateEntity(2, true, {
      instances: { transforms, instanceCount: 129, cacheKey: 99, archVersion: 0 },
    });
    const fresh = f.residentInput().plan;
    expect(f.topology.inspect().windowRelocations).toBeGreaterThan(before);
    expect(captured.matches(fresh)).toBe(false);
  } finally {
    f.dispose();
  }
});

it('rejects foreign and retired group capabilities and cancels without a later frame', async () => {
  const f = await fixture(4, false, false, false, false, true);
  const other = await fixture(4, false, false, false, false, true);
  try {
    const input = f.residentTaskInput();
    expect(
      f.production.createResidentPreparation({ ...input, group: other.residentTaskInput().group })
        .ok,
    ).toBe(false);
    const task = f.production.createResidentPreparation(input).unwrap();
    task.step(1).unwrap();
    task.release();
    expect(task.step(1).ok).toBe(false);
    const stale = f.production.createResidentPreparation(input).unwrap();
    f.topology.rebuild([]);
    expect(stale.step(1).ok).toBe(false);
    expect(stale.inspect().phase).toBe('failed');
  } finally {
    f.dispose();
    other.dispose();
  }
});

it('rejects mixed or changed original version proofs rather than refreshing the definition', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const task = f.production.createResidentPreparation(f.residentTaskInput()).unwrap();
    while (task.inspect().preparedContributions < 1) task.step(1).unwrap();
    f.adopt({ ...f.opaque, roughness: 0.125 });
    let failure = false;
    for (let index = 0; index < 16 && !failure; index++) failure = !task.step(1).ok;
    expect(failure).toBe(true);
    expect(task.inspect().phase).toBe('failed');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
    assert(f.prepare());
  } finally {
    f.dispose();
  }
});

it('drains group task holds through Production disposal without another render frame', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const task = f.production.createResidentPreparation(f.residentTaskInput()).unwrap();
    expect(task.step(32).unwrap().phase).toBe('held');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(1);
    f.production.dispose();
    expect(task.inspect().phase).toBe('released');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
    expect(Reflect.get(f.production, 'residentRowTasks').size).toBe(0);
  } finally {
    f.dispose();
  }
});

it.each([
  'copy',
  'duplicate',
  'reordered',
  'foreign',
])('rejects %s aggregate contribution proofs without acquiring a resident hold', async (invalid) => {
  const f = await fixture(4, false, false, false, false, true);
  const other = await fixture(4, false, false, false, false, true);
  try {
    const first = f.production.prepareResidentBatch(f.residentInput(0)).unwrap();
    const second = f.production.prepareResidentBatch(f.residentInput(1)).unwrap();
    const foreign = other.production.prepareResidentBatch(other.residentInput(1)).unwrap();
    const contributions =
      invalid === 'copy'
        ? [{ ...second }]
        : invalid === 'duplicate'
          ? [second, second]
          : invalid === 'reordered'
            ? [second, first]
            : [foreign];
    expect(f.production.acceptResidentBatches({ ...f.residentInput(), contributions }).ok).toBe(
      false,
    );
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
    const held = f.production
      .acceptResidentBatches({ ...f.residentInput(), contributions: [first, second] })
      .unwrap();
    expect(held.forward).toHaveLength(2);
    held.release();
  } finally {
    f.dispose();
    other.dispose();
  }
});

it('retains the accepted resident material root when ordinary material demand drops it', async () => {
  const f = await fixture(4, false, false, true, false, true, undefined, true);
  try {
    const input = f.residentInput();
    const contribution = f.production.prepareResidentBatch(input).unwrap();
    const held = f.production
      .acceptResidentBatches({ ...input, contributions: [contribution] })
      .unwrap();
    try {
      const descriptor = f.scene.materialIndexForResource(f.secondMaterial);
      expect(descriptor).toBeDefined();
      f.useMaterialFrame(new MaterialFrame(undefined).with(f.material));
      expect(f.scene.materialIndexForResource(f.secondMaterial)).toBe(descriptor);
      expect(held.isCurrent()).toBe(true);
    } finally {
      held.release();
    }
    expect(f.scene.materialIndexForResource(f.secondMaterial)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it('rejects source invalidation during the actual version-custody transfer', async () => {
  const f = await fixture(4, false, false, false, false, true);
  const holdMaterialRoots = f.scene.holdMaterialRoots.bind(f.scene);
  const hook = vi.spyOn(f.scene, 'holdMaterialRoots').mockImplementation((frame) => {
    const result = holdMaterialRoots(frame);
    f.topology.rebuild([]);
    return result;
  });
  try {
    const input = f.residentInput();
    const contribution = f.production.prepareResidentBatch(input).unwrap();
    const accepted = f.production.acceptResidentBatches({
      ...input,
      contributions: [contribution],
    });
    if (accepted.ok) accepted.value.release();
    expect(accepted.ok).toBe(false);
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
  } finally {
    hook.mockRestore();
    f.dispose();
  }
});

it('does not resurrect a task cancelled by its fresh-read callback', async () => {
  const f = await fixture(4, false, false, false, false, true);
  try {
    const input = f.residentTaskInput();
    let cancel = false;
    const task = f.production
      .createResidentPreparation({
        ...input,
        read() {
          if (cancel) task.release();
          return input.read();
        },
      })
      .unwrap();
    task.step(32).unwrap();
    cancel = true;
    expect(task.validate().ok).toBe(false);
    expect(task.inspect().phase).toBe('failed');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
    expect(Reflect.get(f.production, 'residentRowTasks').size).toBe(0);
  } finally {
    f.dispose();
  }
});

it.each([
  'cancel',
  'scene-dispose',
  'scene-sync',
])('rejects terminal or changed Scene facts while the previous hold retires (%s)', async (operation) => {
  const f = await fixture(4, false, false, false, false, true);
  const accept = f.production.acceptResidentBatches.bind(f.production);
  let cancel = false;
  const hook = vi.spyOn(f.production, 'acceptResidentBatches').mockImplementation((input) => {
    const result = accept(input);
    if (!result.ok) return result;
    return ok({
      ...result.value,
      release() {
        result.value.release();
        if (cancel) {
          cancel = false;
          if (operation === 'cancel') task.release();
          else if (operation === 'scene-dispose') f.scene.dispose();
          else f.adopt({ ...f.opaque, roughness: 0.625 });
        }
      },
    });
  });
  const task = f.production.createResidentPreparation(f.residentTaskInput()).unwrap();
  try {
    task.step(32).unwrap();
    cancel = true;
    expect(task.validate().ok).toBe(false);
    expect(task.inspect().phase).toBe('failed');
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
    expect(Reflect.get(f.production, 'residentRowTasks').size).toBe(0);
  } finally {
    hook.mockRestore();
    f.dispose();
  }
});

it.each([
  'prepare-plan',
  'accept-plan',
  'accept-scene',
  'prepare-scene-dispose',
  'accept-scene-dispose',
  'prepare-scene-sync',
  'accept-scene-sync',
])('rejects an execution identity changed by the final source guard (%s)', async (operation) => {
  const f = await fixture(4, false, false, false, false, true);
  const other = await fixture(4, false, false, false, false, true);
  const input = f.residentInput();
  let checks = 0;
  try {
    const contribution = f.production.prepareResidentBatch(input).unwrap();
    const guarded = {
      ...input,
      isCurrent() {
        if (++checks === 4) {
          if (operation === 'accept-scene') input.scene.scene = other.scene;
          else if (operation.endsWith('scene-dispose')) f.scene.dispose();
          else if (operation.endsWith('scene-sync')) f.adopt({ ...f.opaque, roughness: 0.375 });
          else input.scene.residentExecution = Object.freeze({ ...input.plan });
        }
        return true;
      },
    };
    if (operation.startsWith('prepare'))
      expect(f.production.prepareResidentBatch(guarded).ok).toBe(false);
    else {
      const result = f.production.acceptResidentBatches({
        ...guarded,
        contributions: [contribution],
      });
      if (result.ok) result.value.release();
      expect(result.ok).toBe(false);
    }
    expect(checks).toBe(4);
    expect(Reflect.get(f.production, 'residentRowHolds').size).toBe(0);
  } finally {
    input.scene.scene = f.scene;
    f.dispose();
    other.dispose();
  }
});

it('prepares the actual Production main and all owned shadow inputs, including retiring views', async () => {
  const f = await fixture(4, false, true);
  const matrix = mat4.identity(mat4.create());
  const requests = [0, 1].map((index) => ({
    identity: { kind: 'spot' as const, index, layer: 'static' as const },
    matrix,
    planes: frustum.fromViewProjection(frustum.create(), matrix),
    targetSize: 64,
  }));
  const frame = f.prepare();
  assert(frame);
  frame.updateShadowViews?.(requests).unwrap();
  frame._sealResourceReads().unwrap();
  frame._commitResourceReplacement?.();
  const pool = frame.shadowViewPool;
  assert(pool);
  const retained = requests[0];
  assert(retained);
  pool.retain([retained.identity]);
  expect(pool.activeIdentities()).toHaveLength(1);
  const shadows = pool.inputBindingViews(f.scene);
  expect(shadows).toHaveLength(2);
  const task = f.scene.inputs.prepareBuffer().unwrap();
  const creates = vi.spyOn(f.device, 'createBindGroup');
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    const prepared = f.production.prepareInputBindings(f.scene, task).unwrap();
    expect(creates).toHaveBeenCalledTimes(3);
    for (const [descriptor] of creates.mock.calls) {
      const target = [...descriptor.entries].find((entry) => entry.binding === 3)?.resource;
      expect(target?.kind === 'buffer' ? target.value.buffer : undefined).toBe(task.buffer);
    }
    for (let step = 0; step < 10000; step++) if (task.step(64).unwrap().phase === 'current') break;
    expect(prepared.isCurrent()).toBe(true);
    expect(prepared.publish().ok).toBe(false);
    creates.mockClear();
    writes.mockClear();
    task.commitPrepared().unwrap();
    expect(prepared.isCurrent()).toBe(true);
    prepared.publish().unwrap();
    expect(prepared.isCurrent()).toBe(false);
    expect(prepared.publish().ok).toBe(false);
    expect(creates).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    for (const view of shadows) expect(view.sceneInputBuffer).toBe(task.buffer);
    // Releasing the consumed numeric task does not roll back its physical publication.
    task.release();
    expect(f.scene.inputs.isCurrentBuffer(task.buffer)).toBe(true);
    prepared.release();
  } finally {
    creates.mockRestore();
    writes.mockRestore();
    task.release();
    f.dispose();
  }
});

it('refuses Production binding preparation during an unsubmitted real resource frame', async () => {
  const f = await fixture(4);
  assert(f.prepare());
  const task = f.scene.inputs.prepareBuffer().unwrap();
  const creates = vi.spyOn(f.device, 'createBindGroup');
  try {
    expect(f.production.prepareInputBindings(f.scene, task).ok).toBe(false);
    expect(creates).not.toHaveBeenCalled();
    f.abortPending();
    const prepared = f.production.prepareInputBindings(f.scene, task).unwrap();
    prepared.release();
  } finally {
    creates.mockRestore();
    task.release();
    f.dispose();
  }
});

it('releases every private Production pair after partial creation fails and permits retry', async () => {
  const f = await fixture(4, false, true);
  const matrix = mat4.identity(mat4.create());
  const frame = f.prepare();
  assert(frame);
  frame
    .updateShadowViews?.([
      {
        identity: { kind: 'spot', index: 0, layer: 'static' },
        matrix,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
        targetSize: 64,
      },
    ])
    .unwrap();
  frame._sealResourceReads().unwrap();
  frame._commitResourceReplacement?.();
  const task = f.scene.inputs.prepareBuffer().unwrap();
  const original = f.device.createBindGroup.bind(f.device);
  let calls = 0;
  const creates = vi
    .spyOn(f.device, 'createBindGroup')
    .mockImplementation((descriptor) =>
      ++calls === 2
        ? err(new RhiError({ code: 'internal-error', expected: 'native binding', hint: 'retry' }))
        : original(descriptor),
    );
  try {
    expect(f.production.prepareInputBindings(f.scene, task).ok).toBe(false);
    creates.mockImplementation(original);
    const retry = f.production.prepareInputBindings(f.scene, task).unwrap();
    for (let step = 0; step < 10000; step++) if (task.step(64).unwrap().phase === 'current') break;
    expect(retry.isCurrent()).toBe(true);
    task.commitPrepared().unwrap();
    retry.publish().unwrap();
    retry.release();
  } finally {
    creates.mockRestore();
    task.release();
    f.dispose();
  }
});

it('rejects Production publication when an owned retiring View leaves the actual pool', async () => {
  const f = await fixture(4, false, true);
  const matrix = mat4.identity(mat4.create());
  const frame = f.prepare();
  assert(frame);
  frame
    .updateShadowViews?.([
      {
        identity: { kind: 'spot', index: 0, layer: 'static' },
        matrix,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
        targetSize: 64,
      },
    ])
    .unwrap();
  frame._sealResourceReads().unwrap();
  frame._commitResourceReplacement?.();
  const pool = frame.shadowViewPool;
  assert(pool);
  pool.retain([]);
  const task = f.scene.inputs.prepareBuffer().unwrap();
  const prepared = f.production.prepareInputBindings(f.scene, task).unwrap();
  try {
    for (let step = 0; step < 10000; step++) if (task.step(64).unwrap().phase === 'current') break;
    expect(prepared.isCurrent()).toBe(true);
    pool._commitResourceReplacement();
    expect(prepared.isCurrent()).toBe(false);
    expect(prepared.publish().ok).toBe(false);
    prepared.release();
    prepared.release();
  } finally {
    prepared.release();
    task.release();
    f.dispose();
  }
});

it.each([
  'cancel',
  'dispose',
] as const)('closes owned Production View preparations on %s', async (mode) => {
  const f = await fixture(4);
  assert(f.prepare());
  f.abortPending();
  const task = f.scene.inputs.prepareBuffer().unwrap();
  const prepared = f.production.prepareInputBindings(f.scene, task).unwrap();
  try {
    if (mode === 'cancel') prepared.release();
    else f.production.dispose();
    expect(prepared.isCurrent()).toBe(false);
    expect(prepared.publish().ok).toBe(false);
    // This lease owns bindings; the still-private numeric target remains Inputs-owned.
    expect(f.scene.inputs.preparationTarget(task)).toBeDefined();
    if (mode === 'cancel') {
      const retry = f.production.prepareInputBindings(f.scene, task).unwrap();
      retry.release();
    } else expect(f.production.prepareInputBindings(f.scene, task).ok).toBe(false);
  } finally {
    prepared.release();
    task.release();
    f.dispose();
  }
});

async function shadowInputFixture() {
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const positions = mesh.attributes.position as Float32Array;
  const meshes = new MeshFrame().with(3, {
    ...mesh,
    morphTargets: [{ position: new Float32Array(positions.length) }],
  });
  const f = await fixture(4, false, true, false, false, false, meshes);
  f.updateEntity(0, false, { morph: { weights: new Float32Array([1]), targetCount: 1 } });
  expect(f.scene.hasMorphRows).toBe(true);
  const frame = f.prepare();
  assert(frame);
  const matrix = mat4.identity(mat4.create());
  const requests = [0, 1].map((index) => ({
    identity: { kind: 'spot' as const, index, layer: 'static' as const },
    matrix,
    planes: frustum.fromViewProjection(frustum.create(), matrix),
    targetSize: 64,
  }));
  frame.updateShadowViews?.(requests).unwrap();
  frame._sealResourceReads().unwrap();
  frame._commitResourceReplacement();
  const pool = frame.shadowViewPool;
  assert(pool);
  const first = requests[0];
  assert(first);
  pool.retain([first.identity]);
  expect(pool.inputBindingViews(f.scene)).toHaveLength(2);
  const publication = frame.shadowBatchProjections?.();
  assert(publication);
  expect(publication.size).toBe(2);
  return { ...f, frame, pool, publication, first };
}

function finishInputs(task: GpuSceneInputPreparation) {
  for (let step = 0; step < 10000; step++) if (task.step(64).unwrap().phase === 'current') return;
  throw new Error('Inputs copy did not finish');
}

it('publishes actual shadow issuer facts including retiring views and preserves old readonly projections', async () => {
  const f = await shadowInputFixture();
  const input = f.scene.inputs.prepareBuffer().unwrap();
  finishInputs(input);
  const original = f.device.createBindGroup.bind(f.device);
  const buffers = new Map<object, object>();
  const creates = vi.spyOn(f.device, 'createBindGroup').mockImplementation((descriptor) => {
    const result = original(descriptor);
    const resource = [...descriptor.entries].find((entry) => entry.binding === 8)?.resource;
    if (result.ok && resource?.kind === 'buffer') buffers.set(result.value, resource.value.buffer);
    return result;
  });
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  const sources = Reflect.get(f.production, 'shadowProjectionSources') as WeakMap<
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    ShadowProjectionSource
  >;
  const before = [...f.publication].map(([key, projection]) => ({
    key,
    projection,
    source: sources.get(projection),
    groups: [...projection].map(([id, row]) => [id, row.visibleBindGroups] as const),
  }));
  const prepared = f.production.prepareInputBindings(f.scene, input).unwrap();
  try {
    expect(prepared.isCurrent()).toBe(true);
    creates.mockClear();
    writes.mockClear();
    input.commitPrepared().unwrap();
    prepared.publish().unwrap();
    expect(creates).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    const publication = f.frame.shadowBatchProjections?.();
    assert(publication);
    expect(publication).not.toBe(f.publication);
    const identity = Reflect.get(f.production, 'materialRaster').visibleBindingIdentity;
    for (const old of before) {
      const next = publication.get(old.key);
      assert(next);
      expect(next).not.toBe(old.projection);
      expect(sources.get(old.projection)).toBe(old.source);
      expect(sources.get(next)?.visibleBindingIdentity).toBe(identity);
      expect(Reflect.get(f.production, 'shadowUnchangedInputs').get(old.key).projections).toBe(
        next,
      );
      for (const [id, oldGroups] of old.groups) {
        expect(old.projection.get(id)?.visibleBindGroups).toBe(oldGroups);
        const groups = next.get(id)?.visibleBindGroups;
        assert(groups);
        expect(groups).not.toBe(oldGroups);
        for (const group of groups) expect(buffers.get(group)).toBe(input.buffer);
      }
    }
    creates.mockClear();
    const frame = f.prepare();
    assert(frame);
    frame.updateShadowViews?.([f.first]).unwrap();
    const kept = frame.shadowBatchProjections?.();
    assert(kept);
    for (const [key, projection] of kept) expect(projection).toBe(publication.get(key));
    expect(creates).not.toHaveBeenCalled();
    frame._sealResourceReads().unwrap();
    frame._commitResourceReplacement();
  } finally {
    creates.mockRestore();
    writes.mockRestore();
    prepared.release();
    input.release();
    f.dispose();
  }
});

it.each([
  'source-edit',
  'remove-retiring',
] as const)('refuses actual Root native construction after %s and permits retry', async (change) => {
  const f = await shadowInputFixture();
  let input = f.scene.inputs.prepareBuffer().unwrap();
  finishInputs(input);
  const projection = f.publication.values().next().value;
  assert(projection);
  const sources = Reflect.get(f.production, 'shadowProjectionSources') as WeakMap<
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    ShadowProjectionSource
  >;
  const source = sources.get(projection);
  assert(source);
  const filtered = source.filtered;
  const original = f.device.createBindGroup.bind(f.device);
  const creates = vi.spyOn(f.device, 'createBindGroup').mockImplementationOnce((descriptor) => {
    const result = original(descriptor);
    if (change === 'source-edit') source.filtered = { ...filtered };
    else f.pool._commitResourceReplacement();
    return result;
  });
  try {
    expect(f.production.prepareInputBindings(f.scene, input).ok).toBe(false);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(f.frame.shadowBatchProjections?.()).toBe(f.publication);
    source.filtered = filtered;
    creates.mockImplementation(original);
    input.release();
    const frame = f.prepare();
    assert(frame);
    frame.updateShadowViews?.([f.first]).unwrap();
    frame._sealResourceReads().unwrap();
    frame._commitResourceReplacement();
    input = f.scene.inputs.prepareBuffer().unwrap();
    finishInputs(input);
    const retry = f.production.prepareInputBindings(f.scene, input).unwrap();
    expect(retry.isCurrent()).toBe(true);
    retry.release();
  } finally {
    creates.mockRestore();
    input.release();
    f.dispose();
  }
});

it('collects disposed fixture owners without creating an input task', async () => {
  const held = await (async () => {
    const f = await fixture(2);
    assert(f.prepare());
    f.abortPending();
    const production = new WeakRef(f.production),
      scene = new WeakRef(f.scene);
    const retiring = f.production.inputBindingViews(f.scene);
    f.dispose();
    for (const view of retiring) (await view.settleRetirement()).unwrap();
    return { production, scene };
  })();
  await collectWeakOwners();
  expect(held.production.deref() === undefined).toBe(true);
  expect(held.scene.deref() === undefined).toBe(true);
});

it.each([
  ['rigid', 'publish'],
  ['rigid', 'release'],
  ['raster', 'publish'],
  ['raster', 'release'],
] as const)('drops actual %s Production and Scene after %s while the closed task stays held', async (scope, operation) => {
  const held = await (async () => {
    const f = scope === 'raster' ? await shadowInputFixture() : await fixture(2);
    if (scope === 'rigid') {
      assert(f.prepare());
      f.abortPending();
    }
    const input = f.scene.inputs.prepareBuffer().unwrap();
    finishInputs(input);
    const task = f.production.prepareInputBindings(f.scene, input).unwrap();
    const production = new WeakRef(f.production),
      scene = new WeakRef(f.scene);
    const retiring = f.production.inputBindingViews(f.scene);
    if (operation === 'publish') {
      input.commitPrepared().unwrap();
      task.publish().unwrap();
    } else task.release();
    input.release();
    f.dispose();
    for (const view of retiring) (await view.settleRetirement()).unwrap();
    return { task, production, scene };
  })();
  await collectWeakOwners();
  expect(held.production.deref() === undefined).toBe(true);
  expect(held.scene.deref() === undefined).toBe(true);
  expect(held.task.isCurrent()).toBe(false);
});
