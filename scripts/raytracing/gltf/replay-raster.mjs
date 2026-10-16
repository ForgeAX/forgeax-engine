import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';
import browserLaunch from '../../ci/browser-launch.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = resolve(process.argv[2] ?? 'artifacts/sponza-raster');
const name = process.argv[3] ?? 'baseline';
const remoteCdp = process.env.FORGEAX_RASTER_CDP;
const browser = remoteCdp
  ? await chromium.connectOverCDP(remoteCdp)
  : await chromium.launch({
      ...browserLaunch,
      headless: true,
      args: [
        ...browserLaunch.args,
        '--use-angle=swiftshader',
        '--js-flags=--max-old-space-size=8192',
      ],
      chromiumSandbox: true,
    });
const page = remoteCdp ? await browser.contexts()[0].newPage() : await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
  else if (e.text().startsWith('Stage:')) console.log(e.text());
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:5198/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, directory, name, stagesRequested }) => {
      const { rasterInitialization } = await import(
        `/@fs/${root}scripts/raytracing/gltf/raster-tape.mjs`
      );
      const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const bytes = new Uint8Array(
        await (await fetch(`/@fs/${directory}/${name}.rhitape`)).arrayBuffer(),
      );
      const live = new Uint8Array(
        await (await fetch(`/@fs/${directory}/${name}.rgba`)).arrayBuffer(),
      );
      const tape = debug.decodeTape(bytes).unwrap(),
        model = debug.buildFrameModel(tape);
      const initialization = rasterInitialization(model);
      const adapter = (await gpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(
          debug.replayDeviceRequest(tape, adapter.features, adapter.limits),
        )
      ).unwrap();
      const gpuErrors = [];
      gpu
        ._internal_getRawDevice(device)
        .addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const replay = (
        await debug.openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      try {
        const work = model.works.findLast((work) => work.attachments.colorViewHandleIds.length > 0);
        const output = (
          await replay.readResourceAtWork(work.attachments.colorViewHandleIds[0], work.workIndex)
        ).unwrap();
        if (output.bytes.length !== live.length) throw new Error('Live/replay dimensions differ');
        const channels = Array.from({ length: 4 }, () => ({ different: 0, max: 0, sum: 0 }));
        const bgra = output.format.startsWith('bgra');
        for (let i = 0; i < live.length; i++) {
          const c = i % 4,
            index = bgra && (c === 0 || c === 2) ? i + (c === 0 ? 2 : -2) : i;
          const d = Math.abs(output.bytes[index] - live[i]);
          channels[c].different += Number(d !== 0);
          channels[c].max = Math.max(channels[c].max, d);
          channels[c].sum += d;
        }
        const outputs = {};
        let stages;
        if (stagesRequested) {
          const { inspectRasterStages } = await import(
            `/@fs/${root}scripts/raytracing/gltf/raster-stages.mjs`
          );
          stages = await inspectRasterStages(model, replay, async (label, data) => {
            let binary = '';
            for (let i = 0; i < data.length; i += 8192)
              binary += String.fromCharCode(...data.subarray(i, i + 8192));
            outputs[label] = btoa(binary);
            console.log(`Stage: ${label}`);
          });
          const liveHdr = new Uint8Array(
            await (await fetch(`/@fs/${directory}/${name}-live-linear-hdr.bin`)).arrayBuffer(),
          );
          const hdr = Uint8Array.from(atob(outputs['direct-hdr.bin']), (c) => c.charCodeAt(0));
          const capture = await (await fetch(`/@fs/${directory}/${name}.json`)).json();
          const metadata = capture.observations.find((o) => o.domain === 'linear-hdr').metadata;
          let different = 0;
          for (let y = 0; y < output.height; y++)
            for (let x = 0; x < output.width * 8; x++)
              different += Number(
                hdr[y * output.width * 8 + x] !== liveHdr[y * metadata.bytesPerRow + x],
              );
          stages.liveHdrDifferentBytes = different;
          const visible = capture.observations.find((o) => o.domain === 'visible-surface');
          if (visible) {
            const liveSurface = new Uint8Array(
              await (
                await fetch(`/@fs/${directory}/${name}-live-visible-surface.bin`)
              ).arrayBuffer(),
            );
            const replaySurface = Uint8Array.from(atob(outputs['visible-surface.bin']), (c) =>
              c.charCodeAt(0),
            );
            if (replaySurface.byteLength !== output.width * output.height * 16)
              throw new Error('Visible surface replay dimensions differ');
            let differentBytes = 0;
            for (let y = 0; y < output.height; y++)
              for (let x = 0; x < output.width * 16; x++)
                differentBytes += Number(
                  replaySurface[y * output.width * 16 + x] !==
                    liveSurface[y * visible.metadata.bytesPerRow + x],
                );
            stages.visibleSurface = {
              differentBytes,
              bytes: replaySurface.byteLength,
              digest: debug.tapeDigest(replaySurface),
            };
          }
        }
        return {
          stages,
          outputs,
          initialization,
          digest: debug.tapeDigest(bytes),
          workIndex: work.workIndex,
          width: output.width,
          height: output.height,
          channels,
          gpuErrors,
          unseededResources: model.unseededResources,
        };
      } finally {
        (await replay.dispose()).unwrap();
        gpu._internal_getRawDevice(device).destroy();
      }
    },
    { root, directory, name, stagesRequested: process.argv.includes('--stages') },
  );
  for (const [label, bytes] of Object.entries(result.outputs)) {
    const data = Buffer.from(bytes, 'base64');
    await writeFile(resolve(directory, `${name}-${label}`), data);
    if (label.endsWith('.rgba'))
      await writeFile(
        resolve(directory, `${name}-${label.replace('.rgba', '.png')}`),
        writeReferencePng(data, result.width, result.height),
      );
  }
  delete result.outputs;
  await writeFile(
    resolve(directory, `${name}-browser-replay.json`),
    JSON.stringify({ ...result, errors }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, []);
  if (result.stages)
    assert.equal(
      result.stages.liveHdrDifferentBytes,
      0,
      'Lighting HDR must equal the captured live HDR',
    );
  if (result.stages?.visibleSurface)
    assert.equal(
      result.stages.visibleSurface.differentBytes,
      0,
      'Visible surface identities and geometric normals must survive fresh-device replay',
    );
  assert(
    result.channels.every((channel) => channel.max === 0),
    'Fresh Browser replay must equal the live frame',
  );
} finally {
  await page.close();
  await browser.close();
}
