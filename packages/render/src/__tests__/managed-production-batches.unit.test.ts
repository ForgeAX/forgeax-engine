import { createBoxGeometry } from '@forgeax/engine-geometry';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FrameRecording,
  recordFrameTransaction,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialDispatch } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { createSkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { observeCandidateReads } from './gpu-driven-candidate-read-observer';
import { mesh, standardPbrInputs } from './gpu-driven-production-fixture';

async function fixture(
  count: number,
  transparent = false,
  shadows = false,
  splitMaterials = false,
  skinned = false,
) {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'fixture' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const pbr = standardPbrInputs(device, shader, viewLayout);
  const materialPipelineState = pbr.materialPipelineState;
  assert(materialPipelineState);
  const receipt = createStandardPbrArtifactReceipt(skinned);
  const palette = skinned ? createSkinPaletteAllocator(device, 1 << 20) : undefined;
  const skinReceipt = palette?.allocatePersistentSlice({
    identity: 'shared-pose',
    generation: 1,
    jointCount: 1,
    bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
  });
  if (palette !== undefined) {
    const skinLayout = device
      .createBindGroupLayout({
        entries: [0, 1].map((binding) => ({
          binding,
          visibility: 1,
          buffer: { type: 'read-only-storage' as const },
        })),
      })
      .unwrap();
    Object.assign(pbr, { materialArtifact: { ...pbr.materialArtifact, receipt } });
    Object.assign(materialPipelineState, {
      skinPaletteAllocator: palette,
      gpuDrivenPbrSkinPipelineLayout: materialPipelineState.gpuDrivenPbrPipelineLayout,
      pbrSkinMeshBindGroupLayout: skinLayout,
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
  const secondMaterial = new MaterialResource({ ...opaque, materialHandle: 8 });
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
    worldId: 0,
    ...(skinReceipt === undefined ? {} : { skin: skinReceipt }),
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
  const delta = projection.apply(
    Array.from({ length: count }, (_, entityKey) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey,
      snapshot: {
        ...snapshot,
        entityKey,
        ...(splitMaterials && entityKey >= count / 2
          ? { material: secondMaterial, materials: [secondMaterial] }
          : {}),
      },
    })),
  );
  const available = GpuScene.create(device, count).unwrap();
  if (available.status !== 'available') throw new Error('Missing GPU Scene');
  const scene = available.scene;
  scene.sync(delta).unwrap();
  const slots = projection.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const dispatch = new MaterialDispatch();
  for (const slot of slots) dispatch.bind(slot.slot, slot.snapshot);
  const programs = new GpuDrivenMaterialProgramProjection();
  const gpuMesh = mesh(device);
  const work = { memberReads: 0, candidateReads: 0, sharedMeshReads: 0, slotReads: 0 };
  const meshReads = new Map(
    topology.query(topology.sourcePlan(), undefined).batches.map((batch) => {
      assert(batch.binding);
      return [batch.binding, gpuMesh] as const;
    }),
  );
  const getMesh = meshReads.get.bind(meshReads);
  vi.spyOn(meshReads, 'get').mockImplementation((binding) => {
    work.sharedMeshReads++;
    return getMesh(binding);
  });
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const source = topology.query(topology.sourcePlan(), undefined);
  const stopObservingCandidates = observeCandidateReads(
    source.batches.map((batch) => batch.candidates),
    () => {
      work.candidateReads++;
    },
  );
  const plan = {
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
    plan,
    slots,
    completeGeometry: topology.completeGeometry,
    slotForEntity: projection.slot,
    slotAt: (slot: number) => {
      work.slotReads++;
      return projection.slotAt(slot);
    },
  };
  let pending: PreparedGpuDrivenFrame | undefined;
  const prepare = (replace = true) => {
    // Repeated fixture calls abandon the previous unsubmitted recording.
    if (replace) pending?._abortResourceReplacement?.();
    const selected = collectGpuDrivenMaterialArtifacts({
      batches: topology.query(topology.sourcePlan(), undefined).batches,
      programs: programs.project(dispatch.query(slots), dispatch.materials()),
      resolve: () => pbr.materialArtifact,
      clustered: false,
      reflectionFallback: false,
      probeBlend: false,
      shadowViews: shadows,
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
  const adopt = (snapshot: MaterialSnapshot) => {
    material.adopt(snapshot);
    dispatch.adopt(material);
    scene.sync({ ...projection.apply([]), materialUpdates: [material] }).unwrap();
  };
  const dispose = () => {
    stopObservingCandidates();
    production.dispose();
    scene.dispose();
    palette?.dispose();
    gpuMesh.vertexBuffer.destroy();
    gpuMesh.indexBuffer?.destroy();
  };
  return {
    device,
    scene,
    setMeshes: (meshes: MeshFrame) => Object.assign(state, { meshes }),
    material,
    prepare,
    adopt,
    opaque,
    blended,
    topology,
    production,
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
          encoder: f.device.createCommandEncoder().unwrap(),
          device: f.device,
          onSubmittedWork: (done) => prepared._trackSubmittedWork?.(done),
          reportError: (error) => {
            throw error;
          },
        },
      );
      return result.ok;
    })();
    submitFrameRecordings([recording]);
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
    const plan = f.topology.query(f.topology.sourcePlan(), undefined);
    expect(plan.candidateCount).toBe(128);
    expect(f.prepare()).toBeUndefined();
    f.adopt(f.opaque);
    const ready = f.prepare();
    expect(ready).toBeDefined();
    expect(f.topology.query(f.topology.sourcePlan(), undefined)).toBe(plan);
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
    for (const material of [f.blended, f.opaque]) {
      f.work.memberReads = f.work.candidateReads = f.work.sharedMeshReads = f.work.slotReads = 0;
      f.adopt(material);
      expect(f.prepare()).toBeDefined();
      expect(f.work).toEqual({
        memberReads: 0,
        candidateReads: 0,
        sharedMeshReads: 2,
        slotReads: 0,
      });
      expect(f.production.inspect().sharedInputUploadBytes).toBe(4 * 1024 + 8); // Map pages and material descriptor.
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
    const first = old.shadowBatchProjections?.values().next().value?.values().next().value;
    expect(first?.material.roughness).toBe(0.5);
    old._commitResourceReplacement?.();
    expect(() => old.updateShadowViews?.(views)).toThrow('open resource frame');
    const next = f.prepare();
    next?.updateShadowViews?.(views).unwrap();
    const current = next?.shadowBatchProjections?.values().next().value?.values().next().value;
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
    const first = old?.shadowBatchProjections?.values().next().value?.values().next().value;
    old?._commitResourceReplacement?.();
    const quiet = f.prepare();
    quiet?.updateShadowViews?.(views).unwrap();
    expect(quiet?.shadowViewPool?.invalidationReason(identity)).toBeUndefined();
    quiet?._commitResourceReplacement();
    f.touchMesh();
    const next = f.prepare();
    next?.updateShadowViews?.(views).unwrap();
    const changed = next?.shadowBatchProjections?.values().next().value?.values().next().value;
    expect(changed?.mesh).toBe(first?.mesh);
    expect(changed?.meshContentEpoch).toBe((first?.meshContentEpoch ?? -1) + 1);
    expect(next?.shadowViewPool?.invalidationReason(identity)).toBe('content-changed');
  } finally {
    f.dispose();
  }
});

it('retains shadow candidate ranges across shared material edits through view preparation', async () => {
  const f = await fixture(10_000, false, true);
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
    expect(frame?.shadowBatchProjections?.values().next().value?.size).toBe(1);
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
  const f = await fixture(10_000, false, true);
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
    const meshFrame = new MeshFrame().with(0, 3, createBoxGeometry(1, 1, 1).unwrap());
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
  const source = f.topology.query(f.topology.sourcePlan(), undefined);
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
      expect(f.topology.query(f.topology.sourcePlan(), undefined)).toBe(source);
      expect(f.work.memberReads).toBe(0);
      expect(f.work.candidateReads).toBe(0);
      expect(f.work.slotReads).toBe(0);
      frame._commitResourceReplacement();
    }
  } finally {
    f.dispose();
  }
});
