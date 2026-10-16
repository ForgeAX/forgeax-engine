import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import type { Query, QueryDescriptor, QueryRow, QuerySpan } from '../query/query';
import { World } from '../world';

const Position = defineComponent('QueryTypePosition', { x: 'f32', y: 'f32' });
const Velocity = defineComponent('QueryTypeVelocity', { x: 'f32' });

describe('Query public type inference', () => {
  it('infers row read, write, and optional roles', () => {
    const world = new World();
    const query = world.query({ read: [Velocity], write: [Position] }).unwrap();
    expectTypeOf(query).toMatchTypeOf<
      Query<readonly [typeof Velocity], readonly [typeof Position], readonly []>
    >();
  });

  it('projects scalar row and column shapes', () => {
    const row = null as unknown as QueryRow<
      readonly [typeof Velocity],
      readonly [typeof Position],
      readonly []
    >;
    const span = null as unknown as QuerySpan<
      readonly [typeof Velocity],
      readonly [typeof Position]
    >;
    expectTypeOf(row.get(Velocity).x).toBeNumber();
    expectTypeOf(row.mut(Position).x).toBeNumber();
    expectTypeOf(span.get(Velocity).x).toEqualTypeOf<Float32Array>();
    expectTypeOf(span.mut(Position).x).toEqualTypeOf<Float32Array>();
  });

  it('keeps descriptor access tuples literal', () => {
    const descriptor = { read: [Position], write: [Velocity] } satisfies QueryDescriptor;
    expectTypeOf(descriptor.read).toEqualTypeOf<(typeof Position)[]>();
  });
});
