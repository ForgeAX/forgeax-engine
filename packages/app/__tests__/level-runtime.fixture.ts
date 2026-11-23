import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineSystem, FixedTime, FixedUpdate, type World } from '@forgeax/engine-ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld, PhysicsWorld2D } from '@forgeax/engine-physics';
import { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import {
  Camera,
  CameraView,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { Level, LevelService } from '@forgeax/engine-app';
import type { LevelRenderSelection } from '../src/levels/candidate-render-source';
import { LEVEL_STREAMING_SOURCE_COMPONENTS } from '../src/levels/source-preflight';
import type { installDerivedStreamingFixture } from './world-streaming-derived.fixture';

export interface LevelFixtureStatus {
  phase?: string;
  current?: boolean;
  memberCount?: number;
  tick: number;
  hit?: number;
  error?: string;
  failure?: string;
  cleanupFailure?: string;
  derived?: ReturnType<ReturnType<typeof installDerivedStreamingFixture>['request']>['derived'];
  renderSelection?: LevelRenderSelection | undefined;
}

function installLiveSkin(world: World, assets: AssetRegistry): void {
  world.components.register(Skin).unwrap();
  const attributes = {
    position: new Float32Array([-0.35, 0, 0, 0.35, 0, 0, 0, 0.8, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const mesh = assets.create({
    kind: 'mesh',
    vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    attributes,
    indices: new Uint16Array([0, 1, 2]),
    aabb: new Float32Array([-0.35, 0, 0, 0.35, 0.8, 0]),
    materialSlots: [{ slotName: 'Default' }],
    submeshes: [{
      indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list',
    }],
  }).unwrap();
  const material = assets.create({
    kind: 'material',
    passes: [{
      name: 'Forward',
      program: { module: 'forgeax::pbr-skin' },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    }],
    values: { baseColor: [0.12, 0.45, 0.8, 1], metallic: 0, roughness: 0.8 },
  }).unwrap();
  const skeleton = assets.create({
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  }).unwrap();
  const joint = world.spawn({ component: Transform, data: { pos: [-1.6, 0.7, 0] } }).unwrap();
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: ShadowParticipation, data: { cast: false, receive: false } },
    { component: Skin, data: { skeleton, joints: [joint] } },
  ).unwrap();
  for (const handle of [mesh, material, skeleton]) assets.release(handle).unwrap();
}

export function levelFixtureError(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  return JSON.stringify(cause, (_key, value) =>
    value instanceof Error
      ? { ...Object.fromEntries(Object.entries(value)), message: value.message, stack: value.stack, cause: value.cause }
      : value,
  );
}

export function installLevelFixture(
  world: World,
  assets: AssetRegistry,
  physics: PhysicsWorld | PhysicsWorld2D | undefined,
  levels: LevelService,
  rootGuid: string,
  firstLevel = false,
  liveSkin = false,
) {
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    if (world.components.resolve(component.name) === undefined)
      world.components.register(component).unwrap();
  if (!(physics instanceof RapierPhysicsWorld3D))
    throw Error('Missing Rapier3D for the static Level fixture');
  if (liveSkin) installLiveSkin(world, assets);
  const raycast = () => physics.raycast(vec3.create(0, 5, 0), vec3.create(0, -1, 0), 10);
  const camera = world.spawn(
    {
      component: Transform,
      data: { pos: [1, 2, 8], quat: [-Math.sin(0.12), 0, 0, Math.cos(0.12)] },
    },
    { component: Camera, data: perspective({ fov: 1, aspect: 1 }) },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: {
      castShadow: !liveSkin,
      intensity: 10000,
      direction: [-0.4, -1, -0.5],
      mapSize: 2048,
      cascadeCount: 3,
    },
  }).unwrap();
  const mesh = firstLevel
    ? undefined
    : assets.create(createBoxGeometry(0.5, 0.5, 0.5).unwrap()).unwrap();
  const permanent = world.spawn(
    { component: Transform, data: { pos: [-2, 1, 0] } },
    ...(mesh === undefined
      ? []
      : [
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: {} },
        ]),
  ).unwrap();
  const movement = defineSystem({
    name: 'permanent-motion',
    queries: [],
    fn: () => world.set(permanent, Transform, {
      pos: [-2 + 0.2 * Math.sin(world.getResource(FixedTime).tick * 0.03), 1, 0],
    }).unwrap(),
  });
  world.addSystem(FixedUpdate, movement).unwrap();
  let level: Level | undefined;
  let shared: Level | undefined;
  return {
    async request(kind: string): Promise<LevelFixtureStatus> {
      if (kind === 'load') {
        level ??= levels.create({ scene: rootGuid }).unwrap();
        (await level.request('prepared').unwrap().done).unwrap();
      } else if (kind === 'share') {
        shared = levels.create({ scene: rootGuid }).unwrap();
        (await shared.request('active').unwrap().done).unwrap();
      } else if (kind === 'unload-shared' && shared !== undefined) {
        (await shared.request('unloaded').unwrap().done).unwrap();
        shared = undefined;
      } else if (kind === 'open-split-view') {
        world.addComponent(camera, {
          component: CameraView,
          data: { viewport: [0, 0, 0.5, 1] },
        }).unwrap();
        world.spawn(
          {
            component: Transform,
            data: { pos: [1, 2, 8], quat: [-Math.sin(0.12), 0, 0, Math.cos(0.12)] },
          },
          { component: Camera, data: perspective({ fov: 1, aspect: 1 }) },
          { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
        ).unwrap();
      } else if (kind === 'active' || kind === 'prepared' || kind === 'unloaded') {
        const failure = level?.inspect().failure;
        if (failure !== undefined) throw failure;
        if (level !== undefined) (await level.request(kind).unwrap().done).unwrap();
      }
      const status = level?.inspect();
      return {
        phase: status?.phase,
        current: status?.current,
        failure: levelFixtureError(status?.failure),
        cleanupFailure: levelFixtureError(status?.cleanupFailure),
        renderSelection:
          status?.picture === undefined ? undefined : { active: true, ...status.picture },
        memberCount: status?.members,
        tick: world.getResource(FixedTime).tick,
        hit: raycast()?.entity,
      };
    },
    dispose: () => world.removeSystem(FixedUpdate, movement).unwrap(),
  };
}
