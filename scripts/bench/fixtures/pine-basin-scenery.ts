import { meshFromInterleaved } from '@forgeax/engine/geometry';
import type { MeshAsset } from '@forgeax/engine/types';
import { cellMeters, groundHeight, roadX } from './level-streaming-landscape.mjs';

type Point = [number, number, number];
export type PlaceProp = (
  key: string,
  shape: string,
  x: number,
  y: number,
  z: number,
  scale: Point,
  rotation?: [number, number, number, number],
) => void;

type Cell = { readonly id: number; readonly x: number; readonly z: number };
type Inside = (x: number, z: number, margin?: number) => boolean;

export function creekX(z: number): number {
  return roadX(z) + 103 + 35 * Math.sin(z / 154) + 18 * Math.sin(z / 65);
}

export function creekMesh(cell: Cell): MeshAsset | undefined {
  const rows: number[] = [];
  const indices: number[] = [];
  for (let z = cell.z; z < cell.z + cellMeters; z += 8) {
    if (z < -1030 || z > 1850) continue;
    const center = creekX(z + 4);
    if (center < cell.x || center >= cell.x + cellMeters) continue;
    const index = rows.length / 8;
    for (const end of [z, z + 8]) {
      const x = creekX(end);
      for (const offset of [-9, 9]) {
        const bank = x + offset;
        rows.push(bank, groundHeight(bank, end) + 0.42, end, 0, 1, 0, (offset + 9) / 18, end / 24);
      }
    }
    indices.push(index, index + 2, index + 1, index + 1, index + 2, index + 3);
  }
  return indices.length === 0
    ? undefined
    : meshFromInterleaved(new Float32Array(rows), new Uint16Array(indices)).unwrap();
}

export function grassMesh(): MeshAsset {
  const rows: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.399963;
    const x = Math.cos(a),
      z = Math.sin(a);
    const start = rows.length / 8;
    const height = 0.55 + (i % 3) * 0.16;
    rows.push(
      x * 0.11 - z * 0.1,
      0,
      z * 0.11 + x * 0.1,
      x,
      0,
      z,
      0,
      0,
      x * 0.11 + z * 0.1,
      0,
      z * 0.11 - x * 0.1,
      x,
      0,
      z,
      1,
      0,
      x * 0.4,
      height,
      z * 0.4,
      x,
      0,
      z,
      0.5,
      1,
    );
    indices.push(start, start + 2, start + 1);
  }
  return meshFromInterleaved(new Float32Array(rows), new Uint16Array(indices)).unwrap();
}

/** Align a unit box's local +Z with the span between fixed endpoints. */
function span(
  add: PlaceProp,
  kind: string,
  key: string,
  a: Point,
  b: Point,
  width: number,
  height: number,
) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    dz = b[2] - a[2];
  const horizontal = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz) / 2;
  const pitch = Math.atan2(-dy, horizontal) / 2;
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    u = Math.cos(pitch),
    v = Math.sin(pitch);
  add(
    key,
    kind,
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
    [width, height, Math.hypot(horizontal, dy)],
    [c * v, s * u, -s * v, c * u],
  );
}

const post = (z: number): Point => {
  const x = roadX(z) - 15;
  return [x, groundHeight(x, z), z];
};

function roadsidePoles(cell: Cell, inside: Inside, add: PlaceProp): void {
  for (let z = Math.ceil(cell.z / 42) * 42; z < cell.z + cellMeters; z += 42) {
    const p = post(z);
    if (!inside(p[0], z, 0)) continue;
    const [x, y] = p;
    const key = `pole-${z}`;
    add(`${key}-mast`, 'timber', x, y + 4.65, z, [0.38, 9.3, 0.38]);
    add(`${key}-arm`, 'timber', x, y + 8.6, z, [3.65, 0.22, 0.28]);
    const next = post(z + 42);
    for (const side of [-1, 1]) {
      const ax = x + side * 1.46;
      const bx = next[0] + side * 1.46;
      add(`${key}-cap-${side}`, 'insulator', ax, y + 8.91, z, [0.36, 0.33, 0.36]);
      const middle: Point = [(ax + bx) / 2, (y + next[1]) / 2 + 7.75, z + 21];
      span(add, 'metal-dark', `${key}-cable-${side}-a`, [ax, y + 9, z], middle, 0.043, 0.043);
      span(
        add,
        'metal-dark',
        `${key}-cable-${side}-b`,
        middle,
        [bx, next[1] + 9, z + 42],
        0.043,
        0.043,
      );
    }
  }
}

function roadsideRails(cell: Cell, inside: Inside, add: PlaceProp): void {
  for (let z = Math.ceil(cell.z / 11) * 11; z < cell.z + cellMeters; z += 11) {
    if (Math.cos(z / 151) < -0.15 && Math.abs(z - 1590) > 58) continue;
    const a = roadX(z) + 8.9,
      b = roadX(z + 11) + 8.9;
    if (!inside(a, z, 0)) continue;
    const y = groundHeight(a, z);
    const name = `rail-${z}`;
    span(
      add,
      'galvanized',
      `${name}-beam`,
      [a, y + 1.15, z],
      [b, groundHeight(b, z + 11) + 1.15, z + 11],
      0.25,
      0.38,
    );
    add(`${name}-post`, 'metal-dark', a, y + 0.55, z, [0.17, 1.1, 0.2]);
    if (Math.round(z / 11) % 3 === 0)
      add(`${name}-marker`, 'insulator', a, y + 1.38, z, [0.2, 0.16, 0.19]);
  }
}

function bankAndMeadow(cell: Cell, inside: Inside, add: PlaceProp): void {
  let seed = cell.id + 29041;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let patch = 0; patch < 46; patch++) {
    const originX = cell.x + 15 + random() * (cellMeters - 30);
    const originZ = cell.z + 15 + random() * (cellMeters - 30);
    for (let tuft = 0; tuft < 4; tuft++) {
      const x = originX + (random() - 0.5) * 26;
      const z = originZ + (random() - 0.5) * 26;
      const y = groundHeight(x, z);
      if (!inside(x, z) || y < 5 || Math.abs(x - roadX(z)) < 10) continue;
      const size = 0.8 + random() * 0.9;
      const shrubby = tuft === 0 && patch % 2 === 0;
      add(
        `meadow-${patch}-${tuft}`,
        shrubby ? 'shrub' : patch % 3 === 0 ? 'grass-dry' : 'grass',
        x,
        y + (shrubby ? 0.28 : 0.05),
        z,
        [size * 1.4, size, size * 1.4],
      );
    }
  }
  for (let i = 0; i < 34; i++) {
    const z = cell.z + ((i + 0.5) * cellMeters) / 34;
    if (z < -1030 || z > 1850) continue;
    const x = creekX(z) + (i % 2 === 0 ? -1 : 1) * (11 + random() * 14);
    if (!inside(x, z)) continue;
    const y = groundHeight(x, z);
    add(`bank-rock-${i}`, 'river-rock', x, y + 0.36, z, [1.15, 0.6 + random(), 1.28]);
    if (i % 2 === 0) add(`bank-reeds-${i}`, 'grass-dry', x + 1.7, y + 0.08, z, [1.4, 2.1, 1.4]);
  }
}

function landmarks(inside: Inside, add: PlaceProp): void {
  for (const z of [1631, 391, -550, -1479]) {
    const x = roadX(z) + 52;
    if (!inside(x, z, 8)) continue;
    const y = groundHeight(x, z);
    const key = `landmark-${z}`;
    add(`${key}-plinth`, 'stone', x, y + 0.5, z, [21, 1.1, 15]);
    add(`${key}-hall`, 'stucco', x, y + 4.0, z, [1.4, 1.2, 1.2]);
    add(`${key}-roof`, 'tile-roof', x, y + 9.1, z, [1.38, 1.25, 0.96]);
    add(`${key}-tower`, 'stone', x - 5.4, y + 8.5, z - 3.2, [5.8, 17, 5.7]);
    add(`${key}-spire`, 'spire', x - 5.4, y + 20.25, z - 3.2, [1, 1, 1]);
    add(`${key}-door`, 'timber', x - 9.83, y + 2.25, z, [0.23, 4.5, 2.4]);
    for (const offset of [-3.5, 3.5]) {
      add(
        `${key}-facade-light-${offset}`,
        'glass',
        x - 9.85,
        y + 4.2,
        z + offset,
        [0.18, 3.1, 1.4],
      );
    }
  }
}

export function placePineBasinScenery(cell: Cell, inside: Inside, add: PlaceProp): void {
  bankAndMeadow(cell, inside, add);
  roadsidePoles(cell, inside, add);
  roadsideRails(cell, inside, add);
  landmarks(inside, add);
}

/** All retained parts of an object follow the same far-view selection. */
export function proxyPart(key: string): boolean {
  if (key.startsWith('landmark-')) return !key.includes('facade-light') && !key.endsWith('-door');
  if (key.startsWith('pole-')) return key.endsWith('-mast') || key.endsWith('-arm');
  if (key.startsWith('rail-')) return key.endsWith('-beam') || key.endsWith('-post');
  if (key.startsWith('hamlet-')) return !/-(front|side)-/.test(key) && !key.endsWith('-door');
  if (key.startsWith('tower-')) return true;
  if (key.startsWith('meadow-') || key.startsWith('bank-reeds-')) return false;
  const object = key.replace(/^(trunk|crown|lower)-/, '');
  let hash = 0;
  for (const value of object) hash = (Math.imul(hash, 31) + value.charCodeAt(0)) >>> 0;
  return hash % 4 === 0;
}
