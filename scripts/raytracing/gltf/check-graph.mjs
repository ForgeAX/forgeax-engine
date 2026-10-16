import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const out = resolve(process.argv[2] ?? 'artifacts/ray-sponza-graph');
await mkdir(out, { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9737',
);
const page = await browser.newPage({ viewport: { width: 1320, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
});
page.setDefaultTimeout(600000);
const save = async (name, expression) => {
  const compressed = name.endsWith('.rhitape');
  const size = await page.evaluate(
    async ({ expression, compressed }) => {
      const bytes = Function(`return (${expression})`)();
      // Lossless transport only; replay still consumes the original tape bytes.
      window.__gltfTransfer = compressed
        ? new Uint8Array(
            await new Response(
              new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
            ).arrayBuffer(),
          )
        : bytes;
      return window.__gltfTransfer.byteLength;
    },
    { expression, compressed },
  );
  const transferred = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    const chunk = await page.evaluate((offset) => {
      const bytes = window.__gltfTransfer.subarray(offset, offset + 1024 * 1024);
      const parts = [];
      for (let i = 0; i < bytes.length; i += 32768)
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      return btoa(parts.join(''));
    }, offset);
    Buffer.from(chunk, 'base64').copy(transferred, offset);
  }
  await page.evaluate(() => {
    delete window.__gltfTransfer;
  });
  const bytes = compressed ? gunzipSync(transferred) : transferred;
  await writeFile(resolve(out, name), bytes);
  return bytes;
};
try {
  const url = process.env.FORGEAX_GLTF_URL ?? 'http://127.0.0.1:5197/';
  await page.goto(`${url}?resolution=64&samples=4`);
  await page.waitForFunction(
    () =>
      window.__gltfScene?.result ||
      document.querySelector('#status')?.textContent.startsWith('Startup failed'),
  );
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const info = adapter.info;
    return {
      userAgent: navigator.userAgent,
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    };
  });
  await writeFile(resolve(out, 'environment.json'), JSON.stringify(environment, null, 2));
  const graph = await page.evaluate(() => window.__gltfScene?.result?.report);
  assert(graph, await page.locator('#status').textContent());
  assert.equal(graph.graphOwned, true);
  assert(graph.counts.every((c) => c.invalid === 0 && c.incomplete === 0));
  await writeFile(resolve(out, 'graph.json'), JSON.stringify(graph, null, 2));
  await page.screenshot({ path: resolve(out, 'graph.png'), fullPage: true });
  for (const name of ['direct-reference', 'indirect-reference'])
    await page.locator(`#${name}`).screenshot({ path: resolve(out, `${name}.png`) });
  const raw = [],
    images = [];
  for (let i = 0; i < 2; i++) {
    raw.push(await save(`graph-${i}.bin`, `window.__gltfScene.result.raw[${i}]`));
    images.push(await save(`graph-${i}.rgba`, `window.__gltfScene.result.images[${i}]`));
  }
  const tape = await save('graph.rhitape', 'window.__gltfScene.result.tape.bytes');
  assert.equal(
    `sha256:${createHash('sha256').update(tape).digest('hex')}`,
    await page.evaluate(() => window.__gltfScene.result.tape.digest),
  );
  console.log('Captured graph sample; replaying on a fresh device');
  const replay = await page.evaluate(() => window.__gltfScene.replay());
  const imperative = await page.evaluate(() =>
    window.__gltfScene.render({ resolution: 64, samples: 4, graphOwned: false }),
  );
  const comparisons = [];
  for (let i = 0; i < 2; i++) {
    const actual = await save(`encoder-${i}.bin`, `window.__gltfScene.result.raw[${i}]`);
    const display = await save(`encoder-${i}.rgba`, `window.__gltfScene.result.images[${i}]`);
    assert.deepEqual(actual, raw[i]);
    assert.deepEqual(display, images[i]);
    comparisons.push({
      bounces: i + 1,
      rawBytes: actual.length,
      displayBytes: display.length,
      rawDifferences: 0,
      displayDifferences: 0,
    });
  }
  const off = await page.evaluate(async () => {
    const report = await window.__gltfScene.render({ resolution: 64, samples: 1, light: 0 });
    const sums = window.__gltfScene.result.raw.map((bytes) => {
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      let total = 0;
      for (let i = 0; i < floats.length; i += 20)
        total += floats[i] + floats[i + 1] + floats[i + 2];
      return total;
    });
    return { report, sums };
  });
  assert.deepEqual(off.sums, [0, 0]);
  assert(off.report.counts.every((c) => c.invalid === 0 && c.incomplete === 0));
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__gltfScene.errors), []);
  const report = {
    comparisons,
    tapeSha256: createHash('sha256').update(tape).digest('hex'),
    replay,
    graphTiming: graph.timing,
    encoderTiming: imperative.timing,
    off: { sums: off.sums, counts: off.report.counts },
    errors,
    scope:
      'Frozen Sponza reference transport graph equivalence; not ordinary Renderer GI or total-frame performance',
  };
  await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await page.evaluate(() => window.__gltfScene?.dispose()).catch(() => {});
  await page.close();
  await browser.close();
}
