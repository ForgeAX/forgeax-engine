import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { readArrayRangesChangedSince, readMutationEpoch } from '@forgeax/engine-ecs/projection';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import {
  Instances,
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
import { ChildOf, GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import { Skin, skinVertexPosition } from '@forgeax/engine-skinning';
import type {
  MaterialAsset,
  MaterialTextureValue,
  MeshAsset,
  SamplerAsset,
  SkeletonAsset,
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
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SpotLight,
  Texture,
  WebGPUCoordinateSystem,
} from 'three/src/Three.Core.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { cameraData } from '../camera';
import * as sourceGeometry from '../geometry';
import { lineStyle } from '../lines';
import * as materialProjection from '../material';
import { prepareMaterialPrograms } from '../material-programs';
import { SceneProjection } from '../scene';
import { SharedAssets } from '../shared-assets';
import { setThreeSceneTracking } from '../source-changes';
import { MeshUvs } from '../uv-projection';
import { featureCases } from './features.fixture';

it('shares empty UV plans and observes a texture added after an untextured frame', () => {
  const geometry = new BoxGeometry();
  const cached = new MeshUvs();
  const empty = cached.read(geometry, [], []);
  expect(new MeshUvs().read(geometry, [], [0])).toBe(empty);
  const texture = new Texture();
  const mapped = cached.read(geometry, [texture], []);
  expect(mapped.coordinates.get(texture)?.set).toBe(0);
  expect(cached.read(geometry, [], [])).toBe(empty);
  texture.channel = 1;
  expect(cached.read(geometry, [texture], []).coordinates.get(texture)?.set).toBe(1);
  geometry.dispose();
  texture.dispose();
});

it('retains affine UV preparation and rechecks in-place edits and channel presence', () => {
  const geometry = new BoxGeometry();
  geometry.deleteAttribute('uv');
  const texture = new Texture();
  const cached = new MeshUvs();
  const initial = cached.read(geometry, [texture], []);
  expect(initial.attributes.uv).toHaveLength(geometry.getAttribute('position').count * 2);
  expect(cached.read(geometry, [texture], [])).toBe(initial);
  texture.offset.x = 0.25;
  const moved = cached.read(geometry, [texture], []);
  expect(moved.coordinates.get(texture)?.transform?.offset).toEqual([0.25, 0]);
  const missingUv = initial.attributes.uv;
  if (missingUv === undefined) throw new Error('expected a missing-channel stream');
  geometry.setAttribute('uv', new Float32BufferAttribute(missingUv, 2));
  expect(cached.read(geometry, [texture], []).attributes.uv).toBeUndefined();
  texture.matrixAutoUpdate = false;
  texture.matrix.elements[2] = 0.5;
  expect(() => cached.read(geometry, [texture], [])).toThrow('requires affine');
  geometry.dispose();
  texture.dispose();
});

it('retains baked UV bytes until the source UV revision changes', () => {
  const geometry = new BoxGeometry();
  const uv = geometry.getAttribute('uv');
  const texture = new Texture();
  texture.matrixAutoUpdate = false;
  texture.matrix.elements[3] = 0.4;
  const cache = new MeshUvs();
  try {
    const first = cache.read(geometry, [texture], []);
    expect(first.values.length).toBeGreaterThan(0);
    expect(cache.read(geometry, [texture], [])).toBe(first);
    uv.setX(0, uv.getX(0) + 0.5);
    uv.needsUpdate = true;
    const next = cache.read(geometry, [texture], []);
    expect(next.attributes).not.toEqual(first.attributes);
    expect(cache.read(geometry, [texture], [])).toBe(next);
  } finally {
    geometry.dispose();
    texture.dispose();
  }
});

it('keeps affine dashed-line admission exact after runtime mesh adoption', () => {
  const positions = Float32Array.of(0, 0, 0, 3, 4, 0, 3, 4, 12);
  const geometry = new ThreeCore.BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute(positions, 3),
  );
  const material = new ThreeCore.LineDashedMaterial({ scale: 2, dashSize: 4, gapSize: 2 });
  const line = new ThreeCore.Line(geometry, material);
  line.computeLineDistances();
  const author: MeshAsset = {
    kind: 'mesh',
    vertices: positions,
    attributes: { position: positions },
    indices: Uint16Array.of(0, 1, 2),
    materialSlots: [{ slotName: 'line' }],
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'line-strip' },
    ],
  };
  const assets = new AssetRegistry();
  try {
    const handle = assets.create(author).unwrap(),
      packed = assets.read(handle).unwrap();
    expect(packed.attributes.position).toHaveLength(0);
    expect(lineStyle(line, author, [material])).toEqual({ dashSize: 2, gapSize: 1, dashOffset: 0 });
    expect(lineStyle(line, packed, [material])).toEqual(lineStyle(line, author, [material]));
    geometry.getAttribute('lineDistance').setX(2, 18);
    expect(() => lineStyle(line, packed, [material])).toThrow('arbitrary endpoint distances');
  } finally {
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});

describe('Three source to native World', () => {
  const featureAssets = new AssetRegistry();
  let featureProjection: SceneProjection | undefined;
  beforeAll(() => {
    installDefaultAssetDecoders(featureAssets);
  });
  afterAll(() => {
    featureProjection?.dispose();
    featureAssets.dispose();
  });
  it.each(Object.entries(featureCases({ ...ThreeCore, ClippingGroup })))(
    'keeps %s geometry valid across the same source edits used by the GPU oracle',
    { timeout: 120000 },
    async (name, populate) => {
      const assets = featureAssets;
      // Cooked program admission belongs to the existing bounded async case.
      featureProjection ??= new SceneProjection(
        featureAssets,
        undefined,
        await prepareMaterialPrograms(featureAssets),
      );
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
          const position = copyMeshAttribute(mesh, 'position') as Float32Array;
          expect(position.length).toBeGreaterThan(0);
          expect(Array.from(position).every(Number.isFinite)).toBe(true);
          if (name === 'skin-lit') {
            const authored = scene.getObjectByProperty('uuid', source.uuid);
            if (authored instanceof ThreeCore.SkinnedMesh) {
              const skin = projection.world.get(source.entityKey as EntityHandle, Skin).unwrap();
              expect(skin.affinePoint).toBe(true);
              expect(mesh.attributes.skinWeight).toBeInstanceOf(
                phase === 'initial' ? Uint8Array : Float32Array,
              );
              const skeleton = runtimeAssets(assets).borrow<SkeletonAsset>(skin.skeleton).unwrap();
              const palette = new Float32Array(skeleton.jointCount * 16);
              for (const [j, entity] of skin.joints.entries()) {
                const joint = projection.world
                  .get(entity as EntityHandle, GlobalTransform)
                  .unwrap().world;
                new ThreeCore.Matrix4()
                  .fromArray(joint)
                  .multiply(new ThreeCore.Matrix4().fromArray(skeleton.inverseBindMatrices, j * 16))
                  .toArray(palette, j * 16);
              }
              const indices = copyMeshAttribute(mesh, 'skinIndex') as Uint16Array;
              const weights = copyMeshAttribute(mesh, 'skinWeight') as Float32Array;
              const point = new Float64Array(4);
              const sourcePalette = authored.skeleton.bones.map((bone, joint) =>
                bone.matrixWorld
                  .clone()
                  .multiply(authored.skeleton.boneInverses[joint] as ThreeCore.Matrix4),
              );
              const sourcePosition = authored.geometry.getAttribute('position');
              const sourceIndices = authored.geometry.getAttribute('skinIndex');
              const sourceWeights = authored.geometry.getAttribute('skinWeight');
              const inBind = new ThreeCore.Vector4(),
                contribution = new ThreeCore.Vector4();
              const blended = new ThreeCore.Vector4(),
                vertex = new ThreeCore.Vector3();
              for (let index = 0; index < position.length / 3; index++) {
                // The r187 GPU shader drops w after inverse bind. The stock
                // getVertexPosition instead passes a Vector3 through inverse bind.
                inBind
                  .set(
                    sourcePosition.getX(index),
                    sourcePosition.getY(index),
                    sourcePosition.getZ(index),
                    1,
                  )
                  .applyMatrix4(authored.bindMatrix);
                blended.set(0, 0, 0, 0);
                for (let lane = 0; lane < 4; lane++) {
                  const joint = sourceIndices.getComponent(index, lane);
                  contribution.copy(inBind).applyMatrix4(sourcePalette[joint] as ThreeCore.Matrix4);
                  blended.addScaledVector(contribution, sourceWeights.getComponent(index, lane));
                }
                blended.applyMatrix4(authored.bindMatrixInverse);
                vertex.set(blended.x, blended.y, blended.z).applyMatrix4(authored.matrixWorld);
                expect(
                  skinVertexPosition(
                    point,
                    position,
                    indices,
                    weights,
                    palette,
                    index,
                    authored.matrixWorld.elements,
                  ),
                ).toBe(true);
                expect(point[3]).toBe(1);
                expect(point[0]).toBeCloseTo(vertex.x, 6);
                expect(point[1]).toBeCloseTo(vertex.y, 6);
                expect(point[2]).toBeCloseTo(vertex.z, 6);
              }
            }
          }
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
    const entity = (source: ThreeCore.Object3D = mesh) => {
      const match = projection.sources().find((row) => row.uuid === source.uuid);
      if (match === undefined) throw new Error('missing source');
      return match.entityKey as Parameters<typeof projection.world.get>[0];
    };
    return { projection, assets, scene, camera, material, mesh, sync, entity };
  }

  it('keeps current draw plans attached to their sources across replacement and reordered admission', () => {
    const f = fixture();
    const secondMaterial = new MeshBasicMaterial({ color: 0x00ff00 });
    const second: Mesh = new Mesh(f.mesh.geometry, secondMaterial);
    const third = new Mesh(f.mesh.geometry, f.material);
    const color = (mesh: Mesh) => {
      const handle = f.projection.world.get(f.entity(mesh), MeshRenderer).unwrap().materials[0];
      if (handle === undefined) throw new Error('missing projected draw material');
      return f.assets.read(handle).unwrap().values?.baseColor;
    };
    try {
      f.scene.add(second);
      f.sync();
      expect(color(second)).toEqual([0, 1, 0, 1]);
      const orange = color(f.mesh);
      f.scene.remove(f.mesh, second);
      f.scene.add(third, second);
      second.material = f.material;
      third.material = secondMaterial;
      f.sync();
      expect(color(second)).toEqual(orange);
      expect(color(third)).toEqual([0, 1, 0, 1]);
      f.scene.remove(third);
      f.scene.add(f.mesh);
      f.mesh.material = secondMaterial;
      f.sync();
      expect(color(f.mesh)).toEqual([0, 1, 0, 1]);
      expect(color(second)).toEqual(orange);
      expect(f.projection.sources().some((row) => row.uuid === third.uuid)).toBe(false);
    } finally {
      secondMaterial.dispose();
    }
  });

  it('releases only its own working collections when a texture callback opens a competing scene', () => {
    const f = fixture();
    const texture = new DataTexture(Uint8Array.of(20, 40, 60, 255), 1, 1);
    texture.needsUpdate = true;
    const image = texture.image;
    let observed = false;
    Object.defineProperty(texture, 'image', {
      configurable: true,
      get() {
        if (!observed) {
          observed = true;
          expect(f.sync).toThrow('resource preparation is already active');
        }
        return image;
      },
    });
    try {
      const prepared = f.projection.prepareTexture(texture);
      expect(observed).toBe(true);
      expect(f.assets.validate(prepared.handle).ok).toBe(true);
      f.material.map = texture;
      for (let frame = 0; frame < 60; frame++) {
        f.mesh.position.x = frame / 120;
        f.material.transparent = frame % 2 === 0;
        f.material.map = frame % 3 === 0 ? null : texture;
        f.sync();
        const handle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
        if (handle === undefined) throw new Error('missing changing draw material');
        const material = f.assets.read(handle).unwrap();
        expect(material.values?.baseColorTexture !== undefined).toBe(f.material.map !== null);
      }
    } finally {
      texture.dispose();
    }
  });

  it('publishes a shared in-place RGB edit through one numeric asset update', () => {
    const f = fixture();
    const texture = new DataTexture(Uint8Array.of(128, 192, 255, 255), 1, 1);
    texture.needsUpdate = true;
    f.material.map = texture;
    const shared = new Mesh(f.mesh.geometry, f.material);
    shared.position.x = 1;
    f.scene.add(shared);
    f.sync();
    const handle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    if (handle === undefined) throw new Error('missing material');
    const fixed = f.assets.snapshot(handle).unwrap();
    const previous = fixed.read<MaterialAsset>(handle).unwrap();
    const patch = vi.spyOn(f.assets, 'update');
    const replace = vi.spyOn(f.assets, 'replace');
    const reads = vi.spyOn(SharedAssets.prototype, 'read');
    try {
      const alias = f.material.color;
      alias.r = 0.25;
      alias.g = 0.5;
      f.sync();
      expect(reads.mock.calls.filter(([source]) => source === f.material)).toHaveLength(1);
      expect(patch).toHaveBeenCalledExactlyOnceWith(handle, {
        values: { baseColor: [0.25, 0.5, alias.b, f.material.opacity] },
      });
      expect(replace).not.toHaveBeenCalled();
      expect(f.assets.read(handle).unwrap().passes).toEqual(previous.passes);
      expect(f.assets.read(handle).unwrap().values?.baseColorTexture).toEqual(
        previous.values?.baseColorTexture,
      );
      expect(fixed.read<MaterialAsset>(handle).unwrap().values).toEqual(previous.values);
      expect(f.projection.world.get(f.entity(shared), MeshRenderer).unwrap().materials).toEqual(
        Uint32Array.of(handle),
      );
      f.sync();
      expect(patch).toHaveBeenCalledTimes(1);

      f.material.transparent = true;
      f.sync();
      expect(patch).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledTimes(1);
    } finally {
      patch.mockRestore();
      replace.mockRestore();
      reads.mockRestore();
      fixed.dispose();
      texture.dispose();
    }
  });

  it('patches stock numeric surface values while retaining the program and bindings', () => {
    const material = new MeshStandardMaterial({ transparent: true });
    const f = fixture(new AssetRegistry(), material);
    f.sync();
    const handle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    if (handle === undefined) throw new Error('missing material');
    const passes = f.assets.read(handle).unwrap().passes;
    const patch = vi.spyOn(f.assets, 'update');
    try {
      material.opacity = 0.75;
      material.roughness = 0.2;
      material.emissive.setRGB(0.125, 0.25, 0.5);
      material.emissiveIntensity = 2;
      material.metalness = 0.6;
      f.sync();
      expect(patch).toHaveBeenCalledExactlyOnceWith(handle, {
        values: {
          baseColor: [1, 1, 1, 0.75],
          roughness: 0.2,
          emissive: [0.125, 0.25, 0.5],
          emissiveIntensity: 2,
          metallic: 0.6,
        },
      });
      expect(f.assets.read(handle).unwrap().passes).toEqual(passes);
    } finally {
      patch.mockRestore();
    }
  });

  it('qualifies a shared stock material once per sync across distinct geometries', () => {
    const f = fixture();
    const peer = new Mesh(new BoxGeometry(), f.material);
    peer.position.x = 1;
    f.scene.add(peer);
    f.sync();
    const inspect = vi.spyOn(Reflect, 'ownKeys');
    try {
      f.sync();
      const checks = () => inspect.mock.calls.filter(([value]) => value === f.material).length;
      expect(checks()).toBe(1);
      inspect.mockClear();
      f.sync();
      expect(checks()).toBe(1);
    } finally {
      inspect.mockRestore();
    }
  });

  it('admits one untextured stock material use across distinct warm geometries', () => {
    const f = fixture();
    const peer = new Mesh(new BoxGeometry(2, 2, 2), f.material);
    peer.position.x = 1;
    f.scene.add(peer);
    f.sync();
    const admit = vi.spyOn(
      f.projection as unknown as { admitMaterialUse: () => void },
      'admitMaterialUse',
    );
    try {
      f.material.color.r = 0.25;
      f.sync();
      expect(admit).toHaveBeenCalledTimes(1);
      const world = f.projection.world;
      expect(world.get(f.entity(), MeshFilter).unwrap().assetHandle).not.toBe(
        world.get(f.entity(peer), MeshFilter).unwrap().assetHandle,
      );
      expect(world.get(f.entity(), MeshRenderer).unwrap().materials).toEqual(
        world.get(f.entity(peer), MeshRenderer).unwrap().materials,
      );

      const map = new DataTexture(Uint8Array.of(255, 255, 255, 255), 1, 1);
      map.needsUpdate = true;
      f.material.map = map;
      admit.mockClear();
      f.sync();
      expect(admit).toHaveBeenCalledTimes(2);
      const handle = world.get(f.entity(peer), MeshRenderer).unwrap().materials[0];
      if (handle === undefined) throw new Error('missing material');
      expect(f.assets.read(handle).unwrap().values?.baseColorTexture).toBeDefined();
      map.dispose();
    } finally {
      admit.mockRestore();
    }
  });

  it('prepares a shared mesh use once and invalidates only when a UV stream is needed', () => {
    const f = fixture();
    const geometry = f.mesh.geometry;
    const peer = new Mesh(geometry, f.material);
    f.scene.add(peer);
    f.sync();
    const handle = () => f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    const initial = handle();
    const observe = vi.spyOn(sourceGeometry, 'geometryValues');
    const prepare = vi.spyOn(sourceGeometry, 'projectGeometry');
    const prepareUv = vi.spyOn(MeshUvs.prototype, 'read');
    const leases = vi.spyOn(SharedAssets.prototype, 'read');
    const publish = vi.spyOn(SharedAssets.prototype, 'write');
    try {
      f.camera.position.x = 0.25;
      f.material.color.r = 0.8;
      f.sync();
      expect(observe).toHaveBeenCalledExactlyOnceWith(geometry, false);
      expect(leases.mock.calls.filter(([source]) => source === geometry)).toHaveLength(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(prepareUv).not.toHaveBeenCalled();
      expect(handle()).toBe(initial);

      const texture = new DataTexture(Uint8Array.of(255, 255, 255, 255), 1, 1);
      texture.channel = 1;
      texture.needsUpdate = true;
      f.material.map = texture;
      f.sync();
      const generated = handle();
      expect(publish.mock.calls.filter(([source]) => source === geometry)).toHaveLength(1);
      if (generated === 0) throw new Error('missing generated UV stream');
      expect(generated).not.toBe(initial);
      expect(copyMeshAttribute(f.assets.read(generated).unwrap(), 'uv1')).toEqual(
        new Float32Array(geometry.getAttribute('position').count * 2),
      );
      texture.offset.x = 0.25;
      f.sync();
      expect(handle()).toBe(generated);
      expect(prepare).toHaveBeenCalledOnce();

      geometry.setDrawRange(0, 3);
      f.sync();
      expect(f.assets.read(generated).unwrap().submeshes[0]?.indexCount).toBe(3);
      expect(prepare).toHaveBeenCalledTimes(2);
      geometry.dispose();
      f.sync();
      expect(handle()).not.toBe(generated);
      expect(prepare).toHaveBeenCalledTimes(3);
      texture.dispose();
    } finally {
      observe.mockRestore();
      prepare.mockRestore();
      prepareUv.mockRestore();
      leases.mockRestore();
      publish.mockRestore();
    }
  });

  it('observes a stock override and its inherited coverage once across material slots', () => {
    const f = fixture();
    const override = new MeshBasicMaterial();
    const grouped = new Mesh(f.mesh.geometry, Array<ThreeCore.Material>(6).fill(f.material));
    f.scene.add(grouped);
    f.scene.overrideMaterial = override;
    const validate = vi.spyOn(materialProjection, 'validateMaterial');
    try {
      f.sync();
      expect(validate).toHaveBeenCalledTimes(1);
      const handle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
      if (handle === undefined) throw new Error('missing override material');
      f.material.alphaTest = 0.25;
      f.sync();
      expect(validate).toHaveBeenCalledTimes(2);
      expect(f.assets.read(handle).unwrap().values?.alphaCutoff).toBe(0.25);

      const opacity = vi.fn(() => 0.75);
      Object.defineProperty(override, 'opacity', { get: opacity, configurable: true });
      validate.mockClear();
      f.sync();
      expect(validate).toHaveBeenCalledTimes(7);
      expect(opacity.mock.calls.length).toBeGreaterThan(7);
    } finally {
      validate.mockRestore();
      override.dispose();
    }
  });

  it('renews a resident geometry lease disposed during material preparation', () => {
    let disposeGeometry: (() => void) | undefined;
    const f = fixture(new AssetRegistry(), new MeshBasicMaterial(), (asset) => {
      disposeGeometry?.();
      return asset;
    });
    const geometryHandle = () =>
      f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    f.sync();
    const previous = geometryHandle();
    disposeGeometry = () => f.mesh.geometry.dispose();
    f.material.transparent = true;
    f.sync();
    expect(geometryHandle()).not.toBe(previous);
    expect(f.assets.validate(geometryHandle()).ok).toBe(true);
  });

  it('observes public index layout edits on resident geometry independently of byte versions', () => {
    const f = fixture();
    const index = f.mesh.geometry.getIndex();
    if (index === null) throw new Error('expected indexed geometry');
    f.sync();
    const handle = f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    if (handle === 0) throw new Error('missing resident geometry');
    expect(f.assets.read(handle).unwrap().submeshes[0]?.indexCount).toBe(36);
    expect(Reflect.set(index, 'count', 3)).toBe(true);
    f.sync();
    expect(f.assets.read(handle).unwrap().submeshes[0]?.indexCount).toBe(3);
    expect(index.version).toBe(0);
  });

  it('publishes an owned revision of a contiguous index window and preserves custom index reads', () => {
    const f = fixture();
    const geometry = f.mesh.geometry;
    const source = new Uint32Array([70000, 0, 1, 2, 3, 4, 5, 70000]);
    const index = new ThreeCore.BufferAttribute(source, 1);
    geometry.setIndex(index);
    geometry.setDrawRange(1, 6);
    f.sync();
    const handle = f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    if (!handle) throw new Error('missing geometry');
    const published = () => f.assets.read(handle).unwrap().indices;
    expect(published()).toEqual(new Uint16Array([0, 1, 2, 3, 4, 5]));
    source[1] = 5;
    f.sync();
    expect(published()?.[0]).toBe(0);
    index.needsUpdate = true;
    f.sync();
    expect(published()?.[0]).toBe(5);
    source[1] = 65536;
    index.needsUpdate = true;
    expect(f.sync).toThrow();
    expect(published()?.[0]).toBe(5);
    index.getX = () => 2;
    index.needsUpdate = true;
    f.sync();
    expect(published()).toEqual(new Uint16Array(6).fill(2));
  });

  it('retains draw assets across camera culling and retires them on source detachment', () => {
    const f = fixture();
    const texture = new DataTexture(Uint8Array.of(255, 128, 0, 255), 1, 1);
    texture.needsUpdate = true;
    f.material.map = texture;
    f.sync();
    const active = () => f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    const activeMaterial = () =>
      f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    const handle = active();
    const material = activeMaterial();
    if (handle === 0 || material === undefined) throw new Error('missing initial draw');
    const binding = f.assets.read(material).unwrap().values
      ?.baseColorTexture as MaterialTextureValue;
    if (
      !('texture' in binding) ||
      typeof binding.texture !== 'number' ||
      typeof binding.sampler !== 'number'
    )
      throw new Error('missing managed binding');
    const drawAssets = [handle, material, binding.texture, binding.sampler];

    f.camera.position.x = 100;
    f.sync();
    expect(active()).toBe(handle);
    expect(activeMaterial()).toBe(material);
    for (const asset of drawAssets) expect(f.assets.validate(asset).ok).toBe(true);
    f.material.color.r = 0.25;
    f.sync();

    f.camera.position.x = 0;
    f.sync();
    expect(active()).toBe(handle);
    expect(activeMaterial()).toBe(material);
    const returned = f.assets.read(material).unwrap();
    expect(returned.values?.baseColor).toEqual([0.25, f.material.color.g, f.material.color.b, 1]);
    expect(returned.values?.baseColorTexture).toEqual(binding);

    f.camera.position.x = 100;
    f.sync();
    f.scene.remove(f.mesh);
    f.sync();
    for (const asset of drawAssets) expect(f.assets.validate(asset).ok).toBe(false);
  });

  it('admits one current material and geometry per visible Mesh across grouping and source replacements', () => {
    const f = fixture();
    const firstGeometry = f.mesh.geometry;
    const secondGeometry = new BoxGeometry(2, 1, 1);
    const secondMaterial = new MeshBasicMaterial({ color: 0x2457a1 });
    const grouped = Array.from({ length: 6 }, () => secondMaterial);
    let geometry = firstGeometry;
    let material: Mesh['material'] = f.material;
    let planning = false;
    let geometryReads = 0;
    let materialReads = 0;
    Object.defineProperty(f.mesh, 'geometry', {
      configurable: true,
      get() {
        if (planning) geometryReads++;
        return geometry;
      },
    });
    Object.defineProperty(f.mesh, 'material', {
      configurable: true,
      get() {
        if (planning) materialReads++;
        return material;
      },
    });
    const projection = f.projection as unknown as { planMesh(...args: unknown[]): void };
    const admit = projection.planMesh;
    const calls = vi.spyOn(projection, 'planMesh').mockImplementation((...args) => {
      planning = true;
      try {
        admit.call(projection, ...args);
      } finally {
        planning = false;
      }
    });
    try {
      for (let frame = 0; frame < 60; frame++) {
        geometry = frame % 2 === 0 ? firstGeometry : secondGeometry;
        material = frame % 3 === 0 ? grouped : f.material;
        f.mesh.rotation.y = frame / 60;
        geometryReads = materialReads = 0;
        f.sync();
        expect([geometryReads, materialReads]).toEqual([1, 1]);
        const draw = f.projection.world.get(f.entity(), MeshRenderer).unwrap();
        expect(draw.materials.length).toBe(Array.isArray(material) ? 6 : 1);
      }
    } finally {
      calls.mockRestore();
      secondGeometry.dispose();
      secondMaterial.dispose();
    }
  });

  it('admits shared Physical surface values and textures once on every changing frame', async () => {
    const assets = new AssetRegistry();
    installDefaultAssetDecoders(assets);
    const physical = new MeshPhysicalMaterial({ clearcoat: 0.4, roughness: 0.8 });
    const f = fixture(assets, physical, await prepareMaterialPrograms(assets));
    const peers = Array.from({ length: 32 }, () => new Mesh(f.mesh.geometry, physical));
    f.scene.remove(f.mesh);
    f.scene.add(...peers);
    const probe = vi.spyOn(materialProjection, 'validateMaterial');
    const textures = vi.spyOn(materialProjection, 'materialTextures');
    const first = peers[0];
    if (!first) throw new Error('missing physical mesh');
    try {
      for (let step = 1; step <= 16; step++) {
        physical.clearcoat = step / 32;
        physical.specularColor.r = step / 16;
        first.rotation.y = step / 10;
        probe.mockClear();
        textures.mockClear();
        f.sync();
        expect(probe).toHaveBeenCalledOnce();
        expect(textures).toHaveBeenCalledOnce();
        const handle = f.projection.world.get(f.entity(first), MeshRenderer).unwrap().materials[0];
        if (handle === undefined) throw new Error('missing physical material');
        const values = f.assets.read(handle).unwrap().values;
        expect(values?.clearcoat).toBe(step / 32);
        expect(values?.specularColor).toEqual([step / 16, 1, 1]);
        for (const peer of peers)
          expect(f.projection.world.get(f.entity(peer), MeshRenderer).unwrap().materials[0]).toBe(
            handle,
          );
      }
    } finally {
      textures.mockRestore();
      probe.mockRestore();
      physical.dispose();
    }
  });

  it('uses per-mesh preparation when a stock material carries an authored accessor', () => {
    const f = fixture();
    Object.defineProperty(f.material, 'opacity', { configurable: true, get: () => 0.5 });
    f.scene.add(new Mesh(f.mesh.geometry, f.material));
    const prepareUv = vi.spyOn(MeshUvs.prototype, 'read');
    try {
      f.sync();
      expect(prepareUv).toHaveBeenCalledTimes(2);
    } finally {
      prepareUv.mockRestore();
    }
  });

  it('keeps a shared texture in each mesh-specific baked UV slot', () => {
    const f = fixture();
    const shear = new DataTexture(Uint8Array.of(255, 255, 255, 255), 1, 1);
    shear.matrixAutoUpdate = false;
    shear.matrix.elements[3] = 0.4;
    shear.needsUpdate = true;
    f.material.map = shear;
    const extra = new MeshBasicMaterial();
    const other = new DataTexture(Uint8Array.of(255, 255, 255, 255), 1, 1);
    other.channel = 1;
    other.needsUpdate = true;
    extra.map = other;
    const grouped = new Mesh(f.mesh.geometry, [f.material, extra]);
    grouped.position.x = 1;
    f.scene.add(grouped);
    f.sync();

    const entry = (source: Mesh) => {
      const handle = f.projection.world.get(f.entity(source), MeshRenderer).unwrap().materials[0];
      if (handle === undefined) throw new Error('missing material');
      return f.assets.read(handle).unwrap().values?.baseColorTexture;
    };
    expect(entry(f.mesh)).toMatchObject({ coordinates: { set: 1 } });
    expect(entry(grouped)).toMatchObject({ coordinates: { set: 2 } });
    f.material.color.r = 0.3;
    f.sync();
    expect(entry(f.mesh)).toMatchObject({ coordinates: { set: 1 } });
    expect(entry(grouped)).toMatchObject({ coordinates: { set: 2 } });
  });

  it('keeps Matcap sphere orientation separate from ordinary alpha UV inputs', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const projection = new SceneProjection(assets);
    owned.push({ projection, assets });
    const pixels = new Uint8Array([255, 10, 20, 255, 30, 200, 40, 255]);
    const image = new DataTexture(pixels, 1, 2);
    image.needsUpdate = true;
    const material = new MeshMatcapMaterial({ matcap: image, alphaMap: image });
    const mesh = new Mesh(new BoxGeometry(), material),
      scene = new Scene();
    scene.add(mesh);
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
    const content = () => {
      const entity = projection.entityFor(mesh);
      if (entity === undefined) throw new Error('missing source mesh');
      const handle = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
      if (handle === undefined) throw new Error('missing source material');
      return runtimeAssets(assets).borrow<MaterialAsset>(handle).unwrap();
    };
    sync();
    const projected = content();
    const alpha = projected.values?.alphaTexture as MaterialTextureValue;
    const matcap = projected.values?.baseColorTexture as MaterialTextureValue;
    if (
      alpha === undefined ||
      matcap === undefined ||
      !('texture' in alpha) ||
      !('texture' in matcap) ||
      typeof alpha.texture !== 'number' ||
      typeof matcap.texture !== 'number'
    )
      throw new Error('missing textures');
    expect(alpha.texture).not.toBe(matcap.texture);
    expect(alpha.sampler).toBe(matcap.sampler);
    expect(runtimeAssets(assets).borrow<TextureAsset>(alpha.texture).unwrap().data).toEqual(pixels);
    expect(runtimeAssets(assets).borrow<TextureAsset>(matcap.texture).unwrap().data).toEqual(
      new Uint8Array([30, 200, 40, 255, 255, 10, 20, 255]),
    );
    const coverage = new DataTexture(pixels, 1, 2);
    coverage.channel = 1;
    coverage.repeat.set(2, 3);
    coverage.offset.set(0.25, 0.125);
    coverage.needsUpdate = true;
    material.alphaMap = coverage;
    mesh.geometry.setAttribute('uv1', mesh.geometry.getAttribute('uv').clone());
    sync();
    expect((content().values?.alphaTexture as MaterialTextureValue).coordinates).toMatchObject({
      set: 1,
      transform: { scale: [2, 3], offset: [0.25, 0.125] },
    });
    material.alphaMap = null;
    sync();
    expect(content().values?.alphaTexture).toBeUndefined();
    expect(assets.validate(matcap.texture).ok).toBe(true);
    expect(assets.validate(alpha.texture).ok).toBe(false);
    mesh.geometry.dispose();
    material.dispose();
    image.dispose();
    coverage.dispose();
  });

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
    const normals = copyMeshAttribute(mesh, 'normal') as Float32Array;
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

  it('strips source camera scale as r187 does and rejects non-rigid view overrides', () => {
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
    f.mesh.matrix.copy(new Matrix4().set(1, 0, 0, 2, 0, 1.5, 0, 1, 0, 0, -2, 0, 0, 0, 0, 1));
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

  it('ignores manual transform shear with one warning and leaves the source matrix intact', () => {
    const f = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    f.mesh.matrixAutoUpdate = false;
    f.mesh.frustumCulled = false;
    try {
      f.mesh.matrix.set(2, 0.5, 0, 1, 0, 3, 0, -2, 0, 0, 4, 0, 0, 0, 0, 1);
      f.sync();
      const expected = new Matrix4().makeScale(2, 3, 4).setPosition(1, -2, 0);
      const read = () => [...f.projection.world.get(f.entity(), GlobalTransform).unwrap().world];
      expect(read()).toEqual(expected.elements);
      expect(f.mesh.matrixWorld.elements[4]).toBe(0.5);

      f.mesh.matrix.elements[4] = 0.75;
      f.mesh.matrixWorldNeedsUpdate = true;
      f.sync();
      expect(read()).toEqual(expected.elements);
      expect(f.mesh.matrixWorld.elements[4]).toBe(0.75);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        '[forgeax/three] Ignoring shear in Object3D.matrixWorld',
        f.mesh.uuid,
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('publishes inherited rotation and scale and recovers when hierarchy shear is removed', () => {
    const f = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const parent = new Group();
    f.scene.add(parent);
    parent.add(f.mesh);
    f.mesh.frustumCulled = false;
    parent.rotation.set(0.2, 0.53, -0.2);
    f.mesh.rotation.set(0.4, 0.6, 0.3);
    const expectWorldMatrix = () => {
      const world = f.projection.world.get(f.entity(), GlobalTransform).unwrap().world;
      f.mesh.matrixWorld.elements.forEach((value, index) => {
        expect(world[index]).toBeCloseTo(value, 5);
      });
    };
    try {
      f.sync();
      expectWorldMatrix();
      parent.scale.setScalar(2);
      f.sync();
      expectWorldMatrix();
      expect(warning).not.toHaveBeenCalled();
      parent.scale.set(2, 3, 4);
      f.sync();
      const world = f.projection.world.get(f.entity(), GlobalTransform).unwrap().world;
      const nativeX = new ThreeCore.Vector3().fromArray(world, 0);
      const nativeY = new ThreeCore.Vector3().fromArray(world, 4);
      const sourceX = new ThreeCore.Vector3().fromArray(f.mesh.matrixWorld.elements, 0);
      const sourceY = new ThreeCore.Vector3().fromArray(f.mesh.matrixWorld.elements, 4);
      expect(nativeX.dot(nativeY)).toBeCloseTo(0, 5);
      expect(Math.abs(sourceX.dot(sourceY))).toBeGreaterThan(0.1);
      expect(warning).toHaveBeenCalledTimes(1);
      f.mesh.rotation.set(0, 0, 0);
      f.sync();
      expectWorldMatrix();
    } finally {
      warning.mockRestore();
    }
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

  it('projects point colors through existing geometry revisions while retaining the line guard', () => {
    const f = fixture();
    f.scene.remove(f.mesh);
    const geometry = f.mesh.geometry;
    const colors = new Float32BufferAttribute(
      new Float32Array(geometry.getAttribute('position').count * 3),
      3,
    );
    for (let i = 0; i < colors.count; i++) colors.setXYZ(i, 1, 0, 0);
    geometry.setAttribute('color', colors);
    const material = new PointsMaterial({ vertexColors: true });
    const points = new Points(geometry, material);
    f.scene.add(points);
    f.sync();
    const source = f.projection.sources().find((s) => s.uuid === points.uuid);
    if (source === undefined) throw Error('missing points');
    const entity = source.entityKey as EntityHandle;
    const meshHandle = () => f.projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    const handle = meshHandle(),
      materialHandle = f.projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    const readColor = () =>
      copyMeshAttribute(
        runtimeAssets(f.assets).borrow<MeshAsset>(handle).unwrap(),
        'color',
      ) as Float32Array;
    expect([...readColor().slice(0, 4)]).toEqual([1, 0, 0, 1]);
    const changes = f.assets.observe().unwrap();
    try {
      for (let i = 0; i < 20; i++) f.sync();
      expect(changes.read().unwrap().changes).toEqual([]);
      colors.setXYZ(0, 0, 1, 0);
      colors.needsUpdate = true;
      f.sync();
      expect(meshHandle()).toBe(handle);
      expect([...readColor().slice(0, 4)]).toEqual([0, 1, 0, 1]);
      expect(f.projection.world.get(entity, MeshRenderer).unwrap().materials[0]).toBe(
        materialHandle,
      );
      material.vertexColors = false;
      f.sync();
      expect(
        copyMeshAttribute(
          runtimeAssets(f.assets).borrow<MeshAsset>(meshHandle()).unwrap(),
          'color',
        ),
      ).toBeUndefined();
      const lineMaterial = new LineBasicMaterial({ vertexColors: true }),
        line = new LineSegments(geometry, lineMaterial);
      f.scene.add(line);
      expect(() => f.sync()).toThrow('Native Lines do not transport per-vertex colors');
      f.scene.remove(line);
      f.sync();
      lineMaterial.dispose();
    } finally {
      changes.dispose();
      material.dispose();
    }
  });

  it('isolates shared-geometry color morph weights and leaves unchanged bytes admitted', () => {
    const f = fixture();
    const count = f.mesh.geometry.getAttribute('position').count;
    f.material.vertexColors = true;
    f.mesh.geometry.setAttribute(
      'color',
      new Float32BufferAttribute(new Float32Array(count * 3).fill(0.2), 3),
    );
    f.mesh.geometry.morphAttributes.color = [
      new Float32BufferAttribute(new Float32Array(count * 3).fill(0.8), 3),
    ];
    f.mesh.updateMorphTargets();
    const other = new Mesh(f.mesh.geometry, f.material);
    if (f.mesh.morphTargetInfluences === undefined || other.morphTargetInfluences === undefined)
      throw new Error('missing color influences');
    other.morphTargetInfluences[0] = 1;
    f.scene.add(other);
    f.sync();
    const handle = (mesh: Mesh) =>
      f.projection.world.get(f.entity(mesh), MeshFilter).unwrap().assetHandle;
    const color = (mesh: Mesh) =>
      copyMeshAttribute(
        runtimeAssets(f.assets).borrow<MeshAsset>(handle(mesh)).unwrap(),
        'color',
      )?.[0];
    expect(handle(f.mesh)).not.toBe(handle(other));
    expect(color(f.mesh)).toBeCloseTo(0.2);
    expect(color(other)).toBeCloseTo(0.8);
    const changes = f.assets.observe().unwrap();
    f.sync();
    expect(changes.read().unwrap().changes).toEqual([]);
    f.mesh.morphTargetInfluences[0] = 0.5;
    f.sync();
    expect(color(f.mesh)).toBeCloseTo(0.5);
    expect(color(other)).toBeCloseTo(0.8);
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((change) => change.handle),
    ).toEqual([handle(f.mesh)]);
    changes.dispose();
  });

  it('shares a scalar source sampler while retaining compact alpha and color variants', () => {
    const f = fixture();
    const source = new DataTexture(new Uint8Array([128]), 1, 1, ThreeCore.RedFormat);
    source.needsUpdate = true;
    f.material.map = f.material.alphaMap = source;
    f.sync();
    const materialHandle = f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    if (materialHandle === undefined) throw new Error('missing material');
    const read = () => runtimeAssets(f.assets).borrow<MaterialAsset>(materialHandle).unwrap();
    const color = read().values?.baseColorTexture as MaterialTextureValue;
    const alpha = read().values?.alphaTexture as MaterialTextureValue;
    expect(color.sampler).toBe(alpha.sampler);
    const colorHandle = color.texture,
      alphaHandle = alpha.texture;
    if (typeof colorHandle !== 'number' || typeof alphaHandle !== 'number')
      throw new Error('missing texture handles');
    expect(colorHandle).not.toBe(alphaHandle);
    expect(runtimeAssets(f.assets).borrow<TextureAsset>(colorHandle).unwrap().format).toBe(
      'rgba8unorm',
    );
    expect(runtimeAssets(f.assets).borrow<TextureAsset>(alphaHandle).unwrap().format).toBe(
      'r8unorm',
    );
    expect(source.format).toBe(ThreeCore.RedFormat);
    const changes = f.assets.observe().unwrap();
    f.sync();
    expect(changes.read().unwrap().changes).toEqual([]);
    f.material.map = null;
    f.sync();
    expect(runtimeAssets(f.assets).borrow<TextureAsset>(alphaHandle).ok).toBe(true);
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

  it('keeps admitted assets intact while publishing poses when material preparation fails', {
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
      expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(99);
      const rejectedEntity = f.projection.entityFor(rejected);
      expect(rejectedEntity).toBeDefined();
      expect(f.projection.world.hasComponent(rejectedEntity as EntityHandle, MeshRenderer)).toBe(
        false,
      );
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

  it('propagates a moved parent without rewriting its child and keeps a reattached child alive', () => {
    const f = fixture();
    const parent = new Group();
    parent.position.set(1, 2, 0);
    f.scene.add(parent);
    parent.add(f.mesh);
    f.mesh.position.x = 3;
    f.mesh.frustumCulled = false;
    f.sync();

    const child = f.entity(),
      root = f.entity(parent);
    const world = f.projection.world;
    expect(world.get(child, ChildOf).unwrap().parent).toBe(root);
    expect(world.get(child, Transform).unwrap().pos[0]).toBe(3);
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(4);

    const writes = vi.spyOn(world, 'set');
    const ranges = vi.spyOn(world, 'setArrayRange');
    parent.position.x = -2;
    f.sync();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(1);
    expect(
      writes.mock.calls.some(([entity, component]) => entity === child && component === Transform),
    ).toBe(false);
    expect(
      ranges.mock.calls.some(([entity, component]) => entity === child && component === Transform),
    ).toBe(false);

    f.scene.attach(f.mesh);
    f.scene.remove(parent);
    f.sync();
    expect(f.entity()).toBe(child);
    expect(world.get(child, ChildOf).unwrap().parent).toBe(f.entity(f.scene));
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(1);
    expect(world.hasComponent(root, Transform)).toBe(false);
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

  it('publishes only consecutive instance matrix ranges with stable ordinals', () => {
    const f = fixture();
    const mesh = new InstancedMesh(f.mesh.geometry, f.mesh.material, 8);
    mesh.frustumCulled = false;
    f.scene.add(mesh);
    f.sync();
    const entity = f.entity(mesh);
    const world = f.projection.world;
    const transforms = () => world.get(entity, Instances).unwrap().transforms;
    const writes = vi.spyOn(world, 'setArrayRange');
    const from = readMutationEpoch(world);
    mesh.setMatrixAt(2, new Matrix4().makeTranslation(3, 0, 0));
    mesh.instanceMatrix.addUpdateRange(44, 1);
    mesh.instanceMatrix.needsUpdate = true;
    f.sync();
    expect(transforms()[44]).toBe(3);
    expect(readArrayRangesChangedSince(world, entity, Instances, 'transforms', from)).toEqual([
      { start: 32, end: 48 },
    ]);
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 44, count: 1 }]);
    const range = writes.mock.calls.find(
      ([target, component]) => target === entity && component === Instances,
    )?.[4];
    expect(range).toBeInstanceOf(Float32Array);
    expect((range as Float32Array).buffer).toBe(mesh.instanceMatrix.array.buffer);
    writes.mockRestore();
    mesh.instanceMatrix.array[44] = 6;
    expect(transforms()[44]).toBe(3);

    mesh.instanceMatrix.clearUpdateRanges();
    mesh.setMatrixAt(4, new Matrix4().makeScale(0, 0, 0));
    mesh.instanceMatrix.addUpdateRange(64, 16);
    mesh.instanceMatrix.needsUpdate = true;
    const beforeCollapse = readMutationEpoch(world);
    f.sync();
    expect(transforms()).toHaveLength(7 * 16);
    expect(
      readArrayRangesChangedSince(world, entity, Instances, 'transforms', beforeCollapse),
    ).toBe('whole');

    mesh.instanceMatrix.clearUpdateRanges();
    mesh.setMatrixAt(4, new Matrix4().makeTranslation(4, 0, 0));
    mesh.setMatrixAt(5, new Matrix4().makeTranslation(5, 0, 0));
    mesh.instanceMatrix.addUpdateRange(64, 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(80, 16);
    mesh.instanceMatrix.needsUpdate = true;
    f.sync();
    expect(transforms()).toHaveLength(8 * 16);
    expect(transforms()[76]).toBe(4);
    expect(transforms()[92]).toBe(5);
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
    const cameraEntity = f.sync();
    const bound = f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle;
    expect(bound).not.toBe(0);
    expect(f.projection.world.get(f.entity(), MeshRenderer).unwrap().renderLayers).toBe(4);
    expect(f.projection.world.get(cameraEntity, NativeCamera).unwrap().cullMask).toBe(1);
    f.camera.layers.enable(2);
    f.sync();
    expect(f.projection.world.get(cameraEntity, NativeCamera).unwrap().cullMask).toBe(5);
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).toBe(bound);
  });

  it('publishes current camera and display columns through consecutive and nested scene reads', () => {
    const f = fixture();
    const other = new OrthographicCamera(-2, 2, 1, -1, 0, 20);
    const nested = new PerspectiveCamera(25, 1, 0.4, 40);
    const fallback = new ThreeCore.Color(0.5, 0.25, 0.125);
    const buffers = {
      depth: true,
      stencil: false,
      opaque: true,
      transparent: true,
      sortObjects: true,
      updateMatrices: true,
    };
    const input = {
      toneMapping: NoToneMapping,
      exposure: 0.5,
      clearColor: fallback,
      clearAlpha: 0.5,
    };
    const innerScene = new Scene();
    let inside = false;
    Object.defineProperty(f.scene, 'background', {
      configurable: true,
      get() {
        if (!inside) {
          inside = true;
          const key = f.projection.syncCamera(
            innerScene,
            nested,
            { ...input, exposure: 4 },
            buffers,
          );
          expect(f.projection.world.get(key, NativeCamera).unwrap().exposure).toBe(4);
        }
        return null;
      },
    });
    for (let frame = 0; frame < 60; frame++) {
      const camera = frame % 2 === 0 ? f.camera : other;
      f.camera.filmOffset = frame;
      other.zoom = 1 + frame / 60;
      camera.updateProjectionMatrix();
      const bloom = frame % 3 === 0 ? { intensity: 0.75, radius: 0.25, threshold: 0.6 } : undefined;
      const entity = f.projection.syncCamera(
        f.scene,
        camera,
        { ...input, bloom, exposure: frame + 0.5 },
        buffers,
      );
      const data = f.projection.world.get(entity, NativeCamera).unwrap();
      const reference = cameraData(camera, NoToneMapping, frame + 0.5);
      expect(data.projection).toBe(reference.projection);
      expect(data.fov).toBeCloseTo(reference.fov);
      expect(data.left).toBeCloseTo(reference.left);
      expect(data.projectionOffset).toEqual(reference.projectionOffset);
      expect(data.exposure).toBe(frame + 0.5);
      expect(data.bloomIntensity).toBe(bloom?.intensity ?? reference.bloomIntensity);
      expect(data.bloomRadius).toBe(bloom?.radius ?? reference.bloomRadius);
      expect([...data.clearColor]).toEqual([0.25, 0.125, 0.0625, 0.5]);
    }
    expect(inside).toBe(true);
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
    expect(copyMeshAttribute(meshData(f.mesh), 'color')).toBeUndefined();
    expect(copyMeshAttribute(meshData(other), 'color')?.[0]).toBe(0.25);
    f.mesh.material = [colored, f.material];
    geometry.clearGroups();
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(0, 3, 1);
    f.sync();
    const projected = meshData(f.mesh);
    expect(copyMeshAttribute(projected, 'color')?.length).toBe(count * 8);
    expect(copyMeshAttribute(projected, 'color')?.[count * 4]).toBe(1);
    expect(projected.indices?.[3]).toBe((projected.indices?.[0] ?? 0) + count);
    colors.setX(0, 0.75);
    colors.needsUpdate = true;
    f.sync();
    expect(copyMeshAttribute(meshData(other), 'color')?.[0]).toBe(0.75);
    expect(copyMeshAttribute(meshData(f.mesh), 'color')?.[0]).toBe(0.75);
    expect(geometry.getAttribute('position').count).toBe(count);
    geometry.deleteAttribute('color');
    f.sync();
    expect(copyMeshAttribute(meshData(other), 'color')).toBeUndefined();
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

  it('publishes source hierarchy and leaves new draws unbound when material admission fails', () => {
    const f = fixture();
    f.sync();
    const parent = new Group();
    parent.position.x = 99;
    parent.add(f.mesh);
    const unsupported = new Mesh(new BoxGeometry(), new ShaderMaterial());
    f.scene.add(parent, unsupported);
    expect(f.sync).toThrow('three-migration-required');
    const entity = f.entity();
    expect(f.projection.world.get(entity, GlobalTransform).unwrap().world[12]).toBe(99);
    expect(f.projection.world.get(entity, ChildOf).unwrap().parent).toBe(
      f.projection.entityFor(parent),
    );
    const unsupportedEntity = f.projection.entityFor(unsupported);
    expect(unsupportedEntity).toBeDefined();
    expect(f.projection.world.hasComponent(unsupportedEntity as EntityHandle, MeshRenderer)).toBe(
      false,
    );
    expect(f.projection.sources().some(({ uuid }) => uuid === unsupported.uuid)).toBe(true);
    expect(f.projection.sources('admitted').some(({ uuid }) => uuid === unsupported.uuid)).toBe(
      false,
    );
    f.scene.remove(unsupported);
    f.sync();
    expect(f.projection.entityFor(unsupported)).toBeUndefined();
    expect(f.projection.world.get(entity, GlobalTransform).unwrap().world[12]).toBe(99);
  });

  it('reads independent double-precision source poses while native rows move through the same page', () => {
    const f = fixture();
    const other = new Group();
    const third = new Group();
    f.scene.add(other, third);
    const inputs = {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
    };
    try {
      f.projection.sync(f.scene, f.camera, cameraData(f.camera, NoToneMapping, 1), inputs);
      for (let frame = 1; frame <= 60; frame++) {
        const x = 1 + frame * 2 ** -32;
        other.position.x = x;
        third.position.y = -x;
        f.mesh.position.z = frame / 7;
        f.projection.sync(f.scene, f.camera, cameraData(f.camera, NoToneMapping, 1), inputs);
        expect(other.matrix.elements[12]).toBe(x);
        expect(third.matrix.elements[13]).toBe(-x);
        expect(f.mesh.matrix.elements[14]).toBe(frame / 7);
        expect(f.projection.world.get(f.entity(other), GlobalTransform).unwrap().world[12]).toBe(
          Math.fround(x),
        );
        expect(f.projection.world.get(f.entity(third), GlobalTransform).unwrap().world[13]).toBe(
          Math.fround(-x),
        );
      }
    } finally {
      f.projection.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('uses one ECS hierarchy for draw poses and Three caches (tracked=%s)', (tracked) => {
    const f = fixture();
    setThreeSceneTracking(f.scene, tracked);
    const first = new Group();
    const second = new Group();
    first.add(second, f.mesh);
    f.scene.add(first);
    const mirror = f.mesh.matrixWorld.elements;
    const run = () =>
      f.projection.sync(f.scene, f.camera, cameraData(f.camera, NoToneMapping, 1), {
        ecsPoses: true,
        updateMatrices: true,
        depth: true,
        stencil: false,
        sortObjects: true,
        opaque: true,
        transparent: true,
      });
    const updates = vi.spyOn(f.projection, 'updateMatrices');
    try {
      first.position.x = 1;
      f.mesh.position.x = 2;
      run();
      expect(f.projection.sourceWork()?.poseAuthority).toBe('ecs');
      expect(f.projection.world.get(f.entity(), ChildOf).unwrap().parent).toBe(f.entity(first));
      expect(mirror[12]).toBe(3);

      second.position.x = 5;
      second.add(f.mesh);
      f.camera.position.x = 4;
      run();
      expect(f.projection.world.get(f.entity(), ChildOf).unwrap().parent).toBe(f.entity(second));
      expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(8);
      expect(mirror[12]).toBe(8);
      expect(f.camera.matrixWorldInverse.elements[12]).toBe(-4);
      f.camera.matrixAutoUpdate = false;
      f.camera.matrix.makeTranslation(6, 0, 5);
      run();
      expect(f.projection.sourceWork()?.poseAuthority).toBe('ecs');
      expect(f.camera.matrixWorldInverse.elements[12]).toBe(-6);

      f.mesh.matrix.makeTranslation(100, 0, 0);
      f.mesh.matrixWorld.makeTranslation(200, 0, 0);
      run();
      expect(f.mesh.matrix.elements[12]).toBe(2);
      expect(mirror[12]).toBe(8);
      expect(updates).not.toHaveBeenCalled();

      f.mesh.matrixWorldAutoUpdate = false;
      f.mesh.matrixWorld.makeTranslation(14, 0, 0);
      run();
      expect(f.projection.sourceWork()?.poseAuthority).toBe('three');
      expect(f.projection.world.hasComponent(f.entity(), ChildOf)).toBe(false);
      expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(14);
      expect(updates).toHaveBeenCalledTimes(1);

      f.mesh.matrixWorldAutoUpdate = true;
      run();
      expect(f.projection.sourceWork()?.poseAuthority).toBe('ecs');
      expect(f.projection.world.get(f.entity(), ChildOf).unwrap().parent).toBe(f.entity(second));
      expect(mirror[12]).toBe(8);
      expect(updates).toHaveBeenCalledTimes(1);

      first.add(f.camera);
      run();
      const world = f.projection.world;
      const cameraEntity = f.entity(f.camera);
      expect(world.get(cameraEntity, ChildOf).unwrap().parent).toBe(f.entity(first));
      expect(f.camera.matrixWorldInverse.elements[12]).toBe(-7);
      f.scene.add(second);
      second.add(first);
      run();
      expect(world.get(f.entity(first), ChildOf).unwrap().parent).toBe(f.entity(second));
      expect(f.camera.matrixWorldInverse.elements[12]).toBe(-12);
      first.remove(f.camera);
      run();
      expect(world.hasComponent(cameraEntity, ChildOf)).toBe(false);
      expect(f.camera.matrixWorldInverse.elements[12]).toBe(-6);
    } finally {
      updates.mockRestore();
    }
  });

  it('reverses changed edges and retires replaced sources during sustained pose motion', () => {
    const f = fixture();
    const a = new Group(),
      b = new Group();
    let resident = new Group();
    f.scene.add(a, resident);
    a.add(b);
    b.add(f.mesh);
    const sync = () =>
      f.projection.sync(f.scene, f.camera, cameraData(f.camera, NoToneMapping, 1), {
        ecsPoses: true,
        updateMatrices: true,
        depth: true,
        stencil: false,
        sortObjects: true,
        opaque: true,
        transparent: true,
      });
    const world = f.projection.world;
    try {
      sync();
      const mesh = f.entity();
      for (let frame = 1; frame <= 60; frame++) {
        const outer = frame % 2 === 0 ? a : b;
        const inner = outer === a ? b : a;
        f.scene.add(outer);
        outer.add(inner);
        inner.add(f.mesh);
        a.position.x = frame;
        b.position.x = -frame / 2;
        f.mesh.position.x = frame / 4;
        const retired = f.entity(resident);
        f.scene.remove(resident);
        resident = new Group();
        f.scene.add(resident);
        sync();
        expect(world.hasComponent(retired, Transform)).toBe(false);
        expect(world.get(f.entity(inner), ChildOf).unwrap().parent).toBe(f.entity(outer));
        expect(world.get(mesh, ChildOf).unwrap().parent).toBe(f.entity(inner));
        expect(world.get(mesh, GlobalTransform).unwrap().world[12]).toBe(frame * 0.75);
        expect(f.mesh.matrixWorld.elements[12]).toBe(frame * 0.75);
      }
    } finally {
      f.projection.dispose();
    }
  });

  it('publishes the first draw outside the camera frustum for native Render', () => {
    const f = fixture();
    f.mesh.position.x = 100;
    f.sync();
    expect(f.projection.world.get(f.entity(), GlobalTransform).unwrap().world[12]).toBe(100);
    expect(f.projection.world.get(f.entity(), MeshFilter).unwrap().assetHandle).not.toBe(0);
    expect(f.projection.world.get(f.entity(), MeshRenderer).unwrap().frustumCulled).toBe(true);
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

  it('updates managed texture bindings without preparing the same stock material program again', () => {
    const prepare = vi.fn((asset: MaterialAsset) => asset);
    const material = new MeshStandardMaterial();
    const f = fixture(new AssetRegistry(), material, prepare);
    const map = new DataTexture(Uint8Array.of(255, 32, 0, 255), 1, 1);
    const next = new DataTexture(Uint8Array.of(0, 64, 255, 255), 1, 1);
    map.needsUpdate = next.needsUpdate = true;
    material.map = map;
    f.sync();
    const materialHandle = () =>
      f.projection.world.get(f.entity(), MeshRenderer).unwrap().materials[0];
    const handle = materialHandle();
    if (handle === undefined) throw new Error('missing stock material');
    const snapshot = f.assets.snapshot(handle).unwrap();
    const original = snapshot.read<MaterialAsset>(handle).unwrap();
    try {
      material.map = next;
      material.roughness = 0.25;
      next.offset.x = 0.125;
      f.sync();
      const updated = f.assets.read(handle).unwrap();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(materialHandle()).toBe(handle);
      expect(updated.passes).toEqual(original.passes);
      expect(updated.values?.roughness).toBe(0.25);
      expect(updated.values?.baseColorTexture).not.toEqual(original.values?.baseColorTexture);
      expect(updated.values?.baseColorTexture).toMatchObject({
        coordinates: { transform: { offset: [0.125, 0] } },
      });
      expect(snapshot.read<MaterialAsset>(handle).unwrap()).toEqual(original);

      material.map = null;
      f.sync();
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(f.assets.read(handle).unwrap().values?.baseColorTexture).toBeUndefined();
    } finally {
      snapshot.dispose();
      map.dispose();
      next.dispose();
    }
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

  it('diagnoses a custom WebGL compile hook instead of silently losing its effect', () => {
    const f = fixture();
    const material = new MeshStandardMaterial();
    f.mesh.material = material;
    expect(f.sync).not.toThrow();
    material.onBeforeCompile = () => {};
    expect(f.sync).toThrow('Material.onBeforeCompile');
  });

  it('projects spot target, cone, power, decay, finite range and camera layers into native light state', () => {
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
      decay: 2,
      outerConeDeg: 60,
      innerConeDeg: 45,
      castShadow: false,
    });
    light.target.position.x = 3;
    light.power = 30 * Math.PI;
    light.decay = 0;
    light.distance = 7;
    light.angle = Math.PI / 4;
    light.penumbra = 0;
    f.sync();
    expect(read().direction[0]).toBeCloseTo(Math.SQRT1_2);
    expect(read().direction[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(read()).toMatchObject({
      intensity: 30,
      range: 7,
      decay: 0,
      outerConeDeg: 45,
      innerConeDeg: 45,
    });
    light.layers.set(2);
    f.sync();
    expect(read().intensity).toBe(0);
    f.camera.layers.enable(2);
    f.sync();
    expect(read().intensity).toBe(30);
  });
});
