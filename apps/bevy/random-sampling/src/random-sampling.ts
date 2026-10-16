import { type World } from '@forgeax/engine-ecs';
import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { type MaterialAsset } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';

const FLOATS_PER_VERTEX = 12;

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
  const pos = new Float32Array(vc * 3);
  let v = 0;
  for (const [a, b] of edges) {
    for (const ci of [a, b]) {
      const cr = c[ci]!;
      vertices[v * FLOATS_PER_VERTEX] = cr[0];
      vertices[v * FLOATS_PER_VERTEX + 1] = cr[1];
      vertices[v * FLOATS_PER_VERTEX + 2] = cr[2];
      pos[v * 3] = cr[0];
      pos[v * 3 + 1] = cr[1];
      pos[v * 3 + 2] = cr[2];
      v++;
    }
  }
  return {
    kind: 'mesh',
    vertices,
    attributes: { ...buildMeshAttributeMapForUvSets(1), position: pos },
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
  pointMat: Handle<'MaterialAsset', 'shared'>;
} {
  const half = 1.2;

  // Wireframe cube to show the bounding region
  const wireMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.5, 0.5, 0.5, 1]),
  );
  const wireMesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', wireframeCube(half));
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
  const pointMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 0.8, 0.8, 1], metallic: 0.8 }),
  );

  return { wireframeHalf: half, pointMat };
}

export function spawnSamplePoint(
  world: World,
  mode: 'interior' | 'boundary',
  half: number,
  pointMat: Handle<'MaterialAsset', 'shared'>,
) {
  const pos = mode === 'interior' ? randomInCube(half) : randomOnCube(half);
  return world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [0.04, 0.04, 0.04] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
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
