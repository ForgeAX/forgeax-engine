import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Exercise the real observer UI against the independent run owned by the fixture. */
export async function verifyRuntimeCapture({ page, root, runId, sameRun, updateImage, bindExact }) {
  await page.locator('[data-page-id="page-display"]').click();
  const surface = page.locator('.fx-view-run-observer');
  const picture = surface.getByRole('img', { name: 'Latest Engine run capture', includeHidden: true });
  const summary = surface.getByRole('status');
  const metadata = surface.locator('.fx-capture-metadata');
  await surface.getByLabel('Capture source').selectOption('run');
  assert.equal(await surface.locator('input').count(), 0, 'known project and runtime identities must never require typing');
  const bind = () => surface.getByRole('button', { name: /View project run|Reconnect current run/ }).click();
  const waitForImage = async () => {
    await picture.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => {
      const image = document.querySelector('.fx-view-run-observer img');
      return image?.complete && image.naturalWidth === 1280 && image.naturalHeight === 720;
    });
  };
  await bind();
  await waitForImage();
  assert.match(await surface.locator('details pre').last().textContent(), new RegExp(`Run: ${runId}`));
  // The independent run owns these DOM and Shadow DOM markers. Sampling the
  // displayed image proves this page presents the run's pixels, not the Scene.
  await page.waitForFunction(() => {
    const image = document.querySelector('.fx-view-run-observer img');
    if (!image?.complete || !image.naturalWidth) return false;
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return JSON.stringify([Array.from(context.getImageData(50, 60, 1, 1).data), Array.from(context.getImageData(50, 160, 1, 1).data)]) === '[[255,0,255,255],[0,255,255,255]]';
  }, undefined, { timeout: 30_000 });
  const firstFrame = Number((await metadata.innerText()).match(/Frame (\d+)/)?.[1]);
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
    const summary = document.querySelector('.fx-view-run-observer .fx-capture-metadata')?.textContent;
    return Number(summary?.match(/Frame (\d+)/)?.[1]) > frame;
  }, firstFrame, { timeout: 30_000 });
  const refreshedFrame = Number((await metadata.innerText()).match(/Frame (\d+)/)?.[1]);
  assert.doesNotMatch(await metadata.innerText(), /Last captured image/);
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
  await page.locator('[data-page-id="page-scene"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-page-id="page-display"]').click();
  assert.match(await surface.locator('details pre').last().textContent(), new RegExp(`Run: ${runId}`));
  await waitForImage();

  await bindExact({ root, runId: 'missing-runtime-capture-proof' });
  await page.waitForFunction(() => document.querySelector('.fx-view-run-observer [role="status"]')?.textContent.includes('no longer active'));
  assert.equal(await picture.getAttribute('src'), null, 'a wrong binding must clear the previous picture');
  await page.screenshot({ path: '/tmp/view-runtime-capture-missing.png' });
  await sameRun();
  await surface.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.fx-view-run-observer [role="status"]')?.textContent === 'Connect to view the current project’s independent Engine run.');
  assert.equal(await surface.locator('input').count(), 0);
  assert.equal(await surface.getByRole('button', { name: 'Disconnect', exact: true }).isVisible(), false);
  assert.equal(await picture.getAttribute('src'), null);
  await page.screenshot({ path: '/tmp/view-runtime-capture-disconnected.png' });
  await sameRun();
  await bind();
  await waitForImage();
  await sameRun();
  await page.locator('[data-page-id="page-scene"]').click();
  const proof = { runId, firstFrame, refreshedFrame, pixelsUpdated: true, runLogUpdated: true, dimensions, wrongBindingClearsImage: true, disconnectPreservesRun: true, reconnect: true };
  await writeFile('/tmp/view-runtime-capture-proof.json', JSON.stringify(proof, null, 2));
  console.error('Runtime Capture UI: exact pixels, live refresh, resize, tab return, wrong binding, disconnect and reconnect passed', proof);
}
