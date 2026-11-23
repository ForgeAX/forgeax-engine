import type { App } from '@forgeax/engine-app';
import { createMeshBuilder } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/source';
import { createBrowserFileStore, createBrowserRecordStore } from '@forgeax/engine-platform-browser';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { terrainHeight } from '@forgeax/engine-terrain';
import type { TerrainSource } from '@forgeax/engine-types';
import { packageId, terrainGuid } from './identity.ts';

const scope = 'terrain-height-view-v1';
const tileSize = 32;
const tileStride = tileSize - 1;
const tileBytes = tileSize * tileSize * Float32Array.BYTES_PER_ELEMENT;
const files = createBrowserFileStore(PackageId.format(packageId), scope);
const records = createBrowserRecordStore(PackageId.format(packageId), scope);

interface Tile {
  readonly offset: number;
  readonly digest: string;
}

interface HeightIndex {
  readonly sourceRevision: string;
  readonly file: { readonly id: string; readonly byteLength: number };
  readonly tilesAcross: number;
  readonly spacing: number;
  readonly tiles: readonly Tile[];
}

async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

function encodeTile(source: TerrainSource, x: number, z: number, bytes: Uint8Array<ArrayBuffer>) {
  const view = new DataView(bytes.buffer);
  for (let row = 0; row < tileSize; row++)
    for (let column = 0; column < tileSize; column++) {
      const sample = (z * tileStride + row) * source.columns + x * tileStride + column;
      view.setFloat32((row * tileSize + column) * 4, source.heights[sample]!, true);
    }
}

async function publishHeightIndex(
  source: TerrainSource,
  sourceRevision: string,
  signal: AbortSignal,
): Promise<HeightIndex> {
  const tilesAcross = (source.columns - 1) / tileStride;
  const tilesDown = (source.rows - 1) / tileStride;
  if (!Number.isInteger(tilesAcross) || !Number.isInteger(tilesDown))
    throw new Error('The storage example requires whole terrain tiles');
  const writer = (await files.beginWrite(tilesAcross * tilesDown * tileBytes, signal)).unwrap();
  const tiles: Tile[] = [];
  const bytes = new Uint8Array(tileBytes);
  try {
    for (let z = 0; z < tilesDown; z++)
      for (let x = 0; x < tilesAcross; x++) {
        encodeTile(source, x, z, bytes);
        (await writer.append(bytes, signal)).unwrap();
        tiles.push({ offset: tiles.length * tileBytes, digest: await digest(bytes) });
      }
    return { sourceRevision, file: (await writer.commit(signal)).unwrap(), tilesAcross, spacing: source.spacing, tiles };
  } finally {
    await writer.abort();
  }
}

async function readOrPublishHeightIndex(app: App, signal: AbortSignal) {
  const assets = app.assets!;
  return navigator.locks.request(scope, async () => {
    await assets.enumerateCatalog().then((result) => result.unwrap());
    const entry = assets.catalogEntry(AssetGuid.format(terrainGuid));
    if (entry === undefined) throw new Error('Terrain storage requires a published terrain');
    const sourceRevision = entry.publication?.sourceRevision ?? entry.revision?.digest ?? entry.packageUrl;
    const current = (await records.read('height-index', signal)).unwrap();
    const existing = current ? JSON.parse(new TextDecoder().decode(current)) as HeightIndex : undefined;
    if (existing?.sourceRevision === sourceRevision) return { index: existing, warm: true };
    const handle = (await assets.load(terrainGuid, 'terrain')).unwrap();
    try {
      const index = await publishHeightIndex(assets.read(handle).unwrap(), sourceRevision, signal);
      const write = await records.replace('height-index', new TextEncoder().encode(JSON.stringify(index)), signal);
      if (!write.ok && write.error.code !== 'commit-unknown') await files.remove(index.file, signal);
      write.unwrap();
      return { index, warm: false };
    } finally {
      assets.release(handle).unwrap();
    }
  });
}

function decodeTile(bytes: Uint8Array<ArrayBuffer>, spacing: number): TerrainSource {
  const view = new DataView(bytes.buffer);
  const heights = Float32Array.from({ length: tileSize ** 2 }, (_, i) => view.getFloat32(i * 4, true));
  return {
    columns: tileSize,
    rows: tileSize,
    subsectionVertices: tileSize,
    spacing,
    heights,
    weights: new Float32Array(0),
    layers: [],
  };
}

async function readView(index: HeightIndex, column: number, row: number, signal: AbortSignal) {
  const start = performance.now();
  const left = index.tiles[column + row * index.tilesAcross];
  if (left === undefined || column + 1 >= index.tilesAcross) throw new Error('Invalid terrain view');
  const right = index.tiles[column + 1 + row * index.tilesAcross]!;
  const bytes = new Uint8Array(tileBytes);
  const reader = (await files.openRead(index.file, signal)).unwrap();
  let readBytes = 0;
  let decodeMs = 0;
  let readMs = 0;
  const sources: TerrainSource[] = [];
  try {
    for (const tile of [left, right]) {
      const readStart = performance.now();
      const count = (await reader.readAt(tile.offset, bytes, signal)).unwrap();
      readMs += performance.now() - readStart;
      readBytes += count;
      const decodeStart = performance.now();
      if (count !== bytes.byteLength || (await digest(bytes)) !== tile.digest)
        throw new Error('Invalid terrain tile bytes');
      sources.push(decodeTile(bytes, index.spacing));
      decodeMs += performance.now() - decodeStart;
    }
    const [leftSource, rightSource] = sources as [TerrainSource, TerrainSource];
    for (let z = 0; z < tileSize; z++)
      if (leftSource.heights[z * tileSize + tileStride] !== rightSource.heights[z * tileSize])
        throw new Error('The terrain tile edges disagree');
    return {
      sources,
      readBytes,
      ioMs: readMs,
      decodeMs,
      totalReadMs: performance.now() - start,
      rawBufferBytes: bytes.byteLength,
    };
  } finally {
    (await reader.close()).unwrap();
  }
}

function tileMesh(source: TerrainSource) {
  const position = new Float32Array(tileSize ** 2 * 3);
  const indices: number[] = [];
  for (let z = 0; z < tileSize; z++)
    for (let x = 0; x < tileSize; x++) {
      const i = z * tileSize + x;
      position[i * 3] = x * source.spacing;
      position[i * 3 + 1] = source.heights[i]!;
      position[i * 3 + 2] = z * source.spacing;
      if (x < tileStride && z < tileStride)
        indices.push(i, i + tileSize, i + 1, i + 1, i + tileSize, i + tileSize + 1);
    }
  return createMeshBuilder({ attributes: { position }, indices }).build().unwrap();
}

function spawnTile(app: App, source: TerrainSource, x: number, z: number) {
  const assets = app.assets!;
  const mesh = assets.create(tileMesh(source)).unwrap();
  const material = assets.create(Materials.unlit([0.13, 0.4, 0.18, 1])).unwrap();
  const created = app.world.spawn(
    { component: Transform, data: { pos: [x, 0, z], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
  assets.release(mesh).unwrap();
  assets.release(material).unwrap();
  created.unwrap();
}

export async function startTerrainStorageView(app: App) {
  if (!app.assets) throw new Error('Terrain storage requires assets');
  const start = performance.now();
  const signal = new AbortController().signal;
  const { index, warm } = await readOrPublishHeightIndex(app, signal);
  const view = await readView(index, 1, 1, signal);
  const width = tileStride * index.spacing;
  view.sources.forEach((source, i) => spawnTile(app, source, (i + 1) * width, width));
  const eye: [number, number, number] = [2 * width, 50, 3 * width];
  app.world
    .spawn(
      {
        component: Transform,
        data: {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [2 * width, 0, 1.5 * width], [0, 1, 0]),
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 500 }) },
    )
    .unwrap();
  const { sources, ...metrics } = view;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted' || event.receipt.presentation !== 'ready') return;
    void event.receipt.completed.then((completed) => {
      if (!completed.ok || window.__terrainStorage) return;
      window.__terrainStorage = {
        warm,
        ...metrics,
        fileBytes: index.file.byteLength,
        requestedBytes: 2 * tileBytes,
        firstFrameMs: performance.now() - start,
        heights: [terrainHeight(sources[0]!, width, width / 2), terrainHeight(sources[1]!, 0, width / 2)],
      };
      unsubscribe();
    });
  });
  app.start().unwrap();
}

declare global {
  interface Window {
    __terrainStorage?: {
      readonly warm: boolean;
      readonly fileBytes: number;
      readonly requestedBytes: number;
      readonly readBytes: number;
      readonly rawBufferBytes: number;
      readonly ioMs: number;
      readonly decodeMs: number;
      readonly totalReadMs: number;
      readonly firstFrameMs: number;
      readonly heights: readonly (number | undefined)[];
    };
  }
}
