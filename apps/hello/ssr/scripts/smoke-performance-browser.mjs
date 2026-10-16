import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { abbaIncrement, projectTimingFrame, summarizeSamples } from './smoke-performance-sequence-aggregation.mjs';

// Independent browser observation of the same production scene and timing owner.
// The unchanged Dawn budget remains a separate gate.
const directory=resolve(process.env.SSR_PERF_BROWSER_DIR ?? 'artifacts/browser-performance');
mkdirSync(directory,{recursive:true});
const selection=resolveBrowserWebGpuLaunch();
const browser=await chromium.launch({channel:process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',headless:false,args:selection.args, chromiumSandbox: true});
// The demo retains 24 px body padding and a canvas border on each side.
// Leave room for that layout so App's CSS-sized drawing buffer is 1920 wide.
const page=await browser.newPage({viewport:{width:1984,height:1280},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',error=>errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const runs=[];
try {
  await page.goto(`${process.env.SSR_PERF_BROWSER_URL ?? 'http://127.0.0.1:4419/'}?fixture=tiles&aa=none&resolution=1920&height=1080&timings=1`,{waitUntil:'domcontentloaded',timeout:180000});
  await page.waitForFunction(()=>globalThis.__inspectSsr?.().ssr.status==='admitted' && globalThis.__inspectSsrExecution().frame.completed>=60,null,{timeout:180000});
  await page.evaluate(()=>globalThis.__setSsrEvidencePaused(true));
  await page.waitForFunction(()=>globalThis.__inspectSsrExecution().frame.inFlight===0);
  const adapter=await page.evaluate(async()=>{
    const adapter=await navigator.gpu.requestAdapter();
    if(!adapter)throw new Error('Browser has no WebGPU adapter');
    const {vendor,architecture,device,description,isFallbackAdapter}=adapter.info;
    return {vendor,architecture,device,description,isFallbackAdapter};
  });
  assert.equal(adapter.isFallbackAdapter,false,'A software adapter cannot qualify a physical GPU measurement');
  for(const [orderIndex,enabled] of [false,true,true,false].entries()) {
    await page.evaluate(enabled=>globalThis.__setSsrEnabled(enabled),enabled);
    const rows=await page.evaluate(async()=>{
      const rows=[];
      for(let ordinal=1;ordinal<=180;ordinal++) {
        const canvas=document.querySelector('canvas');
        if(canvas.width!==1920 || canvas.height!==1080)
          throw new Error(`Benchmark drawing buffer must be 1920x1080, got ${canvas.width}x${canvas.height}`);
        const before=globalThis.__inspectSsrExecution().frame;
        const frame=await globalThis.__stepSsrEvidenceFrame(true);
        if(canvas.width!==1920 || canvas.height!==1080)
          throw new Error('Benchmark drawing buffer changed during a frame');
        const after=frame.execution.frame;
        if(after.submitted!==before.submitted+1 || after.completed!==before.completed+1 || after.inFlight!==0)
          throw new Error('Benchmark step must submit and complete exactly one App frame');
        rows.push({ordinal,drawingBuffer:{width:canvas.width,height:canvas.height},...frame});
      }
      return rows;
    });
    assert.equal(rows.length,180);
    assert.equal(new Set(rows.map(row=>row.frameId)).size,180);
    for(const row of rows) {
      assert.equal(row.timings?.status,'complete');
      assert.equal(row.execution.engine.realm,'host','Worker CPU cannot qualify host submission cost');
      assert.equal(row.execution.workers.render.enabled,false,'Worker submission is a separate CPU domain');
      assert.equal(row.inspection.ssr.status,enabled?'admitted':'not-requested');
    }
    const measured=rows.slice(120).map(row=>({frameId:row.frameId,cpuSubmissionMs:row.cpuSubmissionMs,intervals:projectTimingFrame(row.timings.frame)}));
    assert.ok(measured.every(row=>row.intervals.status==='complete'));
    const run={orderIndex,enabled,rows,window:{
      gpuEnvelope:summarizeSamples(measured.map(row=>row.intervals.coverage.all.envelopeNanoseconds/1e6)),
      cpuSubmission:summarizeSamples(measured.map(row=>row.cpuSubmissionMs)),
    }};
    runs.push(run);
    writeFileSync(resolve(directory,`${orderIndex}-${enabled?'on':'off'}.json`),JSON.stringify(run,null,2));
    const pixels=await page.evaluate(()=>document.querySelector('canvas').toDataURL('image/png').split(',')[1]);
    writeFileSync(resolve(directory,`${orderIndex}-${enabled?'on':'off'}.png`),Buffer.from(pixels,'base64'));
    console.log(JSON.stringify({orderIndex,enabled,gpuEnvelope:run.window.gpuEnvelope.p50Ms,cpuSubmission:run.window.cpuSubmission.p50Ms}));
  }
  assert.deepEqual(errors,[]);
  const git=args=>execFileSync('git',args,{cwd:new URL('../../../..',import.meta.url),encoding:'utf8'});
  const report={mode:'browser-production-physical-gpu-abba-diagnostic',adapter,backend:selection.selectedBackend,
    identity:{sourceHead:git(['rev-parse','HEAD']).trim(),trackedDiffSha256:createHash('sha256').update(git(['diff','HEAD','--binary'])).digest('hex')},
    protocol:{order:'off/on/on/off',resolution:[1920,1080],fixture:'tiles',antialias:'none',warmup:120,sample:60},
    abba:{gpuEnvelope:abbaIncrement(runs.map(run=>run.window),'gpuEnvelope'),cpuSubmission:abbaIncrement(runs.map(run=>run.window),'cpuSubmission')},
    cpuSemantics:'Synchronous paused App stepFrame callback; receipt completion and timing readback excluded. Host engine and render required.',
    runs:runs.map(run=>({orderIndex:run.orderIndex,enabled:run.enabled,window:run.window})),errors,
    budget:{status:'not-evaluated',reason:'Independent browser diagnostic; does not replace or correct the unchanged Dawn gate'}};
  writeFileSync(resolve(directory,'sequence.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.abba,null,2));
} finally {await browser.close();}
