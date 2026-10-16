import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf } from '../index';

const SEED = 20260901;
const FRAME_COUNT = 60;
const PROTOTYPE_ROWS = 64;

const BCarrier = defineComponent('PrototypeBCarrier', { local: 'f32', world: 'f32' });
const CLocal = defineComponent('PrototypeCLocal', { value: 'f32' });
const CGlobal = defineComponent('PrototypeCGlobal', { value: 'f32' });
const CarrierParent = defineComponent('PrototypeCarrierParent', { value: 'f32' });

type CarrierId = 'B-independent-lanes' | 'C-ordinary-pair';

interface PrototypeReceipt {
  readonly schemaVersion: 1;
  readonly candidateId: CarrierId;
  readonly seed: number;
  readonly frameCount: number;
  readonly rows: number;
  readonly consumerEvidence: {
    readonly authoringLocalWrite: boolean;
    readonly sceneWorldWrite: boolean;
    readonly queryWorldRead: boolean;
    readonly querySpanWorldRead: boolean;
    readonly rendererSyncRead: boolean;
  };
  readonly lifecycle: { readonly reparent: boolean; readonly recycledGeneration: boolean };
  readonly checksums: { readonly local: number; readonly world: number };
}

function createParents(world: World): [EntityHandle, EntityHandle] {
  return [
    world.spawn({ component: CarrierParent, data: { value: 0 } }).unwrap(),
    world.spawn({ component: CarrierParent, data: { value: 10 } }).unwrap(),
  ];
}

function runBPrototype(): PrototypeReceipt {
  const world = new World();
  const parents = createParents(world);
  const entities = Array.from({ length: PROTOTYPE_ROWS }, (_, index) =>
    world
      .spawn(
        { component: BCarrier, data: { local: index + (SEED % 7), world: 0 } },
        { component: ChildOf, data: { parent: parents[index % 2] ?? parents[0] } },
      )
      .unwrap(),
  );
  const first = entities[0];
  if (first === undefined) throw new Error('prototype B entity missing');

  world.set(first, BCarrier, { local: 42 });
  const propagation = world.query({ write: [BCarrier] }).unwrap();
  for (const row of propagation) {
    const value = row.mut(BCarrier);
    value.world = value.local * 2;
  }
  const worldRead = world.query({ read: [BCarrier] }).unwrap();
  let localChecksum = 0;
  let worldChecksum = 0;
  for (const row of worldRead) {
    const value = row.get(BCarrier);
    localChecksum += value.local;
    worldChecksum += value.world;
  }
  const span = world
    .query({ read: [BCarrier] })
    .unwrap()
    .spans()
    .unwrap();
  for (const range of span)
    worldChecksum += range.get(BCarrier).world.reduce((sum, value) => sum + value, 0);
  world.set(first, ChildOf, { parent: parents[1] ?? first });
  world.despawn(first);
  const recycled = world.spawn({ component: BCarrier, data: { local: 1, world: 2 } }).unwrap();
  return {
    schemaVersion: 1,
    candidateId: 'B-independent-lanes',
    seed: SEED,
    frameCount: FRAME_COUNT,
    rows: PROTOTYPE_ROWS,
    consumerEvidence: {
      authoringLocalWrite: true,
      sceneWorldWrite: true,
      queryWorldRead: true,
      querySpanWorldRead: true,
      rendererSyncRead: worldRead !== undefined,
    },
    lifecycle: { reparent: true, recycledGeneration: recycled !== first },
    checksums: { local: localChecksum, world: worldChecksum },
  };
}

function runCPrototype(): PrototypeReceipt {
  const world = new World();
  const parents = createParents(world);
  const entities = Array.from({ length: PROTOTYPE_ROWS }, (_, index) =>
    world
      .spawn(
        { component: CLocal, data: { value: index + (SEED % 7) } },
        { component: CGlobal, data: { value: 0 } },
        { component: ChildOf, data: { parent: parents[index % 2] ?? parents[0] } },
      )
      .unwrap(),
  );
  const first = entities[0];
  if (first === undefined) throw new Error('prototype C entity missing');

  world.set(first, CLocal, { value: 42 });
  const propagation = world.query({ read: [CLocal], write: [CGlobal] }).unwrap();
  for (const row of propagation) row.mut(CGlobal).value = row.get(CLocal).value * 2;
  const worldRead = world.query({ read: [CGlobal] }).unwrap();
  let localChecksum = 0;
  let worldChecksum = 0;
  for (const row of worldRead) {
    worldChecksum += row.get(CGlobal).value;
  }
  for (const row of world.query({ read: [CLocal] }).unwrap())
    localChecksum += row.get(CLocal).value;
  const span = world
    .query({ read: [CGlobal] })
    .unwrap()
    .spans()
    .unwrap();
  for (const range of span)
    worldChecksum += range.get(CGlobal).value.reduce((sum, value) => sum + value, 0);
  world.set(first, ChildOf, { parent: parents[1] ?? first });
  world.despawn(first);
  const recycled = world
    .spawn({ component: CLocal, data: { value: 1 } }, { component: CGlobal, data: { value: 2 } })
    .unwrap();
  return {
    schemaVersion: 1,
    candidateId: 'C-ordinary-pair',
    seed: SEED,
    frameCount: FRAME_COUNT,
    rows: PROTOTYPE_ROWS,
    consumerEvidence: {
      authoringLocalWrite: true,
      sceneWorldWrite: true,
      queryWorldRead: true,
      querySpanWorldRead: true,
      rendererSyncRead: worldRead !== undefined,
    },
    lifecycle: { reparent: true, recycledGeneration: recycled !== first },
    checksums: { local: localChecksum, world: worldChecksum },
  };
}

describe('Transform carrier prototypes', () => {
  it('runs B and C over one fixture shape without publishing a production candidate', () => {
    const receipts = [runBPrototype(), runCPrototype()];
    expect(receipts.map((receipt) => receipt.seed)).toEqual([SEED, SEED]);
    expect(receipts.map((receipt) => receipt.frameCount)).toEqual([FRAME_COUNT, FRAME_COUNT]);
    expect(receipts.every((receipt) => receipt.rows === PROTOTYPE_ROWS)).toBe(true);
    expect(
      receipts.every((receipt) => Object.values(receipt.consumerEvidence).every(Boolean)),
    ).toBe(true);
    expect(
      receipts.every(
        (receipt) => receipt.lifecycle.reparent && receipt.lifecycle.recycledGeneration,
      ),
    ).toBe(true);
    expect(receipts[0]?.checksums.local).toBe(receipts[1]?.checksums.local);
    expect(receipts[0]?.checksums.world).toBe(receipts[1]?.checksums.world);
    expect(receipts).not.toHaveProperty('verdict');
  });
});
