import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBrowserCapture } from '@forgeax/engine/devkit';

/**
 * Records the mech-gt Show in a browser (any WebGPU backend; `software` on hosts without a
 * GPU): for every segment, seek evenly spaced positions with the timeline slider and
 * capture each frame. Writes `frame-<segment>-<n>.png` and `frames.json` (cue and caption
 * of every frame) to FORGEAX_SHOW_OUT (default `artifacts/recording`).
 * FORGEAX_SHOW_STEPS=<segment:frames,...> overrides the frames per segment; a rerun into the
 * same directory keeps the frames already written.
 */
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.FORGEAX_SHOW_OUT ?? resolve(root, 'artifacts/recording'));
const backend = process.env.FORGEAX_BROWSER_BACKEND ?? 'auto';
const steps = Object.fromEntries(
  (process.env.FORGEAX_SHOW_STEPS ?? '').split(',').filter(Boolean).map((s) => s.split(':').map(Number)),
);
await mkdir(output, { recursive: true });
const browser = createBrowserCapture(root);
const record = { backend, frames: [], console: [] };
let session;
try {
  session = await browser.open({ backend, width: 1280, height: 720, outputDir: output, requireUi: true, headless: true });
  const page = session.page;
  page.on('console', (m) => record.console.push(m.text().slice(0, 300)));
  const submitted = () => page.evaluate(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted) || 0);
  const frames = async (count) => {
    const start = await submitted();
    await page.waitForFunction((end) => Number(document.documentElement.dataset.forgeaxFrameSubmitted) >= end, start + count, {
      timeout: 600000,
    });
  };
  const ui = (part) => page.locator(`[data-ui-part="${part}"]`);
  const chips = ui('segments').locator('button');
  await chips.first().waitFor({ timeout: 1800000 });
  // The startup loading screen covers the page until the program's assets are resident.
  await page.waitForFunction(() => document.getElementById('forgeax-loading')?.getAttribute('aria-hidden') !== 'false', undefined, {
    timeout: 1800000,
  });
  await frames(10);
  record.segments = await chips.allTextContents();
  for (const [segment, label] of record.segments.entries()) {
    const count = steps[segment] ?? (label.includes('transform') ? 48 : 20);
    await chips.nth(segment).click();
    if ((await ui('toggle').textContent())?.trim() === 'Pause') await ui('toggle').click();
    for (let i = 0; i < count; i++) {
      const position = Math.round((1000 * i) / Math.max(1, count - 1));
      const name = `frame-${segment}-${String(i).padStart(3, '0')}`;
      const file = resolve(output, `${name}.png`);
      // A rerun into the same directory resumes: frames already written are kept.
      if (existsSync(file)) continue;
      await ui('scrub').fill(String(position));
      // Two frames: the seek lands on the next update, the second frame shows it settled.
      await frames(2);
      // On a loaded software renderer one frame can outlast the capture timeout; retry.
      for (let attempt = 1; ; attempt++) {
        try {
          await session.capture(undefined, { output: file });
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await frames(1);
        }
      }
      record.frames.push({ name, segment, label, position, beat: await ui('beat').textContent() });
    }
    console.log(`${label}: ${count} frames`);
  }
  record.run = session.report();
  record.ok = record.run.pageErrors.length === 0;
  if (!record.ok) process.exitCode = 1;
} catch (error) {
  record.ok = false;
  record.error = String(error?.stack ?? error);
  record.fatal = await session?.page
    .locator('#forgeax-fatal')
    .textContent({ timeout: 1000 })
    .catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (session) record.run = session.report();
  await browser.close();
  await writeFile(resolve(output, 'frames.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ ok: record.ok, output, frames: record.frames.length, error: record.error }));
}
