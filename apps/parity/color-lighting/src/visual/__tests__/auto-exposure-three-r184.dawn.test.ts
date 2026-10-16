import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import {
  autoExposureAc27ProducerIsScheduled,
  runAutoExposureThreeR184ProducerEntry,
} from '../auto-exposure-ac27-producer-entry';

const PRODUCER_TIMEOUT_MS = 120_000;

it.skipIf(!autoExposureAc27ProducerIsScheduled())(
  'runs the independent Three.js r184 AC-27 Dawn WebGPU readback producer',
  () => {
    globalThis.__forgeaxAutoExposureAc27Publish = (path, output) => {
      writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
    };
    return runAutoExposureThreeR184ProducerEntry();
  },
  PRODUCER_TIMEOUT_MS,
);
