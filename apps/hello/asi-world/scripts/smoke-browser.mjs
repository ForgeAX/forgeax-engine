// Real Vite/WebGPU scene: 60 completed frames and public frustum evidence.
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

await page.goto(`${portUrl}?smoke=1`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForFunction(()=>globalThis.__forgeax?.completedFrames?.()>=60,{},{timeout:60_000});

const stats = await page.evaluate(() => {
  const g = /** @type {{__forgeax?: {renderer?: {inspect(): {frustumStats: {total: number, culled: number}}}}}} */ (
    globalThis
  );
  const s = g.__forgeax?.renderer?.inspect().frustumStats;
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

if(errors.length>0){console.error(errors);process.exit(1);}
// Visible chunk projection and exact cell bounds must still reject off-camera work.
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
    'Native visible Tilemap draws participate in frustum culling.',
);
process.exit(0);
