import {
  gltfDocToSceneAsset,
  meshIrToMeshAsset,
  parseGltf,
  toMaterialAsset,
} from '@forgeax/engine/gltf';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { Transform } from '@forgeax/engine/scene';
import type { MaterialAsset, MeshAsset, SceneAsset } from '@forgeax/engine/types';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { cubeGltf, rejectLoader } from './fixtures/gltf-source';
import { errorCode, guid } from './fixtures/memory-pack';

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
    'An in-code glTF (one red Box node) is parsed, bridged to MeshAsset / MaterialAsset / SceneAsset POD, catalogued by GUID, loaded back with loadByGuid<SceneAsset>, and instantiated under a parent entity through AssetRegistry.instantiate.',
  expect:
    'ON: a red cube sits on the ground in front of the camera. OFF: the parent moves out of view, leaving only the ground. Checks: parse, bridge, catalog, loadByGuid and instantiate all succeed.',
  async setup({ app, world }) {
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
      const ids = [guid(0x731), guid(0x732), guid(0x733)].map((id) => AssetGuid.parse(id));
      const [meshGuid, materialGuid, sceneGuid] = ids.map((id) => (id.ok ? id.value : undefined));
      if (meshGuid === undefined || materialGuid === undefined || sceneGuid === undefined)
        return fail(checks, 'GUIDs parse', '');
      const meshHandle = world.allocSharedRef('MeshAsset', mesh.value);
      const materialHandle = world.allocSharedRef('MaterialAsset', material);
      const scene = gltfDocToSceneAsset(doc.value, {
        meshHandles: new Map([[0, meshHandle]]),
        materialHandles: new Map([[0, materialHandle]]),
      });
      const cataloged = [
        assets.catalog<MeshAsset>(meshGuid, mesh.value),
        assets.catalog<MaterialAsset>(materialGuid, material),
        assets.catalog<SceneAsset>(sceneGuid, scene),
      ];
      checks.push({
        name: 'catalog mesh/material/scene',
        ok: cataloged.every((result) => result.ok),
      });
      const loaded = await assets.loadByGuid<SceneAsset>(sceneGuid);
      checks.push({
        name: 'loadByGuid<SceneAsset> ok',
        ok: loaded.ok,
        ...(loaded.ok ? {} : { detail: errorCode(loaded.error) }),
      });
      if (!loaded.ok) return undefined;
      checks.push({
        name: 'scene has the Box entity',
        ok: Object.keys(loaded.value.entities).length >= 1,
        detail: Object.keys(loaded.value.entities).join(','),
      });
      const instance = assets.instantiate<SceneAsset>(
        world.allocSharedRef('SceneAsset', loaded.value),
        world,
        parent,
      );
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
