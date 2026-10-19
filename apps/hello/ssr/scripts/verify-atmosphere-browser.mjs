#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const root=fileURLToPath(new URL('../../../..',import.meta.url));
const out=resolve(process.env.FORGEAX_ATMOSPHERE_EVIDENCE ?? `${root}/artifacts/atmosphere/browser`);
const url=process.env.FORGEAX_ATMOSPHERE_URL ?? 'http://localhost:4173/';
const capture=process.argv.includes('--capture');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',headless:true,args:['--disable-features=MacAppCodeSignClone','--enable-unsafe-webgpu','--ignore-gpu-blocklist','--disable-gpu-driver-bug-workarounds','--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits','--use-angle=metal'], chromiumSandbox: true});
const page=await browser.newPage();
page.setDefaultTimeout(120000);
const errors=[];
page.on('pageerror',error=>errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error'||message.type()==='warning'){errors.push(message.text());console.error(message.type(),message.text());}});
const results=[],images=new Map();
const difference=(a,b,roi=[0,0,512,512])=>{
  const errors=[];let changed=0;
  for(let y=roi[1];y<roi[3];y++)for(let x=roi[0];x<roi[2];x++){
    const i=(y*512+x)*4;let d=0;
    for(let c=0;c<3;c++){const e=Math.abs(a[i+c]-b[i+c])/255;errors.push(e);d+=e;}
    if(d>3/255)changed++;
  }
  errors.sort((a,b)=>a-b);
  return {changed,mean:errors.reduce((a,b)=>a+b,0)/errors.length,p95:errors[Math.floor(errors.length*.95)],p99:errors[Math.floor(errors.length*.99)],max:errors.at(-1)};
};
function require(value,message){if(!value)throw new Error(message);}
try {
  await page.goto(`${url}?fixture=atmosphere&resolution=512&aa=none&timings`);
  await page.waitForFunction(()=>typeof globalThis.__setAtmosphereEvidence==='function');
  const run=async(name,settings)=>{
    console.log(`[atmosphere] ${name}`);
    const report=await page.evaluate(settings=>globalThis.__setAtmosphereEvidence(settings),settings);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const rgba=new Uint8Array(await page.evaluate(async()=>Array.from(await globalThis.__readReflectionPixels())));
    require(rgba.length===512*512*4,`${name}: incorrect readback size`);
    await writeFile(resolve(out,`${name}.png`),encodePng(512, 512, rgba));
    await writeFile(resolve(out,`${name}.rgba`),rgba);
    images.set(name,rgba);
    const row={name,settings,report,sha256:createHash('sha256').update(rgba).digest('hex')};
    results.push(row);
    if(capture && ['noon-ap','cloud','glass-neutral','volume','space','orthographic'].includes(name)){
      row.capture=await page.evaluate(async(name)=>{
        const frame=await globalThis.__forgeax.captureFrame();if(!frame.ok)throw new Error(JSON.stringify(frame.error));
        const response=await fetch(`/__forgeax-debug/tape?runId=atmosphere-${name}-${Date.now()}`,{method:'POST',headers:{'content-type':'application/x-forgeax-rhitape'},body:new Blob([frame.value.bytes])});
        if(!response.ok)throw new Error(`Tape publication failed ${response.status}`);return response.json();
      },name);
    }
    return rgba;
  };
  for(const[elevation,label]of[[60,'noon'],[10,'low'],[1,'sunset'],[-4,'twilight']]){
    await run(`${label}-ap`,{elevation,apScale:1,frames:4});
    await run(`${label}-no-ap`,{apScale:0,frames:4});
  }
  const baseline=await run('baseline',{elevation:60,apScale:1,frames:4});
  const far=difference(images.get('noon-ap'),images.get('noon-no-ap'),[350,170,490,265]);
  const sky=difference(images.get('noon-ap'),images.get('noon-no-ap'),[0,0,512,140]);
  require(far.mean>.01,'AP did not change distant objects');require(sky.p99<=1/255,'Disabling AP changed the sky');
  await run('fog',{fog:true});await run('fog-off',{fog:false});
  for(const panel of ['straight','premultiplied','additive']){
    const zero=await run(`${panel}-zero`,{panel,alpha:0});
    require(difference(baseline,zero).p99<=2/255,`${panel} alpha zero changed the backdrop`);
    const visible=await run(panel,{panel,alpha:.4});
    require(difference(zero,visible).changed>100,`${panel} positive control is invisible`);
    await run(`${panel}-off`,{panel:'off'});
  }
  const glass=await run('glass-neutral',{panel:'glass',transmission:1});
  const neutral=difference(baseline,glass);
  require(neutral.p99<=2/255,`Neutral glass fogged the backdrop twice: ${JSON.stringify(neutral)}`);
  await run('glass-opaque',{panel:'glass',transmission:0});await run('glass-off',{panel:'off'});
  const shadowed=await run('shadows',{shadows:true});
  const clouds=await run('cloud',{clouds:true,frames:60});
  require(difference(shadowed,clouds,[0,0,512,140]).changed>100,'Cloud positive control did not cover the visible sky');
  require([...clouds].filter((_,i)=>i%4===3).every(a=>a===255),'Cloud transport leaked into presentation alpha');
  await run('thin-cloud',{cloudCoverage:.15,frames:10});await run('cloud-off',{clouds:false});
  await run('volume',{volume:true});await run('volume-off',{volume:false});
  await run('orthographic',{orthographic:true});await run('perspective',{orthographic:false});
  await run('above-cloud',{clouds:true,altitude:2500,pitch:-10,frames:10});
  await run('space',{clouds:false,altitude:65000,pitch:-30,frames:4});
  await run('ground-return',{altitude:2,pitch:0,frames:4});
  await run('two-views',{multipleViews:true,frames:60});
  require(results.at(-1).report.inspection.views.length===2 && results.at(-1).report.inspection.views.every(view=>view.renderedFrames>=60),'Two cameras did not complete 60 independent views');
  await run('single-view-return',{multipleViews:false,frames:4});
  await run('taau-half-resolution',{dynamicScale:.5,frames:60});
  const extent=results.at(-1).report.inspection.dynamicResolution?.extent;
  require(extent?.internalWidth===256 && extent?.internalHeight===256 && extent?.outputWidth===512,'TAAU did not use half-resolution internal targets');
  await run('taa-camera-cut',{cameraX:1000,altitude:2000,pitch:-15,cameraCut:true,frames:1});
  require(results.at(-1).report.inspection.temporal.status==='reset','Camera cut did not reset temporal history');
  await run('taa-cut-settled',{frames:60});
  await run('full-resolution-return',{dynamicScale:1,cameraX:0,altitude:2,pitch:0,frames:4});
  await page.evaluate(()=>{const canvas=document.querySelector('canvas');document.documentElement.style.setProperty('--render-size','384px');canvas.width=384;canvas.height=384;});
  const resized=await page.evaluate(()=>__setAtmosphereEvidence({frames:4}));
  const resizedPixels=new Uint8Array(await page.evaluate(async()=>Array.from(await __readReflectionPixels())));
  require(resizedPixels.length===384*384*4,'Resize retained the previous output extent');
  await writeFile(resolve(out,'resized-384.png'),encodePng(384, 384, resizedPixels));
  results.push({name:'resized-384',report:resized,width:384,height:384});
  await page.evaluate(()=>{const canvas=document.querySelector('canvas');document.documentElement.style.setProperty('--render-size','512px');canvas.width=512;canvas.height=512;});
  await run('resize-return',{frames:4});
  require(errors.length===0,`Browser/GPU errors: ${JSON.stringify(errors)}`);
  const hash=async(path)=>createHash('sha256').update(await readFile(resolve(root,path))).digest('hex');
  const evidence={status:'pass',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiffSha256:createHash('sha256').update(execFileSync('git',['diff','HEAD'],{cwd:root})).digest('hex'),renderBuildSha256:await hash('packages/render/dist/construct-renderer.mjs'),browser:browser.version(),far,sky,neutralGlass:neutral,errors,results};
  await writeFile(resolve(out,'report.json'),`${JSON.stringify(evidence,null,2)}\n`);
  console.log(JSON.stringify({status:evidence.status,out,far,sky,neutralGlass:neutral}));
}finally{
  await writeFile(resolve(out,'partial.json'),`${JSON.stringify({errors,results},null,2)}\n`);
  await browser.close();
}
