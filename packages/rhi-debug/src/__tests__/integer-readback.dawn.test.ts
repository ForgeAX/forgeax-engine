import { it } from 'vitest';
import { verifyIntegerReadback } from './integer-readback.fixture';

it('preserves packed material and lighting context bits after GPU work on a fresh replay device', async () => {
  await verifyIntegerReadback();
  await verifyIntegerReadback('rg32uint');
});
