import { type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { Camera, CAMERA_PROJECTION_ORTHOGRAPHIC, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Tilemap, TilemapSort, TransparentSort } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle, TilesetAsset } from '@forgeax/engine-types';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_QUAD = createPrimitiveMesh('quad').unwrap();

const COLS = 32;
const ROWS = 32;
const CHUNK_SIZE = 16;

const TILE_GRASS = 1; // 1x1, atlasA, sub-scene (d)
const TILE_BIG_TREE = 2; // 3x4, atlasA, sub-scenes (a) + (e)
const TILE_MID_TREE = 3; // 2x3, atlasA, sub-scene (b), pivotY=0.2
const TILE_BUSH = 4; // 1x2, atlasA, sub-scene (c) left
const TILE_STONE = 5; // 2x2, atlasB, sub-scene (c) right

function buildAnchorTiles(): Uint32Array {
  const tiles = new Uint32Array(COLS * ROWS);
  tiles[7 * COLS + 15] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  tiles[7 * COLS + 17] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);

  tiles[12 * COLS + 5] = encodeTileBits(TILE_MID_TREE, false, false, false, false);
  tiles[12 * COLS + 8] = encodeTileBits(TILE_MID_TREE, true, false, false, false);
  tiles[12 * COLS + 11] = encodeTileBits(TILE_MID_TREE, false, true, false, false);
  tiles[12 * COLS + 14] = encodeTileBits(TILE_MID_TREE, true, true, false, false);

  tiles[17 * COLS + 15] = encodeTileBits(TILE_BUSH, false, false, false, false);
  tiles[17 * COLS + 17] = encodeTileBits(TILE_STONE, false, false, false, false);

  for (let cx = 2; cx <= 6; cx++) {
    tiles[22 * COLS + cx] = encodeTileBits(TILE_GRASS, false, false, false, false);
    tiles[23 * COLS + cx] = encodeTileBits(TILE_GRASS, false, false, false, false);
  }

  tiles[31 * COLS + 15] = encodeTileBits(TILE_BIG_TREE, false, false, false, false);
  return tiles;
}

function makeTilesetAsset(
  atlasA: AssetHandle<'texture'>,
  atlasB: AssetHandle<'texture'>,
): TilesetAsset {
  return {
    kind: 'tileset',
    atlases: [atlasA, atlasB],
    tileWidth: 16,
    tileHeight: 16,
    columns: 4,
    rows: 4,
    regions: [
      { x: 0, y: 0, width: 16, height: 16, atlasIndex: 0 },
      { x: 16, y: 0, width: 48, height: 64, atlasIndex: 0 },
      { x: 16, y: 0, width: 32, height: 48, atlasIndex: 0 },
      { x: 0, y: 16, width: 16, height: 32, atlasIndex: 0 },
      { x: 0, y: 0, width: 32, height: 32, atlasIndex: 1 },
    ],
    tiles: [
      { regionIndex: 0 },
      { regionIndex: 1, widthCells: 3, heightCells: 4, pivotX: 0.5, pivotY: 0.2 },
      { regionIndex: 2, widthCells: 2, heightCells: 3, pivotX: 0.5, pivotY: 0.2 },
      { regionIndex: 3, widthCells: 1, heightCells: 2, pivotX: 0.5, pivotY: 0.3 },
      { regionIndex: 4, widthCells: 2, heightCells: 2, pivotX: 0.5, pivotY: 0.5 },
    ],
  };
}


/** Five visual cases: chunk border, flips/pivots, multi-atlas, unit cells and sprite overlap. */
export function buildObjectTilemapScene(world:World,assets:AssetRegistry) {
 const a=new Uint8Array(64*64*4),b=new Uint8Array(64*64*4);
 for(let y=0;y<64;y++)for(let x=0;x<64;x++){
   a.set(x<16?[255,255,0,255]:x<22?[255,255,255,255]:y<24?[255,0,0,255]:[0,0,255,255],4*(y*64+x));
   b.set([0,255,0,255],4*(y*64+x));
 }
 const texture=(data:Uint8Array)=>assets.create({kind:'texture',shape:{viewDimension:'2d',extent:{width:64,height:64}},format:'rgba8unorm',colorSpace:'linear',mips:{kind:'none'},data}).unwrap();
 const tileset=assets.create(makeTilesetAsset(texture(a),texture(b))).unwrap();
 const map=world.spawn({component:Transform,data:{}},{component:Tilemap,data:{cols:COLS,rows:ROWS,chunkSize:CHUNK_SIZE,tileset,tiles:buildAnchorTiles(),sortScope:TilemapSort.perCell}}).unwrap();
 const material=assets.create({kind:'material',passes:[{name:'Forward',program:{module:'forgeax::default-unlit'},renderState:{queue:3000,tags:{LightMode:'Forward'},
   blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}},depthWriteEnabled:false,cullMode:'none'}}],values:{baseColor:[1,0,1,1]}}).unwrap();
 const sprite=world.spawn({component:Transform,data:{pos:[16,31,0],scale:[2,2,1]}},{component:MeshFilter,data:{assetHandle:assets.create(BUILTIN_QUAD).unwrap()}},{component:MeshRenderer,data:{materials:[material]}}).unwrap();
 TransparentSort.configure(world,{mode:TransparentSort.layerY,yzAlpha:1}).unwrap();
 world.spawn({component:Transform,data:{pos:[16,16,10]}},{component:Camera,data:{projection:CAMERA_PROJECTION_ORTHOGRAPHIC,left:-16,right:16,bottom:-16,top:16,near:0.1,far:100,antialias:0,bloom:0,tonemap:0,clearColor:[0,0,0,1]}}).unwrap();
 return {map,sprite};
}
