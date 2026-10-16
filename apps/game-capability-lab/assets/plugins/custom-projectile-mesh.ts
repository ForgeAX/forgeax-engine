import { RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Materials } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';

const FLOATS_PER_VERTEX = 12;
const TEXTURE_SIZE = 32;
const SPRITE_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
] as const;

const POSITIONS: readonly (readonly [number, number, number])[] = [
  [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
  [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5],
  [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5],
  [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, -0.5, -0.5],
];
const NORMALS: readonly (readonly [number, number, number])[] = [
  ...Array.from({ length: 4 }, () => [0, 1, 0] as const),
  ...Array.from({ length: 4 }, () => [0, -1, 0] as const),
  ...Array.from({ length: 4 }, () => [1, 0, 0] as const),
  ...Array.from({ length: 4 }, () => [-1, 0, 0] as const),
  ...Array.from({ length: 4 }, () => [0, 0, 1] as const),
  ...Array.from({ length: 4 }, () => [0, 0, -1] as const),
];
const INDICES = new Uint16Array([
  0, 3, 1, 1, 3, 2, 4, 5, 7, 5, 6, 7,
  8, 11, 9, 9, 11, 10, 12, 13, 15, 13, 14, 15,
  16, 19, 17, 17, 19, 18, 20, 21, 23, 21, 22, 23,
]);

export interface CustomProjectileMesh {
  readonly world: World;
  readonly meshContent: EntityHandle;
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
  readonly materialHandle: Handle<'MaterialAsset', 'shared'>;
  readonly spriteMaterialHandle: Handle<'MaterialAsset', 'shared'>;
  readonly spriteLitMaterialHandle: Handle<'MaterialAsset', 'shared'>;
  readonly baseVertices: Float32Array;
  readonly alternateVertices: Float32Array;
  uvMode: 'upper' | 'lower';
  toggles: number;
  readonly textureSource: 'procedural';
  readonly textureFormat: TextureAsset['format'];
}

function publishMesh(
  world: World,
  content: EntityHandle,
  vertices: Float32Array,
  indices: Uint16Array,
): void {
  world.set(content, RuntimeMeshVertices, { vertices, indices: new Uint32Array(indices) }).unwrap();
}

function verticesFor(half: 'upper' | 'lower'): Float32Array {
  const vertices = new Float32Array(POSITIONS.length * FLOATS_PER_VERTEX);
  for (let index = 0; index < POSITIONS.length; index++) {
    const position = POSITIONS[index]!;
    const normal = NORMALS[index]!;
    const offset = index * FLOATS_PER_VERTEX;
    const faceU = index % 4 === 0 || index % 4 === 3 ? 0 : 1;
    const faceV = index % 4 < 2 ? 0 : 0.2;
    vertices[offset] = position[0];
    vertices[offset + 1] = position[1];
    vertices[offset + 2] = position[2];
    vertices[offset + 3] = normal[0];
    vertices[offset + 4] = normal[1];
    vertices[offset + 5] = normal[2];
    vertices[offset + 6] = faceU;
    vertices[offset + 7] = half === 'upper' ? faceV : faceV + 0.5;
    vertices[offset + 8] = 1;
    vertices[offset + 11] = 1;
  }
  return vertices;
}

function meshFrom(vertices: Float32Array): MeshAsset {
  const positions = new Float32Array(POSITIONS.flat());
  const normals = new Float32Array(NORMALS.flat());
  const uv = new Float32Array(POSITIONS.length * 2);
  const tangent = new Float32Array(POSITIONS.length * 4);
  for (let index = 0; index < POSITIONS.length; index++) {
    uv[index * 2] = vertices[index * FLOATS_PER_VERTEX + 6] ?? 0;
    uv[index * 2 + 1] = vertices[index * FLOATS_PER_VERTEX + 7] ?? 0;
    tangent[index * 4] = 1;
    tangent[index * 4 + 3] = 1;
  }
  return {
    kind: 'mesh',
    vertices,
    attributes: { position: positions, normal: normals, uv, tangent },
    indices: INDICES,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: INDICES.length,
        vertexCount: POSITIONS.length,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
    aabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
  };
}

function makeTexture(): TextureAsset {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const lower = y >= TEXTURE_SIZE / 2;
      const tile = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      const offset = (y * TEXTURE_SIZE + x) * 4;
      data[offset] = lower ? (tile ? 245 : 55) : (tile ? 45 : 15);
      data[offset + 1] = lower ? (tile ? 105 : 25) : (tile ? 220 : 80);
      data[offset + 2] = lower ? (tile ? 25 : 155) : (tile ? 95 : 35);
      data[offset + 3] = 255;
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE } },
    format: 'rgba8unorm-srgb',
    data,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

export async function createCustomProjectileMesh(
  world: World,
): Promise<CustomProjectileMesh | undefined> {
  const texture = makeTexture();
  const textureHandle = world.allocSharedRef('TextureAsset', texture);
  const baseVertices = verticesFor('upper');
  const alternateVertices = verticesFor('lower');
  const meshAsset = meshFrom(baseVertices);
  const meshHandle = world.allocSharedRef('MeshAsset', meshAsset);
  const meshContent = world.spawn({ component: RuntimeMeshVertices, data: { asset: meshHandle, vertices: meshAsset.vertices } }).unwrap();
  const material = Materials.standard({
    baseColor: [1, 1, 1, 1],
    baseColorTexture: unwrapHandle(textureHandle),
    roughness: 0.4,
    emissive: [1, 0.7, 0.15],
    emissiveIntensity: 5,
  });
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material);
  const spriteMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite' },
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 },
      },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      colorTint: [1, 0.7, 0.15, 1],
      baseColorTexture: textureHandle,
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  });
  const spriteLitMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::sprite-lit' },
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, tags: { LightMode: 'Forward' }, queue: 3000 },
      },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      colorTint: [1, 0.7, 0.15, 1],
      baseColorTexture: textureHandle,
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  });
  return {
    world,
    meshHandle,
    meshContent,
    materialHandle,
    spriteMaterialHandle: spriteMaterial,
    spriteLitMaterialHandle: spriteLitMaterial,
    baseVertices,
    alternateVertices,
    uvMode: 'upper',
    toggles: 0,
    textureSource: 'procedural',
    textureFormat: texture.format,
  };
}

export function toggleCustomProjectileMesh(mesh: CustomProjectileMesh): void {
  mesh.uvMode = mesh.uvMode === 'upper' ? 'lower' : 'upper';
  mesh.toggles += 1;
  publishMesh(mesh.world, mesh.meshContent, mesh.uvMode === 'upper' ? mesh.baseVertices : mesh.alternateVertices, INDICES);
}

export function resetCustomProjectileMesh(mesh: CustomProjectileMesh): void {
  if (mesh.uvMode === 'upper') return;
  mesh.uvMode = 'upper';
  publishMesh(mesh.world, mesh.meshContent, mesh.baseVertices, INDICES);
}
