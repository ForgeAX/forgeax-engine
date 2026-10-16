import { resolve } from 'node:path';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
const result = await verifyDemoCapture({
  pkg: '@forgeax/hello-ssr',
  label: 'Atmosphere and SSAO reflection probes',
  appDir: resolve(import.meta.dirname, '..'),
  mode: 'pixel',
  urlSuffix: '?fixture=cube&resolution=512&aa=none&timings',
  capturePrepareHook: '__verifyProbeAtmosphere',
  liveHook: '__readReflectionPixels',
  reportHook: '__probeAtmosphereEvidence',
});
console.log(`[probe-atmosphere] ${JSON.stringify(result.producerReport)}`);
