import { encodePng } from '@forgeax/engine-image/png';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';

import { measureMotionRecovery } from './check-motion-recovery.mjs';

// Uses the real dev-server Pack path and the public App paused-frame driver.
const directory = resolve(process.env.SSR_MOTION_BROWSER_DIR ?? new URL('../../../../artifacts/ssr-quality/browser-motion',import.meta.url).pathname);
const antialias = process.env.SSR_ANTIALIAS ?? 'taa';
assert.ok(['none','taa','taau','taa-dynamic'].includes(antialias));
const usesTaa = antialias !== 'none';
mkdirSync(directory,{recursive:true});
const selection = resolveBrowserWebGpuLaunch();
const browser = await chromium.launch({channel:process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',headless:false,args:selection.args, chromiumSandbox: true});
const page = await browser.newPage({viewport:{width:1200,height:1200},deviceScaleFactor:1});
const errors = [];
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error' || (m.type()==='warning' && /WebGPU|validation/i.test(m.text()))) errors.push(m.text());});
try {
  await page.goto(`${process.env.SSR_MOTION_BROWSER_URL ?? 'http://127.0.0.1:4418/'}?fixture=objects&resolution=1024&aa=${antialias}`,{waitUntil:'domcontentloaded',timeout:180000});
  await page.waitForFunction(()=>typeof globalThis.__inspectSsr==='function',null,{timeout:180000});
  const requested = await page.evaluate(()=>globalThis.__inspectSsr().ssr.status);
  assert.notEqual(requested,'not-requested','Start the reflection carrier with VITE_REFLECTION_PROBE_EVIDENCE=1');
  await page.waitForFunction(usesTaa=>{
    const renderer=globalThis.__inspectSsr?.();
    return renderer?.ssr.status==='admitted' && renderer.ssr.history.state==='stable'
      && globalThis.__inspectSsrExecution().frame.completed>=128
      && (!usesTaa || (renderer.temporal.historyValid && renderer.temporal.frameIndex>=128));
  },usesTaa,{timeout:selection.selectedBackend === 'swiftshader-vulkan' ? 600000 : 180000});
  await page.evaluate(()=>globalThis.__setSsrEvidencePaused(true));
  await page.waitForFunction(()=>globalThis.__inspectSsrExecution().frame.inFlight===0);
  const configuration = await page.evaluate(()=>globalThis.__inspectSsr());
  writeFileSync(resolve(directory,'configuration.json'),JSON.stringify(configuration,null,2));
  if(antialias==='taau' || antialias==='taa-dynamic') {
    assert.ok(configuration.dynamicResolution,'The submitted camera must expose DynamicResolution');
    assert.ok(configuration.dynamicResolution.extent,'DynamicResolution must have submitted an internal extent');
    assert.ok(configuration.dynamicResolution.extent.internalWidth<1024,'The combination must actually render below presentation resolution');
    const extent=configuration.dynamicResolution.extent;
    assert.equal(configuration.ssr.history.bytes,
      extent.internalWidth*extent.internalHeight*2*(8+4),
      'SSR radiance and surface history must follow the submitted internal extent');
  }
  const step = async name => {
    const before = await page.evaluate(()=>({temporal:globalThis.__inspectSsr().temporal,ssr:globalThis.__inspectSsr().ssr,execution:globalThis.__inspectSsrExecution().frame}));
    await page.evaluate(()=>globalThis.__stepSsrEvidenceFrame());
    await page.waitForFunction(()=>globalThis.__inspectSsrExecution().frame.inFlight===0);
    const after = await page.evaluate(()=>({temporal:globalThis.__inspectSsr().temporal,ssr:globalThis.__inspectSsr().ssr,execution:globalThis.__inspectSsrExecution().frame}));
    if(usesTaa) assert.equal(after.temporal.frameIndex,before.temporal.frameIndex+1);
    else assert.equal(after.temporal.historyValid,false);
    assert.equal(after.ssr.status,'admitted');
    assert.equal(after.ssr.history.state,'stable');
    assert.equal(after.ssr.history.resetCount,before.ssr.history.resetCount);
    assert.equal(after.execution.completed,before.execution.completed+1);
    assert.equal(after.execution.submitted,before.execution.submitted+1);
    assert.equal(after.temporal.resetReason,undefined);
    let path;
    if(name) {
      const encoded = await page.evaluate(async()=>{
        const pixels = await globalThis.__readReflectionPixels();
        let binary='';
        for(let i=0;i<pixels.length;i+=8192) binary+=String.fromCharCode(...pixels.subarray(i,i+8192));
        return btoa(binary);
      });
      const pixels = new Uint8Array(Buffer.from(encoded,'base64'));
      assert.equal(pixels.length,1024*1024*4);
      path=resolve(directory,`${name}.png`);
      writeFileSync(path,encodePng(1024, 1024, pixels));
    }
    return {path,before:before.temporal,after:after.temporal,ssr:{before:before.ssr,after:after.ssr},execution:{before:before.execution,after:after.execution}};
  };
  const journey=[];
  journey.push({stage:'baseline',...await step('baseline')});
  for(let i=1;i<=7;i++) {
    await page.evaluate(offset=>globalThis.__setSsrObjectOffset(offset),Math.min(i,5)*0.1);
    journey.push({stage:'motion',...await step(i===7?'motion-end':undefined)});
  }
  for(let i=1;i<=160;i++) journey.push({stage:'recovery',heldFrames:i,...await step([8,32,64,128].includes(i)?`recovery-${i}`:undefined)});
  const frames=[];
  for(let i=0;i<9;i++) frames.push(await step(`frame-${i}`));
  assert.deepEqual(errors,[]);
  const adapter = await page.evaluate(async()=>{
    const selected = await navigator.gpu.requestAdapter();
    if (!selected) throw new Error('No browser WebGPU adapter');
    const {vendor,architecture,device,description,isFallbackAdapter} = selected.info;
    return {vendor,architecture,device,description,isFallbackAdapter};
  });
  const git = args=>execFileSync('git',args,{cwd:new URL('../../../..',import.meta.url),encoding:'utf8'});
  const identity = {sourceHead:git(['rev-parse','HEAD']).trim(),trackedDiffSha256:createHash('sha256').update(git(['diff','HEAD','--binary'])).digest('hex')};
  const manifest={mode:'display-only-actual-rendered-frames',backend:selection.selectedBackend,adapter,identity,antialias,url:page.url(),objectMotion:true,journey,frames,errors};
  writeFileSync(resolve(directory,'frames.json'),JSON.stringify(manifest,null,2));
  const quality=measureMotionRecovery(manifest);
  writeFileSync(resolve(directory,'recovery.json'),JSON.stringify(quality,null,2));
  console.log(JSON.stringify({mode:'browser-motion-actual-raw-canvas',backend:selection.selectedBackend,quality,errors},null,2));
  assert.equal(quality.passed,true,'Browser must pass the same motion recovery gate');
} catch (error) {
  const inspection = await page.evaluate(()=>({renderer:globalThis.__inspectSsr?.(),execution:globalThis.__inspectSsrExecution?.()})).catch(()=>undefined);
  writeFileSync(resolve(directory,'failure.json'),JSON.stringify({error:String(error),errors,url:page.url(),inspection},null,2));
  await page.screenshot({path:resolve(directory,'failure.png'),fullPage:true}).catch(()=>undefined);
  throw error;
} finally {await browser.close();}
