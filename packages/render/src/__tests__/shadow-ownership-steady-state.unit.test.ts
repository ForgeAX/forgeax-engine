import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  rebaseShadowCasterOwnership,
  ShadowCasterOwnershipProjection,
  ShadowCasterOwnershipRebase,
} from '../gpu-driven/shadow-ownership';
import {
  publishedShadowMembershipKeys,
  shadowMembershipDraw,
  shadowMembershipLookup,
} from '../record/shadow-ownership-index';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';

function caster(entityKey: number, x: number, materialHandle = 20): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    worldId: 0,
    entityKey,
    assetHandle: 1,
    transform: { world },
    material: {} as never,
    materials: [],
    materialBindingSources: [],
    shadowCasterPasses: [
      {
        drawItemIndex: 0,
        materialHandle,
        passIndex: 1,
        materialShaderId: 'forgeax::default-shadow-caster',
        renderState: { cullMode: 'back' },
        gpuDrivenEligible: true,
      },
    ],
  } as RenderableSnapshot;
}

function shadowDispatch(renderableIndex: number): DispatchEntry {
  return { renderableIndex, tags: { LightMode: 'ShadowCaster' } } as unknown as DispatchEntry;
}

function frame(seconds: number, count = 64) {
  const renderables = Array.from({ length: count }, (_, index) =>
    caster(index + 1, Math.sin(seconds + index)),
  );
  const dispatch = renderables.map((_, index) => shadowDispatch(index));
  return { renderables, dispatch };
}

describe('steady-state ShadowCaster ownership', () => {
  it('reuses the unchanged ownership prefix and keeps earlier publications immutable', () => {
    const projection = new ShadowCasterOwnershipProjection();
    const source = frame(0, 64);
    const first = projection.project(source.renderables, source.dispatch);
    const firstRows = [...first.membership];
    const replaced = source.renderables.slice();
    replaced[63] = caster(64, 1, 21);
    const second = projection.project(replaced, source.dispatch);
    expect(projection.rowBuildCount()).toBe(65);
    for (let index = 0; index < 64; index++) {
      if (index !== 63) expect(second.membership[index]).toBe(firstRows[index]);
    }
    expect(second.membership[63]?.materialHandle).toBe(21);
    expect(second.drawKeys.has('64:20:0:1')).toBe(false);
    expect(second.drawKeys.has('64:21:0:1')).toBe(true);
    expect(first.membership).toEqual(firstRows);
    expect(first.drawKeys.has('64:20:0:1')).toBe(true);

    const appended = [...replaced, caster(65, 0)];
    const third = projection.project(appended, [...source.dispatch, shadowDispatch(64)]);
    expect(projection.rowBuildCount()).toBe(66);
    expect(third.membership.slice(0, 64)).toEqual(second.membership);
    for (let index = 0; index < 64; index++)
      expect(third.membership[index]).toBe(second.membership[index]);
    expect(projection.project(replaced, source.dispatch).membership).toEqual(second.membership);
    expect(projection.rowBuildCount()).toBe(66);

    const hidden = replaced.slice();
    hidden[63] = { ...caster(64, 0, 21), authorVisible: false };
    const fourth = projection.project(hidden, source.dispatch);
    expect(projection.rowBuildCount()).toBe(67);
    expect(fourth.membership).toHaveLength(63);
    expect(fourth.drawKeys.has('64:21:0:1')).toBe(false);
    expect(second.membership).toHaveLength(64);
  });

  it('rebases changed row positions and distinguishes repeated terrain entity identities', () => {
    const projection = new ShadowCasterOwnershipProjection();
    const source = [caster(1, 0, 20), caster(1, 0, 21), { ...caster(1, 0, 22), worldId: 1 }];
    const first = projection.project(
      source,
      source.map((_, index) => shadowDispatch(index)),
    );
    const reordered = [source[0], source[2], source[1]].filter(
      (row): row is RenderableSnapshot => row !== undefined,
    );
    const second = projection.project(
      reordered,
      source.map((_, index) => shadowDispatch(index)),
    );
    expect(
      second.membership.map((row) => [row.worldEntity, row.materialHandle, row.renderableIndex]),
    ).toEqual([
      [1, 20, 0],
      [4294967297, 22, 1],
      [1, 21, 2],
    ]);
    expect(second.membership[0]).toBe(first.membership[0]);
    expect(first.membership.map((row) => row.renderableIndex)).toEqual([0, 1, 2]);
    expect(projection.rowBuildCount()).toBe(5);
  });

  it('retains identity-mapped ownership rows and entity keys without changing draw-key derivation', () => {
    const source = frame(0, 4);
    source.renderables[2] = { ...caster(3, 0), worldId: 1 };
    const owned = new ShadowCasterOwnershipProjection().project(
      source.renderables,
      source.dispatch,
    );
    const staleDrawKeys = new Set(['stale:material:draw:pass']);
    for (const keys of [[], [0], [0, 1], [undefined, 1]]) {
      const rebased = rebaseShadowCasterOwnership(
        [{} as never, {} as never],
        keys as readonly number[],
        owned.entityKeys,
        staleDrawKeys,
        owned.membership,
      );
      expect(rebased.entityKeys).toBe(owned.entityKeys);
      expect(rebased.membership).toBe(owned.membership);
      expect(rebased.drawKeys).toEqual(owned.drawKeys);
      expect(rebased.membership).toEqual(owned.membership);
    }
  });

  it('publishes one shared captured key index and preserves duplicate pass rows', () => {
    const source = frame(0, 1);
    const row = source.renderables[0];
    if (row === undefined || row.shadowCasterPasses?.[0] === undefined)
      throw new Error('missing caster fixture');
    source.renderables[0] = {
      ...row,
      shadowCasterPasses: [
        ...row.shadowCasterPasses,
        { ...row.shadowCasterPasses[0], passIndex: 2, cpuReason: 'test' } as never,
      ],
    };
    const owned = new ShadowCasterOwnershipProjection().project(
      source.renderables,
      source.dispatch,
    );
    const lookup = shadowMembershipLookup(owned.membership);
    expect(lookup.keySet).toBe(owned.drawKeys);
    expect(publishedShadowMembershipKeys(owned.membership)).toBe(lookup.keys);
    expect(shadowMembershipDraw(lookup, 1, 20, 0)).toEqual({ rows: [0, 1], cpu: true });
    const raw = owned.membership.map((entry) => ({ ...entry }));
    expect(publishedShadowMembershipKeys(raw)).toBeUndefined();
    expect(shadowMembershipLookup(raw).keySet).not.toBe(owned.drawKeys);
  });

  it('keeps sparse raw rebase results unqualified and preserves holes in legacy key derivation', () => {
    const owned = new ShadowCasterOwnershipProjection().project(frame(0, 1).renderables, [
      shadowDispatch(0),
    ]);
    const raw = [owned.membership[0]];
    raw.length = 2;
    const rebased = rebaseShadowCasterOwnership(
      [{} as never],
      [7],
      owned.entityKeys,
      owned.drawKeys,
      raw as typeof owned.membership,
    );
    expect(rebased.membership).toHaveLength(2);
    expect(1 in (rebased.membership ?? [])).toBe(false);
    expect(publishedShadowMembershipKeys(rebased.membership ?? [])).toBeUndefined();
    expect(rebased.drawKeys.has(undefined as never)).toBe(true);
  });

  it('keeps the membership-free key normalization when world IDs are unchanged', () => {
    const entityKeys = new Set([1, 4294967298]);
    const drawKeys = new Set(['0001:20:0:1', '4294967298:21:0:1', 'invalid', 'NaN:20:0:1']);
    const rebased = rebaseShadowCasterOwnership(
      [{} as never, {} as never],
      [],
      entityKeys,
      drawKeys,
      undefined,
    );
    expect(rebased.entityKeys).toBe(entityKeys);
    expect(rebased.membership).toBeUndefined();
    expect(rebased.drawKeys).toEqual(
      new Set(['1:20:0:1', '4294967298:21:0:1', 'invalid', 'NaN:20:0:1']),
    );
  });

  it('keeps remapping and ownership changes current after an identity-mapped frame', () => {
    const source = frame(0, 2);
    source.renderables[1] = { ...caster(2, 0), worldId: 1 };
    const projection = new ShadowCasterOwnershipProjection();
    const owned = projection.project(source.renderables, source.dispatch);
    const owner = new ShadowCasterOwnershipRebase();
    const worlds = [{} as never, {} as never];
    const keys = [0, 1];
    const rebase = (worldsInput = worlds, worldKeys = keys, value = owned) =>
      owner.rebase(worldsInput, worldKeys, value.entityKeys, value.drawKeys, value.membership);
    const first = rebase();
    const firstLookup = shadowMembershipLookup(first.membership ?? []);
    expect(rebase([...worlds], [...keys])).toBe(first);
    keys[0] = 1;
    keys[1] = 0;
    const reordered = rebase();
    expect(reordered.membership?.map((x) => x.worldEntity)).toEqual([4294967297, 2]);
    expect(shadowMembershipLookup(reordered.membership ?? []).keys).toEqual([
      ...reordered.drawKeys,
    ]);
    expect(owned.membership.map((x) => x.worldEntity)).toEqual([1, 4294967298]);
    keys[0] = 0;
    const duplicates = rebase();
    expect(duplicates.membership?.map((x) => x.worldEntity)).toEqual([1, 2]);
    keys[1] = 1;
    expect(rebase().membership).toBe(owned.membership);
    expect(shadowMembershipLookup(rebase().membership ?? [])).toBe(firstLookup);
    const nextSource = frame(1, 3);
    const nextOwned = projection.project(nextSource.renderables, nextSource.dispatch);
    const next = rebase(worlds, keys, nextOwned);
    expect(next.membership).toBe(nextOwned.membership);
    expect(next.membership).toHaveLength(3);
    expect(next.drawKeys).toEqual(nextOwned.drawKeys);
  });

  it('keeps one ownership identity while only transforms move', () => {
    const projection = new ShadowCasterOwnershipProjection();
    const rebase = new ShadowCasterOwnershipRebase();
    const worlds = [{} as never];
    const stableWorldKeys = [7];
    const first = frame(0);
    const owned = projection.project(first.renderables, first.dispatch);
    const rebased = rebase.rebase(
      worlds,
      stableWorldKeys,
      owned.entityKeys,
      owned.drawKeys,
      owned.membership,
    );
    const lookup = shadowMembershipLookup(rebased.membership ?? []);
    expect(owned.membership).toHaveLength(64);
    expect(projection.buildCount()).toBe(1);

    for (let step = 1; step <= 120; step += 1) {
      const next = frame(step / 60);
      const again = projection.project(next.renderables, next.dispatch);
      expect(again).toBe(owned);
      const rebasedAgain = rebase.rebase(
        worlds,
        [...stableWorldKeys],
        again.entityKeys,
        again.drawKeys,
        again.membership,
      );
      expect(rebasedAgain).toBe(rebased);
      expect(shadowMembershipLookup(rebasedAgain.membership ?? [])).toBe(lookup);
    }
    expect(projection.buildCount()).toBe(1);
  });

  it('rebuilds on every ownership fact and on stable world key changes', () => {
    const projection = new ShadowCasterOwnershipProjection();
    const rebase = new ShadowCasterOwnershipRebase();
    const base = frame(0, 4);
    const owned = projection.project(base.renderables, base.dispatch);

    const material = frame(0, 4);
    material.renderables[2] = caster(3, 0, 21);
    const byMaterial = projection.project(material.renderables, material.dispatch);
    expect(byMaterial).not.toBe(owned);
    expect(byMaterial.membership[2]?.materialHandle).toBe(21);

    const hidden = frame(0, 4);
    hidden.renderables[2] = { ...caster(3, 0, 21), authorVisible: false };
    const byVisibility = projection.project(hidden.renderables, hidden.dispatch);
    expect(byVisibility).not.toBe(byMaterial);
    expect(byVisibility.membership).toHaveLength(3);

    const reordered = frame(0, 4);
    reordered.renderables[2] = { ...caster(3, 0, 21), authorVisible: false };
    reordered.dispatch.reverse();
    expect(projection.project(reordered.renderables, reordered.dispatch)).not.toBe(byVisibility);

    const removed = frame(0, 3);
    expect(projection.project(removed.renderables, removed.dispatch).membership).toHaveLength(3);
    expect(projection.buildCount()).toBe(5);

    const current = projection.project(removed.renderables, removed.dispatch);
    const worlds = [{} as never];
    const first = rebase.rebase(
      worlds,
      [1],
      current.entityKeys,
      current.drawKeys,
      current.membership,
    );
    const moved = rebase.rebase(
      worlds,
      [2],
      current.entityKeys,
      current.drawKeys,
      current.membership,
    );
    expect(moved).not.toBe(first);
    expect(moved.membership?.[0]?.worldEntity).not.toBe(first.membership?.[0]?.worldEntity);
  });
});
