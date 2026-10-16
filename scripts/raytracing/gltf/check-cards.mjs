import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { chromium } from 'playwright';
import UPNG from 'upng-js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const identity = args.at(-1) === '--identity';
if (identity) args.pop();
assert(args.length >= 2 && args.length <= 4);
const input = resolve(args[0]),
  output = resolve(args[1]);
const captureResolution = Number(args[2] ?? 32);
const probes = args[3] ? resolve(args[3]) : null;
assert(!identity || probes === null, 'identity replaces emission; it cannot feed Card lookups');
assert(Number.isInteger(captureResolution) && captureResolution >= 8 && captureResolution <= 512);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
  else if (e.text().startsWith('Cards:')) console.log(e.text());
});
const sizes = new Map();
await page.exposeFunction('saveCardChunk', async (name, offset, base64) => {
  assert(/^[a-zA-Z0-9_-]+\.(bin|json|rhitape)$/.test(name));
  assert.equal(offset, sizes.get(name) ?? 0);
  const bytes = Buffer.from(base64, 'base64');
  if (offset === 0) await writeFile(resolve(output, name), bytes);
  else await appendFile(resolve(output, name), bytes);
  sizes.set(name, offset + bytes.length);
});
const session = await browser.newBrowserCDPSession();
await session.send('Target.setDiscoverTargets', { discover: true });
const crashes = [];
session.on('Target.targetCrashed', (e) => {
  crashes.push(e);
  console.log('Cards: target-crashed', JSON.stringify(e));
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, input, resolution, probes, identity }) => {
      const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const render = await import(`/@fs/${root}packages/render/dist/internal.mjs`);
      const { createGltfResources } = await import(
        `/@fs/${root}scripts/raytracing/gltf/resources.mjs`
      );
      const load = async (name) =>
        new Uint8Array(await (await fetch(`/@fs/${input}/${name}`)).arrayBuffer());
      const send = async (name, bytes) => {
        for (let offset = 0; offset < bytes.length; offset += 262144) {
          const chunk = bytes.subarray(offset, offset + 262144);
          let binary = '';
          for (let i = 0; i < chunk.length; i += 8192)
            binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
          await window.saveCardChunk(name, offset, btoa(binary));
        }
      };
      const prepared = JSON.parse(new TextDecoder().decode(await load('prepared.json')));
      const data = JSON.parse(new TextDecoder().decode(await load('cards.json')));
      const recorder = debug.attachRecorder(gpu).unwrap();
      const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
      const device = (await adapter.requestDevice()).unwrap();
      const native = gpu._internal_getRawDevice(device._realDevice),
        gpuErrors = [];
      native.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const resources = await createGltfResources(
        device,
        recorder.backend.createShaderModule,
        prepared,
        load,
        (message) => console.log(`Cards: ${message}`),
      );
      console.log('Cards: preparing imported material capture');
      const start = performance.now();
      const identitySections = identity
        ? data.sources.flatMap((source) =>
            source.sections.map((section) => ({
              instance: source.instance.instanceId,
              geometry: source.instance.geometryId,
              indexOffset: section.indexOffset,
              indexCount: section.indexCount,
              material: section.material.id,
            })),
          )
        : [];
      if (
        identitySections.length > 2048 ||
        identitySections.some((s) => s.indexCount / 3 > 0x1000000)
      )
        throw Error('Card identity encoding capacity exceeded');
      const { instrumentCardIdentity } = await import(
        `/@fs/${root}scripts/raytracing/gltf/card-identity.mjs`
      );
      let compiledSections = 0;
      const compile = identity
        ? (device, desc) => {
            if (desc.label !== 'cards.material' || compiledSections >= identitySections.length)
              throw Error('unexpected Card identity compile');
            return recorder.backend.createShaderModule(device, {
              ...desc,
              code: instrumentCardIdentity(desc.code, compiledSections++),
            });
          }
        : recorder.backend.createShaderModule;
      const cards = (
        await render.createSurfaceCapture(
          device,
          compile,
          data.sources,
          { kind: 'cards', resolution },
          resources.resolveTexture,
        )
      ).unwrap();
      if (identity && compiledSections !== identitySections.length)
        throw Error('missing Card identity compile');
      const preparationMs = performance.now() - start;
      const { createSdfCardChains } = await import(
        `/@fs/${root}scripts/raytracing/gltf/sdf-card-chains.mjs`
      );
      const chains = await createSdfCardChains(
        device,
        recorder.backend.createShaderModule,
        cards,
        data.sources,
        probes,
      );
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const e = device.createCommandEncoder({ label: 'sponza-cards' }).unwrap();
      const submitStart = performance.now();
      cards.record(e).unwrap();
      for (const chain of chains) {
        chain.query.record(e).unwrap();
        chain.lookup.record(e).unwrap();
      }
      device.queue.submit([e.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const serialSubmitMs = performance.now() - submitStart;
      (await recorder.frameBoundary()).unwrap();
      const captured = (await capture).unwrap();
      console.log(`Cards: captured ${captured.bytes.length} bytes`);
      await send('cards.rhitape', captured.bytes);
      console.log('Cards: tape saved');
      const tape = debug.decodeTape(captured.bytes).unwrap(),
        model = debug.buildFrameModel(tape);
      const work = model.works.at(-1).workIndex;
      const descriptor = Object.fromEntries(
        Object.keys(cards.textures).map((name) => {
          const resource = model.resources.find(
            (r) =>
              r.descriptor?.kind === 'createTexture' && r.descriptor.desc.label === `cards.${name}`,
          );
          if (!resource) throw Error(`Missing ${name}`);
          return [name, resource.resourceId];
        }),
      );
      const readLive = async (name, texture) => {
        const bpp = name === 'depth' ? 4 : 8,
          row = cards.width * bpp,
          stride = Math.ceil(row / 256) * 256;
        const b = device.createBuffer({ size: stride * cards.height, usage: 9 }).unwrap();
        try {
          const e = device.createCommandEncoder({}).unwrap();
          e.copyTextureToBuffer(
            { texture },
            { buffer: b, bytesPerRow: stride },
            { width: cards.width, height: cards.height },
          );
          device.queue.submit([e.finish().unwrap()]).unwrap();
          const mapping = (await b.mapAsync(1)).unwrap();
          const mapped = new Uint8Array(mapping.getMappedRange().unwrap()).slice();
          mapping.unmap();
          const out = new Uint8Array(row * cards.height);
          for (let y = 0; y < cards.height; y++)
            out.set(mapped.subarray(y * stride, y * stride + row), y * row);
          return out;
        } finally {
          device.destroyBuffer(b);
        }
      };
      const live = {};
      for (const [name, texture] of Object.entries(cards.textures)) {
        live[name] = await readLive(name, texture);
        await send(`${name}.bin`, live[name]);
      }
      const chainReadbacks = [];
      const readBuffer = async (buffer, length) => {
        const stage = device.createBuffer({ size: length, usage: 9 }).unwrap();
        try {
          const encoder = device.createCommandEncoder({}).unwrap();
          encoder.copyBufferToBuffer(buffer, 0, stage, 0, length);
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          const mapped = (await stage.mapAsync(1)).unwrap();
          const bytes = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
          mapped.unmap();
          return bytes;
        } finally {
          device.destroyBuffer(stage);
        }
      };
      const chainWorks = model.works.slice(-2 * chains.length);
      for (const [i, chain] of chains.entries()) {
        const hits = await readBuffer(chain.query.buffers.hits, chain.query.rayCount * 64);
        const lookup = await readBuffer(
          chain.lookup.buffer,
          chain.query.rayCount * render.CARD_LOOKUP_STRIDE,
        );
        await send(`chain-${chain.section}-hits.bin`, hits);
        await send(`chain-${chain.section}-lookup.bin`, lookup);
        chainReadbacks.push({
          section: chain.section,
          rayCount: chain.query.rayCount,
          lookupStride: render.CARD_LOOKUP_STRIDE,
          queryWork: chainWorks[i * 2].workIndex,
          lookupWork: chainWorks[i * 2 + 1].workIndex,
          hitResource: chainWorks[i * 2].bindings.find((b) => b.binding === 3).resourceId,
          lookupResource: chainWorks[i * 2 + 1].bindings.find((b) => b.binding === 2).resourceId,
          hits,
          lookup,
        });
      }
      const facts = {
        mode: identity ? 'primitive-identity' : 'material',
        identitySections,
        chains: chainReadbacks.map(({ hits, lookup, ...row }) => row),
        width: cards.width,
        height: cards.height,
        resolution: cards.resolution,
        bytes: cards.bytes,
        entries: await Promise.all(
          cards.entries.map(async ({ captureKey, ...entry }) => ({
            ...entry,
            captureKeySha256: Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(captureKey)),
              ),
              (b) => b.toString(16).padStart(2, '0'),
            ).join(''),
          })),
        ),
        preparationMs,
        serialSubmitMs,
        scope: 'Single recorded preparation/submission is diagnostic, not steady-state performance',
        workIndex: work,
        works: model.works.map((w) => ({ workIndex: w.workIndex, eventIndex: w.eventIndex })),
        tapeDigest: captured.digest,
        unseededResources: model.unseededResources,
      };
      for (const chain of chains) {
        chain.lookup.dispose();
        chain.query.dispose();
      }
      cards.dispose();
      resources.dispose();
      (await recorder.dispose()).unwrap();
      native.destroy();
      const attachmentChecks = [];
      if (identity) {
        const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
        const raw = gpu._internal_getRawDevice(fresh);
        raw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const replay = (
          await debug.openReplay(tape, {
            device: fresh,
            createShaderModule: gpu.createShaderModule,
          })
        ).unwrap();
        try {
          for (const [name, id] of Object.entries(descriptor)) {
            const bytes = (await replay.readResourceAtWork(id, work)).unwrap().bytes;
            const expected = live[name];
            if (bytes.length !== expected.length || bytes.some((v, i) => v !== expected[i]))
              throw Error(`identity attachment replay mismatch ${name}`);
            attachmentChecks.push({ name, resource: id, workIndex: work, differentBytes: 0 });
          }
        } finally {
          (await replay.dispose()).unwrap();
          raw.destroy();
        }
      }
      const chainChecks = [];
      if (chains.length) {
        console.log('Cards: source device destroyed; replaying chain on a fresh device');
        const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
        const freshRaw = gpu._internal_getRawDevice(fresh);
        freshRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const replay = (
          await debug.openReplay(tape, {
            device: fresh,
            createShaderModule: gpu.createShaderModule,
          })
        ).unwrap();
        try {
          for (const chain of chainReadbacks) {
            const before = (await replay.readResource(chain.lookupResource)).unwrap().bytes;
            if (before.some((x) => x !== 0)) throw Error('lookup before work was nonzero');
            for (const [resource, index, expected] of [
              [chain.hitResource, chain.queryWork, chain.hits],
              [chain.lookupResource, chain.lookupWork, chain.lookup],
            ]) {
              const actual = (await replay.readResourceAtWork(resource, index)).unwrap().bytes;
              if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i]))
                throw Error(`chain replay differs: ${resource}`);
              chainChecks.push({
                section: chain.section,
                resource,
                workIndex: index,
                differentBytes: 0,
              });
            }
          }
        } finally {
          (await replay.dispose()).unwrap();
          freshRaw.destroy();
        }
        console.log('Cards: chain replay exact');
      }
      const report = {
        ...facts,
        attachmentChecks,
        chainChecks,
        resources: descriptor,
        gpuErrors,
        browser: navigator.userAgent,
        liveReplayEqual: identity ? true : null,
      };
      await send('capture.json', new TextEncoder().encode(JSON.stringify(report, null, 2)));
      return { width: facts.width, height: facts.height, works: facts.works.length, gpuErrors };
    },
    { root, input, resolution: captureResolution, probes, identity },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, []);
  await pipeline(
    createReadStream(resolve(output, 'cards.rhitape')),
    createGzip(),
    createWriteStream(resolve(output, 'cards.rhitape.gz')),
  );
  const facts = JSON.parse(await readFile(resolve(output, 'capture.json'), 'utf8'));
  const half = (v, i) => {
    const u = v.getUint16(i, true),
      e = (u >> 10) & 31,
      m = u & 1023;
    return (
      (u & 32768 ? -1 : 1) *
      (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15))
    );
  };
  const { width, height, resolution } = facts,
    a = await readFile(resolve(output, 'albedoRoughness.bin')),
    f = await readFile(resolve(output, 'f0Validity.bin'));
  const av = new DataView(a.buffer, a.byteOffset, a.length),
    fv = new DataView(f.buffer, f.byteOffset, f.length);
  const rgba = new Uint8Array(width * height * 4),
    mask = rgba.slice();
  let valid = 0,
    invalid = 0;
  for (let i = 0; i < width * height; i++) {
    const status = half(fv, i * 8 + 6);
    if (status === 1) valid++;
    else if (status !== 0) invalid++;
    const rgb = [0, 1, 2].map((c) => {
      const linear = Math.max(0, half(av, i * 8 + c * 2));
      return Math.round(
        255 *
          Math.min(1, linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055),
      );
    });
    rgba.set([...(status === 1 ? rgb : [190, 0, 170]), 255], i * 4);
    mask.set([...(status === 1 ? [40, 190, 70] : [190, 0, 170]), 255], i * 4);
  }
  for (const [name, bytes] of [
    ['albedo-atlas', rgba],
    ['validity-atlas', mask],
  ])
    await writeFile(
      resolve(output, `${name}.png`),
      new Uint8Array(UPNG.encode([bytes.buffer], width, height, 0)),
    );
  const report = {
    ...facts,
    valid,
    invalid,
    liveReplayEqual: identity ? true : null,
    gpuErrors: result.gpuErrors,
    browser: browser.version(),
  };
  report.artifacts = {};
  for (const name of ['cards.rhitape', ...Object.keys(facts.resources).map((n) => `${n}.bin`)]) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(resolve(output, name)), hash);
    report.artifacts[name] = hash.digest('hex');
  }
  await writeFile(resolve(output, 'capture.json'), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(invalid, 0);
  console.log(
    JSON.stringify({
      width,
      height,
      resolution,
      valid,
      invalid,
      works: report.works.length,
      bytes: report.bytes,
      liveReplayEqual: report.liveReplayEqual,
    }),
  );
} finally {
  await writeFile(resolve(output, 'target-crashes.json'), JSON.stringify(crashes, null, 2));
  await page.close();
  await browser.close();
}
