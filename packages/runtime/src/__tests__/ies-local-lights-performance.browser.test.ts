import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { measureLocalIes } from './ies-local-lights-performance.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it.skipIf(import.meta.env.IES_PERF !== '1')(
  'measures Point/Rect IES with browser GPU timestamps',
  { timeout: 900_000, retry: 0 },
  async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error('missing performance adapter');
    for (const kind of ['point', 'rect'] as const)
      for (const count of [1, 32, 256]) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 512;
        document.body.append(canvas);
        const host = renderValue(await constructRuntimeRendererHost(canvas, { gpuPassTiming: {} }));
        try {
          const result = await measureLocalIes(host.renderer, kind, count);
          await commands.writeFile(
            `artifacts/ies-point-area/performance-browser/${kind}-${count}.json`,
            JSON.stringify({
              ...result,
              size: 512,
              adapter: {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
              },
              userAgent: navigator.userAgent,
            }),
          );
        } finally {
          renderValue(await host.renderer.dispose());
          canvas.remove();
        }
      }
  },
);
