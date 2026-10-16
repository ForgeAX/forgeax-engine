import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import type { Query } from '../query/query';
import { World } from '../world';

const Position = defineComponent('WorldQueryInferencePosition', { x: 'f32' });
const Velocity = defineComponent('WorldQueryInferenceVelocity', { x: 'f32' });

describe('World.query consumer inference', () => {
  it('preserves descriptor tuples through Result.unwrap', () => {
    const query = new World().query({ read: [Position], write: [Velocity] }).unwrap();
    expectTypeOf(query).toEqualTypeOf<
      Query<readonly [typeof Position], readonly [typeof Velocity], readonly []>
    >();
  });
});
