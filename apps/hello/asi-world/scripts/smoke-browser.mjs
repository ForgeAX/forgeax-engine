// smoke-browser.mjs -- bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu (M3 / m3-1)
//
// Playwright e2e for AC-04 (requirements IN-5): assert
// LOW-LEVEL HARNESS EXCEPTION: `renderer.frustumStats.total > 0` AND
// `renderer.frustumStats.culled > 0` is a renderer-internal browser diagnostic.
// on the asi-world scene (605x56 tilemap + 12387 objects, all sprite
// entities riding HANDLE_QUAD). This probe is the entity-level frustum-
// cull activation signal: pre-M1 fix, `withoutAabb(BUILTIN_QUAD)` in
// packages/runtime/src/builtin-asset-registry.ts stripped the aabb field
// from the builtin quad payload, and the `aabb === undefined` branch in
// packages/runtime/src/render-system-extract.ts short-circuited the
// entity-level cull loop -- `frustumStats.total` never incremented for
// any HANDLE_QUAD-backed entity. Post-M1 fix (commit 6281311d) the aabb
// field is restored + the M2.5 pendingDispatch / flushPendingDispatch
// pairing keeps dispatch/renderable slots aligned when entities are
// culled; asi-world observably drops from fps 7-9 / drawIndexed 208 to
// fps 22-24 / drawIndexed 65 with frustumStats { total: 1575, culled:
// 1274, visible: 301 } (editor main-tree measurement).
//
// Why a separate script (not smoke-dawn.mjs): smoke-dawn.mjs boots a
// createRenderer + hand-built World over dawn-node, which never exercises
// the full vite dev pack path (`JSON.stringify -> fetch -> JSON.parse`),
// the browser WebGPU device, or the live rAF loop that populates the
// 12387 per-cell object TileLayer entities before the extract stage
// visits them. AC-04 is inherently a browser-path assertion: the cull
// path activates only once the scene has spawned the sprite entities in
// steady-state (>= 1 frame of rAF), and only the browser reveals the
// WebGPU-side dispatch / renderable behaviour that the M2.5 pairing
// protects.
//
// Invocation: `pnpm -F @forgeax/hello-asi-world smoke:browser`
//
// Exit codes:
//   0 = green (frustumStats.total > 0 AND culled > 0)
//   1 = red (assertion failed; falsify anchor: temporarily restore
//       withoutAabb() at packages/runtime/src/builtin-asset-registry.ts
//       -> probe must exit 1 with total === 0)
//   2 = harness error (vite did not boot / playwright launch failed)
//
// Local-only gate today (plan-decisions PL-2); CI inclusion gated on a
// Chrome-with-WebGPU runner. Mirrors apps/hello/skin/scripts/smoke-
// browser.mjs and apps/hello/cube/scripts/smoke-browser.mjs.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/hello/asi-world/scripts -> apps/hello/asi-world -> apps/hello -> apps -> repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-asi-world', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (m) portUrl = m[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const deadline = Date.now() + 30000;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('FAIL: vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
    chromiumSandbox: true,
  });
} catch (e) {
  console.error(`FAIL: could not launch headed Chrome with WebGPU: ${e?.message ?? e}`);
  viteProc.kill('SIGTERM');
  process.exit(2);
}
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${msg.text()}`);
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
// asi-world bootstrap fetches 5 JSON docs + 4 PNGs before spawning the
// tilemap / player / object TileLayer, then app.start() begins rAF.
// 3s covers the fetch + first-frame settling on a typical machine; the
// object TileLayer chunk-extract system finishes its per-cell entity
// materialization within the first few frames of app.start().
await page.waitForTimeout(3000);

const stats = await page.evaluate(() => {
  const g = /** @type {{__forgeax?: {renderer?: {frustumStats?: {total: number, culled: number}}}}} */ (
    globalThis
  );
  const s = g.__forgeax?.renderer?.frustumStats;
  if (!s) return null;
  return { total: s.total, culled: s.culled };
});

console.log('\n=== renderer.frustumStats ===');
console.log(JSON.stringify(stats, null, 2));
console.log('=== console errors during boot ===');
errors.forEach((e) => console.log(e));

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

if (stats === null) {
  console.error(
    '\n[smoke-browser] RED -- window.__forgeax.renderer.frustumStats unreachable. ' +
      'Suspect: bootstrap threw before mounting globalThis.__forgeax.renderer ' +
      '(check console errors above), or apps/hello/asi-world/src/main.ts mount side-effect was dropped.',
  );
  process.exit(1);
}

// This browser probe intentionally remains on the low-level diagnostic field:
// the public Renderer.inspect() contract is POD-only and does not expose
// frustum counts, while this script must prove entity-level culling through
// the Vite/WebGPU path without changing the app source surface.
// AC-04 primary gate. The default orthographic camera centers on the
// spawn cell (camHalfW x camHalfH cells visible), so 12387 - visible
// objects sit outside the frustum and must be culled every frame.
// `total > 0` proves the entity-level cull loop reached the decision
// point; `culled > 0` is the load-bearing assertion that the per-entity
// cull path actually rejected at least one HANDLE_QUAD entity. Either
// zero -> the pre-M1 silent bypass (withoutAabb short-circuit) is back.
if (stats.total <= 0 || stats.culled <= 0) {
  console.error(
    `\n[smoke-browser] AC-04 RED -- frustumStats.total=${stats.total} culled=${stats.culled}; ` +
      'expected total > 0 AND culled > 0. ' +
      'Suspect: withoutAabb(BUILTIN_QUAD) regressed at packages/runtime/src/builtin-asset-registry.ts ' +
      '(BUILTIN_QUAD payload missing aabb -> render-system-extract.ts aabb===undefined short-circuits ' +
      'the entity-level cull path silently), or M2.5 flushPendingDispatch pairing regressed.',
  );
  process.exit(1);
}

console.log(
  `\n[smoke-browser] AC-04 GREEN -- frustumStats.total=${stats.total} culled=${stats.culled}; ` +
    'HANDLE_QUAD entities participate in the entity-level frustum cull path.',
);
process.exit(0);
