import {
  createRapier3DPhysicsWorld,
  loadRapier3D,
  registerPhysicsSystems,
} from '@forgeax/engine/physics-rapier3d';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, defineComponent, World } from '@forgeax/engine-ecs';
import { readEntityComponentEpoch, readMutationEpoch } from '@forgeax/engine-ecs/projection';
import {
  Collider,
  ColliderShapeValue,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import {
  FogModeValue,
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  Fog as NativeFog,
  type Renderer,
  type RendererEvent,
} from '@forgeax/engine-render';
import {
  ChildOf,
  GlobalTransform,
  propagateTransforms,
  scenePlugin,
  Transform,
} from '@forgeax/engine-scene';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import {
  BoxGeometry,
  Color,
  Fog,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { afterEach, expect, it, vi } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { mountThreeScene, type ThreeSceneMount } from '../index';
import { prepareMaterialPrograms } from '../material-programs';
import { setThreeSceneTracking } from '../source-changes';
import { initializePoseLayout } from '../source-fields';

// These tests isolate ECS/lifecycle policy. Cooked program admission and actual
// submission use the real public factory in interop.browser/dawn.test.ts.
vi.mock('../material-programs', () => ({
  prepareMaterialPrograms: vi.fn(async () => (material: MaterialAsset) => material),
}));

const owned: { mount?: ThreeSceneMount; assets: AssetRegistry }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.mount?.dispose().unwrap();
    item.assets.dispose();
  }
});

function fixture() {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const world = new World({ assets });
  const listeners = new Set<(event: RendererEvent) => void>();
  const release = vi.fn();
  // Structural mount tests only; real draw/receipt behavior has a separate GPU carrier.
  const renderer = {
    attach: vi.fn(() => ok({ dispose: release })),
    subscribe: (listener: (event: RendererEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Renderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  scene.add(mesh);
  const item: { mount?: ThreeSceneMount; assets: AssetRegistry } = { assets };
  owned.push(item);
  return { assets, world, renderer, scene, camera, mesh, release, listeners, item };
}

it('mounts into the existing World and retires only its own entities', async () => {
  const f = fixture();
  const tag = defineComponent('NativeInteropTag', { value: { type: 'f32', default: 1 } });
  const native = f.world
    .spawn({ component: Transform, data: {} }, { component: tag, data: {} })
    .unwrap();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const entity = mount.entityFor(f.mesh).unwrap();
  f.world.addComponent(entity, { component: tag, data: { value: 2 } }).unwrap();
  f.mesh.position.x = 3;
  mount.sync().unwrap();
  expect(f.world.get(entity, Transform).unwrap().pos[0]).toBe(3);
  expect(f.world.get(entity, tag).unwrap().value).toBe(2);
  expect(f.world.get(native, tag).unwrap().value).toBe(1);
  expect(f.renderer.attach).toHaveBeenCalledWith(f.world);
  mount.dispose().unwrap();
  mount.dispose().unwrap();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.listeners.size).toBe(0);
  expect(f.world.hasComponent(native, tag)).toBe(true);
  expect(f.world.hasComponent(entity, Transform)).toBe(false);
  expect(mount.entityFor(f.mesh).ok).toBe(false);
  expect(mount.sync().ok).toBe(false);
});

it('retains the owner failure and allows admission retry without a half mount', async () => {
  const f = fixture();
  const cause = new Error('material owner failed');
  vi.mocked(prepareMaterialPrograms).mockRejectedValueOnce(cause);
  const failed = await mountThreeScene(f);
  expect(failed.ok).toBe(false);
  if (failed.ok) throw new Error('expected failed admission');
  expect(failed.error.code).toBe('three-owner-failed');
  expect(failed.error.cause).toBe(cause);
  expect(f.renderer.attach).not.toHaveBeenCalled();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  expect(mount.entityFor(f.mesh).ok).toBe(true);
});

it('rejects a second mount and permits a fresh generation after disposal', async () => {
  const f = fixture();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const old = mount.entityFor(f.mesh).unwrap();
  expect((await mountThreeScene(f)).ok).toBe(false);
  mount.dispose().unwrap();
  const next = (await mountThreeScene(f)).unwrap();
  f.item.mount = next;
  expect(next.entityFor(f.mesh).unwrap()).not.toBe(old);
});

it('detects removal, direct property edits and invalidated source entities', async () => {
  const f = fixture();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const old = mount.entityFor(f.mesh).unwrap();
  f.scene.remove(f.mesh);
  mount.sync().unwrap();
  expect(mount.entityFor(f.mesh).ok).toBe(false);
  expect(f.world.hasComponent(old, Transform)).toBe(false);
  f.scene.add(f.mesh);
  mount.sync().unwrap();
  const next = mount.entityFor(f.mesh).unwrap();
  expect(next).not.toBe(old);
  f.world.despawn(next).unwrap();
  expect(mount.entityFor(f.mesh).ok).toBe(false);
  expect(mount.sync().ok).toBe(false);
});

it('projects linear and exponential depth fog and removes its own fog on clear', async () => {
  const f = fixture();
  f.scene.fog = new Fog(0x6688aa, 2, 20);
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const entity = mount.entityFor(f.scene).unwrap();
  expect(f.world.get(entity, NativeFog).unwrap()).toMatchObject({
    mode: FogModeValue.linear,
    near: 2,
    far: 20,
  });
  f.scene.fog = new FogExp2(0x224466, 0.2);
  mount.sync().unwrap();
  expect(f.world.get(entity, NativeFog).unwrap().mode).toBe(FogModeValue.exp2);
  expect(f.world.get(entity, NativeFog).unwrap().density).toBeCloseTo(0.2);
  f.scene.fog = null;
  mount.sync().unwrap();
  expect(f.world.hasComponent(entity, NativeFog)).toBe(false);
});

it('shares standalone clear-color semantics without retaining invocation scratch', async () => {
  const f = fixture();
  f.scene.background = new Color(0x204060);
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const camera = mount.entityFor(f.camera).unwrap();
  expect([...f.world.get(camera, NativeCamera).unwrap().clearColor]).toEqual([
    ...new Float32Array([...f.scene.background.toArray(), 1]),
  ]);
  f.scene.background = null;
  mount.sync().unwrap();
  expect([...f.world.get(camera, NativeCamera).unwrap().clearColor]).toEqual([0, 0, 0, 0]);
});

it('does not rewrite unchanged source components or enumerate native entities', async () => {
  const f = fixture();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const accepted = new Set([
    mount.entityFor(f.scene).unwrap(),
    mount.entityFor(f.mesh).unwrap(),
    mount.entityFor(f.camera).unwrap(),
  ]);
  const write = vi.spyOn(f.world, 'set');
  const get = vi.spyOn(f.world, 'get');
  const has = vi.spyOn(f.world, 'hasComponent');
  const query = vi.spyOn(f.world, 'query');
  const replace = vi.spyOn(f.assets, 'replace');
  const create = vi.spyOn(f.assets, 'create');
  let previous = 0;
  let expectedReads: readonly number[] | undefined;
  for (const population of [1000, 10000]) {
    for (let i = previous; i < population; i++)
      f.world.spawn({ component: Transform, data: {} }).unwrap();
    for (const spy of [write, get, has, query, replace, create]) spy.mockClear();
    mount.sync().unwrap();
    expect(write).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    for (const [entity] of [...get.mock.calls, ...has.mock.calls])
      expect(accepted.has(entity)).toBe(true);
    const reads = [get.mock.calls.length, has.mock.calls.length];
    if (expectedReads !== undefined) expect(reads).toEqual(expectedReads);
    expectedReads = reads;
    previous = population;
  }
});

it('shares projected assets with native entities without a conversion or lifetime mirror', async () => {
  const f = fixture();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const source = mount.entityFor(f.mesh).unwrap();
  const mesh = f.world.get(source, MeshFilter).unwrap().assetHandle;
  const materials = [...f.world.get(source, MeshRenderer).unwrap().materials];
  const create = vi.spyOn(f.assets, 'create');
  const native = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials } },
    )
    .unwrap();
  expect(create).not.toHaveBeenCalled();
  mount.dispose().unwrap();
  expect(f.world.get(native, MeshFilter).unwrap().assetHandle).toBe(mesh);
  expect(f.assets.read(mesh).ok).toBe(true);
  f.world.despawn(native).unwrap();
  expect(f.assets.read(mesh).ok).toBe(false);
});

it('rejects native pose writers before source state is changed', async () => {
  const f = fixture();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const source = mount.entityFor(f.mesh).unwrap();
  f.world
    .addComponent(source, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } })
    .unwrap();
  f.mesh.position.x = 5;
  expect(mount.sync().ok).toBe(false);
  expect(f.world.get(source, Transform).unwrap().pos[0]).toBe(0);
  f.world.removeComponent(source, RigidBody).unwrap();
  mount.sync().unwrap();
  expect(f.world.get(source, Transform).unwrap().pos[0]).toBe(5);
});

it('does not cascade-despawn native children during removal or cleanup', async () => {
  const f = fixture();
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const source = mount.entityFor(f.mesh).unwrap();
  const child = f.world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: source } })
    .unwrap();
  f.scene.remove(f.mesh);
  expect(mount.sync().ok).toBe(false);
  expect(mount.dispose().ok).toBe(false);
  expect(f.world.hasComponent(child, Transform)).toBe(true);
  f.world.removeComponent(child, ChildOf).unwrap();
  mount.sync().unwrap();
  mount.dispose().unwrap();
  expect(f.world.hasComponent(child, Transform)).toBe(true);
});

it('collides a real native dynamic body with a Three-owned static collider and retires it', {
  timeout: 120000,
}, async () => {
  const f = fixture();
  f.mesh.position.y = -0.5;
  f.mesh.scale.set(10, 1, 10);
  const context = await createWorldContext(f.world, [scenePlugin()]);
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  f.world.insertResource(PhysicsWorldResource, physics);
  const release = registerPhysicsSystems(f.world);
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const floor = mount.entityFor(f.mesh).unwrap();
  f.world
    .addComponent(floor, {
      component: Collider,
      data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], restitution: 0 },
    })
    .unwrap();
  const ball = f.world
    .spawn(
      { component: Transform, data: { pos: [0, 4, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.sphere, radius: 0.5, restitution: 0 },
      },
    )
    .unwrap();
  try {
    for (let frame = 0; frame < 90; frame++) {
      mount.sync().unwrap();
      f.world.update(1 / 60).unwrap();
    }
    const settled = f.world.get(ball, Transform).unwrap().pos[1];
    expect(settled).toBeGreaterThan(0.45);
    expect(settled).toBeLessThan(0.55);
    mount.dispose().unwrap();
    for (let frame = 0; frame < 60; frame++) f.world.update(1 / 60).unwrap();
    expect(f.world.get(ball, Transform).unwrap().pos[1]).toBeLessThan(-0.5);
    expect(physics.hasBody(ball)).toBe(true);
  } finally {
    mount.dispose().unwrap();
    f.world.despawn(ball).unwrap();
    f.world.update(1 / 60).unwrap();
    release();
    await context.fiber.dispose();
    physics.dispose();
  }
});

it('isolates native edits by entity and restores the mapped owner while tracking', async () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) {
    const glass = f.mesh.clone();
    glass.material = new MeshBasicMaterial({ transparent: true });
    f.scene.add(glass);
  }
  setThreeSceneTracking(f.scene, true);
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const source = mount.entityFor(f.mesh).unwrap();
  mount.sync().unwrap();
  const native = f.world.spawn({ component: Transform, data: {} }).unwrap();
  f.world.set(native, Transform, { pos: [9, 2, 1] }).unwrap();
  mount.sync().unwrap();
  expect(mount.sourceWork()).toMatchObject({ mode: 'tracked', sourceNodes: 0, meshPlans: 0 });
  const glass = f.scene.children[2];
  if (!glass) throw new Error('Missing retained transparent mesh');
  const glassEntity = mount.entityFor(glass).unwrap();
  f.world.set(glassEntity, MeshRenderer, { materials: [] }).unwrap();
  mount.sync().unwrap();
  expect(mount.sourceWork()).toMatchObject({ mode: 'tracked', sourceNodes: 1, meshPlans: 1 });
  expect(f.world.get(glassEntity, MeshRenderer).unwrap().materials).toHaveLength(1);
  f.world.set(source, Transform, { pos: [1, 4, 9] }).unwrap();
  mount.sync().unwrap();
  expect(mount.sourceWork()).toMatchObject({ mode: 'tracked', sourceNodes: 1 });
  expect(f.world.get(source, Transform).unwrap().pos[0]).toBe(0);
  f.world
    .addComponent(source, { component: RigidBody, data: { type: RigidBodyTypeValue.static } })
    .unwrap();
  mount.sync().unwrap();
  f.world.set(source, RigidBody, { type: RigidBodyTypeValue.dynamic }).unwrap();
  expect(mount.sync().ok).toBe(false);
  f.world.removeComponent(source, RigidBody).unwrap();
  mount.sync().unwrap();
});

it('coalesces tracked local edits into the correct ECS position at each mount boundary', async () => {
  const a = fixture(),
    b = fixture();
  b.scene = a.scene;
  initializePoseLayout(a.mesh.position, false);
  const parent = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  a.scene.add(parent);
  parent.add(a.mesh);
  parent.position.x = 10;
  setThreeSceneTracking(a.scene, true);
  const first = (await mountThreeScene(a)).unwrap(),
    second = (await mountThreeScene(b)).unwrap();
  a.item.mount = first;
  b.item.mount = second;
  const entity = first.entityFor(a.mesh).unwrap(),
    other = second.entityFor(a.mesh).unwrap();
  const alias = a.mesh.position;
  const marker = defineComponent('DirectPositionMigration', { value: 'u32' });
  a.world.addComponent(entity, { component: marker, data: { value: 1 } }).unwrap();
  first.sync().unwrap();
  const before = readMutationEpoch(a.world);
  const ranges = vi.spyOn(a.world, 'setArrayRange');
  alias.x = 2;
  alias.x = 16777217;
  expect(a.world.get(entity, Transform).unwrap().pos[0]).toBe(0);
  first.sync().unwrap();
  expect(alias.x).toBe(16777217);
  expect(a.world.get(entity, ChildOf).unwrap().parent).toBe(first.entityFor(parent).unwrap());
  expect(a.world.get(entity, Transform).unwrap().pos[0]).toBe(Math.fround(alias.x));
  propagateTransforms(a.world).unwrap();
  expect(a.world.get(entity, GlobalTransform).unwrap().world[12]).toBe(
    Math.fround(Math.fround(alias.x) + 10),
  );
  expect(b.world.get(other, Transform).unwrap().pos[0]).toBe(0);
  expect(readEntityComponentEpoch(a.world, entity, Transform)).toBe(before + 1);
  expect(ranges.mock.calls.some(([e, c]) => e === entity && c === Transform)).toBe(false);
  alias.x -= 0.1;
  first.sync().unwrap();
  expect(readEntityComponentEpoch(a.world, entity, Transform)).toBe(before + 1);
  second.sync().unwrap();
  expect(b.world.get(other, Transform).unwrap().pos[0]).toBe(Math.fround(alias.x));
  first.dispose().unwrap();
  delete a.item.mount;
  const replacement = a.world.spawn({ component: Transform, data: { pos: [99, 0, 0] } }).unwrap();
  alias.x = 4;
  second.sync().unwrap();
  expect(a.world.get(replacement, Transform).unwrap().pos[0]).toBe(99);
  expect(b.world.get(other, Transform).unwrap().pos[0]).toBe(4);
  setThreeSceneTracking(a.scene, false);
  second.sync().unwrap();
  expect(a.mesh.position).toBe(alias);
  expect(Object.getOwnPropertyDescriptor(alias, 'x')).toEqual({
    value: 4,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  expect(Object.getOwnPropertySymbols(alias)).toHaveLength(0);
  setThreeSceneTracking(a.scene, true);
  second.sync().unwrap();
  alias.x = 8;
  second.sync().unwrap();
  expect(b.world.get(other, Transform).unwrap().pos[0]).toBe(8);
  propagateTransforms(b.world).unwrap();
  expect(b.world.get(other, GlobalTransform).unwrap().world[12]).toBe(18);
});

it.each([
  true,
  false,
])('restores a rotated and scaled source after a native write and a translation (tracking %s)', async (tracked) => {
  const f = fixture();
  f.mesh.rotation.y = Math.PI / 3;
  f.mesh.scale.set(2, 3, 4);
  setThreeSceneTracking(f.scene, tracked);
  const mount = (await mountThreeScene(f)).unwrap();
  f.item.mount = mount;
  const entity = mount.entityFor(f.mesh).unwrap();
  const original = f.world.get(entity, Transform).unwrap();
  const expected = { quat: [...original.quat], scale: [...original.scale] };
  f.mesh.position.set(4, 5, 6);
  f.world.set(entity, Transform, { quat: [0, 0, 0, 1], scale: [1, 1, 1] }).unwrap();
  mount.sync().unwrap();
  const restored = f.world.get(entity, Transform).unwrap();
  expect([...restored.pos]).toEqual([4, 5, 6]);
  expect([...restored.quat]).toEqual(expected.quat);
  expect([...restored.scale]).toEqual(expected.scale);
});
