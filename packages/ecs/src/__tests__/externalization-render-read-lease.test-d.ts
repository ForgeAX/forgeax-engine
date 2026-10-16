import { expectTypeOf } from 'vitest';
import { defineComponent } from '../component';
import {
  createRenderReadLease,
  type RenderChangeBatch,
  type RenderProjectionRequest,
} from '../projection/index';
import { World } from '../world';

const Position = defineComponent('RenderReadTypePosition', { x: 'f32' });
const world = new World();
const lease = createRenderReadLease(world);
const request: RenderProjectionRequest = {
  components: [{ component: Position, fields: ['x'] }],
};
const batch = lease.readChanges(lease.captureVersion());
const projection = lease.querySpans(request);

expectTypeOf(lease.worldIdentity).toEqualTypeOf<string>();
expectTypeOf(lease.generation).toBeNumber();
expectTypeOf(batch).toMatchTypeOf<RenderChangeBatch>();
expectTypeOf(projection.generation).toBeNumber();
expectTypeOf<NonNullable<(typeof projection.spans)[number]['fields']['x']>>().toMatchTypeOf<
  ArrayLike<number>
>();

// @ts-expect-error RenderReadLease does not expose storage internals.
lease._getArrayView;
// @ts-expect-error a renderer projection is not a public lease.
projection.readChanges;
