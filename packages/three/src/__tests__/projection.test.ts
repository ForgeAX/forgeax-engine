import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  DirectionalLight as NativeDirectionalLight,
  PointLight as NativePointLight,
  SpotLight as NativeSpotLight,
  ShadowParticipation,
  Skylight,
  samplerContribution,
} from '@forgeax/engine-render';
import { GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import type {
  MaterialAsset,
  MaterialTextureValue,
  MeshAsset,
  SamplerAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import * as ThreeCore from 'three/src/Three.Core.js';
import {
  AmbientLight,
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SpotLight,
  Texture,
  WebGPUCoordinateSystem,
} from 'three/src/Three.Core.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { cameraData } from '../camera';
import { prepareMaterialPrograms } from '../material-programs';
import { SceneProjection } from '../scene';
import { featureCases } from './features.fixture';

describe('Three source to native World', () => {
  const featureAssets = new AssetRegistry();
  let featureProjection: SceneProjection;
  beforeAll(async () => {
    installDefaultAssetDecoders(featureAssets);
    featureProjection = new SceneProjection(
      featureAssets,
      undefined,
      await prepareMaterialPrograms(featureAssets),
    );
  });
  afterAll(() => {
    featureProjection.dispose();
    featureAssets.dispose();
  });
  it.each(Object.entries(featureCases({ ...ThreeCore, ClippingGroup })))(
    'keeps %s geometry valid across the same source edits used by the GPU oracle',
    { timeout: 120000 },
    async (_name, populate) => {
      const assets = featureAssets;
      const projection = featureProjection;
      const scene = new Scene(),
        camera = new PerspectiveCamera(50, 1, 0.1, 100);
      camera.coordinateSystem = WebGPUCoordinateSystem;
      camera.updateProjectionMatrix();
      camera.position.z = 5;
      const edit = populate(scene);
      for (const phase of ['initial', 'edited']) {
        if (phase === 'edited') edit();
        projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
        let meshes = 0;
        for (const source of projection.sources()) {
          if (!projection.world.hasComponent(source.entityKey as EntityHandle, MeshFilter))
            continue;
          const handle = projection.world
            .get(source.entityKey as EntityHandle, MeshFilter)
            .unwrap().assetHandle;
          if (handle === 0) continue;
          const mesh = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
          const position = mesh.attributes.position as Float32Array;
          expect(position.length).toBeGreaterThan(0);
          expect(Array.from(position).every(Number.isFinite)).toBe(true);
          for (const index of mesh.indices as Uint16Array | Uint32Array)
            expect(index).toBeLessThan(position.length / 3);
          meshes++;
        }
        expect(meshes).toBeGreaterThan(0);
      }
    },
  );

  it('reads cached WebGPU perspective/orthographic depth ranges including reverse Z', () => {
    for (const reversed of [false, true]) {
      for (const camera of [
        new PerspectiveCamera(60, 1.5, 0.25, 2000),
        new OrthographicCamera(-2, 3, 4, -5, 0.25, 2000),
      ]) {
        camera.coordinateSystem = WebGPUCoordinateSystem;
        Object.defineProperty(camera, 'reversedDepth', { value: reversed });
        camera.updateProjectionMatrix();
        const original = cameraData(camera, NoToneMapping, 1);
        expect(original.near).toBeCloseTo(0.25, 6);
        expect(original.far).toBeCloseTo(2000, 6);
        camera.near = 1;
        camera.far = 100;
        expect(cameraData(camera, NoToneMapping, 1)).toEqual(original);
        camera.updateProjectionMatrix();
        expect(cameraData(camera, NoToneMapping, 1).near).toBeCloseTo(1, 6);
        expect(cameraData(camera, NoToneMapping, 1).far).toBeCloseTo(100, 6);
      }
    }
  });

  const owned: { projection: SceneProjection; assets: AssetRegistry }[] = [];
  afterEach(() => {
    for (const { projection, assets } of owned.splice(0)) {
      projection.dispose();
      assets.dispose();
    }
  });
  function fixture(
    assets = new AssetRegistry(),
    material: MeshBasicMaterial | MeshStandardMaterial = new MeshBasicMaterial({ color: 0xff8040 }),
    prepare?: Awaited<ReturnType<typeof prepareMaterialPrograms>>,
  ) {
    assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const projection = new SceneProjection(assets, undefined, prepare);
    owned.push({ projection, assets });
    const scene = new Scene();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 5;
    const mesh: Mesh = new Mesh(new BoxGeometry(), material);
    scene.add(mesh);
    const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const entity = (source = mesh) => {
      const match = projection.sources().find((row) => row.uuid === source.uuid);
      if (match === undefined) throw new Error('missing source');
      return match.entityKey as Parameters<typeof projection.world.get>[0];
    };
    return { projection, assets, scene, camera, material, mesh, sync, entity };
  }

  it('accepts the zero near plane of an orthographic camera without changing its cache semantics', () => {
    for (const reversed of [false, true]) {
      const camera = new OrthographicCamera(-2, 2, 2, -2, 0, 10);
      camera.coordinateSystem = WebGPUCoordinateSystem;
      Object.defineProperty(camera, 'reversedDepth', { value: reversed });
      camera.updateProjectionMatrix();
      expect(cameraData(camera, NoToneMapping, 1).near).toBeCloseTo(0, 8);
      camera.near = 1;
      expect(cameraData(camera, NoToneMapping, 1).near).toBeCloseTo(0, 8);
      camera.updateProjectionMatrix();
      expect(cameraData(camera, NoToneMapping, 1).near).toBeCloseTo(1, 8);
    }
  });

  it('admits missing normals and ignores unused custom attributes without changing the source', () => {
    const f = fixture();
    f.mesh.geometry.deleteAttribute('normal');
    const custom = new Float32BufferAttribute([7], 1);
    f.mesh.geometry.setAttribute('gameWeight', custom);
    f.sync();
    const handle = () => f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    const accepted = handle();
    const mesh = runtimeAssets(f.assets).borrow<MeshAsset>(accepted).unwrap();
    const normals = mesh.attributes.normal as Float32Array;
    expect(Array.from(normals)).toEqual(
      Array.from({ length: normals.length }, (_, i) => (i % 3 === 1 ? 1 : 0)),
    );
    expect(mesh.attributes).not.toHaveProperty('gameWeight');
    expect(f.mesh.geometry.getAttribute('normal')).toBeUndefined();
    custom.setX(0, 9);
    custom.needsUpdate = true;
    f.sync();
    expect(handle()).toBe(accepted);
    const lit = new MeshStandardMaterial();
    f.mesh.material = lit;
    f.sync();
    const materialHandle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    if (materialHandle === undefined) throw new Error('missing material');
    expect(f.assets.read(materialHandle).unwrap().values?.flatShading).toBe(1);
    expect(handle()).toBe(accepted);
    f.mesh.material = f.material;
    f.sync();
    expect(handle()).toBe(accepted);
    lit.dispose();
  });

  it('keeps smooth and flat projections of one shared material independent through edits and disposal', () => {
    const material = new MeshStandardMaterial();
    const f = fixture(new AssetRegistry(), material);
    const missing = f.mesh.geometry.clone().deleteAttribute('normal');
    const other = new Mesh(missing, material);
    f.scene.add(other);
    const handle = (mesh: Mesh) => {
      const value = f.projection.world.get(f.entity(mesh), MeshRenderer).unwrap().materials[0];
      if (value === undefined) throw new Error('missing material');
      return value;
    };
    const mode = (mesh: Mesh) => f.assets.read(handle(mesh)).unwrap().values?.flatShading;
    f.sync();
    expect(mode(f.mesh)).toBe(0);
    expect(mode(other)).toBe(1);
    expect(handle(f.mesh)).not.toBe(handle(other));
    material.color.set(0x00ff00);
    f.sync();
    for (const mesh of [f.mesh, other])
      expect(f.assets.read(handle(mesh)).unwrap().values?.baseColor).toEqual([0, 1, 0, 1]);
    material.flatShading = true;
    f.sync();
    expect(handle(f.mesh)).toBe(handle(other));
    material.flatShading = false;
    f.sync();
    expect(mode(f.mesh)).toBe(0);
    expect(mode(other)).toBe(1);
    material.dispose();
    f.sync();
    expect(mode(f.mesh)).toBe(0);
    expect(mode(other)).toBe(1);
    f.scene.remove(other);
    f.sync();
    f.scene.add(other);
    f.sync();
    expect(mode(other)).toBe(1);
    expect(material.flatShading).toBe(false);
    expect(missing.hasAttribute('normal')).toBe(false);
    missing.dispose();
  });

  it('projects mesh shadow participation independently of shared geometry and materials', () => {
    const f = fixture();
    const other = new Mesh(f.mesh.geometry, f.material);
    f.scene.add(other);
    f.mesh.castShadow = true;
    f.sync();
    const read = (source: Mesh) =>
      f.projection.world.get(f.entity(source), ShadowParticipation).unwrap();
    expect(read(f.mesh)).toMatchObject({ cast: true, receive: false });
    expect(read(other)).toMatchObject({ cast: false, receive: false });
    const geometry = f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    const materials = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials;
    f.mesh.castShadow = false;
    f.mesh.receiveShadow = true;
    f.sync();
    expect(read(f.mesh)).toMatchObject({ cast: false, receive: true });
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(geometry);
    expect(f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials).toEqual(materials);
    f.scene.remove(f.mesh);
    f.sync();
    f.scene.add(f.mesh);
    f.sync();
    expect(read(f.mesh)).toMatchObject({ cast: false, receive: true });
    const sun = new DirectionalLight();
    sun.castShadow = true;
    f.scene.add(sun);
    expect(f.sync).not.toThrow();
    const projectedSun = f.projection.sources().find((row) => row.uuid === sun.uuid);
    if (projectedSun === undefined) throw new Error('Missing projected light');
    expect(
      f.projection.world
        .get(projectedSun.entityKey as EntityHandle, NativeDirectionalLight)
        .unwrap().castShadow,
    ).toBe(false);
    expect(read(f.mesh)).toMatchObject({ cast: false, receive: true });
  });

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
    const handle = () => {
      const value = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
      if (value === undefined) throw new Error('missing material');
      return value;
    };
    const first = handle();
    const fixed = f.assets.snapshot(first).unwrap();
    const original = fixed.read<MaterialAsset>(first).unwrap();
    const changes = f.assets.observe().unwrap();
    expect(f.projection.world.get(f.entity(other), MeshRenderer).unwrap().materials[0]).toBe(first);
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(
      f.projection.world.get(f.entity(other), MeshFilter).unwrap().assetHandle,
    );
    for (let i = 0; i < 20; i++) f.sync();
    expect(handle()).toBe(first);
    expect(changes.read().unwrap().changes).toEqual([]);
    f.material.color.set(0x00ff00);
    f.sync();
    expect(handle()).toBe(first);
    expect(f.projection.world.get(f.entity(other), MeshRenderer).unwrap().materials[0]).toBe(
      handle(),
    );
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((change) => change.handle),
    ).toEqual([first]);
    expect(f.assets.read(first).unwrap().values?.baseColor).toEqual([0, 1, 0, 1]);
    expect(fixed.read<MaterialAsset>(first).unwrap()).toEqual(original);
    expect(fixed.matchesCurrent()).toBe(false);
    fixed.dispose();
    changes.dispose();
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
    const materialHandle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    const assetChanges = f.assets.observe().unwrap();
    f.material.color.set(0x112233);
    f.camera.fov = 35;
    f.camera.updateProjectionMatrix();
    light.color.set(0xff0000);
    f.sync();
    const changes = queries.map((query) => [...query].map((row) => row.entity));
    expect(changes[4]).toEqual([]);
    expect(changes[5]).toEqual([camera]);
    expect(changes[8]).toHaveLength(1);
    expect(
      assetChanges
        .read()
        .unwrap()
        .changes.map((change) => change.handle),
    ).toEqual([materialHandle]);
    assetChanges.dispose();
    f.sync();
    expect(queries.map((query) => [...query].length)).toEqual(queries.map(() => 0));
  });

  it('keeps admitted resources and entities intact when native material preparation fails', {
    timeout: 30000,
  }, async () => {
    const assets = new AssetRegistry();
    const prepare = await prepareMaterialPrograms(assets);
    const programAssets = runtimeAssets(assets).inspect().assets;
    const f = fixture(assets, new MeshStandardMaterial({ color: 0xff8040 }), prepare);
    f.mesh.frustumCulled = false;
    const pixels = new Uint8Array([255, 0, 0, 255]);
    const texture = new DataTexture(pixels, 1, 1);
    texture.needsUpdate = true;
    f.material.map = texture;
    f.sync();
    const live = runtimeAssets(f.assets).inspect().assets;
    const handle = () => {
      const value = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
      if (value === undefined) throw new Error('missing managed material');
      return value;
    };
    const original = handle();
    const accepted = f.assets.read(original).unwrap();
    const fixed = f.assets.snapshot(original).unwrap();
    const binding = accepted.values?.baseColorTexture as MaterialTextureValue;
    const textureHandle = binding.texture;
    if (typeof textureHandle !== 'number') throw new Error('missing managed texture');
    const samplerHandle = binding.sampler;
    if (typeof samplerHandle !== 'number') throw new Error('missing managed sampler');
    const currentTexture = () => {
      const payload = f.assets.read(textureHandle).unwrap();
      if (payload.kind !== 'texture') throw new Error('expected static texture');
      return payload.data;
    };
    const observer = assets.observe().unwrap();
    pixels.set([0, 255, 0, 255]);
    texture.wrapS = RepeatWrapping;
    texture.needsUpdate = true;
    f.material.color.set(0x00ff00);
    const material = new MeshPhysicalMaterial({ ior: 0, map: texture });
    const rejected = new Mesh(f.mesh.geometry, material);
    f.scene.add(rejected);
    f.mesh.position.x = 99;
    for (let i = 0; i < 3; i++) {
      expect(f.sync).toThrow(/ior/);
      expect(handle()).toBe(original);
      expect(f.assets.read(original).unwrap()).toEqual(accepted);
      expect(currentTexture()).toEqual(new Uint8Array([255, 0, 0, 255]));
      expect(f.assets.read(samplerHandle).unwrap().addressModeU).toBe('clamp-to-edge');
      expect(runtimeAssets(f.assets).inspect().assets).toBe(live);
      expect(observer.read().unwrap().changes).toEqual([]);
      expect(fixed.matchesCurrent()).toBe(true);
      expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(0);
      expect(f.projection.sources().some((source) => source.uuid === rejected.uuid)).toBe(false);
    }
    material.ior = 1.5;
    f.sync();
    expect(handle()).toBe(original);
    expect(f.assets.read(original).unwrap().values?.baseColor).toEqual([0, 1, 0, 1]);
    expect(currentTexture()).toEqual(new Uint8Array([0, 255, 0, 255]));
    expect(f.assets.read(samplerHandle).unwrap().addressModeU).toBe('repeat');
    expect(f.assets.read(original).unwrap().values?.baseColorTexture).toEqual(binding);
    expect(fixed.read<SamplerAsset>(samplerHandle).unwrap().addressModeU).toBe('clamp-to-edge');
    expect(fixed.matchesCurrent()).toBe(false);
    expect(fixed.read<MaterialAsset>(original).unwrap()).toEqual(accepted);
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(99);
    expect(f.projection.sources().some((source) => source.uuid === rejected.uuid)).toBe(true);
    fixed.dispose();
    observer.dispose();
    f.projection.dispose();
    expect(runtimeAssets(f.assets).inspect().assets).toBe(programAssets);
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

  it('selects visible groups, skips missing/unused slots and drops trailing triangle elements', () => {
    const f = fixture();
    const hidden = new ShaderMaterial();
    hidden.visible = false;
    const unused = new ShaderMaterial();
    f.mesh.geometry.clearGroups();
    f.mesh.geometry.addGroup(0, 5, 300);
    f.mesh.geometry.addGroup(6, 6, 1);
    f.mesh.geometry.addGroup(12, 6, 2);
    const materials: import('three/src/Three.Core.js').Material[] = [];
    materials[0] = unused;
    materials[1] = hidden;
    materials[300] = f.material;
    f.mesh.material = materials;
    f.sync();
    const native = f.assets
      .read(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle)
      .unwrap() as MeshAsset;
    expect(native.submeshes).toHaveLength(1);
    expect(native.submeshes[0]).toMatchObject({ indexOffset: 0, indexCount: 3, materialSlot: 0 });
    expect(Array.from(native.indices ?? [])).toEqual(
      Array.from(f.mesh.geometry.index?.array ?? []).slice(0, 3),
    );
    expect(f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials).toHaveLength(1);
    f.mesh.geometry.setDrawRange(6, 6);
    f.sync();
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(0);
    hidden.dispose();
    unused.dispose();
  });

  it('keeps colored and neutral projections of shared vertices independent across groups and source edits', () => {
    const f = fixture();
    const geometry = f.mesh.geometry;
    const count = geometry.getAttribute('position').count;
    const colors = new Float32BufferAttribute(new Float32Array(count * 3).fill(0.25), 3);
    geometry.setAttribute('color', colors);
    const colored = new MeshBasicMaterial({ vertexColors: true });
    const other = new Mesh(geometry, colored);
    f.scene.add(other);
    const meshData = (mesh: Mesh) =>
      f.assets
        .read(f.projection.world.get(f.entity(mesh), MeshFilter).unwrap().assetHandle)
        .unwrap() as MeshAsset;
    f.sync();
    expect(meshData(f.mesh).attributes.color).toBeUndefined();
    expect(meshData(other).attributes.color?.[0]).toBe(0.25);
    f.mesh.material = [colored, f.material];
    geometry.clearGroups();
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(0, 3, 1);
    f.sync();
    const projected = meshData(f.mesh);
    expect(projected.attributes.color?.length).toBe(count * 8);
    expect(projected.attributes.color?.[count * 4]).toBe(1);
    expect(projected.indices?.[3]).toBe((projected.indices?.[0] ?? 0) + count);
    colors.setX(0, 0.75);
    colors.needsUpdate = true;
    f.sync();
    expect(meshData(other).attributes.color?.[0]).toBe(0.75);
    expect(meshData(f.mesh).attributes.color?.[0]).toBe(0.75);
    expect(geometry.getAttribute('position').count).toBe(count);
    geometry.deleteAttribute('color');
    f.sync();
    expect(meshData(other).attributes.color).toBeUndefined();
    colored.dispose();
  });

  it('updates automatic LOD before admission and leaves manual selections alone', () => {
    const f = fixture();
    const lod = new LOD();
    const far = new Mesh(f.mesh.geometry, new ShaderMaterial());
    f.scene.remove(f.mesh);
    lod.addLevel(f.mesh, 0);
    lod.addLevel(far, 20);
    f.scene.add(lod);
    f.sync();
    expect(far.visible).toBe(false);
    f.camera.position.z = 30;
    expect(f.sync).toThrow('three-migration-required');
    far.layers.set(1);
    f.sync();
    lod.autoUpdate = false;
    far.visible = false;
    f.mesh.visible = true;
    f.sync();
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).not.toBe(0);
    (far.material as ShaderMaterial).dispose();
  });

  it('ignores invalid inputs that do not participate in the current view', () => {
    const f = fixture();
    const excluded = new Mesh(new BoxGeometry(), new ShaderMaterial());
    excluded.layers.set(1);
    excluded.position.x = Number.NaN;
    excluded.frustumCulled = false;
    f.scene.add(excluded);
    expect(f.sync).not.toThrow();
    excluded.layers.set(0);
    excluded.visible = false;
    expect(f.sync).not.toThrow();
    excluded.geometry.dispose();
    (excluded.material as ShaderMaterial).dispose();
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
    const handle = () => {
      const value = f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
      if (value === 0) throw new Error('missing geometry');
      return value;
    };
    const first = handle();
    const fixed = f.assets.snapshot(first).unwrap();
    const original = fixed.read<MeshAsset>(first).unwrap();
    const changes = f.assets.observe().unwrap();
    f.mesh.geometry.getAttribute('position').setX(0, 2);
    f.sync();
    expect(handle()).toBe(first);
    expect(changes.read().unwrap().changes).toEqual([]);
    f.mesh.geometry.getAttribute('position').needsUpdate = true;
    f.sync();
    expect(handle()).toBe(first);
    expect(f.assets.read(first).unwrap()).not.toEqual(original);
    expect(fixed.read<MeshAsset>(first).unwrap()).toEqual(original);
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((change) => change.handle),
    ).toEqual([first]);
    const updated = handle();
    f.mesh.geometry.dispose();
    f.sync();
    expect(handle()).not.toBe(updated);
    expect(f.assets.validate(updated).ok).toBe(false);
    fixed.dispose();
    changes.dispose();
  });

  it('updates per-slot UV channels without replacing the shared image or sampler', () => {
    const f = fixture();
    const texture = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    f.material.map = texture;
    f.mesh.geometry.setAttribute('uv2', f.mesh.geometry.getAttribute('uv').clone());
    const binding = () => {
      const handle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
      if (handle === undefined) throw new Error('missing material');
      const material = f.assets.read(handle).unwrap();
      return material.values?.baseColorTexture as MaterialTextureValue;
    };
    f.sync();
    const first = binding();
    const live = runtimeAssets(f.assets).inspect().assets;
    texture.channel = 2;
    f.material.needsUpdate = true;
    f.sync();
    expect(binding().coordinates?.set).toBe(2);
    expect(binding().texture).toBe(first.texture);
    expect(binding().sampler).toBe(first.sampler);
    texture.offset.set(0.25, -0.125);
    texture.repeat.set(2, 3);
    texture.center.set(0.5, 0.25);
    // Coordinate edits are uniforms; neither needsUpdate nor new image bytes are required.
    f.sync();
    expect(binding().coordinates?.transform).toEqual({
      offset: [-0.25, -0.625],
      scale: [2, 3],
      rotation: 0,
    });
    expect(binding().texture).toBe(first.texture);
    expect(binding().sampler).toBe(first.sampler);
    const accepted = binding();
    texture.rotation = 0.4;
    f.sync();
    expect(binding().coordinates?.set).not.toBe(2);
    expect(binding().texture).toBe(accepted.texture);
    expect(binding().sampler).toBe(accepted.sampler);
    texture.rotation = 0;
    for (let i = 0; i < 5; i++) f.sync();
    expect(runtimeAssets(f.assets).inspect().assets).toBe(live);
    texture.channel = 0;
    f.material.needsUpdate = true;
    f.sync();
    expect(binding().coordinates?.set ?? 0).toBe(0);
  });

  it('keeps pending textures renderable and uploads only explicitly published image versions', () => {
    const f = fixture();
    const texture = new Texture();
    f.material.map = texture;
    const uploaded = () => {
      const material = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
      if (material === undefined) throw new Error('missing material');
      const binding = f.assets.read(material).unwrap().values
        ?.baseColorTexture as MaterialTextureValue;
      if (typeof binding.texture !== 'number') throw new Error('missing texture');
      return f.assets.read(binding.texture).unwrap() as TextureAsset;
    };
    f.sync();
    expect(uploaded().shape.extent).toEqual({ width: 1, height: 1 });
    expect(uploaded().data).toEqual(new Uint8Array(4));
    const red = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
    texture.image = red;
    f.sync();
    expect(uploaded().data).toEqual(new Uint8Array(4));
    texture.needsUpdate = true;
    f.sync();
    expect(uploaded().data).toEqual(red.data);
    const green = { width: 1, height: 1, data: new Uint8Array([0, 255, 0, 255]) };
    texture.image = green;
    f.sync();
    expect(uploaded().data).toEqual(red.data);
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    f.sync();
    expect(uploaded().data).toEqual(red.data);
    texture.source.dataReady = true;
    f.sync();
    expect(uploaded().data).toEqual(red.data);
    texture.needsUpdate = true;
    f.sync();
    expect(uploaded().data).toEqual(green.data);
    texture.dispose();
    f.sync();
    expect(uploaded().data).toEqual(green.data);
    texture.image = { width: 0, height: 1, data: new Uint8Array(4) };
    texture.needsUpdate = true;
    expect(() => f.sync()).toThrow('Texture image extent');
    expect(uploaded().data).toEqual(green.data);
  });

  it('keeps texture dependencies alive when an unchanged material cache hits', () => {
    const f = fixture();
    const pixels = new Uint8Array([255, 0, 0, 255]);
    const texture = new DataTexture(pixels, 1, 1);
    texture.needsUpdate = true;
    f.material.map = texture;
    f.sync();
    const material = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    if (material === undefined) throw new Error('missing material');
    const binding = f.assets.read(material).unwrap().values
      ?.baseColorTexture as MaterialTextureValue;
    if (
      !('texture' in binding) ||
      typeof binding.texture !== 'number' ||
      binding.sampler === undefined ||
      typeof binding.sampler !== 'number'
    )
      throw new Error('missing managed texture binding');
    const fixed = f.assets.snapshot(material).unwrap();
    const changes = f.assets.observe().unwrap();
    for (let i = 0; i < 20; i++) f.sync();
    expect(changes.read().unwrap().changes).toEqual([]);
    expect(f.assets.validate(binding.texture).ok).toBe(true);
    expect(f.assets.validate(binding.sampler).ok).toBe(true);
    pixels[0] = 0;
    texture.needsUpdate = true;
    f.sync();
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((change) => change.handle),
    ).toEqual([binding.texture]);
    expect(f.assets.read(material).unwrap().values?.baseColorTexture).toEqual(binding);
    const current = f.assets.read(binding.texture).unwrap();
    if (current.kind !== 'texture') throw new Error('expected static texture');
    expect(current.data).toEqual(new Uint8Array([0, 0, 0, 255]));
    expect(fixed.read<TextureAsset>(binding.texture).unwrap().data).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );
    f.projection.dispose();
    expect(f.assets.validate(material).ok).toBe(false);
    expect(f.assets.validate(binding.texture).ok).toBe(false);
    expect(f.assets.validate(binding.sampler).ok).toBe(false);
    expect(fixed.read<TextureAsset>(binding.texture).unwrap().data).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );
    fixed.dispose();
    changes.dispose();
  });

  it('ignores the WebGL compile hook as r184 WebGPU does', () => {
    const f = fixture();
    const material = new MeshStandardMaterial();
    f.mesh.material = material;
    expect(f.sync).not.toThrow();
    material.onBeforeCompile = () => {};
    expect(f.sync).not.toThrow();
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
