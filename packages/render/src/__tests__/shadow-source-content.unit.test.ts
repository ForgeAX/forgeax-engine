import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { shadowDirtyRects } from '../gpu-driven/shadow-views';
import { updateGpuView, updateShadowView } from './helpers/gpu-input-read-domain';
import { shadowSourceFixture, shadowSourceSnapshot } from './shadow-source-content.fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const shaderModuleFactory = { createShaderModule: () => ok(shader) };
  return { ...shadowSourceFixture(device, shaderModuleFactory), device, shaderModuleFactory };
}

it('clears bounded old/new footprints when a changed source caster leaves the static class', async () => {
  const f = await fixture();
  try {
    const before = f.input();
    const warm = updateShadowView(f.pool, before).unwrap();
    f.pool._commitResourceReplacement();
    const revision = f.scene.contentRevision;
    const transform = f.scene.transformBuffer;
    const resourceGeneration = warm.view.inspect().resourceGeneration;
    const delta = f.update(shadowSourceSnapshot(1, -14, 4));
    const changed = delta.updatedSlots[0]?.slot;
    expect(changed).toBeDefined();
    const next = f.input();
    expect(next.sourcePlan).not.toBe(before.sourcePlan);
    expect(next.ignoredChangeSlots.has(changed ?? -1)).toBe(true);
    expect(next.candidatePrimitiveIndices).not.toContain(changed);
    expect(f.scene.changedBoundsSince(revision, next.ignoredChangeSlots)).toHaveLength(0);
    const boxes = f.scene.slotBoundsSince(revision, [changed ?? -1]);
    expect(boxes).not.toBe('unbounded');
    if (boxes === 'unbounded') throw Error('expected proved caster bounds');
    const history = Array.from({ length: boxes.length / 6 }, (_, index) => [
      ...boxes.subarray(index * 6, index * 6 + 6),
    ]);
    expect(history).toContainEqual([-11, -1, -1, -9, 1, 1]);
    expect(history).toContainEqual([-15, -1, -1, -13, 1, 1]);
    const expected = shadowDirtyRects(next.matrix, [boxes]);
    expect(expected).toHaveLength(2);
    const result = updateShadowView(f.pool, next).unwrap();
    expect(result.cache).toBe('invalidated');
    expect(f.scene.transformBuffer).toBe(transform);
    expect(result.view.inspect().resourceGeneration).toBe(resourceGeneration);
    expect(f.pool.dirtyRects(f.identity)).toEqual(expected);
    expect(f.pool.invalidationReason(f.identity)).toBe('membership-changed');
  } finally {
    f.dispose();
  }
});

it('adopts an equivalent rebuilt source without invalidating retained depth', async () => {
  const f = await fixture();
  try {
    const before = updateShadowView(f.pool, f.input()).unwrap();
    const oldSource = before.sourcePlan;
    const oldBatches = oldSource.batches;
    f.pool._commitResourceReplacement();
    f.topology.rebuild(f.projection.slotsSnapshot());
    const next = f.input();
    expect(next.sourcePlan).not.toBe(before.sourcePlan);
    const result = updateShadowView(f.pool, next).unwrap();
    expect(result.cache).toBe('hit');
    expect(result.plan.candidateCount).toBe(before.plan.candidateCount);
    expect(result.sourcePlan).not.toBe(oldSource);
    expect(result.sourcePlan.revision).toBe(next.sourcePlan.revision);
    expect(result.sourcePlan.batches.map((batch) => [...batch.candidates])).toEqual(
      next.sourcePlan.batches.map((batch) => [...batch.candidates]),
    );
    expect(before.sourcePlan).toBe(oldSource);
    expect(before.sourcePlan.batches).toBe(oldBatches);
    expect(result.plan.batches.map((batch) => [...batch.candidates])).toEqual(
      before.plan.batches.map((batch) => [...batch.candidates]),
    );
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it('adds a declared static caster using only its bounded footprint', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    const revision = f.scene.contentRevision;
    const delta = f.update({ ...shadowSourceSnapshot(3, 20), mobility: 'static' });
    const added = delta.createdSlots[0]?.slot;
    expect(added).toBeDefined();
    const next = f.input();
    expect(next.candidatePrimitiveIndices).toContain(added);
    expect(next.ignoredChangeSlots.has(added ?? -1)).toBe(false);
    const boxes = f.scene.slotBoundsSince(revision, [added ?? -1]);
    if (boxes === 'unbounded') throw Error('expected bounded created caster');
    const result = updateShadowView(f.pool, next).unwrap();
    expect(result.cache).toBe('invalidated');
    expect(result.plan.candidateCount).toBe(3);
    expect(f.pool.dirtyRects(f.identity)).toEqual(shadowDirtyRects(next.matrix, [boxes]));
    expect(f.pool.dirtyRects(f.identity)).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('clears removed caster footprints, including the last caster, then retains the empty layer', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    for (const entityKey of [1, 2]) {
      const revision = f.scene.contentRevision;
      const delta = f.apply([{ kind: 'remove', worldId: 0, entityKey }]);
      expect(delta.removedSlots).toHaveLength(1);
      const next = f.input();
      const boxes = f.scene.changedBoundsSince(revision, next.ignoredChangeSlots);
      if (boxes === 'unbounded') throw Error('expected bounded removed caster');
      expect(boxes.length).toBeGreaterThan(0);
      const result = updateShadowView(f.pool, next).unwrap();
      expect(result.cache).toBe('invalidated');
      expect(result.plan.candidateCount).toBe(2 - entityKey);
      expect(f.pool.dirtyRects(f.identity)).toEqual(shadowDirtyRects(next.matrix, [boxes]));
      expect(f.pool.dirtyRects(f.identity)).toHaveLength(1);
      f.pool._commitResourceReplacement();
      expect(updateShadowView(f.pool, f.input()).unwrap().cache).toBe('hit');
    }
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it.each([
  'rigid',
  'skinned',
] as const)('retains every static cascade when a dynamic %s caster is removed', async (kind) => {
  const f = await fixture();
  const frame = () => {
    const input = f.input();
    const views = [0, 1, 2].map((index) =>
      updateShadowView(f.pool, { ...input, identity: { ...f.identity, index } }).unwrap(),
    );
    f.pool._commitResourceReplacement();
    return { input, views };
  };
  try {
    frame();
    const spawned = f.update({
      ...shadowSourceSnapshot(3, 0),
      ...(kind === 'rigid'
        ? {}
        : {
            skin: {
              buffer: f.scene.transformBuffer,
              jointCount: 1,
              byteOffset: 0,
              identity: 'dynamic-caster',
              generation: 1,
              fence: 0,
              customDataStart: 0,
              storageOrUniform: 'storage' as const,
              dirtyRanges: [],
              uploadBytes: 0,
            },
          }),
    });
    const dynamicSlot = spawned.createdSlots[0]?.slot;
    expect(dynamicSlot).toBeDefined();
    const before = frame();
    expect(before.input.ignoredChangeSlots.has(dynamicSlot ?? -1)).toBe(true);
    expect(before.views.map((view) => view.cache)).toEqual(['hit', 'hit', 'hit']);
    f.apply([{ kind: 'remove', worldId: 0, entityKey: 3 }]);
    const after = frame();
    expect(after.input.ignoredChangeSlots.has(dynamicSlot ?? -1)).toBe(false);
    expect(after.views.map((view) => view.cache)).toEqual(['hit', 'hit', 'hit']);
    for (const [index, view] of after.views.entries()) {
      expect(view.generation).toBe(before.views[index]?.generation);
      expect(view.plan.candidateCount).toBe(2);
      expect(f.pool.dirtyRects({ ...f.identity, index })).toBeUndefined();
    }
  } finally {
    f.dispose();
  }
});

it.each([
  false,
  true,
])('observes the new occupant of a removed dynamic slot (declared static=%s)', async (declaredStatic) => {
  const f = await fixture();
  const frame = () => {
    const input = f.input();
    const view = updateShadowView(f.pool, input).unwrap();
    f.pool._commitResourceReplacement();
    return { input, view };
  };
  try {
    frame();
    const created = f.update(shadowSourceSnapshot(3, 0)).createdSlots[0];
    if (created === undefined) throw Error('expected dynamic caster');
    expect(frame().view.cache).toBe('hit');
    const replacement = {
      ...shadowSourceSnapshot(4, 0),
      ...(declaredStatic ? { mobility: 'static' as const } : {}),
    };
    const delta = f.apply([
      { kind: 'remove', worldId: 0, entityKey: 3 },
      { kind: 'update', worldId: 0, entityKey: 4, snapshot: replacement },
    ]);
    const reused = delta.createdSlots[0];
    expect(reused?.slot).toBe(created.slot);
    expect(reused?.generation).not.toBe(created.generation);
    const next = frame();
    expect(next.input.candidatePrimitiveIndices.has(created.slot)).toBe(declaredStatic);
    expect(next.view.cache).toBe(declaredStatic ? 'invalidated' : 'hit');
    expect(next.view.plan.candidateCount).toBe(declaredStatic ? 3 : 2);
    if (declaredStatic) expect(f.pool.dirtyRects(f.identity)).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('clears a removed static footprint when its slot is reused by a dynamic caster', async () => {
  const f = await fixture();
  try {
    const first = f.input();
    updateShadowView(f.pool, first).unwrap();
    f.pool._commitResourceReplacement();
    const old = f.projection.slotsSnapshot().find((slot) => slot.entityKey === 1);
    if (old === undefined) throw Error('expected static caster');
    const replacement = shadowSourceSnapshot(3, 0);
    const delta = f.apply([
      { kind: 'remove', worldId: 0, entityKey: 1 },
      { kind: 'update', worldId: 0, entityKey: 3, snapshot: replacement },
    ]);
    expect(delta.createdSlots[0]?.slot).toBe(old.slot);
    expect(delta.createdSlots[0]?.generation).not.toBe(old.generation);
    const next = f.input();
    expect(next.ignoredChangeSlots.has(old.slot)).toBe(true);
    expect(updateShadowView(f.pool, next).unwrap().cache).toBe('invalidated');
    expect(f.pool.dirtyRects(f.identity)?.length).toBeGreaterThan(0);
    f.pool._commitResourceReplacement();
    expect(updateShadowView(f.pool, f.input()).unwrap().cache).toBe('hit');
  } finally {
    f.dispose();
  }
});

it('adds a dynamic caster to static depth when it gains the static declaration', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    const source = shadowSourceSnapshot(3, 0);
    f.update(source);
    expect(updateShadowView(f.pool, f.input()).unwrap().cache).toBe('hit');
    f.pool._commitResourceReplacement();
    f.update({ ...source, mobility: 'static' });
    const next = updateShadowView(f.pool, f.input()).unwrap();
    expect(next.cache).toBe('invalidated');
    expect(next.plan.candidateCount).toBe(3);
    expect(f.pool.dirtyRects(f.identity)).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('retries an aborted bounded source update with a full redraw', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    f.update(shadowSourceSnapshot(1, -14, 4));
    updateShadowView(f.pool, f.input()).unwrap();
    expect(f.pool.dirtyRects(f.identity)).toHaveLength(2);
    f.pool._abortResourceReplacement();
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
    expect(updateShadowView(f.pool, f.input()).unwrap().cache).toBe('invalidated');
    expect(f.pool.invalidationReason(f.identity)).toBe('submit-aborted');
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
    f.pool._commitResourceReplacement();
    expect(updateShadowView(f.pool, f.input()).unwrap().cache).toBe('hit');
  } finally {
    f.dispose();
  }
});

it('redraws fully when the scene is replaced despite equivalent source content', async () => {
  const f = await fixture();
  const replacement = shadowSourceFixture(f.device, f.shaderModuleFactory);
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    expect(updateShadowView(f.pool, replacement.input()).unwrap().cache).toBe('invalidated');
    expect(f.pool.invalidationReason(f.identity)).toBe('source-changed');
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
    replacement.dispose();
  }
});

it('redraws fully when scene buffers grow even if every added caster is ignored', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    const transform = f.scene.transformBuffer;
    for (let entityKey = 3; entityKey <= 9; entityKey++)
      f.update(shadowSourceSnapshot(entityKey, 20));
    const next = f.input();
    expect(next.candidatePrimitiveIndices.size).toBe(2);
    expect(next.ignoredChangeSlots.size).toBe(7);
    expect(f.scene.transformBuffer).not.toBe(transform);
    expect(updateShadowView(f.pool, next).unwrap().cache).toBe('invalidated');
    expect(f.pool.invalidationReason(f.identity)).toBe('source-changed');
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it('redraws fully after physical view resources change outside retained publication', async () => {
  const f = await fixture();
  try {
    const before = updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    const generation = before.view.inspect().resourceGeneration;
    const transform = f.scene.transformBuffer;
    for (let entityKey = 3; entityKey <= 7; entityKey++)
      f.update(shadowSourceSnapshot(entityKey, 20, entityKey + 10));
    const next = f.input();
    // The view's public update can replace its allocations before the pool
    // receives the next publication. A stable scene is insufficient for reuse.
    updateGpuView(before.view, next.sourcePlan, next.scene, next.planes).unwrap();
    expect(before.view.inspect().resourceGeneration).toBeGreaterThan(generation);
    expect(f.scene.transformBuffer).toBe(transform);
    expect(updateShadowView(f.pool, next).unwrap().cache).toBe('invalidated');
    expect(f.pool.invalidationReason(f.identity)).toBe('source-changed');
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it('does not turn explicit invalidation into a partial source-content update', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    f.update(shadowSourceSnapshot(1, -14, 4));
    f.pool.invalidate('artifact-changed', f.identity);
    expect(updateShadowView(f.pool, f.input()).unwrap().cache).toBe('invalidated');
    expect(f.pool.invalidationReason(f.identity)).toBe('artifact-changed');
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it('redraws fully when a changed caster leaving the static class has unbounded history', async () => {
  const f = await fixture();
  try {
    updateShadowView(f.pool, f.input()).unwrap();
    f.pool._commitResourceReplacement();
    const revision = f.scene.contentRevision;
    const { localAabb: _localAabb, ...unbounded } = shadowSourceSnapshot(1, -14, 4);
    f.update(unbounded);
    const next = f.input();
    expect(f.scene.changedBoundsSince(revision, next.ignoredChangeSlots)).toHaveLength(0);
    expect(f.scene.slotBoundsSince(revision, next.ignoredChangeSlots)).toBe('unbounded');
    expect(updateShadowView(f.pool, next).unwrap().cache).toBe('invalidated');
    expect(f.pool.dirtyRects(f.identity)).toBeUndefined();
  } finally {
    f.dispose();
  }
});
