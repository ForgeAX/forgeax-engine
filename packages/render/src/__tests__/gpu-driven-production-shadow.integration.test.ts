import { World } from '@forgeax/engine-ecs';
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import { type Buffer, RhiError, type RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { gpuDrivenMaterialArtifactKey, gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import * as batchTopology from '../gpu-driven/batch-topology';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { collectGpuDrivenMaterialArtifacts } from '../gpu-driven/material-artifacts';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import {
  SHADOW_CASTER_PROMOTE_WINDOW,
  SHADOW_CASTER_SETTLE_FRAMES,
} from '../gpu-driven/shadow-caster-classes';
import { type ShadowViewIdentity, shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { buildDispatchPlan } from '../record/frame';
import { makeZeroCameraFallbackSnapshot, worldEntityKey } from '../record/frame-snapshot';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  recordShadowCasterDraws,
  shadowShaderMap,
} from '../record/shadow-pass';
import type {
  DispatchEntry,
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import { shadowCasterCpuReason } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import {
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
  withoutPrepared,
} from './gpu-driven-production-fixture';

const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();

function shadowCandidateCount(
  pool:
    | { submission(identity: ShadowViewIdentity): { plan: { candidateCount: number } } | undefined }
    | undefined,
  identity: ShadowViewIdentity,
): number {
  return (
    (pool?.submission(identity)?.plan.candidateCount ?? 0) +
    (pool?.submission({ ...identity, layer: 'static' })?.plan.candidateCount ?? 0)
  );
}

type PrepareInput = Parameters<GpuDrivenProduction['prepare']>[0];

describe('GPU-driven production shadow projection', () => {
  it('admits prepared Alpha Mask draws to the GPU shadow lane', () => {
    const source = preparedSnapshot(10, 3);
    const alphaMaterial = {
      ...source.material,
      paramSnapshot: { alphaCutoff: 0.5 },
      textureHandles: new Map([['baseColorTexture', 1]]) as never,
      samplerHandles: new Map([['baseColorTexture', 2]]) as never,
    } as MaterialSnapshot;
    const draw = source.gpuDrivenDraws?.[0];
    expect(draw?.prepared).toBeDefined();
    if (draw === undefined || draw.prepared === undefined) return;

    // Alpha Mask is a prepared material fact: it keeps the opaque depth
    // state, carries an authored cutoff, and owns the base-color resource
    // needed by the shadow fragment discard. Alpha Blend is covered by the
    // adjacent residual-lane regression and must remain CPU-owned.
    expect(
      shadowCasterCpuReason(
        alphaMaterial,
        draw,
        [{ materialShaderId: 'forgeax::default-shadow-caster' } as DispatchEntry],
        undefined,
        undefined,
      ),
    ).toBeUndefined();

    const projection = new RenderScene();
    projection.apply([
      updateSnapshot({ ...source, material: alphaMaterial, materials: [alphaMaterial] }),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({
      candidateCount: 1,
      batches: [{ key: { admission: 'alpha-mask' } }],
    });
  });

  it('does not admit Alpha Blend or CPU transmission draw plans as GPU-owned', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pbrPipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
      })
      .unwrap();
    const opaque = preparedSnapshot(1, 3);
    const blendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } as const;
    const alphaMaterial = {
      ...opaque.material,
      renderState: { cullMode: 'none' as const, blend: blendState, depthWriteEnabled: false },
    } as MaterialSnapshot;
    const alphaSnapshots = [2, 3].map(
      (entityKey): RenderableSnapshot => ({
        ...preparedSnapshot(entityKey, 3),
        material: alphaMaterial,
        materials: [alphaMaterial],
        gpuDrivenDraws: [],
      }),
    );
    const transmissionMaterial = {
      ...opaque.material,
      paramSnapshot: { transmission: 0.5 },
    } as MaterialSnapshot;
    const transmissionSnapshot: RenderableSnapshot = {
      ...preparedSnapshot(4, 3),
      material: transmissionMaterial,
      materials: [transmissionMaterial],
    };
    const sceneProjection = new RenderScene();
    const delta = sceneProjection.apply([
      updateSnapshot(opaque),
      ...alphaSnapshots.map((snapshot) => updateSnapshot(snapshot)),
      updateSnapshot(transmissionSnapshot),
    ]);
    const availability = GpuScene.create(device, 3).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(sceneProjection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('synthetic'),
      layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
        Record<string, unknown>
      >[],
      receipt: STANDARD_PBR_RECEIPT,
    };
    const programKey = standardPbrProgramKey(artifact.material);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const prepared = production.prepare({
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: sceneProjection.slotsSnapshot(),
        slotAt: sceneProjection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([[0, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,

      standardPbrArtifact: artifact,
      standardPbrPipelineState: {
        pbrPipelineLayout,
        meshBindGroupLayout: meshLayout,
        instancesBindGroupLayout: instancesLayout,
        gpuDrivenInstancesBindGroupLayout: instancesLayout,
        gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
        standardPbrShaderModule: shader,
        gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
      } as never,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value?.drawKeys).toEqual(new Set(['1:-1:0']));
    expect(prepared.value?.ownsAllDrawItems).toBe(false);
    production.dispose();
    availability.scene.dispose();
  });

  it.each([
    3, 4,
  ])('selects captured shadow rows without rebuilding joins across %i cascades', async (cascadeCount) => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 8).unwrap();
    if (availability.status !== 'available') throw Error('expected GPU Scene');
    const scene = availability.scene;
    const topology = new BatchTopology();
    const apply = (operations: Parameters<RenderScene['apply']>[0]) => {
      const delta = projection.apply(operations);
      scene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
      topology.apply(delta);
    };
    apply([1, 2].map((key) => updateSnapshot(preparedSnapshot(key, key + 2))));
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const input = {
      ...standardPbrInputs(device, shader, viewLayout),
      scene: {
        scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([0, 1].map((slot) => [slot, mesh(device)])),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      shadowCasterDrawKeys: new Set(['1:-1:0:0', '2:-1:0:0']),
    };
    const requests = Array.from({ length: cascadeCount }, (_, index) => {
      const matrix = mat4.orthographic(
        mat4.create(),
        -2 - index,
        2 + index,
        -2 - index,
        2 + index,
        0.1,
        100,
      );
      return {
        identity: { kind: 'directional' as const, index },
        matrix,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
      };
    });
    const project = vi.spyOn(batchTopology, 'buildBatchAlignedSubmission');
    const prepare = () => {
      input.scene = {
        scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      };
      const frame = production.prepare(input).unwrap();
      if (frame === undefined) throw Error('expected GPU-driven frame');
      project.mockClear();
      frame.updateShadowViews?.(requests).unwrap();
      const layers = ['static', undefined].map((layer) =>
        requests.map(({ identity }) => {
          const submission = frame.shadowViewPool?.submission({
            ...identity,
            ...(layer === undefined ? {} : { layer: 'static' as const }),
          });
          if (submission === undefined) throw Error('expected shadow submission');
          return submission;
        }),
      );
      return { frame, layers, projections: project.mock.calls.length };
    };
    try {
      const first = prepare();
      expect(first.projections).toBe(0);
      for (const layer of first.layers)
        expect(new Set(layer.map((view) => view.plan)).size).toBe(1);
      expect(new Set(first.layers.flat().map((view) => view.view.visibleBuffer)).size).toBe(
        2 * cascadeCount,
      );
      first.frame._commitResourceReplacement();
      const steady = prepare();
      expect(steady.projections).toBe(0);
      for (const view of steady.layers.flat()) expect(view.cache).toBe('hit');
      steady.frame._commitResourceReplacement();

      const moved = mat4.identity(mat4.create());
      moved[12] = 0.5;
      apply([{ kind: 'update', worldId: 0, entityKey: 1, world: moved }]);
      const changed = prepare();
      expect(changed.projections).toBe(0);
      for (const layer of changed.layers) {
        expect(new Set(layer.map((view) => view.plan)).size).toBe(1);
        for (const view of layer) expect(view.plan.candidateCount).toBe(1);
      }
      changed.frame._abortResourceReplacement?.();
      const retry = prepare();
      expect(retry.projections).toBe(0);
      for (const [index, layer] of retry.layers.entries()) {
        expect(new Set(layer.map((view) => view.plan)).size).toBe(1);
        expect(layer[0]?.plan).not.toBe(changed.layers[index]?.[0]?.plan);
        for (const [viewIndex, view] of layer.entries()) {
          const previous = changed.layers[index]?.[viewIndex];
          expect(view.cache).toBe('invalidated');
          expect(view.plan.batches).toEqual(previous?.plan.batches);
          expect(view.view.visibleBuffer).toBe(previous?.view.visibleBuffer);
          // Aborting the draw does not undo successful queue writes. The new
          // plan must redraw depth while identical topology bytes stay resident.
          expect(view.view.inspect().candidateUploadBytes).toBe(0);
          expect(view.view.inspect().batchUploadBytes).toBe(0);
          expect(view.view.inspect().viewConstantsUploadBytes).toBeGreaterThan(0);
        }
      }
      retry.frame._commitResourceReplacement();
    } finally {
      project.mockRestore();
      production.dispose();
      scene.dispose();
    }
  });

  it('keeps unchanged shadow batch projections when a trailing caster changes source', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const artifact = pbrInputs.standardPbrArtifact;
    if (artifact === undefined) throw Error('expected material artifact');
    const receipt = artifact.receipt;
    if (receipt === undefined) throw Error('expected material receipt');
    const rows = [1, 2, 3, 4].map((key, renderableIndex) => {
      const source = preparedSnapshot(key, key + 2);
      return {
        renderableIndex,
        source: {
          ...source,
          gpuDrivenDraws: (source.gpuDrivenDraws ?? []).map((draw) => {
            if (draw.prepared === undefined) throw Error('expected prepared draw');
            return {
              ...draw,
              prepared: { ...draw.prepared, receiptIdentity: receipt.receiptIdentity },
            };
          }),
        },
      };
    });
    let dispatch = rows.flatMap(({ renderableIndex }) =>
      ['Forward', 'ShadowCaster'].map(
        (LightMode): DispatchEntry => ({
          entityIndex: renderableIndex,
          materialHandle: -1,
          renderableIndex,
          passIndex: 0,
          queue: 2000,
          layer: 0,
          tags: { LightMode },
          renderState: undefined,
          defines: undefined,
          paramSnapshot: undefined,
          materialShaderId: artifact.material,
          vertexEntry: 'vs_scene_index',
          fragmentEntry: LightMode === 'Forward' ? 'fs_main' : 'fs_shadow',
        }),
      ),
    );
    let shadowReceipt = receipt;
    const collect = () =>
      collectGpuDrivenMaterialArtifacts({
        rows,
        dispatch,
        resolve: (_id, request) => {
          const pass = typeof request === 'object' ? (request.pass ?? 'forward') : 'forward';
          return { ...artifact, pass, receipt: pass === 'shadow' ? shadowReceipt : receipt };
        },
        clustered: false,
        reflectionFallback: false,
        shadowViews: true,
      });
    const projection = new RenderScene();
    const delta = projection.apply(rows.map(({ source }) => updateSnapshot(source)));
    const available = GpuScene.create(device, 8).unwrap();
    if (available.status !== 'available') throw Error('expected GPU Scene');
    const scene = available.scene;
    scene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const meshes = new Map([0, 1, 2, 3].map((slot) => [slot, mesh(device)]));
    let probeBlendRecordBuffer: Buffer | undefined;
    const input = {
      ...pbrInputs,
      ...collect(),
      scene: {
        scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: meshes,
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      shadowCasterDrawKeys: new Set(['1:-1:0:0', '2:-1:0:0', '3:-1:0:0', '4:-1:0:0']),
    };
    const requests = [0, 1, 2].map((index) => ({
      identity: { kind: 'directional' as const, index },
      matrix: mat4.identity(mat4.create()),
      planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      candidatePrimitiveIndices: [0, 1, 2],
    }));
    const lookup = vi.spyOn(
      MaterialAbiRasterAdapter.prototype,
      'shadowVisibleWindowBindGroupForBuffer',
    );
    const prepare = (commit = true) => {
      const previousArtifact = input.shadowMaterialArtifacts.values().next().value;
      Object.assign(input, collect());
      expect(input.shadowMaterialArtifacts.size).toBe(1);
      expect(input.shadowMaterialArtifacts.values().next().value).not.toBe(previousArtifact);
      const frame = production
        .prepare({
          ...input,
          ...(probeBlendRecordBuffer === undefined ? {} : { probeBlendRecordBuffer }),
        })
        .unwrap();
      if (frame === undefined) throw Error('expected GPU frame');
      lookup.mockClear();
      frame.updateShadowViews?.(requests).unwrap();
      const calls = lookup.mock.calls.length;
      const views = requests.map(({ identity }) => {
        const staticIdentity = { ...identity, layer: 'static' as const };
        const submission = frame.shadowViewPool?.submission(staticIdentity);
        const projections = frame.shadowBatchProjections?.get(
          shadowViewIdentityKey(staticIdentity),
        );
        if (submission === undefined || projections === undefined)
          throw Error('expected static view');
        return { submission, projections };
      });
      if (commit) frame._commitResourceReplacement();
      return { calls, views, frame };
    };
    const editMesh = (slot: number) => {
      const current = meshes.get(slot);
      if (current === undefined) throw Error('expected mesh');
      meshes.set(slot, { ...current, contentEpoch: current.contentEpoch + 1 });
      input.meshResidencyEpoch++;
    };
    try {
      let first = prepare();
      expect(first.calls).toBe(9);
      // Replacing only the ownership publication cannot change these windows.
      input.shadowCasterDrawKeys = new Set(input.shadowCasterDrawKeys);
      const republished = prepare();
      expect(republished.calls).toBe(0);
      for (const [index, view] of republished.views.entries())
        for (const [batchId, projected] of view.projections)
          expect(projected).toBe(first.views[index]?.projections.get(batchId));

      // Removing a caster outside the selected views keeps their bindings.
      input.shadowCasterDrawKeys = new Set(
        [...input.shadowCasterDrawKeys].filter((key) => key !== '4:-1:0:0'),
      );
      const outsideClaim = prepare();
      expect(outsideClaim.calls).toBe(0);
      for (const [index, view] of outsideClaim.views.entries())
        for (const [batchId, projected] of view.projections)
          expect(projected).toBe(republished.views[index]?.projections.get(batchId));

      const entries: ShadowCasterMembership[] = [1, 2, 3].map((worldEntity, renderableIndex) => ({
        worldEntity,
        renderableIndex,
        drawItemIndex: 0,
        materialHandle: -1,
        passIndex: 0,
        ...(worldEntity === 1
          ? {
              renderState: { cullMode: 'none' as const },
              vertexEntry: 'vs_scene_index',
              fragmentEntry: 'fs_shadow',
            }
          : {}),
      }));
      Object.assign(input, { shadowCasterMembership: entries });
      const entryChanged = prepare();
      expect(entryChanged.calls).toBe(3);
      for (const [index, view] of entryChanged.views.entries()) {
        for (const [batchId, projected] of view.projections) {
          if (projected.materialEntityKey === 1) {
            expect(projected).not.toBe(outsideClaim.views[index]?.projections.get(batchId));
            expect(projected.shadowRenderState?.cullMode).toBe('none');
            expect(projected.shadowVertexEntry).toBe('vs_scene_index');
            expect(projected.shadowFragmentEntry).toBe('fs_shadow');
          } else expect(projected).toBe(outsideClaim.views[index]?.projections.get(batchId));
        }
      }
      Object.assign(input, {
        shadowCasterMembership: entries.map((entry) => ({
          ...entry,
          ...(entry.renderState === undefined ? {} : { renderState: { ...entry.renderState } }),
        })),
      });
      expect(prepare().calls).toBe(0);
      Object.assign(input, { shadowCasterMembership: undefined });
      first = prepare();

      editMesh(3);
      const unused = prepare();
      expect(unused.calls).toBe(0);
      for (const [index, view] of unused.views.entries())
        for (const [batchId, projected] of view.projections)
          expect(projected).toBe(first.views[index]?.projections.get(batchId));

      editMesh(2);
      const changed = prepare();
      for (const [index, view] of changed.views.entries()) {
        expect(view.submission.plan).not.toBe(unused.views[index]?.submission.plan);
        expect(view.submission.plan.batches).toHaveLength(2);
        expect(view.submission.view.visibleBuffer).toBe(
          unused.views[index]?.submission.view.visibleBuffer,
        );
        for (const batch of view.submission.plan.batches) {
          const before = unused.views[index]?.submission.plan.batches.find(
            (old) => old.batchId === batch.batchId,
          );
          expect(batch.visibleBase).toBe(before?.visibleBase);
          expect(batch.visibleCapacity).toBe(before?.visibleCapacity);
        }
      }
      // Only the changed caster's three dynamic views need a new projection.
      expect(changed.calls).toBe(3);
      for (const [index, view] of changed.views.entries())
        for (const [batchId, projected] of view.projections)
          expect(projected).toBe(unused.views[index]?.projections.get(batchId));

      // Keep the view allocation while replacing a shared visible-window binding.
      probeBlendRecordBuffer = device
        .createBuffer({
          size: 256,
          usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap();
      const rebound = prepare();
      expect(rebound.calls).toBe(9);
      for (const [index, view] of rebound.views.entries()) {
        expect(view.submission.view.visibleBuffer).toBe(
          changed.views[index]?.submission.view.visibleBuffer,
        );
        for (const [batchId, projected] of view.projections) {
          const previous = changed.views[index]?.projections.get(batchId);
          expect(projected).not.toBe(previous);
          expect(projected.visibleBindGroups[0]).not.toBe(previous?.visibleBindGroups[0]);
        }
      }

      // Main and ShadowCaster select their actual entries independently.
      for (const LightMode of ['Forward', 'ShadowCaster']) {
        dispatch = dispatch.map((entry) =>
          entry.tags.LightMode === LightMode
            ? { ...entry, fragmentEntry: `fs_${LightMode}_replacement` }
            : entry,
        );
        const replaced = prepare();
        expect(replaced.calls).toBe(LightMode === 'ShadowCaster' ? 9 : 0);
        if (LightMode === 'Forward') {
          for (const [index, view] of replaced.views.entries())
            for (const [batchId, projected] of view.projections)
              expect(projected).toBe(rebound.views[index]?.projections.get(batchId));
        } else
          for (const view of replaced.views)
            for (const projected of view.projections.values())
              expect(projected.shadowArtifact?.fragmentEntry).toBe('fs_ShadowCaster_replacement');
      }
      if (shadowReceipt === undefined) throw Error('expected shadow receipt');
      shadowReceipt = { ...shadowReceipt, generation: shadowReceipt.generation + 1 };
      expect(prepare().calls).toBe(9);

      const beforeRemoval = prepare();
      expect(beforeRemoval.calls).toBe(0);
      editMesh(0);
      const removed = prepare(false);
      // Both dynamic casters rebind; the remaining static batch keeps its
      // physical range even after an earlier static batch leaves the view.
      expect(removed.calls).toBe(6);
      for (const [index, view] of removed.views.entries()) {
        expect(view.submission.plan.batches).toHaveLength(1);
        const batch = view.submission.plan.batches[0];
        if (batch === undefined) throw Error('expected remaining static batch');
        const previous = beforeRemoval.views[index];
        expect(view.submission.view.visibleBuffer).toBe(previous?.submission.view.visibleBuffer);
        expect(batch.visibleBase).toBe(
          previous?.submission.plan.batches.find((old) => old.batchId === batch.batchId)
            ?.visibleBase,
        );
        expect(
          previous?.submission.plan.batches.find((old) => old.batchId === batch.batchId)
            ?.visibleBase,
        ).toBe(16);
        expect(view.projections.get(batch.batchId)).toBe(previous?.projections.get(batch.batchId));
      }
      removed.frame._abortResourceReplacement?.();
      const retried = prepare();
      // Submission failure invalidates depth, not unchanged physical bindings.
      expect(retried.calls).toBe(0);
      for (const [index, view] of retried.views.entries()) {
        expect(view.submission.cache).toBe('invalidated');
        expect(view.submission.plan).not.toBe(removed.views[index]?.submission.plan);
        expect(view.submission.plan.batches).toEqual(removed.views[index]?.submission.plan.batches);
        for (const [batchId, projected] of view.projections)
          expect(projected).toBe(removed.views[index]?.projections.get(batchId));
      }
    } finally {
      lookup.mockRestore();
      production.dispose();
      scene.dispose();
      if (probeBlendRecordBuffer !== undefined) device.destroyBuffer(probeBlendRecordBuffer);
    }
  });

  it('retains view bindings across unrelated mesh edits and refreshes changed shadow claims', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const delta = projection.apply(
      [1, 2, 3].map((key) => updateSnapshot(preparedSnapshot(key, key + 2))),
    );
    const availability = GpuScene.create(device, 3).unwrap();
    if (availability.status !== 'available') throw new Error('expected GPU Scene');
    availability.scene
      .sync(delta, undefined, () => ({ min: [-0.25, -0.25, -0.25], max: [0.25, 0.25, 0.25] }))
      .unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const meshes = new Map([0, 1, 2].map((slot) => [slot, mesh(device)]));
    const input = {
      ...standardPbrInputs(device, shader, viewLayout),
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: meshes,
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      shadowCasterDrawKeys: new Set(['1:-1:0:0', '2:-1:0:0', '3:-1:0:0']),
    };
    const identities = [0, 1, 2].map((index) => ({ kind: 'directional' as const, index }));
    const candidates = [0, 1];
    const requests = identities.map((identity) => ({
      identity,
      planes: new Float32Array(24),
      matrix: mat4.create(),
      candidatePrimitiveIndices: candidates,
    }));
    const prepare = () => {
      const frame = production.prepare(input).unwrap();
      if (frame === undefined) throw new Error('expected GPU-driven frame');
      frame.updateShadowViews?.(requests).unwrap();
      const views = identities.map((identity) => {
        const key = shadowViewIdentityKey({ ...identity, layer: 'static' });
        const submission = frame.shadowViewPool?.submission({ ...identity, layer: 'static' });
        const bindings = frame.shadowBatchProjections?.get(key);
        const claims = frame.shadowDrawKeysByView?.get(key);
        if (submission === undefined || bindings === undefined || claims === undefined) {
          throw new Error('expected projected shadow view');
        }
        expect(submission.plan.candidateCount).toBe(2);
        expect(bindings.size).toBe(2);
        return { submission, bindings, claims };
      });
      frame._commitResourceReplacement();
      return { frame, views };
    };
    const first = prepare();
    const publication = first.frame.shadowBatchProjections;
    expect(first.frame.shadowBatchProjections).toBe(publication);
    expect(Reflect.get(publication ?? {}, 'clear')).toBeUndefined();
    for (const view of first.views) expect(Reflect.get(view.bindings, 'clear')).toBeUndefined();
    const rewrapped = production.prepare(input).unwrap();
    if (rewrapped === undefined) throw Error('missing unchanged frame');
    rewrapped.updateShadowViews?.(requests).unwrap();
    expect(rewrapped.shadowBatchProjections).toBe(rewrapped.shadowBatchProjections);
    expect(
      publication?.get(
        shadowViewIdentityKey({ ...identities[0], kind: 'directional', index: 0, layer: 'static' }),
      ),
    ).toBe(first.views[0]?.bindings);
    expect(new Set(first.views.map((view) => view.submission.plan)).size).toBe(1);
    const unrelatedMesh = meshes.get(2);
    if (unrelatedMesh === undefined) throw new Error('expected mesh outside the selected views');
    const bindWindow = vi.spyOn(
      MaterialAbiRasterAdapter.prototype,
      'shadowVisibleWindowBindGroupForBuffer',
    );
    try {
      for (let frame = 0; frame < 60; frame += 1) {
        // Real residency content changes rebuild preparation for the excluded
        // mesh. No selected view consumes that mesh or its shadow bindings.
        meshes.set(2, { ...unrelatedMesh, contentEpoch: frame + 1 });
        input.meshResidencyEpoch += 1;
        const next = prepare();
        expect(production.inspect().planRebuildBatches).toBe(1);
        for (const [index, view] of next.views.entries()) {
          expect(view.submission.cache).toBe('hit');
          expect(view.submission.plan).toBe(first.views[index]?.submission.plan);
          for (const [batchId, binding] of view.bindings) {
            expect(binding).toBe(first.views[index]?.bindings.get(batchId));
          }
          expect(view.claims).toBe(first.views[index]?.claims);
        }
      }
      expect(bindWindow).not.toHaveBeenCalled();

      // A changed pass index keeps the same draw layout but changes which
      // dispatch the GPU owns. Both static and inherited final claims refresh.
      input.shadowCasterDrawKeys = new Set(['1:-1:0:1', '2:-1:0:0', '3:-1:0:0']);
      const changed = prepare();
      for (const [index, view] of changed.views.entries()) {
        expect(view.submission.plan).toBe(first.views[index]?.submission.plan);
        expect(view.claims).toEqual(new Set(['1:-1:0:1', '2:-1:0:0']));
        for (const [batchId, binding] of view.bindings) {
          expect(binding).toBe(first.views[index]?.bindings.get(batchId));
        }
        expect(
          changed.frame.shadowDrawKeysByView?.get(
            shadowViewIdentityKey(identities[index] as ShadowViewIdentity),
          ),
        ).toEqual(view.claims);
      }
      expect(bindWindow).not.toHaveBeenCalled();

      // A selected caster outside the retained frustum can replace its mesh
      // while depth stays a hit. The next draw must bind the new resource.
      const pointIdentity = {
        kind: 'point' as const,
        index: 0,
        face: 0 as const,
        layer: 'static' as const,
      };
      const pointPlanes = new Float32Array(24);
      pointPlanes[0] = 1;
      pointPlanes[3] = -10;
      const preparePoint = () => {
        const frame = production.prepare(input).unwrap();
        if (frame === undefined) throw new Error('expected GPU-driven frame');
        frame
          .updateShadowViews?.([
            {
              identity: pointIdentity,
              planes: pointPlanes,
              candidatePrimitiveIndices: [0, 1],
            },
          ])
          .unwrap();
        const submission = frame.shadowViewPool?.submission(pointIdentity);
        const bindings = frame.shadowBatchProjections?.get(shadowViewIdentityKey(pointIdentity));
        if (submission === undefined || bindings === undefined) throw new Error('expected view');
        frame._commitResourceReplacement();
        return { submission, bindings };
      };
      const outside = preparePoint();
      const replacement = mesh(device);
      meshes.set(0, replacement);
      input.meshResidencyEpoch += 1;
      const replaced = preparePoint();
      expect(replaced.submission.cache).toBe('hit');
      expect(replaced.submission.plan).toBe(outside.submission.plan);
      expect(replaced.submission.plan.candidateCount).toBe(2);
      expect([...replaced.bindings.values()][0]).not.toBe([...outside.bindings.values()][0]);
      expect([...replaced.bindings.values()][0]?.mesh).toBe(replacement);
    } finally {
      bindWindow.mockRestore();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('retains shadow topology across main-view binding changes and refreshes shadow dependencies', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const delta = projection.apply([1, 2].map((key) => updateSnapshot(preparedSnapshot(key, 3))));
    const casterBounds = () => ({
      min: [-0.25, -0.25, -0.25] as const,
      max: [0.25, 0.25, 0.25] as const,
    });
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta, undefined, casterBounds).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const input = {
      ...pbrInputs,
      scene: {
        scene: availability.scene,
        plan: topology.plan(),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([
        [0, mesh(device)],
        [1, mesh(device)],
      ]),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,
      shadowCasterDrawKeys: new Set(['1:-1:0:0', '2:-1:0:0']),
      materialBindingClasses: new Map([['0:1:-1', 'forward|probe:first']]),
    } as { -readonly [K in keyof PrepareInput]: PrepareInput[K] } & typeof pbrInputs & {
        meshResidencyEpoch: number;
      };
    const identity = { kind: 'directional' as const, index: 0 };
    const planes = new Float32Array(24);
    const lightMatrix = mat4.create();
    const prepare = () => {
      const frame = production.prepare(input).unwrap();
      if (frame === undefined) throw new Error('expected prepared shadow frame');
      expect(
        frame.updateShadowViews?.([
          { identity, planes, matrix: lightMatrix, candidatePrimitiveIndices: [0, 1] },
        ]).ok,
      ).toBe(true);
      // Settled casters live in the view's static layer.
      const submission = frame.shadowViewPool?.submission({ ...identity, layer: 'static' });
      if (submission === undefined) throw new Error('expected shadow submission');
      return { frame, submission };
    };
    // A retained source may precede its first resident mesh. Its later
    // admission changes the shadow plan even without a scene delta.
    const arrivingMesh = input.meshBySlot.get(1);
    if (arrivingMesh === undefined) throw new Error('expected pending mesh');
    const pendingMeshes = new Map(input.meshBySlot);
    pendingMeshes.delete(1);
    input.meshBySlot = pendingMeshes;
    const pending = prepare();
    expect(pending.submission.plan.candidateCount).toBe(1);
    pending.frame._commitResourceReplacement();
    const pendingHit = prepare();
    expect(pendingHit.submission.cache).toBe('hit');
    pendingHit.frame._commitResourceReplacement();
    input.meshBySlot = new Map(input.meshBySlot).set(1, arrivingMesh);
    input.meshResidencyEpoch += 1;
    const arrived = prepare();
    expect(arrived.submission.cache).toBe('invalidated');
    expect(arrived.submission.plan.candidateCount).toBe(2);
    expect(arrived.frame.shadowViewPool?.submission(identity)?.plan.candidateCount).toBe(0);
    arrived.frame._commitResourceReplacement();

    // The first population starts in the static layer.
    let first = prepare();
    for (
      let frame = 0;
      frame <= SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW &&
      first.submission.plan.candidateCount < 2;
      frame += 1
    ) {
      first.frame._commitResourceReplacement();
      first = prepare();
    }
    expect(first.submission.plan.candidateCount).toBe(2);
    expect(first.frame.shadowViewPool?.submission(identity)?.plan.candidateCount).toBe(0);
    expect(production.inspect().channels).toContainEqual(
      expect.objectContaining({
        viewPass: 'directional-shadow',
        viewIndex: 0,
        lane: 'gpu',
        drawCount: 2,
        totalDrawCount: 2,
        claimedDrawCount: 2,
        residualDrawCount: 0,
      }),
    );
    first.frame._commitResourceReplacement();
    const shadowProjection = (frame: typeof first.frame) =>
      [
        ...(frame.shadowBatchProjections
          ?.get(shadowViewIdentityKey({ ...identity, layer: 'static' }))
          ?.values() ?? []),
      ][0];
    const firstProjection = shadowProjection(first.frame);
    expect(firstProjection).toBeDefined();

    // Main-view probe membership changes while the shadow camera also moves.
    input.materialBindingClasses = new Map([['0:2:-1', 'forward|probe:second']]);
    planes[3] = 0.5;
    lightMatrix[12] = 0.125;
    const rotated = prepare();
    // The main-view filter rebuilds this frame; the shadow plan stays retained.
    expect(production.inspect().filteredPlanBuilds).toBe(1);
    expect(rotated.submission.plan).toBe(first.submission.plan);
    // Redrawing depth does not replace the physical draw bindings.
    expect(shadowProjection(rotated.frame)).toBe(firstProjection);
    expect(rotated.submission.view.inspect()).toMatchObject({
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 528,
    });
    expect(rotated.frame.shadowDrawKeys).toEqual(input.shadowCasterDrawKeys);
    rotated.frame._commitResourceReplacement();

    // A depth hit can still replace a physical binding resource. Rebuild the
    // projection and its visible groups even though the retained plan is unchanged.
    input.probeBlendRecordBuffer = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const rebound = prepare();
    expect(rebound.submission.plan).toBe(rotated.submission.plan);
    expect(rebound.submission.cache).toBe('hit');
    const reboundProjection = shadowProjection(rebound.frame);
    expect(reboundProjection).not.toBe(firstProjection);
    expect(reboundProjection?.visibleBindGroups[0]).not.toBe(firstProjection?.visibleBindGroups[0]);
    rebound.frame._commitResourceReplacement();
    const stableBinding = prepare();
    expect(shadowProjection(stableBinding.frame)).toBe(reboundProjection);
    stableBinding.frame._commitResourceReplacement();

    // A re-published snapshot re-derives preparation without changing what
    // the shadow views draw; the retained static layer stays a cache hit.
    projection.apply([updateSnapshot(preparedSnapshot(1, 3))]);
    input.scene = {
      ...input.scene,
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
    } as typeof input.scene;
    const reslotted = prepare();
    expect(reslotted.submission.plan).toBe(rotated.submission.plan);
    expect(
      reslotted.frame.shadowViewPool
        ?.inspect()
        .find((view) => view.identity.kind === 'directional' && view.identity.layer === 'static')
        ?.cache,
    ).toBe('hit');
    reslotted.frame._commitResourceReplacement();

    // The skin fallback is re-resolved every frame as a fresh object with the
    // same program; object identity alone keeps the static layer cached.
    const skin = input.standardPbrArtifact;
    if (skin === undefined) throw new Error('expected material artifact');
    const reresolved = () => {
      input.materialSkinArtifact = { ...skin };
      return prepare();
    };
    const resolved = reresolved();
    resolved.frame._commitResourceReplacement();
    const reresolvedAgain = reresolved();
    expect(reresolvedAgain.submission.plan).toBe(resolved.submission.plan);
    expect(
      reresolvedAgain.frame.shadowViewPool
        ?.inspect()
        .find((view) => view.identity.kind === 'directional' && view.identity.layer === 'static')
        ?.cache,
    ).toBe('hit');
    reresolvedAgain.frame._commitResourceReplacement();

    // A receiver-only program replacement must not throw away static caster depth.
    const casterArtifact = input.standardPbrArtifact;
    const casterPrepared = preparedSnapshot(1, 3).gpuDrivenDraws?.[0]?.prepared;
    if (casterArtifact === undefined || casterPrepared === undefined)
      throw new Error('expected caster program');
    const casterKey = gpuDrivenMaterialArtifactKey({
      material: casterPrepared.identity.material,
      deformation: casterPrepared.identity.deformation,
      receiptIdentity: casterPrepared.receiptIdentity,
      receiptGeneration: casterPrepared.receiptGeneration,
    });
    input.shadowMaterialArtifacts = new Map([[casterKey, casterArtifact]]);
    const originalCaster = prepare();
    originalCaster.frame._commitResourceReplacement();
    input.standardPbrArtifact = {
      ...casterArtifact,
      program: createMaterialShaderProgram('receiver-only replacement'),
    };
    const receiverOnly = prepare();
    expect(receiverOnly.submission.cache).toBe('hit');
    expect(shadowProjection(receiverOnly.frame)?.shadowArtifact).toBe(casterArtifact);
    receiverOnly.frame._commitResourceReplacement();
    input.shadowMaterialArtifacts = new Map([
      [
        casterKey,
        { ...casterArtifact, program: createMaterialShaderProgram('caster replacement') },
      ],
    ]);
    const casterChanged = prepare();
    expect(casterChanged.submission.cache).toBe('invalidated');
    expect(
      casterChanged.frame.shadowViewPool?.invalidationReason({ ...identity, layer: 'static' }),
    ).toBe('artifact-changed');
    casterChanged.frame._commitResourceReplacement();
    delete input.shadowMaterialArtifacts;

    input.shadowCasterDrawKeys = new Set(['2:-1:0:0']);
    const membership = prepare();
    expect(membership.submission.plan).not.toBe(rotated.submission.plan);
    expect(membership.submission.plan.candidateCount).toBe(1);
    expect(membership.frame.shadowDrawKeys).toEqual(new Set(['2:-1:0:0']));
    membership.frame._commitResourceReplacement();

    const artifact = input.standardPbrArtifact;
    if (artifact === undefined) throw new Error('expected material artifact');
    input.standardPbrArtifact = {
      ...artifact,
      program: createMaterialShaderProgram('republished program'),
    };
    const material = prepare();
    expect(material.submission.plan).not.toBe(membership.submission.plan);
    expect(material.submission.plan.candidateCount).toBe(1);
    material.frame._commitResourceReplacement();

    const residencyChurn = { staticMisses: 0, rebuiltBatches: 0 };
    for (let frame = 0; frame < 60; frame += 1) {
      input.meshResidencyEpoch += 1;
      const unrelatedResidency = prepare();
      residencyChurn.staticMisses += Number(unrelatedResidency.submission.cache !== 'hit');
      residencyChurn.rebuiltBatches += production.inspect().planRebuildBatches;
      unrelatedResidency.frame._commitResourceReplacement();
    }
    expect(residencyChurn).toEqual({ staticMisses: 0, rebuiltBatches: 0 });
    expect(production.inspect().channels).toContainEqual(
      expect.objectContaining({
        viewPass: 'directional-shadow',
        viewIndex: 0,
        lane: 'gpu',
        drawCount: 1,
        totalDrawCount: 1,
        claimedDrawCount: 1,
        residualDrawCount: 0,
      }),
    );

    input.meshBySlot = new Map(input.meshBySlot).set(1, mesh(device));
    input.meshResidencyEpoch += 1;
    const resident = prepare();
    expect(resident.submission.plan).not.toBe(material.submission.plan);
    expect(resident.submission.plan.candidateCount).toBe(0);
    expect(resident.frame.shadowViewPool?.submission(identity)?.plan.candidateCount).toBe(1);
    resident.frame._abortResourceReplacement?.();
    const retry = prepare();
    expect(retry.submission.cache).toBe('invalidated');
    expect(retry.frame.shadowViewPool?.submission(identity)?.plan.candidateCount).toBe(1);
    expect(retry.frame.shadowDrawKeys).toEqual(new Set(['2:-1:0:0']));
    retry.frame._commitResourceReplacement();

    // A new declared-static caster reuses both a primitive slot and the
    // topology lane. Cached mesh witnesses belong to the old occupant;
    // generation replacement must still classify this one as newly declared.
    const retiredGeneration = projection.slotAt(1)?.generation;
    const retiredBatch = topology.plan().batches[0];
    const replacement = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 1 },
      { kind: 'remove', worldId: 0, entityKey: 2 },
      updateSnapshot({ ...preparedSnapshot(3, 3), mobility: 'static' }),
    ]);
    availability.scene.sync(replacement, undefined, casterBounds).unwrap();
    topology.apply(replacement);
    expect(projection.slotAt(1)?.generation).not.toBe(retiredGeneration);
    expect(topology.plan().batches[0]?.batchId).toBe(retiredBatch?.batchId);
    expect(topology.plan().batches[0]?.generation).not.toBe(retiredBatch?.generation);
    input.scene = {
      ...input.scene,
      plan: topology.plan(),
      slots: projection.slotsSnapshot(),
    } as typeof input.scene;
    input.meshBySlot = new Map([[1, mesh(device)]]);
    input.meshResidencyEpoch += 1;
    input.shadowCasterDrawKeys = new Set(['3:-1:0:0']);
    const reused = prepare();
    expect(reused.submission.cache).toBe('invalidated');
    expect(reused.submission.plan.candidateCount).toBe(1);
    expect(reused.frame.shadowViewPool?.submission(identity)?.plan.candidateCount).toBe(0);
    expect(reused.frame.shadowDrawKeys).toEqual(new Set(['3:-1:0:0']));
    expect(production.inspect().shadowCasterFlips).toBe(0);
    reused.frame._commitResourceReplacement();

    // Material values can change without changing the draw plan. The retained
    // projection must publish the current values used by custom/alpha UBOs.
    const current = projection.slotAt(1)?.snapshot;
    if (current === undefined) throw new Error('expected live caster');
    const editedMaterial = { ...current.material, roughness: 0.375 };
    const materialDelta = projection.apply([
      updateSnapshot({
        ...current,
        material: editedMaterial,
        materials: [editedMaterial],
      }),
    ]);
    availability.scene.sync(materialDelta, undefined, casterBounds).unwrap();
    topology.apply(materialDelta);
    input.scene = {
      ...input.scene,
      scene: availability.scene,
      slotAt: projection.slotAt,
      plan: topology.plan(),
      slots: projection.slotsSnapshot(),
    };
    const editedValues = prepare();
    const editedDynamic = editedValues.frame.shadowViewPool?.submission(identity);
    if (editedDynamic === undefined) throw new Error('expected dynamic caster');
    expect(editedDynamic.plan.candidateCount).toBe(1);
    editedValues.frame._commitResourceReplacement();
    const nextMaterial = { ...editedMaterial, roughness: 0.625 };
    const nextDelta = projection.apply([
      updateSnapshot({
        ...current,
        material: nextMaterial,
        materials: [nextMaterial],
      }),
    ]);
    availability.scene.sync(nextDelta, undefined, casterBounds).unwrap();
    topology.apply(nextDelta);
    input.scene = {
      ...input.scene,
      scene: availability.scene,
      slotAt: projection.slotAt,
      plan: topology.plan(),
      slots: projection.slotsSnapshot(),
    };
    const editedAgain = prepare();
    expect(editedAgain.frame.shadowViewPool?.submission(identity)?.plan).toBe(editedDynamic.plan);
    expect(
      [
        ...(editedAgain.frame.shadowBatchProjections
          ?.get(shadowViewIdentityKey(identity))
          ?.values() ?? []),
      ][0]?.material.roughness,
    ).toBe(0.625);
    editedAgain.frame._commitResourceReplacement();
    production.dispose();
    availability.scene.dispose();
  });

  it('projects concrete ShadowCaster candidates and leaves the CPU residual disjoint', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pbrPipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
      })
      .unwrap();
    const source = preparedSnapshot(1, 3);
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw).toBeDefined();
    if (firstDraw === undefined) return;
    const firstPrepared = firstDraw.prepared;
    expect(firstPrepared).toBeDefined();
    if (firstPrepared === undefined) return;
    const blendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } as const;
    const residualMaterial = {
      ...source.material,
      materialHandle: 22,
      transparent: true,
      renderState: { cullMode: 'none' as const, blend: blendState, depthWriteEnabled: false },
    } as MaterialSnapshot;
    const residualDraw = {
      ...firstDraw,
      first: 3,
      materialSlot: 1,
      materialResourceClass: 'alpha-blend',
      prepared: { ...firstPrepared, first: 3 },
    };
    const mixed = {
      ...source,
      materials: [source.material, residualMaterial],
      gpuDrivenDraws: [firstDraw, residualDraw],
    } as RenderableSnapshot;
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(mixed)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan()).toMatchObject({ candidateCount: 1 });
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('synthetic'),
      layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
        Record<string, unknown>
      >[],
      receipt: STANDARD_PBR_RECEIPT,
    };
    const programKey = standardPbrProgramKey(artifact.material);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const entity = worldEntityKey(mixed.worldId, mixed.entityKey);
    const gpuKey = gpuDrivenShadowDrawKey(entity, -1, 0, 0);
    const residualKey = gpuDrivenShadowDrawKey(entity, 22, 1, 0);
    const allShadowKeys = new Set([gpuKey, residualKey]);
    const prepareFrame = () =>
      production
        .prepare({
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, mesh(device)]]),
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          standardPbrArtifact: artifact,
          standardPbrPipelineState: {
            pbrPipelineLayout,
            meshBindGroupLayout: meshLayout,
            instancesBindGroupLayout: instancesLayout,
            gpuDrivenInstancesBindGroupLayout: instancesLayout,
            gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
            standardPbrShaderModule: shader,
            gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
          } as never,
          shadowCasterDrawKeys: allShadowKeys,
        })
        .unwrap();
    const prepared = prepareFrame();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const claimed = new Set(prepared.shadowDrawKeys ?? []);
    expect([...claimed]).toEqual([gpuKey]);
    expect(prepared.ownsAllShadowCasters).toBe(false);
    const residual = [...allShadowKeys].filter((key) => !claimed.has(key));
    expect(residual).toEqual([residualKey]);
    expect([...new Set([...claimed, ...residual])].sort()).toEqual([...allShadowKeys].sort());
    const identity = { kind: 'directional' as const, index: 0 };
    const updated = prepared.updateShadowViews?.([{ identity, planes: new Float32Array(24) }]);
    expect(updated?.ok).toBe(true);
    expect(production.inspect().channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewPass: 'directional-shadow',
          lane: 'blocked',
          reason: 'shadow-ownership',
          drawCount: 1,
          failure: expect.objectContaining({
            code: 'shadow-ownership',
            detail: expect.objectContaining({
              owner: 'shadow',
              reason: 'shadow-ownership-missing',
              recovery: 'route-cpu-lane',
            }),
          }),
        }),
      ]),
    );
    expect(shadowCandidateCount(prepared.shadowViewPool, identity)).toBe(1);
    const resumed = prepareFrame();
    expect(resumed?.updateShadowViews?.([{ identity, planes: new Float32Array(24) }]).ok).toBe(
      true,
    );
    expect(
      production.inspect().channels.some((channel) => channel.viewPass === 'directional-shadow'),
    ).toBe(true);
    production.dispose();
    availability.scene.dispose();
  });

  it('claims exact ShadowCaster passes without swallowing residual or custom passes', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } }],
      })
      .unwrap();
    const instancesLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pbrPipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
      })
      .unwrap();
    const source = preparedSnapshot(7, 3);
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw?.prepared).toBeDefined();
    if (firstDraw === undefined || firstDraw.prepared === undefined) return;
    const materials = [0, 1, 2].map((handle) => ({
      ...source.material,
      materialHandle: handle + 10,
    })) as MaterialSnapshot[];
    const draws = [
      { ...firstDraw, drawItemIndex: 0, materialSlot: 0, first: 0, count: 3 },
      {
        ...withoutPrepared(firstDraw),
        drawItemIndex: 1,
        materialSlot: 1,
        first: 3,
        count: 3,
      },
      { ...firstDraw, drawItemIndex: 2, materialSlot: 2, first: 6, count: 3 },
    ];
    const mixed: RenderableSnapshot = {
      ...source,
      material: materials[0] as MaterialSnapshot,
      materials,
      gpuDrivenDraws: draws,
    };
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(mixed)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan().candidateCount).toBe(3);
    const entity = worldEntityKey(mixed.worldId, mixed.entityKey);
    const membership: ShadowCasterMembership[] = [
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 0,
        materialHandle: 10,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
      },
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 1,
        materialHandle: 11,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
      },
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 2,
        materialHandle: 12,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
      },
      {
        worldEntity: entity,
        renderableIndex: 0,
        drawItemIndex: 2,
        materialHandle: 12,
        passIndex: 7,
        materialShaderId: 'custom-shadow-caster',
      },
    ];
    const allKeys = new Set(
      membership.map((entry) =>
        gpuDrivenShadowDrawKey(
          entry.worldEntity,
          entry.materialHandle,
          entry.drawItemIndex,
          entry.passIndex,
        ),
      ),
    );
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('synthetic'),
      layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
        Record<string, unknown>
      >[],
      receipt: STANDARD_PBR_RECEIPT,
    };
    const programKey = standardPbrProgramKey(artifact.material);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const multiMesh = {
      ...mesh(device),
      submeshes: [0, 1, 2].map((materialSlot) => ({
        indexOffset: materialSlot * 3,
        indexCount: 3,
        vertexCount: 3,
        materialSlot,
        topology: 'triangle-list' as const,
      })),
    };
    const prepared = production
      .prepare({
        scene: {
          scene: availability.scene,
          plan: topology.plan(),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, multiMesh]]),
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,

        standardPbrArtifact: artifact,
        standardPbrPipelineState: {
          pbrPipelineLayout,
          meshBindGroupLayout: meshLayout,
          instancesBindGroupLayout: instancesLayout,
          gpuDrivenInstancesBindGroupLayout: instancesLayout,
          gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
          standardPbrShaderModule: shader,
          gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
        } as never,
        shadowCasterDrawKeys: allKeys,
        shadowCasterMembership: membership,
      })
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const gpuKey = gpuDrivenShadowDrawKey(entity, 10, 0, 0);
    expect([...(prepared.shadowDrawKeys ?? [])]).toEqual([gpuKey]);
    expect(prepared.ownsAllShadowCasters).toBe(false);
    const residual = [...allKeys].filter((key) => !prepared.shadowDrawKeys?.has(key));
    expect(residual).toHaveLength(3);
    expect(new Set([...(prepared.shadowDrawKeys ?? []), ...residual])).toEqual(allKeys);
    const identity = { kind: 'directional' as const, index: 0 };
    expect(prepared.updateShadowViews?.([{ identity, planes: new Float32Array(24) }]).ok).toBe(
      true,
    );
    expect(shadowCandidateCount(prepared.shadowViewPool, identity)).toBe(1);
    expect(prepared.shadowDrawKeysByView?.get('directional:0:')).toEqual(new Set([gpuKey]));
    production.dispose();
    availability.scene.dispose();
  });

  it.each([false, true])('prepares off-camera CPU shadow materials (main rows=%s)', (withMain) => {
    const material = { ...preparedSnapshot(1, 3).material, materialHandle: 42 };
    const shadow = {
      source: { ...preparedSnapshot(1, 3), material, materials: [material] },
      renderableIndex: 0,
    } as never;
    const main = { source: preparedSnapshot(2, 3), renderableIndex: 0 } as never;
    const plan = buildDispatchPlan({} as never, withMain ? [main] : [], [], [], [shadow]);
    expect(plan.shadowValidatedOrdered).toEqual([shadow]);
    const slot = plan.materialSlots.indexOf(material);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(plan.materialSlotOwners[slot]).toBe(shadow);
    const dispatch = {
      renderableIndex: 0,
      materialHandle: 42,
      materialShaderId: 'forgeax::default-standard-pbr',
      tags: { LightMode: 'ShadowCaster' },
    };
    const map = shadowShaderMap({ ...plan, shadowDispatch: [dispatch] } as never);
    expect(map.get(0)?.get(42)?.[0]?.materialSlot).toBe(slot);
  });

  it.each([
    false,
    true,
  ])('records exact CPU residuals with authored state (skinned=%s)', async (skinned) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const source = preparedSnapshot(8, 3);
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw?.prepared).toBeDefined();
    if (firstDraw === undefined || firstDraw.prepared === undefined) return;
    const materials = [0, 1, 2].map((handle) => ({
      ...source.material,
      materialHandle: handle + 20,
    })) as MaterialSnapshot[];
    const draws = [
      { ...firstDraw, drawItemIndex: 0, materialSlot: 0, first: 0, count: 3 },
      { ...firstDraw, drawItemIndex: 1, materialSlot: 1, first: 3, count: 3 },
      { ...firstDraw, drawItemIndex: 2, materialSlot: 2, first: 6, count: 3 },
    ];
    const sourceForRecord: RenderableSnapshot = {
      ...source,
      ...(skinned ? { skin: { buffer: {} as never, byteOffset: 0 } as never } : {}),
      material: materials[0] as MaterialSnapshot,
      materials,
      gpuDrivenDraws: draws,
    };
    const geometry = {
      ...mesh(device),
      submeshes: [0, 1, 2].map((materialSlot) => ({
        indexOffset: materialSlot * 3,
        indexCount: 3,
        vertexCount: 3,
        materialSlot,
        topology: 'triangle-list' as const,
      })),
    };
    const identityInstanceBuffer = device
      .createBuffer({ size: 64, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const instancesBindGroupLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 0x1, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const worldEntity = worldEntityKey(sourceForRecord.worldId, sourceForRecord.entityKey);
    const claimedKey = gpuDrivenShadowDrawKey(worldEntity, 20, 0, 0);
    const residualKeys = new Set([
      gpuDrivenShadowDrawKey(worldEntity, 21, 1, 0),
      gpuDrivenShadowDrawKey(worldEntity, 22, 2, 0),
      gpuDrivenShadowDrawKey(worldEntity, 22, 2, 7),
    ]);
    const shadowDispatches = new Map([
      [
        0,
        new Map([
          [
            20,
            [
              {
                passIndex: 0,
                materialHandle: 20,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'forgeax::default-shadow-caster',
                renderState: undefined,
                materialSlot: 0,
                paramSnapshot: materials[0]?.paramSnapshot,
              },
            ],
          ],
          [
            21,
            [
              {
                passIndex: 0,
                materialHandle: 21,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'forgeax::default-shadow-caster',
                renderState: undefined,
                materialSlot: 1,
                paramSnapshot: materials[1]?.paramSnapshot,
              },
            ],
          ],
          [
            22,
            [
              {
                passIndex: 0,
                materialHandle: 22,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'forgeax::default-shadow-caster',
                renderState: undefined,
                materialSlot: 2,
                paramSnapshot: materials[2]?.paramSnapshot,
              },
              {
                passIndex: 7,
                materialHandle: 22,
                vertexEntry: undefined,
                fragmentEntry: undefined,
                materialShaderId: 'custom-shadow-caster',
                renderState: { cullMode: 'none' as const, frontFace: 'cw' as const },
                materialSlot: 2,
                paramSnapshot: materials[2]?.paramSnapshot,
              },
            ],
          ],
        ]),
      ],
    ]);
    const indexedDraws: number[][] = [];
    const pipelineRequests: unknown[][] = [];
    const pass = {
      setPipeline: () => undefined,
      setVertexBuffer: () => undefined,
      setIndexBuffer: () => undefined,
      setBindGroup: () => undefined,
      drawIndexed: (...args: number[]) => indexedDraws.push(args),
      draw: () => undefined,
    } as unknown as RhiRenderPassEncoder;
    const context = {
      runtime: {
        device,
        getMaterialShaderPipeline: (...args: unknown[]) => {
          pipelineRequests.push(args);
          return {} as never;
        },
      },
      pipelineState: {
        identityInstanceBuffer,
        pbrSkinMeshBindGroupLayout: {} as never,
        skinPaletteAllocator: { bindingWindowBytes: 256 },
        instancesBindGroupLayout,
        materialBindGroupLayout: {} as never,
        materialUniformBuffer: { buffer: {} as never, sizeInBytes: 256 },
        meshStorageBuffer: { buffer: {} as never, sizeInBytes: 256 },
        defaultSampler: {} as never,
        fallbackTextureView: {} as never,
        defaultNormalTextureView: {} as never,
        defaultWhiteTextureView: {} as never,
        skylightFallback: {
          irradianceView: {} as never,
          prefilterView: {} as never,
          brdfLutView: {} as never,
          sampler: {} as never,
          intensityBuffer: {} as never,
        },
      },
      validatedOrdered: [
        {
          source: sourceForRecord,
          mesh: geometry,
          renderableIndex: 0,
        },
      ],
      frameState: {
        instanceBuffers: new Map(),
        meshBindGroupCache: new Map(),
        instancesBgPerEntity: new Map(),
        shadowMaterialBindGroups: new WeakMap(),
        materialBgShared: new Map(),
      },
      materialBgAssemblyCache: new MaterialBgAssemblyCache(),
      store: { materialResourceEpoch: 0 } as never,
      world: new World(),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      dispatch: [],
      // Stands in for the persistent scene owner, the only bounds source.
      shadowCasterBounds: (source: RenderableSnapshot) => {
        if (source.localAabb === undefined) return undefined;
        const bounds = box3.transformBox3(box3.create(), source.localAabb, source.transform.world);
        return {
          min: [bounds[0], bounds[1], bounds[2]],
          max: [bounds[3], bounds[4], bounds[5]],
        };
      },
    } as never;
    const recorded = recordShadowCasterDraws(
      context,
      pass,
      {} as never,
      {} as never,
      new Set([0]),
      new Map([[0, new Set([20, 21, 22])]]),
      shadowDispatches,
      new Set([claimedKey]),
    );
    expect(indexedDraws).toHaveLength(3);
    expect(recorded).toEqual(residualKeys);
    expect(recorded.has(claimedKey)).toBe(false);
    const authored = pipelineRequests.find((args) => args[0] === 'custom-shadow-caster');
    expect(authored).toBeDefined();
    expect(authored?.[2]).toEqual({ cullMode: 'none', frontFace: 'cw' });
    expect(authored?.[15]).toBe(skinned ? 'pbr-skin' : 'pbr');
    if (skinned) expect(authored?.[5]).toContain('SKINNING_DISABLED=false');

    sourceForRecord.transform.world[12] = 100;
    indexedDraws.length = 0;
    const culled = recordShadowCasterDraws(
      context,
      pass,
      {} as never,
      {} as never,
      new Set([0]),
      new Map([[0, new Set([20, 21, 22])]]),
      shadowDispatches,
      new Set([claimedKey]),
      false,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    expect(indexedDraws).toHaveLength(skinned ? 3 : 0);
    expect(culled).toEqual(skinned ? residualKeys : new Set());
  });

  it.each([
    'directional',
    'point',
    'spot',
  ] as const)('skips the %s CPU residual when every unclaimed caster is outside that view', async (kind) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const buffer = device.createBuffer({ size: 4096, usage: 64 }).unwrap();
    const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const source = preparedSnapshot(1, 3);
    source.transform.world[12] = 50;
    const identity = { kind, index: 0, ...(kind === 'point' ? { face: 0 } : {}) };
    const key = `${kind}:0:${kind === 'point' ? '0' : ''}`;
    const view = { indirectBuffer: buffer };
    const plan = { revision: 1, batches: [], candidateCount: 0, visibleCapacity: 0 };
    const pipeline = {};
    const cpuPipeline = vi.fn(() => {
      throw new Error('CPU residual reached');
    });
    const feature = vi.fn();
    const context = {
      runtime: { device, getMaterialShaderPipeline: () => pipeline },
      pipelineState: {
        projectorAvailable: false,
        perPassResources: { shadowSampler: {} },
        viewUniformBuffer: buffer,
        shadowArrayFallbackTextureView: {},
        shadowAtlasFallbackTextureView: {},
        shadowParamsBuffer: buffer,
        shadowCasterCascadeBuffer: buffer,
        viewBindGroupLayout: layout,
        materialBindGroupLayout: layout,
        materialUniformBuffer: { buffer },
        meshStorageBuffer: { buffer },
        defaultSampler: {},
        defaultNormalTextureView: {},
        fallbackTextureView: {},
        skylightFallback: null,
      },
      frameState: {
        viewBindGroupCache: new Map(),
        shadowMaterialBindGroups: new WeakMap(),
        pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
        spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
      },
      dispatch: [],
      validatedOrdered: [{ source, renderableIndex: 0 }],
      shadowCasterBounds: () => ({
        min: [source.transform.world[12], -1, -1],
        max: [(source.transform.world[12] ?? 0) + 2, 1, 1],
      }),
      shadowCasterMembership: [
        { worldEntity: 1, renderableIndex: 0, drawItemIndex: 0, materialHandle: -1, passIndex: 0 },
      ],
      shadowViewPlanesByView: new Map([
        [key, frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()))],
      ]),
      gpuDrivenShadowViews: { submission: () => ({ identity, view, plan }) },
      gpuDrivenShadowBatchProjections: new Map([[key, new Map()]]),
      gpuDrivenShadowDrawKeysByView: new Map([[key, new Set()]]),
      gpuDrivenShadowDrawKeys: new Set(['1:-1:0:0']),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
    } as never;
    const pass = {
      setBindGroup: vi.fn(),
      setPipeline: cpuPipeline,
    } as unknown as RhiRenderPassEncoder;
    const encode = () =>
      kind === 'directional'
        ? encodeDirectionalShadowPass(context, pass, 0, feature)
        : kind === 'point'
          ? encodePointShadowPass(context, pass, 0, 0, feature)
          : encodeSpotShadowPass(context, pass, 0, feature);
    expect(encode).not.toThrow();
    expect(cpuPipeline).not.toHaveBeenCalled();
    expect(feature).toHaveBeenCalledOnce();
    source.transform.world[12] = 0;
    expect(encode).toThrow('CPU residual reached');
    expect(cpuPipeline).toHaveBeenCalledOnce();
  });

  it('fails closed at every shadow front door when expected casters lack bind groups', () => {
    const membership: ShadowCasterMembership[] = [
      {
        worldEntity: 1,
        renderableIndex: 0,
        drawItemIndex: 0,
        materialHandle: 20,
        passIndex: 0,
        materialShaderId: 'forgeax::default-shadow-caster',
        cpuReason: 'unprepared',
      },
    ];
    const context = {
      runtime: {
        device: { caps: { storageBuffer: false } },
        getMaterialShaderPipeline: () => null,
      },
      pipelineState: { perPassResources: { shadowSampler: null } },
      frameState: {
        pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
        spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
      },
      dispatch: [],
      shadowCasterMembership: membership,
    } as never;
    const pass = {} as RhiRenderPassEncoder;
    const calls = [
      () => encodeDirectionalShadowPass(context, pass, 0),
      () => encodePointShadowPass(context, pass, 0, 0),
      () => encodeSpotShadowPass(context, pass, 0),
    ];
    for (const call of calls) {
      expect(call).toThrowError(RhiError);
      try {
        call();
      } catch (error) {
        expect(error).toBeInstanceOf(RhiError);
        expect((error as RhiError).code).toBe('rhi-not-available');
      }
    }
  });

  it('labels a prepared-contract admission rejection for the CPU residual', () => {
    const source = preparedSnapshot(9, 3);
    const draw = source.gpuDrivenDraws?.[0];
    expect(draw?.prepared).toBeDefined();
    if (draw === undefined || draw.prepared === undefined) return;
    const mismatched = {
      ...draw,
      prepared: {
        ...draw.prepared,
        identity: {
          ...draw.prepared.identity,
          material: 'forgeax::pbr-skin' as const,
          deformation: 'skin' as const,
        },
      },
    };
    const material = {
      ...source.material,
      materialShaderId: 'forgeax::default-standard-pbr',
    } as MaterialSnapshot;
    expect(
      shadowCasterCpuReason(
        material,
        mismatched,
        [
          {
            entityIndex: source.entityKey,
            materialHandle: material.materialHandle ?? -1,
            renderableIndex: 0,
            passIndex: 0,
            queue: 2000,
            layer: 0,
            tags: { LightMode: 'ShadowCaster' },
            renderState: undefined,
            defines: undefined,
            vertexEntry: undefined,
            fragmentEntry: undefined,
            materialShaderId: 'forgeax::default-shadow-caster',
            paramSnapshot: undefined,
          } as DispatchEntry,
        ],
        undefined,
        undefined,
      ),
    ).toBe('prepared-contract');
  });
});
