import {
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  DirectionalLight as NativeDirectionalLight,
  PointLight as NativePointLight,
  SpotLight as NativeSpotLight,
  Skylight,
} from '@forgeax/engine-render';
import { GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import {
  AmbientLight,
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PointLight,
  Scene,
  ShaderMaterial,
  SpotLight,
} from 'three/src/Three.Core.js';
import { afterEach, describe, expect, it } from 'vitest';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

describe('Three source to native World', () => {
  const owned: SceneProjection[] = [];
  afterEach(() => {
    for (const projection of owned.splice(0)) projection.dispose();
  });
  function fixture() {
    const projection = new SceneProjection();
    owned.push(projection);
    const scene = new Scene();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    const material = new MeshBasicMaterial({ color: 0xff8040 });
    const mesh: Mesh = new Mesh(new BoxGeometry(), material);
    scene.add(mesh);
    const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const entity = (source = mesh) => {
      const match = projection.sources().find((row) => row.uuid === source.uuid);
      if (match === undefined) throw new Error('missing source');
      return match.entityKey as Parameters<typeof projection.world.get>[0];
    };
    return { projection, scene, camera, material, mesh, sync, entity };
  }

  it('projects camera-visible ambient irradiance and clears removed lights', () => {
    const f = fixture();
    const first = new AmbientLight(0xffffff, 2);
    const second = new AmbientLight(0xffffff, 3);
    f.scene.add(first, second);
    const sky = () =>
      [...f.projection.world.query({ read: [Skylight] }).unwrap()][0]?.get(Skylight);
    f.sync();
    expect(Array.from(sky()?.ambientIrradiance ?? [])).toEqual([5, 5, 5]);
    expect(sky()?.intensity).toBe(0);
    second.layers.set(1);
    f.sync();
    expect(Array.from(sky()?.ambientIrradiance ?? [])).toEqual([2, 2, 2]);
    f.scene.remove(first, second);
    f.sync();
    expect(Array.from(sky()?.ambientIrradiance ?? [])).toEqual([0, 0, 0]);
  });

  it('uses the frozen camera view cache independently of its world matrix', () => {
    const f = fixture();
    f.camera.updateMatrixWorld();
    f.camera.matrixWorldAutoUpdate = false;
    f.camera.matrixWorldInverse.elements[12] = -2;
    const camera = f.sync();
    expect(f.projection.world.get(camera, GlobalTransform).unwrap().world[12]).toBe(2);
    expect(f.camera.matrixWorld.elements[12]).toBe(0);
    f.camera.matrixWorld.elements[12] = 100;
    f.sync();
    expect(f.projection.world.get(camera, GlobalTransform).unwrap().world[12]).toBe(2);
  });

  it('accepts the inverse roundoff of an orbit camera pose', () => {
    const f = fixture();
    f.camera.position.set(3.999999999999998, 2.499999999999999, 5.999999999999997);
    f.camera.lookAt(0, 0.3, 0);
    const entity = f.sync();
    const actual = f.projection.world.get(entity, GlobalTransform).unwrap().world;
    f.camera.matrixWorld.elements.forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, 5);
    });
  });

  it('strips source camera scale as r184 does and rejects non-rigid view overrides', () => {
    const f = fixture();
    f.camera.scale.set(-2, 3, 4);
    const entity = f.sync();
    const expected = f.camera.matrixWorldInverse.clone().invert().elements;
    const actual = f.projection.world.get(entity, GlobalTransform).unwrap().world;
    expected.forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, 5);
    });
    f.camera.matrixWorldAutoUpdate = false;
    f.camera.matrixWorldInverse.makeShear(0, 0, 0.5, 0, 0, 0);
    expect(f.sync).toThrow('Camera.matrixWorldInverse requires a rigid view');
  });

  it('samples consecutive source transforms synchronously', () => {
    const f = fixture();
    f.mesh.position.x = 1;
    f.sync();
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(1);
    f.mesh.position.x = 2;
    f.sync();
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(2);
    expect(f.mesh.position.x).toBe(2);
  });

  it('preserves manual affine matrices and frozen world matrices', () => {
    const f = fixture();
    f.mesh.matrixAutoUpdate = false;
    f.mesh.matrix.copy(new Matrix4().set(1, 0.5, 0.2, 2, 0, 1, -0.3, 1, 0, 0, -2, 0, 0, 0, 0, 1));
    f.sync();
    const read = () => [...f.projection.world.get(f.entity(), GlobalTransform).unwrap().world];
    f.mesh.matrixWorld.elements.forEach((value, index) => {
      expect(read()[index]).toBeCloseTo(value, 5);
    });
    const frozen = read();
    f.mesh.matrixWorldAutoUpdate = false;
    f.mesh.matrix.makeTranslation(20, 0, 0);
    f.sync();
    expect(read()).toEqual(frozen);
    f.mesh.matrixWorld.makeTranslation(3, 4, 5);
    f.sync();
    expect(read().slice(12, 15)).toEqual([3, 4, 5]);
  });

  it('renders an Object3D root and preserves an externally parented camera cache', () => {
    const f = fixture();
    const root = new Group();
    root.add(f.mesh);
    const parent = new Group();
    parent.position.x = 3;
    parent.add(f.camera);
    parent.updateMatrixWorld(true);
    const sync = () => f.projection.sync(root, f.camera, cameraData(f.camera, NoToneMapping, 1));
    const cameraEntity = sync();
    const read = () => f.projection.world.get(cameraEntity, GlobalTransform).unwrap().world[12];
    expect(read()).toBe(3);
    parent.position.x = 7;
    sync();
    expect(read()).toBe(3);
    parent.updateMatrixWorld(true);
    sync();
    expect(read()).toBe(7);
  });

  it('shares geometry/material handles, observes edits, and reuses handles in static frames', () => {
    const f = fixture();
    const other = new Mesh(f.mesh.geometry, f.material);
    f.scene.add(other);
    f.sync();
    const handle = () => f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    const first = handle();
    expect(f.projection.world.get(f.entity(other), MeshRenderer).unwrap().materials[0]).toBe(first);
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(
      f.projection.world.get(f.entity(other), MeshFilter).unwrap().assetHandle,
    );
    const live = f.projection.world.sharedRefs._liveCount();
    for (let i = 0; i < 20; i++) f.sync();
    expect(handle()).toBe(first);
    expect(f.projection.world.sharedRefs._liveCount()).toBe(live);
    f.material.color.set(0x00ff00);
    f.sync();
    expect(handle()).not.toBe(first);
    expect(f.projection.world.get(f.entity(other), MeshRenderer).unwrap().materials[0]).toBe(
      handle(),
    );
    expect(f.projection.world.sharedRefs._liveCount()).toBe(live);
  });

  it('publishes only changed native component values without a second component cache', () => {
    const f = fixture();
    const light = new PointLight(0x336699, 0.3);
    f.scene.add(light, new DirectionalLight(0x7799bb, 0.7), new SpotLight(0xaabbcc, 0.2));
    const camera = f.sync();
    const queries = [
      Transform,
      GlobalTransform,
      Name,
      MeshFilter,
      MeshRenderer,
      NativeCamera,
      Skylight,
      NativeDirectionalLight,
      NativePointLight,
      NativeSpotLight,
    ].map((component) => f.projection.world.query({ changed: [component] }).unwrap());
    for (const query of queries) [...query];
    for (let i = 0; i < 3; i++) {
      f.sync();
      expect(queries.map((query) => [...query].length)).toEqual(queries.map(() => 0));
    }
    f.material.color.set(0x112233);
    f.camera.fov = 35;
    f.camera.updateProjectionMatrix();
    light.color.set(0xff0000);
    f.sync();
    const changes = queries.map((query) => [...query].map((row) => row.entity));
    expect(changes[4]).toEqual([f.entity()]);
    expect(changes[5]).toEqual([camera]);
    expect(changes[8]).toHaveLength(1);
    f.sync();
    expect(queries.map((query) => [...query].length)).toEqual(queries.map(() => 0));
  });

  it('keeps admitted resources and entities intact when native material preparation fails', () => {
    const f = fixture();
    f.material.map = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    f.sync();
    const live = f.projection.world.sharedRefs._liveCount();
    const handle = () => f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    const original = handle();
    f.material.map = new DataTexture(new Uint8Array([0, 255, 0, 255]), 1, 1);
    const material = new MeshPhysicalMaterial({ ior: 0, map: f.material.map });
    const rejected = new Mesh(f.mesh.geometry, material);
    f.scene.add(rejected);
    f.mesh.position.x = 99;
    for (let i = 0; i < 3; i++) {
      expect(f.sync).toThrow(/ior/);
      expect(handle()).toBe(original);
      expect(f.projection.world.sharedRefs._liveCount()).toBe(live);
      expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(0);
      expect(f.projection.sources().some((source) => source.uuid === rejected.uuid)).toBe(false);
    }
    material.ior = 1.5;
    f.sync();
    expect(handle()).not.toBe(original);
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(99);
    expect(f.projection.sources().some((source) => source.uuid === rejected.uuid)).toBe(true);
    f.projection.dispose();
    expect(f.projection.world.sharedRefs._liveCount()).toBe(0);
  });

  it('keeps native hierarchy semantics through reparent, removal and reuse', () => {
    const f = fixture();
    const parent = new Group();
    parent.scale.set(2, 3, 4);
    parent.position.x = 5;
    f.scene.add(parent);
    parent.add(f.mesh);
    f.mesh.position.x = 1;
    f.sync();
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(7);
    f.scene.add(f.mesh);
    f.scene.remove(parent);
    f.sync();
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(1);
    const old = f.entity();
    f.scene.remove(f.mesh);
    f.sync();
    expect(f.projection.world.hasComponent(old, MeshFilter)).toBe(false);
    f.scene.add(f.mesh);
    f.sync();
    expect(f.entity()).not.toBe(old);
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).not.toBe(0);
  });

  it('distinguishes inherited visibility from per-object camera layers', () => {
    const f = fixture();
    const parent = new Group();
    parent.layers.set(2);
    parent.add(f.mesh);
    f.scene.add(parent);
    f.sync();
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).not.toBe(0);
    parent.visible = false;
    f.sync();
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(0);
    parent.visible = true;
    f.mesh.layers.set(2);
    f.sync();
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(0);
    f.camera.layers.enable(2);
    f.sync();
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).not.toBe(0);
  });

  it('respects cached camera projection and explicit updateProjectionMatrix', () => {
    const f = fixture();
    const entity = f.sync();
    const before = f.projection.world.get(entity, NativeCamera).unwrap().fov;
    f.camera.fov = 30;
    f.sync();
    expect(f.projection.world.get(entity, NativeCamera).unwrap().fov).toBe(before);
    f.camera.updateProjectionMatrix();
    f.sync();
    expect(f.projection.world.get(entity, NativeCamera).unwrap().fov).toBeCloseTo(Math.PI / 6);
  });

  it('preserves view offsets, film offsets and the cached off-axis projection', () => {
    const f = fixture();
    f.camera.setViewOffset(1920, 1080, 320, 120, 960, 720);
    f.camera.filmOffset = 4;
    f.camera.updateProjectionMatrix();
    const entity = f.sync();
    const read = () => f.projection.world.get(entity, NativeCamera).unwrap();
    expect([...read().projectionOffset]).toEqual(
      [-f.camera.projectionMatrix.elements[8], -f.camera.projectionMatrix.elements[9]].map(
        Math.fround,
      ),
    );
    const before = [...read().projectionOffset];
    f.camera.filmOffset = -2;
    f.sync();
    expect([...read().projectionOffset]).toEqual(before);
    f.camera.updateProjectionMatrix();
    f.sync();
    expect([...read().projectionOffset]).not.toEqual(before);
    f.camera.clearViewOffset();
    f.camera.filmOffset = 0;
    f.camera.updateProjectionMatrix();
    f.sync();
    expect([...read().projectionOffset].every((value) => value === 0)).toBe(true);
  });

  it('admits every used material before changing any World entity', () => {
    const f = fixture();
    f.sync();
    f.mesh.position.x = 99;
    const unsupported = new Mesh(new BoxGeometry(), new ShaderMaterial());
    f.scene.add(unsupported);
    expect(f.sync).toThrow('three-migration-required');
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(0);
    expect(f.projection.sources().some((source) => source.uuid === unsupported.uuid)).toBe(false);
    f.scene.remove(unsupported);
    f.sync();
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(99);
  });

  it('honors geometry version and dispose invalidation', () => {
    const f = fixture();
    f.sync();
    const handle = () => f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    const first = handle();
    f.mesh.geometry.getAttribute('position').setX(0, 2);
    f.sync();
    expect(handle()).toBe(first);
    f.mesh.geometry.getAttribute('position').needsUpdate = true;
    f.sync();
    expect(handle()).not.toBe(first);
    const updated = handle();
    f.mesh.geometry.dispose();
    f.sync();
    expect(handle()).not.toBe(updated);
  });

  it('keeps texture dependencies alive when an unchanged material cache hits', () => {
    const f = fixture();
    const texture = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    texture.needsUpdate = true;
    f.material.map = texture;
    f.sync();
    const live = f.projection.world.sharedRefs._liveCount();
    for (let i = 0; i < 20; i++) f.sync();
    expect(f.projection.world.sharedRefs._liveCount()).toBe(live);
    texture.needsUpdate = true;
    f.sync();
    expect(f.projection.world.sharedRefs._liveCount()).toBe(live);
    f.projection.dispose();
    expect(f.projection.world.sharedRefs._liveCount()).toBe(0);
  });

  it('accepts Standard material and rejects a used shader hook', () => {
    const f = fixture();
    const material = new MeshStandardMaterial();
    f.mesh.material = material;
    expect(f.sync).not.toThrow();
    material.onBeforeCompile = () => {};
    expect(f.sync).toThrow('shader callbacks');
  });

  it('projects spot target, cone, power, finite range and camera layers into native light state', () => {
    const f = fixture();
    const light = new SpotLight(0xffffff, 20, 0, Math.PI / 3, 0.25, 2);
    light.position.set(0, 0, 3);
    f.scene.add(light, light.target);
    f.sync();
    const source = f.projection.sources().find((source) => source.uuid === light.uuid);
    if (source === undefined) throw new Error('missing spot source');
    const entity = source.entityKey as Parameters<typeof f.projection.world.get>[0];
    const read = () => f.projection.world.get(entity, NativeSpotLight).unwrap();
    expect([...read().direction]).toEqual([0, 0, -1]);
    expect(read()).toMatchObject({
      intensity: 20,
      range: Infinity,
      outerConeDeg: 60,
      innerConeDeg: 45,
      castShadow: false,
    });
    light.target.position.x = 3;
    light.power = 30 * Math.PI;
    light.distance = 7;
    light.angle = Math.PI / 4;
    light.penumbra = 0;
    f.sync();
    expect(read().direction[0]).toBeCloseTo(Math.SQRT1_2);
    expect(read().direction[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(read()).toMatchObject({ intensity: 30, range: 7, outerConeDeg: 45, innerConeDeg: 45 });
    light.layers.set(2);
    f.sync();
    expect(read().intensity).toBe(0);
    f.camera.layers.enable(2);
    f.sync();
    expect(read().intensity).toBe(30);
  });
});
