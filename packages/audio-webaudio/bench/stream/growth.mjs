import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = resolve(root, 'artifacts/audio-stream');
const project = resolve(output, 'growth-project');
await mkdir(project, { recursive: true });
await writeFile(resolve(project, 'index.html'), `<html><body><script type="module" src="/@fs/${resolve(root, 'packages/audio-webaudio/bench/stream/growth.ts')}"></script></body></html>`);
const server = await createServer({ configFile: false, root: project, optimizeDeps: { noDiscovery: true }, server: { port: 5300, strictPort: true, fs: { allow: [root] } } });
const exec = promisify(execFile);
const report = { runs: [], memory: [] };
let browser;
try {
  await server.listen(); browser = await chromium.launch({ ...browserLaunch, headless: true, chromiumSandbox: true});
  report.browser = browser.version();
  const cdp = await browser.newBrowserCDPSession();
  const rootPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(row => row.type === 'browser').id;
  async function sample(label) {
    const { stdout } = await exec('ps', ['-axo', 'pid,ppid,rss,time,command']);
    const rows = stdout.trim().split('\n').slice(1).map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)?.slice(1)).filter(Boolean);
    const pids = new Set([rootPid]);
    for (let pass = 0; pass < 5; pass++) for (const row of rows) if (pids.has(Number(row[1]))) pids.add(Number(row[0]));
    const processes = rows.filter(row => pids.has(Number(row[0]))).map(row => ({ pid: Number(row[0]), parent: Number(row[1]), rssKiB: Number(row[2]), cpuTime: row[3], command: row[4] }));
    report.memory.push({ label, at: Date.now(), aggregateRssKiB: processes.reduce((sum, row) => sum + row.rssKiB, 0), processes });
  }
  for (let round = 1; round <= 3; round++) for (const [voices, destinations] of [[1, 1], [8, 4], [32, 16]]) {
    const page = await browser.newPage(); await page.goto('http://localhost:5300');
    await page.waitForFunction(() => globalThis.__busGrowth);
    const label = `${voices}-voices-${destinations}-fx-r${round}`;
    await sample(`${label}-cold`);
    let settled = false;
    const pending = page.evaluate(({ voices, destinations }) => globalThis.__busGrowth(voices, destinations), { voices, destinations });
    pending.then(() => settled = true, () => settled = true);
    while (!settled) { await sample(`${label}-work`); await new Promise(resolve => setTimeout(resolve, 100)); }
    const result = await pending;
    await writeFile(resolve(output, `growth-${label}.wav`), new Uint8Array(result.wav)); delete result.wav;
    report.runs.push({ label, ...result }); await page.close(); await sample(`${label}-released`);
  }
  console.log(JSON.stringify(report.runs.map(({ updatesMs, ...row }) => ({ ...row, updateP50: [...updatesMs].sort((a, b) => a - b)[15] }))));
} finally {
  await writeFile(resolve(output, 'bus-growth.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server.close();
}
