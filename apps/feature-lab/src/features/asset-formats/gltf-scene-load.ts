import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import {
  gltfDocToSceneAsset,
  meshIrToMeshAsset,
  parseGltf,
  toMaterialAsset,
} from '@forgeax/engine/gltf';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { cubeGltf, rejectLoader } from './fixtures/gltf-source';
import { errorCode } from './fixtures/memory-pack';

const HIDDEN: [number, number, number] = [0, -50, 0];

function fail(checks: FeatureCheck[], name: string, detail: string): undefined {
  checks.push({ name, ok: false, detail });
  return undefined;
}

export default defineFeature({
  title: 'glTF scene load',
  catalog: 'glTF scene load',
  kind: 'visual',
  summary:
    'An in-code glTF (one red Box node) is parsed, bridged to MeshAsset / MaterialAsset / SceneAsset POD, created in the runtime asset owner, and instantiated under a parent entity through AssetRegistry.instantiate.',
  expect:
    'ON: a red cube sits on the ground in front of the camera. OFF: the parent moves out of view, leaving only the ground. Checks: parse, bridge, create and instantiate all succeed.',
  async setup({ app, world }) {
    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    spawnStage(world);
    const checks: FeatureCheck[] = [];
    const parent = world
      .spawn({ component: Transform, data: { pos: [0, 0.2, 0], scale: [1.6, 1.6, 1.6] } })
      .unwrap();
    const load = async (): Promise<undefined> => {
      const assets = app.assets;
      if (assets === undefined) return fail(checks, 'app.assets present', 'undefined');
      const { json } = cubeGltf();
      const doc = await parseGltf(json, rejectLoader, 'lab-box.gltf');
      checks.push({
        name: 'parseGltf ok',
        ok: doc.ok,
        ...(doc.ok ? {} : { detail: errorCode(doc.error) }),
      });
      if (!doc.ok) return undefined;
      const mesh = meshIrToMeshAsset(doc.value.meshes);
      const materialIr = doc.value.materials[0];
      if (!mesh.ok) return fail(checks, 'meshIrToMeshAsset ok', errorCode(mesh.error));
      if (materialIr === undefined) return fail(checks, 'material parsed', 'none');
      const material = toMaterialAsset(materialIr);
      const meshHandle = sceneAssets.create(mesh.value).unwrap();
      const materialHandle = sceneAssets.create(material).unwrap();
      const scene = gltfDocToSceneAsset(doc.value, {
        meshHandles: new Map([[0, meshHandle]]),
        materialHandles: new Map([[0, materialHandle]]),
      });
      const sceneHandle = assets.create(scene).unwrap();
      checks.push({
        name: 'scene has the Box entity',
        ok: Object.keys(scene.entities).length >= 1,
        detail: Object.keys(scene.entities).join(','),
      });
      const instance = assets.instantiate(sceneHandle, world, parent);
      checks.push({
        name: 'instantiate ok',
        ok: instance.ok,
        ...(instance.ok ? {} : { detail: errorCode(instance.error) }),
      });
      return undefined;
    };
    await load();
    return {
      toggle(on) {
        world.set(parent, Transform, { pos: on ? [0, 0.2, 0] : HIDDEN } as never);
      },
      checks: () => checks,
    };
  },
});
