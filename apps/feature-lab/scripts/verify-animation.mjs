// Browser effect, counter-control, actual palette readback, and fresh-device RHI replay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import launch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(process.env.ANIMATION_EVIDENCE ?? `${root}/artifacts/animation`);
const base = process.env.FEATURE_LAB_URL ?? 'http://127.0.0.1:5196';
mkdirSync(out, { recursive: true });
const native = process.env.ANIMATION_NATIVE_GPU === '1';
const launchOptions = native ? { ...launch, args: launch.args.filter((arg) => !arg.startsWith('--use-vulkan=') && !arg.startsWith('--enable-features=')), } : launch;
const browser = await chromium.launch({ ...launchOptions, headless: true, chromiumSandbox: true});
const browserGpu = (await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
const report = {
  browserGpu: { devices: browserGpu.devices, renderer: browserGpu.auxAttributes?.glRenderer },
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: 'browser-webgpu',
  nativeLaunchRequested: native,
  cases: [],
};
const difference = (a, b) => {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    sum += delta;
    max = Math.max(max, delta);
  }
  return { mean: sum / (a.length * 255), max };
};

try {
  for (const slug of (process.env.ANIMATION_FEATURES ?? 'property-animation,inverse-kinematics,skeleton-retargeting,animation-blending,timeline-root-motion').split(',')) {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 820 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    await page.exposeFunction('saveAnimationTapeChunk', (tag, chunk) =>
      appendFileSync(resolve(out, `${tag}.rhitape.partial`), Buffer.from(chunk, 'base64')),
    );
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${base}/?f=geometry-scene-animation/${slug}&animationEvidence=1`);
    await page.waitForFunction(
      () => window.__featureLab?.state === 'ready' || window.__featureLab?.state === 'failed',
      null,
      { timeout: 180000 },
    );
    assert.equal(await page.evaluate(() => window.__featureLab.state), 'ready');
    const waitFrames = async (frames) =>
      page.evaluate(
        (count) =>
          new Promise((resolve, reject) => {
            const canvas = document.getElementById('app');
            let completed = 0;
            let first;
            const timeout = setTimeout(() => {
              canvas.removeEventListener('forgeax:frame-completed', handler);
              reject(new Error(`only ${completed} completed frames`));
            }, 180000);
            function handler(event) {
              first ??= event.detail;
              if (++completed < count) return;
              clearTimeout(timeout);
              canvas.removeEventListener('forgeax:frame-completed', handler);
              resolve({ completed, first, last: event.detail });
            }
            canvas.addEventListener('forgeax:frame-completed', handler);
          }),
        frames,
      );
    const defaultAdapterInfo = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
      return { vendor, architecture, device, description, isFallbackAdapter };
    });
    const row = { slug, captures: [], checks: {}, errors, defaultAdapterInfo };
    const pngs = [];
    for (const enabled of [true, false]) {
      await page.evaluate((on) => window.__featureLab.toggle(on), enabled);
      const completedFrames = await waitFrames(60);
      const checks = await page.evaluate(() => window.__featureLab.checks());
      row.checks[enabled ? 'on' : 'off'] = checks;
      assert(checks.length > 0 && checks.every((check) => check.ok), JSON.stringify(checks));
      const png = await page.locator('#app').screenshot();
      const pixels = PNG.sync.read(png);
      pngs.push(pixels);
      writeFileSync(resolve(out, `${slug}.${enabled ? 'on' : 'off'}.png`), png);
      if (slug === 'property-animation') {
        // Inspect the fixed sphere region, excluding the grey background and floor.
        // A changed background or a black silhouette cannot satisfy this control.
        let orange = 0;
        let samples = 0;
        let luminance = 0;
        for (let y = Math.floor(pixels.height * 0.3); y < pixels.height * 0.48; y++) {
          for (let x = Math.floor(pixels.width * 0.4); x < pixels.width * 0.6; x++) {
            const i = (y * pixels.width + x) * 4;
            const [r, g, b] = pixels.data.subarray(i, i + 3);
            if (r > 40 && r > g * 1.15 && g > b * 1.15) orange++;
            luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
            samples++;
          }
        }
        row.visibility ??= {};
        row.visibility[enabled ? 'on' : 'off'] = {
          orangeFraction: orange / samples,
          meanLuminance: luminance / samples,
        };
        assert(
          orange / samples > 0.8,
          `property sample lost its illuminated orange sphere: ${orange / samples}`,
        );
        assert(luminance / samples > 20, 'property sample is too dark to compare');
        row.labels ??= {};
        row.labels[enabled ? 'on' : 'off'] = await page.locator('#lab-status').innerText();
        await page.screenshot({
          path: resolve(out, `${slug}.${enabled ? 'on' : 'off'}.page.png`),
        });
      }
      if (slug === 'timeline-root-motion') await page.screenshot({path:resolve(out, `${slug}.${enabled ? 'on' : 'off'}.page.png`)});
      const tag = `${slug}.${enabled ? 'on' : 'off'}`;
      rmSync(resolve(out, `${tag}.rhitape.partial`), { force: true });
      const evidence = JSON.parse(
        await page.evaluate(
          async ({ root, slug, enabled }) => {
            const debug = await import(`/@fs/${root}/packages/rhi-debug/dist/index.mjs`);
            const backend = await import(`/@fs/${root}/packages/rhi-webgpu/dist/index.mjs`);
            const captured = (await window.__forgeax.captureFrame()).unwrap();
            const tag = `${slug}.${enabled ? 'on' : 'off'}`;
            for (let offset = 0; offset < captured.bytes.length; offset += 1048576) {
              const data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(new Blob([captured.bytes.subarray(offset, offset + 1048576)]));
              });
              await window.saveAnimationTapeChunk(tag, data);
            }
            const tape = debug.decodeTape(captured.bytes).unwrap();
            const model = debug.buildFrameModel(tape);
            const adapter = (await backend.rhi.requestAdapter()).unwrap();
            const device = (
              await adapter.requestDevice(
                debug.replayDeviceRequest(tape, adapter.features, adapter.limits),
              )
            ).unwrap();
            const replay = (
              await debug.openReplay(tape, {
                device,
                createShaderModule: backend.createShaderModule,
              })
            ).unwrap();
            const palettes = [];
            try {
              for (const resource of model.resources.filter((resource) =>
                /skin-palette/.test(resource.descriptor?.desc?.label ?? ''),
              )) {
                const offsets = new Set();
                for (const work of model.works.filter((work) =>
                  work.bindings.some((binding) => binding.resourceId === resource.resourceId),
                )) {
                  const binding = work.bindings.find(
                    (binding) => binding.resourceId === resource.resourceId,
                  );
                  const offset = (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0);
                  if (offsets.has(offset)) continue;
                  offsets.add(offset);
                  const records = (
                    await debug.inspectBufferRecords(
                      replay,
                      resource.resourceId,
                      work.workIndex,
                      {
                        stride: 64,
                        fields: [0, 1, 2, 3].map((column) => ({
                          name: `column${column}`,
                          offset: column * 16,
                          type: 'f32',
                          components: 4,
                        })),
                      },
                      { first: offset / 64, count: 3 },
                    )
                  ).unwrap();
                  palettes.push({
                    resourceId: resource.resourceId,
                    workIndex: work.workIndex,
                    offset,
                    records: records.records,
                    bindings: work.bindings,
                    vertexBuffers: work.vertexBuffers,
                    pipeline: {
                      label: work.pipeline.descriptor?.desc?.label,
                      vertex: work.pipeline.descriptor?.desc?.vertex?.buffers,
                    },
                  });
                }
              }
              const last = model.works.findLast(
                (work) => work.attachments?.colorViewHandleIds.length > 0,
              );
              if (last === undefined) throw new Error('capture contains no color-producing work');
              const inspected = (
                await replay.inspectWork(last.workIndex, ['pipeline', 'bindings', 'pixels'])
              ).unwrap();
              const image = inspected.attachment;
              if (image === undefined) throw new Error('final work has no replay pixels');
              const rgba = debug.decodeToRgba8(
                image.bytes,
                image.format,
                image.width,
                image.height,
              );
              if (rgba === null) throw new Error('final replay format unsupported');
              let destructiveControl;
              let controlPng;
              if (enabled && palettes.length > 0) {
                const paletteIds = new Set(palettes.map((palette) => palette.resourceId));
                const added = new Map();
                const zeroBlob = (hash) => {
                  const original = tape.blobs.find((blob) => blob.hash === hash);
                  if (original === undefined) throw new Error('palette blob missing');
                  const bytes = new Uint8Array(original.bytes.length);
                  const replacement = debug.tapeDigest(bytes);
                  added.set(replacement, { hash: replacement, bytes, compression: 'none' });
                  return replacement;
                };
                const bootstrap = tape.bootstrap.map((resource) =>
                  paletteIds.has(resource.handleId)
                    ? {
                        ...resource,
                        initialData: resource.initialData.map((slice) => ({
                          ...slice,
                          hash: zeroBlob(slice.hash),
                        })),
                      }
                    : resource,
                );
                const events = tape.events.map((event) =>
                  event.kind === 'writeBuffer' && paletteIds.has(event.handleId)
                    ? { ...event, dataHash: zeroBlob(event.dataHash) }
                    : event,
                );
                if (added.size === 0) throw new Error('palette falsifier mutated no bytes');
                const blobs = [
                  ...tape.blobs.filter((blob) => !added.has(blob.hash)),
                  ...added.values(),
                ];
                const mutated = {
                  ...tape,
                  bootstrap,
                  events,
                  blobs,
                  header: { ...tape.header, blobCount: blobs.length },
                };
                const controlAdapter = (await backend.rhi.requestAdapter()).unwrap();
                const controlDevice = (
                  await controlAdapter.requestDevice(
                    debug.replayDeviceRequest(
                      mutated,
                      controlAdapter.features,
                      controlAdapter.limits,
                    ),
                  )
                ).unwrap();
                const control = (
                  await debug.openReplay(mutated, {
                    device: controlDevice,
                    createShaderModule: backend.createShaderModule,
                  })
                ).unwrap();
                try {
                  const pixels = (await control.inspectWork(last.workIndex, ['pixels'])).unwrap()
                    .attachment;
                  if (pixels === undefined) throw new Error('palette falsifier has no pixels');
                  const changed = debug.decodeToRgba8(
                    pixels.bytes,
                    pixels.format,
                    pixels.width,
                    pixels.height,
                  );
                  if (changed === null) throw new Error('palette falsifier format unsupported');
                  let sum = 0;
                  for (let i = 0; i < rgba.length; i++) sum += Math.abs(rgba[i] - changed[i]);
                  const mean = sum / (rgba.length * 255);
                  if (mean <= 0.001)
                    throw new Error(`zeroing bound palette failed to falsify output: ${mean}`);
                  destructiveControl = {
                    kind: 'zero-actual-bound-palette',
                    resourceIds: [...paletteIds],
                    replacementHashes: [...added.keys()],
                    pixelDifference: mean,
                  };
                  const canvas = document.createElement('canvas');
                  canvas.width = pixels.width;
                  canvas.height = pixels.height;
                  canvas
                    .getContext('2d')
                    .putImageData(new ImageData(changed, pixels.width, pixels.height), 0, 0);
                  controlPng = canvas.toDataURL('image/png');
                } finally {
                  (await control.dispose()).unwrap();
                }
              }
              const compact = {
                digest: captured.digest,
                formatVersion: tape.header.formatVersion,
                works: model.works.length,
                events: tape.events.length,
                unseededResources: model.unseededResources,
                lifecycle: {
                  scope: model.resourceLifecycle.scope,
                  counts: model.resourceLifecycle.counts,
                  bytes: model.resourceLifecycle.bytes,
                },
                finalWork: last.workIndex,
                finalFormat: image.format,
                width: image.width,
                height: image.height,
                palettes,
                destructiveControl,
                adapter: await (async () => {
                  const adapter = await navigator.gpu.requestAdapter();
                  const info = adapter?.info;
                  return { description: info?.description, vendor: info?.vendor, architecture: info?.architecture, device: info?.device, isFallbackAdapter: adapter?.isFallbackAdapter };
                })(),
              };
              const canvas = document.createElement('canvas');
              canvas.width = image.width;
              canvas.height = image.height;
              canvas
                .getContext('2d')
                .putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
              const result = JSON.stringify({
                compact,
                controlPng,
                replayPng: canvas.toDataURL('image/png'),
              });
              if (result.length > 8000000)
                throw new Error(`unexpected report size ${result.length}`);
              return result;
            } finally {
              (await replay.dispose()).unwrap();
            }
          },
          { root, slug, enabled },
        ),
      );
      renameSync(resolve(out, `${tag}.rhitape.partial`), resolve(out, `${tag}.rhitape`));
      if (evidence.controlPng !== undefined)
        writeFileSync(
          resolve(out, `${tag}.zero-palette.png`),
          Buffer.from(evidence.controlPng.split(',')[1], 'base64'),
        );
      const replayBytes = Buffer.from(evidence.replayPng.split(',')[1], 'base64');
      const replayPng = PNG.sync.read(replayBytes);
      writeFileSync(resolve(out, `${tag}.replay.png`), replayBytes);
      const live = pngs.at(-1);
      assert.equal(live.width, replayPng.width);
      assert.equal(live.height, replayPng.height);
      const replayDifference = difference(live.data, replayPng.data);
      assert(
        replayDifference.mean <= 0.05,
        `live/replay mismatch ${JSON.stringify(replayDifference)}`,
      );
      if (slug === 'animation-blending') {
        const blend = (angles, weights) => 2 * Math.atan2(
          angles.reduce((sum, a, i) => sum + Math.sin(a / 2) * weights[i], 0),
          angles.reduce((sum, a, i) => sum + Math.cos(a / 2) * weights[i], 0),
        );
        const upper = [blend([-0.9, 0.9], enabled ? [0.25, 0.75] : [1, 0]), blend([-0.9, 0.9, -1.2], enabled ? [0.25, 0.25, 0.5] : [1, 0, 0]), blend([-0.2, -1.2], [0.35, 0.65])];
        const lower = [0, 0, enabled ? -0.2 : blend([-0.2, 0.9], [0.35, 0.65])];
        const planar = (angle, x, y) => [Math.cos(angle), Math.sin(angle), 0, 0, -Math.sin(angle), Math.cos(angle), 0, 0, 0, 0, 1, 0, x, y, 0, 1];
        const references = [-2.7, 0, 2.7].map((x, i) => {
          const r = lower[i], u = upper[i], l = 1.4;
          const mx = x - l * Math.sin(r), my = 0.15 + l * Math.cos(r);
          const ex = mx - l * Math.sin(r + u), ey = my + l * Math.cos(r + u);
          return [planar(r, x, 0.15), planar(r + u, mx + l * Math.sin(r + u), my - l * Math.cos(r + u)), planar(r + u, ex + 2 * l * Math.sin(r + u), ey - 2 * l * Math.cos(r + u))];
        });
        const actual = evidence.compact.palettes.map((palette) => palette.records.map((record) => [0, 1, 2, 3].flatMap((column) => record.fields[`column${column}`])));
        assert(actual.length >= 3, 'not all three rigs have bound palettes');
        const errors = references.map((reference) => Math.min(...actual.map((palette) => Math.max(...reference.flat().map((value, i) => Math.abs(value - palette.flat()[i]))))));
        assert(errors.every((error) => error < 1e-4), `CPU reference / GPU palette mismatch: ${errors}`);
        evidence.compact.paletteReferenceMaxErrors = errors;
      }
      if (slug === 'timeline-root-motion') {
        const planar = (angle,x,y) => [Math.cos(angle),Math.sin(angle),0,0,-Math.sin(angle),Math.cos(angle),0,0,0,0,1,0,x,y,0,1];
        const references = [[enabled ? -1.5:-2.5,enabled ? -0.9:0],[2.5,enabled ? 0.9:0]].map(([x,angle]) => [
          planar(0,x,0.15),
          planar(angle,x+1.4*Math.sin(angle),0.15+1.4-1.4*Math.cos(angle)),
          planar(angle,x+1.4*Math.sin(angle),0.15+1.4-1.4*Math.cos(angle)),
        ]);
        const actual=evidence.compact.palettes.map(palette=>palette.records.map(record=>[0,1,2,3].flatMap(column=>record.fields[`column${column}`])));
        assert(actual.length>=2,'both motion and sub-animation rigs must reach GPU palettes');
        const errors=references.map(reference=>Math.min(...actual.map(palette=>Math.max(...reference.flat().map((value,i)=>Math.abs(value-palette.flat()[i]))))));
        assert(errors.every(error=>error<1e-4),`timeline CPU / bound GPU palette error: ${errors}`);
        evidence.compact.paletteReferenceMaxErrors=errors;
      }
      row.captures.push({ ...evidence.compact, completedFrames, replayDifference });
    }
    // Same page, resolution and rendering configuration; independent ABBA timing window.
    row.performance = [];
    for (const enabled of [true, false, false, true]) {
      await page.evaluate((on) => window.__featureLab.toggle(on), enabled);
      await waitFrames(60);
      await page.evaluate(() => { if (window.__animationEvidence) window.__animationEvidence.length = 0; });
      await waitFrames(120);
      row.performance.push({ enabled, samples: await page.evaluate(() => window.__animationEvidence ?? []) });
    }
    row.toggleDifference = difference(pngs[0].data, pngs[1].data);
    if (slug === 'property-animation') {
      assert.match(row.labels.on, /t=1 s/);
      assert.match(row.labels.off, /t=0 s/);
    }
    assert(
      row.toggleDifference.mean > 0.004,
      'feature-disabled counter-control did not change pixels',
    );
    if (slug !== 'property-animation') {
      assert(
        row.captures.every((capture) => capture.palettes.length > 0),
        'no actual bound skin palette',
      );
      assert.notDeepEqual(
        row.captures[0].palettes.map((palette) => palette.records),
        row.captures[1].palettes.map((palette) => palette.records),
        'disabled solver retained identical palette bytes',
      );
    }
    assert.deepEqual(errors, []);
    report.cases.push(row);
    writeFileSync(resolve(out, 'browser-rhi.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        slug,
        diff: row.toggleDifference.mean,
        captures: row.captures.map((capture) => ({
          digest: capture.digest,
          works: capture.works,
          palettes: capture.palettes.length,
          replayDifference: capture.replayDifference,
        })),
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
