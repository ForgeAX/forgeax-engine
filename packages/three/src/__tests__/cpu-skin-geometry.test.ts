import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import {
  Bone,
  BufferAttribute,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

it('reuses rigidly weighted source geometry through poses and invalidates on source edits', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const geometry = new PlaneGeometry();
  const position = geometry.getAttribute('position');
  const readPosition = vi.spyOn(position, 'getX');
  const joints = new BufferAttribute(new Uint16Array(position.count * 4), 4);
  const weights = new BufferAttribute(new Float32Array(position.count * 4), 4);
  for (let vertex = 0; vertex < position.count; vertex++) {
    joints.setX(vertex, 1);
    weights.setX(vertex, 1);
  }
  geometry.setAttribute('skinIndex', joints);
  geometry.setAttribute('skinWeight', weights);
  const mesh = new SkinnedMesh(
    geometry,
    new MeshStandardMaterial({ roughness: 0.8, flatShading: true }),
  );
  const root = new Bone();
  const tip = new Bone();
  root.add(tip);
  mesh.add(root);
  mesh.position.set(0.2, 0.1, -0.5);
  mesh.scale.setScalar(1.5);
  scene.add(mesh);
  mesh.bind(new Skeleton([root, tip]));
  mesh.frustumCulled = false;
  const pod = cameraData(camera, NoToneMapping, 1);

  function renderPositions() {
    projection.sync(scene, camera, pod);
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Expected a projected skin');
    const handle = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    return copyMeshAttribute(runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap(), 'position');
  }
  function expectPosition(actual: ReturnType<typeof renderPositions>) {
    const expected = mesh.getVertexPosition(0, new Vector3());
    expect(actual?.[0]).toBeCloseTo(expected.x, 5);
    expect(actual?.[1]).toBeCloseTo(expected.y, 5);
    expect(actual?.[2]).toBeCloseTo(expected.z, 5);
  }
  try {
    expectPosition(renderPositions());
    readPosition.mockClear();
    tip.rotation.z = 0.5;
    tip.scale.set(1.2, 0.8, 1.1);
    tip.position.set(-0.21, 0.47, 0);
    const moved = renderPositions();
    expect(readPosition).not.toHaveBeenCalled();
    expectPosition(moved);

    readPosition.mockClear();
    position.setX(0, -0.7);
    position.needsUpdate = true;
    const edited = renderPositions();
    expect(readPosition).toHaveBeenCalled();
    expectPosition(edited);

    readPosition.mockClear();
    geometry.dispose();
    expect(renderPositions()).toEqual(edited);
    expect(readPosition).toHaveBeenCalled();

    joints.setW(0, 99);
    joints.needsUpdate = true;
    expect(renderPositions).toThrow('SkinnedMesh joint index/weight');
  } finally {
    readPosition.mockRestore();
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    mesh.material.dispose();
  }
});

it.each([
  { name: 'rounded float32', ArrayType: Float32Array, unit: 1, first: 0.5 + 2 ** -23 },
  { name: 'UNORM8', ArrayType: Uint8Array, unit: 255, first: 128 },
  { name: 'UNORM16', ArrayType: Uint16Array, unit: 65535, first: 32768 },
])('keeps $name Standard skins on native geometry and follows weight and scale edits', ({
  ArrayType,
  unit,
  first: firstWeight,
}) => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const geometry = new PlaneGeometry();
  const count = geometry.getAttribute('position').count;
  const joints = new BufferAttribute(new Uint16Array(count * 4), 4);
  const weights = new BufferAttribute(new ArrayType(count * 4), 4, unit !== 1);
  for (let vertex = 0; vertex < count; vertex++) weights.setX(vertex, 1);
  geometry.setAttribute('skinIndex', joints);
  geometry.setAttribute('skinWeight', weights);
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  const bone = new Bone();
  const second = new Bone();
  mesh.add(bone, second);
  mesh.bind(new Skeleton([bone, second]));
  joints.setY(0, 1);
  weights.array[0] = firstWeight;
  weights.array[1] = unit === 1 ? 0.5 : unit - firstWeight;
  mesh.frustumCulled = false;
  scene.add(mesh);
  const pod = cameraData(camera, NoToneMapping, 1);

  const sync = () => {
    projection.sync(scene, camera, pod);
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Expected a projected skin');
    const material = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (material === undefined) throw new Error('Expected a projected material');
    return {
      skinned: projection.world.hasComponent(entity, Skin),
      mesh: projection.world.get(entity, MeshFilter).unwrap().assetHandle,
      programs: runtimeAssets(assets)
        .borrow<MaterialAsset>(material)
        .unwrap()
        .passes?.map((pass) => pass.program.module),
    };
  };
  try {
    const first = sync();
    expect(first.skinned).toBe(true);
    expect(first.programs).toContain('forgeax::pbr-skin');
    expect(first.programs).toContain('forgeax::default-shadow-caster');
    bone.position.x = 0.4;
    expect(sync()).toEqual(first);

    second.position.y = 2;
    weights.array[0] = unit === 1 ? 0.75 : unit - 16;
    weights.array[1] = unit === 1 ? 0.25 : 16;
    weights.needsUpdate = true;
    expect(sync().skinned).toBe(true);
    weights.setXY(0, 0.2, 0.2);
    weights.needsUpdate = true;
    expect(sync().skinned).toBe(true);
    weights.setXY(0, 0, 0);
    weights.needsUpdate = true;
    expect(sync().skinned).toBe(true);
    weights.setXY(0, 1, 0);
    weights.needsUpdate = true;
    expect(sync().skinned).toBe(true);
    if (unit !== 1) {
      weights.normalized = false;
      expect(sync().skinned).toBe(true);
      weights.normalized = true;
      expect(sync().skinned).toBe(true);
    }
    mesh.scale.set(1, 2, 1);
    mesh.position.x = 2;
    weights.setXY(0, 0.25, 0);
    weights.needsUpdate = true;
    const fallback = sync();
    expect(fallback.skinned).toBe(false);
    const projected = runtimeAssets(assets).borrow<MeshAsset>(fallback.mesh).unwrap();
    const localX = geometry.getAttribute('position').getX(0);
    const weight = weights.getX(0);
    expect(copyMeshAttribute(projected, 'position')?.[0]).toBeCloseTo((localX + 0.4) * weight, 6);
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    mesh.material.dispose();
  }
});
