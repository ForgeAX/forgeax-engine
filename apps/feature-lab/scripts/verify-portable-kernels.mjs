// Run against the Feature Lab dev server; retain actual backend contexts,
// sixty completed frames, production checks and paired on/off images.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.env.FORGEAX_PORTABLE_EVIDENCE ?? resolve(appRoot, 'artifacts/portable-kernels'));
const baseUrl = process.env.FEATURE_LAB_URL ?? 'http://127.0.0.1:5173';
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim();
mkdirSync(out, { recursive: true });
const serverDeadline = Date.now() + 180000;
while (true) {
  let ready = false;
  try { ready = (await fetch(baseUrl)).ok; } catch {}
  if (ready) break;
  if (Date.now() >= serverDeadline) throw new Error('Feature Lab server did not become ready within 180s');
  await new Promise((resume) => setTimeout(resume, 250));
}
const browser = await chromium.launch({
  channel: 'chrome-beta', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const receipts = [];
try {
  for (const backend of ['webgpu', 'wgpu-webgl2']) {
    for (const slug of ['ssr', 'auto-exposure']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 720 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
      });
      await page.addInitScript((selected) => {
        if (selected === 'wgpu-webgl2') Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
        window.__portableContexts = [];
        window.__portableGl = undefined;
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          const context = original.call(this, kind, ...args);
          if (context !== null) window.__portableContexts.push(kind);
          if (kind === 'webgl2' && context !== null) {
            const debug = context.getExtension('WEBGL_debug_renderer_info');
            window.__portableGl = { version: context.getParameter(context.VERSION), renderer: debug === null ? 'unavailable' : context.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
          }
          return context;
        };
      }, backend);
      const started = Date.now();
      console.log('START', backend, slug);
      await page.goto(`${baseUrl}/?f=post-processing/${slug}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
      await page.waitForFunction(() => window.__featureLab?.frame >= 60 || (window.__featureLab?.error !== null && window.__featureLab?.error !== undefined), undefined, { timeout: 180000 });
      const initial = await page.evaluate(() => ({ frame: window.__featureLab.frame, error: window.__featureLab.error, contexts: [...new Set(window.__portableContexts)], gl: window.__portableGl }));
      if (initial.error !== null) {
        writeFileSync(resolve(out, `${backend}-${slug}-failure.json`), JSON.stringify({ sourceHead, initial, errors }, null, 2));
        await page.screenshot({ path: resolve(out, `${backend}-${slug}-failure.png`) });
        throw new Error(JSON.stringify(initial));
      }
      if (!initial.contexts.includes(backend === 'webgpu' ? 'webgpu' : 'webgl2')) throw new Error('expected backend context was not created');
      await page.screenshot({ path: resolve(out, `${backend}-${slug}-on.png`) });
      await page.evaluate(() => window.__featureLab.toggle(false));
      const at = await page.evaluate(() => window.__featureLab.frame);
      await page.waitForFunction((target) => window.__featureLab.frame >= target, at + 20, { timeout: 120000 });
      await page.screenshot({ path: resolve(out, `${backend}-${slug}-off.png`) });
      await page.evaluate(() => window.__featureLab.toggle(true));
      const checks = await page.evaluate(() => window.__featureLab.checks());
      const receipt = { sourceHead, backend, slug, ...initial, elapsedMs: Date.now() - started, checks, errors };
      receipts.push(receipt);
      writeFileSync(resolve(out, 'visual.json'), `${JSON.stringify(receipts, null, 2)}\n`);
      console.log('RESULT', JSON.stringify(receipt));
      if (checks.some((check) => !check.ok) || errors.length > 0) throw new Error('production checks failed');
      await page.close();
    }
  }
} finally { await browser.close(); }
