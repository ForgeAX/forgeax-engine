import type { AssetHandle } from '@forgeax/engine-types';
import { type World } from '@forgeax/engine-ecs';
import { buildMeshAttributeMapForUvSets, deriveVertexLayoutProjection, unpackInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';


import type { MeshAsset } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const VERTEX_LAYOUT = deriveVertexLayoutProjection(buildMeshAttributeMapForUvSets(1));
const FLOATS_PER_VERTEX = VERTEX_LAYOUT.arrayStride / Float32Array.BYTES_PER_ELEMENT;

function wireframeCube(half: number): MeshAsset {
  const c: readonly (readonly [number, number, number])[] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const edges: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const vc = edges.length * 2;
  const vertices = new Float32Array(vc * FLOATS_PER_VERTEX);
  let v = 0;
  for (const [a, b] of edges) {
    for (const ci of [a, b]) {
      const cr = c[ci]!;
      vertices[v * FLOATS_PER_VERTEX] = cr[0];
      vertices[v * FLOATS_PER_VERTEX + 1] = cr[1];
      vertices[v * FLOATS_PER_VERTEX + 2] = cr[2];
      v++;
    }
  }
  const attributes = unpackInterleavedVertexAttributes(vertices, VERTEX_LAYOUT);
  if (attributes === undefined) throw new Error('Wireframe vertices must match their layout');
  return {
    kind: 'mesh',
    vertices,
    attributes,
    submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: vc, topology: 'line-list', materialSlot: 0 }],
    materialSlots: [{ slotName: 'Default' }],
  };
}

function randomInCube(half: number): [number, number, number] {
  return [
    (Math.random() * 2 - 1) * half,
    (Math.random() * 2 - 1) * half,
    (Math.random() * 2 - 1) * half,
  ];
}

function randomOnCube(half: number): [number, number, number] {
  const face = Math.floor(Math.random() * 6);
  const u = Math.random() * 2 - 1;
  const v = Math.random() * 2 - 1;
  const h = half;
  switch (face) {
    case 0: return [h, u * h, v * h];
    case 1: return [-h, u * h, v * h];
    case 2: return [u * h, h, v * h];
    case 3: return [u * h, -h, v * h];
    case 4: return [u * h, v * h, h];
    default: return [u * h, v * h, -h];
  }
}

export function buildRandomSamplingWorld(world: World): {
  wireframeHalf: number;
  pointMat: AssetHandle<'material'>;
} {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const half = 1.2;

  // Wireframe cube to show the bounding region
  const wireMat = sceneAssets.create(Materials.unlit([0.5, 0.5, 0.5, 1])).unwrap();
  const wireMesh = sceneAssets.create(wireframeCube(half)).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: wireMesh } },
    { component: MeshRenderer, data: { materials: [wireMat] } },
  );

  // Point light
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // Camera
  const eye: [number, number, number] = [-2, 3, 5];
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

  // Point material (shared, used for all spawned sample points)
  const pointMat = sceneAssets.create(Materials.standard({ baseColor: [1, 0.8, 0.8, 1], metallic: 0.8 })).unwrap();

  return { wireframeHalf: half, pointMat };
}

export function spawnSamplePoint(
  world: World,
  mode: 'interior' | 'boundary',
  half: number,
  pointMat: AssetHandle<'material'>,
) {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  const pos = mode === 'interior' ? randomInCube(half) : randomOnCube(half);
  return world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [0.04, 0.04, 0.04] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [pointMat] } },
  );
}

let wasSDown = false;
let wasDDown = false;
let wasMDown = false;

export function stepRandomSampling(
  snapshot: InputSnapshot | null,
): { spawn: number; toggleMode: boolean } {
  if (!snapshot) return { spawn: 0, toggleMode: false };
  const s = snapshot.keyboard.down('s');
  const d = snapshot.keyboard.down('d');
  const m = snapshot.keyboard.down('m');

  const spawn = (s && !wasSDown) ? 1 : (d && !wasDDown) ? 100 : 0;
  wasSDown = s;
  wasDDown = d;
  const toggleMode = m && !wasMDown;
  wasMDown = m;
  return { spawn, toggleMode };
}
