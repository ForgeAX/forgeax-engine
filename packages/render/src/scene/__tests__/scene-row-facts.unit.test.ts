import { expect, it } from 'vitest';
import type { RenderableSnapshot } from '../../render-system-extract';
import { lodCandidateCountOf, RetainedFrameProjection, sparseRowsOf } from '../frame-list';
import type { RenderSceneSlot } from '../render-scene-types';
import { SceneSlots } from '../scene-slots';
import { setSceneRow } from './scene-row-writes';

type MeshState = 'absent' | 'lods' | 'plain';

interface Row {
  readonly worldId: number;
  readonly entityKey: number;
  readonly assetHandle: number;
  readonly lods: boolean;
  readonly overrides: boolean;
  readonly terrain: boolean;
  readonly capsule: boolean;
}

function slotOf(slot: number, row: Row): RenderSceneSlot {
  const snapshot = {
    worldId: row.worldId,
    entityKey: row.entityKey,
    assetHandle: row.assetHandle,
    ...(row.lods ? { lods: [{}] } : {}),
    ...(row.overrides ? { materialOverrides: [] } : {}),
    ...(row.terrain ? { terrain: {} } : {}),
    ...(row.capsule ? { capsuleShadowRequested: true } : {}),
  } as unknown as RenderableSnapshot;
  return {
    slot,
    generation: 0,
    version: 0,
    worldId: row.worldId,
    entityKey: row.entityKey,
    snapshot,
  };
}

// The draw projection reads a resident Mesh's levels for override-carrying rows, else its own.
function reference(rows: Map<number, Row>, meshes: Map<string, MeshState>): number {
  let count = 0;
  for (const row of rows.values()) {
    const mesh = meshes.get(`${row.worldId}:${row.assetHandle}`) ?? 'absent';
    const viaMesh = !row.terrain && row.overrides && mesh !== 'absent';
    if (viaMesh ? mesh === 'lods' : row.lods) count++;
  }
  return count;
}

it('maintains the LOD candidate count and sparse indexes equal to full recomputation', () => {
  const slots = new SceneSlots();
  const rows = new Map<number, Row>();
  const meshes = new Map<string, MeshState>();
  let seed = 12345;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let step = 0; step < 4000; step++) {
    const action = random(5);
    if (action < 3) {
      const slot = random(200);
      const row: Row = {
        worldId: random(2),
        entityKey: slot,
        assetHandle: random(4),
        lods: random(2) === 0,
        overrides: random(4) !== 0,
        terrain: random(10) === 0,
        capsule: random(6) === 0,
      };
      rows.set(slot, row);
      setSceneRow(slots, slot, slotOf(slot, row));
    } else if (action === 3) {
      const slot = random(200);
      rows.delete(slot);
      setSceneRow(slots, slot, undefined);
    } else {
      const worldId = random(2);
      const handle = random(4);
      const state = (['absent', 'lods', 'plain'] as const)[random(3)] as MeshState;
      meshes.set(`${worldId}:${handle}`, state);
      slots.setMeshLods(worldId, handle, state === 'absent' ? undefined : state === 'lods');
    }
    if (step % 97 === 0) {
      expect(slots.lodCandidateCount).toBe(reference(rows, meshes));
      const sorted = [...rows.entries()].sort((a, b) => a[0] - b[0]);
      expect(slots.indexedSlots('terrain')).toEqual(
        sorted.filter(([, row]) => row.terrain).map(([slot]) => slot),
      );
      expect(slots.indexedSlots('capsule')).toEqual(
        sorted.filter(([, row]) => row.capsule).map(([slot]) => slot),
      );
    }
  }
  slots.clearMeshLods();
  meshes.clear();
  expect(slots.lodCandidateCount).toBe(reference(rows, meshes));
});

it('reads retained row facts through projections and falls back to walking plain lists', () => {
  const slots = new SceneSlots();
  setSceneRow(
    slots,
    0,
    slotOf(0, {
      worldId: 0,
      entityKey: 1,
      assetHandle: 1,
      lods: true,
      overrides: false,
      terrain: false,
      capsule: true,
    }),
  );
  setSceneRow(
    slots,
    1,
    slotOf(1, {
      worldId: 0,
      entityKey: 2,
      assetHandle: 1,
      lods: false,
      overrides: false,
      terrain: true,
      capsule: false,
    }),
  );
  const frame = slots.capture();
  const rows = new RetainedFrameProjection(frame, (slot) => slot.snapshot, {
    lodCandidateCount: slots.lodCandidateCount,
    *sparseRows(kind) {
      for (const slot of slots.indexedSlots(kind))
        yield (frame.slotAt(slot) as RenderSceneSlot).snapshot;
    },
  });
  expect(lodCandidateCountOf(rows)).toBe(1);
  expect([...sparseRowsOf(rows, 'terrain')].map((row) => row.entityKey)).toEqual([2]);
  expect([...sparseRowsOf(rows, 'capsule')].map((row) => row.entityKey)).toEqual([1]);
  const plain = [...rows];
  const list = new RetainedFrameProjection(frame, (slot) => slot.snapshot);
  expect(lodCandidateCountOf(list)).toBe(1);
  expect([...sparseRowsOf(list, 'terrain')]).toHaveLength(2);
  expect(plain).toHaveLength(2);
});
