import { RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';

const FLOATS_PER_VERTEX = 12;
const CUBE_POSITIONS: readonly (readonly [number, number, number])[] = [
  [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
  [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5],
  [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5],
  [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, -0.5, -0.5],
];
const CUBE_NORMALS: readonly (readonly [number, number, number])[] = [
  ...Array.from({ length: 4 }, () => [0, 1, 0] as const),
  ...Array.from({ length: 4 }, () => [0, -1, 0] as const),
  ...Array.from({ length: 4 }, () => [1, 0, 0] as const),
  ...Array.from({ length: 4 }, () => [-1, 0, 0] as const),
  ...Array.from({ length: 4 }, () => [0, 0, 1] as const),
  ...Array.from({ length: 4 }, () => [0, 0, -1] as const),
];
const CUBE_INDICES = new Uint16Array([
  0, 3, 1, 1, 3, 2, 4, 5, 7, 5, 6, 7,
  8, 11, 9, 9, 11, 10, 12, 13, 15, 13, 14, 15,
  16, 19, 17, 17, 19, 18, 20, 21, 23, 21, 22, 23,
]);

export const CUSTOM_TEXTURE_SIZE = 64;

export interface CustomMeshState {
  readonly meshContent: EntityHandle;
  readonly meshEntity: EntityHandle;
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
  readonly baseVertices: Float32Array;
  readonly alternateVertices: Float32Array;
  readonly indices: Uint16Array;
  uvMode: 'upper' | 'lower';
  toggles: number;
}

export function makeCustomMeshTexture(): TextureAsset {
  const data = new Uint8Array(CUSTOM_TEXTURE_SIZE * CUSTOM_TEXTURE_SIZE * 4);
  for (let y = 0; y < CUSTOM_TEXTURE_SIZE; y++) {
    for (let x = 0; x < CUSTOM_TEXTURE_SIZE; x++) {
      const lower = y >= CUSTOM_TEXTURE_SIZE / 2;
      const tile = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const offset = (y * CUSTOM_TEXTURE_SIZE + x) * 4;
      if (lower) {
        data[offset] = tile ? 245 : 55;
        data[offset + 1] = tile ? 125 : 25;
        data[offset + 2] = tile ? 35 : 155;
      } else {
        data[offset] = tile ? 60 : 20;
        data[offset + 1] = tile ? 210 : 85;
        data[offset + 2] = tile ? 95 : 35;
      }
      data[offset + 3] = 255;
    }
  }
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: CUSTOM_TEXTURE_SIZE, height: CUSTOM_TEXTURE_SIZE },
    },
    format: 'rgba8unorm-srgb',
    data,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

function customCubeVertices(lower: boolean): Float32Array {
  const vertices = new Float32Array(CUBE_POSITIONS.length * FLOATS_PER_VERTEX);
  for (let i = 0; i < CUBE_POSITIONS.length; i++) {
    const position = CUBE_POSITIONS[i]!;
    const normal = CUBE_NORMALS[i]!;
    const faceU = i % 4 === 0 || i % 4 === 3 ? 0 : 1;
    const faceV = i % 4 < 2 ? 0 : 0.2;
    const u = faceU;
    const v = lower ? faceV + 0.5 : faceV;
    const offset = i * FLOATS_PER_VERTEX;
    vertices[offset] = position[0];
    vertices[offset + 1] = position[1];
    vertices[offset + 2] = position[2];
    vertices[offset + 3] = normal[0];
    vertices[offset + 4] = normal[1];
    vertices[offset + 5] = normal[2];
    vertices[offset + 6] = u;
    vertices[offset + 7] = v;
    vertices[offset + 8] = 1;
    vertices[offset + 11] = 1;
  }
  return vertices;
}

function customCubeMesh(vertices: Float32Array): MeshAsset {
  const positions = new Float32Array(CUBE_POSITIONS.flat());
  const normals = new Float32Array(CUBE_NORMALS.flat());
  const uv = new Float32Array(CUBE_POSITIONS.length * 2);
  const tangent = new Float32Array(CUBE_POSITIONS.length * 4);
  for (let i = 0; i < CUBE_POSITIONS.length; i++) {
    uv[i * 2] = vertices[i * FLOATS_PER_VERTEX + 6] ?? 0;
    uv[i * 2 + 1] = vertices[i * FLOATS_PER_VERTEX + 7] ?? 0;
    tangent[i * 4] = 1;
    tangent[i * 4 + 3] = 1;
  }
  return {
    kind: 'mesh',
    vertices,
    attributes: { position: positions, normal: normals, uv, tangent },
    indices: CUBE_INDICES,
    submeshes: [{ indexOffset: 0, indexCount: CUBE_INDICES.length, vertexCount: CUBE_POSITIONS.length, topology: 'triangle-list', materialSlot: 0 }],
    aabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    materialSlots: [{ slotName: 'Default' }],
  };
}

export function buildCustomMeshWorld(world: World, textureHandle?: number): CustomMeshState {
  const baseVertices = customCubeVertices(false);
  const alternateVertices = customCubeVertices(true);
  const mesh = customCubeMesh(baseVertices);
  const material = Materials.unlit([1, 1, 1, 1], {
    ...(textureHandle === undefined ? {} : { baseColorTexture: textureHandle }),
  });
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material);
  const meshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
  const meshContent = world.spawn({ component: RuntimeMeshVertices, data: { asset: meshHandle, vertices: baseVertices } }).unwrap();
  const meshEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1.6, 1.6, 1.6] } },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
  const eye: [number, number, number] = [1.8, 1.8, 1.8];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }) },
  );
  return { meshEntity, meshContent, meshHandle, baseVertices, alternateVertices, indices: CUBE_INDICES, uvMode: 'upper', toggles: 0 };
}

export function toggleCustomMesh(world: World, state: CustomMeshState): void {
  state.uvMode = state.uvMode === 'upper' ? 'lower' : 'upper';
  state.toggles += 1;
  world.set(state.meshContent, RuntimeMeshVertices, { vertices: state.uvMode === 'upper' ? state.baseVertices : state.alternateVertices }).unwrap();
}

export function stepCustomMesh(world: World, state: CustomMeshState, input: InputSnapshot): void {
  if (input.keyboard.justPressedCode('Space')) toggleCustomMesh(world, state);
  const current = world.get(state.meshEntity, Transform);
  if (!current.ok) return;
  let rotation = current.value.quat;
  if (input.keyboard.downCode('KeyX')) rotation = quat.rotateAxis(quat.create(), rotation, [1, 0, 0], 0.02);
  if (input.keyboard.downCode('KeyY')) rotation = quat.rotateAxis(quat.create(), rotation, [0, 1, 0], 0.02);
  if (input.keyboard.downCode('KeyZ')) rotation = quat.rotateAxis(quat.create(), rotation, [0, 0, 1], 0.02);
  if (input.keyboard.downCode('KeyR')) rotation = quat.create();
  world.set(state.meshEntity, Transform, { quat: rotation });
}
