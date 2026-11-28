import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { browserGpuLaunchOptions } from '../../../../scripts/ci/browser-executable.mjs';
import launchDefaults from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5387';
const output =
  process.env.FORGEAX_POOL_EVIDENCE ?? (await mkdtemp(join(tmpdir(), 'forgeax-pool-')));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...browserGpuLaunchOptions(launchDefaults),
  chromiumSandbox: true,
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const state = () =>
  page.evaluate(() => {
    const s = window.__poolDemo.readState();
    return { ...s, renderer: undefined };
  });
async function frames(count = 6) {
  const start = (await state()).completedFrames;
  await page.waitForFunction(
    (goal) => window.__poolDemo.readState().completedFrames >= goal,
    start + count,
    { timeout: 120000 },
  );
  const current = await state();
  assert.deepEqual(current.errors, []);
  assert.deepEqual(errors, []);
  return current;
}
async function picture(name) {
  const bytes = await page.locator('#pool').screenshot();
  await writeFile(join(output, `${name}.png`), bytes);
  return PNG.sync.read(bytes);
}
function differences(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      24
    )
      count++;
  }
  return count;
}
function project(point, camera, bounds) {
  const delta = point.map((value, axis) => value - camera.eye[axis]);
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const depth = dot(delta, camera.forward);
  return {
    x:
      bounds.x +
      (bounds.width *
        (1 + dot(delta, camera.right) / ((depth * 0.41421356 * bounds.width) / bounds.height))) /
        2,
    y: bounds.y + (bounds.height * (1 - dot(delta, camera.up) / (depth * 0.41421356))) / 2,
  };
}
try {
  await page.goto(`${baseUrl}/pool.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__poolDemo?.readState().completedFrames >= 60, null, {
    timeout: 180000,
  });
  const initial = await frames();
  assert(initial.submissions >= 60);
  assert.equal(initial.fieldSize, 1024);
  assert.equal(initial.maximumHeight, 0, 'The initial pool must remain perfectly still');
  assert.equal(initial.gravity, false);
  await picture('initial-still-water');
  const display = await page.locator('#pool').evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    ratio: window.devicePixelRatio,
  }));
  assert.equal(display.width, Math.round(display.cssWidth * display.ratio));
  assert.equal(display.height, Math.round(display.cssHeight * display.ratio));
  await page.locator('summary').click();
  await page.locator('#field').check({ force: true });
  await page.evaluate(() => window.__poolDemo.setPaused(true));
  await frames();
  const flatField = await picture('flat-caustic-field');
  await page.evaluate(() => {
    window.__poolDemo.disturb(-0.15, 0.05, 0.075, 0.00001);
    window.__poolDemo.setPaused(false);
  });
  await frames(45);
  await page.evaluate(() => window.__poolDemo.setPaused(true));
  const weak = await frames();
  assert(weak.maximumHeight > 0 && weak.maximumHeight < 0.000002);
  const weakField = await picture('weak-caustic-field');
  let weakPeakDifference = 0;
  for (let y = Math.ceil(flatField.height * 0.2); y < flatField.height * 0.8; y++) {
    for (let x = Math.ceil(flatField.width * 0.2); x < flatField.width * 0.8; x++) {
      const i = (y * flatField.width + x) * 4;
      weakPeakDifference = Math.max(
        weakPeakDifference,
        Math.abs(weakField.data[i] - flatField.data[i]),
      );
    }
  }
  assert(
    weakPeakDifference <= 6,
    `Sub-micrometre waves produced spurious bright fragments: ${weakPeakDifference}/255`,
  );
  await page.locator('#field').uncheck({ force: true });
  await page.locator('summary').click();
  await page.evaluate(() => {
    window.__poolDemo.reset();
    window.__poolDemo.setPaused(false);
  });
  await frames();
  const startBounds = await page.locator('#pool').boundingBox();
  assert(startBounds);
  const firstTouch = project([0.45, 0, -0.35], initial.camera, startBounds);
  await page.mouse.click(firstTouch.x, firstTouch.y);
  await frames(45);
  await page.evaluate(() => window.__poolDemo.setPaused(true));
  await frames();
  const on = await picture('reference-caustics-on');
  await page.locator('#caustics').uncheck({ force: true });
  await frames();
  const off = await picture('reference-caustics-off');
  const causticPixels = differences(on, off);
  assert(causticPixels > 1000, `Caustic toggle changed only ${causticPixels} pixels`);
  await page.locator('#caustics').check({ force: true });
  await frames();
  const beforeRipple = (await state()).maximumHeight;
  const bounds = await page.locator('#pool').boundingBox();
  assert(bounds);
  const before = await state();
  const water = project([0.35, 0, -0.3], before.camera, bounds);
  await page.mouse.click(water.x, water.y);
  const ripple = await frames();
  assert(
    ripple.maximumHeight > beforeRipple + 0.003,
    'A real canvas click did not disturb the shared heightfield',
  );
  await picture('clicked-ripple-paused');
  const ball = project(ripple.sphere, ripple.camera, bounds);
  await page.mouse.move(ball.x, ball.y);
  await page.mouse.down();
  await frames(2);
  await page.mouse.move(ball.x + 36, ball.y - 28, { steps: 10 });
  await frames(2);
  await page.mouse.up();
  const dragged = await frames();
  assert(
    Math.hypot(...dragged.sphere.map((value, axis) => value - ripple.sphere[axis])) > 0.03,
    'Sphere drag did not move the actual receiver',
  );
  await picture('dragged-sphere-soft-shadow');
  await page.evaluate(() => window.__poolDemo.setPaused(false));
  await frames(60);
  const moving = await picture('propagated-ripples');
  assert(differences(on, moving) > 1000, 'Simulated ripples did not change the rendered image');
  await page.mouse.move(bounds.x + 30, bounds.y + 80);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + 130, bounds.y + 110, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  const orbited = await frames();
  assert(Math.hypot(...orbited.camera.eye.map((v, i) => v - initial.camera.eye[i])) > 0.1);
  await page.locator('#pool').focus();
  await page.keyboard.press('KeyG');
  await frames(60);
  assert.equal((await state()).gravity, true);
  await page.evaluate(() => {
    window.__poolDemo.setPaused(true);
    window.__poolDemo.setView('underwater');
  });
  await frames();
  await picture('underwater-reflection-refraction');
  await page.evaluate(() => window.__poolDemo.setView('reference'));
  await frames();
  await page.locator('summary').click();
  await page.locator('#field').check({ force: true });
  await frames();
  const field = await picture('caustic-field');
  let dark = 0;
  let covered = 0;
  let pattern = 0;
  for (let i = 0; i < field.data.length; i += 4) {
    if (field.data[i] < 8) dark++;
    if (field.data[i] > 16) covered++;
    if (field.data[i] > 16 && Math.abs(field.data[i] - 51) > 8) pattern++;
  }
  assert(
    dark > 1000 && covered > 1000 && pattern > 1000,
    'The caustic field must contain actual projected coverage, not a neutral placeholder',
  );
  await page.locator('#field').uncheck({ force: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await frames(10);
  const mobile = await state();
  const beforeTouch = await picture('mobile-before-touch');
  const mobileBounds = await page.locator('#pool').boundingBox();
  assert(mobileBounds);
  const contact = project([0.3, 0, -0.3], mobile.camera, mobileBounds);
  await page.touchscreen.tap(contact.x, contact.y);
  await frames();
  const afterTouch = await picture('mobile-touch-ripple');
  assert(
    differences(beforeTouch, afterTouch) > 100,
    'Touch did not disturb the rendered shared water field',
  );
  await page.screenshot({ path: join(output, 'mobile.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.__poolDemo.reset());
  const reset = await frames(60);
  assert.equal(
    reset.maximumHeight,
    0,
    'Reset must restore still water without preset disturbances',
  );
  assert.equal(reset.gravity, false);
  await picture('reset-still-water');
  const final = await state();
  await writeFile(
    join(output, 'acceptance.json'),
    JSON.stringify({ baseUrl, causticPixels, weakPeakDifference, final, errors }, null, 2),
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, completedFrames: final.completedFrames, causticPixels, output })}\n`,
  );
} finally {
  await page.evaluate(() => window.__poolDemo?.dispose()).catch(() => {});
  await browser.close();
}
