import { assert, expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { RenderScene } from '../../scene/render-scene';
import { buildDispatchPlan } from '../fold-buckets';
import type { ValidatedRenderable } from '../frame-snapshot';
import { MeshDrawSlots } from '../mesh-draw-slots';
import type { FoldBucket } from '../mesh-ssbo';

function terrainSource(source: ValidatedRenderable['source'], _count: number) {
  return {
    ...source,
    terrain: {
      handle: 1 as import('@forgeax/engine-types').AssetHandle<'terrain'>,
      lod0Diameter: 1,
      forcedLod: -1,
      layer: 0,
    },
  } as ValidatedRenderable['source'];
}

function terrainRows(row: ValidatedRenderable, count: number): ValidatedRenderable[] {
  const source = terrainSource(row.source, count);
  return Array.from({ length: count }, (_, index) => ({
    ...row,
    source: {
      ...source,
      terrainSection: {
        index,
        lod: 0,
        neighbors: [0, 0, 0, 0],
        source: {
          version: 0,
          asset: { columns: 1, rows: 1, spacing: 1, subsectionVertices: 2, heightRange: [0, 1] },
          layers: [],
          activeLayers: [],
          grids: [],
          sectionCount: count,
          sections: undefined,
        },
      },
    },
  }));
}

it.each([
  'apply',
  'reset',
] as const)('reclaims terrain tails before ordinary draws regardless of roster order via %s', (update) => {
  const { rows, scene, internals } = capacityFixture(3);
  const [root, ordinary] = rows;
  assert(root && ordinary);
  scene.reset([terrainSource(root.source, 3), ordinary.source]);
  const plan = (draws: readonly ValidatedRenderable[]) =>
    buildDispatchPlan(internals, draws, [], [], [], undefined, false, undefined, scene);
  expect(plan(terrainRows(root, 3)).validatedOrdered.map((row) => row.meshSlot)).toEqual([0, 1, 2]);
  const next = terrainSource(root.source, 1);
  if (update === 'apply')
    scene.apply([
      { kind: 'update', worldId: next.worldId, entityKey: next.entityKey, snapshot: next },
    ]);
  else scene.reset([ordinary.source, next]);
  expect(
    plan([ordinary, ...terrainRows(root, 1)]).validatedOrdered.map((row) => row.meshSlot),
  ).toEqual([1, 0]);
});

it.each([undefined, 0])('reclaims terrain ranges when its next shape is %s', (count) => {
  const { rows, scene, internals } = capacityFixture(3);
  const [root, ordinary] = rows;
  assert(root && ordinary);
  scene.reset([terrainSource(root.source, 3), ordinary.source]);
  const plan = (draws: readonly ValidatedRenderable[]) =>
    buildDispatchPlan(internals, draws, [], [], [], undefined, false, undefined, scene);
  plan(terrainRows(root, 3));
  const next = count === undefined ? root.source : terrainSource(root.source, count);
  scene.apply([
    { kind: 'update', worldId: next.worldId, entityKey: next.entityKey, snapshot: next },
  ]);
  expect(
    plan([ordinary, ...(count === undefined ? [root] : [])]).validatedOrdered.map(
      (row) => row.meshSlot,
    ),
  ).toEqual(count === undefined ? [0, 1] : [0]);
});

it('reclaims ordinary addresses before a source becomes terrain', () => {
  const { rows, scene, internals } = capacityFixture(3);
  const root = rows[0];
  assert(root);
  const plan = (draws: readonly ValidatedRenderable[]) =>
    buildDispatchPlan(internals, draws, [], [], [], undefined, false, undefined, scene);
  plan([root]);
  const next = terrainSource(root.source, 3);
  scene.apply([
    { kind: 'update', worldId: next.worldId, entityKey: next.entityKey, snapshot: next },
  ]);
  expect(plan(terrainRows(root, 3)).validatedOrdered.map((row) => row.meshSlot)).toEqual([0, 1, 2]);
});

function capacityFixture(capacity = 2) {
  const base = receiptRow().source;
  const rows = [0, 1, 2].map(
    (index) =>
      ({
        source: { ...base, entityKey: base.entityKey + index },
        meshSlot: index,
        renderableIndex: index,
        mesh: {},
        renderState: undefined,
        stencilReference: undefined,
      }) as ValidatedRenderable,
  );
  const scene = new RenderScene();
  scene.rebuild(rows.map((row) => row.source));
  const metrics = { increment: vi.fn() };
  const internals = {
    device: { caps: { storageBuffer: true } },
    metrics,
    meshSsboState: { meshSlotCount: capacity, materialSlotCount: 2 },
    growMeshSsbo: () => ({
      ok: false,
      code: 'mesh-ssbo-ceiling-reached',
      degradedTo: { meshSlotCount: capacity, materialSlotCount: 2 },
    }),
  } as never;
  return { rows, scene, internals, metrics };
}

it('recovers below the address budget after an oversized candidate loses its sources', () => {
  const { rows, scene, internals } = capacityFixture();
  const plan = (rows: readonly ValidatedRenderable[]) =>
    buildDispatchPlan(internals, rows, [], [], [], undefined, false, undefined, scene);
  expect(() => plan(rows)).toThrow('capacity for every physical draw address');
  scene.apply(
    rows.slice(1).map(({ source }) => ({
      kind: 'remove',
      worldId: source.worldId,
      entityKey: source.entityKey,
    })),
  );
  expect(plan(rows.slice(0, 1)).validatedOrdered[0]?.meshSlot).toBe(0);
});

it.each([
  false,
  true,
])('falls back to ordinary draws when folded identity exceeds capacity, native=%s', (native) => {
  const { rows, scene, internals, metrics } = capacityFixture();
  const buckets = [
    {
      entries: [{ renderableIndex: 0 }, { renderableIndex: 1 }],
      bucketSize: 2,
      transforms: new Float32Array(32),
      materialHandle: 17,
      layer: 0,
      sortKey: 0,
    } as unknown as FoldBucket,
  ];
  const plan = buildDispatchPlan(
    internals,
    rows.slice(0, 2),
    [],
    buckets,
    [],
    undefined,
    false,
    undefined,
    native ? scene : undefined,
  );
  expect(plan.foldDispatchPlan).toBeNull();
  expect(plan.validatedOrdered.map((row) => row.meshSlot)).toEqual([0, 1]);
  expect(plan.validatedOrdered.every((row) => row.foldedMeshSlot === undefined)).toBe(true);
  expect(metrics.increment).not.toHaveBeenCalled();
});

it('keeps source, terrain and folded addresses disjoint through scene growth', () => {
  const owner = new MeshDrawSlots();
  const root = { slot: 4, generation: 2, worldId: 0, entityKey: 19 };
  const source = owner.index(root, 'source');
  const folded = owner.index(root, 'folded');
  const sections = Array.from({ length: 4 }, (_, section) =>
    owner.index(root, { key: `section:${section}` }),
  );
  const other = owner.index({ ...root, slot: 100, entityKey: 21 }, 'source');
  expect(new Set([source, folded, ...sections, other]).size).toBe(7);
  expect(owner.index(root, 'source')).toBe(source);
  expect(owner.index(root, { key: 'section:1' })).toBe(sections[1]);
  const grown = owner.index(root, { key: 'section:8' });
  expect(grown).not.toBe(source);
  expect(grown).not.toBe(folded);
  expect(grown).not.toBe(other);
  expect(owner.index(root, 'source')).toBe(source);
  expect(owner.index({ ...root, slot: 100, entityKey: 21 }, 'source')).toBe(other);
  owner.release(root);
  const next = { ...root, generation: 3 };
  const reused = owner.index(next, 'source');
  expect(reused).toBe(source);
  owner.release(root); // Late retirement cannot reclaim a reused generation.
  expect(owner.index(next, 'source')).toBe(reused);
  expect(() => owner.index(root, 'source')).toThrow('release the prior generation');
});

it('reclaims prior folded work before newly visible ordinary sources need its capacity', () => {
  const { rows, scene, internals } = capacityFixture(3);
  const buckets = [
    {
      entries: [{ renderableIndex: 0 }, { renderableIndex: 1 }],
      bucketSize: 2,
      transforms: new Float32Array(32),
      materialHandle: 17,
      layer: 0,
      sortKey: 0,
    } as unknown as FoldBucket,
  ];
  const first = buildDispatchPlan(
    internals,
    rows.slice(0, 2),
    [],
    buckets,
    [],
    undefined,
    false,
    undefined,
    scene,
  );
  expect(first.foldDispatchPlan?.foldedBucketCount).toBe(1);
  expect(first.validatedOrdered[0]?.foldedMeshSlot).toBe(2);
  const next = buildDispatchPlan(internals, rows, [], [], [], undefined, false, undefined, scene);
  expect(next.validatedOrdered.map((row) => row.meshSlot)).toEqual([0, 1, 2]);
  expect(next.validatedOrdered.every((row) => row.foldedMeshSlot === undefined)).toBe(true);
  expect(next.foldDispatchPlan).toBeNull();
});

it('retires exact source allocations on remove, recreate and reset without a cache sweep', () => {
  const scene = new RenderScene();
  const a = receiptRow().source;
  const b = { ...a, entityKey: a.entityKey + 1 };
  scene.rebuild([a, b]);
  const aSlot = scene.meshDrawSlot(a);
  const bSlot = scene.meshDrawSlot(b);
  const aFolded = scene.meshDrawSlot(a, true);
  expect(aSlot).not.toBe(aFolded);
  scene.apply([{ kind: 'remove', worldId: a.worldId, entityKey: a.entityKey }]);
  expect(() => scene.meshDrawSlot(a)).toThrow('retained Scene');
  expect(scene.meshDrawSlot(b)).toBe(bSlot);
  const c = { ...a, entityKey: a.entityKey + 2 };
  scene.apply([{ kind: 'update', worldId: c.worldId, entityKey: c.entityKey, snapshot: c }]);
  expect(scene.meshDrawSlot(c)).toBe(aSlot);
  scene.reset([b]);
  expect(scene.meshDrawSlot(b)).toBe(bSlot);
  scene.apply([{ kind: 'update', worldId: c.worldId, entityKey: c.entityKey, snapshot: c }]);
  expect(scene.meshDrawSlot(c)).toBe(aSlot);
  expect(scene.meshDrawCapacity).toBe(3);
});

it('assigns the same source address to independently ordered main and shadow rosters', () => {
  const scene = new RenderScene();
  const a = {
    ...receiptRow(),
    meshSlot: 0,
    renderableIndex: 0,
    mesh: {},
    renderState: undefined,
    stencilReference: undefined,
  } as ValidatedRenderable;
  const b = {
    ...a,
    source: { ...a.source, entityKey: a.source.entityKey + 1 },
    renderableIndex: 1,
  };
  scene.rebuild([a.source, b.source]);
  // Two physical rows suffice for four logical draw rows.
  const internals = {
    meshSsboState: { meshSlotCount: 2, materialSlotCount: 2 },
    growMeshSsbo: () => {
      throw new Error('unexpected growth');
    },
  } as never;
  const first = buildDispatchPlan(
    internals,
    [a, b],
    [],
    [],
    [b, a],
    undefined,
    false,
    undefined,
    scene,
  );
  expect(first.validatedOrdered.map((entry) => entry.meshSlot)).toEqual([0, 1]);
  expect(first.shadowValidatedOrdered.map((entry) => entry.meshSlot)).toEqual([1, 0]);
  const next = buildDispatchPlan(internals, [b], [], [], [a], undefined, false, undefined, scene);
  expect(next.validatedOrdered[0]?.meshSlot).toBe(1);
  expect(next.shadowValidatedOrdered[0]?.meshSlot).toBe(0);
});

it('addresses only actual native children and reuses capacity while streaming across a large source', () => {
  const scene = new RenderScene();
  const root = receiptRow().source;
  scene.rebuild([root]);
  const child = (key: string) => ({ ...root, nativeDraw: { key } });
  const permanent = child('kept');
  scene.beginMeshDrawFrame([permanent]);
  const stable = scene.meshDrawSlot(permanent);
  for (let index = 0; index < 100; index++) {
    const next = child(`cell:${index * 1_000_000}`);
    scene.beginMeshDrawFrame([next, permanent]);
    expect(scene.meshDrawSlot(permanent)).toBe(stable);
    expect(scene.meshDrawSlot(next)).not.toBe(stable);
    expect(scene.meshDrawSlot(next)).toBe(scene.meshDrawSlot(next));
    expect(scene.meshDrawCapacity).toBe(2);
  }
  scene.apply([{ kind: 'remove', worldId: root.worldId, entityKey: root.entityKey }]);
  scene.apply([
    { kind: 'update', worldId: root.worldId, entityKey: root.entityKey, snapshot: root },
  ]);
  expect(scene.meshDrawSlot(root)).toBe(0);
});
