// Browser capture smoke for the sole learn-render transmission/refraction carrier.
// This gate requires an explicitly available headed display. A CI/headless
// checkout reports NOT-RUN before starting Vite; it never claims a GPU result.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const forcedHeaded = process.env.FORGEAX_BROWSER_HEADED;
const hasDisplay =
  process.platform === 'darwin' ||
  process.platform === 'win32' ||
  process.env.DISPLAY !== undefined ||
  process.env.WAYLAND_DISPLAY !== undefined;

if (forcedHeaded !== '1' && (process.env.CI === 'true' || !hasDisplay)) {
  console.log(
    '[learn-render 6.4 transmission-refraction] NOT-RUN: headed browser display is unavailable; set FORGEAX_BROWSER_HEADED=1 on a headed GPU host to run this gate.',
  );
  process.exit(0);
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-6-pbr-4-transmission-refraction',
  label: 'learn-render 6.4 transmission-refraction',
  mode: 'pixel',
  liveHook: '__captureTransmission',
  rtIdx: 0,
  warmupMs: 5000,
  appDir: dirname(here),
  assertCapture(report) {
    const renderPasses = report.events.filter((event) => event.kind === 'beginRenderPass');
    if (renderPasses.length === 0) throw new Error('capture has no render passes');
  },
});
