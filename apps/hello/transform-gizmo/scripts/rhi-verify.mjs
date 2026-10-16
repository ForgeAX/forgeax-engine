import { startGizmoHost, waitGizmoFrames } from './browser-host.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import {
  buildFrameModel,
  decodeTape,
  decodeToRgba8,
  openReplay,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import {
  bootstrapDawn,
  resolveBrowserWebGpuLaunch,
  selectCaptureWorkIndex,
} from '../../../shared/scripts/rhi-debug-verify.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const output = resolve(process.env.GIZMO_EVIDENCE_DIR ?? 'artifacts/transform-gizmo/rhi');
mkdirSync(output, { recursive: true });
const mode = process.env.GIZMO_MODE ?? 'rotate';
const host = await startGizmoHost({ capture: true });
const browser = await chromium
  .launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
    args: resolveBrowserWebGpuLaunch().args,
    chromiumSandbox: true,
  })
  .catch(async (error) => {
    await host.stop();
    throw error;
  });
const page = await browser.newPage({
  viewport: { width: 1180, height: 920 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
let captured, live;
async function transfer(globalName, size) {
  const chunks = [];
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    const encoded = await page.evaluate(
      ({ globalName, offset }) => {
        const bytes = globalThis[globalName].subarray(offset, offset + 1024 * 1024);
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192)
          s += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(s);
      },
      { globalName, offset },
    );
    chunks.push(Buffer.from(encoded, 'base64'));
  }
  return Buffer.concat(chunks);
}
try {
  await page.goto(host.url, { waitUntil: 'domcontentloaded' });
  await waitGizmoFrames(page);
  await page.click(`[data-mode=${mode}]`);
  const input = await page.evaluate((mode) => {
    const { scene } = globalThis.__gizmo;
    scene.sync();
    const f = scene.gizmo.frame;
    const canvas = document.querySelector('canvas'),
      rect = canvas.getBoundingClientRect();
    const point = (amount, angle) => {
      const p = f.origin.map(
        (n, i) =>
          n +
          f.radius *
            (mode === 'rotate'
              ? f.axes[0][i] * Math.cos(angle) + f.axes[1][i] * Math.sin(angle)
              : f.axes[0][i] * amount),
      );
      const s = f.project(p);
      return {
        x: rect.left + (s[0] * rect.width) / canvas.width,
        y: rect.top + (s[1] * rect.height) / canvas.height,
        handle: scene.gizmo.hitTest(s[0], s[1]),
      };
    };
    return {
      before: globalThis.__gizmo.pose(),
      from: point(mode === 'scale' ? 1 : 0.75, 0.35),
      to: point(mode === 'scale' ? 1.4 : 1.15, 1.1),
    };
  }, mode);
  assert.equal(input.from.handle, mode === 'rotate' ? 'Z' : 'X');
  await page.mouse.move(input.from.x, input.from.y);
  await page.mouse.down();
  assert(await page.evaluate(() => globalThis.__gizmo.scene.gizmo.dragging));
  await page.mouse.move(input.to.x, input.to.y, { steps: 16 });
  await page.mouse.up();
  const after = await page.evaluate(() => globalThis.__gizmo.pose());
  assert.notDeepEqual(after, input.before, 'real manipulation changes the authored pose');
  await page.mouse.move(20, 20);
  captured = await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    const capture = await globalThis.__forgeax.captureFrame();
    if (!capture.ok) throw new Error(JSON.stringify(capture.error));
    // Transfer bounded chunks; a large shadow snapshot must not become DevTools request postData.
    const compressed = new Uint8Array(
      await new Response(
        new Blob([capture.value.bytes]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );
    globalThis.__gizmoTape = compressed;
    const pixels = await globalThis.__captureGizmo();
    globalThis.__gizmoPixels = pixels;
    const canvas = document.querySelector('canvas');
    return {
      digest: capture.value.digest,
      rawBytes: capture.value.bytes.byteLength,
      compressedBytes: compressed.byteLength,
      pixelBytes: pixels.byteLength,
      width: canvas.width,
      height: canvas.height,
      frames: globalThis.__gizmo.frames(),
      pose: globalThis.__gizmo.pose(),
      origin: globalThis.__gizmo.scene.gizmo.frame.origin,
    };
  });
  const compressed = await transfer('__gizmoTape', captured.compressedBytes);
  live = await transfer('__gizmoPixels', captured.pixelBytes);
  writeFileSync(resolve(output, `${mode}.rhitape.gz`), compressed);
  const raw = gunzipSync(compressed);
  assert.equal(tapeDigest(raw), captured.digest);
  captured.input = { ...input, after };
  captured.archiveDigest = `sha256:${createHash('sha256').update(compressed).digest('hex')}`;
  captured.raw = raw;
  await page.screenshot({ path: resolve(output, `${mode}-screen.png`) });
  assert.equal(errors.length, 0, errors.join('\n'));
} finally {
  await browser.close();
  await host.stop();
}
const decoded = decodeTape(captured.raw);
assert(decoded.ok, JSON.stringify(decoded.error));
delete captured.raw;
const tape = decoded.value,
  model = buildFrameModel(tape);
const overlays = model.works.filter(
  (w) =>
    w.pipeline.descriptor?.desc?.depthStencil?.depthCompare === 'always' &&
    w.drawCall.kind === 'drawIndexed',
);
assert.equal(
  overlays.length,
  mode === 'rotate' ? 3 : mode === 'scale' ? 7 : 10,
  'overlay draw budget',
);
const { freshDevice, rhiWebgpu, backend } = await bootstrapDawn(
  'transform-gizmo',
  tape,
  process.platform === 'darwin' ? { backend: 'metal' } : {},
);
const opened = await openReplay(tape, {
  device: freshDevice,
  createShaderModule: rhiWebgpu.createShaderModule,
});
assert(opened.ok, JSON.stringify(opened.error));
const replay = opened.value,
  report = {
    mode,
    capture: captured,
    backend,
    unseededResources: model.unseededResources,
    workCount: model.works.length,
    resourceCount: model.resources.length,
    // Missing bootstrap bytes are a fact, so preserve the actual frame producers.
    initialContentAudit: model.unseededResources.map((u) => {
      const resource = model.resources.find((r) => r.resourceId === u.resourceId);
      const views = tape.bootstrap
        .filter(
          (b) => b.create.kind === 'createTextureView' && b.create.sourceHandleId === u.resourceId,
        )
        .map((b) => b.handleId);
      const writes = tape.events.flatMap((event, eventIndex) => {
        if (event.kind === 'copyBufferToBuffer' && event.destinationHandleId === u.resourceId)
          return [{ eventIndex, event }];
        if (
          event.kind === 'beginRenderPass' &&
          (views.includes(event.depthStencilViewHandleId) ||
            event.colorAttachmentViewHandleIds.some((id) => views.includes(id)))
        )
          return [{ eventIndex, event }];
        return [];
      });
      assert(writes.length > 0, `unseeded resource lacks a frame producer: ${u.resourceId}`);
      if (u.kind === 'buffer')
        assert.equal(
          writes.reduce((sum, w) => sum + w.event.size, 0),
          resource.descriptor.desc.size,
          'readback is fully overwritten',
        );
      else {
        const first = writes[0].event;
        if (views.includes(first.depthStencilViewHandleId))
          assert.equal(first.desc.depthStencilAttachment.depthLoadOp, 'clear');
        else assert(first.desc.colorAttachments.every((a) => a.loadOp === 'clear'));
      }
      return { resourceId: u.resourceId, descriptor: resource.descriptor, frameProducers: writes };
    }),
    overlay: [],
  };
try {
  for (const w of overlays) {
    const desc = w.pipeline.descriptor.desc;
    assert.equal(desc.depthStencil.depthWriteEnabled, false);
    assert.equal(desc.primitive.topology, 'triangle-list');
    const mesh = w.bindings.find((b) => b.groupIndex === 2 && b.binding === 0),
      material = w.bindings.find((b) => b.groupIndex === 1 && b.binding === 0);
    assert(mesh && material);
    const offset = (b) => (b.bufferOffset ?? 0) + (b.dynamicOffset ?? 0);
    const mb = await replay.readResourceAtWork(mesh.resourceId, w.workIndex);
    assert(mb.ok, JSON.stringify(mb.error));
    const pb = await replay.readResourceAtWork(material.resourceId, w.workIndex);
    assert(pb.ok, JSON.stringify(pb.error));
    const matrix = Array.from(
      new Float32Array(mb.value.bytes.buffer, mb.value.bytes.byteOffset + offset(mesh), 16),
    );
    const baseColor = Array.from(
      new Float32Array(pb.value.bytes.buffer, pb.value.bytes.byteOffset + offset(material), 4),
    );
    assert(matrix.every(Number.isFinite));
    const retained = w.vertexBuffers.every(
      (b) => model.resources.find((r) => r.resourceId === b.bufferHandleId)?.origin === 'bootstrap',
    );
    assert(retained, 'gizmo must reuse retained geometry');
    report.overlay.push({
      workIndex: w.workIndex,
      eventIndex: w.eventIndex,
      meshBinding: mesh,
      materialBinding: material,
      matrix,
      baseColor,
      retainedGeometry: retained,
      indexCount: w.drawCall.indexCount,
      pipeline: desc,
    });
  }
  assert(
    report.overlay.some((w) =>
      captured.origin.every((n, i) => Math.abs(n - w.matrix[12 + i]) < 1e-4),
    ),
    'GPU helper pivot follows the manipulated Scene target',
  );
  if (mode === 'rotate') {
    const matrices = report.overlay.map((w) =>
      w.matrix.map((n) => Math.round(n * 10000)).join(','),
    );
    assert.equal(new Set(matrices).size, 3, 'rotation rings must retain distinct GPU matrices');
    const colors = report.overlay.map((w) => w.baseColor.slice(0, 3).join(','));
    assert.equal(new Set(colors).size, 3, 'rotation rings must retain distinct GPU material slots');
  }
  const finalIndex = selectCaptureWorkIndex(model, 'pixel');
  const frame = await replay.inspectWork(finalIndex, ['pipeline', 'bindings', 'pixels']);
  assert(frame.ok, JSON.stringify(frame.error));
  const rt = frame.value.attachment;
  assert(rt && rt.width === captured.width && rt.height === captured.height);
  const pixels = decodeToRgba8(rt.bytes, rt.format, rt.width, rt.height);
  assert(pixels);
  let sum = 0,
    max = 0,
    coveredSum = 0,
    coveredCount = 0,
    over = 0;
  for (let i = 0; i < live.length; i += 4) {
    const covered = Math.max(live[i], live[i + 1], live[i + 2]) > 32;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(live[i + c] - pixels[i + c]) / 255;
      sum += d;
      max = Math.max(max, d);
      if (d > 0.05) over++;
      if (covered) {
        coveredSum += d;
        coveredCount++;
      }
    }
  }
  const mean = sum / ((live.length / 4) * 3),
    coveredMean = coveredSum / (coveredCount || 1);
  report.pixels = {
    finalWorkIndex: finalIndex,
    alignment: 'identity',
    mean,
    maxChannelDelta: max,
    coveredMean,
    channelsOverEpsilon: over,
    epsilon: 0.05,
  };
  writeFileSync(resolve(output, `${mode}-live.png`), writeReferencePng(live, rt.width, rt.height));
  writeFileSync(
    resolve(output, `${mode}-replay.png`),
    writeReferencePng(pixels, rt.width, rt.height),
  );
  writeFileSync(resolve(output, `${mode}-rhi-report.json`), JSON.stringify(report, null, 2));
  assert(mean <= 0.05 && max <= 0.05 && coveredMean <= 0.05, JSON.stringify(report.pixels));
  console.log(
    JSON.stringify(
      {
        mode,
        digest: captured.digest,
        draws: overlays.length,
        pixels: report.pixels,
        unseededResources: model.unseededResources.length,
      },
      null,
      2,
    ),
  );
} finally {
  await replay.dispose();
  freshDevice.destroy?.();
}
process.exit(0);
