import {chromium} from 'playwright';
import {mkdirSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeTape,buildFrameModel} from '../../../rhi-debug/dist/index.mjs';
const out=new URL('../../../../artifacts/roi-navigation/browser/',import.meta.url);mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu'], chromiumSandbox: true});const page=await browser.newPage({viewport:{width:1180,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{await page.goto('http://127.0.0.1:5799/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.navigationReady===true,null,{timeout:120000});await page.screenshot({path:new URL('overview.png',out).pathname});const worker=await page.evaluate(()=>window.runNavigationWorker());console.log('worker',JSON.stringify(worker));writeFileSync(new URL('worker.json',out),JSON.stringify(worker,null,2));const featureChecks=await page.evaluate(async({featurePath,runnerPath})=>{
 const [{default:feature},{runHeadless}]=await Promise.all([import('/@fs'+featurePath),import('/@fs'+runnerPath)]);
 return await runHeadless(feature);
},{featurePath:new URL('../../../../apps/feature-lab/src/features/state/static-navmesh-physical-navigation.ts',import.meta.url).pathname,runnerPath:new URL('../../../../apps/feature-lab/src/lab/feature.ts',import.meta.url).pathname});
writeFileSync(new URL('feature-lab.json',out),JSON.stringify({scope:'Browser-loaded public Feature Lab headless consumer; same runHeadless path as the panel, not a full panel-startup gate',checks:featureChecks},null,2));
console.log('feature-lab',JSON.stringify(featureChecks));if(!featureChecks.length||featureChecks.some(check=>!check.ok))throw Error('Public Feature Lab navigation consumer failed');
await page.waitForFunction(()=>window.navigationState?.tick>=900,null,{timeout:120000});const state=await page.evaluate(async()=>{const adapter=await navigator.gpu.requestAdapter(),info=adapter?.info;return {state:window.navigationState,error:window.navigationError,execution:window.navigationApp.execution.report(),renderer:window.navigationApp.renderer.inspect(),adapterInfo:info?{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter}:null};});await page.screenshot({path:new URL('final.png',out).pathname});writeFileSync(new URL('state.json',out),JSON.stringify({state,errors},null,2));console.log('state',JSON.stringify(state.state),'errors',JSON.stringify(errors));if(errors.length||state.error||!worker.ok||!worker.value.arrived||state.state.actors.some(a=>a.status!==2||Math.hypot(a.position[0]-a.goal[0],a.position[2]-a.goal[1])>.081))throw new Error('Browser navigation gate failed');
 const captured=await page.evaluate(async()=>{
   const r=await window.navigationApp.rhiCapture.captureFrame({signal:AbortSignal.timeout(60000)});
   if(!r.ok)return {ok:false,error:r.error};
   window.navigationTape=r.value.bytes;
   const uploaded=await window.navigationApp.rhiCapture.upload(r.value,{runId:'roi-navigation',signal:AbortSignal.timeout(60000)});
   return uploaded.ok?{ok:true,digest:r.value.digest,bytes:r.value.bytes.length,artifact:uploaded.value}:{ok:false,error:uploaded.error};
 });
 writeFileSync(new URL('capture.json',out),JSON.stringify(captured));if(!captured.ok)throw new Error('RHI capture/upload unavailable '+JSON.stringify(captured.error));
 console.log('capture',JSON.stringify(captured));
 const tapeBytes=readFileSync(captured.artifact.path);
 if('sha256:'+createHash('sha256').update(tapeBytes).digest('hex')!==captured.digest)throw Error('Tape digest mismatch');
 writeFileSync(new URL('frame.rhitape',out),tapeBytes);
 const tape=decodeTape(tapeBytes).unwrap(),model=buildFrameModel(tape);
 writeFileSync(new URL('initialization.json',out),JSON.stringify({digest:captured.digest,unseeded:model.unseededResources,
   resources:model.unseededResources.map(r=>({resource:r,create:tape.bootstrap.find(b=>b.handleId===r.resourceId)?.create})),
   passes:tape.events.map((event,eventIndex)=>({event,eventIndex})).filter(r=>r.event.kind==='beginRenderPass'),
   views:tape.bootstrap.filter(b=>b.create.kind==='createTextureView').map(b=>b.create)},null,2));
 const replay=await page.evaluate(()=>window.runNavigationReplay(window.navigationTape));replay.browser=browser.version();writeFileSync(new URL('replay.json',out),JSON.stringify(replay));
 if(replay.validation.length)throw new Error('Fresh replay WebGPU validation failed '+JSON.stringify(replay.validation));
 for(const [name,inspection] of Object.entries(replay.inspections))if(!inspection.ok)throw new Error('Fresh replay failed '+name+' '+JSON.stringify(inspection.error));
 const readbacks=await page.evaluate(()=>window.navigationReplayReadbacks.map(r=>({name:r.name,length:r.bytes.length})));
 for(let index=0;index<readbacks.length;index++){
   const {name,length}=readbacks[index],path=new URL('readback-'+name+'.bin',out);writeFileSync(path,new Uint8Array(0));
   for(let offset=0;offset<length;offset+=65536){const chunk=await page.evaluate(({index,offset})=>Array.from(window.navigationReplayReadbacks[index].bytes.slice(offset,offset+65536)),{index,offset});appendFileSync(path,Buffer.from(chunk));}
   const digest=createHash('sha256').update(readFileSync(path)).digest('hex');if(digest!==replay.inspections[name].value.attachment.sha256)throw Error('Readback digest mismatch');
   if(name==='output'){
     const bytes=readFileSync(path);let nonzero=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i]||bytes[i+1]||bytes[i+2])nonzero++;
     if(nonzero<1000)throw Error('Fresh replay final output is black');
   }
 }
 console.log('replay',JSON.stringify({browser:replay.browser,works:replay.model.works.length,resources:replay.model.resources.length,inspections:Object.fromEntries(Object.entries(replay.inspections).map(([name,r])=>[name,{workIndex:r.value.workIndex,attachment:r.value.attachment}]))}));

}catch(error){writeFileSync(new URL('failure.json',out),JSON.stringify({message:error.message,errors,url:page.url()},null,2));await page.screenshot({path:new URL('failure.png',out).pathname});throw error;}finally{await browser.close();}
