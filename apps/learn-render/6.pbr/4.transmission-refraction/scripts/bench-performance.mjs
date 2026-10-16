import { numMipLevels } from '@forgeax/engine-assets-runtime';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const hasDisplay =
  process.platform === 'darwin' ||
  process.platform === 'win32' ||
  process.env.DISPLAY !== undefined ||
  process.env.WAYLAND_DISPLAY !== undefined;
if (!hasDisplay && process.env.FORGEAX_BROWSER_HEADED !== '1') {
  console.log(JSON.stringify({
    executionPath: 'headed-browser:carrier',
    verdict: 'not-run',
    confidence: 'not-run',
    reason: 'headed browser display is unavailable',
  }, null, 2));
  process.exit(0);
}

const smoke = resolve(import.meta.dirname, 'smoke-browser.mjs');
const run = spawnSync(process.execPath, [smoke], {
  cwd: resolve(import.meta.dirname, '../../../..'),
  encoding: 'utf8',
  env: { ...process.env, FORGEAX_BROWSER_HEADED: '1' },
});
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
if (run.status !== 0) process.exit(run.status ?? 1);
const match = (run.stdout ?? '').match(/performance receipt: (\{.*\})/);
if (match === null) {
  console.log(JSON.stringify({
    executionPath: 'headed-browser:carrier',
    verdict: 'not-run',
    confidence: 'not-run',
    reason: 'browser smoke produced no completed-frame receipt',
  }, null, 2));
  process.exit(0);
}
const browser = JSON.parse(match[1]);
const completedFrames = Number(browser.submittedFrames ?? 0);
const preparationMs = Number(browser.preparationMs ?? Number.NaN);
const inspection = browser.transmissionInspection?.transmission;
if (inspection === null || typeof inspection !== 'object') {
  throw new Error('browser smoke did not publish renderer.inspect().transmission');
}
const extent = inspection.extent;
const fullChainUpperBound = (32 * extent.width * extent.height) / 3;
const bytes = Number(inspection.bytes);
const receipt = {
  executionPath: 'headed-browser:carrier',
  adapter: 'browser-webgpu',
  configuration: {
    lane: 'standard-forward',
    resolution: extent,
    format: inspection.format,
    msaa: 1,
    quality: inspection.needsRoughMips ? 'full-mip-chain' : 'level-zero',
    submittedFrames: completedFrames,
    completedFrames,
  },
  observed: {
    preparationMs,
    framesPerSecond: preparationMs > 0 ? completedFrames / (preparationMs / 1000) : 0,
    transmissionInspection: inspection,
    fullChainUpperBound,
    bytesWithinDerivedBound: bytes <= fullChainUpperBound,
  },
  verdict: completedFrames >= 60 && Number.isFinite(preparationMs) && bytes >= 0 && bytes <= fullChainUpperBound ? 'pass' : 'fail',
  confidence: 'measured-browser',
};
if (receipt.verdict !== 'pass') throw new Error(JSON.stringify(receipt));
console.log(JSON.stringify(receipt, null, 2));
