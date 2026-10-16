import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { measureLocalIes } from './ies-local-lights-performance.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it.skipIf(process.env.IES_PERF !== '1')(
  'measures Point/Rect IES at 1, 32 and 256 lights',
  { timeout: 900_000, retry: 0 },
  async () => {
    const manifest = shaderManifestUrl(await buildEngineShaderManifest());
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error('missing performance adapter');
    const directory = 'artifacts/ies-point-area/performance-dawn';
    mkdirSync(directory, { recursive: true });
    for (const kind of ['point', 'rect'] as const)
      for (const count of [1, 32, 256]) {
        const target = offscreenCanvas(256);
        const host = renderValue(
          await constructRuntimeRendererHost(
            target.canvas,
            { gpuPassTiming: {} },
            { shaderManifestUrl: manifest },
          ),
        );
        try {
          const result = await measureLocalIes(host.renderer, kind, count);
          writeFileSync(
            `${directory}/${kind}-${count}.json`,
            JSON.stringify({
              ...result,
              size: 256,
              adapter: adapter.info,
              cpu: cpus()[0]?.model,
              platform: platform(),
            }),
          );
        } finally {
          renderValue(await host.renderer.dispose());
          target.destroy();
        }
      }
  },
);
