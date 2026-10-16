import { it } from 'vitest';
import { verifyTransparentSolarComposition } from './solar-atmosphere-transparent.fixture';

it('keeps authored fog composed with a transparent foreground through deferred TAA resize', async () => {
  await verifyTransparentSolarComposition('deferred');
}, 240_000);
