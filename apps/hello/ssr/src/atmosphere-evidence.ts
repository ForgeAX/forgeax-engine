import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { ANTIALIAS_NONE, ANTIALIAS_TAA, Atmosphere, Camera, CameraView, DynamicResolution, CloudLayer, DirectionalLight, Fog, Materials, MeshFilter, MeshRenderer, VolumetricFog } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';

export interface AtmosphereEvidenceSettings {
  enabled?: boolean;
  multipleViews?: boolean; dynamicScale?: number; cameraCut?: boolean;
  elevation?: number; azimuth?: number; apScale?: number; altitude?: number;
  cameraX?: number; pitch?: number; far?: number; orthographic?: boolean;
  shadows?: boolean; clouds?: boolean; fog?: boolean; volume?: boolean;
  frames?: number; mie?: number; solarLux?: number; cloudCoverage?: number;
  panel?: 'off' | 'straight' | 'premultiplied' | 'additive' | 'glass';
  alpha?: number; transmission?: number; panelDistance?: number;
}
/** Bounded controls for the physical-scale acceptance fixture. */
export function atmosphereEvidenceControls(world: World, scene: {
  atmosphere?: EntityHandle; sun?: EntityHandle; camera?: EntityHandle;
}) {
  let secondCamera: EntityHandle | undefined;
  let panel: EntityHandle | undefined;
  let volume: EntityHandle | undefined;
  let elevation=60, azimuth=0;
  return (settings: AtmosphereEvidenceSettings) => {
    const {atmosphere, sun, camera}=scene;
    if (atmosphere===undefined || sun===undefined || camera===undefined) throw new Error('Use fixture=atmosphere');
    if (settings.multipleViews !== undefined) {
      if (secondCamera !== undefined) { world.despawn(secondCamera).unwrap(); secondCamera = undefined; }
      if (world.hasComponent(camera, CameraView)) world.removeComponent(camera, CameraView).unwrap();
      if (settings.multipleViews) {
        world.addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1] } }).unwrap();
        secondCamera = world.spawn(
          { component: Transform, data: { pos: [0, 2000, 0] } },
          { component: Camera, data: { ...world.get(camera, Camera).unwrap() } },
          { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
        ).unwrap();
      }
    }
    if (settings.cameraCut) world.set(camera, Camera, { historyVersion: world.get(camera, Camera).unwrap().historyVersion + 1 }).unwrap();
    if (settings.dynamicScale !== undefined) {
      if (world.hasComponent(camera, DynamicResolution)) world.removeComponent(camera, DynamicResolution).unwrap();
      world.set(camera, Camera, { antialias: settings.dynamicScale < 1 ? ANTIALIAS_TAA : ANTIALIAS_NONE }).unwrap();
      if (settings.dynamicScale < 1) world.addComponent(camera, { component: DynamicResolution, data: { minScale: settings.dynamicScale, maxScale: settings.dynamicScale } }).unwrap();
    }
    if (settings.enabled!==undefined) {
      if (settings.enabled && !world.hasComponent(atmosphere,Atmosphere)) world.addComponent(atmosphere,{component:Atmosphere,data:{}}).unwrap();
      else if (!settings.enabled && world.hasComponent(atmosphere,Atmosphere)) world.removeComponent(atmosphere,Atmosphere).unwrap();
    }
    elevation=settings.elevation ?? elevation; azimuth=settings.azimuth ?? azimuth;
    if (settings.elevation!==undefined || settings.azimuth!==undefined) {
      const e=elevation*Math.PI/180,a=azimuth*Math.PI/180;
      world.set(sun,DirectionalLight,{direction:[Math.cos(e)*Math.sin(a),-Math.sin(e),Math.cos(e)*Math.cos(a)]}).unwrap();
    }
    if (settings.solarLux!==undefined) world.set(sun,DirectionalLight,{intensity:settings.solarLux}).unwrap();
    if (settings.apScale!==undefined) world.set(atmosphere,Atmosphere,{aerialPerspectiveDistanceScale:settings.apScale}).unwrap();
    if (settings.altitude!==undefined || settings.cameraX!==undefined) {
      const current=world.get(camera,Transform).unwrap().pos;
      world.set(camera,Transform,{pos:[settings.cameraX ?? current[0] ?? 0,settings.altitude ?? current[1] ?? 2,0]}).unwrap();
    }
    if (settings.pitch!==undefined) {const half=settings.pitch*Math.PI/360;world.set(camera,Transform,{quat:[Math.sin(half),0,0,Math.cos(half)]}).unwrap();}
    if (settings.far!==undefined) world.set(camera,Camera,{far:settings.far}).unwrap();
    if (settings.orthographic!==undefined) world.set(camera,Camera,{projection:settings.orthographic?1:0,left:-500,right:500,bottom:-500,top:500}).unwrap();
    if (settings.shadows!==undefined) world.set(sun,DirectionalLight,{castShadow:settings.shadows,shadowDistance:25000,mapSize:1024}).unwrap();
    if (settings.mie!==undefined) world.set(atmosphere,Atmosphere,{mieScattering:settings.mie}).unwrap();
    if (settings.clouds!==undefined) {
      if (settings.clouds) world.addComponent(atmosphere,{component:CloudLayer,data:{baseHeight:1200,thickness:800,scale:.0004,wind:[0,0,0],coverage:.55,shadowRange:60000,quality:2}}).unwrap();
      else world.removeComponent(atmosphere,CloudLayer).unwrap();
    }
    if (settings.cloudCoverage!==undefined) world.set(atmosphere,CloudLayer,{coverage:settings.cloudCoverage}).unwrap();
    if (settings.fog!==undefined) {
      if (settings.fog) world.addComponent(atmosphere,{component:Fog,data:{color:[0,0,0],density:.00004,heightFalloff:.001,maxOpacity:.9}}).unwrap();
      else world.removeComponent(atmosphere,Fog).unwrap();
    }
    if (settings.panel!==undefined) {
      if (panel!==undefined) {world.despawn(panel).unwrap();panel=undefined;}
      if (settings.panel!=='off') {
        const alpha=settings.alpha ?? .4, distance=settings.panelDistance ?? 50;
        const premultiplied=settings.panel==='premultiplied';
        const additive=settings.panel==='additive';
        const material:MaterialAsset=settings.panel==='glass'
          ? Materials.standard({ baseColor:[1,1,1,1],metallic:0,roughness:0,ior:1,transmission:settings.transmission ?? 1,thickness:0})
          : Materials.unlit([(premultiplied||additive?alpha:1)*1000,0,0,alpha],{renderState:{depthWriteEnabled:false,blend:{color:{srcFactor:premultiplied||additive?'one':'src-alpha',dstFactor:additive?'one':'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}});
        panel=world.spawn({component:Transform,data:{pos:[distance*.15,distance*.12,-distance],scale:[distance*.55,distance*.32,.1]}},{component:MeshFilter,data:{assetHandle:HANDLE_CUBE}},{component:MeshRenderer,data:{materials:[world.allocSharedRef('MaterialAsset',material)]}}).unwrap();
      }
    }
    if (settings.volume!==undefined) {
      if (volume!==undefined) {world.despawn(volume).unwrap();volume=undefined;}
      if (settings.volume) {
        const texture:TextureAsset={kind:'texture',shape:{viewDimension:'3d',extent:{width:2,height:2,depth:2}},format:'r8unorm',data:new Uint8Array(8).fill(255),colorSpace:'linear',mips:{kind:'none'}};
        volume=world.spawn({component:VolumetricFog,data:{light:sun,density:world.allocSharedRef('TextureAsset',texture),boundsMin:[-25,0,-100],boundsMax:[25,30,-40],extinction:[.02,.02,.02],albedo:[1,1,1],emission:[0,0,0],anisotropy:.2,maxDistance:150,sampling:1}}).unwrap();
      }
    }
  };
}
