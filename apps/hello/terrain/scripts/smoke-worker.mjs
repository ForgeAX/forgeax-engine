import { resolve } from 'node:path';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
await verifyDemoCapture({
  pkg: '@forgeax/hello-terrain',
  label: 'hello-terrain-worker',
  appDir: resolve(import.meta.dirname, '..'),
  mode: 'structural',
  urlSuffix: '?workers=1',
  capturePrepareHook: '__prepareTerrainWorkerCapture',
  reportHook: '__terrainReport',
  navigationWaitUntil: 'domcontentloaded',
  hookReadyTimeoutMs: 300000,
});
