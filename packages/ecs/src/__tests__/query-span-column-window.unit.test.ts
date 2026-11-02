import { expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

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
