import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const profiling = args.includes('--profile');
const cpuStages = args.includes('--cpu-stages');
if (profiling && cpuStages) throw new Error('--profile and --cpu-stages use separate observation windows');
if (args.includes('--warm-motion') && (profiling || cpuStages)) throw new Error('--warm-motion applies to ordinary throughput windows');
const option = (key, fallback) => { const i = args.indexOf(key); return i === -1 ? fallback : args[i + 1]; };
const output = option('--output', null);
if (!output) throw new Error('--output must name a directory outside the source checkout');
await mkdir(output, { recursive: true });
const label = option('--label', cpuStages ? 'native-cpu-stages' : profiling ? 'native-profile' : 'forgeax');
const url = new URL(option('--url', 'http://127.0.0.1:8848/?fly=1&pos=30,50,-40'));
if (profiling) url.searchParams.set('gpu-timing', '1');
if (cpuStages) url.searchParams.set('cpu-profile', '1');
const config = {
  url: url.href,
  warmMotion: args.includes('--warm-motion'),
  screenshot: resolve(output, `${label}.png`), staticMs: profiling ? 6000 : 8000, roundTrips: profiling ? 1 : 2,
};
const script = (await readFile(resolve(here, cpuStages ? 'stages-page.js' : profiling ? 'profile-page.js' : 'measure-page.js'), 'utf8')).replace('__CONFIG__', JSON.stringify(config));
const scriptPath = resolve(output, `${label}-driver.js`);
await writeFile(scriptPath, script);
const wrapper = process.env.FORGEAX_PWCLI ?? resolve(homedir(), '.codex/skills/forgeax-visual/scripts/pwcli-wrapper.py');
const child = spawn(wrapper, [`-s=${option('--session', 'robrun-port')}`, 'run-code', `--filename=${scriptPath}`], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let text = '';
child.stdout.on('data', chunk => { text += chunk; });
child.stderr.on('data', chunk => process.stderr.write(chunk));
const timer = setTimeout(() => { child.kill('SIGTERM'); }, 235000);
child.on('close', async code => {
  clearTimeout(timer);
  await writeFile(resolve(output, `${label}.txt`), text);
  const match = text.match(/### Result\n([\s\S]*?)\n###/);
  if (match) {
    const result = JSON.parse(match[1]);
    await writeFile(resolve(output, `${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ label, failed: result.failed, firstReadyMs: result.firstReadyMs,
      gpuObservations: result.gpu?.observations?.length,
      cpuCapture: result.capture?.value?.completeness, phaseReady: result.phaseAfter?.ready, sampledReady: result.cpuAfter?.ready,
      windows: result.windows?.map(w => ({ name: w.name, frames: w.draws.length, completed: w.ready.length, elapsedMs: w.elapsedMs, errors: w.errors.length })) }));
    process.exitCode = result.failed ? 1 : 0;
  } else { console.log(text.slice(-12000)); process.exitCode = code || 1; }
});
