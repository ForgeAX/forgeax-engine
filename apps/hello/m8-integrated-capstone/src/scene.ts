import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { AudioListener, AudioSource } from '@forgeax/engine-audio';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Collider, ColliderShapeValue, CollidingEntities, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';

export const CapstoneMarker = defineComponent('M8CapstoneMarker', { value: 'u32' });
export const CapstoneVelocity = defineComponent('M8CapstoneVelocity', { x: 'f32' });
const EMPTY_CLIP = 0 as unknown as Handle<'AudioClipAsset', 'shared'>;

export interface CapstoneScene {
  root: EntityHandle;
  child: EntityHandle;
  camera: EntityHandle;
  actor: EntityHandle;
  cursor: EntityHandle;
  emitter: EntityHandle;
  material: Handle<'MaterialAsset', 'shared'>;
  highlightMaterial: Handle<'MaterialAsset', 'shared'>;
}

export function buildCapstoneScene(world: World): CapstoneScene {
  const box = createBoxGeometry(1, 1, 1);
  if (!box.ok) throw new Error(`m8-capstone: shared cube geometry failed: ${box.error.code}`);
  const cubeMesh = world.allocSharedRef('MeshAsset', box.value);
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit([0.12, 0.62, 0.95, 1]));
  const highlightMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit([0.95, 0.26, 0.12, 1]));
  const root = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: CapstoneMarker, data: { value: 1 } },
    { component: AudioSource, data: { clip: EMPTY_CLIP, playing: false, spatialBlend: 1, bus: 'sfx' } },
  ).unwrap();
  const child = world.spawn({ component: Transform, data: { pos: [0.8, 0, 0] } }, { component: CapstoneMarker, data: { value: 2 } }).unwrap();
  world.addChild(root, child, ChildOf, { parent: root }).unwrap();
  const cursor = world.spawn(
    { component: Transform, data: { pos: [-1.6, 0, 0], scale: [0.35, 0.35, 0.35] } },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [highlightMaterial] } },
    { component: CapstoneVelocity, data: { x: 0.8 } },
  ).unwrap();
  const camera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 7] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
    { component: AudioListener, data: {} },
  ).unwrap();
  world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1.1 } }).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, -1.1, 0], scale: [8, 0.25, 8] } },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5] } },
  ).unwrap();
  const actor = world.spawn(
    { component: Transform, data: { pos: [0, 3, 0], scale: [0.55, 0.55, 0.55] } },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [highlightMaterial] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.01 } },
    { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5, restitution: 0, friction: 0.5 } },
    { component: CollidingEntities, data: { entities: [] } },
  ).unwrap();
  return { root, child, camera, actor, cursor, emitter: root, material, highlightMaterial };
}
