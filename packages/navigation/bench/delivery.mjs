import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import { createWorldContext,World,componentDefinition } from '../../ecs/dist/index.mjs';
import { AssetGuid,definePack,definePackageId } from '../../pack/dist/scriptable-pack.mjs';
import { finalizePackageTransportSource } from '../../pack/dist/build.mjs';
import { buildScriptablePack,createStandardAssetOutputProducerRegistry } from '../../import/dist/index.mjs';
import { bakeNavigationMesh } from '../../import/dist/navigation-bake.mjs';
import { AssetRegistry } from '../../assets-runtime/dist/index.mjs';
import { ShaderRegistry } from '../../shader/dist/index.mjs';
import { physicsPlugin } from '../../physics/dist/index.mjs';
import { SceneInstance } from '../../render/dist/index.mjs';
import { Transform } from '../../scene/dist/index.mjs';
import { ok } from '../../types/dist/index.mjs';
import { createNavigationMesh,navigationCharacterPlugin,NavigationCharacter,NavigationAgent,NavigationAgentStatus,setNavigationTarget } from '../dist/index.mjs';
import { settings,doorway,actor } from './fixtures.mjs';
export const packageId=definePackageId('01a10100-1112-7000-8000-000000000001');
export const navGuid=AssetGuid.format(AssetGuid.derive(packageId,'navigation'));
export const sceneGuid=AssetGuid.format(AssetGuid.derive(packageId,'scene'));
export async function produceNavigationFixture({geometry=doorway(1.6),bakeSettings={...settings,radius:0.35},actors=[actor(-4)],base='/',sceneComponents}={}) {
  const baked=(await bakeNavigationMesh({geometry,settings:bakeSettings})).unwrap();
  const scene={kind:'scene',entities:Object.fromEntries([...geometry.map((entry,i)=>[`geometry-${i}`,{components:entry.components}]),...actors.map((entry,i)=>[`actor-${i}`,entry])])};
  const definition=definePack({schemaVersion:'2.0.0',packageId,build:()=>ok({navigation:baked,scene})});
  const product=(await buildScriptablePack({definition,sourcePath:'navigation.pack.ts',sourceClosure:[{path:'navigation-input.json',digest:baked.sourceDigest}],outputs:createStandardAssetOutputProducerRegistry(sceneComponents),availableGuids:new Set()})).unwrap();
  const files=new Map();
  const finalized=await finalizePackageTransportSource(product.product,{base,packagePath:'navigation.pack.json',artifactPath:(guid,key)=>`${guid}/${key}.bin`,sink:(path,bytes)=>files.set(path,bytes)});
  files.set('navigation.pack.json',Buffer.from(JSON.stringify(finalized.pack)));
  files.set('pack-index.json',Buffer.from(JSON.stringify(finalized.pack.assets.map(a=>({guid:a.guid,kind:a.kind,sourceKey:a.guid===navGuid?'navigation':'scene',sourcePath:'navigation.pack.ts',packageUrl:`${base}navigation.pack.json`})))));
  files.set('cook-receipt.json',Buffer.from(JSON.stringify({inputFingerprint:product.inputFingerprint,sourceDigest:baked.sourceDigest,receipts:finalized.receipts})));
  return {baked,scene,files,finalized,inputFingerprint:product.inputFingerprint};
}
export function componentVocabulary(world) {return [...world.components.entries()].map(([name,token])=>({name,fields:Object.fromEntries(Object.entries(componentDefinition(token).fields).map(([key,field])=>[key,field.type]))}));}
export async function validateDelivery() {
  const scratch=new World(),realm=await createWorldContext(scratch,[navigationCharacterPlugin(createNavigationMesh((await bakeNavigationMesh({geometry:doorway(1.6),settings:{...settings,radius:0.35}})).unwrap()).unwrap())]);
  scratch.components.register(SceneInstance).unwrap();const vocabulary=componentVocabulary(scratch);await realm.fiber.dispose();
  let files;
  const server=createServer((req,res)=>{const bytes=files?.get(req.url.slice(1));if(!bytes){res.writeHead(404);res.end();return;}res.end(bytes);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/`;
  try {
    const first=await produceNavigationFixture({base,sceneComponents:vocabulary});files=first.files;const cold=[];
    for(let restart=0;restart<2;restart++) {
      const registry=new AssetRegistry(new ShaderRegistry({manifestUrl:undefined}));registry.configurePackIndex(`${base}pack-index.json`);
      const asset=(await registry.loadByGuid(registry.parseGuid(navGuid))).unwrap(),scene=(await registry.loadByGuid(registry.parseGuid(sceneGuid))).unwrap(),mesh=createNavigationMesh(asset).unwrap();
      const world=new World(),ctx=await createWorldContext(world,[physicsPlugin('rapier-3d'),navigationCharacterPlugin(mesh)]);
      try {
        world.components.register(SceneInstance).unwrap();
        registry.instantiateFlat(world.allocSharedRef('SceneAsset',scene),world).unwrap();
        const entity=[...world.query({with:[NavigationCharacter]}).unwrap()][0].entity;setNavigationTarget(world,entity,[4,0,0],{maxProjection:0.3}).unwrap();
        for(let frame=0;frame<1200;frame++)world.update(1/60).unwrap();
        const agent=world.get(entity,NavigationAgent).unwrap(),position=[...world.get(entity,Transform).unwrap().pos];
        assert.equal(agent.status,NavigationAgentStatus.arrived);assert.ok(Math.hypot(position[0]-4,position[2])<=0.08);cold.push({restart,sourceDigest:asset.sourceDigest,position,status:agent.status});
      } finally {await ctx.fiber.dispose();}
    }
    const second=await produceNavigationFixture({base,sceneComponents:vocabulary,bakeSettings:{...settings,radius:0.6}});
    assert.notEqual(second.inputFingerprint,first.inputFingerprint);assert.notEqual(second.baked.sourceDigest,first.baked.sourceDigest);
    assert.deepEqual(first.finalized.pack.assets.map(a=>a.guid),second.finalized.pack.assets.map(a=>a.guid));
    return {cold,navGuid,sceneGuid,inputFingerprint:first.inputFingerprint,reimportFingerprint:second.inputFingerprint};
  } finally {await new Promise(resolve=>server.close(resolve));}
}

if(process.argv[1]===new URL(import.meta.url).pathname){
  const output=new URL('../../../artifacts/roi-navigation/',import.meta.url);mkdirSync(output,{recursive:true});
  const result=await validateDelivery();writeFileSync(new URL('delivery.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
