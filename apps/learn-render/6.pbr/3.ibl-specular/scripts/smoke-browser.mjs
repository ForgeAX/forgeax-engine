// smoke-browser.mjs -- RHI-debug capture verification for learn-render
// 6.pbr/3.ibl-specular (static IBL split-sum sphere matrix, Skylight equirect HDR).
//
// Pixel mode proves live->replay fidelity for the final target, but it does not
// prove split-sum algorithm truth: the Skylight irradiance/prefilter maps are
// rgba16float cubemaps and remain outside the frame-header seed path (roadmap
// specs §10 residual #1). Keep the longer warmup so the IBL precompute completes;
// intermediate cubemap and BRDF-LUT truth remains a separate F3/F5 gap.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function assertDiffuseIblPixels({ pixels, width, height }) {
  // Bottom-left sphere: roughness=0.9, metallic=0. It is intentionally almost
  // entirely diffuse, so it detects an irradiance payload that is divided by
  // PI twice without depending on the specular prefilter or BRDF LUT.
  const centerX = width * (114 / 512);
  const centerY = height * (396 / 512);
  const radius = Math.min(width, height) * (30 / 512);
  let luminance = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > radius ** 2) continue;
      const offset = (y * width + x) * 4;
      luminance += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 765;
      count += 1;
    }
  }
  const mean = count === 0 ? 0 : luminance / count;
  if (mean < 0.24) {
    throw new Error(
      `diffuse IBL sphere is too dark: mean=${mean.toFixed(5)} expected>=0.24 ` +
        `(the double-Lambert-divide regression measured 0.17400)`,
    );
  }
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-6-pbr-3-ibl-specular',
  label: 'learn-render 6.3 ibl-specular',
  mode: 'pixel',
  liveHook: '__captureIblSpecular',
  rtIdx: 0,
  warmupMs: 5000,
  appDir: dirname(here),
  assertPixels: assertDiffuseIblPixels,
});
