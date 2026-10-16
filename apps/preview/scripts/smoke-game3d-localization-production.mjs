import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { probeLocalization } from '../../../templates/game-3d/scripts/localization-probe.mjs';

const root = resolve(import.meta.dirname, '../../..');
const built = resolve(process.argv[2] ?? resolve(root, 'templates/game-3d/.forgeax/g09-production'));
const artifacts = resolve(root, '.forgeax-debug/g09/production');
await mkdir(artifacts, { recursive: true });
const requests = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(built, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(built + sep)) throw new Error('Invalid static path');
    const bytes = await readFile(file);
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream');
    response.end(bytes);
  } catch {
    response.writeHead(404); response.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...browserLaunch, chromiumSandbox: true});
let page;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await context.route('**/*', (route) => {
    const url = route.request().url(); requests.push(url);
    if (!url.startsWith(origin + '/') && !url.startsWith('blob:') && !url.startsWith('data:')) {
      errors.push(`External request: ${url}`); return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${origin}/?forgeax-cpu-profile=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const renderer = globalThis.__forgeaxGameInspection?.renderer();
    const state = typeof renderer?.state === 'string' ? renderer.state : renderer?.state?.reason;
    return state === 'alive' && renderer.frameId >= 60;
  }, null, { timeout: 90_000 });
  const renderer = await page.evaluate(() => globalThis.__forgeaxGameInspection.renderer());
  const pixels = PNG.sync.read(await page.locator('canvas#app').screenshot());
  let nonBlackPixels = 0, lumaMin = 255, lumaMax = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const [r, g, b] = pixels.data.subarray(i, i + 3);
    const luma = .2126 * r + .7152 * g + .0722 * b;
    lumaMin = Math.min(lumaMin, luma); lumaMax = Math.max(lumaMax, luma);
    if (r > 8 || g > 8 || b > 8) nonBlackPixels++;
  }
  const canvas = { width: pixels.width, height: pixels.height, nonBlackPixels, lumaMin, lumaMax, lumaRange: lumaMax - lumaMin };
  if (!nonBlackPixels || canvas.lumaRange <= 8) throw new Error(`Blank game canvas: ${JSON.stringify(canvas)}`);
  const localization = await probeLocalization(page, artifacts, { offline: true });
  const compactDir = resolve(artifacts, 'compact');
  await mkdir(compactDir, { recursive: true });
  const beforeResize = await page.evaluate(() => globalThis.__forgeaxGameInspection.renderer().frameId);
  await page.setViewportSize({ width: 320, height: 180 });
  await page.waitForFunction((frameId) => globalThis.__forgeaxGameInspection?.renderer().frameId >= frameId + 60, beforeResize, { timeout: 90_000 });
  const compact = await probeLocalization(page, compactDir, { offline: true });
  if (errors.length) throw new Error(JSON.stringify(errors));
  const report = { built, renderer, canvas, localization, compact, requests, errors, browser: browser.version() };
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const renderer = await page?.evaluate(() => globalThis.__forgeaxGameInspection?.renderer()).catch(() => undefined);
  await page?.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => undefined);
  await writeFile(resolve(artifacts, 'failure.json'), JSON.stringify({ error: String(error), renderer, errors, requests }, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
