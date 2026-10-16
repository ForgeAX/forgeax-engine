import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Exercise the real observer UI against the independent run owned by the fixture. */
export async function verifyRuntimeCapture({ page, root, runId, sameRun, updateImage }) {
  await page.locator('[data-page-id="page-display"]').click();
  const surface = page.locator('.fx-view-run-observer');
  const picture = surface.getByRole('img', { name: 'Latest Engine run capture', includeHidden: true });
  const summary = surface.getByRole('status');
  const bind = async id => {
    await surface.getByLabel('Observed project path').fill(root);
    await surface.getByLabel('Observed run ID').fill(id);
    await surface.getByRole('button', { name: 'Observe run', exact: true }).click();
  };
  const waitForImage = async () => {
    await picture.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => {
      const image = document.querySelector('.fx-view-run-observer img');
      return image?.complete && image.naturalWidth === 1280 && image.naturalHeight === 720;
    });
  };
  await bind(runId);
  await waitForImage();
  assert.match(await summary.innerText(), new RegExp(`Run ${runId.slice(0, 8)}`));
  // The independent run owns these DOM and Shadow DOM markers. Sampling the
  // displayed image proves this page presents the run's pixels, not the Editor.
  await page.waitForFunction(() => {
    const image = document.querySelector('.fx-view-run-observer img');
    if (!image?.complete || !image.naturalWidth) return false;
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return JSON.stringify([Array.from(context.getImageData(50, 60, 1, 1).data), Array.from(context.getImageData(50, 160, 1, 1).data)]) === '[[255,0,255,255],[0,255,255,255]]';
  }, undefined, { timeout: 30_000 });
  const firstFrame = Number((await summary.innerText()).match(/Frame (\d+)/)?.[1]);
  assert.ok(firstFrame >= 300);
  await page.screenshot({ path: '/tmp/view-runtime-capture-before.png' });
  await updateImage();
  await page.waitForFunction(() => {
    const image = document.querySelector('.fx-view-run-observer img');
    if (!image?.complete || !image.naturalWidth) return false;
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return JSON.stringify(Array.from(context.getImageData(50, 60, 1, 1).data)) === '[0,255,0,255]';
  }, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.fx-view-run-observer pre')?.textContent.includes('Runtime capture live update'), undefined, { timeout: 30_000 });
  await page.waitForFunction(frame => {
    const summary = document.querySelector('.fx-view-run-observer [role="status"]')?.textContent;
    return Number(summary?.match(/Frame (\d+)/)?.[1]) > frame;
  }, firstFrame, { timeout: 30_000 });
  const refreshedFrame = Number((await summary.innerText()).match(/Frame (\d+)/)?.[1]);
  assert.doesNotMatch(await summary.innerText(), /Stale image/);
  assert.equal(await surface.locator('canvas, iframe').count(), 0);
  await page.screenshot({ path: '/tmp/view-runtime-capture.png' });

  await page.setViewportSize({ width: 1000, height: 700 });
  const dimensions = await picture.evaluate(image => {
    const rect = image.getBoundingClientRect();
    const surface = image.closest('section').getBoundingClientRect();
    return { natural: [image.naturalWidth, image.naturalHeight], fits: rect.left >= surface.left && rect.right <= surface.right };
  });
  assert.deepEqual(dimensions, { natural: [1280, 720], fits: true });
  await page.screenshot({ path: '/tmp/view-runtime-capture-compact.png' });
  await sameRun();
  await page.locator('[data-page-id="page-editor"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-page-id="page-display"]').click();
  assert.equal(await surface.getByLabel('Observed run ID').inputValue(), runId);
  await waitForImage();

  await bind('missing-runtime-capture-proof');
  await page.waitForFunction(() => document.querySelector('.fx-view-run-observer [role="status"]')?.textContent.includes('no longer active'));
  assert.equal(await picture.getAttribute('src'), null, 'a wrong binding must clear the previous picture');
  await page.screenshot({ path: '/tmp/view-runtime-capture-missing.png' });
  await sameRun();
  await surface.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.fx-view-run-observer [role="status"]')?.textContent === 'No Engine run is connected.');
  assert.equal(await surface.getByLabel('Observed run ID').inputValue(), '');
  assert.equal(await surface.getByLabel('Observed project path').inputValue(), '');
  assert.equal(await picture.getAttribute('src'), null);
  await page.screenshot({ path: '/tmp/view-runtime-capture-disconnected.png' });
  await sameRun();
  await bind(runId);
  await waitForImage();
  await sameRun();
  await page.locator('[data-page-id="page-editor"]').click();
  const proof = { runId, firstFrame, refreshedFrame, pixelsUpdated: true, runLogUpdated: true, dimensions, wrongBindingClearsImage: true, disconnectPreservesRun: true, reconnect: true };
  await writeFile('/tmp/view-runtime-capture-proof.json', JSON.stringify(proof, null, 2));
  console.error('Runtime Capture UI: exact pixels, live refresh, resize, tab return, wrong binding, disconnect and reconnect passed', proof);
}
