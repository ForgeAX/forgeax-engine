import type { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import type { MeshAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';

type Vertex = readonly [number, number, number];

function planeMesh(vertices: readonly Vertex[], indices: readonly number[]): MeshAsset {
  const position = new Float32Array(vertices.flat());
  const normal = new Float32Array(vertices.length * 3);
  const uv = new Float32Array(vertices.length * 2);
  const tangent = new Float32Array(vertices.length * 4);
  const interleaved = new Float32Array(vertices.length * 12);
  const aabb = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < vertices.length; i++) {
    const [x, y, z] = vertices[i]!;
    const base = i * 12;
    interleaved[base] = x;
    interleaved[base + 1] = y;
    interleaved[base + 2] = z;
    normal[i * 3 + 2] = 1;
    interleaved[base + 5] = 1;
    uv[i * 2] = x / 300 + 0.5;
    uv[i * 2 + 1] = y / 220 + 0.5;
    interleaved[base + 6] = uv[i * 2]!;
    interleaved[base + 7] = uv[i * 2 + 1]!;
    tangent[i * 4] = 1;
    tangent[i * 4 + 3] = 1;
    interleaved[base + 8] = 1;
    interleaved[base + 11] = 1;
    aabb[0] = Math.min(aabb[0]!, x);
    aabb[1] = Math.min(aabb[1]!, y);
    aabb[2] = Math.min(aabb[2]!, z);
    aabb[3] = Math.max(aabb[3]!, x);
    aabb[4] = Math.max(aabb[4]!, y);
    aabb[5] = Math.max(aabb[5]!, z);
  }
  return {
    kind: 'mesh',
    vertices: interleaved,
    attributes: { position, normal, uv, tangent },
    indices: new Uint32Array(indices),
    submeshes: [{ indexOffset: 0, indexCount: indices.length, vertexCount: vertices.length, topology: 'triangle-list', materialSlot: 0 }],
    aabb,
    materialSlots: [{ slotName: 'Default' }],
  };
}

const TRIANGLE = planeMesh([[0, 180, 0], [-170, -130, 0], [170, -130, 0]], [0, 1, 2]);
const DIAMOND = planeMesh([[0, 180, 0], [160, 0, 0], [0, -180, 0], [-160, 0, 0]], [0, 2, 1, 0, 3, 2]);
const QUAD = planeMesh([[-150, 120, 0], [150, 120, 0], [150, -120, 0], [-150, -120, 0]], [0, 3, 2, 0, 2, 1]);

function spawnMesh(world: World, mesh: MeshAsset, pos: readonly [number, number, number], color: readonly [number, number, number, number]): void {
  const asset = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: asset } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildMesh2dWorld(world: World): void {
  spawnMesh(world, TRIANGLE, [-270, 0, 1], [0.1, 0.85, 1, 1]);
  spawnMesh(world, DIAMOND, [0, 0, 1], [1, 0.35, 0.15, 1]);
  spawnMesh(world, QUAD, [270, 0, 1], [0.65, 0.25, 1, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 999.9], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -600, right: 600, bottom: -320, top: 320, near: 0.1, far: 2000 }) },
  );
}
