import { writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it, onTestFinished } from 'vitest';
import {
  autoExposureForgeaxProducerIsScheduled,
  runAutoExposureForgeaxProducerEntry,
} from '../auto-exposure-forgeax-producer-entry';

const PRODUCER_TIMEOUT_MS = 120_000;

it.skipIf(!autoExposureForgeaxProducerIsScheduled())(
  'runs the ForgeaX AC-27 Dawn WebGPU readback producer',
  async () => {
    globalThis.__forgeaxAutoExposureForgeaxPublish = (path, output) => {
      writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
    };
    const manifest = await buildEngineShaderManifest();
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
    onTestFinished(() => URL.revokeObjectURL(url));
    return runAutoExposureForgeaxProducerEntry({ shaderManifestUrl: url });
  },
  PRODUCER_TIMEOUT_MS,
);
