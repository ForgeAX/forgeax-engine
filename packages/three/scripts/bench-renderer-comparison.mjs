// Run from any directory after pnpm build:engine. Output is one JSON record per workload.
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: {
    host: '127.0.0.1',
    port: 0,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    forgeaxShader(),
    {
      name: 'comparison-entry',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><body></body>');
        });
      },
    },
  ],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.FORGEAX_BROWSER_CHANNEL ?? 'chrome',
    args: ['--enable-unsafe-webgpu'],
    chromiumSandbox: true,
  });
  const objects = Number(process.argv[2] ?? 256),
    frames = Number(process.argv[3] ?? 120);
  if (![objects, frames].every((v) => Number.isSafeInteger(v) && v > 0))
    throw Error('Expected positive object and frame counts');
  const materialKind = process.argv[4] ?? 'basic';
  if (!['basic', 'physical'].includes(materialKind)) throw Error('Expected basic or physical material');
  const url = server.resolvedUrls.local[0];
  for (const changed of [1, Math.ceil(objects / 10), objects]) {
    let reference;
    for (const lane of ['three', 'forgeax']) {
      const page = await browser.newPage();
      try {
        const profileDir = process.env.FORGEAX_RENDER_PROFILE_DIR;
        let memory;
        if (profileDir) {
          await mkdir(profileDir, { recursive: true });
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Profiler.enable');
          const events = [];
          cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
          await page.exposeFunction('beginRendererProfile', async () => {
            memory = { before: await cdp.send('Runtime.getHeapUsage') };
            await cdp.send('Tracing.start', {
              categories: 'devtools.timeline,blink.user_timing,v8',
              transferMode: 'ReportEvents',
            });
            await cdp.send('Profiler.start');
          });
          await page.exposeFunction('endRendererProfile', async () => {
            const { profile } = await cdp.send('Profiler.stop');
            memory.after = await cdp.send('Runtime.getHeapUsage');
            const stopped = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
            await cdp.send('Tracing.end');
            await stopped;
            const marker = events.find((e) => e.name === 'renderer-benchmark-start');
            if (!marker) throw Error('Missing measured renderer thread in trace');
            const finish = events.find(
              (e) =>
                e.name === 'renderer-benchmark-end' && e.pid === marker.pid && e.tid === marker.tid,
            );
            if (!finish) throw Error('Missing renderer end marker in trace');
            memory.collections = events
              .filter(
                (e) =>
                  e.pid === marker.pid &&
                  e.tid === marker.tid &&
                  e.ts >= marker.ts &&
                  e.ts <= finish.ts &&
                  e.ph === 'X' &&
                  (e.name === 'MinorGC' || e.name === 'MajorGC'),
              )
              .map((e) => ({ kind: e.name, ms: e.dur / 1000 }));
            const name = join(profileDir, `${lane}-${objects}-${changed}`);
            await writeFile(name + '.cpuprofile', JSON.stringify(profile));
            await writeFile(name + '.trace.json', JSON.stringify({ traceEvents: events }));
          });
        }
        await page.goto(url);
        await page.evaluate((input) => {
          globalThis.comparisonResult = import('/bench/renderer-comparison.mjs').then((mod) =>
            mod.runComparison(...input),
          );
        }, [lane, changed, objects, frames, materialKind]);
        const result = await page
          .waitForFunction(() => globalThis.comparisonResult, undefined, { timeout: 150_000 })
          .then((handle) => handle.jsonValue());
        const { coverageMask, ...timings } = result;
        const mask = Buffer.from(coverageMask, 'base64');
        let mismatchedPixels = 0;
        if (lane === 'three') reference = mask;
        else {
          if (reference.length !== mask.length) throw Error('Render extents differ');
          for (let i = 0; i < mask.length; i++) {
            for (let bits = reference[i] ^ mask[i]; bits; bits &= bits - 1) mismatchedPixels++;
          }
        }
        const percentiles = (xs) => {
          const sorted = [...xs].sort((a, b) => a - b);
          return [0.5, 0.95, 0.99].map((q) => sorted[Math.ceil(q * sorted.length) - 1]);
        };
        console.log(
          JSON.stringify({
            ...timings,
            browser: browser.version(),
            mismatchedPixels,
            memory,
            submitMs: percentiles(result.submit),
            completeMs: percentiles(result.complete),
            completedFrameIntervalMs: percentiles(result.intervals),
          }),
        );
        if (mismatchedPixels > result.foreground * 0.05)
          throw Error('Raster silhouettes diverged between renderers');
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
