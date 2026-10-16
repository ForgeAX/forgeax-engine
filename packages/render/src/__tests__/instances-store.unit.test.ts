import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { InstanceProjectionStore, validateInstanceTransforms } from '../instances';
import { packInstanceStorageBuffer } from '../record/mesh-ssbo';

function matrices(x: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
}

function projected<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw value;
  return value as Exclude<T, Error>;
}

function project(
  store: InstanceProjectionStore,
  world: World,
  entity: number,
  transforms: Float32Array,
) {
  const snapshot = projected(store.project(world, entity, transforms));
  store.accept(world, entity, snapshot);
  return snapshot;
}

describe('renderer instance projection', () => {
  it('derives independent complete snapshots for consumers that skip different updates', () => {
    const world = new World();
    const first = new InstanceProjectionStore();
    const late = new InstanceProjectionStore();
    const before = project(first, world, 1, matrices(0));
    project(late, world, 1, matrices(0));
    project(first, world, 1, matrices(1));
    // The retained revision stays intact while its successor is in flight;
    // the store recycles it two revisions later (RenderScene treats a lag
    // beyond one revision as a temporal cut).
    expect(before.transforms[12]).toBe(0);
    project(first, world, 1, matrices(2));
    const latest = project(late, world, 1, matrices(2));
    expect(latest.transforms[12]).toBe(2);
    const stable = project(late, world, 1, matrices(2));
    expect(stable.transforms).toBe(latest.transforms);
    expect(stable.revision).toBe(latest.revision);
  });

  it('ping-pongs two owned buffers when a whole column changes every frame', () => {
    const world = new World();
    const store = new InstanceProjectionStore();
    const a = project(store, world, 1, matrices(1));
    const b = project(store, world, 1, matrices(2));
    expect(b.transforms).not.toBe(a.transforms);
    expect(a.transforms[12]).toBe(1);
    const c = project(store, world, 1, matrices(3));
    const d = project(store, world, 1, matrices(4));
    expect(c.transforms).toBe(a.transforms);
    expect(d.transforms).toBe(b.transforms);
    expect(c.transforms[12]).toBe(3);
    expect(d.transforms[12]).toBe(4);
    expect(d.revision).toBe(4);
    expect(d.generations).toBe(a.generations);
    // A caller-owned accepted buffer never becomes writable back storage.
    const caller = matrices(5);
    store.accept(world, 1, { ...d, transforms: caller, revision: 5 });
    const e = projected(store.project(world, 1, matrices(6)));
    expect(e.transforms).not.toBe(caller);
    store.accept(world, 1, e);
    const f = project(store, world, 1, matrices(7));
    expect(f.transforms).not.toBe(caller);
    expect(caller[12]).toBe(5);
    // An unaccepted candidate is overwritten by the next projection, never the front.
    const front = project(store, world, 1, matrices(8));
    projected(store.project(world, 1, matrices(9)));
    const g = project(store, world, 1, matrices(10));
    expect(front.transforms[12]).toBe(8);
    expect(g.transforms[12]).toBe(10);
    expect(g.transforms).not.toBe(front.transforms);
  });

  it('does not alias identical entity numbers across World identities', () => {
    const projection = new InstanceProjectionStore();
    const a = project(projection, new World(), 1, matrices(10));
    const b = project(projection, new World(), 1, matrices(99));
    expect(a.collectionId).not.toBe(b.collectionId);
    expect(a.transforms[12]).toBe(10);
    expect(b.transforms[12]).toBe(99);
  });

  it('rebuilds from unchanged source after dropping renderer resources', () => {
    const world = new World();
    const transforms = matrices(4);
    const projection = new InstanceProjectionStore();
    project(projection, world, 1, transforms);
    projection.dispose();
    expect(project(projection, world, 1, transforms).transforms).toEqual(transforms);
    expect(
      projected(new InstanceProjectionStore().project(world, 1, transforms)).transforms,
    ).toEqual(transforms);
  });

  it('retains pose identity and last submitted matrices while reseeding resized topology', () => {
    const world = new World();
    const projection = new InstanceProjectionStore();
    const before = project(projection, world, 1, matrices(2));
    const moved = project(projection, world, 1, matrices(9));
    expect(moved.generations).toEqual(before.generations);
    const payload = packInstanceStorageBuffer(
      moved.transforms,
      before.transforms,
      moved.generations,
      before.generations,
    );
    expect(payload[12]).toBe(9);
    expect(payload[16 + 12]).toBe(2);
    const resized = project(
      projection,
      world,
      1,
      new Float32Array([...matrices(3), ...matrices(4)]),
    );
    expect(resized.generations[0]).not.toBe(moved.generations[0]);
    expect(before.transforms[12]).toBe(2);
  });

  it('releases removed identities and never aliases a replacement to retained temporal data', () => {
    const world = new World();
    const projection = new InstanceProjectionStore();
    const a = project(projection, world, 1, matrices(1));
    const b = project(projection, world, 2, matrices(2));
    projection.retain(new Set([b.collectionId]));
    expect(projection._inspections(0).map((value) => value.collectionId)).toEqual([b.collectionId]);
    const replacement = project(projection, world, 1, matrices(3));
    expect(replacement.collectionId).not.toBe(a.collectionId);
    projection.release(world, 1);
    projection.release(world, 1);
    expect(projection._inspections(0)).toHaveLength(1);
  });

  it('reports only current-frame uploads and drops old device residency on recovery', () => {
    const projection = new InstanceProjectionStore();
    const value = project(projection, new World(), 1, matrices(2));
    projection._reportResidency({
      collectionId: value.collectionId,
      frameNumber: 1,
      residentGeneration: 3,
      lane: 'direct-storage',
      uploadRanges: [{ start: 0, end: 1 }],
      uploadedBytes: 128,
      requestedBytes: 128,
      supportedBytes: 1024,
      backend: 'webgpu',
    });
    expect(projection._inspections(1)[0]?.uploadedBytes).toBe(128);
    expect(projection._inspections(2)[0]?.uploadedBytes).toBe(0);
    expect(projection._inspections(2)[0]?.uploadRanges).toEqual([]);
    projection._resetResidency();
    expect(projection._inspections(2)[0]).toMatchObject({ lane: 'unresident', revision: 1 });
  });

  it('rejects incomplete and non-finite matrices before they reach rendering', () => {
    expect(validateInstanceTransforms(new Float32Array(17))).toMatchObject({
      code: 'instance-transforms-stride-mismatch',
      detail: { actualLength: 17, expectedStride: 16 },
    });
    const invalid = matrices(0);
    invalid[12] = NaN;
    expect(validateInstanceTransforms(invalid)).toMatchObject({
      code: 'instance-transforms-invalid',
      detail: { actualLength: 16, nonFiniteIndex: 12 },
    });
    expect(validateInstanceTransforms(new Float32Array())).toBeUndefined();
  });
});
