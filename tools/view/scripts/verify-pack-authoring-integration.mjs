import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { parseImage } from '@forgeax/engine/image/parse-image';
import { connectViewWorkspace } from '../dist/modules/workspace/resident.mjs';
import { writeProofGameAssets } from './fixtures/plugin-assets.mjs';

process.env.FORGEAX_ENGINE_RHI_DEBUG = '1';
const checkout = resolve(import.meta.dirname, '../../..');
const root = resolve(process.env.FORGEAX_PACK_AUTHORING_PROJECT ?? join(checkout, 'artifacts/pack-authoring/project'));
const output = resolve(checkout, 'artifacts/pack-authoring');
const view = resolve(checkout, 'tools/view');
await mkdir(join(root, 'assets'), { recursive: true });
await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
for (const [name, target] of [['engine', join(checkout, 'packages/engine')], ['view', view]]) {
  try { await symlink(target, join(root, 'node_modules/@forgeax', name)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const editableSource = await readFile(join(import.meta.dirname, 'fixtures/pack-authoring.pack.ts'), 'utf8');
const identity = editableSource.match(/packageId: (definePackageId\('[^']+'\)),/);
assert.ok(identity);
const legacySource = editableSource
 .replace('export default', `let legacyPackageId = ${identity[1]};\nexport default`)
 .replace(identity[0], 'packageId: legacyPackageId,')
 .replace(/  parameters: \[[\s\S]*?\n  \],\n/, '')
 .replace('build({ packageId, values })', 'build({ packageId })')
 .replaceAll('values.radius', '1')
 .replace('values: materialValues', 'values: { ...materialValues, baseColor: [0.9, 0.25, 0.08, 1] }')
 .replace('intensity: 2', 'color: [1, 1, 1], intensity: 2');
await writeFile(join(root, 'assets/proof.pack.ts'), legacySource);
await cp(join(view, 'scripts/fixtures/workspace-proof.plugin.ts'), join(root, 'assets/game.plugin.ts'));
const roots = await writeProofGameAssets(root);
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pack-authoring-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
await writeFile(join(root, 'assets/direct.pack.json'), JSON.stringify({ schemaVersion:'3.0.0', packageId:'01900000-0000-7000-8000-000000000099', assets:{ 'scene/json':{kind:'scene',refs:[],payload:{entities:{sun:{components:{DirectionalLight:{color:[1,1,1],intensity:2}}}}}}}}));
await writeFile(join(root, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'pack-authoring-proof', name: 'Pack authoring', assetRoots: ['assets'], roots }));

const command = async (...args) => {
 const result = await runUnifiedCli([...args, '--root', root, '--json']);
 assert.equal(result.ok, true, JSON.stringify(result));
 return result.value;
};
await command('project','engine','use-local',checkout);
await command('backend','start','--host-pack',join(view,'host.pack.json'));
const start = await command('view','start','--input',JSON.stringify({ root, frontendConfig:{layout:{responsiveAutoTuck:false}} }));
await writeFile(join(output,'entry.json'),JSON.stringify({url:start.url,root},null,2));
console.log('View URL',start.url);
const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap',start.url)).then(r=>r.json());
const client = await connectViewWorkspace({endpoint:bootstrap.endpoint,token:bootstrap.token,clientId:'pack-authoring-proof'});
const launch = JSON.parse(await readFile(join(checkout, 'scripts/ci/browser-launch.json'), 'utf8'));
const browser = await chromium.launch({ ...launch, headless:true,
 args: [...launch.args, '--use-angle=swiftshader'],
 executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome', channel: undefined,
 chromiumSandbox:true,
});
const page = await browser.newPage({viewport:{width:1680,height:1200}});
const errors=[];
let failureDraft;
const staleInspections=[];
const readCounts = new Map();
page.on('websocket', socket => socket.on('framesent', frame => {
 const text = String(frame.payload);
 if (text.includes('sunColor') && text.includes('edit')) console.log('SUN EDIT SENT');
 if (text.includes('preview.texture.get')) for (const id of readCounts.keys()) {
   if (text.includes(id)) readCounts.set(id, readCounts.get(id) + 1);
 }
}));
page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});
page.on('console',m=>{if(m.type()==='error') console.error('CONSOLE',m.text());});
await page.addInitScript(()=>{try{localStorage.setItem('forgeax.view.locale','en');}catch{}});
try {
 page.on('websocket', socket => socket.on('framereceived', frame => { const value=String(frame.payload); try { const parsed=JSON.parse(value); if(parsed.ok===false) { console.error('WIRE FAILURE',JSON.stringify(parsed.error)); if(JSON.stringify(parsed.error).includes('view-workspace-reference-stale')) staleInspections.push(parsed.error); } } catch {} }));
 await page.goto(start.url);
 await page.waitForURL(url=>url.searchParams.has('forgeaxWorkspaceTarget'),{timeout:120000});
 await page.waitForFunction(()=>{
   const failure = document.querySelector('#forgeax-fatal-details')?.textContent;
   if (failure) throw new Error(failure);
   return globalThis.__forgeaxViewReady?.mounted;
 },undefined,{timeout:120000});
 let state=await client.getState();
 const {assets}=await client.listAssets(state.project.id,{targetId:state.projectTarget.targetId});
 await writeFile(join(output,'assets.json'),JSON.stringify({state,assets},null,2));
 const asset=assets.find(a=>a.sourceKey==='scene/proof');
 assert.ok(asset,'author scene is catalogued');
 state=await client.openAsset(asset.guid,{projectId:state.project.id});
 await writeFile(join(output,'state.json'),JSON.stringify(state,null,2));
 await page.waitForTimeout(2000);
 await page.screenshot({path:join(output,'initial-ui.png')});
 await writeFile(join(output,'initial-dom.txt'),await page.locator('body').textContent());
 state=await client.getState();
 const target=state.previews.find(preview=>preview.asset?.guid===asset.guid)?.target;
 assert.ok(target,'Scene preview has an exact target');
 const sourcePath=asset.path ?? asset.sourcePath;
 console.log('TARGET', target.targetId, sourcePath);
 const call=(request)=>client.call('asset.source.draft',{projectId:state.project.id,targetId:target.targetId,previewTargetId:target.targetId,request});
 const generationParameters=page.getByTestId('panel-content-browser').getByLabel('Pack parameters',{exact:true});
 const waitForDraft=async(draftId, predicate, label)=>{
   const deadline=Date.now()+120000;
   let current;
   do {
     current=await call({action:'get',draftId});
     if(predicate(current)) return current;
     await page.waitForTimeout(100);
   } while(Date.now()<deadline);
   assert.fail(`${label}: ${JSON.stringify(current)}`);
 };
 await assert.rejects(()=>call({action:'open',sourcePath}));
 console.log('PAGES',JSON.stringify(await client.listPages()));
 console.log('REVEAL',JSON.stringify(await client.revealPack({projectId:state.project.id,sourcePath,revision:`sha256:${createHash('sha256').update(legacySource).digest('hex')}`})));
 await page.getByRole('button',{name:'Content Browser settings',exact:true}).click();
 const detailsPanel=page.getByRole('switch',{name:'Details panel',exact:true});
 if(!await detailsPanel.isChecked()) await detailsPanel.click();
 await page.keyboard.press('Escape');
 await client.call('presentation.panel.reveal',{panelId:'content-browser'});
 await page.getByRole('button',{name:'Expand details panel',exact:true}).click();
 await page.getByRole('tab',{name:'Generation Parameters',exact:true}).click();
 await page.getByTestId('panel-content-browser').getByRole('alert').waitFor();
 await page.getByText('Editable sun',{exact:true}).click();
 const inspectorDraft=page.getByLabel('Source draft',{exact:true});
 await inspectorDraft.getByRole('alert').waitFor();
 const documentMarker = await page.evaluate(()=>globalThis.__packRecoveryMarker=crypto.randomUUID());
 await writeFile(join(root,'assets/proof.pack.ts'),legacySource.replace('let legacyPackageId', 'const legacyPackageId'));
 await inspectorDraft.getByRole('alert').waitFor({state:'detached',timeout:30000});
 await client.call('presentation.panel.reveal',{panelId:'content-browser'});
 await page.getByText('No parameters exposed.',{exact:false}).waitFor({timeout:30000});
 assert.equal(await page.getByRole('button',{name:'Generate',exact:true}).count(),0,'an unparameterized Pack has no parameter generation controls');
 assert.equal(await page.getByRole('button',{name:'Rebuild source',exact:true}).count(),1,'an unparameterized TS Pack retains manual source generation');
 const unparameterized=await call({action:'open',sourcePath});
 failureDraft={projectId:state.project.id,targetId:target.targetId,previewTargetId:target.targetId,draftId:unparameterized.id,sourcePath};
 assert.deepEqual(unparameterized.fields,[],'the scaffold const identity supports drafts without changing its syntax');
 await page.screenshot({path:join(output,'no-parameters-ui.png')});
 await writeFile(join(root,'assets/proof.pack.ts'),editableSource);
 assert.equal(await page.evaluate(()=>globalThis.__packRecoveryMarker),documentMarker,'source repair retains the View document');
 assert.equal(await generationParameters.getByRole('alert').count(),0,'source recovery clears the old open error');
 let draft=await call({action:'open',sourcePath});
 console.log('DRAFT',JSON.stringify(draft));
 await generationParameters.waitFor();
 await page.locator('.dv-tab:visible').filter({hasText:'Runtime Parameter Settings'}).click();
 const runtimeParameters=page.locator('.cb-pack-author--runtime:visible');
 const otherAssetParameters=runtimeParameters.getByRole('button',{name:'Runtime parameters of other assets',exact:true});
 await otherAssetParameters.waitFor({timeout:30000});
 await otherAssetParameters.click();
 const bodyColorInput=runtimeParameters.getByRole('textbox',{name:'Body Color',exact:true});
 await bodyColorInput.scrollIntoViewIfNeeded();
 await bodyColorInput.waitFor({timeout:30000});
 const gripHandle=page.locator('.fx-edge-drawer-grip');
 const grip=await gripHandle.count()?await gripHandle.boundingBox():null;
 if(grip){await page.mouse.move(grip.x+20,grip.y+3);await page.mouse.down();await page.mouse.move(grip.x+20,grip.y-330,{steps:15});await page.mouse.up();}
 const dividerHandle=page.locator('[data-testid="panel-content-browser"] .cb-resize-handle').last();
 const divider=await dividerHandle.count()?await dividerHandle.boundingBox():null;
 if(divider){await page.mouse.move(divider.x+2,divider.y+25);await page.mouse.down();await page.mouse.move(divider.x-240,divider.y+25,{steps:15});await page.mouse.up();}
 const capture=async(name)=>{
   const result=await client.capture({targetId:target.targetId,targetGeneration:target.generation});
   const bytes=Buffer.from(result.png.split(',')[1],'base64');
   await writeFile(join(output,`${name}.png`),bytes);
   const image=parseImage(bytes,'image/png',{mipmap:false}).unwrap();
   return [...image.bytes.slice((Math.floor(image.height/2)*image.width+Math.floor(image.width/2))*4,(Math.floor(image.height/2)*image.width+Math.floor(image.width/2))*4+3)];
 };
 const warm=await capture('source-frame');
 assert.ok(warm[0]>warm[1]+50,'source frame is orange');
 await page.screenshot({path:join(output,'parameters-ui.png')});
 const before=await readFile(join(root,'assets/proof.pack.ts'),'utf8');
 await bodyColorInput.fill('#3FDA7C');
 for(let attempt=0;attempt<50;attempt++) {
   draft=await call({action:'get',draftId:draft.id});
   if(draft.unsaved)break;
   await page.waitForTimeout(100);
 }
 assert.equal(draft.unsaved,true);
 assert.equal(draft.preview,'ready',JSON.stringify(draft));
 assert.equal(await readFile(join(root,'assets/proof.pack.ts'),'utf8'),before);
 await page.waitForTimeout(500);
 await page.screenshot({path:join(output,'live-ui.png')});
 await client.call('presentation.panel.reveal',{panelId:'content-browser'});
 await page.getByTestId('panel-content-browser').getByRole('tab',{name:'Generation Parameters',exact:true}).click();
 await page.getByRole('button',{name:'Generate',exact:true}).click();
 draft=await waitForDraft(draft.id,current=>!current.needsGeneration && !current.generating && current.preview==='ready','generation did not finish');
 await page.getByRole('button',{name:'Generate',exact:true}).waitFor();
 console.log('GENERATE',JSON.stringify(draft));
 assert.equal(draft.needsGeneration,false,JSON.stringify(draft));
 assert.equal(draft.preview,'ready',JSON.stringify(draft));
 await page.waitForTimeout(500);
 const generatedTree = await client.getSceneTree({projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation});
 await writeFile(join(output,'generated-tree.json'),JSON.stringify(generatedTree,null,2));
 await writeFile(join(output,'generated-entities.json'),JSON.stringify(await Promise.all(generatedTree.nodes.map(node=>client.call('entity.inspect',{projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation,entityId:node.entityId}))),null,2));
 const generatedPixel=await capture('generated-frame');
 assert.ok(generatedPixel[1]>generatedPixel[0]+50,`generated frame keeps current live green: ${generatedPixel}`);
 await page.locator('.cb-preview-body').evaluate(element=>{element.scrollTop=0;});
 await page.screenshot({path:join(output,'generated-ui.png')});
 const latencies=[];
 const liveStart=performance.now();
 for(let index=0;index<100;index++){
   const start=performance.now();
   draft=await call({action:'edit',draftId:draft.id,field:'bodyColor',value:[0.05,0.3+index/200,0.2,1]});
   latencies.push(performance.now()-start);
   assert.equal(draft.preview,'ready'); assert.equal(draft.needsGeneration,false);
 }
 assert.equal(await readFile(join(root,'assets/proof.pack.ts'),'utf8'),before,'100 edits preserve source bytes');
 const livePixel=await capture('live-100-frame');
 assert.ok(livePixel[1]>livePixel[0]+50,`live edits are visible: ${livePixel}`);
 const latency={count:100,totalMs:performance.now()-liveStart,medianMs:[...latencies].sort((a,b)=>a-b)[50],p95Ms:[...latencies].sort((a,b)=>a-b)[95]};
 console.log('LIVE',JSON.stringify(latency));
 const sceneAnchor=generatedTree.nodes.find(node=>node.parentId===null);
 await page.getByRole('treeitem').filter({hasText:`Entity ${sceneAnchor.entity}`}).locator('.caret').click();
 await page.getByText('Editable sun',{exact:true}).click();
 await page.locator('.dv-tab:visible').filter({hasText:'Inspector'}).click();
 await page.getByTestId('insp-comprow-DirectionalLight').click();
 const sunInput = page.getByRole('textbox',{name:'Runtime sunColor',exact:true});
 await sunInput.waitFor({timeout:30000});
 await sunInput.fill('[0.8,0.9,1]');
 for(let attempt=0;attempt<50;attempt++) {
   draft=await call({action:'get',draftId:draft.id});
   if(JSON.stringify(draft.values.sunColor)==='[0.8,0.9,1]')break;
   await page.waitForTimeout(100);
 }
 console.log('SUN EDIT RESULT',JSON.stringify(draft));
 assert.deepEqual(draft.values.sunColor,[0.8,0.9,1]);
 const sun=generatedTree.nodes.find(node=>node.name==='Editable sun');
 const sunState=await client.call('entity.inspect',{projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation,entityId:sun.entityId});
 const color=sunState.components.find(component=>component.name==='DirectionalLight').values.color;
 assert.ok(Math.abs(color[0]-.8)<1e-6 && Math.abs(color[1]-.9)<1e-6);
 assert.equal(await readFile(join(root,'assets/proof.pack.ts'),'utf8'),before);
 await page.screenshot({path:join(output,'inspector-ui.png')});
 await client.call('presentation.panel.reveal',{panelId:'content-browser'});
 await generationParameters.getByRole('button',{name:'Save',exact:true}).click();
 draft=await waitForDraft(draft.id,current=>!current.unsaved,'parameter save did not finish');
 await generationParameters.getByText('Editable form',{exact:true}).waitFor();
 assert.equal(draft.unsaved,false);assert.equal(draft.needsGeneration,false);
 const saved=await readFile(join(root,'assets/proof.pack.ts'),'utf8');
 assert.ok(saved.includes('[0.05,0.7949999999999999,0.2,1]')||saved.includes('[0.05,0.795,0.2,1]'));
 await page.getByRole('textbox',{name:'Radius',exact:true}).fill('1.4');
 draft=await waitForDraft(draft.id,current=>current.unsaved && current.needsGeneration,'radius edit did not reach the draft');
 await generationParameters.getByRole('button',{name:'Save',exact:true}).waitFor();
 await generationParameters.getByRole('button',{name:'Save',exact:true}).click();
 draft=await waitForDraft(draft.id,current=>!current.unsaved,'radius save did not finish');
 await generationParameters.getByText('Editable form',{exact:true}).waitFor();
 assert.equal(draft.needsGeneration,true);
 await page.getByRole('button',{name:'Generate',exact:true}).click();
 draft=await waitForDraft(draft.id,current=>!current.needsGeneration && !current.generating && current.preview==='ready','radius generation did not finish');
 await page.getByRole('button',{name:'Generate',exact:true}).waitFor();
 await page.waitForTimeout(300);
 assert.ok((await capture('resized-frame'))[1]>100);
 const tree=await client.getSceneTree({projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation});
 await writeFile(join(output,'tree.json'),JSON.stringify(tree,null,2));
 await call({action:'close',draftId:draft.id});
 draft=await call({action:'open',sourcePath});
 assert.equal(draft.values.radius,1.4);assert.ok(Math.abs(draft.values.bodyColor[1]-.795)<1e-6);
 await page.locator('.cb-preview-body').evaluate(element=>{element.scrollTop=0;});
 await page.screenshot({path:join(output,'saved-ui.png')});
 const jsonCall=request=>client.call('asset.source.draft',{projectId:state.project.id,targetId:target.targetId,request});
 const directBefore=await readFile(join(root,'assets/direct.pack.json'),'utf8');
 let direct=await jsonCall({action:'open',sourcePath:'assets/direct.pack.json'});
 const directColor=direct.fields.find(field=>field.apply?.path?.at(-1)==='color');
 assert.ok(directColor,'direct JSON exposes its original field');
 await jsonCall({action:'edit',draftId:direct.id,field:directColor.name,value:[0.3,0.4,0.5]});
 assert.equal(await readFile(join(root,'assets/direct.pack.json'),'utf8'),directBefore);
 direct=await jsonCall({action:'save',draftId:direct.id});
 assert.equal(direct.unsaved,false);
 assert.deepEqual(JSON.parse(await readFile(join(root,'assets/direct.pack.json'),'utf8')).assets['scene/json'].payload.entities.sun.components.DirectionalLight.color,[0.3,0.4,0.5]);
 await jsonCall({action:'close',draftId:direct.id});
 const beforeExposure=await readFile(join(root,'assets/proof.pack.ts'),'utf8');
 const exposed=beforeExposure.replace('  ],\n  build', "    { name:'sunIntensity',type:'f32',default:2,apply:{asset:'scene/proof',path:['entities','sun','components','DirectionalLight','intensity']} },\n  ],\n  build").replace(', intensity: 2','');
 assert.notEqual(exposed,beforeExposure);
 await writeFile(join(root,'assets/proof.pack.ts'),exposed);
 await page.locator('.dv-tab:visible').filter({hasText:'Runtime Parameter Settings'}).click();
 await page.getByRole('textbox',{name:'Sun Intensity',exact:true}).waitFor({timeout:30000});
 draft=await call({action:'get',draftId:draft.id});
 assert.equal(draft.values.sunIntensity,2);assert.equal(draft.generating,false);
 await page.screenshot({path:join(output,'new-parameter-ui.png')});
 const runtimeOnlySource=(await readFile(join(root,'assets/proof.pack.ts'),'utf8'))
   .replace(/    \{ name: 'radius'[^\n]+\n/,'').replaceAll('values.radius','1.4');
 await client.call('presentation.panel.reveal',{panelId:'content-browser'});
 const radiusInput=page.getByTestId('panel-content-browser').getByRole('textbox',{name:'Radius',exact:true});
 await radiusInput.waitFor();
 await writeFile(join(root,'assets/proof.pack.ts'),runtimeOnlySource);
 try {
   await radiusInput.waitFor({state:'detached',timeout:30000});
 } catch(error) {
   await writeFile(join(output,'runtime-only-state.json'),JSON.stringify({draft:await call({action:'get',draftId:draft.id}),state:await client.getState()},null,2));
   throw error;
 }
 await page.locator('.dv-tab:visible').filter({hasText:'Runtime Parameter Settings'}).click();
 const runtimePanel=page.locator('.cb-pack-author--runtime:visible');
 assert.equal(await runtimePanel.getByText('Generation parameters',{exact:true}).count(),0);
 assert.equal(await runtimePanel.getByRole('button',{name:'Generate',exact:true}).count(),0);
 assert.equal(await runtimePanel.getByText('Needs generation',{exact:true}).count(),0);
 await runtimePanel.getByRole('textbox',{name:'Sun Intensity',exact:true}).fill('1');
 for(let attempt=0;attempt<50;attempt++) {
   draft=await call({action:'get',draftId:draft.id});
   if(draft.values.sunIntensity===1)break;
   await page.waitForTimeout(100);
 }
 assert.equal(draft.unsaved,true);
 assert.equal(draft.values.sunIntensity,1);
 assert.equal(draft.preview,'ready');
 assert.equal(await readFile(join(root,'assets/proof.pack.ts'),'utf8'),runtimeOnlySource);
 await runtimePanel.getByRole('button',{name:'Save',exact:true}).click();
 draft=await waitForDraft(draft.id,current=>!current.unsaved,'runtime parameter save did not finish');
 await runtimePanel.getByText('Editable form',{exact:true}).waitFor();
 const runtimeOnlySaved=await readFile(join(root,'assets/proof.pack.ts'),'utf8');
 await client.closePreview({projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation});
 const reopenDeadline=Date.now()+30000;
 for(;;) {
  try {
   state=await client.openAsset(asset.guid,{projectId:state.project.id,targetId:target.targetId});
   break;
  } catch(error) {
   if(error.detail?.cause?.failure?.detail?.code!=='asset-superseded' || Date.now()>=reopenDeadline) throw error;
   await page.waitForTimeout(250);
  }
 }
 Object.assign(target,state.scenePreview.target);
 const reopenedTree=await client.getSceneTree({projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation});
 const reopenedSun=reopenedTree.nodes.find(node=>node.name==='Editable sun');
 assert.ok(reopenedSun,'reopened scene creates its Sun');
 const reopenedInspection=await client.call('entity.inspect',{projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation,entityId:reopenedSun.entityId});
 const reopenedIntensity=reopenedInspection.components.find(component=>component.name==='DirectionalLight').values.intensity;
 assert.ok(Math.abs(reopenedIntensity-1)<1e-6,`saved Sun intensity survives scene reopen without a draft replay: ${reopenedIntensity}`);
 assert.equal(await runtimePanel.getByRole('textbox',{name:'Sun Intensity',exact:true}).inputValue(),'1','the parameter panel agrees with the reopened Scene');
 await writeFile(join(output,'saved-reopened-sun.json'),JSON.stringify({target,reopenedIntensity,draft:await call({action:'get',draftId:draft.id})},null,2));
 await page.screenshot({path:join(output,'saved-reopened-sun.png')});
 await client.call('presentation.panel.reveal',{panelId:'content-browser'});
 await generationParameters.getByRole('button',{name:'Rebuild source',exact:true}).click();
 await generationParameters.getByRole('button',{name:/^Rebuilding/}).waitFor();
 await generationParameters.getByRole('button',{name:'Rebuild source',exact:true}).waitFor({timeout:120000});
 draft=await call({action:'get',draftId:draft.id});
 assert.equal(draft.needsGeneration,false,'manual rebuilding still works without generation inputs');
 assert.equal(draft.preview,'ready');
 assert.equal(draft.values.sunIntensity,1,'manual rebuilding preserves live author values');
 assert.equal(await readFile(join(root,'assets/proof.pack.ts'),'utf8'),runtimeOnlySaved,'manual rebuilding does not save source');
 await page.locator('.dv-tab:visible').filter({hasText:'Runtime Parameter Settings'}).click();
 await page.screenshot({path:join(output,'runtime-only-ui.png')});
 await call({action:'edit',draftId:draft.id,field:'bodyColor',value:[0.4,0.5,0.2,1]});
 const currentSource=await readFile(join(root,'assets/proof.pack.ts'),'utf8');
 const foreign=currentSource.replace(/default: \[0\.05,[^\]]+\]/,'default: [0.9,0.1,0.2,1]');
 assert.notEqual(foreign,currentSource);
 await writeFile(join(root,'assets/proof.pack.ts'),foreign);
 draft=await call({action:'refresh',draftId:draft.id});
 assert.ok(draft.conflicts.includes('bodyColor'));
 await assert.rejects(()=>call({action:'save',draftId:draft.id}));
 assert.equal(await readFile(join(root,'assets/proof.pack.ts'),'utf8'),foreign);
 assert.equal(staleInspections.length,0,'generation retires Inspector selection before replacing scene entities');
 await call({action:'discard',draftId:draft.id});
 await client.closePreview({projectId:state.project.id,targetId:target.targetId,targetGeneration:target.generation});
 draft=await jsonCall({action:'edit',draftId:draft.id,field:'bodyColor',value:[0.2,0.3,0.4,1]});
 assert.equal(draft.preview,'unavailable');assert.equal(draft.unsaved,true);
 await jsonCall({action:'close',draftId:draft.id,discard:true});
 assert.deepEqual(errors,[],'browser reports no uncaught page errors');
 await writeFile(join(output,'latency.json'),JSON.stringify(latency,null,2));
 await writeFile(join(output,'result.json'),JSON.stringify({passed:true,draft,errors},null,2));
} catch(error) {
 const source=await readFile(join(root,'assets/proof.pack.ts'),'utf8').catch(cause=>({error:String(cause)}));
 const draft=failureDraft===undefined ? undefined : await client.call('asset.source.draft',{
  projectId:failureDraft.projectId,targetId:failureDraft.targetId,previewTargetId:failureDraft.previewTargetId,
  request:{action:'get',draftId:failureDraft.draftId},
 }).catch(cause=>({error:String(cause)}));
 await writeFile(join(output,'failure-source-state.json'),JSON.stringify({
  source,sourceDigest:typeof source==='string'?createHash('sha256').update(source).digest('hex'):undefined,
  draft,workspace:await client.getState().catch(cause=>({error:String(cause)})),
  dom:await page.locator('body').textContent().catch(cause=>String(cause)),
 },null,2));
 const observed=await page.evaluate(()=>JSON.parse(JSON.stringify({renderer:globalThis.__forgeaxGameInspection?.renderer(),globals:Object.keys(globalThis.__forgeax??{})},(_key,value)=>value instanceof Error?{...value,message:value.message}:value))).catch(cause=>({error:String(cause)}));
 await writeFile(join(output,'render-failure.json'),JSON.stringify(observed,null,2));
 const tape=await page.evaluate(async()=>{
  if(!globalThis.__forgeax?.captureFrame)return {ok:false,error:{code:'capture-unavailable'}};
  let timer;
  const result=await Promise.race([globalThis.__forgeax.captureFrame({snapshotTimeoutMs:5000}),new Promise(resolve=>{timer=setTimeout(()=>resolve({ok:false,error:{code:'capture-timeout'}}),10000);})]).finally(()=>clearTimeout(timer));
  if(!result.ok)return result;
  globalThis.__packFailureTape=result.value.chunks(65536)[Symbol.iterator]();
  return {ok:true,digest:result.value.digest,byteLength:result.value.byteLength};
 }).catch(cause=>({ok:false,error:String(cause)}));
 if(tape.ok){
  const chunks=[];
  for(;;){const part=await page.evaluate(()=>{const result=globalThis.__packFailureTape.next();if(result.done)return null;let binary='';for(const byte of result.value.bytes)binary+=String.fromCharCode(byte);return btoa(binary);});if(part===null)break;chunks.push(Buffer.from(part,'base64'));}
  await writeFile(join(output,'failing-frame.rhitape'),Buffer.concat(chunks));
  const {decodeTape,buildFrameModel}=await import('@forgeax/engine/rhi-debug');
  const model=buildFrameModel(decodeTape(Buffer.concat(chunks)).unwrap());
  await writeFile(join(output,'failing-work.json'),JSON.stringify({works:model.works,resources:model.resources.map(r=>({id:r.handleId,descriptor:r.descriptor}))},null,2));
 }
 await writeFile(join(output,'failing-frame.json'),JSON.stringify(tape,null,2));
 await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
 await writeFile(join(output,'failure.txt'),String(error.stack)+'\n'+await page.locator('body').textContent());
 throw error;
} finally {
 await client.close(); await browser.close();
 if(process.env.FORGEAX_PACK_AUTHORING_KEEP!=='1') await command('backend','stop');
}
