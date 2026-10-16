import { resolve } from 'node:path';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';
const result = await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-9-ssao',
  label: 'SSAO dynamic OFF/ON',
  appDir: resolve(import.meta.dirname, '..'),
  mode: 'pixel',
  liveHook: '__captureSsao',
  capturePrepareHook: '__verifySsao',
  reportHook: '__ssaoEvidence',
});
console.log(JSON.stringify({ ssao: result.producerReport }));
