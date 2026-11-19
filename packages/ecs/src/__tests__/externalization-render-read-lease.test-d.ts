import { expectTypeOf } from 'vitest';
import { createRenderReadLease, type RenderChangeBatch } from '../projection/index';
import { World } from '../world';

const world = new World();
const lease = createRenderReadLease(world);
const batch = lease.readChanges(lease.captureVersion());

expectTypeOf(lease.worldIdentity).toEqualTypeOf<string>();
expectTypeOf(lease.generation).toBeNumber();
expectTypeOf(batch).toMatchTypeOf<RenderChangeBatch>();

// @ts-expect-error RenderReadLease does not expose storage internals.
lease._getArrayView;
// @ts-expect-error Numeric spans belong to Query.
lease.querySpans;
