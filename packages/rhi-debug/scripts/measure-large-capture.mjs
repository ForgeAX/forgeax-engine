#!/usr/bin/env node
// Browser large-capture upload probe: a synthetic >=800 MiB seeded frame is
// captured in headless Chromium and uploaded to the real Vite RHI-debug plugin.
//
//   CI=1 xvfb-run -a node packages/rhi-debug/scripts/measure-large-capture.mjs \
//        [--mb 832] [--mode upload|live-dev] [--out result.json]
//
// Reports wall-clock stage marks, peak renderer / GPU-process / dev-server RSS,
// peak V8 heap, and whether the page crashed.

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repo = resolve(pkg, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const mb = Number(option('--mb', '832'));
const mode = option('--mode', 'upload');
const outPath = option('--out', undefined);
const rootDir = resolve(option('--root', `/tmp/rhi-large-capture-${process.pid}`));

const { createServer } = await import(
  resolve(repo, 'packages/vite-plugin-rhi-debug/node_modules/vite/dist/node/index.js')
);
const { vitePluginRhiDebug } = await import(
  resolve(repo, 'packages/vite-plugin-rhi-debug/dist/index.mjs')
);
const { chromium } = await import(resolve(repo, 'node_modules/playwright/index.mjs'));

const server = await createServer({
  configFile: false,
  root: resolve(option('--page', resolve(here, 'large-capture'))),
  logLevel: 'warn',
  server: { port: 0, host: '127.0.0.1', fs: { allow: [repo] }, hmr: false, watch: null },
  plugins: [vitePluginRhiDebug({ rootDir })],
});
await server.listen();
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=swiftshader',
    '--disable-gpu-watchdog',
    '--ignore-gpu-blocklist',
    '--js-flags=--max-old-space-size=4096',
  ],
  chromiumSandbox: true,
});

function processTree() {
  const table = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${entry}/status`, 'utf8'))?.[1] ?? 0);
      table.set(Number(entry), { ppid, cmd, rssKb });
    } catch {}
  }
  return table;
}
const peaks = { rendererMiB: 0, gpuMiB: 0, devServerMiB: 0, jsHeapMiB: 0 };
const sampleProcesses = () => {
  const table = processTree();
  const rootPid = process.pid;
  const descendants = new Set();
  const visit = (pid) => {
    for (const [child, info] of table) {
      if (info.ppid === pid && !descendants.has(child)) {
        descendants.add(child);
        visit(child);
      }
    }
  };
  if (rootPid !== undefined) visit(rootPid);
  let renderer = 0;
  let gpu = 0;
  for (const pid of descendants) {
    const info = table.get(pid);
    if (info.cmd.includes('--type=renderer')) renderer = Math.max(renderer, info.rssKb);
    if (info.cmd.includes('--type=gpu-process')) gpu = Math.max(gpu, info.rssKb);
  }
  peaks.rendererMiB = Math.max(peaks.rendererMiB, Math.round(renderer / 1024));
  peaks.gpuMiB = Math.max(peaks.gpuMiB, Math.round(gpu / 1024));
  peaks.devServerMiB = Math.max(peaks.devServerMiB, Math.round(process.memoryUsage().rss / 2 ** 20));
};

const started = performance.now();
const page = await browser.newPage();
page.setDefaultTimeout(0);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
let crashed = false;
let crashAtMs;
const crash = new Promise((resolve) => {
  page.on('crash', () => {
    crashed = true;
    crashAtMs = Math.round(performance.now() - started);
    resolve({ ok: false, cause: 'renderer crashed', lastMark });
  });
});
let lastMark;
page.on('console', (message) => {
  if (message.text().startsWith('[large-capture]')) {
    lastMark = message.text();
    console.log(message.text());
  }
});
const timer = setInterval(async () => {
  sampleProcesses();
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
    peaks.jsHeapMiB = Math.max(peaks.jsHeapMiB, Math.round(heap / 2 ** 20));
  } catch {}
}, 100);

let result;
try {
  await page.goto(`${origin}/index.html?mb=${mb}&mode=${mode}`);
  await page.waitForFunction(() => globalThis.__largeCapture !== undefined, undefined, { timeout: 60_000 });
  result = await Promise.race([page.evaluate(() => globalThis.__largeCapture), crash]);
} catch (cause) {
  result = { ok: false, cause: String(cause).split('\n')[0] };
}
const totalMs = Math.round(performance.now() - started);
clearInterval(timer);
sampleProcesses();
const report = { mb, mode, crashed, crashAtMs, totalMs, peaks, result };
console.log(JSON.stringify(report, null, 2));
if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
await browser.close().catch(() => {});
await server.close();
rmSync(rootDir, { recursive: true, force: true });
process.exit(result?.ok === true && !crashed ? 0 : 1);
