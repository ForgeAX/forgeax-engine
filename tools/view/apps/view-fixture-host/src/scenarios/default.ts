import type { EngineWorkspaceAsset } from '@forgeax/engine/app';

type FixtureAsset = EngineWorkspaceAsset & { sourcePath: string; sourceKey?: string };

export const PROJECT_ROOT = '/fixture/project';
export const PROJECT = Object.freeze({ id: 'fixture-project', root: PROJECT_ROOT, name: 'Game 3D' });
export const EDITOR_TARGET_ID = 'fixture-editor-target';
export const SCENE_ASSET_ID = 'fixture-scene';

function fixtureAsset(source: string, key: string, kind: string, guid = `fixture-${key.replaceAll('/', '-')}`): FixtureAsset {
  return { guid, kind, name: key, sourcePath: `${PROJECT_ROOT}/${source}`, sourceKey: key };
}

function fixturePack(source: string, kind: string, keys: readonly string[]): FixtureAsset[] {
  return keys.map((key) => fixtureAsset(source, key, kind));
}

export const ASSETS = Object.freeze([
  fixtureAsset('assets/environment.pack.ts', 'environment/sky', 'texture'),
  ...fixturePack('assets/fantasy-meshes.pack.ts', 'mesh', ['fantasy/arch', 'fantasy/column', 'fantasy/stairs']),
  fixtureAsset('assets/game.pack.ts', 'game/settings', 'data'),
  ...fixturePack('assets/geometry.pack.ts', 'mesh', [
    'geometry/box', 'geometry/capsule', 'geometry/cone', 'geometry/cylinder',
    'geometry/plane', 'geometry/sphere', 'geometry/torus', 'geometry/vase',
  ]),
  ...fixturePack('assets/materials.pack.ts', 'material', Array.from({ length: 15 }, (_, index) => `materials/surface-${index + 1}`)),
  fixtureAsset('assets/physics.pack.json', 'physics/world', 'data'),
  fixtureAsset('assets/scene.pack.ts', 'scene/showcase', 'scene', SCENE_ASSET_ID),
  fixtureAsset('assets/guide.ui.html', 'guide.ui.html', 'ui'),
  fixtureAsset('assets/camera/camera.pack.ts', 'camera/rig', 'prefab'),
  fixtureAsset('assets/player/player.pack.ts', 'player/controller', 'prefab'),
  fixtureAsset('assets/runtime-vase/vase.pack.ts', 'runtime-vase/vase', 'mesh'),
  fixtureAsset('assets/ui/hud.pack.ts', 'ui/hud', 'ui'),
  fixtureAsset('assets/world/world.pack.ts', 'world/terrain', 'mesh'),
  fixtureAsset('.forgeax/generated/serve-8Y1wRF/builtins.pack.json', 'generated/builtins', 'data'),
] satisfies readonly FixtureAsset[]);

export const SCENE_NODES = Object.freeze([
  { entity: 1, entityId: 'world', parentId: null, name: 'World', componentNames: ['Transform'] },
  { entity: 2, entityId: 'ground', parentId: 'world', name: 'Ground', componentNames: ['Transform', 'MeshFilter', 'MeshRenderer', 'Collider'] },
  { entity: 3, entityId: 'player', parentId: 'world', name: 'Player', componentNames: ['Transform', 'CharacterController', 'CameraFollow', 'MeshFilter', 'MeshRenderer', 'PlayerStatus'] },
  { entity: 4, entityId: 'sun', parentId: 'world', name: 'Sun', componentNames: ['Transform', 'DirectionalLight'] },
]);

const transform = (position: { x: number; y: number; z: number }, rotation: readonly [number, number, number, number] = [0, 0, 0, 1]) => ({
  name: 'Transform',
  fields: { pos: { type: 'array<f32, 3>' }, quat: { type: 'array<f32, 4>' }, scale: { type: 'array<f32, 3>' } },
  values: { pos: [position.x, position.y, position.z], quat: rotation, scale: [1, 1, 1] },
});
const meshComponents = [
  { name: 'MeshFilter', fields: { assetHandle: { type: 'shared<MeshAsset>' } }, values: { assetHandle: 1025 } },
  { name: 'MeshRenderer', fields: { materials: { type: 'array<shared<MaterialAsset>>' }, lightingChannels: { type: 'f64' } }, values: { materials: [], lightingChannels: 4294967295 } },
];

export const INSPECTIONS = Object.freeze({
  world: { entityId: 'world', name: 'World', components: [transform({ x: 0, y: 0, z: 0 })] },
  ground: { entityId: 'ground', name: 'Ground', components: [
    transform({ x: 0, y: -0.5, z: 0 }),
    ...meshComponents,
    { name: 'Collider', fields: { size: { type: 'vec3' } }, values: { size: { x: 20, y: 1, z: 20 } } },
  ] },
  player: { entityId: 'player', name: 'Player', components: [
    transform({ x: -1.2, y: 0, z: 0 }, [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]),
    { name: 'CharacterController', fields: {
      speed: { type: 'number' }, jumpHeight: { type: 'number' }, grounded: { type: 'boolean' },
    }, values: { speed: 6, jumpHeight: 1.4, grounded: false } },
    { name: 'CameraFollow', fields: {
      active: { type: 'boolean', widget: 'switch' },
      camera: { type: 'assetRef' },
      mode: { type: 'enum', enum: ['Third Person', 'First Person', 'Orbit'] },
      offset: { type: 'vec3' },
      damping: { type: 'number' },
    }, values: {
      active: true,
      camera: { guid: 'fixture-camera-rig', name: 'camera/rig', kind: 'prefab' },
      mode: 'Third Person',
      offset: { x: 0, y: 2.1, z: -4.5 },
      damping: 0.25,
    } },
    { name: 'MeshFilter', fields: { assetHandle: { type: 'shared<MeshAsset>' }, mesh: { type: 'assetRef' } }, values: {
      assetHandle: 'fixture-geometry-capsule', mesh: { guid: 'fixture-geometry-capsule', name: 'geometry/capsule', kind: 'mesh' },
    } },
    { name: 'MeshRenderer', fields: {
      materials: { type: 'array<shared<MaterialAsset>>' },
      lightingChannels: { type: 'f64' },
      visible: { type: 'boolean', widget: 'switch' },
      castShadows: { type: 'boolean' },
      material: { type: 'assetRef' },
      overrideMaterial: { type: 'assetRef' },
      missingMaterial: { type: 'assetRef' },
      tint: { type: 'color' },
    }, values: {
      materials: ['fixture-materials-surface-3'],
      lightingChannels: 4294967295,
      visible: true,
      castShadows: true,
      material: { guid: 'fixture-materials-surface-3', name: 'materials/surface-3', kind: 'material' },
      overrideMaterial: '',
      missingMaterial: { guid: 'fixture-missing-material', missing: true },
      tint: '#6AB7A8',
    } },
    { name: 'PlayerStatus', fields: {
      displayName: { type: 'string' },
      health: { type: 'number' },
      orientation: { type: 'quat' },
    }, values: { displayName: 'Explorer', health: 100, orientation: [0, 0, 0, 1] } },
  ] },
  sun: { entityId: 'sun', name: 'Sun', components: [transform({ x: 0, y: 8, z: 0 })] },
});
