import { it } from 'vitest';
import { verifyFixedFieldTicks } from './force-fields-fixed-ticks.gpu-fixture';
import { prepareFixedFieldProgram } from './force-fields-fixed-ticks.server';

it('executes queued ticks with their own texture versions in one native submission', async () => {
  await verifyFixedFieldTicks(await prepareFixedFieldProgram());
}, 120_000);
