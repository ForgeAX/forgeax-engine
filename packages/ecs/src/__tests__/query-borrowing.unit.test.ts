import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { QueryIterationActiveError } from '../errors';
import { World } from '../world';
import { worldInternal } from '../world-internal';

describe('query-span-column-window', () => {
  it('keeps managed readers distinct from numeric, buffer and shared-array windows', () => {
    const Fields = defineComponent('SpanFamilyWindows', {
      text: 'string',
      unique: 'unique<Resource>',
      shared: 'shared<Resource>',
      asset: 'asset<mesh>',
      assets: 'array<asset<mesh>>',
      fixedAssets: 'array<asset<mesh>, 2>',
      numbers: 'array<f32>',
      fixedNumbers: 'array<f32, 2>',
      sharedValues: 'array<shared<Resource>>',
      fixedShared: 'array<shared<Resource>, 2>',
      bytes: 'array<u8>',
      fixedBytes: 'array<u8, 2>',
    });
    const world = new World();
    const entity = world.spawn({ component: Fields, data: {} }).unwrap();
    const query = world.query({ read: [Fields] }).unwrap();
    function read() {
      const span = [...query.spans().unwrap()][0];
      if (span === undefined) throw Error('missing family span');
      return span.get(Fields);
    }
    const first = read();
    for (const name of ['text', 'unique', 'shared', 'asset', 'assets', 'fixedAssets'] as const) {
      expect(Object.isFrozen(first[name])).toBe(true);
      expect(Object.keys(first[name])).toEqual(['length', 'get', '__managed']);
      expect(first[name].__managed).toBe(Fields.fields[name]?.type);
      expect(Number.isInteger(first[name].get(0))).toBe(true);
      expect(read()[name]).toBe(first[name]);
    }
    for (const name of [
      'numbers',
      'fixedNumbers',
      'sharedValues',
      'fixedShared',
      'bytes',
      'fixedBytes',
    ] as const) {
      expect(ArrayBuffer.isView(first[name])).toBe(true);
      expect(first[name]).not.toHaveProperty('__managed');
      expect(read()[name]).toBe(first[name]);
    }
    const originalTextHandle = first.text.get(0);
    world.set(entity, Fields, { text: 'replacement', numbers: [1, 2] }).unwrap();
    expect(read().text).toBe(first.text);
    expect(read().text.get(0)).not.toBe(originalTextHandle);
    expect(world.get(entity, Fields).unwrap().text).toBe('replacement');
    expect([...world.get(entity, Fields).unwrap().numbers]).toEqual([1, 2]);
  });
  const Values = defineComponent('SpanWindowValues', { scalar: 'f32', vector: 'array<f32, 3>' });
  const Caption = defineComponent('SpanWindowCaption', { text: 'string' });

  function fixture(count = 1) {
    const world = new World();
    const spawn = (scalar: number) =>
      world
        .spawn(
          { component: Values, data: { scalar, vector: [1, 2, 3] } },
          { component: Caption, data: { text: 'owned column' } },
        )
        .unwrap();
    const entities = Array.from({ length: count }, (_, i) => spawn(i));
    const query = world.query({ read: [Values, Caption] }).unwrap();
    const read = () => {
      const span = [...query.spans().unwrap()][0];
      if (span === undefined) throw Error('missing span');
      return { values: span.get(Values), caption: span.get(Caption), entities: span.entities };
    };
    return { world, query, spawn, entities, read };
  }

  it('keeps fresh shape carriers and shares only the actual equal physical windows', () => {
    const f = fixture(3);
    const first = f.read();
    const second = f.read();
    expect(second.values).not.toBe(first.values);
    expect(second.values.scalar).toBe(first.values.scalar);
    expect(second.values.vector).toBe(first.values.vector);
    expect(second.caption.text).toBe(first.caption.text);
    expect(second.entities).toBe(first.entities);
    const detachedGet = first.caption.text.get;
    expect(detachedGet(0)).toBe(first.caption.text.get(0));
    expect(Object.keys(first.caption.text)).toEqual(['length', 'get', '__managed']);
    expect(Object.isFrozen(first.caption.text)).toBe(true);
    const writer = f.world.query({ write: [Values] }).unwrap();
    for (const span of writer.spans().unwrap()) {
      const shape = span.mut(Values);
      shape.scalar = new Float32Array([999]);
    }
    expect(f.read().values.scalar[0]).toBe(0);
    expect(f.world.get(f.entities[0] as never, Values).unwrap().scalar).toBe(0);
  });

  it('replaces windows on size/backing changes without retargeting a held reader', () => {
    const f = fixture();
    const first = f.read();
    f.spawn(5);
    const second = f.read();
    expect(first.caption.text.length).toBe(1);
    expect(second.caption.text.length).toBe(2);
    expect(second.values.vector.length).toBe(6);
    expect(second.values.vector).not.toBe(first.values.vector);
    const oldBacking = second.values.vector.buffer;
    for (let i = 0; i < 200; i++) f.spawn(i + 10);
    const grown = f.read();
    expect(grown.values.vector.buffer).not.toBe(oldBacking);
    expect(grown.values.vector.length).toBe(202 * 3);
    expect(grown.values.scalar[201]).toBe(209);
    expect(grown.caption.text.length).toBe(202);
  });

  it('does not let sparse changed spans displace the full-table preparation', () => {
    const f = fixture(8);
    const first = f.read();
    const changed = f.world.query({ read: [Values], changed: [Values] }).unwrap();
    Array.from(changed.spans().unwrap());
    f.world.set(f.entities[4] as never, Values, { scalar: 27 }).unwrap();
    const selected = [...changed.spans().unwrap()];
    expect(selected).toHaveLength(1);
    expect(selected[0]?.get(Values).scalar[0]).toBe(27);
    expect(selected[0]?.entities[0]).toBe(f.entities[4]);
    expect(f.read().values.scalar).toBe(first.values.scalar);
    expect(f.read().entities).toBe(first.entities);
  });

  it('keeps declared field order, inline lanes and array locations in each fresh shape', () => {
    const Fields = defineComponent('SpanDeclaredColumnVocabulary', {
      scalar: 'f32',
      dynamic: 'array<f32>',
      fixed: 'array<u16, 2>',
      data: 'array<u8, 4>',
      text: 'string',
    });
    const world = new World();
    const entity = world
      .spawn({
        component: Fields,
        data: {
          scalar: 7,
          dynamic: new Float32Array([2, 3, 5]),
          fixed: new Uint16Array([11, 13]),
          data: new Uint8Array([1, 2, 3, 4]),
          text: 'kept',
        },
      })
      .unwrap();
    const query = world.query({ read: [Fields] }).unwrap();
    for (const span of query.spans().unwrap()) {
      const first = span.get(Fields),
        second = span.get(Fields);
      expect(first).not.toBe(second);
      expect(Object.keys(first)).toEqual(['scalar', 'dynamic', 'fixed', 'data', 'text']);
      expect(Array.from(first.fixed)).toEqual([11, 13]);
      expect(Array.from(first.data)).toEqual([1, 2, 3, 4]);
      expect(first.dynamic).toBe(second.dynamic);
      expect(first.text.get(0)).toBe(second.text.get(0));
      // An array field's window is its `[block, byteOffset, count]` location.
      const location = first.dynamic as unknown as Uint32Array;
      expect(location).toBeInstanceOf(Uint32Array);
      expect(location[2]).toBe(3);
      world.set(entity, Fields, { dynamic: new Float32Array([17]) }).unwrap();
      expect(location[2]).toBe(1);
      expect(first.scalar[0]).toBe(7);
    }
  });
});

describe('query-span-iterator-lifetime', () => {
  const Value = defineComponent('SpanIteratorLifetimeValue', { x: 'f32' });
  const Other = defineComponent('SpanIteratorLifetimeOther', { y: 'f32' });

  it('keeps detached span callbacks once-only across later traversals', () => {
    const world = new World();
    const entity = world.spawn({ component: Value, data: { x: 1 } }).unwrap();
    const query = world.query({ read: [Value], changed: [Value] }).unwrap();
    const iterable = query.spans().unwrap();
    const first = iterable[Symbol.iterator]();
    const next = first.next;
    const close = first.return;
    if (close === undefined) throw new Error('Missing span close');
    expect(first.next).toBe(next);
    expect(first.return).toBe(close);
    const held = next();
    if (held.done) throw new Error('Missing initial span');
    close();
    // A partial traversal must not advance the changed observation.
    const current = iterable[Symbol.iterator]();
    expect(() => iterable[Symbol.iterator]()).toThrow(QueryIterationActiveError);
    close();
    expect(next().done).toBe(true);
    expect(() => iterable[Symbol.iterator]()).toThrow(QueryIterationActiveError);
    const step = current.next();
    expect(step.done).toBe(false);
    expect(step).not.toBe(held);
    expect(step.value).not.toBe(held.value);
    expect(current.next().done).toBe(true);
    expect(held.done).toBe(false);
    expect(Array.from(held.value.entities)).toEqual([entity]);
    expect(Array.from(iterable)).toHaveLength(0);
    world.set(entity, Value, { x: 2 }).unwrap();
    expect(Array.from(iterable)).toHaveLength(1);
  });

  it('closes invalidated span callbacks without affecting their replacement', () => {
    const world = new World();
    world.spawn({ component: Value, data: { x: 1 } }).unwrap();
    const iterable = world
      .query({ read: [Value] })
      .unwrap()
      .spans()
      .unwrap();
    const stale = iterable[Symbol.iterator]();
    const next = stale.next;
    const close = stale.return;
    world.spawn({ component: Other, data: { y: 1 } }).unwrap();
    expect(next).toThrow(expect.objectContaining({ code: 'query-iteration-invalidated' }));
    const current = iterable[Symbol.iterator]();
    close?.();
    expect(next().done).toBe(true);
    expect(current.next().done).toBe(false);
    expect(current.next().done).toBe(true);
  });
});

describe('borrowed-array-view', () => {
  const Pose = defineComponent('BorrowedPose', { value: 'array<f32, 3>' });
  const Tag = defineComponent('BorrowedPoseTag', {});

  describe('internal borrowed inline array views', () => {
    it('aliases the same byte window without retaining a per-row wrapper', () => {
      const world = new World();
      const entity = world.spawn({ component: Pose, data: { value: [1, 2, 3] } }).unwrap();
      const read = () => world[worldInternal].getArrayView(entity, Pose, 'value') as Float32Array;
      const initial = read();
      const again = read();
      expect(again).not.toBe(initial);
      expect(again.buffer).toBe(initial.buffer);
      expect(again.byteOffset).toBe(initial.byteOffset);
      world.set(entity, Pose, { value: [4, 5, 6] }).unwrap();
      expect(Array.from(read() ?? [])).toEqual([4, 5, 6]);
      expect(world.get(entity, Pose).unwrap().value).not.toBe(
        world.get(entity, Pose).unwrap().value,
      );
    });

    it('resolves new storage after growth, migration and swap removal', () => {
      const world = new World();
      const first = world.spawn({ component: Pose, data: { value: [1, 2, 3] } }).unwrap();
      const initial = world[worldInternal].getArrayView(first, Pose, 'value');
      for (let i = 0; i < 600; i++)
        world.spawn({ component: Pose, data: { value: [i, i + 1, i + 2] } }).unwrap();
      const last = world.spawn({ component: Pose, data: { value: [7, 8, 9] } }).unwrap();
      expect(world[worldInternal].getArrayView(first, Pose, 'value') === initial).toBe(false);
      expect(Array.from(world[worldInternal].getArrayView(first, Pose, 'value') ?? [])).toEqual([
        1, 2, 3,
      ]);
      world[worldInternal].getArrayView(last, Pose, 'value');
      world.addComponent(first, { component: Tag, data: {} }).unwrap();
      expect(Array.from(world[worldInternal].getArrayView(first, Pose, 'value') ?? [])).toEqual([
        1, 2, 3,
      ]);
      expect(Array.from(world[worldInternal].getArrayView(last, Pose, 'value') ?? [])).toEqual([
        7, 8, 9,
      ]);
      world.despawn(first).unwrap();
      expect(world[worldInternal].getArrayView(first, Pose, 'value')).toBeUndefined();
      const replacement = world.spawn({ component: Pose, data: { value: [10, 11, 12] } }).unwrap();
      expect(
        Array.from(world[worldInternal].getArrayView(replacement, Pose, 'value') ?? []),
      ).toEqual([10, 11, 12]);
    });

    it('still reads variable arrays from their current pool slot and length', () => {
      const Dynamic = defineComponent('BorrowedDynamic', { value: 'array<u32>' });
      const world = new World();
      const entity = world.spawn({ component: Dynamic, data: { value: [1, 2] } }).unwrap();
      world[worldInternal].getArrayView(entity, Dynamic, 'value');
      world.set(entity, Dynamic, { value: [3, 4, 5, 6] }).unwrap();
      expect(Array.from(world[worldInternal].getArrayView(entity, Dynamic, 'value') ?? [])).toEqual(
        [3, 4, 5, 6],
      );
    });
  });
});
