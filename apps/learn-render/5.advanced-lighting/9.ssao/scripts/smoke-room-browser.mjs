import { resolve } from 'node:path';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';
const result = await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-9-ssao',
  label: 'Room AO, soft shadows and dynamic occluders',
  appDir: resolve(import.meta.dirname, '..'),
  urlSuffix: '?scene=room',
  mode: 'pixel',
  liveHook: '__captureSsao',
  capturePrepareHook: '__verifySsao',
  reportHook: '__ssaoEvidence',
});
console.log(JSON.stringify({ room: result.producerReport }));
