import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';

import { type EntityHandle, FixedTime, FixedUpdate } from '@forgeax/engine-ecs';
import { quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  createPathSample,
  DesiredPathPose,
  PATH_FOLLOW_SYSTEM,
  Path,
  PathFollower,
  pathPlugin,
  preparePath,
} from '@forgeax/engine-path';
import {
  CharacterController,
  Collider,
  type PhysicsWorld,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import {
  ChildOf,
  GlobalTransform,
  Name,
  Transform,
  worldInstantiateSceneFlat,
} from '@forgeax/engine-scene';

import { sceneGuid } from './scene-guid';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const canvas = document.querySelector<HTMLCanvasElement>('#app') as HTMLCanvasElement;
const app = (
  await createApp(
    canvas,
    {
      plugins: [pathPlugin(), physicsPlugin('rapier-3d')],
      ...(import.meta.env.DEV && runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      time: { fixedDeltaSeconds: 1 / 60 },
    },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport() },
  )
).unwrap();
const assets = app.assets;
if (!assets) throw new Error('App asset service absent');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const guid = sceneGuid;
const handle = (await assets.load(guid, 'scene')).unwrap();
try {
  worldInstantiateSceneFlat(app.world, handle).unwrap();
} finally {
  assets.release(handle).unwrap();
}
const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const patrolMaterial = app.assets.create(Materials.unlit([0.05, 0.85, 0.8, 1])).unwrap();
const platformMaterial = app.assets.create(Materials.unlit([1, 0.55, 0.1, 1])).unwrap();
const upMaterial = app.assets.create(Materials.unlit([0.95, 0.98, 1, 1])).unwrap();
const floorMaterial = app.assets.create(Materials.unlit([0.1, 0.16, 0.24, 1])).unwrap();
const markerMaterial = app.assets.create(Materials.unlit([0.3, 0.43, 0.62, 1])).unwrap();
const named = new Map<string, EntityHandle>();
for (const row of world.query({ read: [Name] }).unwrap())
  named.set(row.get(Name).value, row.entity);
const rail = named.get('rail') as EntityHandle,
  platform = named.get('platform') as EntityHandle,
  railCamera = named.get('rail-camera') as EntityHandle;
for (let i = 0; i < 8; i++) {
  const entity = named.get(`patrol${i}`) as EntityHandle;
  world
    .addComponent(entity, { component: MeshFilter, data: { assetHandle: primitiveCube } })
    .unwrap();
  world
    .addComponent(entity, { component: MeshRenderer, data: { materials: [patrolMaterial] } })
    .unwrap();
  world
    .spawn(
      { component: ChildOf, data: { parent: entity } },
      { component: Transform, data: { pos: [0, 0, 0.65], scale: [0.65, 0.3, 0.3] } },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [platformMaterial] } },
    )
    .unwrap();
  world
    .spawn(
      { component: ChildOf, data: { parent: entity } },
      { component: Transform, data: { pos: [0, 0.7, 0], scale: [0.25, 0.3, 0.25] } },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [upMaterial] } },
    )
    .unwrap();
}
// The motor installs transient output after loading the ordinary saved Scene.
world.addComponent(platform, { component: DesiredPathPose, data: {} }).unwrap();
world
  .addComponent(platform, { component: MeshFilter, data: { assetHandle: primitiveCube } })
  .unwrap();
world
  .addComponent(platform, { component: MeshRenderer, data: { materials: [platformMaterial] } })
  .unwrap();
world
  .addComponent(platform, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } })
  .unwrap();
world
  .addComponent(platform, { component: Collider, data: { halfExtents: [0.6, 0.075, 0.6] } })
  .unwrap();
world
  .addComponent(platform, { component: CharacterController, data: { snapToGroundDist: 0 } })
  .unwrap();
const delta = vec3.create();
// Existing PhysicsWorld owns actual movement. The path never writes this body.
world
  .addSystem(FixedUpdate, {
    name: 'platform/motor',
    after: [PATH_FOLLOW_SYSTEM, 'physicsSyncBackend'],
    before: ['physicsStepSimulation'],
    queries: [],
    fn() {
      const desired = world.get(platform, DesiredPathPose).unwrap();
      if (!desired.valid) return;
      vec3.sub(
        delta,
        desired.position,
        world.get(platform, GlobalTransform).unwrap().world.subarray(12, 15),
      );
      world.getResource<PhysicsWorld>('PhysicsWorld').moveAndSlide(platform, delta);
    },
  })
  .unwrap();
world
  .spawn(
    { component: Transform, data: { pos: [0, -0.1, 0], scale: [20, 0.1, 20] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [floorMaterial] } },
  )
  .unwrap();
// Equal world-distance reference markers use ordinary rendered meshes.
const prepared = preparePath(world.get(rail, Path).unwrap()).unwrap();
const marker = createPathSample();
for (let i = 0; i < 48; i++) {
  prepared.sample(marker, (prepared.length * i) / 48);
  world
    .spawn(
      { component: Transform, data: { pos: marker.position, scale: [0.08, 0.08, 0.08] } },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [markerMaterial] } },
    )
    .unwrap();
}
const rotation = quat.create();
quat.fromLookAt(rotation, [12, 12, 16], [0, 1, 0], [0, 1, 0]);
const observer = world
  .spawn(
    { component: Transform, data: { pos: [12, 12, 16], quat: rotation } },
    {
      component: Camera,
      data: perspective({ fov: Math.PI / 3, aspect: 960 / 640, near: 0.1, far: 100 }),
    },
  )
  .unwrap();
const cameraData = perspective({ fov: Math.PI / 3, aspect: 960 / 640, near: 0.1, far: 100 });
let useRailCamera = false;
(document.querySelector('#camera') as HTMLButtonElement).addEventListener('click', () => {
  world.removeComponent(useRailCamera ? railCamera : observer, Camera).unwrap();
  world
    .addComponent(useRailCamera ? observer : railCamera, { component: Camera, data: cameraData })
    .unwrap();
  useRailCamera = !useRailCamera;
});
(document.querySelector('#pause') as HTMLButtonElement).addEventListener('click', () => {
  for (const row of world.query({ write: [PathFollower] }).unwrap())
    row.mut(PathFollower).paused = !world.get(row.entity, PathFollower).unwrap().paused;
});
const debug = {
  app,
  world,
  sceneGuid: sceneGuid,
  rail,
  platform,
  railCamera,
  async closeup() {
    const target = named.get('patrol0') as EntityHandle;
    const matrix = world.get(target, GlobalTransform).unwrap().world;
    const center = vec3.create(matrix[12], matrix[13], matrix[14]);
    const up = vec3.create(matrix[4], matrix[5], matrix[6]);
    vec3.normalize(up, up);
    const eye = vec3.create(
      (center[0] as number) + 1.8,
      (center[1] as number) + 1.1,
      (center[2] as number) + 2.4,
    );
    const cameraRotation = quat.create();
    quat.fromLookAt(cameraRotation, eye, center, up);
    world.set(observer, Transform, { pos: eye, quat: cameraRotation }).unwrap();
    return debug.step(1);
  },
  async missingAsset() {
    const missing = AssetGuid.parse('01a10a05-1600-7000-8000-ffffffffffff');
    if (!missing.ok) throw missing.error;
    const result = await assets.load(missing.value, 'scene');
    if (result.ok) return { ok: true };
    const { code, expected, hint, detail } = result.error;
    return { ok: false, error: { code, expected, hint, detail } };
  },
  snapshot() {
    return {
      cameraMatrix: Array.from(
        world.get(useRailCamera ? railCamera : observer, GlobalTransform).unwrap().world,
      ),
      camera: (() => {
        const camera = world.get(useRailCamera ? railCamera : observer, Camera).unwrap();
        return { fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far };
      })(),
      tick: world.getResource(FixedTime).tick,
      worldIdentity: world.identity,
      sceneGuid: AssetGuid.format(sceneGuid),
      path: Array.from(world.get(rail, Path).unwrap().points),
      followers: Array.from(
        world.query({ read: [PathFollower, GlobalTransform, Name] }).unwrap(),
        (row) => ({
          entity: row.entity,
          name: row.get(Name).value,
          distance: row.get(PathFollower).distance,
          matrix: Array.from(row.get(GlobalTransform).world),
        }),
      ),
      platformDesired: Array.from(world.get(platform, DesiredPathPose).unwrap().position),
    };
  },
  async step(frames: number) {
    app.pause().unwrap();
    const drain = async () => {
      while (app.execution.report().frame.inFlight !== 0)
        await new Promise((resolve) => setTimeout(resolve, 1));
    };
    await drain();
    for (let i = 0; i < frames; i++) {
      app.stepFrame(1 / 60).unwrap();
      await drain();
    }
    return debug.snapshot();
  },
};
Object.assign(globalThis, { __pathDemo: debug });
app.start().unwrap();
