import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { quat } from '@forgeax/engine/math';
import { Materials, Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective, Skylight, SkyboxBackground, SKYBOX_MODE_CUBEMAP, TONEMAP_ACES_FILMIC, ANTIALIAS_TAA } from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { ok, type Asset, type SceneAsset } from '@forgeax/engine/types';
import { buildPalace } from './architecture.ts';

const STONE_GUID='01a09809-7a2d-7241-92a2-ef9a7f4aeab6';
const PAINT_GUID='01a097b9-28cd-7a1a-98de-0ba786fd061c';
const textureByMaterial:Record<string,string>={caihua:PAINT_GUID,marble:STONE_GUID,stone:STONE_GUID,'stone-dark':STONE_GUID,paving:STONE_GUID,'taihedian-plaque':'01a09875-1144-7616-a12b-f06d137a8d3b','jiaotaidian-plaque':'01a09875-143d-74ed-a63f-0fc10acb8f32'};
const ID=definePackageId('79ab1eb2-fcde-41c3-9177-e93dd5c18ef5');
const guid=(key:string)=>AssetGuid.derive(ID,key);
const ref=(key:string)=>AssetGuid.format(guid(key));
const sky=AssetGuid.format(AssetGuid.derive(definePackageId('ae95da62-8ad3-47d6-a814-32245a1b7a70'),'environment/daylight'));
export const SCENE_GUID=ref('scene/palace');
const palette:Record<string,[number,number,number,number]>={
  'taihedian-plaque':[1,1,1,.72],'jiaotaidian-plaque':[1,1,1,.72],
  roof:[.38,.17,.025,.55], 'roof-edge':[.41,.19,.03,.48], 'roof-aged':[.33,.14,.022,.6],
  timber:[.055,.033,.018,.86],caihua:[1,1,1,.72],water:[.025,.10,.075,.23],foliage:[.035,.10,.037,.91],bark:[.14,.075,.033,.95],
  red:[.32,.026,.016,.62], 'dark-red':[.115,.013,.009,.76],
  marble:[.76,.74,.67,.82], stone:[.46,.43,.37,.90], 'stone-dark':[.26,.25,.22,.94],
  blue:[.018,.052,.14,.65], green:[.014,.14,.12,.63], gold:[.66,.39,.08,.38],
  paving:[.23,.24,.23,.93], 'paving-joint':[.14,.15,.14,.96],
};
export default definePack({
  schemaVersion:'2.0.0',packageId:ID,name:'Forbidden City / Architecture',
  sceneComponents:[ChildOf,Camera,DirectionalLight,MeshFilter,MeshRenderer,Name,Transform,Skylight,SkyboxBackground],
  build:()=>{
    const outputs:Record<string,Asset>={};
    const size=128,data=new Uint8Array(size*size*4);
    let seed=4819;
    for(let i=0;i<size*size;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const grain=224+(seed>>>27);
      data.set([grain,grain,grain,255],i*4);
    }
    outputs['texture/surface-grain']={kind:'texture',shape:{viewDimension:'2d',extent:{width:size,height:size}},format:'rgba8unorm-srgb',colorSpace:'srgb',mips:{kind:'generate'},data};
    for(const [name,[r,g,b,roughness]] of Object.entries(palette)) outputs['material/'+name]=Materials.standard({baseColor:[r,g,b,1],roughness,baseColorTexture:textureByMaterial[name]??ref('texture/surface-grain'),metallic:name==='gold'?.6:0});
    const entities:Record<string,SceneAsset['entities'][string]>={};
    for(const [key,{mesh,material}] of Object.entries(buildPalace().meshes())){
      outputs['mesh/'+key]={...mesh,materialSlots:[{slotName:'surface',sourceKey:key,defaultMaterial:guid('material/'+material)}]};
      const subject=key.slice(0,key.indexOf('/'));
      entities[subject]??={components:{Name:{value:subject},Transform:{}}};
      entities[key]={components:{Name:{value:key},Transform:{},ChildOf:{parent:subject},MeshFilter:{assetHandle:ref('mesh/'+key)},MeshRenderer:{materials:[]}}};
    }
    const pos=[0,6.7,105] as const,target=[0,18,-5] as const,q=quat.fromLookAt(quat.create(),pos,target,[0,1,0]);
    entities.camera={components:{Name:{value:'Reference Camera'},Transform:{pos,quat:Array.from(q)},Camera:{...perspective({fov:Math.PI/4,aspect:16/9,near:.2,far:1500}),exposure:.95,tonemap:TONEMAP_ACES_FILMIC,antialias:ANTIALIAS_TAA}}};
    entities.sun={components:{Name:{value:'Beijing Sun'},DirectionalLight:{direction:[-.45,-.8,-.32],color:[1,.96,.87],intensity:3.4,castShadow:true,cascadeCount:4,mapSize:2048,shadowDistance:400,depthBias:.002,normalBias:.05,cascadeBlend:.15,splitLambda:.8}}};
    entities.sky={components:{Name:{value:'Beijing Sky'},SkyboxBackground:{equirect:sky,mode:SKYBOX_MODE_CUBEMAP}}};
    entities.ambient={components:{Skylight:{equirect:sky,color:[1,1,1],intensity:.85}}};
    outputs['scene/palace']={kind:'scene',entities};
    return ok(outputs);
  }
});
