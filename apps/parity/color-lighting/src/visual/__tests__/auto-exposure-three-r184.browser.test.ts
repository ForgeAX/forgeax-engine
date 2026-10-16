import { it } from 'vitest';
import {
  autoExposureAc27ProducerIsScheduled,
  runAutoExposureThreeR184ProducerEntry,
} from '../auto-exposure-ac27-producer-entry';

const PRODUCER_TIMEOUT_MS = 120_000;

it.skipIf(!autoExposureAc27ProducerIsScheduled())(
  'runs the independent Three.js r184 AC-27 Browser WebGPU readback producer',
  () => {
    globalThis.__forgeaxAutoExposureAc27Publish = async (path, output) => {
      const url = import.meta.env.VITE_FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT_URL;
      if (url === undefined) {
        throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'AC-27 Browser artifact receiver URL is unavailable', path }));
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(output),
      });
      if (!response.ok) throw new Error(`AC-27 Browser artifact receiver rejected capture: ${response.status}`);
    };
    return runAutoExposureThreeR184ProducerEntry();
  },
  PRODUCER_TIMEOUT_MS,
);
