import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { it } from 'vitest';
import {
  autoExposureForgeaxProducerIsScheduled,
  runAutoExposureForgeaxProducerEntry,
} from '../auto-exposure-forgeax-producer-entry';

const PRODUCER_TIMEOUT_MS = 120_000;

it.skipIf(!autoExposureForgeaxProducerIsScheduled())(
  'runs the ForgeaX AC-27 Browser WebGPU readback producer',
  () => {
    globalThis.__forgeaxAutoExposureForgeaxPublish = async (path, output) => {
      const url = import.meta.env.VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT_URL;
      if (url === undefined) {
        throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'ForgeaX AC-27 Browser artifact receiver URL is unavailable', path }));
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(output),
      });
      if (!response.ok) throw new Error(`ForgeaX AC-27 Browser artifact receiver rejected capture: ${response.status}`);
    };
    return runAutoExposureForgeaxProducerEntry(forgeaxBundlerAdapter());
  },
  PRODUCER_TIMEOUT_MS,
);
