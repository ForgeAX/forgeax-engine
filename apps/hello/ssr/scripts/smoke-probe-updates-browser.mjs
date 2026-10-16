import { resolve } from 'node:path';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
process.env.VITE_REFLECTION_PROBE_EVIDENCE = '1';
const result = await verifyDemoCapture({
  pkg: '@forgeax/hello-ssr',
  label: 'Dynamic reflection probes',
  appDir: resolve(import.meta.dirname, '..'),
  mode: 'pixel',
  urlSuffix: '?fixture=probe-updates&resolution=512&aa=none',
  capturePrepareHook: '__verifyProbeUpdates',
  liveHook: '__readReflectionPixels',
  reportHook: '__probeUpdateEvidence',
});
console.log(`[probe-updates] ${JSON.stringify(result.producerReport)}`);
