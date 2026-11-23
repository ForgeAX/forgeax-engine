import { fileURLToPath } from 'node:url';
import { animationClipContribution } from '../../../packages/animation/dist/index.mjs';
import { validateAssetPublication } from '../../../packages/assets-runtime/dist/index.mjs';
import {
  buildScriptablePack,
  createStandardAssetOutputProducerRegistry,
  prepareRuntimePackContent,
  RuntimePackProducer,
} from '../../../packages/import/dist/index.mjs';
import {
  AssetGuid,
  definePackageId,
  PackageId,
  projectScriptablePackSceneComponents,
} from '../../../packages/pack/dist/scriptable-pack.mjs';
import { skeletonContribution, skinContribution } from '../../../packages/skinning/dist/index.mjs';
import { cells } from './level-streaming-landscape.mjs';
import { levelDecoders } from './level-streaming-pack.mjs';
import scenery from './pine-basin-scenery.pack.ts';
import wildlife, { wildlifePackageId } from './pine-basin-wildlife.pack.ts';

async function publish(producer, definition, file, packageId, values) {
  const subjectPackageId = definePackageId(packageId);
  const sceneComponents = projectScriptablePackSceneComponents(definition.sceneComponents);
  const sourcePath = fileURLToPath(new URL(file, import.meta.url));
  const { stagedOutputs } = (
    await buildScriptablePack({
      definition,
      sourcePath,
      subjectPackageId,
      values,
      outputs: createStandardAssetOutputProducerRegistry(sceneComponents),
    })
  ).unwrap();
  const assets = Object.fromEntries(
    stagedOutputs.map(({ sourceKey, asset }) => [sourceKey, asset]),
  );
  const content = (
    await prepareRuntimePackContent(PackageId.format(subjectPackageId), assets, { sceneComponents })
  ).unwrap();
  const publication = (await producer.admit(content)).unwrap();
  const ref = (key) => AssetGuid.format(AssetGuid.derive(subjectPackageId, key));
  return { assets, ref, packageUrl: publication.rows[0].packageUrl };
}

function describeCell(id, { assets, ref, packageUrl }) {
  const shapes = new Map(
    Object.entries(assets)
      .filter(([, asset]) => asset.kind === 'mesh')
      .map(([key, asset]) => [ref(key), asset.indices.length / 3]),
  );
  const count = (...scenes) => {
    let renderables = 0;
    let triangles = 0;
    for (const scene of scenes) {
      for (const { components } of Object.values(scene.entities)) {
        const mesh = components.MeshFilter?.assetHandle;
        if (mesh === undefined) continue;
        const number = shapes.get(mesh);
        if (number === undefined) throw Error(`Pine Basin Cell ${id} has an unknown mesh: ${mesh}`);
        renderables++;
        triangles += number;
      }
    }
    return { renderables, triangles };
  };
  return {
    id,
    collision: ref('collision'),
    proxy: ref('proxy'),
    west: ref('west'),
    east: ref('east'),
    packageUrl,
    ...count(assets.west, assets.east),
    proxyCounts: count(assets.proxy),
    colliders: Object.keys(assets.collision.entities).length,
  };
}

export async function createWorldPack(baseUrl) {
  const producer = new RuntimePackProducer({
    scopeId: 'level-pine-basin',
    baseUrl,
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(state.rows, fetcher, undefined, {
        decoders: [
          ...levelDecoders,
          animationClipContribution,
          skeletonContribution,
          skinContribution,
        ],
        dependencies,
      }),
  });
  const manifest = [];
  try {
    for (const { id } of cells) {
      const packageId = `61a842de-0708-4eef-80a2-${String(id + 1).padStart(12, '0')}`;
      const cell = await publish(producer, scenery, './pine-basin-scenery.pack.ts', packageId, {
        cell: id,
      });
      manifest.push(describeCell(id, cell));
    }
    const animal = await publish(
      producer,
      wildlife,
      './pine-basin-wildlife.pack.ts',
      wildlifePackageId,
    );
    return { producer, manifest, wildlife: { scene: animal.ref('scene/deer') } };
  } catch (error) {
    await producer.dispose();
    throw error;
  }
}
