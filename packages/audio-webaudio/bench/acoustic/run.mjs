import { spawn } from 'node:child_process';
import { arch, cpus, platform, loadavg, freemem, totalmem } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import launch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { inputIdentity } from './inputs.mjs';

if(process.env.FORGEAX_LOCAL_GPU_LEASE!=='1'||process.env.FORGEAX_LOCAL_GPU_LEASE_HELD!=='1')throw new Error('invoke this prepared native owner through FORGEAX_LOCAL_GPU_LEASE=1 node scripts/ci/local-gpu-lease.mjs --timeout-ms 2700000 -- node packages/audio-webaudio/bench/acoustic/run.mjs; the maintained entry supplies the held marker');

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = resolve(root, process.env.FORGEAX_AUDIO_EVIDENCE ?? `artifacts/roi22-acoustics/${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(output, { recursive: true });

const before = { load: loadavg(), freeMemory: freemem() };
const phase=process.env.FORGEAX_AUDIO_PHASE??'all';
const inputs=await inputIdentity(root);
const metadata = {phase,lease:{requested:process.env.FORGEAX_LOCAL_GPU_LEASE,held:process.env.FORGEAX_LOCAL_GPU_LEASE_HELD},environment:before,...inputs,startedAt:new Date().toISOString()};
await writeFile(resolve(output,'metadata.json'),`${JSON.stringify(metadata,null,2)}\n`);
if(phase!=='native'){
  let quiet;
  try{quiet=JSON.parse(await readFile(process.env.FORGEAX_AUDIO_QUIET_RECEIPT,'utf8'));}catch(error){
    await writeFile(resolve(output,'admission-refused.json'),JSON.stringify({reason:'fresh 60-second quiet receipt required',error:String(error)}));throw error;
  }
  await writeFile(resolve(output,'quiet-preflight.json'),`${JSON.stringify(quiet,null,2)}\n`);
  if(quiet.status!=='pass'||inputs.dirty!==''||JSON.stringify(quiet.inputs)!==JSON.stringify(inputs)||!Number.isFinite(quiet.endedAt)||Date.now()-quiet.endedAt>60000||quiet.endedAt>Date.now()||before.load[0]>3){
    await writeFile(resolve(output,'admission-refused.json'),JSON.stringify({reason:'stale, mismatched or non-quiet admission',before}));throw new Error('performance admission refused; retain receipt and obtain a fresh coordinated window');
  }
}
const server = process.env.FORGEAX_AUDIO_URL ? undefined : spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--config', 'packages/audio-webaudio/bench/acoustic/vite.config.mjs', '--port', '5296', '--strictPort'], { cwd: root, stdio: ['ignore','pipe','pipe'] });
let log = ''; server?.stdout.on('data', chunk => { log += chunk; }); server?.stderr.on('data', chunk => { log += chunk; });
let browser,page;const errors=[];
// Measure only this owner and its actual descendants. Summed RSS can count
// shared pages twice; it is observed process residency, not driver allocation.
const residency=[];let residencyPeak=0,sampling=true;
const sampleResidency=async()=>{
  try{
    const {stdout}=await promisify(execFile)('ps',['-axo','pid=,ppid=,rss='],{maxBuffer:4*1024*1024});
    const processes=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    const owned=new Set([process.pid]);let grew=true;
    while(grew){grew=false;for(const [pid,parent]of processes)if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);grew=true;}}
    const rows=processes.filter(([pid])=>owned.has(pid));const rssBytes=rows.reduce((n,row)=>n+row[2]*1024,0);
    residencyPeak=Math.max(residencyPeak,rssBytes);residency.push({at:new Date().toISOString(),rssBytes,processes:rows.map(([pid,parent,rssKiB])=>({pid,parent,rssKiB})),load:loadavg(),freeMemory:freemem()});
  }catch(error){residency.push({at:new Date().toISOString(),error:String(error)});}
};
const sampler=(async()=>{while(sampling){await sampleResidency();if(sampling)await new Promise(resolve=>setTimeout(resolve,1000));}})();
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (server && server.exitCode !== null) throw new Error(log);
    try { if ((await fetch(process.env.FORGEAX_AUDIO_URL ?? 'http://localhost:5296')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`startup timeout: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ ...launch, headless: true, args: [...launch.args, '--js-flags=--expose-gc'], chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  await page.exposeFunction('__saveAcousticEvidence', async (name, report) => {
    for (const [file,data] of Object.entries({...report.audioFiles,...report.binaryFiles})) await writeFile(resolve(output,file),new Uint8Array(data));
    delete report.audioFiles;delete report.binaryFiles;
    await writeFile(resolve(output,`${name}.json`),`${JSON.stringify(report,null,2)}\n`);
    console.log(JSON.stringify({checkpoint:name,output}));
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(phase=>{globalThis.__acousticPhase=phase;},phase);
  await page.goto(process.env.FORGEAX_AUDIO_URL ?? 'http://localhost:5296');
  await page.waitForFunction(() => globalThis.__acousticEvidence !== undefined);
  const report = await page.evaluate(async () => {
    try { return await globalThis.__acousticEvidence.run(); }
    catch (error) {
      // Playwright's Error transport omits the public AppError POD detail.
      // Preserve the original error and deadline before transport rethrows it.
      await globalThis.__saveAcousticEvidence('terminal-error', {
        name: error.name, message: error.message, stack: error.stack,
        code: error.code, expected: error.expected, hint: error.hint,
        detail: error.detail,
      });
      throw error;
    }
  });
  for (const [name, data] of Object.entries(report.audioFiles)) await writeFile(resolve(output,name), new Uint8Array(data));
  delete report.audioFiles;
  report.errors = errors;
  report.host = { arch: arch(), platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    before, after: { load: loadavg(), freeMemory: freemem() }, totalMemory: totalmem(), browser: browser.version() };
  const finalInputs=await inputIdentity(root);Object.assign(report,finalInputs);
  if(JSON.stringify(finalInputs)!==JSON.stringify(inputs)){report.status='fail';report.failures.push('source or built inputs changed during frozen gate');}
  await writeFile(resolve(output,'raw.json'), `${JSON.stringify(report,null,2)}\n`);
  await page.screenshot({ path: resolve(output,'signal-and-performance.png'), fullPage: true });
  console.log(JSON.stringify({ output, status: report.status, failures: report.failures, signals: report.signals.map(s=>({mode:s.mode,error:s.error,resources:s.resources})), rows: report.rows.length, errors }));
  if (report.status !== 'pass' || errors.length) process.exitCode = 1;
} catch (error) {
  await writeFile(resolve(output,'failure.txt'), `${error.stack}\n${log}\n${JSON.stringify(errors)}`);
  if(page)await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();if(server&&server.exitCode===null){const closed=new Promise(resolve=>server.once('close',resolve));server.kill('SIGTERM');await closed;}
  sampling=false;await sampler;await sampleResidency();
  await writeFile(resolve(output,'process-residency.json'),`${JSON.stringify({method:'summed ps RSS for owner PID and actual descendants; shared pages may be counted twice; samples include cleanup',ownerPid:process.pid,peakBytes:residencyPeak,samples:residency},null,2)}\n`);
  await writeFile(resolve(output,'server.log'), log);
}
