import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';
import { waitForLearnRenderTestBootstrap } from '../../../../../shared/src/learn-render-test-lifecycle';
import type { App } from '@forgeax/engine-app';
import { verifySsaoWithoutLocalLights } from './ssao-no-local-oracle';

onerrorGate('learn-render 5.9 ssao', async () => {
  await import('../main.ts');
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  if (!canvas) throw new Error('SSAO test canvas is missing');
  await waitForLearnRenderTestBootstrap(canvas, 80_000);
  const scope = globalThis as typeof globalThis & {
    __forgeaxLearnRenderTestLifecycle: { app: App };
    __captureSsao: () => Promise<Uint8Array>;
  };
  const failures: unknown[] = [];
  for (const algorithm of ['ssao', 'gtao'] as const) {
    try {
      const evidence = await verifySsaoWithoutLocalLights(scope.__forgeaxLearnRenderTestLifecycle.app, scope.__captureSsao, algorithm);
      console.log('AO without local lights', { algorithm, changed: evidence.changed, meanChangedRgbDelta: evidence.meanChangedRgbDelta, restoredChanges: evidence.restoredChanges });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'AO without local lights failed');
}, 90_000);
