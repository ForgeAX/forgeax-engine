#!/usr/bin/env node
// apps/learn-render/6.pbr/2.ibl-irradiance/scripts/smoke-dawn.mjs
//
// Thin shim over apps/learn-render/6.pbr/_shared/ibl-smoke-shared.mjs.
// Verdict (60 frame + reference PNG mean abs delta <= 0.05; AC-12 + AC-18):
// the shared driver loads real newport_loft.hdr (CC BY-NC carve-out) via the
// declarative loadByGuid<EquirectAsset> + Skylight{equirect} path (the engine
// projects the cubemap + IBL internally), runs SMOKE_MIN_FRAMES draw calls,
// reads the final frame, and diffs against skylight-irradiance.ref.png.
// Bake the reference once via `pnpm bake:ibl-reference`.

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sharedPath = resolve(here, '..', '..', '_shared', 'ibl-smoke-shared.mjs');
const { runIblSmoke, warmUpng } = await import(pathToFileURL(sharedPath).href);

await warmUpng();
const framesObserved = await runIblSmoke({
  demoKind: 'irradiance',
  demoId: 'learn-render-ibl-irradiance',
  referencePath: resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    '..',
    'forgeax-engine-assets',
    'smoke-baselines',
    'learn-render-6-pbr-2-ibl-irradiance',
    'skylight-irradiance.ref.png',
  ),
  mode: 'verify',
  distDir: resolve(here, '..', 'dist'),
});
emitSmokeReceipt('app-learn-render-6-pbr-2-ibl-irradiance/smoke', framesObserved);
process.exit(0);
