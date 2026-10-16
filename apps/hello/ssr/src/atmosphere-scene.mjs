import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { createConeGeometry } from '@forgeax/engine-geometry';
import { ANTIALIAS_NONE, Atmosphere, Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Skylight, TONEMAP_ACES_FILMIC, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

/** Fixed SI-scale carrier: no Fog, Bloom, auto exposure, or scene-side haze. */
export function spawnAtmosphereScene(world,aspect) {
  const mesh=(geometry,pos,scale,color)=>world.spawn(
    {component:Transform,data:{pos,scale}},
    {component:MeshFilter,data:{assetHandle:geometry}},
    {component:MeshRenderer,data:{materials:[world.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[...color,1],roughness:.85,metallic:0}))]}},
  ).unwrap();
  const distances=[100,1000,5000,20000];
  const colors=[[.7,.08,.05],[.05,.5,.1],[.06,.15,.65],[.5,.5,.5]];
  const mountain=world.allocSharedRef('MeshAsset',createConeGeometry(1,2,7).unwrap());
  /** @type {import("@forgeax/engine-ecs").EntityHandle | undefined} */
  let movingObject;
  distances.forEach((distance,index)=>{
    const center=(-.43+index*.285)*distance;
    for(let tower=0;tower<3;tower++) {
      const height=distance*(.12+tower*.025);
      const entity=mesh(HANDLE_CUBE,[center+(tower-1)*distance*.045,height*.5,-distance],[distance*.034,height,distance*.035],colors[tower]);
      movingObject ??= entity;
    }
    mesh(mountain,[center+distance*.015,distance*.11,-distance*1.13],[distance*.11,distance*.11,distance*.1],colors[3]);
  });
  const receiver=mesh(HANDLE_CUBE,[0,-10,-40000],[200000,20,200000],[.12,.13,.1]);
  const sun=world.spawn({component:DirectionalLight,data:{direction:[0,-Math.sin(Math.PI/3),Math.cos(Math.PI/3)],color:[1,1,1],intensity:100000,castShadow:false}}).unwrap();
  const atmosphere=world.spawn({component:Atmosphere,data:{}}).unwrap();
  const skylight=world.spawn({component:Skylight,data:{color:[1,1,1],intensity:1}}).unwrap();
  const camera=world.spawn({component:Transform,data:{pos:[0,2,0]}},{component:Camera,data:{...perspective({fov:Math.PI/3,aspect,near:.1,far:150000}),antialias:ANTIALIAS_NONE,tonemap:TONEMAP_ACES_FILMIC,exposure:1/5000}}).unwrap();
  return {camera,sun,atmosphere,skylight,receiver,...(movingObject === undefined ? {} : {movingObject})};
}
