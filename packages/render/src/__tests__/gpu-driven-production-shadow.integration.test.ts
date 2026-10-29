import { World } from '@forgeax/engine-ecs';
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import { RhiError, type RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { prepareBatchExecution } from '../gpu-driven/batch-execution';
import * as batchTopology from '../gpu-driven/batch-topology';
import * as cameraProjection from '../gpu-driven/production-raster-camera';
import * as shadowLod from '../gpu-driven/production-raster-lod';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import { buildDispatchPlan } from '../record/frame';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  recordShadowCasterDraws,
} from '../record/shadow-pass';
import type { RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { receiptSelection } from './gpu-draw-selection-fixture';
import { mesh, preparedSnapshot, updateSnapshot } from './gpu-driven-production-fixture';
import { productionShadowFixture } from './gpu-driven-production-shadow-fixture';

describe('GPU-driven production shadow projection', () => {
  it.each([
    false,
    true,
  ])('derives shadow cameras only for consumed compute work, with camera cull %s', async (cameraCull) => {
    const f = await productionShadowFixture(2, 3);
    const derive = vi.spyOn(shadowLod, 'lodViewCameraFromMatrix');
    const cull = vi.spyOn(cameraProjection, 'occlusionCamera');
    if (cameraCull)
      for (const request of f.requests)
        Object.assign(request, { cameraCull: { ndcDilation: 0.01, worldDilation: 0.01 } });
    try {
      f.prepare();
      if (cameraCull) f.prepare();
      expect(derive).toHaveBeenCalled();
      derive.mockClear();
      cull.mockClear();
      const steady = f.prepare();
      expect(steady.views.every((view) => view.submission.cache === 'hit')).toBe(true);
      expect(derive).not.toHaveBeenCalled();
      // The main view still derives its camera; retained shadows need none.
      expect(cull).toHaveBeenCalledTimes(1);
      const request = required(f.requests[0]);
      const matrix = required(request.matrix);
      matrix[12] = 0.25;
      request.planes.set(frustum.fromViewProjection(frustum.create(), matrix));
      const changed = f.prepare();
      expect(changed.views.some((view) => view.submission.cache === 'invalidated')).toBe(true);
      expect(derive).toHaveBeenCalled();
    } finally {
      derive.mockRestore();
      cull.mockRestore();
      f.dispose();
    }
  });

  it('admits prepared Alpha Mask draws to the GPU shadow lane', async () => {
    const f = await productionShadowFixture(1);
    try {
      const resource = required(f.rows[0]).material;
      resource.adopt({
        ...resource.snapshot,
        paramSnapshot: { alphaCutoff: 0.5 },
        textureHandles: new Map([['baseColorTexture', 1]]) as never,
        samplerHandles: new Map([['baseColorTexture', 2]]) as never,
      });
      const frame = f.prepare();
      expect(frame.views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0)).toBe(
        3,
      );
      expect([...frame.admitted.batchExecutions.values()][0]?.shadow.route).toBe('gpu');
      expect(
        frame.views
          .flatMap((view) => [...view.bindings.values()])
          .every((value) => value.material.paramSnapshot?.alphaCutoff === 0.5),
      ).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('does not admit Alpha Blend or CPU transmission draw plans as GPU-owned', async () => {
    const f = await productionShadowFixture(3);
    try {
      const blend = required(f.rows[1]).material;
      blend.adopt({
        ...blend.snapshot,
        passes: blend.snapshot.passes.map((pass) => ({
          ...pass,
          renderState: {
            ...pass.renderState,
            blend: { color: {}, alpha: {} },
            depthWriteEnabled: false,
          },
        })),
      });
      const transmission = required(f.rows[2]).material;
      transmission.adopt({ ...transmission.snapshot, paramSnapshot: { transmission: 0.5 } });
      const prepared = f.prepare();
      expect(
        f.rows.map((row) =>
          prepared.frame.selection.owns(row, required(row.gpuDrivenDraws?.[0]), 0),
        ),
      ).toEqual([true, false, false]);
    } finally {
      f.dispose();
    }
  });

  it.each([
    3, 4,
  ])('selects captured shadow rows without rebuilding joins across %i cascades', async (cascades) => {
    const f = await productionShadowFixture(2, cascades);
    const project = vi.spyOn(batchTopology, 'buildBatchAlignedSubmission');
    try {
      const first = f.prepare();
      for (const parity of [0, 1])
        expect(
          new Set(
            first.views.filter((_, i) => i % 2 === parity).map((view) => view.submission.plan),
          ).size,
        ).toBe(1);
      expect(new Set(first.views.map((view) => view.submission.view.visibleBuffer)).size).toBe(
        cascades * 2,
      );
      project.mockClear();
      const steady = f.prepare();
      expect(project).not.toHaveBeenCalled();
      expect(steady.views.every((view) => view.submission.cache === 'hit')).toBe(true);
      const moved = mat4.identity(mat4.create());
      moved[12] = 0.5;
      f.apply([{ kind: 'update', worldId: 0, entityKey: 1, world: moved }]);
      const changed = f.prepare(false);
      expect(changed.views.every((view) => view.submission.plan.candidateCount === 1)).toBe(true);
      changed.frame._abortResourceReplacement?.();
      const retry = f.prepare();
      retry.views.forEach((view, i) => {
        expect(view.submission.cache).toBe('invalidated');
        expect(view.submission.plan.batches).toEqual(changed.views[i]?.submission.plan.batches);
        expect(view.submission.view.visibleBuffer).toBe(
          changed.views[i]?.submission.view.visibleBuffer,
        );
        expect(view.submission.view.inspect()).toMatchObject({
          sharedInputUploadBytes: 0,
          batchUploadBytes: 0,
        });
      });
      moved[0] = -1;
      f.apply([{ kind: 'update', worldId: 0, entityKey: 1, world: moved }]);
      const mirrored = f.prepare();
      const projections = mirrored.views.flatMap((view) => [...view.bindings.values()]);
      expect(projections.length).toBeGreaterThan(0);
      expect(
        projections.some((projection) => projection.shadowRenderState?.frontFace === 'cw'),
      ).toBe(true);
      for (const projected of projections) {
        expect(projected.shadowRenderState?.frontFace).toBe(
          projected.material.materialHandle === 10 ? 'cw' : undefined,
        );
      }
    } finally {
      project.mockRestore();
      f.dispose();
    }
  });

  it('keeps unchanged shadow batch projections when a trailing caster changes source', async () => {
    const f = await productionShadowFixture(4);
    try {
      const before = f.prepare(true, [0, 1, 2]);
      const outside = required(f.meshes.get(3));
      f.meshes.set(3, { ...outside, contentEpoch: outside.contentEpoch + 1 });
      const unrelated = f.prepare(true, [0, 1, 2]);
      unrelated.views.forEach((view, index) => {
        expect(view.bindings).toBe(before.views[index]?.bindings);
        expect(view.submission.plan).toBe(before.views[index]?.submission.plan);
      });
      const trailing = required(f.meshes.get(2));
      f.meshes.set(2, { ...trailing, contentEpoch: trailing.contentEpoch + 1 });
      const changed = f.prepare(false, [0, 1, 2]);
      changed.views.forEach((view, index) => {
        expect(view.submission.view.visibleBuffer).toBe(
          before.views[index]?.submission.view.visibleBuffer,
        );
        for (const [id, binding] of view.bindings) {
          const previous = before.views[index]?.bindings.get(id);
          if (previous !== undefined && binding.mesh === previous.mesh)
            expect(binding).toBe(previous);
        }
      });
      changed.frame._abortResourceReplacement?.();
      const retry = f.prepare(true, [0, 1, 2]);
      retry.views.forEach((view, i) => {
        expect(view.submission.plan.batches).toEqual(changed.views[i]?.submission.plan.batches);
        for (const [id, binding] of view.bindings)
          expect(binding).toBe(changed.views[i]?.bindings.get(id));
      });
    } finally {
      f.dispose();
    }
  });

  it('retains view bindings across unrelated mesh edits and refreshes authored shadow passes', async () => {
    const f = await productionShadowFixture(3);
    const lookup = vi.spyOn(
      MaterialAbiRasterAdapter.prototype,
      'shadowVisibleWindowBindGroupForBuffer',
    );
    try {
      const before = f.prepare(true, [0, 1]);
      lookup.mockClear();
      for (let frame = 0; frame < 60; frame++) {
        const outside = required(f.meshes.get(2));
        f.meshes.set(2, { ...outside, contentEpoch: outside.contentEpoch + 1 });
        const next = f.prepare(true, [0, 1]);
        next.views.forEach((view, index) => {
          expect(view.submission.cache).toBe('hit');
          expect(view.submission.plan).toBe(before.views[index]?.submission.plan);
          expect(view.bindings).toBe(before.views[index]?.bindings);
        });
      }
      expect(lookup).not.toHaveBeenCalled();
      const material = required(f.rows[0]).material;
      material.adopt({
        ...material.snapshot,
        passes: material.snapshot.passes.map((pass) =>
          pass.name === 'ShadowCaster'
            ? {
                ...pass,
                program: { ...pass.program, fragmentEntry: 'fs_changed' },
                renderState: { ...pass.renderState, cullMode: 'front' },
              }
            : pass,
        ),
      });
      const changed = f.prepare(true, [0, 1]);
      expect(
        changed.views
          .flatMap((view) => [...view.bindings.values()])
          .filter((binding) => binding.material.materialHandle === 10)
          .every(
            (binding) =>
              binding.shadowFragmentEntry === 'fs_changed' &&
              binding.shadowRenderState?.cullMode === 'front',
          ),
      ).toBe(true);
      const stable = f.prepare(true, [0, 1]);
      stable.views.forEach((view, index) => {
        expect(view.bindings).toBe(changed.views[index]?.bindings);
      });
    } finally {
      lookup.mockRestore();
      f.dispose();
    }
  });

  it('retains shadow topology across main bindings, mesh arrival, submission rejection and material adoption', async () => {
    const f = await productionShadowFixture(2);
    try {
      const pending = required(f.meshes.get(1));
      f.meshes.delete(1);
      expect(f.prepare().views.reduce((sum, view) => sum + view.bindings.size, 0)).toBe(3);
      f.meshes.set(1, pending);
      const arrived = f.prepare();
      expect(
        arrived.views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0),
      ).toBe(6);
      Object.assign(f.input, {
        materialBindingClasses: new Map([
          ['0:1', 'probe:A'],
          ['0:2', 'probe:B'],
        ]),
      });
      const split = f.prepare();
      split.views.forEach((view, i) => {
        expect(view.submission.plan).toBe(arrived.views[i]?.submission.plan);
      });
      const material = required(f.rows[0]).material;
      material.adopt({ ...material.snapshot, roughness: 0.375 });
      const values = f.prepare(false);
      expect(
        values.views
          .flatMap((view) => [...view.bindings.values()])
          .filter((binding) => binding.material.materialHandle === 10)
          .every((binding) => binding.material.roughness === 0.375),
      ).toBe(true);
      values.frame._abortResourceReplacement?.();
      const retry = f.prepare();
      expect(retry.views.some((view) => view.submission.cache === 'invalidated')).toBe(true);
      material.adopt({ ...material.snapshot, roughness: 0.625 });
      const latest = f.prepare();
      expect(
        latest.views
          .flatMap((view) => [...view.bindings.values()])
          .filter((binding) => binding.material.materialHandle === 10)
          .every((binding) => binding.material.roughness === 0.625),
      ).toBe(true);
      expect(
        values.views
          .flatMap((view) => [...view.bindings.values()])
          .filter((binding) => binding.material.materialHandle === 10)
          .every((binding) => binding.material.roughness === 0.375),
      ).toBe(true);
      for (let frame = 0; frame < 60; frame++) {
        const steady = f.prepare();
        expect(f.production.inspect().planRebuildBatches).toBe(0);
        expect(steady.views.every((view) => view.submission.cache === 'hit')).toBe(true);
      }
      const artifact = required(f.input.materialArtifact);
      Object.assign(f.input, { shadowMaterialArtifacts: new Map([[artifact.material, artifact]]) });
      const caster = f.prepare();
      f.input.materialArtifact = {
        ...artifact,
        program: createMaterialShaderProgram('receiver-only replacement'),
      };
      const receiverOnly = f.prepare();
      receiverOnly.views.forEach((view, i) => {
        expect(view.submission.cache).toBe('hit');
        expect(view.bindings).toBe(caster.views[i]?.bindings);
      });
      Object.assign(f.input, {
        shadowMaterialArtifacts: new Map([
          [
            artifact.material,
            { ...artifact, program: createMaterialShaderProgram('caster replacement') },
          ],
        ]),
      });
      const casterChanged = f.prepare();
      expect(casterChanged.views.some((view) => view.submission.cache === 'invalidated')).toBe(
        true,
      );
      const beforeSlots = new Map(
        f.projection.slotsSnapshot().map((slot) => [slot.slot, slot.generation]),
      );
      const replacement = { ...required(f.rows[0]), entityKey: 3, mobility: 'static' as const };
      f.apply([
        { kind: 'remove', worldId: 0, entityKey: 1 },
        { kind: 'remove', worldId: 0, entityKey: 2 },
        updateSnapshot(replacement),
      ]);
      const reused = required(f.projection.slot(0, 3));
      expect(reused.generation).not.toBe(beforeSlots.get(reused.slot));
      f.meshes.clear();
      f.meshes.set(reused.slot, pending);
      const reusedFrame = f.prepare();
      expect(reusedFrame.views.reduce((sum, view) => sum + view.bindings.size, 0)).toBe(3);
      expect(
        reusedFrame.views
          .filter((view) => 'layer' in view.identity && view.identity.layer === 'static')
          .every((view) => view.bindings.size === 1),
      ).toBe(true);
      expect(f.production.inspect().shadowCasterFlips).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('projects concrete ShadowCaster candidates and leaves the CPU residual disjoint', async () => {
    const f = await productionShadowFixture(2);
    try {
      const direct = required(f.rows[1]).material;
      direct.adopt({
        ...direct.snapshot,
        passes: direct.snapshot.passes.map((pass) =>
          pass.name === 'ShadowCaster'
            ? { ...pass, renderState: { ...pass.renderState, blend: { color: {}, alpha: {} } } }
            : pass,
        ),
      });
      const prepared = f.prepare();
      expect(
        [...prepared.admitted.batchExecutions.values()].map((value) => value.shadow.route),
      ).toEqual(['gpu', 'direct']);
      expect(
        f.rows.map((row) =>
          prepared.views.some((view) =>
            view.selection.owns(row, required(row.gpuDrivenDraws?.[0]), 0),
          ),
        ),
      ).toEqual([true, false]);
      expect(prepared.views.reduce((sum, view) => sum + view.bindings.size, 0)).toBe(3);
    } finally {
      f.dispose();
    }
  });

  it('preserves additional authored ShadowCaster passes on the direct lane', async () => {
    const f = await productionShadowFixture(2);
    try {
      const direct = required(f.rows[1]).material;
      direct.adopt({
        ...direct.snapshot,
        passes: [
          ...direct.snapshot.passes,
          {
            name: 'custom',
            program: { module: 'custom-shadow-caster' },
            renderState: { tags: { LightMode: 'ShadowCaster' } },
          },
        ],
        materialProgramKeys: {
          ...direct.snapshot.materialProgramKeys,
          custom: 'custom-shadow-caster',
        },
      });
      const prepared = f.prepare();
      expect(
        [...prepared.admitted.batchExecutions.values()].map((value) => value.shadow.route),
      ).toEqual(['gpu', 'direct']);
      expect(prepared.views.reduce((sum, view) => sum + view.bindings.size, 0)).toBe(3);
    } finally {
      f.dispose();
    }
  });

  it.each([false, true])('prepares off-camera CPU shadow materials (main rows=%s)', (withMain) => {
    const material = new MaterialResource({
      ...preparedSnapshot(1, 3).material.snapshot,
      materialHandle: 42,
    });
    const shadow = {
      source: { ...preparedSnapshot(1, 3), material, materials: [material] },
      renderableIndex: 0,
    } as never;
    const main = { source: preparedSnapshot(2, 3), renderableIndex: 0 } as never;
    const plan = buildDispatchPlan(
      { meshSsboState: { meshSlotCount: 16, materialSlotCount: 16 } } as never,
      withMain ? [main] : [],
      [],
      [],
      [shadow],
    );
    expect(plan.shadowValidatedOrdered).toMatchObject([shadow]);
    expect(plan.shadowValidatedOrdered[0]?.meshSlot).toBe(withMain ? 1 : 0);
    const slot = plan.materialSlots.indexOf(material.snapshot);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(plan.materialBindings[slot]?.material).toBe(material);
    expect(plan.materialSlotIndices[withMain ? 1 : 0]?.[0]).toBe(slot);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('records exact CPU residuals with authored state (skinned=%s, mirrored=%s)', async (skinned, mirrored) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const source = preparedSnapshot(8, 3);
    if (mirrored) source.transform.world[0] = -1;
    const firstDraw = source.gpuDrivenDraws?.[0];
    expect(firstDraw?.prepared).toBeDefined();
    if (firstDraw === undefined || firstDraw.prepared === undefined) return;
    const materials = [0, 1, 2].map(
      (index) =>
        new MaterialResource({
          ...source.material.snapshot,
          materialHandle: index + 20,
          passes: [
            {
              name: 'shadow',
              program: { module: 'forgeax::default-shadow-caster' },
              renderState: { tags: { LightMode: 'ShadowCaster' } },
            },
            ...(index === 2
              ? [
                  {
                    name: 'custom',
                    program: { module: 'custom-shadow-caster' },
                    renderState: {
                      tags: { LightMode: 'ShadowCaster' },
                      cullMode: 'none' as const,
                      frontFace: 'cw' as const,
                    },
                  },
                ]
              : []),
          ],
          materialProgramKeys: {
            shadow: 'forgeax::default-shadow-caster',
            custom: 'custom-shadow-caster',
          },
        }),
    );
    const draws = [
      { ...firstDraw, drawItemIndex: 0, materialSlot: 0, first: 0, count: 3 },
      { ...firstDraw, drawItemIndex: 1, materialSlot: 1, first: 3, count: 3 },
      { ...firstDraw, drawItemIndex: 2, materialSlot: 2, first: 6, count: 3 },
    ];
    const sourceForRecord: RenderableSnapshot = {
      ...source,
      ...(skinned ? { skinBinding: { skeleton: 7, joints: [19] } } : {}),
      material: required(materials[0]),
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
        getMaterialShaderPipelineEntry: (...args: unknown[]) => {
          pipelineRequests.push(args);
          return { pipeline: {} as never, group2Contract: skinned ? 'skin' : 'mesh' };
        },
        demandSkinTask: () => ({
          data: {},
          auxiliary: {},
          dataOffset: 0,
          auxiliaryOffset: 0,
          dataSize: 160,
          auxiliarySize: 16,
          jointCount: 1,
          flags: 1,
        }),
      },
      pipelineState: {
        identityInstanceBuffer,
        pbrSkinMeshBindGroupLayout: {} as never,

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
          meshSlot: 0,
        },
      ],
      frameState: {
        instanceBuffers: new Map(),
        meshBindGroupCache: new Map(),
        instancesBgPerEntity: new Map(),
        shadowMaterialBindGroups: new WeakMap(),
        materialBgShared: new Map(),
      },
      materialSlotIndices: [[0, 1, 2]],
      materialSlots: materials.map((material) => material.snapshot),
      materialFrame: materials.reduce(
        (frame, material) => frame.with(material, 1),
        new MaterialFrame(undefined),
      ),
      materialBgAssemblyCache: new MaterialBgAssemblyCache(),
      store: { materialResourceEpoch: 0 } as never,
      world: new World(),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      dispatch: [],
      // Stands in for the persistent scene owner, the only bounds source.
      shadowCasterBounds: (source: RenderableSnapshot, out: box3.Box3) => {
        if (source.skinBinding !== undefined) return false;
        if (source.localAabb === undefined) return false;
        box3.transformBox3(out, source.localAabb, source.transform.world);
        return true;
      },
    } as never;
    const selection = receiptSelection(
      [{ source: sourceForRecord }],
      (batch) => batch.binding?.drawItemIndex === 0,
    );
    Object.assign(context, { shadowSlotForEntity: () => ({ slot: 0, generation: 0 }) });
    recordShadowCasterDraws(context, pass, {} as never, {} as never, [selection]);
    expect(indexedDraws.map((args) => args[2])).toEqual([3, 6, 6]);
    const authored = pipelineRequests.find((args) => args[0] === 'custom-shadow-caster');
    expect(authored).toBeDefined();
    expect(authored?.[2]).toEqual({ cullMode: 'none', frontFace: mirrored ? 'ccw' : 'cw' });
    expect(authored?.[15]).toBeUndefined();
    if (skinned) expect(authored?.[5]).toContain('SKINNING_DISABLED=false');

    sourceForRecord.transform.world[12] = 100;
    indexedDraws.length = 0;
    recordShadowCasterDraws(
      context,
      pass,
      {} as never,
      {} as never,
      [selection],
      false,
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    expect(indexedDraws).toHaveLength(skinned ? 3 : 0);
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
    source.material.adopt({
      ...source.material.snapshot,
      passes: [
        {
          name: 'shadow',
          program: { module: 'forgeax::default-shadow-caster' },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
      materialProgramKeys: { shadow: 'forgeax::default-shadow-caster' },
    });
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
      validatedOrdered: [
        {
          source,
          renderableIndex: 0,
          meshSlot: 0,
          mesh: mesh(device),
        },
      ],
      materialFrame: new MaterialFrame(undefined).with(source.material, 1),
      shadowCasterBounds: (_source: RenderableSnapshot, out: box3.Box3) => {
        out.set([
          source.transform.world[12] ?? 0,
          -1,
          -1,
          (source.transform.world[12] ?? 0) + 2,
          1,
          1,
        ]);
        return true;
      },
      shadowViewPlanesByView: new Map([
        [key, frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()))],
      ]),
      gpuDrivenShadowViews: { submission: () => ({ identity, view, plan }) },
      gpuDrivenShadowBatchProjections: new Map([[key, new Map()]]),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
    } as never;
    const pass = {
      setBindGroup: vi.fn(),
      setPipeline: cpuPipeline,
      setVertexBuffer: cpuPipeline,
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
    const source = preparedSnapshot(1, 3);
    source.material.adopt({
      ...source.material.snapshot,
      passes: [
        {
          name: 'shadow',
          program: { module: 'forgeax::default-shadow-caster' },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
      materialProgramKeys: { shadow: 'forgeax::default-shadow-caster' },
    });
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
      validatedOrdered: [{ source, mesh: { submeshes: [{ materialSlot: 0 }] } }],
      materialFrame: new MaterialFrame(undefined).with(source.material, 1),
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

  it('rejects incompatible geometry at the shared admission boundary', async () => {
    const f = await productionShadowFixture(1);
    try {
      const draw = required(required(f.rows[0]).gpuDrivenDraws?.[0]);
      const result = prepareBatchExecution(
        { ...draw.geometry, receipt: { ...draw.geometry.receipt, vertexInputs: [] } },
        required(f.rows[0]).material.snapshot,
        { kind: 'shadow', shaderId: 'forgeax::default-standard-pbr' },
        () => f.input.materialArtifact,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.detail.owner).toBe('geometry');
    } finally {
      f.dispose();
    }
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing shadow fixture input');
  return value;
}
