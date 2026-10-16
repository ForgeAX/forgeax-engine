// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x deferred shading (8.deferred-shading). Delegates to the
// shared harness; supplies demo identity + live-pixel hook
// (window.__captureDeferred, installed by src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const requestedLights = process.env.FORGEAX_DEFERRED_LIGHTS;
if (requestedLights !== undefined && !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(requestedLights)) {
  throw new Error('FORGEAX_DEFERRED_LIGHTS must be an integer in [1, 128]');
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-8-deferred-shading',
  label: 'learn-render 5.8 deferred',
  mode: 'pixel',
  liveHook: '__captureDeferred',
  rtIdx: 0,
  ...(requestedLights !== undefined ? { urlSuffix: `?lights=${requestedLights}` } : {}),
  appDir: dirname(here),
  assertCapture(report) {
    const deferredPipelines = report.events.filter(
      (event) =>
        event.kind === 'createRenderPipeline' &&
        event.desc?.fragment?.entryPoint === 'fs_gbuffer',
    );
    if (deferredPipelines.length === 0) {
      throw new Error('no fs_gbuffer render pipeline was captured');
    }
    if (deferredPipelines.some((event) => event.desc.fragment.targets?.length !== 3)) {
      throw new Error('fs_gbuffer pipeline did not declare exactly 3 color targets');
    }
    const gBufferPass = report.events.find(
      (event) => event.kind === 'beginRenderPass' && event.colorAttachmentViewHandleIds?.length === 3,
    );
    if (gBufferPass === undefined) {
      throw new Error('no render pass with 3 G-Buffer color attachments was captured');
    }
  },
});
