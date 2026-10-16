import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const destination = resolve(root, 'artifacts/asset-format-fidelity/browser-scale');
await mkdir(destination, { recursive: true });
const url = process.env.MESH_IO_URL;
if (url === undefined) throw new Error('MESH_IO_URL must name a prepared development server with MESH_IO_SCALE_ASSETS=1; prepare and Cook before acquiring the GPU performance lock');
const browser = await chromium.launch({ channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'], chromiumSandbox: true});
const browserSession = await browser.newBrowserCDPSession();
const raw = [], warmup = [];
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const trackedDiffSha256 = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex');
try {
  for (const triangles of [12, 10000, 120000]) {
    const sequence = [...['tight', 'strided', 'tight', 'strided'].map(layout => ({ layout, warmup: true, block: -1 })), ...Array.from({ length: 8 }, (_, block) => ['tight', 'strided', 'strided', 'tight'].map(layout => ({ layout, warmup: false, block }))).flat()];
    for (const trial of sequence) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await session.send('Performance.enable');
      const errors = [], requests = [], processSamples = [];
      page.on('pageerror', error => errors.push(error.stack));
      page.on('console', message => { if (message.type() === 'error' || /GPUValidation|validation error|uncaptured.*error|Error creating query set|Invalid (QuerySet|CommandBuffer)|While (validating|encoding)/i.test(message.text())) errors.push(message.text()); });
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await session.send('Network.enable');
      session.on('Network.loadingFinished', event => requests.push({ requestId: event.requestId, encodedDataLength: event.encodedDataLength }));
      let sampling = false;
      const sample = async () => {
        if (sampling) return;
        sampling = true;
        try {
          const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
          const ids = processInfo.map(process => process.id);
          const rows = execFileSync('ps', ['-p', ids.join(','), '-o', 'pid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
          const { metrics } = await session.send('Performance.getMetrics');
          processSamples.push({ at: Date.now(), processInfo, rssBytes: rows.reduce((sum, row) => sum + row[1] * 1024, 0), heapBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value });
        } finally { sampling = false; }
      };
      const timer = setInterval(() => { sample().catch(error => errors.push(String(error))); }, 100);
      let result;
      try {
        const started = performance.now();
        await page.goto(`${url}?scale=scale-${triangles}-${trial.layout}`);
        await page.waitForFunction(() => window.meshIoEvidence !== undefined);
        result = await page.evaluate(() => window.meshIoEvidence);
        await sample();
        const { metrics } = await session.send('Performance.getMetrics');
        if (!result.ok || result.results.length !== 1 || result.results[0].completedFrames !== 60 || errors.length) throw new Error(JSON.stringify({ result, errors }));
        const row = { triangles, ...trial, totalWallMs: performance.now() - started, loadAverage: loadavg(), browserMetrics: metrics, requests, processSamples, result: result.results[0] };
        (trial.warmup ? warmup : raw).push(row);
        if (!trial.warmup && trial.block === 0) await page.locator('canvas').screenshot({ path: resolve(destination, `${triangles}-${trial.layout}.png`) });
        await writeFile(resolve(destination, 'raw.json'), JSON.stringify({ sourceHead, trackedDiffSha256, measuredAt: new Date().toISOString(), cpu: cpus()[0].model, browser: await browser.version(), protocol: 'prepared real source/Cook/Catalog server; fresh browser Context + World + Renderer each trial, browser driver cache may persist; two excluded warmups/route/size; eight ABBA blocks; 60 completed frames/trial, first ten excluded from frame percentiles; 320x240 fixed-area textured triangle grid; native GPU timing envelopes, not pass sums; browser CPU task duration and sampled own-browser process RSS are separate from GPU resource allocation; totalWallMs includes module load/World/pipeline and 60 frames, loadMs only Catalog load + instantiate; CPU import stress benchmark uses a separately declared overlapping geometry', warmup, raw }, null, 2) + '\n');
        console.log(JSON.stringify({ triangles, ...trial, loadMs: row.result.loadMs, frameWallMs: row.result.frameWallMs }));
      } finally { clearInterval(timer); while (sampling) await new Promise(resolve => setTimeout(resolve, 10)); await context.close(); }
    }
  }
} finally { await browser.close(); }
