import { reduceTestProject } from '../../../scripts/test/reduce-test-project.mjs';
import { installTestCanvasBudget } from '../../../scripts/test/browser-canvas-budget.mjs';
import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
const linuxBrowserLaunch = JSON.parse(await readFile(resolve(root, 'scripts/ci/browser-launch.json'), 'utf8'));
process.env.FORGEAX_ENGINE_RHI_DEBUG = '1';
const toolRoot = resolve(process.env.FORGEAX_VIEW_TOOL_PACKAGE ?? resolve(root, 'tools/view'));
const engineRoot = resolve(process.env.FORGEAX_VIEW_ENGINE_PACKAGE ?? resolve(root, 'packages/engine'));
const engineManifest = JSON.parse(await readFile(resolve(engineRoot, 'package.json')));
const engineEntry = name => {
 const entry = engineManifest.exports[`./${name}`] ?? engineManifest.exports['./*'];
 const target = (typeof entry === 'string' ? entry : entry.import).replaceAll('*',name);
 return pathToFileURL(resolve(engineRoot, target)).href;
};
const { runUnifiedCli } = await import(engineEntry('devkit'));
const { createProfiler, buildProfileModel } = await import(engineEntry('profiler'));
const { parseImage } = await import(engineEntry('image/parse-image'));
const { decodeTape, buildFrameModel } = await import(engineEntry('rhi-debug'));
const { connectViewWorkspace } = await import(pathToFileURL(resolve(toolRoot, 'dist/modules/workspace/resident.mjs')));
const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'view-integrated-workspace-'));
const gameRoot = await mkdtemp(resolve(tmpdir(), 'view-integrated-game-'));
const output = resolve(process.env.FORGEAX_VIEW_EVIDENCE_ROOT ?? resolve(root, 'artifacts/view-integration'));
await mkdir(output, { recursive: true });
const stages = [];
const errors = [];
const catalogFailures = [];
let browser, client, page;
let independentStarted = false;
const cli = async (args, cwd = workspaceRoot) => {
 const result = await runUnifiedCli([...args, '--root', cwd, '--json']);
 if (!result.ok && args[0] === 'backend' && (args[1] === 'start' || args[1] === 'stop')) {
  try {
   const status = await runUnifiedCli(['backend', 'status', '--root', cwd, '--json']);
   await writeFile(resolve(output, `backend-${args[1]}-failure.json`), JSON.stringify({result, status}, null, 2));
   // Use the owner-provided diagnostic path; never derive a second backend registry.
   const log = result.error?.hint?.match(/inspect (.+[\\/]backend\.log) and backend status\./)?.[1];
   if (log) await cp(log, resolve(output, `backend-${args[1]}.log`));
  } catch (cause) {
   console.error('[view.backend lifecycle evidence]', String(cause));
  }
 }
 assert.equal(result.ok, true, JSON.stringify(result));
 return result.value;
};
async function independentFacts() {
 const status = await runUnifiedCli(['dev','status','--root',gameRoot,'--json']);
 if(!status.ok || !status.value.revision) return {status};
 const inspected = await runUnifiedCli(['dev','eval','--root',gameRoot,'--json','--revision',status.value.revision,'--timeout-ms','10000','--code',
  'return JSON.parse(JSON.stringify({execution:simulation.execution.report(),renderer:renderer?.inspect?.(),profilerActive:profiler?.activeCaptureId(),vase:await globalThis.__forgeaxGameInspection?.read("game-3d.runtime-vase")},(_key,value)=>value instanceof Error?{...value,name:value.name,message:value.message,stack:value.stack}:value));']);
 return {status,inspected};
}
async function stage(name, execute) {
 console.log('start',name);
 const start = performance.now();
 const result = await execute();
 stages.push({ name, milliseconds: performance.now() - start });
 console.log(name, stages.at(-1).milliseconds);
 return result;
}
async function openDiagnosticPage(target, type = 'rhi-debug') {
 await target.locator(`[role="tab"][data-page-id="page-${type}"]`).click();
 await target.locator(`[data-forgeax-diagnostic="${type}"]`).waitFor({ state: 'visible' });
}
async function assertAuthoredSky(bytes, subject) {
 await writeFile(resolve(output,`${subject}-sky.png`),bytes);
 const decoded = parseImage(bytes,'image/png',{mipmap:false});
 assert.equal(decoded.ok,true,JSON.stringify(decoded));
 const {width,height,bytes:pixels}=decoded.value;
 // Keep the independent sample in the fixed outer margin, before both HUD cards.
 // Relative horizontal positions enter the HUD in the compact CI viewport.
 const x=subject === 'independent' ? 2 : Math.floor(width*.01),y=Math.floor(height*.16);
 let blue=0,upperBlue=0,lowerBlue=0;
 for(let dy=0;dy<4;dy++) for(let dx=0;dx<4;dx++) {
  const offset=((y+dy)*width+x+dx)*4;
  const [r,g,b]=pixels.slice(offset,offset+3);
  upperBlue+=b;
  lowerBlue+=pixels[((Math.floor(height*.20)+dy)*width+x+dx)*4+2];
  if(b>r+12 && b>g+4 && b>40)blue++;
 }
 const observation={width,height,x,y,blue,upperBlue:upperBlue/16,lowerBlue:lowerBlue/16,gradient:(upperBlue-lowerBlue)/16};
 await writeFile(resolve(output,`${subject}-sky.json`),JSON.stringify(observation,null,2));
 assert.equal(blue,16,`the authored blue sky must remain visible beyond the finite floor: ${JSON.stringify(observation)}`);
 assert.ok(observation.gradient>12,`the sky horizon gradient must reject a uniform clear-color fallback: ${JSON.stringify(observation)}`);
}
async function prepareDiagnosticGameProject(template, gameRoot, lightweight) {
 await cp(resolve(template, 'assets'), resolve(gameRoot, 'assets'), { recursive: true });
 if (lightweight) await reduceTestProject(gameRoot, { shadowMapSize: 128 });
 const manifest = JSON.parse(await readFile(resolve(template, 'forge.json')));
 await writeFile(resolve(gameRoot, 'forge.json'), JSON.stringify(manifest));
 return manifest;
}

try {
 for (const directory of [workspaceRoot, gameRoot]) {
  await mkdir(resolve(directory, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engineRoot, resolve(directory, 'node_modules/@forgeax/engine'));
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'view-integration-proof', type: 'module', dependencies: { '@forgeax/engine': '*' } }));
 }
 const template = process.env.FORGEAX_VIEW_TEMPLATE_ROOT ?? resolve(root, 'templates/game-3d');
 const manifest = await prepareDiagnosticGameProject(template, gameRoot, process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1');
 if (!process.env.FORGEAX_VIEW_ENGINE_PACKAGE) await cli(['project', 'engine', 'use-local', root], gameRoot);
 await stage('backend-start', () => cli(['backend', 'start', '--host-pack', resolve(toolRoot, 'host.pack.json')]));
 const state = await stage('view-start', () => cli(['view', 'start']));
 const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', state.url)).then(response => response.json());
 client = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'engine-view-integration' });
 browser = await chromium.launch({
  ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : process.platform === 'linux' ? linuxBrowserLaunch.channel : undefined) }),
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--disable-features=MacAppCodeSignClone',
    ...(process.platform === 'linux' ? [...linuxBrowserLaunch.args, '--use-angle=swiftshader'] : []),
  ],
  chromiumSandbox: true,
 });
 // The paired-page CI probe keeps the real Editor surface and sixty ready frames,
 // with fewer framebuffer pixels during cold pipeline/IBL preparation.
 const viewport = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
  ? { width: 860, height: 660 } : { width: 1440, height: 900 };
 page = await browser.newPage({ viewport });
 if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1')
  await installTestCanvasBudget(page.context());
 await page.addInitScript(() => {
  if(location.protocol==='http:' || location.protocol==='https:')
   localStorage.setItem('forgeax.view.locale', 'en');
  globalThis.__diagnosticCompletedFrames = {};
  globalThis.__diagnosticReadyCompletedFrames = {};
  globalThis.__diagnosticReadiness = { firstReady: {}, lastReady: {}, latest: null, wait: null };
  document.addEventListener('forgeax:frame-completed', event => {
   const visible=event.target instanceof HTMLCanvasElement && event.target.checkVisibility();
   const sample={...event.detail,visible,milliseconds:performance.now()};
   globalThis.__diagnosticReadiness.latest=sample;
   if (!visible) return;
   const identity=event.detail?.worldIdentity;
   if(identity) globalThis.__diagnosticCompletedFrames[identity]=(globalThis.__diagnosticCompletedFrames[identity] ?? 0)+1;
   if(identity && event.detail?.presentation==='ready') {
    globalThis.__diagnosticReadyCompletedFrames[identity]=(globalThis.__diagnosticReadyCompletedFrames[identity] ?? 0)+1;
    globalThis.__diagnosticReadiness.firstReady[identity]??=sample;
    globalThis.__diagnosticReadiness.lastReady[identity]=sample;
   }
  },true);
 });
 await page.addInitScript(() => {
  const facts=globalThis.__diagnosticGraphics={raf:{requested:0,fired:0,cancelled:0},calls:{},settled:{},pending:{},errors:[],adapters:[],devices:[]};
  const raf=requestAnimationFrame.bind(globalThis),caf=cancelAnimationFrame.bind(globalThis);
  facts.raf.callbacks={};
  globalThis.requestAnimationFrame=callback=> {facts.raf.requested++;const name=callback.name||'(anonymous)';const counts=facts.raf.callbacks[name]??={requested:0,fired:0};counts.requested++;return raf(timestamp=> {facts.raf.fired++;counts.fired++;callback(timestamp);});};
  globalThis.cancelAnimationFrame=id=> {facts.raf.cancelled++;return caf(id);};
  const gpu=navigator.gpu;if(!gpu)return;
  const requestAdapter=gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter=async(...args)=> {
   const adapter=await requestAdapter(...args);if(!adapter)return adapter;
   const limits=value=>Object.fromEntries(['maxSampledTexturesPerShaderStage','maxColorAttachments','maxColorAttachmentBytesPerSample','maxTextureDimension3D'].map(key=>[key,value[key]]));
   facts.adapters.push({info:{vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,device:adapter.info?.device,description:adapter.info?.description},limits:limits(adapter.limits)});
   const requestDevice=adapter.requestDevice.bind(adapter);
   adapter.requestDevice=async(...args)=> {
    const device=await requestDevice(...args);
    facts.devices.push({requestedLimits:args[0]?.requiredLimits,limits:limits(device.limits)});
    device.addEventListener('uncapturederror',event=>facts.errors.push(event.error.message));
    const observe=(name,result,label)=> {
     const index=facts.calls[name]=(facts.calls[name] ?? 0)+1;
     if(result?.then){const key=`${name}:${index}`;facts.pending[key]={label,started:performance.now()};
      result.then(()=> {delete facts.pending[key];facts.settled[name]=(facts.settled[name] ?? 0)+1;},error=> {delete facts.pending[key];facts.errors.push(String(error));});}
     return result;
    };
    for(const name of ['createShaderModule','createRenderPipeline','createComputePipeline','createRenderPipelineAsync','createComputePipelineAsync','createCommandEncoder','popErrorScope']) {
     const original=device[name].bind(device);
     device[name]=(...args)=> {const result=observe(name,original(...args),args[0]?.label);
      if(name==='createShaderModule'){const compilation=result.getCompilationInfo.bind(result);result.getCompilationInfo=(...args)=>observe('getCompilationInfo',compilation(...args));}
      return result;
     };
    }
    for(const name of ['submit','onSubmittedWorkDone']){const original=device.queue[name].bind(device.queue);device.queue[name]=(...args)=>observe(`queue.${name}`,original(...args));}
    return device;
   };return adapter;
  };
 });
 page.on('pageerror', error => errors.push(error.message));
 page.on('response',async response=> {
  const path=new URL(response.url()).pathname;
  if(response.status()<400 || !path.endsWith('/catalog.json')) return;
  try {catalogFailures.push({path,status:response.status(),body:JSON.parse(await response.text())});}
  catch(error){catalogFailures.push({path,status:response.status(),readError:String(error)});}
 });
 page.on('console', message => console.log('browser',message.type(),message.text()));
 page.on('requestfailed', request => {const url=new URL(request.url());console.log('requestfailed',`${url.origin}${url.pathname}`,request.failure());});
 await stage('resident-ready', async () => {
  await page.goto(state.url);
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted || !!globalThis.__forgeaxViewReady?.error, undefined, { timeout: 90_000 });
  assert.equal(await page.evaluate(()=>globalThis.__forgeaxViewReady?.error),undefined);
  await openDiagnosticPage(page);
  await page.getByRole('button', {name:'Import tape',exact:true}).waitFor();
  assert.equal(await page.locator('.fx-view-project-open').count(), 0, 'projectless artifact page must remain usable');
 });
 const profiler = createProfiler({ phaseCatalog: { app: ['frame'], render: [] } });
 const started = profiler.startCapture({ frameLimit: 60, eventLimit: 240, detail: 'owner' });
 assert.equal(started.ok, true, JSON.stringify(started));
 const session = started.value;
 for (let frame=0; frame<60; frame++) {
  assert.equal(session.beginFrame(frame + 1).ok, true); assert.equal(session.beginPhase('app','frame').ok, true);
  // Measured CPU work through the production recorder, not hand-authored duration values.
  Array.from({length:5000},(_,i)=>Math.sin(i+frame)).reduce((a,b)=>a+b,0);
  assert.equal(session.endPhase().ok, true); assert.equal(session.endFrame().ok, true);
 }
 const captured = profiler.latestCapture();
 assert.ok(captured);
 const expected = buildProfileModel(captured); assert.equal(expected.ok, true);
 const capturePath = resolve(output, 'cpu-capture.json'); await writeFile(capturePath, JSON.stringify(captured));
 await page.locator('[role="tab"][data-page-id="page-profiler"]').click();
 await stage('profile-file-to-model', async () => {
  await page.locator('[data-forgeax-diagnostic="profiler"] input[type="file"]').setInputFiles(capturePath);
  await page.locator('[data-profile-status="loaded"]').waitFor();
  assert.equal(await page.locator('[data-profile-frames]').getAttribute('data-profile-frames'), '60');
  assert.ok((await page.locator('.fx-profile-summary').textContent()).includes(`${expected.value.summary.recordCount} records`));
 });
 await page.screenshot({ path: resolve(output, 'resident-profiler.png') });
 const invalid = resolve(output, 'invalid-profile.json'); await writeFile(invalid, '{"schemaVersion":"invalid"}');
 await page.locator('[data-forgeax-diagnostic="profiler"] input[type="file"]').setInputFiles(invalid);
 await page.locator('[data-profile-status="error"]').waitFor();
 await page.locator('[data-forgeax-diagnostic="profiler"] input[type="file"]').setInputFiles(capturePath);
 await page.locator('[data-profile-status="loaded"]').waitFor();
 await stage('resident-reload', async () => {
  await page.reload();
  await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted);
  await openDiagnosticPage(page);
  await page.getByRole('button', {name:'Import tape',exact:true}).waitFor();
 });
 await page.screenshot({ path: resolve(output, 'resident-rhi.png') });
 for(let sample=0;sample<5;sample++) await stage(`resident-reload-sample-${sample}`, async () => {
  await page.reload(); await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted);
  await openDiagnosticPage(page);
  await page.getByRole('button',{name:'Import tape',exact:true}).waitFor();
 });
 for(const type of ['rhi-debug','profiler']) {
  const ownerUid = await page.evaluate(() => globalThis.__forgeaxViewReady.mounted.frontendHost.context.fiber.uid);
  await page.evaluate(async type => {
   const host = globalThis.__forgeaxViewReady.mounted.frontendHost;
   const runtime = [...host.context.registry.values()].find(runtime => runtime.name === `forgeax.engine.view.${type}`);
   if(!runtime) throw new Error(`missing native ${type} plugin`);
   const fiber = [...runtime.fibers][0];
   globalThis.__forgeaxDiagnosticRestore = { parent:fiber.parent, config:fiber.config, plugin:{name:runtime.name,apply:runtime.callback,inject:fiber.inject} };
   await fiber.dispose();
  }, type);
  await page.locator(`[role="tab"][data-page-id="page-${type}"]`).waitFor({state:'detached'});
  await page.evaluate(async () => {
   const saved=globalThis.__forgeaxDiagnosticRestore; delete globalThis.__forgeaxDiagnosticRestore;
   await (await saved.parent.plugin(saved.plugin,saved.config)).await();
  });
  await page.locator(`[role="tab"][data-page-id="page-${type}"]`).waitFor();
  assert.equal(await page.locator(`[role="tab"][data-page-id="page-${type}"]`).count(),1);
  assert.equal(await page.evaluate(() => globalThis.__forgeaxViewReady.mounted.frontendHost.context.fiber.uid),ownerUid);
 }

 const opened = await stage('game-3d-open', () => cli(['view','project','open','--project',gameRoot]));
 await page.goto(opened.projectTarget?.url ?? opened.viewerUrl);
 await page.waitForFunction(() => !!globalThis.__forgeaxViewReady?.mounted, undefined, { timeout: 120_000 });
 assert.ok(new URL(page.url()).searchParams.has('forgeaxWorkspaceTarget'));
 const snapshot = await client.getState();
 assert.equal(snapshot.project.root, await realpath(gameRoot));
 const assets = await client.listAssets(manifest.id); assert.ok(assets.assets.length > 0);
 await page.locator('[role="tab"][data-page-id="page-editor"]').click();
 const scene = assets.assets.find(asset => asset.kind === 'scene'); assert.ok(scene);
 const editorOpened=await client.openAsset(scene.guid,{projectId:manifest.id});
 await page.bringToFront();
 await page.evaluate(() => {
  const identity=globalThis.__forgeaxGameInspection?.renderer()?.execution?.world?.identity;
  globalThis.__diagnosticReadiness.wait={identity,milliseconds:performance.now(),
   completed:globalThis.__diagnosticCompletedFrames[identity]??0,
   ready:globalThis.__diagnosticReadyCompletedFrames[identity]??0};
 });
 await page.waitForFunction(() => {
  const identity=globalThis.__forgeaxGameInspection?.renderer()?.execution?.world?.identity;
  return !!identity && globalThis.__diagnosticReadyCompletedFrames[identity]>=60;
 },undefined,{timeout:90000});
 const editorCompletedFrames=await page.evaluate(()=>globalThis.__diagnosticCompletedFrames);
 await writeFile(resolve(output,'editor-target.json'),JSON.stringify({
  target:editorOpened.preview.target,
  camera:await client.getCamera({targetId:editorOpened.preview.target.targetId,targetGeneration:editorOpened.preview.target.generation}),
  completedFrames:editorCompletedFrames,
  readyCompletedFrames:await page.evaluate(()=>globalThis.__diagnosticReadyCompletedFrames),
  readiness:await page.evaluate(()=>globalThis.__diagnosticReadiness),
 },(key,value)=>key==='url'?undefined:value,2));
 await page.screenshot({path:resolve(output,'game-3d.png')});
 await assertAuthoredSky(await page.locator('canvas').first().screenshot(),'editor');
 const editorFacts=()=>page.evaluate(()=>({
  renderer:globalThis.__forgeaxGameInspection?.renderer(),
  canvas:(()=>{const canvas=document.querySelector('canvas');return canvas?{width:canvas.width,height:canvas.height,clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight,widthLimit:canvas.getAttribute('data-forgeax-render-width-limit'),heightLimit:canvas.getAttribute('data-forgeax-render-height-limit'),visible:canvas.checkVisibility({visibilityProperty:true})}:null;})(),
 }));
 const editorPresentation={active:await editorFacts()};
 assert.ok(editorPresentation.active.canvas.clientHeight>=300,'initial Editor layout must retain a usable scene extent');
 const editorWorld=editorPresentation.active.renderer.execution.world.identity;
 // Follow the user journey into the diagnostic page before starting another
 // GPU-owning game. Keep the completed Editor receipt and its live target.
 await openDiagnosticPage(page);
 const waitForHiddenEditor=async()=>{
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('canvas')).every(canvas=>!canvas.checkVisibility({visibilityProperty:true})),undefined,{timeout:10000});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const before=await editorFacts();
  await page.waitForTimeout(1000);
  const after=await editorFacts();
  assert.equal(after.renderer.execution.world.identity,editorWorld,'hiding a preview must preserve its World');
  assert.equal(after.renderer.execution.frame.submitted,before.renderer.execution.frame.submitted,'inactive Editor must stop continuous submissions');
  return {before,after};
 };
 editorPresentation.hidden=await stage('editor-hidden-presentation',waitForHiddenEditor);
 await writeFile(resolve(output,'editor-presentation.json'),JSON.stringify(editorPresentation,null,2));
 const hiddenCapture=await stage('editor-hidden-capture',()=>client.capture({targetId:editorOpened.preview.target.targetId,targetGeneration:editorOpened.preview.target.generation}));
 assert.equal(hiddenCapture.width,editorPresentation.active.canvas.width,'hidden capture must retain the actual preview width');
 assert.equal(hiddenCapture.height,editorPresentation.active.canvas.height,'hidden capture must retain the actual preview height');
 assert.ok(hiddenCapture.png.startsWith('data:image/png;base64,'));
 await writeFile(resolve(output,'editor-hidden.png'),Buffer.from(hiddenCapture.png.split(',')[1],'base64'));
 editorPresentation.hiddenCapture={frameId:hiddenCapture.frameId,width:hiddenCapture.width,height:hiddenCapture.height};
 editorPresentation.afterCapture=await waitForHiddenEditor();
 // The UI resize still reallocates the real drawing buffer under the shared cap.
 const resizeSceneBuffer=async scale=>{
  if(process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT!=='1')return;
  await page.locator('canvas').evaluateAll((canvases,{width,height})=>{
   for(const canvas of canvases){
    canvas.setAttribute('data-forgeax-render-width-limit',String(width));
    canvas.setAttribute('data-forgeax-render-height-limit',String(height));
   }
  },{width:testQuality.viewport.width*scale,height:testQuality.viewport.height*scale});
 };
 await resizeSceneBuffer(0.5);
 await page.locator('canvas').first().evaluate(canvas=>{
  // Native resize delivery and the workspace command may run after App's rAF.
  // Observe every resulting buffer pair so a later frame cannot hide an overwrite.
  const changes=[];
  const observer=new MutationObserver(()=>{
   if(canvas.checkVisibility({visibilityProperty:true})&&changes.length<32)
    changes.push({width:canvas.width,height:canvas.height});
  });
  observer.observe(canvas,{attributes:true,attributeFilter:['width','height']});
  globalThis.__diagnosticEditorResize={canvas,changes,disconnect:()=>observer.disconnect()};
 });
 await page.setViewportSize({width:1280,height:800});
 await page.locator('[role="tab"][data-page-id="page-editor"]').click();
 await page.waitForFunction(({frame,width,requireResize})=>{
  const canvas=document.querySelector('canvas');
  const renderer=globalThis.__forgeaxGameInspection?.renderer();
  return canvas?.checkVisibility({visibilityProperty:true})&&canvas.clientWidth>0&&canvas.clientHeight>0&&renderer?.execution.frame.completed>frame&&(!requireResize||canvas.width<width);
 },{frame:editorPresentation.afterCapture.after.renderer.execution.frame.completed,width:editorPresentation.active.canvas.width,requireResize:process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT==='1'},{timeout:90000});
 const resizedExtent=await page.locator('canvas').first().evaluate(canvas=>({width:Math.round(canvas.clientWidth*devicePixelRatio),height:Math.round(canvas.clientHeight*devicePixelRatio)}));
 await client.resizePreview({targetId:editorOpened.preview.target.targetId,targetGeneration:editorOpened.preview.target.generation,...resizedExtent});
 editorPresentation.resumed=await editorFacts();
 editorPresentation.bufferChanges=await page.evaluate(()=>{
  const observation=globalThis.__diagnosticEditorResize;
  observation.disconnect();
  return {sameCanvas:observation.canvas===document.querySelector('canvas'),changes:observation.changes};
 });
 await writeFile(resolve(output,'editor-presentation.json'),JSON.stringify(editorPresentation,null,2));
 assert.equal(editorPresentation.resumed.renderer.execution.world.identity,editorWorld);
 assert.equal(editorPresentation.bufferChanges.sameCanvas,true,'resizing must preserve the actual preview canvas');
 if(process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT==='1') {
  assert.ok(editorPresentation.bufferChanges.changes.length>0,'resuming must change the real drawing buffer');
  for(const size of editorPresentation.bufferChanges.changes)
   assert.ok(size.width<=testQuality.viewport.width*.5&&size.height<=testQuality.viewport.height*.5,`every native and workspace resize must honor the smaller budget: ${JSON.stringify(size)}`);
  assert.ok(editorPresentation.resumed.canvas.width<editorPresentation.active.canvas.width,'resuming at the smaller budget must resize the real drawing buffer');
 }
 await page.screenshot({path:resolve(output,'editor-resumed.png')});
 await resizeSceneBuffer(1);
 await page.setViewportSize(viewport);
 await page.locator('[role="tab"][data-page-id="page-rhi-debug"]').click();
 editorPresentation.beforeIndependent=await waitForHiddenEditor();
 await writeFile(resolve(output,'editor-presentation.json'),JSON.stringify(editorPresentation,null,2));
 // The existing CLI observes the actual game App. Embedded View readiness is a
 // boolean and must never be treated as a native Context or profiler authority.
 independentStarted=true;
 const independent=await stage('independent-game-start',()=>cli(['dev','start','--headless','true','--rhi-capture','true'],gameRoot));
 const liveProfilePath=resolve(output,'live-cpu-capture.json');
 const profileArtifact=await stage('live-profile-capture',()=>cli(['profile','capture','--frame-limit','60','--event-limit','20000','--output',liveProfilePath],gameRoot));
 const liveProfile=JSON.parse(await readFile(liveProfilePath,'utf8'));
 const liveProfileModel=buildProfileModel(liveProfile); assert.equal(liveProfileModel.ok,true);
 assert.equal(liveProfileModel.value.summary.frameCount,60);
 const independentAfterProfile=await independentFacts();
 await writeFile(resolve(output,'independent-after-profile.json'),JSON.stringify(independentAfterProfile,null,2));
 assert.equal(independentAfterProfile.inspected?.ok,true,'the actual game read projection must remain available');
 const liveVase=independentAfterProfile.inspected.value.result.vase;
 assert.equal(liveVase?.busy,false,'the default runtime vase must finish generation');
 assert.equal(liveVase?.error,undefined,'the actual game must execute its native runtime Pack');
 assert.ok(liveVase?.generation !== undefined,'the actual game must publish a generated vase');
 // Keep completed producer evidence even if a later large tape export fails.
 await writeFile(resolve(output,'live-producer.json'),JSON.stringify({independent,profileArtifact,editorCompletedFrames,liveProfile:liveProfileModel.value.summary},null,2));
 const liveTape=resolve(output,'live-frame.rhitape');
 const liveCapture=await stage('live-frame-capture',()=>cli(['rhi','capture','--output',liveTape],gameRoot));
 assert.equal(liveCapture.source,'live');
 const storedHash=createHash('sha256');
 for await (const bytes of createReadStream(liveTape)) storedHash.update(bytes);
 assert.equal(`sha256:${storedHash.digest('hex')}`,liveCapture.digest,'the stored tape must match its actual producer digest');
 {
  const decoded=decodeTape(await readFile(liveTape));
  assert.equal(decoded.ok,true,JSON.stringify(decoded.ok?{ok:true}:decoded));
  const frame=buildFrameModel(decoded.value);
  assert.ok(frame.works.some(work=>work.pipeline.shaders.some(shader=>shader.entryPoint==='skybox_fs')),
   'the actual captured frame must draw the authored environment, rather than only clear the background');
 }
 const liveBytes=(await stat(liveTape)).size;
 const independentImage=await stage('independent-game-visible-capture',()=>cli(['dev','capture','--output',resolve(output,'independent-game.png')],gameRoot));
 await assertAuthoredSky(await readFile(resolve(output,'independent-game.png')),'independent');
 const independentImageReport=JSON.parse(await readFile(independentImage.report.uri,'utf8'));
 assert.equal(independentImageReport.record.pixels.rendered,true,'the actual independent game canvas must contain rendered pixels');
 assert.ok(independentImageReport.record.runtime.domUi.rootChildren>0,'the game UI must be mounted');
 assert.ok(independentImageReport.record.runtime.domUi.textWitness.length>0,'the mounted game UI must expose visible text');
 await writeFile(resolve(output,'live-producer.json'),JSON.stringify({independent,profileArtifact,liveProfile:liveProfileModel.value.summary,liveCapture,liveBytes,editorCompletedFrames},null,2));

 await openDiagnosticPage(page);
 await page.getByRole('button', {name:'Import tape',exact:true}).waitFor();
 // The existing artifact fixture is explicit structural/replay data, not a claimed live capture.
 const generator = resolve(output, 'diagnostic-fixture.mjs');
 await writeFile(generator, (await readFile(resolve(root, 'apps/rhi-debug-viewer/fixtures/generate-fixture.mjs'), 'utf8')).replace('@forgeax/engine-rhi-debug', engineEntry('rhi-debug')));
 const fixture = spawnSync(process.execPath, [generator,output], {cwd:gameRoot,encoding:'utf8'});
 assert.equal(fixture.status,0,fixture.stderr); const tapePath = resolve(output, 'frame-0.rhitape');
 await stage('rhi-file-to-model', async () => {
  await page.getByLabel('Select one v7 RHI tape').setInputFiles(tapePath);
  await page.waitForFunction(() => globalThis.__forgeaxRhiDebug?.model?.works?.length > 0, undefined, {timeout:90000});
 });
 await page.evaluate(() => {
  const observer = new MutationObserver(() => {
   if(document.querySelector('[data-forgeax-rt-status="ok"]')===null) return;
   const canvas=document.querySelector('canvas[data-forgeax-rt-canvas]');
   globalThis.__forgeaxFirstReadyPixels=canvas===null?null:{
    width:canvas.width,height:canvas.height,
    pixels:Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.slice(0,16)),
   };
   observer.disconnect();
  });
  observer.observe(document,{childList:true,attributes:true,subtree:true});
 });
 await page.locator('[data-forgeax-event-browser] [data-forgeax-work-index="0"]').click();
 const drawTab=page.getByRole('tab',{name:'Draw Call Viewer',exact:true});
 if(await drawTab.count()) await drawTab.click();
 await page.locator('[data-forgeax-rt-status="ok"]').first().waitFor({timeout:90000});
 const firstReadyPixels=await page.evaluate(()=>globalThis.__forgeaxFirstReadyPixels);
 assert.equal(firstReadyPixels?.width,2,'pixels ready must expose the replay width on its first DOM publication');
 assert.equal(firstReadyPixels?.height,2,'pixels ready must expose the replay height on its first DOM publication');
 assert.ok(firstReadyPixels.pixels.some((value,index)=>index%4!==3 && value>0),'pixels ready must expose drawn fixture pixels on its first DOM publication');
 const replayPixels=await page.locator('canvas[data-forgeax-rt-canvas]').evaluate(canvas=> {
  const pixels=Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
  return {width:canvas.width,height:canvas.height,pixels};
 });
 assert.equal(replayPixels.width,2); assert.equal(replayPixels.height,2);
 assert.ok(replayPixels.pixels.some((value,index)=>index%4!==3 && value>0),'replayed fixture must produce color pixels');
 const layout=await page.locator('.fx-rhi-tool > .h-screen').boundingBox();
 const rhiViewport=page.viewportSize();
 assert.ok(layout.y+layout.height<=rhiViewport.height+1,`RHI tool must fit inside the View viewport: ${JSON.stringify({layout,viewport:rhiViewport})}`);
 await page.screenshot({ path: resolve(output, 'embedded-rhi.png') });
 await stage('live-rhi-file-to-model', async () => {
  await page.getByLabel('Select one v7 RHI tape').setInputFiles(liveTape);
  await page.waitForFunction(digest => globalThis.__forgeaxRhiDebug?.artifactRef?.digest===digest && !!globalThis.__forgeaxRhiDebug?.model?.works?.length,liveCapture.digest,{timeout:90000});
 });
 const liveModel=await page.evaluate(()=>({digest:globalThis.__forgeaxRhiDebug.artifactRef.digest,passes:globalThis.__forgeaxRhiDebug.model.passes.length,works:globalThis.__forgeaxRhiDebug.model.works.length,resources:globalThis.__forgeaxRhiDebug.model.resources.length}));
 assert.equal(liveModel.digest,liveCapture.digest);
 const liveReplayWork=await page.evaluate(()=>globalThis.__forgeaxRhiDebug.model.passes.findLast(pass=>pass.kind==='render' && pass.colorAttachmentViewHandleIds.length>0 && pass.workIndices.length>0)?.workIndices.at(-1));
 assert.ok(Number.isInteger(liveReplayWork),'the actual capture must contain a render work with a color attachment');
 await page.locator(`[data-forgeax-event-browser] [data-forgeax-work-index="${liveReplayWork}"]`).click();
 await page.locator('[data-forgeax-rt-status="ok"]').first().waitFor({timeout:90000});
 const liveReplayPixels=await page.locator('canvas[data-forgeax-rt-canvas]').evaluate(canvas=> {
  const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const colors=new Set();let nonBlack=0;
  for(let offset=0;offset<pixels.length;offset+=4){const color=(pixels[offset]<<16)|(pixels[offset+1]<<8)|pixels[offset+2];colors.add(color);if(color!==0)nonBlack++;}
  return {width:canvas.width,height:canvas.height,distinctColors:colors.size,nonBlackPixels:nonBlack};
 });
 assert.ok(liveReplayPixels.width>2 && liveReplayPixels.height>2,'the replay must use the actual game attachment, not the structural 2x2 fixture');
 assert.ok(liveReplayPixels.nonBlackPixels>0 && liveReplayPixels.distinctColors>1,'the actual game replay must contain visible, varying color pixels');
 await page.screenshot({path:resolve(output,'live-rhi.png')});

 await page.locator('[role="tab"][data-page-id="page-profiler"]').click();
 await page.locator('[data-forgeax-diagnostic="profiler"] input[type="file"]').setInputFiles(liveProfilePath);
 await page.locator('[data-profile-status="loaded"]').waitFor();
 await page.screenshot({ path: resolve(output,'embedded-profiler.png') });
 const independentBeforeStop=await cli(['dev','status'],gameRoot);
 await cli(['view','stop']);
 const independentAfterStop=await cli(['dev','status'],gameRoot);
 assert.equal(independentAfterStop.phase,'ready');
 assert.equal(independentAfterStop.revision,independentBeforeStop.revision);
 assert.equal(independentAfterStop.worldIdentity,independentBeforeStop.worldIdentity);
 assert.equal((await cli(['backend','status'])).phase,'ready');
 const restored = await cli(['view','start']);
 // Recover through the workspace owner before mounting Scene. Opening the
 // retired target first races its late query failures against diagnostic tabs.
 const restoredBootstrap=await fetch(new URL('/__forgeax/view/bootstrap',restored.url)).then(response=>response.json());
 await client.close();
 client=await connectViewWorkspace({endpoint:restoredBootstrap.endpoint,token:restoredBootstrap.token,clientId:'engine-view-integration-restored'});
 const lost=await client.getState();
 assert.equal(lost.projectPhase,'failed','stopped presentation must retire the headed target');
 assert.equal(lost.projectTarget.targetId,snapshot.projectTarget.targetId,'retirement must identify the original target');
 await writeFile(resolve(output,'retired-workspace.json'),JSON.stringify({
  projectId:lost.project.id,targetId:lost.projectTarget.targetId,phase:lost.projectPhase,
 },null,2));
 const recovered=await client.reopenProject({root:gameRoot,expectedTargetId:snapshot.projectTarget.targetId,expectedTargetState:'lost'});
 assert.notEqual(recovered.projectTarget.targetId,snapshot.projectTarget.targetId);
 await page.goto(recovered.projectTarget.url);
 await page.waitForFunction(()=>!!globalThis.__forgeaxViewReady?.mounted,undefined,{timeout:90000});
 await openDiagnosticPage(page);
 await page.goto('about:blank');
 await client.close(); client=undefined;
 const backendBeforeRestart=await cli(['backend','status']);
 await cli(['backend','stop']);
 const independentWhileBackendStopped=await cli(['dev','status'],gameRoot);
 assert.equal(independentWhileBackendStopped.phase,'ready');
 assert.equal(independentWhileBackendStopped.revision,independentBeforeStop.revision);
 assert.equal(independentWhileBackendStopped.worldIdentity,independentBeforeStop.worldIdentity);
 await cli(['backend','start','--host-pack',resolve(toolRoot,'host.pack.json')]);
 const restartedView=await cli(['view','start']);
 await page.goto(restartedView.url);
 await page.waitForFunction(()=>!!globalThis.__forgeaxViewReady?.mounted,undefined,{timeout:90000});
 await openDiagnosticPage(page);
 await page.getByRole('button',{name:'Import tape',exact:true}).waitFor();
 // The projectless fallback must run before a project intent can auto-open
 // another game in this GPU-disabled page. Backend restart clears that intent.
 const noGpu=await browser.newPage({viewport:{width:1440,height:900}});
 await noGpu.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true}));
 await noGpu.goto(restartedView.url);
 await noGpu.waitForFunction(()=>!!globalThis.__forgeaxViewReady?.mounted,undefined,{timeout:90000});
 await noGpu.locator('[role="tab"][data-page-id="page-rhi-debug"]').click();
 await noGpu.getByLabel('Select one v7 RHI tape').setInputFiles(tapePath);
 await noGpu.locator('[data-forgeax-event-browser] [data-forgeax-work-index="0"]').click();
 await noGpu.locator('[data-forgeax-rt-status="no-webgpu"]').first().waitFor();
 assert.ok(await noGpu.evaluate(()=>globalThis.__forgeaxRhiDebug.model.works.length>0));
 await noGpu.screenshot({path:resolve(output,'resident-no-webgpu.png')});
 await noGpu.close();
 const afterLifecyclePath=resolve(output,'live-cpu-after-lifecycle.json');
 await stage('independent-game-after-backend-restart',()=>cli(['profile','capture','--frame-limit','60','--event-limit','20000','--output',afterLifecyclePath],gameRoot));
 const afterLifecycleModel=buildProfileModel(JSON.parse(await readFile(afterLifecyclePath,'utf8')));
 assert.equal(afterLifecycleModel.ok,true); assert.equal(afterLifecycleModel.value.summary.frameCount,60);
 const independentAfterLifecycle=await cli(['dev','status'],gameRoot);
 assert.equal(independentAfterLifecycle.revision,independentBeforeStop.revision);
 assert.equal(independentAfterLifecycle.worldIdentity,independentBeforeStop.worldIdentity);
 assert.deepEqual(errors, []);
 await writeFile(resolve(output,'browser.json'), JSON.stringify({ok:true,stages,errors,graphics:await page.evaluate(()=>globalThis.__diagnosticGraphics),project: snapshot.project,assetCount:assets.assets.length,profile:expected.value.summary,liveProfile:liveProfileModel.value.summary,liveCapture:{...liveCapture,byteLength:liveBytes,...liveModel},editorCompletedFrames,independentAfterStop,independentWhileBackendStopped,independentAfterLifecycle,backendBeforeRestart,backendRestart:true,replayPixels,liveReplayWork,liveReplayPixels,presentationRetirementRecovery:true,noWebGpu:true,nativePluginRemoveRestore:true,viewport:page.viewportSize(),platform:process.platform,architecture:process.arch},null,2));
} catch (error) {
 // Freeze qualification facts before the diagnostic capture can add frames.
 const readinessAtFailure=await page?.evaluate(()=>({milliseconds:performance.now(),
  completed:{...globalThis.__diagnosticCompletedFrames},
  ready:{...globalThis.__diagnosticReadyCompletedFrames},
  observation:globalThis.__diagnosticReadiness,
 })).catch(()=>null);
 const independent = independentStarted ? await independentFacts().catch(cause=>({error:String(cause)})) : undefined;
 if (independentStarted) await cp(resolve(gameRoot,'.forgeax/dev.log'),resolve(output,'independent-dev.log')).catch(()=>{});
 const workspace=await client?.getState().then(state=>({projectPhase:state.projectPhase,projectTarget:state.projectTarget?{targetId:state.projectTarget.targetId,worldId:state.projectTarget.worldId}:null,preview:state.preview?{asset:state.preview.asset,target:{targetId:state.preview.target.targetId,worldId:state.preview.target.worldId,generation:state.preview.target.generation}}:null})).catch(()=>null);
 // Serialize in the browser realm: Playwright Error transport drops custom code/detail.
 const failureState=await page?.evaluate(()=>JSON.parse(JSON.stringify({origin:location.origin,ready:{mounted:!!globalThis.__forgeaxViewReady?.mounted,error:globalThis.__forgeaxViewReady?.error},execution:globalThis.__forgeaxGameInspection?.renderer(),bootstrap:globalThis.__forgeaxRendererBootstrap,frameSubmitted:document.documentElement.dataset.forgeaxFrameSubmitted,visibleCompletedFrames:globalThis.__diagnosticCompletedFrames,visibility:document.visibilityState,graphics:globalThis.__diagnosticGraphics,canvases:Array.from(document.querySelectorAll('canvas'),c=>({connected:c.isConnected,width:c.width,height:c.height,visible:c.checkVisibility(),rect:{x:c.getBoundingClientRect().x,y:c.getBoundingClientRect().y,width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height}})),plugins:globalThis.__forgeaxPluginProjection?.current?.inspect()?.live?.map(({id,fiberState,requiredServices,providedServices,error})=>({id,fiberState,requiredServices,providedServices,error})),fatal:document.querySelector('#forgeax-fatal-details')?.textContent,text:document.body.innerText},(_key,value)=>value instanceof Error?{...value,name:value.name,message:value.message,stack:value.stack}:value))).catch(()=>null);
 await writeFile(resolve(output,'browser-failure.json'),JSON.stringify({ok:false,stages,errors,catalogFailures,error:String(error),readinessAtFailure,workspace,independent,state:failureState},null,2));
 // Preserve the failed ordinary picture before capture can change graph work.
 await page?.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});
 // Preserve the original failure: capture is diagnosis, never a replacement
 // for the ordinary 60 completed frames gate.
 let failingFrame;
 if((error.name==='TimeoutError' || error.name==='AssertionError') && workspace?.preview) {
  failingFrame=await page.evaluate(async()=> {
   if(!globalThis.__forgeax?.captureFrame)return {ok:false,code:'capture-unavailable',reason:'the failing App did not expose RHI capture'};
   const controller=new AbortController();let timer;
   try {
    const result=await Promise.race([globalThis.__forgeax.captureFrame({snapshotTimeoutMs:5000,signal:controller.signal}),new Promise(resolve=> {timer=setTimeout(()=> {controller.abort();resolve({ok:false,error:{code:'capture-timeout',hint:'the failing App did not finish its native capture transaction in 10 seconds'}});},10000);})]);
    if(!result.ok)return result;
    globalThis.__diagnosticFailureTape=result.value.chunks(65536)[Symbol.iterator]();
    return {ok:true,byteLength:result.value.byteLength,digest:result.value.digest};
   }finally{clearTimeout(timer);}
  }).catch(cause=>({ok:false,code:'capture-unavailable',reason:String(cause)}));
  try { if(failingFrame.ok) {
   const tape=await open(resolve(output,'failing-frame.rhitape'),'w');const hash=createHash('sha256');let offset=0;
   try {
    while(true){const chunk=await page.evaluate(()=> {const item=globalThis.__diagnosticFailureTape.next();if(item.done)return null;let binary='';for(const byte of item.value.bytes)binary+=String.fromCharCode(byte);return {offset:item.value.offset,base64:btoa(binary)};});if(!chunk)break;
     assert.equal(chunk.offset,offset);const bytes=Buffer.from(chunk.base64,'base64');await tape.writeFile(bytes);hash.update(bytes);offset+=bytes.length;
    }
    assert.equal(offset,failingFrame.byteLength);assert.equal(`sha256:${hash.digest('hex')}`,failingFrame.digest);
   }finally{await tape.close();}
  }}catch(cause){failingFrame={...failingFrame,exportError:String(cause)};}
  await writeFile(resolve(output,'failing-frame.json'),JSON.stringify({workspace,...failingFrame},null,2));
 }
 // Diagnose the actual independent producer, rather than the View's Editor App.
 // The live owner retains its existing bounded capture transaction and failure.
 if(independentStarted) {
  const command=['rhi','capture','--output',resolve(output,'independent-failing-frame.rhitape'),'--root',gameRoot,'--json'];
  const result=await runUnifiedCli(command).catch(cause=>({ok:false,error:{code:'capture-unavailable',detail:String(cause)}}));
  await writeFile(resolve(output,'independent-failing-frame.json'),JSON.stringify({command,result},null,2));
 }
 throw error;
} finally {
 if(independentStarted) await runUnifiedCli(['dev','stop','--root',gameRoot,'--json']).catch(()=>{});
 await client?.close?.();
 await browser?.close();
 await runUnifiedCli(['backend','stop','--root',workspaceRoot,'--json']);
 await rm(workspaceRoot,{recursive:true,force:true}); await rm(gameRoot,{recursive:true,force:true});
}
