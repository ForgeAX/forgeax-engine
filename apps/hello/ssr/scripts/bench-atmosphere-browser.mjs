#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const resolution=Number(process.env.FORGEAX_ATMOSPHERE_RESOLUTION ?? 512);
const out=resolve(process.env.FORGEAX_ATMOSPHERE_EVIDENCE ?? 'artifacts/atmosphere/performance');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',headless:true,args:['--disable-features=MacAppCodeSignClone','--enable-unsafe-webgpu','--ignore-gpu-blocklist','--disable-gpu-driver-bug-workarounds','--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits','--use-angle=metal'], chromiumSandbox: true});
const page=await browser.newPage();page.setDefaultTimeout(120000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')errors.push(m.text());});
const summarize=values=>{const a=values.slice().sort((a,b)=>a-b);return{samples:a.length,p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1)}};
try {
  await page.goto(`${process.env.FORGEAX_ATMOSPHERE_URL ?? 'http://localhost:4173/'}?fixture=atmosphere&resolution=${resolution}&aa=none&timings`);await page.waitForFunction(()=>typeof __setAtmosphereEvidence==='function');
  const rows=[];
  for(const mode of ['disabled','cold','static','camera','sun','medium','static-shadows','camera-shadows','multiple-views','retired-views']) {
    console.log('[atmosphere benchmark]',mode);
    const settings=mode==='disabled'?{enabled:false}:{enabled:true,elevation:60,cameraX:0,mie:3.996e-6,shadows:mode.endsWith('shadows'),multipleViews:mode==='multiple-views'};
    const warm=await page.evaluate(settings=>__setAtmosphereEvidence({...settings,frames:settings.mode==='cold'?1:60}),{...settings,mode});
    const reports=mode==='cold'?[warm]:await page.evaluate(async mode=>{
      const reports=[];for(let i=0;i<120;i++){
        const update=mode==='camera'||mode==='camera-shadows'?{cameraX:Math.sin(i*.05)*20}:mode==='sun'?{elevation:60+i*.1}:mode==='medium'?{mie:3.996e-6*(1+.01*i)}:{};
        reports.push(await __setAtmosphereEvidence({...update,frames:1}));
      }return reports;
    },mode);
    const passes=new Map(),frame=[],cpu=[];
    for(const report of reports){cpu.push(...report.cpuDrawMilliseconds);for(const timing of report.timings){
      if(timing.status!=='complete'&&timing.status!=='partial')throw new Error(`GPU timestamps unavailable: ${JSON.stringify(timing)}`);
      let first, last=0n;
      for(const pass of timing.frame.passes){if(pass.status!=='measured'){if(pass.passKind==='copy')continue;throw new Error(`Unmeasured GPU pass ${pass.passName}`);}const samples=passes.get(pass.passName)??[];samples.push(pass.durationNanoseconds/1e6);passes.set(pass.passName,samples);const begin=BigInt(pass.beginningTick),end=BigInt(pass.endTick);first=first===undefined||begin<first?begin:first;last=end>last?end:last;}
      // Interval includes gaps and GPU work between measured boundaries. Copy
      // markers unavailable on this adapter remain explicitly unmeasured.
      if(first===undefined)throw new Error("No GPU timestamps");
      frame.push(Number(last-first)*timing.frame.timestampPeriodNanoseconds/1e6);
    }}
    await writeFile(resolve(out,`${mode}-timings.json`),`${JSON.stringify(reports.flatMap(report=>report.timings),null,2)}\n`);
    rows.push({mode,warmupFrames:mode==='cold'?0:60,completedSampleFrames:reports.length,gpuMeasuredSpanMs:summarize(frame),cpuWorldUpdateAndDrawMs:summarize(cpu),passes:Object.fromEntries([...passes].map(([name,v])=>[name,summarize(v)])),first:reports[0].inspection,last:reports.at(-1).inspection});
  }
  if(errors.length)throw new Error(JSON.stringify(errors));
  await writeFile(resolve(out,'report.json'),`${JSON.stringify({sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),renderBuildSha256:createHash('sha256').update(await readFile('packages/render/dist/construct-renderer.mjs')).digest('hex'),browser:browser.version(),resolution:[resolution,resolution],errors,rows},null,2)}\n`);console.log(out);
}finally{await browser.close()}
