// Two native Tilemap layers display the complete terrain/object atlas contents.
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { ChildOf, Transform } from '@forgeax/engine-scene';

import { CAMERA_PROJECTION_ORTHOGRAPHIC } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { TransparentSort, Tilemap } from '@forgeax/engine-render/authoring';
import { Camera } from '@forgeax/engine-render';

import type {
  TextureAsset,
  TilesetAsset,
  TilesetRegion,
  TilesetTileEntry,
} from '@forgeax/engine-types';

import { fetchPngAsRgba } from './png-loader';
import type { TsjFile } from './types';

const WORLD = '/world';
const STRIP_COLS = 32;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('[tile-strip] missing <canvas id="app">');
const statusEl = document.querySelector<HTMLElement>('#status');

bootstrap(canvas).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[tile-strip]', msg);
  if (statusEl) statusEl.textContent = `error: ${msg}`;
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  setStatus('booting...');

  const appRes = await createApp(target, {}, { shaderManifestUrl: '/shaders/manifest.json' });
  if (!appRes.ok) {
    reportError(appRes.error);
    return;
  }
  const app: App = appRes.value;


  const assets = app.assets;
  if (assets === undefined) {
    setStatus('AssetRegistry null');
    return;
  }

  const world = app.world;
  TransparentSort.configure(world, { mode: TransparentSort.layerY, yzAlpha: 1 });

  setStatus('loading atlases...');
  const [terrainTsj, objectTsj] = await Promise.all([
    fetchJson<TsjFile>(`${WORLD}/terrain_atlas.tsj`),
    fetchJson<TsjFile>(`${WORLD}/object_atlas.tsj`),
  ]);

  const [terrainPng, objectPng] = await Promise.all([
    fetchPngAsRgba(`${WORLD}/terrain_atlas.png`),
    fetchPngAsRgba(`${WORLD}/object_atlas.png`),
  ]);

  const terrainPayload = makeTextureAsset(terrainPng);
  const objectPayload = makeTextureAsset(objectPng);
  const terrainAtlas=assets.create(terrainPayload).unwrap(),objectAtlas=assets.create(objectPayload).unwrap();

  // Combined TilesetAsset — terrain entries first, then object entries.
  // Matches main.ts composeTilesetAsset exactly so we exercise the same
  // registration path.
  const regions: TilesetRegion[] = [];
  const tiles: TilesetTileEntry[] = [];

  for (const t of terrainTsj.tiles) {
    regions.push({ x: t.x, y: t.y, width: t.width, height: t.height });
    tiles.push({ regionIndex: regions.length - 1 });
  }

  const numTerrain = terrainTsj.tiles.length;
  const numObject = objectTsj.tiles.length;

  for (const t of objectTsj.tiles) {
    regions.push({ x: t.x, y: t.y, width: t.width, height: t.height, atlasIndex: 1 });
    // Normalize all object tiles to 1×1 in the debug strip so they sit in a
    // clean grid without overlap (object tiles range up to 17×15 cells at true
    // scale; that would shatter the layout). UV slicing via the region is still
    // exercised faithfully.
    tiles.push({ regionIndex: regions.length - 1, widthCells: 1, heightCells: 1 });
  }

  const tileset: TilesetAsset = {
    kind: 'tileset',
    atlases: [terrainAtlas, objectAtlas],
    tileWidth: 16,
    tileHeight: 16,
    columns: Math.ceil(Math.max(terrainTsj.imagewidth, objectTsj.imagewidth) / 16),
    rows: Math.ceil(Math.max(terrainTsj.imageheight, objectTsj.imageheight) / 16),
    atlasSizes: [
      { pixelWidth: terrainTsj.imagewidth, pixelHeight: terrainTsj.imageheight },
      { pixelWidth: objectTsj.imagewidth,  pixelHeight: objectTsj.imageheight  },
    ],
    regions,
    tiles,
  };
  const handle=assets.create(tileset).unwrap();

  // Grid layout (y-up coordinates):
  //   high y  → terrain band (terrainRows rows)
  //   gap row
  //   low y   → object band  (objectRows  rows)
  const terrainRows = Math.ceil(numTerrain / STRIP_COLS);
  const objectRows = Math.ceil(numObject / STRIP_COLS);
  const totalRows = objectRows + 1 + terrainRows; // bottom=objects, mid=gap, top=terrain
  const totalCols = STRIP_COLS;

  const tilemapEntity=world.spawn({component:Transform,data:{}}).unwrap();
  const grid={cols:totalCols,rows:totalRows,tileSize:[1,1],tileset:handle};

  // Terrain Tilemap — cells in the top band (high y).
  // tile value i+1 → tiles[i] (terrain section of the combined tiles[])
  const terrainCells = new Uint32Array(totalCols * totalRows);
  for (let i = 0; i < numTerrain; i++) {
    const col = i % STRIP_COLS;
    const bandRow = Math.floor(i / STRIP_COLS); // 0 = first terrain strip row
    // terrain band occupies y = (objectRows+1) .. (totalRows-1); bandRow 0 → lowest terrain row
    const y = objectRows + 1 + bandRow;
    terrainCells[y * totalCols + col] = encodeTileBits(i + 1, false, false, false, false);
  }

  const terrainLayerRes = world.spawn(
    { component: Tilemap, data: { ...grid, tiles: terrainCells, layerOrder: 0 } },
    { component: ChildOf, data: { parent: tilemapEntity } },
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
  );
  if (!terrainLayerRes.ok) {
    setStatus(`terrain layer: ${terrainLayerRes.error.code}`);
    return;
  }

  // Object Tilemap — cells in the bottom band (low y).
  // tile value numTerrain+i+1 → tiles[numTerrain+i] (object section)
  const objectCells = new Uint32Array(totalCols * totalRows);
  for (let i = 0; i < numObject; i++) {
    const col = i % STRIP_COLS;
    const bandRow = Math.floor(i / STRIP_COLS);
    const y = bandRow; // object band: y=0 upward
    objectCells[y * totalCols + col] = encodeTileBits(numTerrain + i + 1, false, false, false, false);
  }

  const objectLayerRes = world.spawn(
    { component: Tilemap, data: { ...grid, tiles: objectCells, layerOrder: 1000 } },
    { component: ChildOf, data: { parent: tilemapEntity } },
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
  );
  if (!objectLayerRes.ok) {
    setStatus(`object layer: ${objectLayerRes.error.code}`);
    return;
  }

  // Camera centred on the full grid, wide enough to see all STRIP_COLS columns.
  const aspect = target.width / Math.max(target.height, 1);
  const camHalfW = totalCols / 2 + 1;
  const camHalfH = camHalfW / aspect;
  const camX = totalCols / 2;
  const camY = totalRows / 2;

  const cameraRes = world.spawn(
    {
      component: Transform,
      data: { pos: [camX, camY, 5], scale: [1, 1, 1]},
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect,
        near: 0.1,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -camHalfW,
        right: camHalfW,
        bottom: -camHalfH,
        top: camHalfH,
        clearColor: [0.05, 0.05, 0.08, 1],
      },
    },
  );
  if (!cameraRes.ok) {
    setStatus(`camera: ${cameraRes.error.code}`);
    return;
  }

  const startRes = app.start();
  if (!startRes.ok) {
    reportError(startRes.error);
    return;
  }

  setStatus(
    `terrain ${numTerrain} tiles | objects ${numObject} tiles` +
      ` | grid ${totalCols}×${totalRows} | backend=${app.renderer.inspect().capabilities.backendKind}`,
  );
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

function makeTextureAsset(
  png: { width: number; height: number; rgba: Uint8Array },
): TextureAsset {
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: png.width, height: png.height },
    },
    format: 'rgba8unorm-srgb',
    data: png.rgba,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}


function reportError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    setStatus(`EngineEnvironmentError (no usable WebGPU backend)`);
  } else {
    setStatus(`${err.code}: ${err.hint}`);
  }
}
