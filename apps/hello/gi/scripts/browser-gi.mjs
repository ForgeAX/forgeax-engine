// Drive the hello-gi dev server in a Chrome reached over CDP and write one
// <out>/<scene>.json per scene for scripts/reference.mjs --browser <out>.
// Only pages this script opens are touched; existing targets stay as they are.
//
//   node scripts/browser-gi.mjs --cdp http://127.0.0.1:9222 --url http://127.0.0.1:5173/
//     [--scenes sponza] [--size 512] [--frames 64] [--gather exact|irradiance-field|screen-probe]
//     [--bounces 1] [--capture] [--out <dir>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { optionReader } from './gi-comparison.mjs';

const args = process.argv.slice(2);
const option = optionReader(args);
const CDP = option('cdp', 'http://127.0.0.1:9222');
const URL_BASE = option('url', 'http://127.0.0.1:5173/');
const SCENES = option('scenes', 'sponza').split(',');
const SIZE = Number(option('size', '512'));
const FRAMES = Number(option('frames', '64'));
const GATHER = option('gather', 'exact');
const BOUNCES = Number(option('bounces', '1'));
const WARMUP = Number(option('warmup', '256'));
if (!['exact', 'irradiance-field', 'screen-probe'].includes(GATHER)) throw new Error(`invalid gather ${GATHER}`);
for (const [name, value] of Object.entries({ SIZE, FRAMES, BOUNCES, WARMUP }))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
const CAPTURE = args.includes('--capture');
const OUT = resolve(option('out', 'artifacts/gi-browser'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0] ?? (await browser.newContext());
const commit = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
for (const id of SCENES) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (event) => {
    if (event.type() === 'error') {
      const location = event.location();
      errors.push(`${event.text()} (${location.url}:${location.lineNumber}:${location.columnNumber})`);
    }
    else if (event.text().startsWith('[hello-gi]')) console.log(event.text());
  });
  try {
    const started = performance.now();
    await page.goto(`${URL_BASE}?scene=${id}&size=${SIZE}&gi=off&bounces=${BOUNCES}`);
    await page.waitForFunction(() => window.__gi !== undefined, undefined, { timeout: 600000 });
    const loadMs = performance.now() - started;
    console.log(`[browser-gi] ${id}: loaded in ${(loadMs / 1000).toFixed(1)} s`);
    const lost = new Promise((_, reject) => {
      page.on('crash', () => reject(new Error('page crashed')));
      page.on('close', () => reject(new Error('page closed')));
    });
    lost.catch(() => {});
    const run = (body, arg) => Promise.race([page.evaluate(body, arg), lost]);
    const direct = await run(({ frames, warmup }) => window.__gi.observe(frames, warmup), { frames: FRAMES, warmup: WARMUP });
    if (!direct.ok) throw new Error(`direct observe: ${JSON.stringify(direct.error)}`);
    const set = await run((gi) => window.__gi.set({ gi }), GATHER);
    if (!set.ok) throw new Error(`set gi ${GATHER}: ${set.error}`);
    let t = performance.now();
    const gi = await run(({ frames, warmup }) => window.__gi.observe(frames, warmup), { frames: FRAMES, warmup: WARMUP });
    if (!gi.ok) throw new Error(`gi observe: ${JSON.stringify(gi.error)}`);
    const giMs = performance.now() - t;
    console.log(`[browser-gi] ${id}: ${FRAMES} GI frames in ${(giMs / 1000).toFixed(1)} s`);
    let capture;
    if (CAPTURE) {
      console.log(`[browser-gi] ${id}: capturing`);
      t = performance.now();
      capture = await run((runId) => window.__gi.capture(runId), `hello-gi-${id}-${GATHER}`);
      capture.roundTripMs = performance.now() - t;
      console.log(`[browser-gi] ${id}: capture ${JSON.stringify(capture)}`);
    }
    const userAgent = await run(() => navigator.userAgent);
    const adapter = await run(async () => {
      const device = await navigator.gpu.requestAdapter();
      if (device === null) throw new Error('browser adapter unavailable');
      return { vendor: device.info.vendor, architecture: device.info.architecture,
        device: device.info.device, description: device.info.description, fallback: device.isFallbackAdapter };
    });
    const state = await run(() => window.__gi.state());
    await page.screenshot({ path: resolve(OUT, `${id}-browser.png`), fullPage: true });
    writeFileSync(
      resolve(OUT, `${id}.json`),
      JSON.stringify({
        scene: id,
        commit,
        settings: { size: SIZE, frames: FRAMES, warmup: WARMUP, bounces: BOUNCES, gather: GATHER },
        adapter,
        gather: GATHER,
        width: direct.width,
        height: direct.height,
        userAgent,
        // The observation includes warm-up and readiness, so dividing this
        // interval by only the sampled frames does not measure frame cost.
        wallMs: { load: loadMs, giObserve: giMs },
        direct,
        gi,
        capture,
        state,
        errors,
      }),
    );
    console.log(
      `[browser-gi] ${id}: wrote ${resolve(OUT, `${id}.json`)} (errors ${errors.length})`,
    );
    if (errors.length > 0 || state.errors !== 0 || (CAPTURE && capture?.ok !== true))
      throw new Error(`${id}: browser validation or capture failed; see recorded errors`);
  } finally {
    await page.close();
  }
}
process.exit(0);
