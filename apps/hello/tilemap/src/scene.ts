import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { Camera, CAMERA_PROJECTION_ORTHOGRAPHIC } from '@forgeax/engine-render';
import { Tilemap } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';

/** Browser and Dawn use the same complete native layer. */
export function buildTilemapScene(world: World, assets: AssetRegistry) {
  const data=new Uint8Array(32*32*4);
  const colors=[[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,0,255]];
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)data.set(colors[(y<16?0:2)+(x<16?0:1)]!,4*(y*32+x));
  const atlas=assets.create({kind:'texture',shape:{viewDimension:'2d',extent:{width:32,height:32}},format:'rgba8unorm',colorSpace:'linear',mips:{kind:'none'},data}).unwrap();
  const tileset=assets.create({kind:'tileset',atlases:[atlas],tileWidth:16,tileHeight:16,columns:2,rows:2,
    regions:[{x:0,y:0,width:16,height:16},{x:16,y:0,width:16,height:16},{x:0,y:16,width:16,height:16},{x:16,y:16,width:16,height:16}],
    tiles:[{regionIndex:0},{regionIndex:1},{regionIndex:2},{regionIndex:3}]}).unwrap();
  const tiles=new Uint32Array(64);for(let i=0;i<8;i++)tiles[i*8+i]=(i%4)+1;
  const map=world.spawn({component:Transform,data:{}},{component:Tilemap,data:{cols:8,rows:8,tileSize:[1,1],chunkSize:4,tileset,tiles}}).unwrap();
  world.spawn({component:Transform,data:{pos:[4,4,10]}},{component:Camera,data:{projection:CAMERA_PROJECTION_ORTHOGRAPHIC,
    left:-4,right:4,bottom:-4,top:4,near:0.1,far:100,antialias:0,bloom:0,tonemap:0,clearColor:[0,0,0,1]}}).unwrap();
  return {map,tileset,edit(){const cells=world.get(map,Tilemap).unwrap().tiles;cells[0]=0;cells[63]=1;world.set(map,Tilemap,{tiles:cells}).unwrap();}};
}
