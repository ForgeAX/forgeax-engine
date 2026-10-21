// Reproduce Bevy's `gltf/update_gltf_scene` through a real SceneAsset hierarchy.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import {
  gltfDocToSceneAsset,
  meshIrToMeshAsset,
  parseGltf,
  toMaterialAsset,
} from '@forgeax/engine-gltf';

import { Camera, DirectionalLight, perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

import { quat } from '@forgeax/engine-math';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import boxGltfUrl from '../../../hello/gltf/assets/box.gltf?url';
import { MovedScene, stepUpdateGltfScene } from './update-gltf-scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('bevy-update-gltf-scene: missing canvas');

type WindowEvidence = Window & {
  __bevyUpdateGltfSceneReady?: boolean;
  __prepareUpdateGltfSceneCapture?: () => Promise<void>;
};

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    { pointerLockAllowed: () => false },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appResult.ok) {
    const message = appResult.error instanceof EngineEnvironmentError
      ? 'no usable rendering backend'
      : `${appResult.error.code}: ${appResult.error.hint}`;
    console.error(`[bevy-update-gltf-scene] createApp failed: ${message}`);
    return;
  }

  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  if (assets === undefined) {
    console.error('[bevy-update-gltf-scene] assets unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;

  const source = await fetch(boxGltfUrl);
  const docResult = await parseGltf(
    (await source.json()) as unknown,
    async (uri) => { throw new Error(`bevy-update-gltf-scene: unexpected external buffer ${uri}`); },
    boxGltfUrl,
  );
  if (!docResult.ok) {
    console.error(`[bevy-update-gltf-scene] parseGltf failed: ${docResult.error.code}`);
    return;
  }
  const doc = docResult.value;
  const meshResult = meshIrToMeshAsset(doc.meshes);
  if (!meshResult.ok) {
    console.error(`[bevy-update-gltf-scene] mesh bridge failed: ${meshResult.error.code}`);
    return;
  }
  const mesh = meshResult.value;
  const materialIr = doc.materials[0];
  if (materialIr === undefined) {
    console.error('[bevy-update-gltf-scene] glTF has no material');
    return;
  }
  const material = toMaterialAsset(materialIr);
  const meshHandle = assets.create(mesh).unwrap();
  const materialHandle = assets.create(material).unwrap();
  const meshNode = doc.nodes[0];
  const sceneDoc = meshNode === undefined
    ? doc
    : {
        ...doc,
        nodes: [meshNode],
        scenes: [{ ...doc.scenes[doc.defaultSceneIndex], nodes: [0] }],
        defaultSceneIndex: 0,
      };
  const scene = gltfDocToSceneAsset(sceneDoc, {
    meshHandles: new Map([[0, meshHandle]]),
    materialHandles: new Map([[0, materialHandle]]),
  });

  const sceneHandle = assets.create(scene).unwrap();
  const instanceResult = assets.instantiate(sceneHandle, world);
  if (!instanceResult.ok) {
    console.error(`[bevy-update-gltf-scene] instantiate failed: ${instanceResult.error.code}`);
    return;
  }
  const sceneRoot = instanceResult.value;
  const marked = world.addComponent(sceneRoot, { component: MovedScene, data: {} });
  if (!marked.ok) {
    console.error(`[bevy-update-gltf-scene] mark scene failed: ${marked.error.code}`);
    return;
  }

  const eye: [number, number, number] = [2, 2, 4];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
  world.spawn({ component: DirectionalLight, data: { castShadow: true, direction: [-0.4, -1, -0.3], intensity: 5 } });
  world.addSystem(Update, {
    name: 'update-gltf-scene-descendants',
    queries: [],
    fn: (world) => {
      const time = world.getResource(Time);
      stepUpdateGltfScene(world, time.elapsed);
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error(`[bevy-update-gltf-scene] app.start failed: ${started.error.code}`);
    return;
  }
  const evidenceWindow = window as WindowEvidence;
  evidenceWindow.__prepareUpdateGltfSceneCapture = async (): Promise<void> => {
    const updated = world.update(1 / 60);
    if (!updated.ok) throw new Error(`capture preparation update failed: ${updated.error.code}`);
  };
  evidenceWindow.__bevyUpdateGltfSceneReady = true;
  console.warn('[bevy-update-gltf-scene] instantiated SceneAsset descendants are moving');
}
