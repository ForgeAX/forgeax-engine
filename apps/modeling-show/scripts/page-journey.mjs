// Sandboxed headless Chromium journey through an interactive Show page (software WebGPU, default
// limits): alive, play/pause, turntable, orbit/zoom/pan, presets, floor toggle; JOURNEY=full adds
// the u slider of a transforming subject (segment 2) and its robot turntable (segment 3).
// THROTTLE_MBPS / THROTTLE_RTT_MS emulate a remote link. Exit code 0 = every check passed.
// JOURNEY=smoke only loads the page and checks first frames. JOURNEY=panel opens the debug panel
// on the first (turntable) beat and checks each control the subject shows (part visibility and
// every shading mode; explode, section and mechanism u where the panel has them).
// usage: node page-journey.mjs <url> <outdir>
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../../packages/devkit/package.json', import.meta.url));
const full = process.env.JOURNEY === 'full';
// JOURNEY=smoke: the quick check of a geometry-only rebuild (loads, first frames, no errors).
const smoke = process.env.JOURNEY === 'smoke';
const panel = process.env.JOURNEY === 'panel';
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const [url, out = '/tmp/f1ip/journey'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader'],
  chromiumSandbox: true,
});
const errors = [];
const warnings = [];
const steps = [];
const t0 = Date.now();
const ts = () => +((Date.now() - t0) / 1000).toFixed(1);
let page;
const frames = () => page.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameCompleted) || 0);
const settle = async (n = 4) => {
  const start = await frames();
  await page.waitForFunction((m) => Number(document.documentElement.dataset.forgeaxFrameCompleted) >= m, start + n, { timeout: 300_000 });
};
const shot = async (name) => {
  const path = `${out}/${name}.png`;
  await page.screenshot({ path, clip: { x: 0, y: 100, width: 1280, height: 480 }, timeout: 180_000 });
  return PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 100, width: 1280, height: 480 }, timeout: 180_000 }));
};
const diff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  return sum / (a.data.length / 4) / 765;
};
const check = (name, ok, detail) => {
  steps.push({ name, ok, detail, at: ts() });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
};
const ui = (selector) => page.locator(selector).first();
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Actionability 'stable' needs two animation frames; heavy pages under software WebGPU and host load run rAF below 1/s.
  page.setDefaultTimeout(180_000);
  page.on('console', (m) => (m.type() === 'error' ? errors : m.type() === 'warning' ? warnings : []).push(m.text().slice(0, 400)));
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 400)}`));
  page.on('requestfailed', (r) => errors.push(`failed ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  if (process.env.THROTTLE_MBPS) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: Number(process.env.THROTTLE_RTT_MS ?? 50),
      downloadThroughput: (Number(process.env.THROTTLE_MBPS) * 1e6) / 8,
      uploadThroughput: (10 * 1e6) / 8,
    });
  }
  const statuses = [];
  const statusTimer = setInterval(() => page.evaluate(() => document.getElementById('forgeax-loading-status')?.textContent).then((t) => t && statuses.at(-1) !== t && statuses.push(`${ts()} ${t}`)).catch(() => {}), 5000);
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('forgeax-loading')?.getAttribute('aria-hidden') === 'true' && Number(document.documentElement.dataset.forgeaxFrameCompleted) > 2, undefined, { timeout: 1_200_000 });
  clearInterval(statusTimer);
  check('alive', true, { seconds: ts(), label: await ui('[data-ui-part="label"]').textContent(), statuses: statuses.filter((_, i) => i % 6 === 0 || i === statuses.length - 1) });
  if (smoke) {
    const before = await frames();
    await settle(3);
    check('frames advance', (await frames()) > before, { frames: await frames() });
  } else {
  // The camera, floor, finish and surface controls live in the debug panel, collapsed by default.
  await ui('[data-ui-part="panel-toggle"]').click();
  if (panel) {
    await ui('[data-ui-part="segments"] button:nth-child(1)').click();
    await settle();
    const base = await shot('panel-base');
    const held = async (name, part, value, threshold, reset) => {
      await ui(`[data-ui-part="${part}"]`).fill(String(value));
      await settle();
      const view = await shot(name);
      check(name, diff(base, view) > threshold, { diff: diff(base, view) });
      await reset();
      await settle();
      return view;
    };
    if (await ui('[data-ui-part="explode"]').isVisible())
      await held('panel-explode', 'explode', 1000, 0.005, () => ui('[data-ui-action="explode-auto"]').click());
    if (await ui('[data-ui-action="section-x"]').isVisible()) {
      for (const axis of ['x', 'y', 'z']) {
        await ui(`[data-ui-action="section-${axis}"]`).click();
        await held(`panel-section-${axis}`, 'section', 500, 0.005, async () => {});
      }
      await ui('[data-ui-action="section-auto"]').click();
      await settle();
    }
    if (await ui('[data-ui-part="mechanism"]').isVisible())
      await held('panel-mechanism', 'mechanism', 1000, 0.005, () => ui('[data-ui-action="mechanism-auto"]').click());
    if (await ui('[data-ui-part="parts"]').isVisible()) {
      const count = await page.locator('[data-ui-part="parts"] input').count();
      for (let i = 0; i < count; i += 2) await page.locator('[data-ui-part="parts"] input').nth(i).uncheck();
      await settle();
      const view = await shot('panel-parts-hidden');
      check('panel hides every other part', diff(base, view) > 0.003, { diff: diff(base, view), hidden: Math.ceil(count / 2), of: count });
      await ui('[data-ui-action="parts-all"]').click();
      await settle();
    }
  }
  if (full) {
    // Pause, then scrub u on the transformation beat.
    await ui('[data-ui-part="segments"] button:nth-child(2)').click();
    await ui('[data-ui-part="scrub"]').fill('0');
    await settle();
    const u0 = await shot('u0');
    await ui('[data-ui-part="scrub"]').fill('1000');
    await settle();
    const u1 = await shot('u1');
    check('u slider changes the form', diff(u0, u1) > 0.02, { diff: diff(u0, u1), toggle: await ui('[data-ui-part="toggle"]').textContent() });
  }
  if (!panel) {
  // Play / pause on the first (turntable) beat.
  await ui('[data-ui-part="segments"] button:nth-child(1)').click();
  await settle();
  const paused = await shot('paused');
  await settle();
  const stillPaused = await shot('still-paused');
  await ui('[data-ui-part="toggle"]').click();
  await settle(6);
  const playing = await shot('turntable-playing');
  check('paused holds still', diff(paused, stillPaused) < 0.004, { diff: diff(paused, stillPaused) });
  check('play turns the turntable', diff(paused, playing) > 0.01, { diff: diff(paused, playing), toggle: await ui('[data-ui-part="toggle"]').textContent() });
  await ui('[data-ui-part="toggle"]').click();
  await settle();
  const before = await shot('before-orbit');
  // Orbit: left drag on the canvas.
  await page.mouse.move(640, 330);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(640 + 30 * i, 330 + 6 * i);
    await settle(1);
  }
  await page.mouse.up();
  await settle();
  const orbited = await shot('orbit');
  const autoOff = !(await ui('[data-ui-action="view-auto"]').getAttribute('class'))?.includes('current');
  check('drag orbits the camera', diff(before, orbited) > 0.02 && autoOff, { diff: diff(before, orbited), autoOff });
  // Zoom.
  await page.mouse.move(640, 330);
  await page.mouse.wheel(0, -300);
  await settle();
  const zoomed = await shot('zoom');
  check('wheel zooms', diff(orbited, zoomed) > 0.02, { diff: diff(orbited, zoomed) });
  // Pan: right drag.
  await page.mouse.move(640, 330);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(640 - 25 * i, 330);
    await settle(1);
  }
  await page.mouse.up({ button: 'right' });
  await settle();
  const panned = await shot('pan');
  check('right drag pans', diff(zoomed, panned) > 0.01, { diff: diff(zoomed, panned) });
  // Presets.
  const views = {};
  for (const name of ['front', 'side', 'rear', 'top']) {
    await ui(`[data-ui-action="view-${name}"]`).click();
    await settle();
    views[name] = await shot(`view-${name}`);
  }
  check('preset views differ', diff(views.front, views.side) > 0.02 && diff(views.side, views.top) > 0.02, {
    frontSide: diff(views.front, views.side),
    sideTop: diff(views.side, views.top),
  });
  await ui('[data-ui-action="view-auto"]').click();
  await settle();
  const auto = await shot('view-auto');
  // Floor.
  await ui('[data-ui-part="floor"]').click();
  await settle();
  const noFloor = await shot('floor-off');
  check('floor toggle hides the floor', diff(auto, noFloor) > 0.01, { diff: diff(auto, noFloor), button: await ui('[data-ui-part="floor"]').textContent() });
  await ui('[data-ui-part="floor"]').click();
  await settle();
  // Finish toggle (subjects with clean looks): weathered paint differs from the clean default.
  if (await ui('[data-ui-part="finish"]').isVisible()) {
    const clean = await shot('finish-clean');
    await ui('[data-ui-part="finish"]').click();
    await settle();
    const weathered = await shot('finish-weathered');
    check('finish toggle changes the paint', diff(clean, weathered) > 0.002, { diff: diff(clean, weathered) });
    await ui('[data-ui-part="finish"]').click();
    await settle();
  }
  }
  // Surface views: each replaces (or overlays) every part once computed.
  await ui('[data-ui-part="segments"] button:nth-child(1)').click();
  await settle();
  const shaded = await shot('surface-shaded');
  for (const mode of ['curvature', 'zebra', 'edges']) {
    const begun = ts();
    await ui(`[data-ui-action="analysis-${mode}"]`).click();
    await page.waitForFunction(
      () => {
        const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot?.querySelector('[data-ui-part="analysis-progress"]'));
        return host?.shadowRoot?.querySelector('[data-ui-part="analysis-progress"]')?.textContent === '';
      },
      undefined,
      { timeout: 600_000, polling: 2000 },
    );
    await settle(3);
    const view = await shot(`surface-${mode}`);
    check(`surface view ${mode}`, diff(shaded, view) > (mode === "edges" ? 0.0005 : 0.01), { diff: diff(shaded, view), seconds: +(ts() - begun).toFixed(1) });
  }
  await ui('[data-ui-action="analysis-off"]').click();
  await settle(3);
  if (full) {
    // Robot form on the turntable.
    await ui('[data-ui-part="segments"] button:nth-child(3)').click();
    await ui('[data-ui-part="scrub"]').fill('300');
    await settle();
    await shot('robot');
  }
  await page.screenshot({ path: `${out}/full.png`, timeout: 180_000 });
  }
} catch (error) {
  check('journey', false, { error: String(error).slice(0, 600) });
  await page?.screenshot({ path: `${out}/error.png` }).catch(() => {});
} finally {
  const ok = steps.every((s) => s.ok) && errors.length === 0;
  console.log(JSON.stringify({ ok, seconds: ts(), steps, errors: errors.slice(0, 10), warnings: [...new Set(warnings)].slice(0, 5) }, null, 1));
  await browser.close();
  process.exitCode = ok ? 0 : 1;
}
