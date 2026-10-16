import { mkdir, writeFile, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, platform, loadavg } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { audioImporter } from '../../dist/audio-importer.mjs';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
const exec = promisify(execFile);
const mixedApps = process.argv.includes('--mix-apps-only');
const appsOnly = mixedApps || process.argv.includes('--apps-only');
const serverPort = mixedApps ? 5302 : appsOnly ? 5298 : 5296;
const reportName = mixedApps ? 'mixed-app-execution.json' : appsOnly ? 'app-execution.json' : 'performance.json';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = resolve(root, 'artifacts/audio-stream');
const fixtures = resolve(output, 'sources');
await mkdir(fixtures, { recursive: true });
if (mixedApps) {
  const bytes = Buffer.alloc(44 + 48000 * 2 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < 96000; frame++) bytes.writeInt16LE(Math.round(8192 * Math.sin(2 * Math.PI * 660 * frame / 48000)), 44 + frame * 2);
  await writeFile(resolve(fixtures, 'mixed-short.wav'), bytes);
  await writeFile(resolve(fixtures, 'mixed-short.wav.meta.json'), JSON.stringify({ schemaVersion: '1.0.0', kind: 'external-asset-package', importer: 'audio', importSettings: { playback: 'buffer' }, subAssets: [{ sourceKey: 'audio:audio', guid: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000901', kind: 'audio', sourceIndex: 0 }] }));
}
for (const minutes of appsOnly || process.argv.includes('--reuse-fixtures') ? [] : [0, 10, 60]) {
  const seconds = minutes ? minutes * 60 : 2;
  const path = resolve(fixtures, `${minutes}.wav`);
  const sampleRate = 48000, channels = 2, dataBytes = sampleRate * channels * 2 * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const chunk = Buffer.alloc(sampleRate * channels * 2);
  for (let frame = 0; frame < sampleRate; frame++) {
    const value = Math.round(8192 * (Math.sin(2 * Math.PI * 440 * frame / sampleRate) + Math.sin(2 * Math.PI * 8000 * frame / sampleRate)));
    for (let ch = 0; ch < channels; ch++) chunk.writeInt16LE(value, (frame * channels + ch) * 2);
  }
  const handle = await open(path, 'w'); await handle.write(header);
  for (let second = 0; second < seconds; second++) await handle.write(chunk);
  await handle.close();
  await writeFile(`${path}.meta.json`, JSON.stringify({ schemaVersion: '1.0.0', kind: 'external-asset-package',
    importer: 'audio', importSettings: { playback: minutes ? 'stream' : 'buffer' },
    subAssets: [{ sourceKey: 'audio:audio', guid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(minutes).padStart(12,'0')}`, kind: 'audio', sourceIndex: 0 }] }));
}
const binding = createStandaloneRuntimeAssetBinding('roi-audio-stream');
const requests = [];
const sourcePaths = ['packages/audio-webaudio/src/web-audio-engine.ts','packages/audio-webaudio/src/pcm-stream-player.ts','packages/audio-webaudio/src/bus-graph.ts','packages/audio/src/audio-intent.ts'];
const initialHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const pack = pluginPack({ roots: [fixtures], importers: [audioImporter], runtimeBinding: binding,
    producerReadiness: 'before-consume', ddc: { projectDdcRoot: resolve(output, appsOnly ? 'ddc-app' : 'ddc-finalizer') } });
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('.', import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  define: { __AUDIO_CATALOG__: JSON.stringify(binding.catalogUrl) },
  plugins: [
    { name: 'audio-request-evidence', configureServer(server) {
      server.middlewares.use((req, res, next) => { const at = Date.now(); res.on('finish', () => requests.push({ at, url: req.url, range: req.headers.range, status: res.statusCode, bytes: Number(res.getHeader('Content-Length') ?? 0) })); next(); });
    } }, pack, ...(appsOnly ? [forgeaxShader({ engineEntries: { pointShadows: true, hdrpSsao: true } })] : [])],
  server: { watch: null, port: serverPort, strictPort: true, fs: { allow: [root] }, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } } });
let browser;
const report = { hardware: { cpu: cpus()[0]?.model, platform: platform() }, fixtures: { sampleRate: 48000, channels: 2, encoding: 'RIFF PCM16', chunkSeconds: 1 }, runs: [], signals: [], memory: [], requests, sourceHashes: {} };
try {
  await server.listen();
  await pack.ready();
  console.log(JSON.stringify({catalogGuids:pack.catalogSnapshot().map(row => row.guid)}));
  browser = await chromium.launch({ ...browserLaunch, args: [...(browserLaunch.args ?? []), '--autoplay-policy=no-user-gesture-required'], headless: true, chromiumSandbox: true});
  report.browser = browser.version();
  const browserPid = browser.process?.()?.pid;
  // Playwright Browser does not expose process(); CDP returns its process inventory.
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send('SystemInfo.getProcessInfo');
  const rootPid = processes.processInfo.find(row => row.type === 'browser')?.id ?? browserPid;
  async function sample(label) {
    const { stdout } = await exec('ps', ['-axo', 'pid,ppid,rss,time,command']);
    const rows = stdout.trim().split('\n').slice(1).map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)?.slice(1)).filter(Boolean);
    const pids = new Set([Number(rootPid)]);
    for (let pass = 0; pass < 5; pass++) for (const row of rows) if (pids.has(Number(row[1]))) pids.add(Number(row[0]));
    const tree = rows.filter(row => pids.has(Number(row[0]))).map(row => ({ pid: Number(row[0]), parent: Number(row[1]), rssKiB: Number(row[2]), cpuTime: row[3], command: row[4] }));
    report.memory.push({ label, at: Date.now(), loadAverage: loadavg(), aggregateRssKiB: tree.reduce((sum,row) => sum+row.rssKiB,0), processes: tree });
  }
  for (let round = 1; round <= (appsOnly ? 0 : 3); round++) for (const [minutes, tier, count] of [[0,'main-serial',1],[10,'main-serial',1],[60,'main-serial',1],[60,'ecs-worker',1],[60,'main-serial',8],[60,'ecs-worker',32]]) {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(`http://localhost:${serverPort}`);
    await page.evaluate(url => globalThis.__audioCatalog=url, binding.catalogUrl);
    await page.waitForFunction(()=>globalThis.__streamEvidence);
    const label=`${minutes}m-${tier}-${count}-r${round}`;
    await sample(`${label}-cold`);
    const start = await page.evaluate(async ({minutes,tier,count})=>globalThis.__streamEvidence.start(minutes,tier,count),{minutes,tier,count});
    const states=[];
    for (let i=0;i<100;i++) { await sample(`${label}-play-${i}`); states.push(await page.evaluate(()=>globalThis.__streamEvidence.sample())); await new Promise(resolve=>setTimeout(resolve,100)); }
    const controls = minutes ? await page.evaluate(minutes=>globalThis.__streamEvidence.seeks(minutes),minutes) : null;
    const hot = await page.evaluate(count=>globalThis.__streamEvidence.hot(count),count);
    await new Promise(resolve=>setTimeout(resolve,800));
    const wav=await page.evaluate(()=>globalThis.__streamEvidence.wav());
    await writeFile(resolve(output,`${label}.wav`),new Uint8Array(wav.bytes)); delete wav.bytes;
    const stopped=await page.evaluate(()=>globalThis.__streamEvidence.stop()); await sample(`${label}-released`);
    report.runs.push({ label,start,hot,states,controls,wav,stopped,errors });
    await page.close();
    console.log(JSON.stringify({label,start,controls,stopped,errors}));
    await writeFile(resolve(output,reportName),JSON.stringify(report,null,2));
  }
  {
    const page = await browser.newPage(); await page.goto(`http://localhost:${serverPort}`);
    await page.waitForFunction(()=>globalThis.__streamEvidence);
    for (const row of appsOnly ? [] : await page.evaluate(()=>globalThis.__streamEvidence.signals())) {
      await writeFile(resolve(output, `bus-${row.variant}.wav`), new Uint8Array(row.bytes)); delete row.bytes;
      report.signals.push(row);
    }
    await page.close();
  }
  if (!appsOnly) {
    report.fullDecodeFalsifier = [];
    for (const minutes of [10,60]) {
      const page = await browser.newPage(); await page.goto(`http://localhost:${serverPort}`);
      await page.evaluate(url=>globalThis.__audioCatalog=url,binding.catalogUrl);
      await page.waitForFunction(()=>globalThis.__streamEvidence);
      await sample(`full-${minutes}-cold`);
      let finished = false;
      const pending = page.evaluate(minutes=>globalThis.__streamEvidence.fullDecode(minutes),minutes);
      pending.then(()=>finished=true,()=>finished=true);
      while(!finished) { await sample(`full-${minutes}-decode`); await new Promise(resolve=>setTimeout(resolve,100)); }
      report.fullDecodeFalsifier.push(await pending);
      await sample(`full-${minutes}-held`); await page.evaluate(()=>globalThis.__streamEvidence.stopBaseline());
      await page.close(); await sample(`full-${minutes}-released`);
    }
  }
  if (appsOnly) {
    report.apps = [];
    for (const tier of ['main-serial', 'engine-worker', 'shared']) {
      const page = await browser.newPage(); await page.goto(`http://localhost:${serverPort}`);
      await page.evaluate(url=>globalThis.__audioCatalog=url,binding.catalogUrl);
      await page.waitForFunction(()=>globalThis.__streamEvidence);
      let value;
      try {
        value = await page.evaluate(({ tier, mixedApps })=>globalThis.__streamEvidence.app(tier, 1, mixedApps),{ tier, mixedApps });
      } catch (error) {
        const wav = await page.evaluate(()=>globalThis.__streamEvidence.wav());
        await writeFile(resolve(output, `failed-${mixedApps ? 'mixed' : 'app'}-${tier}.wav`), new Uint8Array(wav.bytes)); delete wav.bytes;
        report.apps.push({ tier, status: 'failed', error: String(error), wav });
        throw error;
      }
      await writeFile(resolve(output, `${mixedApps ? 'mixed' : 'app'}-${tier}.wav`), new Uint8Array(value.wav.bytes)); delete value.wav.bytes;
      if (value.initialWav) {
        await writeFile(resolve(output, `${mixedApps ? 'mixed' : 'app'}-${tier}-initial.wav`), new Uint8Array(value.initialWav.bytes)); delete value.initialWav.bytes;
      }
      report.apps.push(value); console.log(JSON.stringify(value)); await page.close();
    }
  }
  for (const path of sourcePaths) {
    report.sourceHashes[path]=createHash('sha256').update(await readFile(resolve(root,path))).digest('hex');
    if (initialHashes[path] !== report.sourceHashes[path]) throw new Error(`source changed during measurement: ${path}`);
  }
} finally {
  await writeFile(resolve(output,reportName),JSON.stringify(report,null,2));
  await browser?.close(); await server.close();
}
