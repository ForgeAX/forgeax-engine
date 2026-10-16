import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const appRoot = resolve(root, 'apps/showcase/canvas-texture');
const evidence = resolve(root, 'artifacts/canvas-texture/showcase');
await mkdir(evidence, { recursive: true });
const launch = JSON.parse(await readFile(resolve(root, 'scripts/ci/browser-launch.json'), 'utf8'));
const errors = [];
let server;
let browser;
const changes = {};
function difference(before, after) {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c]))) > 12) changed++;
  }
  return changed;
}
try {
  let url = process.env.FORGEAX_DEMO_URL;
  if (!url) {
    server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '0'], {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
    });
    const ready = await observeViteHttpReadiness(server, {
      timeoutEnvName: 'FORGEAX_DEMO_START_TIMEOUT_MS',
    }).wait();
    url = typeof ready === 'string' ? ready : ready.origin;
  }
  browser = await chromium.launch({
    channel: launch.channel,
    headless: true,
    args: [...launch.args, ...(process.env.CI ? ['--use-angle=swiftshader'] : [])],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1020 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.canvasShowcase?.submittedFrames >= 60 || !document.querySelector('#error').hidden,
  );
  assert.equal(
    await page.locator('#error').isVisible(),
    false,
    await page.locator('#error').textContent(),
  );
  await page.screenshot({ path: resolve(evidence, 'drawing-board.png'), fullPage: true });
  if (process.env.FORGEAX_DEMO_SCREENSHOT_ONLY === '1') process.exitCode = 0;
  else {
    const frames = async (count = 4) => {
      const target = await page.evaluate((n) => window.canvasShowcase.submittedFrames + n, count);
      await page.waitForFunction((n) => window.canvasShowcase.submittedFrames >= n, target);
    };
    const model = async () => {
      const canvas = page.locator('#world');
      await canvas.scrollIntoViewIfNeeded();
      const bounds = await canvas.boundingBox();
      assert.ok(bounds);
      const size = await canvas.evaluate((node) => ({ width: node.width, height: node.height }));
      // Fractional CSS placement adds an extra edge row to locator screenshots.
      // Compare the actual drawing-buffer extent at integer screenshot coordinates.
      return page.screenshot({
        clip: { x: Math.round(bounds.x), y: Math.round(bounds.y), ...size },
      });
    };
    const source = () => page.locator('#source').screenshot();
    const draw = async (y) => {
      await page.locator('#source').scrollIntoViewIfNeeded();
      const box = await page.locator('#source').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width * 0.16, box.y + box.height * y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * y, { steps: 16 });
      await page.mouse.up();
      await frames();
    };
    await page.locator('#clear').click();
    await frames();
    const blank = await model();
    await draw(0.35);
    changes.draw = difference(blank, await model());
    assert.ok(changes.draw > 150, 'Painting must change the model pixels');
    await page.locator('#sync').click();
    await frames();
    const frozen = await model();
    const oldCanvas = await source();
    await page.getByRole('button', { name: 'Purple brush' }).click();
    await draw(0.65);
    changes.pausedSource = difference(oldCanvas, await source());
    changes.pausedModel = difference(frozen, await model());
    assert.ok(changes.pausedSource > 150);
    assert.equal(changes.pausedModel, 0, 'Paused model must stay unchanged');
    await page.screenshot({ path: resolve(evidence, 'paused-drawing.png'), fullPage: true });
    await page.locator('#sync').click();
    await frames();
    changes.resumed = difference(frozen, await model());
    assert.ok(changes.resumed > 150);
    await page.screenshot({ path: resolve(evidence, 'resumed-drawing.png'), fullPage: true });
    const picture = PNG.sync.read(await model());
    const centroids = { orange: { sum: 0, count: 0 }, purple: { sum: 0, count: 0 } };
    for (let y = 0; y < picture.height; y++)
      for (let x = 0; x < picture.width; x++) {
        const i = (y * picture.width + x) * 4;
        const [r, g, b] = picture.data.subarray(i, i + 3);
        const tone =
          r > 180 && g > 40 && g < 150 && b < 110
            ? centroids.orange
            : b > 130 && r < 140 && g < 140
              ? centroids.purple
              : undefined;
        if (tone) {
          tone.sum += y;
          tone.count++;
        }
      }
    assert.ok(centroids.orange.count > 50 && centroids.purple.count > 50);
    assert.ok(
      centroids.purple.sum / centroids.purple.count > centroids.orange.sum / centroids.orange.count,
      'Canvas and model must have the same vertical orientation',
    );

    for (const mode of ['departures', 'telemetry']) {
      await page.locator(`[data-mode="${mode}"]`).click();
      await frames();
      const first = await model();
      await frames(40);
      changes[mode] = difference(first, await model());
      assert.ok(changes[mode] > 20, `${mode} must visibly animate`);
      await page.locator('#sync').click();
      await frames();
      const stopped = await model();
      const liveCanvas = await source();
      await frames(40);
      assert.equal(difference(stopped, await model()), 0, `${mode} model freezes`);
      assert.ok(difference(liveCanvas, await source()) > 20, `${mode} source continues`);
      await page.screenshot({ path: resolve(evidence, `${mode}.png`), fullPage: true });
      await page.locator('#sync').click();
      await frames();
    }
    await page.locator('[data-mode="paint"]').click();
    await frames();
    const straight = await model();
    await page.locator('#angle').fill('35');
    await page.locator('#angle').dispatchEvent('input');
    await frames();
    changes.rotation = difference(straight, await model());
    assert.ok(changes.rotation > 1000);
    await page.screenshot({ path: resolve(evidence, 'angled-sign.png'), fullPage: true });
    await page.locator('#angle').fill('-18');
    await page.locator('#angle').dispatchEvent('input');
    await frames();
    // Capture the actual showcase through App, then replay on a fresh WebGPU device.
    const captured = await page.evaluate(async () => {
      const artifact = (await window.canvasShowcase.app.rhiCapture.captureFrame()).unwrap();
      window.showcaseTape = artifact;
      window.canvasShowcase.app.pause().unwrap();
      return { digest: artifact.digest, byteLength: artifact.bytes.length };
    });
    const ref = {
      kind: 'rhi-tape',
      digest: captured.digest,
      path: resolve(evidence, 'canvas-showcase.rhitape'),
    };
    // Large raw POST bodies can exceed CDP's string limit. Persist bounded base64
    // chunks through the test transport; the bytes remain the canonical App tape.
    const tapeFile = await open(ref.path, 'w');
    try {
      for (let offset = 0; offset < captured.byteLength; offset += 1024 * 1024) {
        const chunk = await page.evaluate((start) => {
          const bytes = window.showcaseTape.bytes.subarray(start, start + 1024 * 1024);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return btoa(binary);
        }, offset);
        await tapeFile.write(Buffer.from(chunk, 'base64'));
      }
    } finally {
      await tapeFile.close();
    }
    assert.equal(
      `sha256:${createHash('sha256')
        .update(await readFile(ref.path))
        .digest('hex')}`,
      ref.digest,
      'Persisted chunks must preserve the App tape digest',
    );
    const capture = await page.evaluate(async (repoRoot) => {
      try {
        const app = window.canvasShowcase.app;
        const artifact = window.showcaseTape;
        delete window.showcaseTape;
        const { decodeTape, buildFrameModel, openReplay, replayDeviceRequest } = await import(
          `/@fs/${repoRoot}/packages/rhi-debug/dist/index.mjs`
        );
        const webgpu = await import(`/@fs/${repoRoot}/packages/rhi-webgpu/dist/index.mjs`);
        const tape = decodeTape(artifact.bytes).unwrap();
        const model = buildFrameModel(tape);
        const texture = model.resources.find(
          (row) =>
            row.kind === 'texture' &&
            row.descriptor?.desc?.size?.width === 800 &&
            row.descriptor?.desc?.size?.height === 500,
        );
        if (!texture || texture.descriptor.desc.format !== 'rgba8unorm-srgb')
          throw new Error('Canvas color texture missing');
        if (model.unseededResources.some((row) => row.resourceId === texture.resourceId))
          throw new Error('Canvas pixels were not captured');
        const views = new Set(
          model.resources
            .filter((row) => row.descriptor?.sourceHandleId === texture.resourceId)
            .map((row) => row.resourceId),
        );
        const canvasWork = model.works.find((row) =>
          row.bindings.some((binding) => views.has(binding.resourceId)),
        );
        if (!canvasWork) throw new Error('No work consumes the Canvas texture');
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const replay = (
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const canvasInspection = (
            await replay.inspectWork(canvasWork.workIndex, ['pipeline', 'bindings', 'pixels'])
          ).unwrap();
          if (!canvasInspection.attachment) throw new Error('Canvas draw has no pixels');
          const texturePixels = (
            await replay.readResourceAtWork(texture.resourceId, canvasWork.workIndex)
          ).unwrap();
          if (texturePixels.bytes.length !== 800 * 500 * 4)
            throw new Error('Canvas texture dimensions changed');
          const last = model.works.at(-1);
          if (!last) throw new Error('No work in captured frame');
          const inspection = (
            await replay.inspectWork(last.workIndex, ['pipeline', 'bindings', 'pixels'])
          ).unwrap();
          const pixels = inspection.attachment;
          if (!pixels) throw new Error('No replay pixels');
          const rgba = new Uint8ClampedArray(pixels.bytes);
          if (pixels.format.startsWith('bgra'))
            for (let i = 0; i < rgba.length; i += 4)
              [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
          const canvas = document.createElement('canvas');
          canvas.width = pixels.width;
          canvas.height = pixels.height;
          canvas
            .getContext('2d')
            .putImageData(new ImageData(rgba, pixels.width, pixels.height), 0, 0);
          return {
            works: model.works.map(({ workIndex, kind, eventIndex }) => ({
              workIndex,
              kind,
              eventIndex,
            })),
            unseededResources: model.unseededResources,
            canvasWorkIndex: canvasWork.workIndex,
            textureResourceId: texture.resourceId,
            textureFirstPixel: [...texturePixels.bytes.slice(0, 4)],
            selectedWorkIndex: last.workIndex,
            replayPng: canvas.toDataURL('image/png'),
          };
        } finally {
          await replay.dispose();
          app.resume().unwrap();
        }
      } catch (cause) {
        throw new Error(String(cause).slice(0, 2000));
      }
    }, root);
    await writeFile(
      resolve(evidence, 'showcase-replay.png'),
      Buffer.from(capture.replayPng.split(',')[1], 'base64'),
    );
    const replayPicture = Buffer.from(capture.replayPng.split(',')[1], 'base64');
    const livePicture = await model();
    changes.replay = difference(livePicture, replayPicture);
    const size = PNG.sync.read(livePicture);
    assert.ok(
      changes.replay / (size.width * size.height) < 0.05,
      'Fresh replay must match the live model',
    );
    delete capture.replayPng;
    capture.ref = ref;
    await writeFile(resolve(evidence, 'rhi-inspection.json'), JSON.stringify(capture, null, 2));
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Mobile layout must not overflow',
    );
    await page.screenshot({ path: resolve(evidence, 'mobile.png'), fullPage: true });
    await page.locator('#clear').click();
    await frames();
    const mobileBlank = await model();
    await draw(0.5);
    assert.ok(
      difference(mobileBlank, await model()) > 100,
      'Drawing also updates the model after resize',
    );
    const completedFrames = await page.evaluate(() => window.canvasShowcase.submittedFrames);
    await page.evaluate(() => window.canvasShowcase.dispose());
    assert.deepEqual(errors, []);
    await rm(resolve(evidence, 'failure.json'), { force: true });
    await writeFile(
      resolve(evidence, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          environment: process.env.CI ? 'software-gpu-diagnostic' : 'browser',
          url,
          submittedFrames: completedFrames,
          changes,
          errors,
          rhi: capture.ref,
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, submittedFrames: completedFrames, changes, evidence })}\n`,
    );
  }
} catch (error) {
  await writeFile(
    resolve(evidence, 'failure.json'),
    JSON.stringify({ error: String(error), errors }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        process.stderr.write(`Vite cleanup failed: ${error}\n`);
        process.exitCode = 1;
      }
    }
  }
}
