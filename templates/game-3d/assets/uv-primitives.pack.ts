import { meshFromInterleaved } from '@forgeax/engine/geometry';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { assetGuid, PACKAGE_IDS } from './shared/asset-refs.ts';

type Point = readonly [number, number, number];
type Uv = readonly [number, number];
interface Island {
  vertices: number[];
  indices: number[];
  width: number;
  height: number;
}

const HEIGHT = 2;
const RADIUS = 1;
const GUTTER = 0.12;

function face(points: readonly Point[], normal: Point, uvs: readonly Uv[], width: number, height: number): Island {
  return {
    vertices: points.flatMap((point, index) => [...point, ...normal, ...uvs[index]!]),
    indices: points.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3],
    width,
    height,
  };
}

const rectangleUvs = (width: number, height: number): Uv[] => [[0, 0], [width, 0], [width, height], [0, height]];

function ramp(): Island[] {
  const a: Point = [-1, 0, -1];
  const b: Point = [1, 0, -1];
  const c: Point = [1, 0, 1];
  const d: Point = [-1, 0, 1];
  const e: Point = [-1, HEIGHT, 1];
  const f: Point = [1, HEIGHT, 1];
  const slope = Math.hypot(2, HEIGHT);
  return [
    face([a, b, c, d], [0, -1, 0], rectangleUvs(2, 2), 2, 2),
    face([a, b, f, e], [0, 2 / slope, -HEIGHT / slope], rectangleUvs(2, slope), 2, slope),
    face([d, c, f, e], [0, 0, 1], rectangleUvs(2, HEIGHT), 2, HEIGHT),
    face([a, d, e], [-1, 0, 0], [[0, 0], [2, 0], [2, HEIGHT]], 2, HEIGHT),
    face([b, c, f], [1, 0, 0], [[0, 0], [2, 0], [2, HEIGHT]], 2, HEIGHT),
  ];
}

function cylinderSector(angle: number, segments: number): Island[] {
  const arcLength = RADIUS * angle;
  const strip: Island = { vertices: [], indices: [], width: arcLength, height: HEIGHT };
  const capWidth = angle === Math.PI ? 2 * RADIUS : RADIUS;
  const caps = [0, HEIGHT].map((y): Island => {
    const normal: Point = [0, y === 0 ? -1 : 1, 0];
    const offsetX = angle === Math.PI ? RADIUS : 0;
    const vertices = [0, y, 0, ...normal, offsetX, 0];
    const indices: number[] = [];
    for (let step = 0; step <= segments; step += 1) {
      const theta = angle * step / segments;
      const x = RADIUS * Math.cos(theta);
      const z = RADIUS * Math.sin(theta);
      vertices.push(x, y, z, ...normal, offsetX + x, z);
      if (step > 0) indices.push(0, step, step + 1);
    }
    return { vertices, indices, width: capWidth, height: RADIUS };
  });

  // Each angular column is shared along the curved surface, including its UV seam endpoints.
  for (let step = 0; step <= segments; step += 1) {
    const theta = angle * step / segments;
    const x = Math.cos(theta);
    const z = Math.sin(theta);
    for (const y of [0, HEIGHT]) {
      strip.vertices.push(RADIUS * x, y, RADIUS * z, x, 0, z, RADIUS * theta, y);
    }
    if (step < segments) {
      const current = step * 2;
      strip.indices.push(current, current + 2, current + 3, current, current + 3, current + 1);
    }
  }

  const diameter: Island = { vertices: [], indices: [0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3], width: 2 * RADIUS, height: HEIGHT };
  for (const x of [RADIUS, 0, -RADIUS]) {
    for (const y of [0, HEIGHT]) diameter.vertices.push(x, y, 0, 0, 0, -1, RADIUS - x, y);
  }
  const cuts = angle === Math.PI
    ? [diameter]
    : [
      face([[0, 0, 0], [RADIUS, 0, 0], [RADIUS, HEIGHT, 0], [0, HEIGHT, 0]], [0, 0, -1], rectangleUvs(RADIUS, HEIGHT), RADIUS, HEIGHT),
      face([[0, 0, 0], [0, 0, RADIUS], [0, HEIGHT, RADIUS], [0, HEIGHT, 0]], [-1, 0, 0], rectangleUvs(RADIUS, HEIGHT), RADIUS, HEIGHT),
    ];
  return [...caps, strip, ...cuts];
}

function buildMesh(islands: readonly Island[], rowWidth: number) {
  const vertices: number[] = [];
  const indices: number[] = [];
  let x = GUTTER;
  let y = GUTTER;
  let rowHeight = 0;
  let atlasWidth = 0;
  for (const island of islands) {
    if (x > GUTTER && x + island.width + GUTTER > rowWidth) {
      x = GUTTER;
      y += rowHeight + GUTTER;
      rowHeight = 0;
    }
    const base = vertices.length / 8;
    for (let offset = 0; offset < island.vertices.length; offset += 8) {
      vertices.push(...island.vertices.slice(offset, offset + 6), island.vertices[offset + 6]! + x, island.vertices[offset + 7]! + y);
    }
    indices.push(...island.indices.map((index) => index + base));
    x += island.width + GUTTER;
    atlasWidth = Math.max(atlasWidth, x);
    rowHeight = Math.max(rowHeight, island.height);
  }

  // One uniform scale preserves texel density and the circular cap shapes across all islands.
  const atlasHeight = y + rowHeight + GUTTER;
  const extent = Math.max(atlasWidth, atlasHeight);
  for (let offset = 0; offset < vertices.length; offset += 8) {
    vertices[offset + 6] = (vertices[offset + 6]! + (extent - atlasWidth) / 2) / extent;
    vertices[offset + 7] = (vertices[offset + 7]! + (extent - atlasHeight) / 2) / extent;
  }
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 8;
    const b = indices[offset + 1]! * 8;
    const c = indices[offset + 2]! * 8;
    const ab = [0, 1, 2].map((axis) => vertices[b + axis]! - vertices[a + axis]!);
    const ac = [0, 1, 2].map((axis) => vertices[c + axis]! - vertices[a + axis]!);
    const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    const alignment = cross.reduce((sum, value, axis) => sum + value * (vertices[a + 3 + axis]! + vertices[b + 3 + axis]! + vertices[c + 3 + axis]!), 0);
    if (alignment < 0) [indices[offset + 1], indices[offset + 2]] = [indices[offset + 2]!, indices[offset + 1]!];
  }
  const result = meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices));
  if (!result.ok) return result;
  return ok({ ...result.value, materialSlots: [{ slotName: 'Surface', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/white') }] });
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01a15d30-7190-7000-8000-000000000000'),
  name: 'Game 3D / UV Primitives',
  build: () => {
    const triangularRamp = buildMesh(ramp(), 6.5);
    if (!triangularRamp.ok) return triangularRamp;
    const halfCylinder = buildMesh(cylinderSector(Math.PI, 32), 4.5);
    if (!halfCylinder.ok) return halfCylinder;
    const quarterCylinder = buildMesh(cylinderSector(Math.PI / 2, 16), 3.5);
    if (!quarterCylinder.ok) return quarterCylinder;
    return ok({
      'mesh/triangular-ramp': triangularRamp.value,
      'mesh/half-cylinder': halfCylinder.value,
      'mesh/quarter-cylinder': quarterCylinder.value,
    });
  },
});
