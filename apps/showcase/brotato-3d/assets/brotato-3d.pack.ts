import {
  createBoxGeometry,
  createCapsuleGeometry,
  createConeGeometry,
  createCylinderGeometry,
  meshFromInterleaved,
  createSphereGeometry,
  createTorusGeometry,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Materials,
  PointLight,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Name, Transform } from '@forgeax/engine-scene';
import type {
  AssetGuid as AssetGuidType,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  SceneAsset,
  SceneEntity,
  Submesh,
  TextureAsset,
} from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';

const PACKAGE_NAME = 'Brotato 3D / Neon Harvest' as const;

function parseGuid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const PACKAGE_ID = definePackageId('019fb264-3000-7000-8000-000000000000');

function assetGuid(sourceKey: string): AssetGuidType {
  return AssetGuid.derive(PACKAGE_ID, sourceKey);
}

const IMPACT_VFX_SOURCE_GUID = AssetGuid.derive(
  definePackageId('019fb264-3000-7000-8000-000000000080'),
  'vfx/impact',
);
const SKY_EQUIRECT_SOURCE_GUID = parseGuid('81eec382-392f-5a93-8998-0ecf11ef7990');

function formatGuid(value: AssetGuidType): string {
  return AssetGuid.format(value);
}

function texture(size: number, colors: readonly [number, number, number, number][]): TextureAsset {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = (x + y) % colors.length;
      const color = colors[cell] ?? colors[0] ?? [255, 255, 255, 255];
      const offset = (y * size + x) * 4;
      data[offset] = color[0] ?? 255;
      data[offset + 1] = color[1] ?? 255;
      data[offset + 2] = color[2] ?? 255;
      data[offset + 3] = color[3] ?? 255;
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm-srgb',
    data,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

function bindMaterialSlots(
  mesh: MeshAsset,
  materials: readonly AssetGuidType[],
  sourceKey: string,
): MeshAsset {
  if (materials.length === 0) throw new Error(`Brotato mesh ${sourceKey} needs one material slot`);
  const lastSlot = materials.length - 1;
  return {
    ...mesh,
    submeshes: mesh.submeshes.map((submesh) => ({
      ...submesh,
      materialSlot: Math.max(0, Math.min(lastSlot, submesh.materialSlot)),
    })),
    materialSlots: materials.map((defaultMaterial, index) => ({
      slotName: index === 0 ? 'primary' : `detail-${index}`,
      sourceKey: index === 0 ? sourceKey : `${sourceKey}:detail-${index}`,
      defaultMaterial,
    })),
  };
}

function material(
  baseColor: readonly [number, number, number, number],
  textureGuid: AssetGuidType | undefined,
  options: { readonly metallic: number; readonly roughness: number; readonly emissive?: readonly [number, number, number]; readonly emissiveIntensity?: number },
): MaterialAsset {
  return Materials.standard({
    baseColor,
    ...(textureGuid === undefined ? {} : { baseColorTexture: formatGuid(textureGuid) }),
    metallic: options.metallic,
    roughness: options.roughness,
    ...(options.emissive === undefined ? {} : { emissive: options.emissive }),
    ...(options.emissiveIntensity === undefined ? {} : { emissiveIntensity: options.emissiveIntensity }),
  });
}

interface ModelPart {
  readonly mesh: MeshAsset;
  readonly position: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly materialSlot?: number;
}

function rotateModelVector(
  vector: readonly [number, number, number],
  rotation: readonly [number, number, number],
): readonly [number, number, number] {
  let [x, y, z] = vector;
  const [rotationX, rotationY, rotationZ] = rotation;
  const sinX = Math.sin(rotationX ?? 0);
  const cosX = Math.cos(rotationX ?? 0);
  [y, z] = [y * cosX - z * sinX, y * sinX + z * cosX];
  const sinY = Math.sin(rotationY ?? 0);
  const cosY = Math.cos(rotationY ?? 0);
  [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];
  const sinZ = Math.sin(rotationZ ?? 0);
  const cosZ = Math.cos(rotationZ ?? 0);
  [x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ];
  return [x, y, z];
}

function combineModelParts(parts: readonly ModelPart[]): MeshAsset {
  const groups = new Map<number, { readonly vertices: number[]; readonly indices: number[] }>();
  for (const part of parts) {
    if (part.mesh.vertices.length % 12 !== 0 || part.mesh.indices === undefined) {
      throw new Error('Brotato model parts must be procedural 12-float indexed meshes');
    }
    const materialSlot = Math.max(0, part.materialSlot ?? 0);
    let group = groups.get(materialSlot);
    if (group === undefined) {
      group = { vertices: [], indices: [] };
      groups.set(materialSlot, group);
    }
    const scale = part.scale ?? [1, 1, 1];
    const rotation = part.rotation ?? [0, 0, 0];
    const vertexCount = part.mesh.vertices.length / 12;
    const vertexOffset = group.vertices.length / 8;
    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      const source = vertexIndex * 12;
      const position = rotateModelVector(
        [
          (part.mesh.vertices[source] ?? 0) * (scale[0] ?? 1),
          (part.mesh.vertices[source + 1] ?? 0) * (scale[1] ?? 1),
          (part.mesh.vertices[source + 2] ?? 0) * (scale[2] ?? 1),
        ],
        rotation,
      );
      const normal = rotateModelVector(
        [part.mesh.vertices[source + 3] ?? 0, part.mesh.vertices[source + 4] ?? 1, part.mesh.vertices[source + 5] ?? 0],
        rotation,
      );
      const normalLength = Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 1) || 1;
      group.vertices.push(
        (position[0] ?? 0) + (part.position[0] ?? 0),
        (position[1] ?? 0) + (part.position[1] ?? 0),
        (position[2] ?? 0) + (part.position[2] ?? 0),
        (normal[0] ?? 0) / normalLength,
        (normal[1] ?? 0) / normalLength,
        (normal[2] ?? 0) / normalLength,
        part.mesh.vertices[source + 6] ?? 0,
        part.mesh.vertices[source + 7] ?? 0,
      );
    }
    for (const index of part.mesh.indices) group.indices.push(index + vertexOffset);
  }
  const vertices: number[] = [];
  const indices: number[] = [];
  const submeshes: Submesh[] = [];
  for (const [materialSlot, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    const indexOffset = indices.length;
    const vertexOffset = vertices.length / 8;
    const vertexCount = group.vertices.length / 8;
    vertices.push(...group.vertices);
    for (const index of group.indices) indices.push(index + vertexOffset);
    submeshes.push({
      indexOffset,
      indexCount: group.indices.length,
      vertexCount,
      topology: 'triangle-list',
      materialSlot,
    });
  }
  const merged = meshFromInterleaved(new Float32Array(vertices), new Uint32Array(indices));
  if (!merged.ok) throw merged.error;
  return { ...merged.value, submeshes };
}

function node(
  name: string,
  mesh: AssetGuidType,
  materials: readonly AssetGuidType[],
  pos: readonly [number, number, number],
  scale: readonly [number, number, number],
  quat: readonly [number, number, number, number] = [0, 0, 0, 1],
): SceneEntity {
  return {
    components: {
      Name: { value: name },
      Transform: { pos, scale, quat },
      MeshFilter: { assetHandle: formatGuid(mesh) },
      MeshRenderer: { materials: materials.map((entry) => formatGuid(entry)) },
    },
  };
}

function arenaScene(fieldA: AssetGuidType, fieldB: AssetGuidType): SceneAsset {
  const entities: Record<string, SceneEntity> = {
    'arena-floor': node('Arena Floor', assetGuid('mesh/arena-floor'), [assetGuid('material/arena-floor')], [0, -0.28, 0], [1, 1, 1]),
    'arena-sun': {
      components: {
        Name: { value: 'Arena Sun' },
        Transform: { pos: [0, 8, 0] },
        DirectionalLight: {
          direction: [-0.45, -1, -0.32],
          color: [0.72, 0.88, 1],
          intensity: 3.2,
          castShadow: true,
          cascadeCount: 2,
          mapSize: 1024,
          shadowDistance: 42,
          depthBias: 0.008,
          normalBias: 0.08,
        },
      },
    },
    'arena-ambient': {
      components: {
        Name: { value: 'Arena Ambient' },
        Skylight: {
          equirect: formatGuid(SKY_EQUIRECT_SOURCE_GUID),
          color: [0.7, 0.82, 1],
          intensity: 0.28,
        },
      },
    },
    'arena-rim-light': {
      components: {
        Name: { value: 'Arena Rim Light' },
        Transform: { pos: [7.5, 4.5, 4.5] },
        PointLight: {
          color: [0.08, 0.62, 1],
          intensity: 82,
          range: 14,
        },
      },
    },
    'arena-skybox': {
      components: {
        Name: { value: 'Arena Skybox' },
        SkyboxBackground: {
          equirect: formatGuid(SKY_EQUIRECT_SOURCE_GUID),
          mode: 0,
        },
      },
    },
    'arena-tile-field-a': node('Arena Tile Field A', fieldA, [assetGuid('material/arena-tile-a')], [0, 0, 0], [1, 1, 1]),
    'arena-tile-field-b': node('Arena Tile Field B', fieldB, [assetGuid('material/arena-tile-b')], [0, 0, 0], [1, 1, 1]),
  };
  const walls: readonly [
    string,
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number, number],
  ][] = [
    ['North Wall', [0, 0.34, -15.2], [1, 1, 1], [0, 0, 0, 1]],
    ['South Wall', [0, 0.34, 15.2], [1, 1, 1], [0, 0, 0, 1]],
    ['West Wall', [-15.2, 0.34, 0], [1, 1, 1], [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
    ['East Wall', [15.2, 0.34, 0], [1, 1, 1], [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
  ];
  for (const [index, [name, pos, scale, quat]] of walls.entries()) {
    entities[`arena-wall-${index}`] = node(name, assetGuid('mesh/arena-wall'), [assetGuid('material/arena-wall')], pos, scale, quat);
  }
  for (const [index, [x, z]] of ([[-12.2, -12.2], [12.2, -12.2], [-12.2, 12.2], [12.2, 12.2]] as const).entries()) {
    entities[`arena-marker-${index}`] = node('Arena Marker', assetGuid('mesh/arena-marker'), [assetGuid('material/weapon')], [x, 0.08, z], [1, 1, 1]);
  }
  return { kind: 'scene', entities };
}

function actorScene(
  name: string,
  mesh: AssetGuidType,
  materials: readonly AssetGuidType[],
  scale: readonly [number, number, number],
): SceneAsset {
  return {
    kind: 'scene',
    entities: { actor: node(name, mesh, materials, [0, 0, 0], scale) },
  };
}

const scriptablePack = definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_ID,
  name: PACKAGE_NAME,
  sceneComponents: [
    DirectionalLight,
    MeshFilter,
    MeshRenderer,
    Name,
    PointLight,
    SkyboxBackground,
    Skylight,
    Transform,
  ],
  async build({ readByGuid }) {
    const floor = createBoxGeometry(30, 0.4, 30);
    if (!floor.ok) return floor;
    const tile = createBoxGeometry(1.9, 0.12, 1.9);
    if (!tile.ok) return tile;
    const wall = createBoxGeometry(30, 0.9, 0.36);
    if (!wall.ok) return wall;
    const player = createCapsuleGeometry(0.55, 0.25, 6, 16);
    if (!player.ok) return player;
    const playerHead = createSphereGeometry(0.28, 12, 8);
    if (!playerHead.ok) return playerHead;
    const playerVisor = createBoxGeometry(0.42, 0.12, 0.18);
    if (!playerVisor.ok) return playerVisor;
    const playerArmor = createBoxGeometry(0.64, 0.22, 0.48);
    if (!playerArmor.ok) return playerArmor;
    const playerCore = createSphereGeometry(0.2, 10, 8);
    if (!playerCore.ok) return playerCore;
    const weaponReceiver = createBoxGeometry(0.58, 0.38, 1.08);
    if (!weaponReceiver.ok) return weaponReceiver;
    const weaponStock = createBoxGeometry(0.44, 0.3, 0.68);
    if (!weaponStock.ok) return weaponStock;
    const weaponGrip = createBoxGeometry(0.32, 0.7, 0.42);
    if (!weaponGrip.ok) return weaponGrip;
    const weaponMagazine = createBoxGeometry(0.32, 0.28, 0.48);
    if (!weaponMagazine.ok) return weaponMagazine;
    const weaponBarrel = createCylinderGeometry(0.16, 0.16, 1.25, 12, 1);
    if (!weaponBarrel.ok) return weaponBarrel;
    const weaponMuzzle = createTorusGeometry(0.23, 0.06, 8, 16);
    if (!weaponMuzzle.ok) return weaponMuzzle;
    const weaponRail = createBoxGeometry(0.34, 0.14, 0.92);
    if (!weaponRail.ok) return weaponRail;
    const enemy = createSphereGeometry(0.62, 16, 10);
    if (!enemy.ok) return enemy;
    const enemySpike = createConeGeometry(0.17, 0.46, 8, 1);
    if (!enemySpike.ok) return enemySpike;
    const enemyFin = createBoxGeometry(0.22, 0.18, 0.9);
    if (!enemyFin.ok) return enemyFin;
    const elite = createSphereGeometry(0.86, 20, 12);
    if (!elite.ok) return elite;
    const eliteRing = createTorusGeometry(0.98, 0.09, 8, 20);
    if (!eliteRing.ok) return eliteRing;
    const projectile = createSphereGeometry(0.18, 12, 8);
    if (!projectile.ok) return projectile;
    const projectileTip = createConeGeometry(0.16, 0.5, 8, 1);
    if (!projectileTip.ok) return projectileTip;
    const pickup = createCylinderGeometry(0.26, 0.26, 0.32, 12, 1);
    if (!pickup.ok) return pickup;
    const marker = createTorusGeometry(0.75, 0.08, 10, 24);
    if (!marker.ok) return marker;
    const impactVfx = await readByGuid<ParticleEffectAsset>(IMPACT_VFX_SOURCE_GUID);
    if (!impactVfx.ok) {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: 'the declared Brotato impact particle-effect source asset',
          hint: 'include brotato-impact-vfx.pack.json in the Preview Pack roots',
          detail: { sourcePath: 'brotato-impact-vfx.pack.json' },
        }),
      );
    }
    const glowMask = assetGuid('texture/glow-mask');
    const materialFloor = assetGuid('material/arena-floor');
    const materialTileA = assetGuid('material/arena-tile-a');
    const materialWall = assetGuid('material/arena-wall');
    const materialPlayer = assetGuid('material/player');
    const materialWeapon = assetGuid('material/weapon');
    const materialWeaponAccent = assetGuid('material/weapon-accent');
    const materialEnemy = assetGuid('material/enemy');
    const materialElite = assetGuid('material/elite');
    const materialProjectile = assetGuid('material/projectile');
    const materialPickup = assetGuid('material/pickup');
    const playerModel = combineModelParts([
      { mesh: player.value, position: [0, 0, 0], materialSlot: 0 },
      { mesh: playerHead.value, position: [0, 0.66, 0], scale: [0.9, 0.82, 0.9], materialSlot: 0 },
      { mesh: playerArmor.value, position: [0, 0.16, 0.32], scale: [1, 1, 0.85], materialSlot: 1 },
      { mesh: playerVisor.value, position: [0, 0.48, 0.31], scale: [0.95, 0.9, 0.75], materialSlot: 1 },
      { mesh: playerHead.value, position: [-0.38, 0.14, 0], scale: [0.3, 0.22, 0.34], materialSlot: 1 },
      { mesh: playerHead.value, position: [0.38, 0.14, 0], scale: [0.3, 0.22, 0.34], materialSlot: 1 },
      { mesh: playerCore.value, position: [0, 0.2, 0.48], scale: [0.9, 0.7, 0.45], materialSlot: 1 },
    ]);
    const weaponModel = combineModelParts([
      { mesh: weaponReceiver.value, position: [0, 0, 0], materialSlot: 0 },
      { mesh: weaponStock.value, position: [0, 0, -0.78], materialSlot: 0 },
      { mesh: weaponGrip.value, position: [0, -0.46, -0.12], rotation: [0.08, 0, 0], materialSlot: 0 },
      { mesh: weaponMagazine.value, position: [0, -0.27, 0.16], rotation: [0.08, 0, 0], materialSlot: 0 },
      { mesh: weaponBarrel.value, position: [0, 0.04, 1.08], rotation: [Math.PI / 2, 0, 0], materialSlot: 1 },
      { mesh: weaponMuzzle.value, position: [0, 0.04, 1.72], rotation: [Math.PI / 2, 0, 0], materialSlot: 1 },
      { mesh: weaponRail.value, position: [0, 0.27, 0.18], materialSlot: 1 },
    ]);
    const enemyModel = combineModelParts([
      { mesh: enemy.value, position: [0, 0, 0], materialSlot: 0 },
      { mesh: enemySpike.value, position: [0, 0.57, 0], materialSlot: 1 },
      { mesh: enemyFin.value, position: [0, 0.08, 0.54], materialSlot: 1 },
      { mesh: enemyFin.value, position: [0, 0.08, -0.54], materialSlot: 1 },
      { mesh: enemyFin.value, position: [0.54, 0.08, 0], rotation: [0, Math.PI / 2, 0], materialSlot: 1 },
      { mesh: enemyFin.value, position: [-0.54, 0.08, 0], rotation: [0, Math.PI / 2, 0], materialSlot: 1 },
      { mesh: playerCore.value, position: [0, 0.12, 0.53], scale: [0.55, 0.36, 0.28], materialSlot: 1 },
    ]);
    const eliteModel = combineModelParts([
      { mesh: elite.value, position: [0, 0, 0], materialSlot: 0 },
      { mesh: eliteRing.value, position: [0, 0, 0], materialSlot: 1 },
      { mesh: enemySpike.value, position: [0, 0.92, 0], scale: [1.15, 1.15, 1.15], materialSlot: 1 },
      { mesh: enemySpike.value, position: [0, -0.92, 0], scale: [1.15, 1.15, 1.15], rotation: [Math.PI, 0, 0], materialSlot: 1 },
      { mesh: playerCore.value, position: [0, 0.16, 0.76], scale: [0.75, 0.45, 0.3], materialSlot: 1 },
    ]);
    const projectileModel = combineModelParts([
      { mesh: projectile.value, position: [0, 0, 0], materialSlot: 0 },
      { mesh: projectileTip.value, position: [0, 0, 0.32], rotation: [Math.PI / 2, 0, 0], materialSlot: 1 },
    ]);
    const arenaFieldPartsA: ModelPart[] = [];
    const arenaFieldPartsB: ModelPart[] = [];
    for (let row = -7; row <= 7; row += 1) {
      for (let column = -7; column <= 7; column += 1) {
        const target = (row + column) % 2 === 0 ? arenaFieldPartsA : arenaFieldPartsB;
        target.push({ mesh: tile.value, position: [column * 2, -0.02, row * 2] });
      }
    }
    const arenaFieldA = combineModelParts(arenaFieldPartsA);
    const arenaFieldB = combineModelParts(arenaFieldPartsB);
    return ok({
      'texture/glow-mask': texture(4, [[255, 255, 255, 255], [120, 210, 255, 255]]),
      'material/arena-floor': material([0.09, 0.16, 0.24, 1], undefined, { metallic: 0.08, roughness: 0.9 }),
      'material/arena-tile-a': material([0.14, 0.26, 0.39, 1], undefined, { metallic: 0.05, roughness: 0.8 }),
      'material/arena-tile-b': material([0.16, 0.29, 0.43, 1], undefined, { metallic: 0.08, roughness: 0.74 }),
      'material/arena-wall': material([0.08, 0.2, 0.29, 1], glowMask, { metallic: 0.25, roughness: 0.5, emissive: [0.01, 0.08, 0.12], emissiveIntensity: 0.8 }),
      'material/player': material([0.95, 0.78, 0.22, 1], glowMask, { metallic: 0.12, roughness: 0.34, emissive: [0.26, 0.11, 0.01], emissiveIntensity: 0.55 }),
      'material/player-hit': material([1, 0.12, 0.16, 1], glowMask, { metallic: 0.05, roughness: 0.3, emissive: [0.8, 0.02, 0.01], emissiveIntensity: 1.3 }),
      'material/weapon': material([0.28, 0.52, 0.62, 1], glowMask, { metallic: 0.66, roughness: 0.24, emissive: [0.02, 0.2, 0.3], emissiveIntensity: 1.05 }),
      'material/weapon-accent': material([0.98, 0.48, 0.08, 1], glowMask, { metallic: 0.58, roughness: 0.2, emissive: [0.55, 0.08, 0.01], emissiveIntensity: 1.15 }),
      'material/enemy': material([0.9, 0.16, 0.22, 1], glowMask, { metallic: 0.08, roughness: 0.42, emissive: [0.32, 0.01, 0.02], emissiveIntensity: 0.7 }),
      'material/elite': material([0.75, 0.22, 0.9, 1], glowMask, { metallic: 0.35, roughness: 0.28, emissive: [0.32, 0.02, 0.55], emissiveIntensity: 1.1 }),
      'material/projectile': material([0.18, 0.9, 1, 1], glowMask, { metallic: 0.45, roughness: 0.18, emissive: [0.05, 0.6, 1], emissiveIntensity: 2.8 }),
      'material/pickup': material([0.15, 1, 0.42, 1], glowMask, { metallic: 0.25, roughness: 0.22, emissive: [0.02, 0.8, 0.18], emissiveIntensity: 1.6 }),
      'mesh/arena-floor': bindMaterialSlots(floor.value, [materialFloor], 'arena-floor'),
      'mesh/arena-field-a': bindMaterialSlots(arenaFieldA, [materialTileA], 'arena-field-a'),
      'mesh/arena-field-b': bindMaterialSlots(arenaFieldB, [assetGuid('material/arena-tile-b')], 'arena-field-b'),
      'mesh/arena-wall': bindMaterialSlots(wall.value, [materialWall], 'arena-wall'),
      'mesh/player': bindMaterialSlots(playerModel, [materialPlayer, materialWeapon], 'player'),
      'mesh/weapon': bindMaterialSlots(weaponModel, [materialWeapon, materialWeaponAccent], 'weapon'),
      'mesh/enemy': bindMaterialSlots(enemyModel, [materialEnemy, materialWeapon], 'enemy'),
      'mesh/elite': bindMaterialSlots(eliteModel, [materialElite, materialWeapon], 'elite'),
      'mesh/projectile': bindMaterialSlots(projectileModel, [materialProjectile, materialWeaponAccent], 'projectile'),
      'mesh/pickup': bindMaterialSlots(pickup.value, [materialPickup], 'pickup'),
      'mesh/arena-marker': bindMaterialSlots(marker.value, [materialWeaponAccent], 'arena-marker'),
      'scene/arena': arenaScene(assetGuid('mesh/arena-field-a'), assetGuid('mesh/arena-field-b')),
      'scene/player': actorScene('Brotato Player', assetGuid('mesh/player'), [materialPlayer, materialWeapon], [0.72, 0.72, 0.72]),
      'scene/enemy': actorScene('Brotato Enemy', assetGuid('mesh/enemy'), [materialEnemy, materialWeapon], [0.62, 0.62, 0.62]),
      'scene/boss': actorScene('Brotato Boss', assetGuid('mesh/elite'), [materialElite, materialWeapon], [0.86, 0.86, 0.86]),
      'scene/weapon': actorScene('Brotato Weapon', assetGuid('mesh/weapon'), [materialWeapon, materialWeaponAccent], [0.92, 0.92, 0.92]),
      'scene/projectile': actorScene('Brotato Projectile', assetGuid('mesh/projectile'), [materialProjectile, materialWeaponAccent], [0.42, 0.42, 0.42]),
      'scene/pickup': actorScene('Brotato Pickup', assetGuid('mesh/pickup'), [materialPickup], [0.3, 0.22, 0.3]),
      'vfx/impact': impactVfx.value,
    });
  },
});

export default scriptablePack;
