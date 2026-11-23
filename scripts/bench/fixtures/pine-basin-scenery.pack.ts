import {
  buildMeshCollision,
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createSphereGeometry,
  withVertexColor,
} from '@forgeax/engine/geometry';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ColliderShapeValue } from '@forgeax/engine/physics';
import { Materials } from '@forgeax/engine/render';
import {
  type MeshAsset,
  ok,
  type SceneAsset,
  type SceneEntity,
  type TextureAsset,
} from '@forgeax/engine/types';
import {
  cellMeters,
  cells,
  groundHeight,
  roadX,
  terrainMesh,
} from './level-streaming-landscape.mjs';
import { levelComponents } from './level-streaming-pack.mjs';
import {
  creekMesh,
  grassMesh,
  type PlaceProp,
  placePineBasinScenery,
  proxyPart,
} from './pine-basin-scenery.ts';

const textured = (guid: ReturnType<typeof AssetGuid.derive>) =>
  Materials.standard({
    baseColor: '#e7e8d9',
    roughness: 0.9,
    baseColorTexture: { texture: guid },
  });

function authoredShapes() {
  const tintMesh = (shape: MeshAsset, color: [number, number, number]) => {
    const mesh = withVertexColor(shape, [...color, 1]).unwrap();
    const { attributeStorage, ...packed } = mesh;
    return attributeStorage === undefined ? packed : mesh;
  };
  const tint = (shape: ReturnType<typeof createBoxGeometry>, color: [number, number, number]) =>
    tintMesh(shape.unwrap(), color);
  const landscape: Record<string, MeshAsset> = {
    'mesh/pine': tint(createConeGeometry(4.8, 11.2, 7), [0.14, 0.28, 0.12]),
    'mesh/fir': tint(createConeGeometry(3.8, 12.5, 6), [0.09, 0.22, 0.18]),
    'mesh/aspen': tint(createSphereGeometry(3.5, 8, 5), [0.45, 0.55, 0.18]),
    'mesh/trunk': tint(createCylinderGeometry(0.38, 0.51, 4, 7), [0.29, 0.16, 0.09]),
    'mesh/boulder': tint(createSphereGeometry(2.6, 7, 4), [0.37, 0.38, 0.33]),
    'mesh/shrub': tint(createSphereGeometry(2.2, 7, 4), [0.24, 0.39, 0.11]),
    'mesh/lodge': tint(createBoxGeometry(14, 6, 10), [0.59, 0.38, 0.2]),
    'mesh/stucco': tint(createBoxGeometry(14, 6, 10), [0.73, 0.65, 0.48]),
    'mesh/roof': tint(createConeGeometry(10.9, 3.4, 4), [0.16, 0.27, 0.31]),
    'mesh/tile-roof': tint(createConeGeometry(10.9, 3.4, 4), [0.47, 0.19, 0.12]),
    'mesh/glass': tint(createBoxGeometry(1, 1, 1), [0.13, 0.23, 0.32]),
    'mesh/timber': tint(createBoxGeometry(1, 1, 1), [0.37, 0.25, 0.14]),
    'mesh/stone': tint(createBoxGeometry(1, 1, 1), [0.45, 0.44, 0.4]),
    'mesh/tank': tint(createCylinderGeometry(3.2, 3.2, 3.4, 10), [0.42, 0.49, 0.5]),
    'mesh/river-rock': tint(createSphereGeometry(1.8, 8, 5), [0.42, 0.47, 0.5]),
    'mesh/metal-dark': tint(createBoxGeometry(1, 1, 1), [0.19, 0.24, 0.26]),
    'mesh/galvanized': tint(createBoxGeometry(1, 1, 1), [0.68, 0.74, 0.73]),
    'mesh/insulator': tint(createBoxGeometry(1, 1, 1), [0.83, 0.78, 0.57]),
    'mesh/spire': tint(createConeGeometry(3.9, 6.7, 4), [0.22, 0.32, 0.37]),
    'mesh/grass': tintMesh(grassMesh(), [0.28, 0.43, 0.16]),
    'mesh/grass-dry': tintMesh(grassMesh(), [0.62, 0.55, 0.3]),
  };
  return landscape;
}

function texture(): TextureAsset {
  const width = 32,
    height = 32;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const t = 227 + ((i * 43 + Math.floor(i / width) * 17) % 17);
    data.set([t, t, t, 255], i * 4);
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data,
  };
}

const hamlets = [1660, 1080, 415, -120, -480, -930, -1535];
const roofRotation: [number, number, number, number] = [
  0,
  Math.sin(Math.PI / 8),
  0,
  Math.cos(Math.PI / 8),
];

type Cell = { readonly id: number; readonly x: number; readonly z: number };
type Inside = (x: number, z: number, margin?: number) => boolean;

function placeVegetation(cell: Cell, inside: Inside, add: PlaceProp, pass: number) {
  let seed = cell.id + 13049 + pass * 104729;
  const prefix = pass === 0 ? '' : 'fill-';
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const tree = (key: string, x: number, y: number, z: number, scale: number, species: string) => {
    add(`trunk-${key}`, 'trunk', x, y + 1.9 * scale, z, [scale, scale, scale]);
    if (species === 'aspen') {
      add(`crown-${key}`, species, x, y + 5.9 * scale, z, [scale, scale * 1.3, scale]);
    } else {
      add(`lower-${key}`, species, x, y + 6.8 * scale, z, [scale, scale, scale]);
      if (species === 'pine')
        add(`crown-${key}`, species, x, y + 10.4 * scale, z, [
          scale * 0.7,
          scale * 0.74,
          scale * 0.7,
        ]);
    }
  };
  const inHamlet = (x: number, z: number) =>
    hamlets.some((center) => Math.abs(z - center) < 84 && Math.abs(x - roadX(center)) < 106);
  for (let grove = 0; grove < 10; grove++) {
    const centerX = cell.x + 34 + random() * (cellMeters - 68);
    const centerZ = cell.z + 34 + random() * (cellMeters - 68);
    const highland = groundHeight(centerX, centerZ) > 225;
    const species = grove % 4 === 0 ? 'aspen' : grove % 3 === 0 ? 'fir' : 'pine';
    for (let i = 0; i < 8; i++) {
      const x = centerX + (random() - 0.5) * 62;
      const z = centerZ + (random() - 0.5) * 62;
      const y = groundHeight(x, z);
      const scale = 0.8 + random() * 0.9;
      if (y < 4 || Math.abs(x - roadX(z)) < 18 || inHamlet(x, z)) continue;
      const key = `${prefix}ridge-${grove}-${i}`;
      if (highland || i === 0)
        add(key, 'boulder', x, y + 0.6, z, [scale * 2.2, scale * 1.3, scale * 1.7]);
      else if (i === 1) add(key, 'shrub', x, y + 0.8, z, [scale, scale * 0.7, scale]);
      else tree(key, x, y, z, scale, species);
    }
  }
  for (let grove = 0; grove < 5; grove++) {
    const middle = cell.z + 35 + grove * 96;
    const side = (grove + Math.floor(cell.z / cellMeters)) % 2 === 0 ? 1 : -1;
    for (let i = 0; i < 10; i++) {
      const z = middle + (random() - 0.5) * 56;
      const x = roadX(z) + side * (22 + random() * 94);
      if (!inside(x, z) || inHamlet(x, z)) continue;
      const y = groundHeight(x, z);
      if (y >= 4)
        tree(
          `${prefix}grove-${grove}-${i}`,
          x,
          y,
          z,
          0.68 + random() * 0.7,
          i % 4 === 0 ? 'aspen' : 'pine',
        );
    }
  }
}

function placeHamlets(
  inside: Inside,
  add: PlaceProp,
  colliders: Record<string, SceneEntity>,
): void {
  for (const center of hamlets) {
    for (let i = 0; i < 16; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const back = i >= 10;
      const z = center + (Math.floor((back ? i - 10 : i) / 2) - (back ? 1 : 2)) * (back ? 31 : 28);
      const x = roadX(z) + side * (29 + (i % 3) * 13 + (back ? 43 : 0));
      if (!inside(x, z, 9)) continue;
      const y = groundHeight(x, z);
      const key = `hamlet-${center}-${i}`;
      const stone = i % 3 === 0;
      add(`${key}-base`, 'stone', x, y + 0.25, z, [15, 1.2, 11]);
      add(key, stone ? 'stucco' : 'lodge', x, y + 3.35, z, [1, 1, 1]);
      colliders[key] = {
        components: {
          Transform: { pos: [x, y + 3.35, z] },
          Mobility: { kind: 0 },
          Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [7, 3, 5] },
        },
      };
      add(
        `${key}-roof`,
        stone ? 'tile-roof' : 'roof',
        x,
        y + 7.6,
        z,
        [1.05, 1, 0.78],
        roofRotation,
      );
      for (const offset of [-3.5, 3.5]) {
        add(`${key}-front-${offset}`, 'glass', x - side * 7.05, y + 3.7, z + offset, [0.2, 2, 2.1]);
        add(`${key}-side-${offset}`, 'glass', x + offset, y + 3.7, z + 5.05, [2.1, 2, 0.2]);
      }
      add(`${key}-door`, 'timber', x - side * 7.06, y + 1.9, z, [0.22, 3, 2.4]);
    }
    const z = center - 71;
    const x = roadX(z) - 44;
    if (inside(x, z, 8)) {
      const y = groundHeight(x, z);
      for (const dx of [-2, 2])
        for (const dz of [-2, 2])
          add(`tower-${center}-${dx}-${dz}`, 'timber', x + dx, y + 3.3, z + dz, [0.65, 7, 0.65]);
      add(`tower-${center}`, 'tank', x, y + 8, z, [1, 1, 1]);
    }
  }
}

function cellScenes(
  cell: Cell,
  ref: (key: string) => string,
  includeCreek: boolean,
): Record<string, SceneAsset> {
  const colliders: Record<string, SceneEntity> = {
    ground: {
      components: {
        Transform: { pos: [cell.x, 0, cell.z] },
        Mobility: { kind: 0 },
        Collider: { shape: ColliderShapeValue.trimesh, mesh: ref('mesh/ground') },
      },
    },
  };
  const entities: Record<string, SceneEntity> = {};
  const add: PlaceProp = (key, shape, x, y, z, scale, quat) => {
    const mesh = `mesh/${shape}`;
    entities[key] = {
      components: {
        Transform: { pos: [x, y, z], scale, ...(quat ? { quat } : {}) },
        Mobility: { kind: 0 },
        MeshFilter: { assetHandle: ref(mesh) },
        MeshRenderer: {
          materials: [ref(shape === 'creek' ? 'material/creek' : 'material/detail')],
        },
        ShadowParticipation: { cast: true, receive: true },
      },
    };
  };
  const inside: Inside = (x, z, margin = 5) =>
    x >= cell.x + margin &&
    x <= cell.x + cellMeters - margin &&
    z >= cell.z + margin &&
    z <= cell.z + cellMeters - margin;
  placeVegetation(cell, inside, add, 0);
  placeVegetation(cell, inside, add, 1);
  placePineBasinScenery(cell, inside, add);
  if (includeCreek) add('creek', 'creek', 0, 0, 0, [1, 1, 1]);

  placeHamlets(inside, add, colliders);
  const west: Record<string, SceneEntity> = {};
  const east: Record<string, SceneEntity> = {};
  const proxy: Record<string, SceneEntity> = {};
  for (const [key, entity] of Object.entries(entities)) {
    const pos = entity.components.Transform?.pos;
    const x = Array.isArray(pos) ? Number(pos[0]) : 0;
    const detail = x >= cell.x + cellMeters / 2 ? east : west;
    detail[key] = entity;
    if (key === 'creek' || proxyPart(key)) proxy[key] = entity;
  }
  return {
    collision: { kind: 'scene', entities: colliders },
    proxy: { kind: 'scene', entities: proxy },
    west: { kind: 'scene', entities: west },
    east: { kind: 'scene', entities: east },
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  name: 'Pine Basin scenery Cell',
  packageId: definePackageId('61a842de-0708-4eef-80a2-000000010000'),
  parameters: [{ name: 'cell', type: 'f32', default: 0, minimum: 0, maximum: 63 }],
  sceneComponents: levelComponents,
  build({ packageId, values }) {
    const cell = cells[Math.round(values.cell)];
    if (cell === undefined) throw new Error('Pine Basin Cell is outside the map');
    const guid = (key: string) => AssetGuid.derive(packageId, key);
    const ref = (key: string) => AssetGuid.format(guid(key));
    const ground = terrainMesh(cell.x, cell.z, cellMeters, false);
    const water = creekMesh(cell);
    return ok({
      ...authoredShapes(),
      'mesh/ground': { ...ground, collision: buildMeshCollision(ground).unwrap() },
      'texture/detail': texture(),
      'material/detail': textured(guid('texture/detail')),
      ...(water === undefined
        ? {}
        : {
            'mesh/creek': water,
            'material/creek': Materials.unlit('#3c8095'),
          }),
      ...cellScenes(cell, ref, water !== undefined),
    });
  },
});
