import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBrowserCapture } from '@forgeax/engine/devkit';
import { parseImage } from '@forgeax/engine/image/parse-image';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-smoke');
const backend = process.env.FORGEAX_BROWSER_BACKEND ?? 'auto';
assert.ok(['auto', 'hardware', 'software'].includes(backend));
await mkdir(output, { recursive: true });
const browser = createBrowserCapture(root);
const evidence = { backendRequested: backend, captures: [], failedResponses: [] };
let activeSession;
const diagnostics = [];
try {
  const session = await browser.open({ backend, width: 1280, height: 720, outputDir: output });
  activeSession = session;
  const page = session.page;
  page.on('response', (response) => {
    if (response.status() < 400) return;
    diagnostics.push(response.text().then((body) => {
      evidence.failedResponses.push({ url: response.url(), status: response.status(), body: body.slice(0, 16000) });
    }).catch((error) => { evidence.failedResponses.push({ url: response.url(), error: String(error) }); }));
  });
  const frames = async (count) => {
    const start = await page.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted) || 0);
    await page.waitForFunction((end) => Number(document.documentElement.dataset.forgeaxFrameSubmitted) >= end, start + count, { timeout: 90000 });
    return { start, end: await page.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted)) };
  };
  const capture = async (name) => {
    const file = resolve(output, `${name}.png`);
    evidence.captures.push(await session.capture(undefined, { output: file }));
    return parseImage(await readFile(file), 'image/png', { mipmap: false }).unwrap();
  };
  const difference = (a, b) => {
    assert.equal(a.bytes.length, b.bytes.length);
    let changed = 0;
    for (let i = 0; i < a.bytes.length; i += 4) {
      if (a.bytes[i] !== b.bytes[i] || a.bytes[i + 1] !== b.bytes[i + 1] || a.bytes[i + 2] !== b.bytes[i + 2]) changed++;
    }
    return changed;
  };
  evidence.warmup = await frames(160);
  const before = await capture('before');
  await page.locator('canvas').click({ position: { x: 640, y: 360 } });
  await page.keyboard.down('KeyW');
  await frames(18);
  await page.keyboard.up('KeyW');
  await frames(40);
  const forward = await capture('forward');
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(820, 300, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await frames(40);
  const looked = await capture('look');
  evidence.pixelChanges = { keyboard: difference(before, forward), mouse: difference(forward, looked) };
  assert.ok(evidence.pixelChanges.keyboard > 1000, 'keyboard input changes the rendered view');
  assert.ok(evidence.pixelChanges.mouse > 1000, 'mouse input changes the rendered view');
  evidence.sustained = await frames(60);
  await capture('after-60-frames');
  evidence.run = session.report();
  assert.equal(evidence.run.pageErrors.length, 0);
  assert.equal(evidence.run.consoleErrors.length, 0);
  assert.equal(evidence.run.requests.failed, 0);
  assert.equal(evidence.run.requests.resourceMisses, 0);
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  if (activeSession) evidence.run = activeSession.report();
  await browser.close();
  await Promise.allSettled(diagnostics);
  evidence.closedAt = new Date().toISOString();
  evidence.boundary = 'Project browser smoke, not exact-package or 85-percent visual acceptance. Image changes do not prove released input state or GPU timings.';
  await writeFile(resolve(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: evidence.ok, output, error: evidence.error }));
}
