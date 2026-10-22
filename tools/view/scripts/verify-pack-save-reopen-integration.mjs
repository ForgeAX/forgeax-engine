import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { connectViewWorkspace } from '../dist/modules/workspace/resident.mjs';
import { writeProofGameAssets } from './fixtures/plugin-assets.mjs';

const checkout=resolve(import.meta.dirname,'../../..');
const root=resolve(checkout,'artifacts/pack-save-reopen/project');
const output=resolve(checkout,'artifacts/pack-save-reopen');
const view=resolve(checkout,'tools/view');
await mkdir(join(root,'assets'),{recursive:true});
await mkdir(join(root,'node_modules/@forgeax'),{recursive:true});
for(const [name,path] of [['engine',join(checkout,'packages/engine')],['view',view]]) {
  await symlink(path,join(root,'node_modules/@forgeax',name)).catch(error=>{if(error.code!=='EEXIST')throw error;});
}
const sourcePath='assets/proof.pack.ts';
const source=(await readFile(join(import.meta.dirname,'fixtures/pack-authoring.pack.ts'),'utf8'))
  .replace(/  parameters: \[[\s\S]*?\n  \],/,`  parameters: [{ name: 'sunIntensity', type: 'f32', default: 3.2, apply: { asset: 'scene/proof', path: ['entities','sun','components','DirectionalLight','intensity'] } }],`)
  .replaceAll('values.radius','1').replace('intensity: 2','')
  .replace('values: materialValues','values: { ...materialValues, baseColor: [0.9, 0.25, 0.08, 1] }');
await writeFile(join(root,sourcePath),source);
await writeFile(join(root,'assets/game.plugin.ts'),await readFile(join(view,'scripts/fixtures/workspace-proof.plugin.ts'),'utf8'));
const roots=await writeProofGameAssets(root);
await writeFile(join(root,'package.json'),JSON.stringify({name:'pack-save-reopen',type:'module',dependencies:{'@forgeax/engine':'*','@forgeax/view':'*'}}));
await writeFile(join(root,'forge.json'),JSON.stringify({schemaVersion:'3.0.0',id:'pack-save-reopen',name:'Pack save/reopen',assetRoots:['assets'],roots}));
const command=async(...args)=>{
  const result=await runUnifiedCli([...args,'--root',root,'--json']);
  assert.ok(result.ok,JSON.stringify(result));
  return result.value;
};
await command('project','engine','use-local',checkout);
await command('backend','start','--host-pack',join(view,'host.pack.json'));
const start=await command('view','start');
const bootstrap=await fetch(new URL('/__forgeax/view/bootstrap',start.url)).then(response=>response.json());
const client=await connectViewWorkspace({endpoint:bootstrap.endpoint,token:bootstrap.token,clientId:'save-reopen-proof'});
const launch=JSON.parse(await readFile(join(checkout,'scripts/ci/browser-launch.json'),'utf8'));
const browser=await chromium.launch({...launch,headless:true,
  executablePath:process.env.FORGEAX_BROWSER_EXECUTABLE??'/usr/bin/google-chrome',channel:undefined,
  args:[...launch.args,'--use-angle=swiftshader'],chromiumSandbox:true});
const page=await browser.newPage({viewport:{width:1680,height:1200}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
try {
  await page.goto(start.url);
  await page.waitForURL(url=>url.searchParams.has('forgeaxWorkspaceTarget'),{timeout:120000});
  await page.waitForFunction(()=>globalThis.__forgeaxViewReady?.mounted,undefined,{timeout:120000});
  let state=await client.getState();
  const projectId=state.project.id;
  const {assets}=await client.listAssets(projectId,{targetId:state.projectTarget.targetId});
  const asset=assets.find(row=>row.sourceKey==='scene/proof');
  assert.ok(asset);
  state=await client.openAsset(asset.guid,{projectId,targetId:state.projectTarget.targetId});
  let target=state.scenePreview.target;
  const call=request=>client.call('asset.source.draft',{projectId,targetId:target.targetId,previewTargetId:target.targetId,request});
  let draft=await call({action:'open',sourcePath});
  const observations=[];
  const intensity=async()=>{
    const tree=await client.getSceneTree({projectId,targetId:target.targetId,targetGeneration:target.generation});
    const sun=tree.nodes.find(row=>row.name==='Editable sun');
    const inspection=await client.call('entity.inspect',{projectId,targetId:target.targetId,targetGeneration:target.generation,entityId:sun.entityId});
    return inspection.components.find(row=>row.name==='DirectionalLight').values.intensity;
  };
  assert.ok(Math.abs(await intensity()-3.2)<1e-6);
  for(const value of [1,3.2,1]) {
    await call({action:'edit',draftId:draft.id,field:'sunIntensity',value});
    assert.ok(Math.abs(await intensity()-value)<1e-6);
    draft=await call({action:'save',draftId:draft.id});
    assert.equal(draft.unsaved,false);
    await client.closePreview({projectId,targetId:target.targetId,targetGeneration:target.generation});
    state=await client.openAsset(asset.guid,{projectId,targetId:target.targetId});
    target=state.scenePreview.target;
    const actual=await intensity();
    observations.push({value,actual,generation:target.generation});
    console.log('REOPEN',JSON.stringify(observations.at(-1)));
    assert.ok(Math.abs(actual-value)<1e-6,'saved source survives reopening without draft replay');
  }
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,observations,errors},null,2));
  await page.screenshot({path:join(output,'saved-one-reopened.png')});
  assert.deepEqual(errors,[]);
} catch(error) {
  await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  await writeFile(join(output,'failure.txt'),String(error.stack));
  throw error;
} finally {
  await client.close();
  await browser.close();
  await command('backend','stop');
}
