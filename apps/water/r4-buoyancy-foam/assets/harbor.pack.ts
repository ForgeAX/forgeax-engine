import { EngineContent } from '@forgeax/engine/content';
import { createBoxGeometry, createMeshBuilder, createSphereGeometry } from '@forgeax/engine/geometry';
import { AssetGuid, definePack } from '@forgeax/engine/pack/source';
import { Collider, RigidBody } from '@forgeax/engine/physics';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { ChildOf, Name, Transform, WaterBodyInstance, WaterPontoonSet, WaterTerrainProvider, WaterZoneInstance } from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { buildTerrainAssets } from '@forgeax/engine/terrain/cook';
import { ok, standardSurfaceParameters, type MaterialAsset, type MaterialRootAsset, type SceneAsset, type SceneEntity, type WaterBodySource } from '@forgeax/engine/types';
import { buildWaterPackOutputs, cookWaterAsset, waterMaterialFamilySlots } from '@forgeax/engine/water';
import { FOAM_MATERIAL_MODES, foamMaterialKey, WATER_R4_PACKAGE, pontoonLayout, pontoonRadius, type FoamMaterialMode, type PontoonCount } from '../src/identity';

const splinePoint=(inputKey:number,x:number,z:number,y=0,widthM=12)=>({inputKey,interpolationMode:'linear' as const,positionM:[x,y,z] as const,
  arriveTangentM:[0,0,0] as const,leaveTangentM:[0,0,0] as const,rotationQuat:[0,0,0,1] as const,up:[0,1,0] as const,rollAngle:0,angleUnit:'degrees' as const,widthM,depthM:4,velocityMPerSec:1.4,audioIntensity:1});
function material(color:readonly [number,number,number,number],roughness=.55,metallic=0):MaterialRootAsset {
  return {kind:'material',colorSpace:'linear',parameters:standardSurfaceParameters([]),values:{baseColor:color,roughness,metallic},
    passes:[{name:'forward',program:{module:'forgeax_material::standard'},renderState:{tags:{LightMode:'Forward'},queue:2000}}]};
}
function hull(offsetX=0,offsetZ=0) {
  const outline=[[-1.8,-.82],[1.2,-.82],[2.05,-.38],[2.2,0],[2.05,.38],[1.2,.82],[-1.8,.82]];
  const positions:number[]=[],indices:number[]=[];
  for(const y of [-.32,.26]) for(const [x,z] of outline) positions.push(x!+offsetX,y,z!+offsetZ);
  const n=outline.length;
  for(let i=1;i<n-1;i++){indices.push(0,i+1,i,n,n+i,n+i+1);}
  for(let i=0;i<n;i++){const next=(i+1)%n;indices.push(i,next,n+next,i,n+next,n+i);}
  return createMeshBuilder({attributes:{position:new Float32Array(positions)},indices}).build().unwrap();
}
function collider(offsetX=0,offsetZ=0) {
  const box=createBoxGeometry(3.6,.58,1.5).unwrap();
  const sourcePositions=box.attributes.position;
  if(!(sourcePositions instanceof Float32Array)||box.indices===undefined) throw new Error('Box collider geometry requires positions and indices');
  const positions=sourcePositions.slice();
  for(let i=0;i<positions.length;i+=3){positions[i]=positions[i]!+offsetX;positions[i+2]=positions[i+2]!+offsetZ;}
  return createMeshBuilder({attributes:{position:positions},indices:box.indices}).build().unwrap();
}

export default definePack({schemaVersion:'2.0.0',packageId:WATER_R4_PACKAGE,name:'Water R4 Buoyancy Harbor',
sceneComponents:[Name,Transform,ChildOf,MeshFilter,MeshRenderer,Visibility,RigidBody,Collider,WaterPontoonSet,WaterBodyInstance,WaterZoneInstance,Terrain,WaterTerrainProvider],build:async({packageId,readByGuid})=>{
  const guid=(key:string)=>AssetGuid.format(AssetGuid.derive(packageId,key));
  const waveSet=cookWaterAsset({kind:'water-wave-set',waveSource:{kind:'predefined',waves:[
    {directionXZ:[.8,.6],wavelengthM:8,amplitudeM:.16,steepness:.1},
    {directionXZ:[-.3,.953939],wavelengthM:3.5,amplitudeM:.055,steepness:.07}]},depthMaskM:2,maxWaveHeightM:.24,timeSource:'scene-clock'}).unwrap();
  const noWaves=cookWaterAsset({kind:'water-wave-set',waveSource:{kind:'predefined',waves:[{directionXZ:[1,0],wavelengthM:8,amplitudeM:0,steepness:0}]},depthMaskM:2,maxWaveHeightM:0,timeSource:'scene-clock'}).unwrap();
  const family={guids:EngineContent.water.materials},zoneGuid=guid('zone/harbor');
  const common={kind:'water-body' as const,zoneGuid,baseHeightM:0,overlapPriority:1,maxWaveHeightM:.24,waveSetGuid:guid('waves/harbor'),shapeDilationM:1,
    flags:{affectsWaterInfo:true,affectsWaterMesh:true,affectsLandscape:false},queryFootprint:[[-110,-110],[110,-110],[110,110],[-110,110]] as const,
    underwaterSettings:{enabled:true,priority:0,blendRadiusM:1,blendWeight:1,maxDepthM:10}};
  const river:WaterBodySource={...common,type:'river',overlapPriority:3,...waterMaterialFamilySlots(family,'river'),
    spline:{closed:false,interpolationVersion:'ue-water-spline/1',points:[splinePoint(0,-42,-1,.09,10),splinePoint(1,-27,-1,.07,11),splinePoint(2,-10,0,.05,14),splinePoint(3,0,0,.04,18)].map((point,index)=>({...point,depthM:2+index*2}))},
    collision:{type:'river-prism',enabled:true,collisionGroups:0x0002ffff}};
  const lake:WaterBodySource={...common,type:'lake',baseHeightM:.04,overlapPriority:2,...waterMaterialFamilySlots(family,'lake'),
    spline:{closed:true,interpolationVersion:'ue-water-spline/1',points:[splinePoint(0,-11,-11),splinePoint(1,15,-13),splinePoint(2,20,-5),splinePoint(3,17,11),splinePoint(4,-8,12)]},
    collision:{type:'polygon',enabled:true,channelDepthM:8,collisionHeightOffsetM:2,collisionGroups:0x0002ffff}};
  const ocean:WaterBodySource={...common,type:'ocean',overlapPriority:0,...waterMaterialFamilySlots(family,'ocean'),
    surfaceMaterialGuid:guid('material/ocean-foam'),lodMaterialGuid:guid('material/ocean-foam-lod'),
    oceanExtentM:[220,220],centerOnWaterZone:false,
    spline:{closed:true,interpolationVersion:'ue-water-spline/1',points:[splinePoint(0,-90,-90),splinePoint(1,18,-90),splinePoint(2,18,-17),splinePoint(3,13,-12),splinePoint(4,14,12),splinePoint(5,20,19),splinePoint(6,20,90),splinePoint(7,-90,90)]},
    collision:{type:'polygon',enabled:true,collisionHalfHeightM:10,collisionHeightOffsetM:2,collisionHalfExtentsM:[110,110],collisionGroups:0x0002ffff}};
  const water=await buildWaterPackOutputs({'zone/harbor':{kind:'water-zone',extentM:{spanXM:104,spanZM:80},tileSizeM:4,tessellationFactor:7,lodScale:1.8,
    farExtentM:{spanXM:220,spanZM:220},farMaterialGuid:family.guids.far,
    waterInfo:{resolution:{widthPx:256,heightPx:256},format:'rgba16f',blurRadius:1,localTessellation:false}},'body/river':river,'body/lake':lake,'body/ocean':ocean},
  {packageId,readByGuid:async requested=>AssetGuid.format(requested).toLowerCase()===guid('waves/harbor').toLowerCase()?ok(waveSet):readByGuid(requested)});
  if(!water.ok) return water;
  const terrainMaterials={'material/shore':material([.38,.46,.39,1],.96),'material/grass':material([.12,.25,.09,1],.96)};
  const columns=76,rows=61,spacing=100/75,heights=new Float32Array(columns*rows),weights=new Float32Array(columns*rows*2);
  for(let z=0;z<rows;z++) for(let x=0;x<columns;x++) {
    const wx=-50+x*spacing,wz=-40+z*spacing;
    const riverDistance=Math.abs(wz+Math.max(0,Math.min(1,(-wx-10)/32))),riverBank=(riverDistance-5.2)/3;
    const lakeDistance=Math.sqrt(((wx-3)/18)**2+(wz/14)**2),lakeBank=(lakeDistance-1)*5;
    const coast=(18+1.7*Math.sin(wz*.13)-wx)/6;
    const edge=Math.max(0,Math.min(1,Math.min(wx<0?riverBank:10,lakeBank,coast)));
    const blend=edge*edge*(3-2*edge),height=-3.6+blend*(5.4+.25*Math.sin(wx*.25)*Math.cos(wz*.2));
    const i=z*columns+x;heights[i]=height;const grass=Math.max(0,Math.min(1,(height-.1)/1.5));weights[i*2]=1-grass;weights[i*2+1]=grass;
  }
  const terrain=buildTerrainAssets({columns,rows,spacing,subsectionVertices:16,heights,weights,layers:Object.keys(terrainMaterials).map(key=>({material:guid(key),blend:'weight' as const}))},
    key=>guid(`terrain/harbor/${key}`),Object.fromEntries(Object.entries(terrainMaterials).map(([key,value])=>[guid(key),value])));
  if(!terrain.ok) return terrain;
  const entities:Record<string,SceneEntity>={};
  const mesh=(key:string,shape:string,color:string,pos:readonly number[],scale:readonly number[],parent?:string,visible=true)=>{entities[key]={components:{Transform:{pos,scale},MeshFilter:{assetHandle:guid(`mesh/${shape}`)},MeshRenderer:{materials:[guid(`material/${color}`)]},...(parent?{ChildOf:{parent}}:{}),...(visible?{}:{Visibility:{state:VisibilityStateValue.hidden}})}};};
  const craft=(key:string,color:string,pos:readonly number[],count:PontoonCount,socket=false)=>{
    const anchors=pontoonLayout(count),radius=pontoonRadius(count);
    entities[key]={components:{Name:{value:key},Transform:{pos},RigidBody:{type:1,mass:125,linearDamping:.02,angularDamping:.02,ccdEnabled:true},Collider:{shape:5,mesh:guid('mesh/collider-centered'),density:1,collisionGroups:0x0001ffff},
      WaterPontoonSet:{configurationVersion:1,anchorMode:socket?1:0,anchorsM:socket?anchors.flatMap(()=>[0,0,0]):anchors.flatMap(p=>[...p]),radiiM:anchors.map(()=>radius),socketEntities:socket?anchors.map((_,i)=>`${key}-socket-${i}`):[],buoyancyCoefficientNPerM3:1200,applyDrag:true,overlapFilterMask:0xffff0002}}};
    mesh(`${key}-hull`,'hull',color,[0,.25,0],[1,1,1],key);
    mesh(`${key}-deck`,'box','white',[-.3,.65,0],[2.8,.16,1.38],key);
    mesh(`${key}-cabin`,'box',color,[-.55,1.04,0],[1.05,.65,.92],key);
    mesh(`${key}-window`,'box','glass',[-.55,1.12,-.48],[.72,.3,.025],key);
    mesh(`${key}-roof`,'box','white',[-.55,1.4,0],[1.22,.1,1.05],key);
    mesh(`${key}-mast`,'box','metal',[-1.1,1.85,0],[.045,1.15,.045],key);
    mesh(`${key}-flag`,'box',color,[-.86,2.28,0],[.5,.28,.035],key);
    anchors.forEach((p,i)=>{
      if(socket) entities[`${key}-socket-${i}`]={components:{Transform:{pos:p},ChildOf:{parent:key}}};
      mesh(`${key}-pontoon-${i}`,'sphere',color,p,[radius,radius,radius],key,false);
    });
  };
  craft('river-craft','red',[-24,.8,-1],4);
  craft('lake-craft','yellow',[4,.8,1],1);
  craft('ocean-craft','teal',[27,.8,-2],16,true);
  entities.zone={components:{Transform:{},WaterZoneInstance:{zone:zoneGuid}}};
  for(const type of ['river','lake','ocean']) entities[type]={components:{Name:{value:type},Transform:{},WaterBodyInstance:{body:guid(`body/${type}`)}}};
  entities.terrain={components:{Transform:{pos:[-50,0,-40]},Terrain:{asset:guid('terrain/harbor/terrain')},RigidBody:{type:0},WaterTerrainProvider:{terrain:guid('terrain/harbor/terrain')}}};
  mesh('dock','box','dock',[-.3,.55,11],[32,.35,2]);
  for(let i=0;i<15;i++) mesh(`dock-plank-${i}`,'box','white',[-14.2+i*2,.74,11],[.035,.015,1.95]);
  for(const x of [-13,-5,4,13]) for(const z of [10.4,11.6]) mesh(`pier-${x}-${z}`,'box','metal',[x,-1,z],[.2,3,.2]);
  for(const [i,x,z] of [[0,-28,9],[1,10,-16],[2,20,18]] as const){mesh(`beacon-${i}`,'box','white',[x,2.4,z],[1.2,3.5,1.2]);mesh(`beacon-top-${i}`,'sphere','red',[x,4.5,z],[.7,.7,.7]);}
  return ok({...water.value,...terrainMaterials,...Object.fromEntries(Object.entries(terrain.value).map(([key,value])=>[`terrain/harbor/${key}`,value])),
    'scene/harbor':{kind:'scene',entities} satisfies SceneAsset,
    'waves/harbor':waveSet,'waves/off':noWaves,
    'mesh/box':createBoxGeometry(1,1,1).unwrap(),'mesh/sphere':createSphereGeometry(1,24,16).unwrap(),'mesh/hull':hull(),
    'mesh/collider-centered':collider(),'mesh/collider-eccentric':collider(.3,.12),
    'material/white':material([.83,.91,.88,1],.35),'material/red':material([.76,.045,.035,1],.3),'material/yellow':material([.95,.66,.04,1],.35),
    'material/teal':material([.02,.42,.4,1],.27),'material/glass':material([.025,.065,.09,1],.1,.6),'material/metal':material([.12,.18,.19,1],.3,.7),'material/dock':material([.22,.28,.27,1],.8),
    ...Object.fromEntries(Object.entries(FOAM_MATERIAL_MODES).flatMap(([mode,values])=>[false,true].flatMap(lod=>[false,true].map(enabled=>[
      foamMaterialKey(mode as FoamMaterialMode,enabled,lod),{kind:'material',parent:family.guids[lod?'ocean-lod':'ocean'],staticSwitches:{waterOceanFoam:enabled},
        values:{absorptionPerM:[.38,.10,.06],scatteringPerM:[.035,.045,.04],...values}} satisfies MaterialAsset]))))});
}});
