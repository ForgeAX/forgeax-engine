import { createApp } from '@forgeax/engine/app/browser';
import {FixedTime,FixedUpdate,Update} from '@forgeax/engine/ecs';
import {createBoxGeometry} from '@forgeax/engine/geometry';
import {Camera,Materials,MeshFilter,MeshRenderer,perspective} from '@forgeax/engine/render';
import {ChildOf,Transform,Name} from '@forgeax/engine/scene';
import {quat} from '@forgeax/engine/math';
import { Collider } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {navigationCharacterPlugin,NavigationCharacter,NavigationAgent,setNavigationTarget} from '@forgeax/engine/navigation';
import {forgeaxBundlerAdapter} from 'virtual:forgeax/bundler';
import {loadNavigationScene,sceneGuid} from './simulation.mjs';
const canvas=document.querySelector('canvas'),status=document.querySelector('#status');
const result=await createApp(canvas,{time:{fixedDeltaSeconds:1/60,maxStepsPerUpdate:1},plugins:[physics3d]},forgeaxBundlerAdapter());if(!result.ok)throw result.error;
const app=result.value,world=app.world,registry=app.assets;app.onError(e=>{window.navigationError={code:e.code,hint:e.hint,detail:e.detail};status.textContent=JSON.stringify(window.navigationError);});
const {asset,handle}=await loadNavigationScene(registry,world);await app.pluginContext.plugin(navigationCharacterPlugin(handle));registry.release(handle).unwrap();registry.instantiateFlat((await registry.load(registry.parseGuid(sceneGuid),'scene')).unwrap(),world).unwrap();
const mat=(rgba)=>registry.create(Materials.unlit(rgba)).unwrap(),floorMaterial=mat([.12,.19,.24,1]),wallMaterial=mat([.28,.35,.43,1]),teal=mat([.12,.65,.57,1]),gold=mat([1,.75,.15,1]),blue=mat([.25,.55,1,1]),red=mat([1,.35,.27,1]);
const cube=registry.create(createBoxGeometry(1,1,1).unwrap()).unwrap();
const spawn=(pos,scale,material,parent)=>world.spawn({component:Transform,data:{pos,scale}},{component:MeshFilter,data:{assetHandle:cube}},{component:MeshRenderer,data:{materials:[material]}},...(parent===undefined?[]:[{component:ChildOf,data:{parent}}])).unwrap();
for(const e of Array.from(world.query({with:[Collider,Transform]}).unwrap(),row=>row.entity)){const c=world.get(e,Collider).unwrap();if(world.hasComponent(e,NavigationCharacter)){spawn([0,0,0],[.6,1.6,.6],world.get(e,Transform).unwrap().pos[0]<0?blue:red,e);for(let i=0;i<32;i++){const a=i*Math.PI/16;spawn([Math.cos(a)*.31,-.67,Math.sin(a)*.31],[.045,.035,.045],gold,e);}}else spawn([0,0,0],Array.from(c.halfExtents,x=>x*2),c.halfExtents[1]<.2?floorMaterial:wallMaterial,e);}
// Ordinary retained meshes visualize producer/query facts; no new simulation authority.
for(const polygon of asset.polygons)for(let i=0;i<polygon.length;i++){const a=polygon[i]*3,b=polygon[(i+1)%polygon.length]*3,x=(asset.vertices[a]+asset.vertices[b])/2,z=(asset.vertices[a+2]+asset.vertices[b+2])/2,dx=asset.vertices[b]-asset.vertices[a],dz=asset.vertices[b+2]-asset.vertices[a+2],e=spawn([x,.08,z],[Math.hypot(dx,dz),.025,.025],teal);world.set(e,Transform,{quat:[0,Math.sin(-Math.atan2(dz,dx)/2),0,Math.cos(-Math.atan2(dz,dx)/2)]}).unwrap();}
const eye=[10,13,14];world.spawn({component:Transform,data:{pos:eye,quat:quat.fromLookAt(quat.create(),eye,[0,0,0],[0,1,0])}},{component:Camera,data:{...perspective({fov:.8,aspect:1120/700}),clearColor:[.035,.055,.08,1]}}).unwrap();
const actors=Array.from(world.query({with:[NavigationCharacter]}).unwrap(),r=>r.entity),starts=actors.map(e=>[...world.get(e,Transform).unwrap().pos]);let target=false,paths=[];
function retarget(){target=!target;for(const e of paths)world.despawn(e).unwrap();paths=[];for(let i=0;i<actors.length;i++){const goal=target?[-starts[i][0],0,-starts[i][2]]:[starts[i][0],0,starts[i][2]];setNavigationTarget(world,actors[i],goal,{maxProjection:.3}).unwrap();const p=world.get(actors[i],NavigationAgent).unwrap().path;for(let j=3;j<p.length;j+=3){const dx=p[j]-p[j-3],dz=p[j+2]-p[j-1],e=spawn([(p[j]+p[j-3])/2,.12,(p[j+2]+p[j-1])/2],[Math.hypot(dx,dz),.035,.035],gold);world.set(e,Transform,{quat:[0,Math.sin(-Math.atan2(dz,dx)/2),0,Math.cos(-Math.atan2(dz,dx)/2)]}).unwrap();paths.push(e);}}}
document.querySelector('#run').onclick=retarget;retarget();
window.navigationReady=true;window.navigationApp=app;window.navigationAsset=asset;
world.addSystem(Update,{name:'navigation-evidence-hud',queries:[],fn(){window.navigationState={tick:world.getResource(FixedTime).tick,sourceDigest:asset.sourceDigest,actors:actors.map((e,i)=>({goal:target?[-starts[i][0],-starts[i][2]]:[starts[i][0],starts[i][2]],position:[...world.get(e,Transform).unwrap().pos],status:world.get(e,NavigationAgent).unwrap().status,desired:[...world.get(e,NavigationCharacter).unwrap().desired],actual:[...world.get(e,NavigationCharacter).unwrap().actual]}))};status.textContent=JSON.stringify(window.navigationState,null,2);}}).unwrap();
window.runNavigationWorker=()=>new Promise((resolve,reject)=>{const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});worker.onmessage=event=>{worker.terminate();resolve(event.data);};worker.onerror=event=>{worker.terminate();reject(new Error(event.message));};worker.postMessage({});});
app.start().unwrap();

window.runNavigationReplay=async(bytes)=>{
 const debug=await import('@forgeax/engine/rhi-debug'),gpu=await import('@forgeax/engine/rhi-webgpu');
 const tape=debug.decodeTape(new Uint8Array(bytes)).unwrap(),model=debug.buildFrameModel(tape);
 const adapter=(await gpu.rhi.requestAdapter()).unwrap(),device=(await adapter.requestDevice(debug.replayDeviceRequest(tape,adapter.features,adapter.limits))).unwrap();
 const native=device.nativeDevice().unwrap(),validation=[];
 native.addEventListener('uncapturederror',event=>validation.push({kind:'uncaptured',message:event.error.message}));
 const replay=(await debug.openReplay(tape,{device,createShaderModule:gpu.createShaderModule})).unwrap();
 try {
   const geometry=model.works.find(w=>w.kind==='drawIndexed'&&w.attachments?.colorViewHandleIds?.some(Boolean));
   const output=[...model.works].reverse().find(w=>w.kind==='draw'&&w.attachments?.colorViewHandleIds?.some(Boolean));
   if(!geometry||!output)throw new Error('Missing geometric or final color work');
   window.navigationReplayReadbacks=[];const inspections={};
   for(const [name,work] of [['geometry',geometry],['output',output]]){
     native.pushErrorScope('validation');
     const inspected=await replay.inspectWork(work.workIndex,['pipeline','bindings','pixels']);
     const error=await native.popErrorScope();if(error)validation.push({kind:'validation',name,workIndex:work.workIndex,message:error.message});
     if(!inspected.ok){inspections[name]={ok:false,error:inspected.error};continue;}
     const attachment=inspected.value.attachment;
     if(!attachment)throw new Error('Selected work has no readback');
     const digest=await crypto.subtle.digest('SHA-256',attachment.bytes.slice().buffer);
     const sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
     window.navigationReplayReadbacks.push({name,bytes:attachment.bytes});
     inspections[name]={ok:true,value:{...inspected.value,attachment:{...attachment,bytes:undefined,byteLength:attachment.bytes.length,sha256}}};
   }
   return {adapter:{features:[...adapter.features],limits:adapter.limits},model:{works:model.works,resources:model.resources,unseededResources:model.unseededResources,passes:model.passes},inspections,validation};
 }finally{(await replay.dispose()).unwrap();device.nativeDevice().unwrap().destroy();}
};
