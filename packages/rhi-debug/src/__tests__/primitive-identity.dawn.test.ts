import { it } from 'vitest';
import { verifyPrimitiveIdentity } from './primitive-identity.fixture';

it('replays draw-local primitive and instance identity without losing integer bits', async (ctx) => {
  const result = await verifyPrimitiveIdentity();
  if (result.status === 'unavailable') ctx.skip(result.reason);
});
