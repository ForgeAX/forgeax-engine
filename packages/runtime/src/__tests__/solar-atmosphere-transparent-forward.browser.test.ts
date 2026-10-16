import { it } from 'vitest';
import { verifyTransparentSolarComposition } from './solar-atmosphere-transparent.fixture';

it('keeps authored fog composed with a transparent foreground through forward TAA resize', async () => {
  await verifyTransparentSolarComposition('forward');
}, 240_000);
