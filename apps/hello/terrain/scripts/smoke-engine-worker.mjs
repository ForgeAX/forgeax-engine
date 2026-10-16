import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
const report = await verifyDemoCapture({
  pkg: '@forgeax/hello-terrain',
  label: 'hello-terrain-engine-worker',
  appDir: resolve(import.meta.dirname, '..'),
  mode: 'structural',
  urlSuffix: '?workers=engine',
  capturePrepareHook: '__prepareTerrainWorkerCapture',
  reportHook: '__terrainReport',
  navigationWaitUntil: 'domcontentloaded',
  hookReadyTimeoutMs: 300000,
});
writeFileSync(resolve(import.meta.dirname, '../.forgeax-debug', report.runId, 'report.json'), JSON.stringify(report, null, 2));
