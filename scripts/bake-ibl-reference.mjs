#!/usr/bin/env node
// scripts/bake-ibl-reference.mjs
//
// One-shot reference PNG regeneration for the IBL diffuse + specular
// smoke drivers. Invokes the shared dawn-node smoke driver
// (apps/learn-render/6.pbr/_shared/ibl-smoke-shared.mjs) in `bake` mode
// for both demos sequentially, writing:
//   apps/learn-render/6.pbr/2.ibl-irradiance/reference/skylight-irradiance.ref.png
//   apps/learn-render/6.pbr/3.ibl-specular/reference/skylight-specular.ref.png
//
// Idempotency: a second invocation with the same engine/dawn build + the
// same newport_loft.hdr vendor bytes produces a bytewise-identical PNG
// (UPNG encode is deterministic; the scene + draw order are fixed; the
// vendor HDR is committed under forgeax-engine-assets/learn-opengl/).
//
// AGENTS.md "Demo failures route to engine fixes, not workarounds": when
// the baked PNG drifts after an engine change, the correct response is
// to investigate the visual regression (walk back from the PNG diff to
// the responsible commit) -- NOT to rerun bake-ibl-reference and re-commit
// the new baseline. Only run this script when the engine genuinely
// produces a new correct output (e.g. M5 first-bake landing on round-2
// fix-up; future feat-* loops that intentionally change IBL math).
//
// Baseline regeneration scenarios (must hold to justify re-running):
//   1. First bake -- no reference PNG yet (feat-20260520-skylight-ibl-cubemap
//      round-2 fix-up).
//   2. Intentional engine change -- a downstream feat loop intentionally
//      changes the IBL diffuse / specular shader math; the corresponding
//      requirements.md must record the visual delta as a planned AC.
//   3. Vendor HDR replacement -- newport_loft.hdr swapped for a different
//      LearnOpenGL chapter source; forgeax-engine-assets submodule pointer
//      bump must accompany.
//
// Any other "the smoke fails so regenerate" usage is a charter F1 violation
// (silent baseline drift). Reviewer pushes back.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const { runIblSmoke, warmUpng } = await import(
  resolve(repoRoot, 'apps/learn-render/6.pbr/_shared/ibl-smoke-shared.mjs')
);

await warmUpng();

console.log('[bake-ibl-reference] phase 1/2 -- ibl-irradiance');
await runIblSmoke({
  demoKind: 'irradiance',
  demoId: 'bake-ibl-irradiance',
  referencePath: resolve(
    repoRoot,
    'forgeax-engine-assets/smoke-baselines/learn-render-6-pbr-2-ibl-irradiance/skylight-irradiance.ref.png',
  ),
  mode: 'bake',
  distDir: resolve(repoRoot, 'apps/learn-render/6.pbr/2.ibl-irradiance/dist'),
});

console.log('[bake-ibl-reference] phase 2/2 -- ibl-specular');
await runIblSmoke({
  demoKind: 'specular',
  demoId: 'bake-ibl-specular',
  referencePath: resolve(
    repoRoot,
    'forgeax-engine-assets/smoke-baselines/learn-render-6-pbr-3-ibl-specular/skylight-specular.ref.png',
  ),
  mode: 'bake',
  distDir: resolve(repoRoot, 'apps/learn-render/6.pbr/3.ibl-specular/dist'),
});

console.log('[bake-ibl-reference] PASS -- both reference PNGs regenerated.');
process.exit(0);
