import { type World } from '@forgeax/engine-ecs';
import { buildMeshAttributeMapForUvSets, deriveVertexLayoutProjection, unpackInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';

import type { MeshAsset } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';


const VERTEX_LAYOUT = deriveVertexLayoutProjection(buildMeshAttributeMapForUvSets(1));
const FLOATS_PER_VERTEX = VERTEX_LAYOUT.arrayStride / Float32Array.BYTES_PER_ELEMENT;

function greenLineList(): MeshAsset {
  // Wireframe cube — 12 edges, visible from any angle
  const half = 0.8;
  const c: readonly (readonly [number, number, number])[] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const edges: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const vertexCount = edges.length * 2;
  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  let v = 0;
  for (const [a, b] of edges) {
    for (const ci of [a, b]) {
      const corner = c[ci]!;
      const vi = v * FLOATS_PER_VERTEX;
      vertices[vi] = corner[0];
      vertices[vi + 1] = corner[1];
      vertices[vi + 2] = corner[2];
      v++;
    }
  }
  const attributes = unpackInterleavedVertexAttributes(vertices, VERTEX_LAYOUT);
  if (attributes === undefined) throw new Error('Wireframe vertices must match their layout');
  return {
    kind: 'mesh',
    vertices,
    attributes,
    submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount, topology: 'line-list', materialSlot: 0 }],
    materialSlots: [{ slotName: 'Default' }],
  };
}

function blueLineStrip(): MeshAsset {
  // Another wireframe cube, colored blue
  const half = 0.6;
  const c: readonly (readonly [number, number, number])[] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const edges: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const vertexCount = edges.length * 2;
  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  let v = 0;
  for (const [a, b] of edges) {
    for (const ci of [a, b]) {
      const corner = c[ci]!;
      const vi = v * FLOATS_PER_VERTEX;
      vertices[vi] = corner[0];
      vertices[vi + 1] = corner[1];
      vertices[vi + 2] = corner[2];
      v++;
    }
  }
  const attributes = unpackInterleavedVertexAttributes(vertices, VERTEX_LAYOUT);
  if (attributes === undefined) throw new Error('Wireframe vertices must match their layout');
  return {
    kind: 'mesh',
    vertices,
    attributes,
    submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount, topology: 'line-list', materialSlot: 0 }],
    materialSlots: [{ slotName: 'Default' }],
  };
}

export function buildLinesWorld(world: World): void {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  // Green line-list entity at (-1.5, 0, 0) — scaled up
  const greenMat = sceneAssets.create(Materials.unlit([0, 1, 0, 1])).unwrap();
  const greenMesh = sceneAssets.create(greenLineList()).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [-1.5, 0, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5] } },
    { component: MeshFilter, data: { assetHandle: greenMesh } },
    { component: MeshRenderer, data: { materials: [greenMat] } },
  );

  // Blue line-strip entity at (0.5, 0, 0) — scaled up
  const blueMat = sceneAssets.create(Materials.unlit([0, 0, 1, 1])).unwrap();
  const blueMesh = sceneAssets.create(blueLineStrip()).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0.5, 0, 0], quat: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5] } },
    { component: MeshFilter, data: { assetHandle: blueMesh } },
    { component: MeshRenderer, data: { materials: [blueMat] } },
  );

  // Camera — perspective, matching Bevy: from (-2, 2.5, 5) looking at origin
  const eye: [number, number, number] = [-2, 2.5, 5];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}
