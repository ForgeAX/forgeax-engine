import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBrowserCapture } from '@forgeax/engine/devkit';
import { parseImage } from '@forgeax/engine/image/parse-image';

/**
 * Browser journey of the Show project: boot through the Engine browser capture, wait for
 * the timeline UI, play, jump to segments with the chips, scrub the slider and step the
 * history with the arrow keys; every interaction must change the rendered frame and the
 * caption. FORGEAX_SHOW_SEQUENCE=<n> also captures n frames of the played timeline.
 */
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'artifacts/browser-smoke');
const backend = process.env.FORGEAX_BROWSER_BACKEND ?? 'auto';
const sequence = Number(process.env.FORGEAX_SHOW_SEQUENCE ?? 0);
await mkdir(output, { recursive: true });
const browser = createBrowserCapture(root);
const evidence = { backendRequested: backend, captures: [], captions: {} };
let session;
try {
  session = await browser.open({ backend, width: 1280, height: 720, outputDir: output, requireUi: true, headless: true });
  const page = session.page;
  evidence.console = [];
  page.on('console', (m) => evidence.console.push(m.text().slice(0, 300)));
  const frames = async (count) => {
    const start = await page.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted) || 0);
    await page.waitForFunction(
      (end) => Number(document.documentElement.dataset.forgeaxFrameSubmitted) >= end,
      start + count,
      { timeout: 180000 },
    );
  };
  const ui = (part) => page.locator(`[data-ui-part="${part}"]`);
  const capture = async (name) => {
    const file = resolve(output, `${name}.png`);
    evidence.captures.push(await session.capture(undefined, { output: file }));
    evidence.captions[name] = { beat: await ui('beat').textContent(), step: await ui('step').textContent() };
    return parseImage(await readFile(file), 'image/png', { mipmap: false }).unwrap();
  };
  const changed = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.bytes.length; i += 4) {
      if (Math.abs(a.bytes[i] - b.bytes[i]) + Math.abs(a.bytes[i + 1] - b.bytes[i + 1]) + Math.abs(a.bytes[i + 2] - b.bytes[i + 2]) > 12) n++;
    }
    return n;
  };
  await page.waitForFunction(() => document.querySelectorAll('*').length > 0);
  await ui('segments').locator('button').first().waitFor({ timeout: 600000 });
  await frames(60);
  const played = await capture('played-60');
  const chips = ui('segments').locator('button');
  evidence.segments = await chips.allTextContents();
  assert.ok(evidence.segments.length >= 6, 'the timeline lists the Show segments');
  // Chip: jump to the transformation and pause there via the slider.
  await chips.nth(1).click();
  await ui('scrub').fill('900');
  await frames(20);
  const transformed = await capture('transform-90');
  // Chip: history; arrow keys step through the build.
  const history = evidence.segments.findIndex((s) => s.endsWith('history'));
  await chips.nth(history).click();
  await ui('scrub').fill('0');
  await frames(20);
  const first = await capture('history-first');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await frames(20);
  const later = await capture('history-step-21');
  // Chip: the second subject on the polished turntable, where its mirror image shows.
  await chips.nth(evidence.segments.findIndex((s) => s.startsWith('panels') && s.endsWith('turntable'))).click();
  await ui('scrub').fill('0');
  await frames(20);
  await capture('panels-turntable');
  evidence.pixelChanges = {
    transform: changed(played, transformed),
    history: changed(first, later),
  };
  assert.ok(evidence.pixelChanges.transform > 2000, 'seeking the transformation changes the frame');
  assert.ok(evidence.pixelChanges.history > 500, 'stepping the history changes the frame');
  assert.notEqual(evidence.captions['history-first'].step, evidence.captions['history-step-21'].step);
  assert.match(evidence.captions['history-step-21'].step ?? '', /step 21\//);
  if (sequence > 0) {
    await chips.nth(0).click();
    await ui('toggle').click();
    for (let i = 0; i < sequence; i++) {
      await frames(4);
      await capture(`sequence-${String(i).padStart(4, '0')}`);
    }
  }
  evidence.run = session.report();
  assert.equal(evidence.run.pageErrors.length, 0);
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (session) evidence.run = session.report();
  await browser.close();
  await writeFile(resolve(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: evidence.ok, output, error: evidence.error }));
}
