// Real browser transport, quality controls, and RHI capture of the water consumer.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer, loadConfigFromFile } from 'vite';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, 'artifacts/planar-reflection/browser');
mkdirSync(output, { recursive: true });
process.env.FORGEAX_ENGINE_RHI_DEBUG = '1';
let server;
let browser;
const errors = [];
try {
  let url = process.argv[2];
  if (url === undefined) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(root, 'apps/preview/vite.config.ts'));
    assert(loaded, 'Preview configuration missing');
    server = await createServer({ ...loaded.config, configFile: false, root: resolve(root, 'apps/preview'), server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
    url = server.resolvedUrls?.local[0];
  }
  assert(url, 'Preview URL missing');
  const launch = JSON.parse(readFileSync(resolve(root, 'scripts/ci/browser-launch.json'), 'utf8'));
  browser = await chromium.launch({ ...launch, headless: true, chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(new URL('water.html?smoke', url).href, { waitUntil: 'domcontentloaded' });
  const waitFrames = async (count) => {
    await page.waitForFunction((minimum) => document.body.dataset.error || Number(document.body.dataset.frames ?? 0) >= minimum, count, { timeout: 180_000 });
    assert.equal(await page.evaluate(() => document.body.dataset.error), undefined);
  };
  await waitFrames(60);
  await page.locator('#waves').uncheck();
  await page.locator('#view').click();
  const qualities = [];
  for (const [resolution, interval] of [['256', '4'], ['1024', '1'], ['512', '2']]) {
    const before = await page.evaluate(() => Number(document.body.dataset.frames));
    await page.locator('#reflection-resolution').selectOption(resolution);
    await page.locator('#reflection-interval').selectOption(interval);
    await waitFrames(before + 12);
    const readback = await page.evaluate(async () => {
      const { app, reflectionTarget } = globalThis.__planarWater;
      const ticket = app.renderer.requestTargetReadback(reflectionTarget, { mipLevel: 0 });
      if (!ticket.ok) throw ticket.error;
      const receipt = await new Promise((done) => {
        const unsubscribe = app.renderer.subscribe((event) => {
          if (event.kind === 'frame-submitted') { unsubscribe(); done(event.receipt); }
        });
      });
      const observed = await app.renderer.observe(receipt, { include: ['target-readbacks'], targetReadbacks: [ticket.value] });
      if (!observed.ok) throw observed.error;
      const pixels = observed.value.targetReadbacks[0];
      return { width: pixels.width, height: pixels.height, bytes: pixels.bytes.length, bytesPerRow: pixels.bytesPerRow };
    });
    assert.equal(readback.bytesPerRow, Number(resolution) * 8);
    assert.equal(readback.bytes, Number(resolution) ** 2 * 8);
    qualities.push({ resolution, interval, readback });
  }
  // Capture every frame so this transaction contains the producer as well as water.
  await page.locator('#reflection-interval').selectOption('1');
  const capture = await page.evaluate(async () => {
    const result = await globalThis.__forgeax.captureFrame();
    if (!result.ok) throw result.error;
    const bytes = result.value.bytes;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return { digest: result.value.digest, base64: btoa(binary) };
  });
  const bytes = Buffer.from(capture.base64, 'base64');
  writeFileSync(resolve(output, 'water.rhitape'), bytes);
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const consumer = model.works.findLast((work) => work.pipeline.shaders.some((shader) => shader.stage === 'fragment' && shader.source?.includes('PlanarReflectionUniform')));
  assert(consumer, 'Water consumer absent from capture');
  const binding = consumer.bindings.find((entry) => entry.groupIndex === 1 && entry.binding === 15);
  const textureForView = (id) => {
    const descriptor = model.resources.find((resource) => resource.resourceId === id)?.descriptor;
    return descriptor?.kind === 'createTextureView' ? descriptor.sourceHandleId : undefined;
  };
  const reflectionTexture = textureForView(binding?.resourceId);
  assert(reflectionTexture, 'Water has no reflection texture');
  const producer = model.passes.find((pass) => pass.colorAttachmentViewHandleIds.some((id) => textureForView(id) === reflectionTexture));
  assert(producer?.workIndices.length, 'Reflection producer has no draws');
  assert(producer.workIndices.at(-1) < consumer.workIndex);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(output, 'water.png') });
  const evidence = { completedFrames: await page.evaluate(() => Number(document.body.dataset.frames)), qualities, digest: capture.digest, producerWorks: producer.workIndices, waterWork: consumer.workIndex, reflectionTexture, errors };
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  await server?.close();
}
