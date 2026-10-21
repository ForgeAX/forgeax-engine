import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyFixedFieldTicks } from './force-fields-fixed-ticks.gpu-fixture';
import type { prepareFixedFieldProgram } from './force-fields-fixed-ticks.server';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareFixedFieldProgram(): ReturnType<typeof prepareFixedFieldProgram>;
  }
}
it('executes queued ticks with their own texture versions in one native submission', async () => {
  await verifyFixedFieldTicks(await commands.prepareFixedFieldProgram());
}, 120_000);
