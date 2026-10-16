import { mat4 } from '@forgeax/engine-math';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  GpuDrivenProduction,
  type GpuDrivenShadowBatchProjection,
} from '../gpu-driven/production-raster';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RecordProfileRunner } from '../record/render-context';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import {
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

async function fixture(instanceCount: number) {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const classCount = 8;
  const snapshots: RenderableSnapshot[] = Array.from({ length: classCount }, (_, index) => ({
    ...preparedSnapshot(index + 1, index + 1),
    instances: {
      transforms: new Float32Array(
        Array.from({ length: instanceCount }, () => [...mat4.identity(mat4.create())]).flat(),
      ),
      instanceCount,
      cacheKey: index + 1,
      archVersion: 1,
    },
  }));
  const projection = new RenderScene();
  const delta = projection.apply(snapshots.map(updateSnapshot));
  const available = GpuScene.create(device, classCount).unwrap();
  if (available.status !== 'available') throw Error('expected GPU Scene');
  const scene = available.scene;
  const bounds = () => ({ min: [-0.25, -0.25, -0.25] as const, max: [0.25, 0.25, 0.25] as const });
  scene.sync(delta, undefined, bounds).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const pbr = standardPbrInputs(device, shader, viewLayout);
  const meshes = new Map(Array.from({ length: classCount }, (_, index) => [index, mesh(device)]));
  const phases: string[] = [];
  const profilePhase: RecordProfileRunner = (name, action) => {
    phases.push(name);
    return action();
  };
  const input = {
    ...pbr,
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
    profilePhase,
  };
  const membership: ShadowCasterMembership[] = snapshots.map((snapshot, index) => ({
    worldEntity: snapshot.entityKey,
    renderableIndex: index,
    drawItemIndex: 0,
    materialHandle: -1,
    passIndex: 0,
    materialShaderId: SHADOW_CASTER_SHADER_ID,
    vertexEntry: 'shadow_fixture_vs',
    gpuDrivenEligible: true,
    renderState: { cullMode: 'back' },
  }));
  const identities = [0, 1, 2].map((index) => ({ kind: 'directional' as const, index }));
  const requests = identities.map((identity) => ({
    identity,
    planes: new Float32Array(24),
    matrix: mat4.identity(mat4.create()),
  }));
  const lookup = vi.spyOn(ShadowClaimTable.prototype, 'claim');
  const prepare = (
    values: readonly ShadowCasterMembership[],
    extra: Partial<Parameters<GpuDrivenProduction['prepare']>[0]> = {},
  ) => {
    lookup.mockClear();
    const frame = production
      .prepare({ ...input, ...extra, shadowCasterMembership: values })
      .unwrap();
    if (frame === undefined) throw Error('missing prepared frame');
    const prepareClaimCalls = lookup.mock.calls.length;
    lookup.mockClear();
    phases.length = 0;
    try {
      frame.updateShadowViews?.(requests).unwrap();
      // The publication exposes the retained read-only owner without cloning it.
      const maps = frame.shadowBatchProjections as ReadonlyMap<
        string,
        ReadonlyMap<number, GpuDrivenShadowBatchProjection>
      >;
      const views = identities.flatMap((identity) =>
        [true, false].map((staticLayer) => {
          const selected = staticLayer ? { ...identity, layer: 'static' as const } : identity;
          const key = shadowViewIdentityKey(selected);
          const submission = frame.shadowViewPool?.submission(selected);
          const bindings = maps.get(key);
          const claims = frame.shadowDrawKeysByView?.get(key);
          if (submission === undefined || bindings === undefined || claims === undefined)
            throw Error('missing shadow view');
          return { submission, bindings, claims };
        }),
      );
      frame._commitResourceReplacement();
      const firstStatic = views[0];
      if (firstStatic === undefined) throw Error('missing first static view');
      const ownership = Reflect.get(production, 'shadowOwnershipCache') as {
        readonly claims: ShadowClaimTable;
      };
      return {
        views,
        firstStatic,
        ownership: ownership.claims,
        prepareClaimCalls,
        claimCalls: lookup.mock.calls.length,
        phases: [...phases],
      };
    } catch (error) {
      frame._abortResourceReplacement?.();
      throw error;
    }
  };
  return {
    classCount,
    device,
    input,
    membership,
    snapshots,
    prepare,
    refresh(snapshot: RenderableSnapshot) {
      const changed = projection.apply([updateSnapshot(snapshot)]);
      scene.sync(changed, undefined, bounds).unwrap();
      topology.apply(changed);
      input.scene = { ...input.scene, plan: topology.plan(), slots: projection.slotsSnapshot() };
    },
    dispose() {
      lookup.mockRestore();
      production.dispose();
      scene.dispose();
    },
  };
}

it('retains physical projections while the full instance order and depth content change', async () => {
  const f = await fixture(16);
  try {
    const before = f.prepare(f.membership);
    const original = f.input.scene.plan;
    f.input.scene = {
      ...f.input.scene,
      plan: {
        ...original,
        revision: original.revision + 1,
        batches: original.batches.map((batch) => {
          const first = batch.candidates[0];
          if (first === undefined) throw Error('missing candidate');
          return {
            ...batch,
            contentEpoch: batch.contentEpoch + 1,
            candidates: [first, ...batch.candidates.slice(1).reverse()],
          };
        }),
      },
    };
    const after = f.prepare(f.membership);
    expect(after.views.map((view) => view.bindings)).toEqual(
      before.views.map((view) => view.bindings),
    );
    for (let index = 0; index < before.views.length; index++) {
      const old = before.views[index];
      const next = after.views[index];
      if (old === undefined || next === undefined) throw Error('missing view');
      expect(next.bindings).toBe(old.bindings);
      expect(next.submission.plan.candidateCount).toBe(old.submission.plan.candidateCount);
      expect(next.claims).toEqual(old.claims);
      if (next.submission.plan.candidateCount === 0) continue;
      expect(next.submission.plan.batches.map((batch) => batch.contentEpoch)).not.toEqual(
        old.submission.plan.batches.map((batch) => batch.contentEpoch),
      );
      expect(next.submission.plan.batches[0]?.candidates).not.toEqual(
        old.submission.plan.batches[0]?.candidates,
      );
      expect(old.submission.plan.batches[0]?.candidates[1]?.instanceOrdinal).toBe(1);
    }
  } finally {
    f.dispose();
  }
});

it.each([
  1, 16, 256,
])('retains shadow claims when presentation indices shift with %i instances per draw', async (instances) => {
  const f = await fixture(instances);
  try {
    const first = f.prepare(f.membership);
    expect(first.prepareClaimCalls).toBe(f.classCount);
    expect(first.claimCalls).toBe(6 * f.classCount);
    const expected = new Set(f.membership.map((entry) => `${entry.worldEntity}:-1:0:0`));
    for (const [index, view] of first.views.entries()) {
      expect(view.submission.plan.candidateCount).toBe(
        index % 2 === 0 ? instances * f.classCount : 0,
      );
      expect(view.claims).toEqual(expected);
    }
    let accepted: readonly ShadowCasterMembership[] = f.membership;
    for (let frame = 0; frame < 60; frame += 1) {
      let entryReads = 0;
      const fresh = f.membership.map((entry, index) => ({
        ...entry,
        // Unrelated non-caster rows can move every presentation index without
        // changing a single shadow draw, program, or resource.
        renderableIndex: index + (frame % 4) + 1,
        renderState: { ...entry.renderState },
        get vertexEntry() {
          entryReads += 1;
          return entry.vertexEntry ?? 'shadow_fixture_vs';
        },
      }));
      const next = f.prepare(fresh);
      accepted = fresh;
      expect({
        prepareClaimCalls: next.prepareClaimCalls,
        claimCalls: next.claimCalls,
        reusedMaps: next.views.filter(
          (view, index) => view.bindings === first.views[index]?.bindings,
        ).length,
        reusedClaims: next.views.filter((view, index) => view.claims === first.views[index]?.claims)
          .length,
      }).toEqual({ prepareClaimCalls: 0, claimCalls: 0, reusedMaps: 6, reusedClaims: 6 });
      expect(next.ownership).toBe(first.ownership);
      expect(entryReads).toBe(f.classCount);
      expect(next.phases.filter((name) => name.endsWith('/project-view'))).toHaveLength(6);
      for (const [index, view] of next.views.entries()) {
        expect(view.submission.plan).toBe(first.views[index]?.submission.plan);
        expect(view.bindings).toBe(first.views[index]?.bindings);
        expect(view.claims).toBe(first.views[index]?.claims);
        expect(view.claims).toEqual(expected);
      }
    }
    // Accepting an equal publication advances the existing claims source,
    // so retaining that publication needs no representative queries again.
    const retained = f.prepare(accepted);
    expect(retained.claimCalls).toBe(0);
    for (const [index, view] of retained.views.entries()) {
      expect(view.bindings).toBe(first.views[index]?.bindings);
      expect(view.claims).toBe(first.views[index]?.claims);
    }
  } finally {
    f.dispose();
  }
});

it('observes changed claim entries, raster state, pass keys and denied admission', async () => {
  const f = await fixture(16);
  try {
    const first = f.prepare(f.membership);
    const entry = f.membership[0];
    if (entry === undefined) throw Error('missing membership');
    Reflect.set(entry, 'vertexEntry', 'shadow_vs_changed');
    Reflect.set(entry, 'fragmentEntry', 'shadow_fs_changed');
    const entries = f.prepare(f.membership);
    expect(entries.views[0]?.submission.plan).toBe(first.views[0]?.submission.plan);
    expect(entries.views[0]?.bindings).not.toBe(first.views[0]?.bindings);
    expect([...entries.firstStatic.bindings.values()][0]).toMatchObject({
      shadowVertexEntry: 'shadow_vs_changed',
      shadowFragmentEntry: 'shadow_fs_changed',
    });
    Reflect.set(entry.renderState as object, 'cullMode', 'front');
    const state = f.prepare(f.membership);
    expect([...first.firstStatic.bindings.values()][0]?.shadowRenderState?.cullMode).toBe('back');
    expect(
      [...state.firstStatic.bindings.values()].some(
        (binding) => binding.shadowRenderState?.cullMode === 'front',
      ),
    ).toBe(true);
    Reflect.set(entry, 'passIndex', 1);
    const keys = f.prepare([...f.membership]);
    for (const view of keys.views) {
      expect(view.claims.has('1:-1:0:0')).toBe(false);
      expect(view.claims.has('1:-1:0:1')).toBe(true);
    }
    Reflect.set(entry, 'gpuDrivenEligible', false);
    const denied = f.prepare([...f.membership]);
    // Compare both ownership publications once per draw, then re-project the denied draw.
    expect(denied.prepareClaimCalls).toBe(2 * f.classCount + 1);
    for (const view of denied.views) expect(view.claims.has('1:-1:0:1')).toBe(false);
    Reflect.set(entry, 'gpuDrivenEligible', true);
    const restored = f.prepare([...f.membership]);
    for (const view of restored.views) expect(view.claims.has('1:-1:0:1')).toBe(true);
    Reflect.set(entry, 'materialHandle', 75);
    const material = f.prepare(f.membership);
    for (const view of material.views) expect(view.claims.has('1:-1:0:1')).toBe(false);
    Reflect.set(entry, 'materialHandle', -1);
    const removed = f.prepare(f.membership.slice(1));
    for (const view of removed.views) expect(view.claims.has('1:-1:0:1')).toBe(false);
    const reentered = f.prepare(f.membership);
    for (const view of reentered.views) expect(view.claims.has('1:-1:0:1')).toBe(true);
  } finally {
    f.dispose();
  }
});

it('observes material, physical mesh and shadow artifact replacements', async () => {
  const f = await fixture(16);
  try {
    f.prepare(f.membership);
    const snapshot = f.snapshots[0];
    if (snapshot === undefined) throw Error('missing snapshot');
    const material = { ...snapshot.material, roughness: 0.375 };
    f.refresh({ ...snapshot, material, materials: [material] });
    const materials = f.prepare([...f.membership]);
    const acceptedMaterial = f.input.scene.slotAt(0)?.snapshot.material;
    expect(
      materials.views.some(({ bindings }) =>
        [...bindings.values()].some((binding) => binding.material === acceptedMaterial),
      ),
    ).toBe(true);
    const replacement = mesh(f.device);
    f.input.meshBySlot.set(0, replacement);
    f.input.meshResidencyEpoch += 1;
    const meshes = f.prepare([...f.membership]);
    expect(
      meshes.views.some(({ bindings }) =>
        [...bindings.values()].some((binding) => binding.mesh === replacement),
      ),
    ).toBe(true);
    const original = f.input.standardPbrArtifact;
    const prepared = snapshot.gpuDrivenDraws?.[0]?.prepared;
    if (original === undefined || prepared === undefined) throw Error('missing artifact');
    const artifact = { ...original, program: createMaterialShaderProgram('new shadow program') };
    const artifacts = f.prepare([...f.membership], {
      shadowMaterialArtifacts: new Map([
        [
          gpuDrivenMaterialArtifactKey({
            material: prepared.identity.material,
            deformation: prepared.identity.deformation,
            receiptIdentity: prepared.receiptIdentity,
            receiptGeneration: prepared.receiptGeneration,
          }),
          artifact,
        ],
      ]),
    });
    expect(artifacts.views[0]?.bindings).not.toBe(meshes.views[0]?.bindings);
    expect(
      [...artifacts.firstStatic.bindings.values()].every(
        (binding) => binding.shadowArtifact === artifact,
      ),
    ).toBe(true);
  } finally {
    f.dispose();
  }
});

it('propagates a fresh claim getter failure and retries after the aborted projection', async () => {
  const f = await fixture(16);
  try {
    f.prepare(f.membership);
    const failed = f.membership.map((entry, index) => ({
      ...entry,
      get vertexEntry(): string {
        if (index === 0) throw Error('fresh shadow entry unavailable');
        return entry.vertexEntry ?? 'shadow_fixture_vs';
      },
    }));
    expect(() => f.prepare(failed)).toThrow('fresh shadow entry unavailable');
    const retried = f.prepare([...f.membership]);
    for (const view of retried.views) expect(view.claims.size).toBe(f.classCount);
  } finally {
    f.dispose();
  }
});

it('retains admitted caster facts when a non-caster enters the production scene', async () => {
  const f = await fixture(16);
  try {
    const first = f.prepare(f.membership);
    const extra = preparedSnapshot(100, 100);
    f.refresh(extra);
    const extraSlot = f.input.scene.slots.find((slot) => slot.snapshot.entityKey === 100);
    if (extraSlot === undefined) throw Error('missing added scene slot');
    f.input.meshBySlot.set(extraSlot.slot, mesh(f.device));
    f.input.meshResidencyEpoch += 1;
    const added = f.prepare(f.membership.map((entry) => ({ ...entry })));
    expect(added.ownership).toBe(first.ownership);
    expect(added.prepareClaimCalls).toBe(1);
    expect(added.claimCalls).toBe(0);
    for (const [index, view] of added.views.entries()) {
      expect(view.claims).toEqual(first.views[index]?.claims);
    }
    const stable = f.prepare(f.membership.map((entry) => ({ ...entry })));
    expect(stable.prepareClaimCalls).toBe(0);
    expect(stable.claimCalls).toBe(0);
  } finally {
    f.dispose();
  }
});

it('keeps static depth cached when a non-caster settles through promotion windows', async () => {
  const f = await fixture(16);
  try {
    f.prepare(f.membership);
    const extra = preparedSnapshot(100, 100);
    f.refresh(extra);
    const slot = f.input.scene.slots.find((row) => row.snapshot.entityKey === 100);
    if (slot === undefined) throw Error('missing non-caster slot');
    f.input.meshBySlot.set(slot.slot, mesh(f.device));
    f.input.meshResidencyEpoch += 1;
    for (let frame = 0; frame < 64; frame += 1) {
      const next = f.prepare(f.membership);
      for (const view of next.views.filter((_, index) => index % 2 === 0)) {
        expect(view.submission.plan.candidateCount).toBe(16 * f.classCount);
        expect(view.submission.cache).toBe('hit');
      }
    }
  } finally {
    f.dispose();
  }
});
