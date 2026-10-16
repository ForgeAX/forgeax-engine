import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
const report = await verifyDemoCapture({
  pkg: '@forgeax/hello-terrain',
  label: 'hello-terrain',
  appDir: resolve(import.meta.dirname, '..'),
  mode: 'pixel',
  liveHook: '__readTerrainCapture',
  capturePrepareHook: '__prepareTerrainCapture',
  browserReplayHook: '__replayTerrainCapture',
  reportHook: '__terrainReport',
  pixelVerdictOwner: 'browser-fresh',
  epsilon: 0.05,
  coveredEpsilon: 0.05,
  maxChannelEpsilon: 0.05,
  navigationWaitUntil: 'domcontentloaded',
  hookReadyTimeoutMs: 300000,
  assertPixels({ pixels, width, height }) {
    let covered = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) covered++;
    assert(covered > width * height * 0.15, 'black or missing terrain is a fatal pixel falsifier');
  },
});
writeFileSync(resolve(import.meta.dirname, '../.forgeax-debug', report.runId, 'report.json'), JSON.stringify(report, null, 2));
