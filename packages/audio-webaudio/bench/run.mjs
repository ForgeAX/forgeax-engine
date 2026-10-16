import { spawn } from 'node:child_process';
import { cpus, platform, arch, loadavg } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../..', import.meta.url));
const loadBefore = loadavg();
const spatial = process.argv.includes('--spatial');
const seek = process.argv.includes('--seek');
const output = resolve(
  root,
  process.env.FORGEAX_AUDIO_EVIDENCE ??
    (seek ? 'artifacts/g17-audio-seek' : spatial ? 'artifacts/g18-spatial-audio' : 'artifacts/audio-controls'),
);
await mkdir(output, { recursive: true });
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--config', 'packages/audio-webaudio/bench/vite.config.mjs'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverLogs = '';
server.stdout.on('data', (chunk) => (serverLogs += chunk));
server.stderr.on('data', (chunk) => (serverLogs += chunk));
let browser;
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(serverLogs);
    try {
      const response = await fetch('http://localhost:5295');
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Vite startup timeout: ${serverLogs}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ ...browserLaunch, headless: true, chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://localhost:5295/${seek ? 'seek.html' : spatial ? 'spatial.html' : ''}`);
  await page.waitForFunction(() => globalThis.__audioEvidence !== undefined);
  const report = await page.evaluate(() => globalThis.__audioEvidence.run());
  if (errors.length) throw new Error(JSON.stringify(errors));
  for (const [name, bytes] of Object.entries(report.audioFiles))
    await writeFile(resolve(output, name), new Uint8Array(bytes));
  delete report.audioFiles;
  report.errors = errors;
  report.host = { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, loadBefore, loadAfter: loadavg(), browser: browser.version() };
  report.sourceHashes = {};
  for (const file of [
    'packages/audio-webaudio/src/web-audio-engine.ts',
    'packages/audio-webaudio/src/host-audio-consumer.ts',
    'packages/audio/src/audio-intent.ts',
    'packages/audio/src/audio-tick-system.ts',
    ...(seek ? ['packages/audio/src/components.ts', 'packages/audio-webaudio/bench/seek-evidence.ts'] : []),
    ...(spatial
      ? [
          'packages/audio/src/plugin-factory.ts',
          'packages/audio/src/components.ts',
          'packages/audio-webaudio/bench/spatial-evidence.ts',
        ]
      : []),
  ])
    report.sourceHashes[file] = createHash('sha256')
      .update(await readFile(resolve(root, file)))
      .digest('hex');
  await writeFile(resolve(output, 'performance.json'), `${JSON.stringify(report, null, 2)}\n`);
  await page.screenshot({ path: resolve(output, 'signal-and-performance.png'), fullPage: true });
  console.log(
    JSON.stringify({
      output,
      status: report.status,
      rates: report.rates,
      bands: report.bands,
      rows: report.rows?.map(({ raw, rawMs, ...row }) => row),
      offline: report.offline,
    }),
  );
  if (seek && report.status !== 'pass') process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
