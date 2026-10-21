import { type AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import { sceneAssetContribution } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset, SceneAsset } from '@forgeax/engine-types';

/** A complete transported source for the parser → Source → World contract tests. */
export function publishGltfFixture(
  assets: AssetRegistry,
  input: {
    mesh: MeshAsset;
    material: MaterialAsset;
    scene: SceneAsset;
    meshGuid: string;
    materialGuid: string;
    sceneGuid: string;
  },
) {
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.installDecoder(materialContribution.kind, materialContribution.decoder);
  assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  const packageUrl = 'https://gltf-fixture.invalid/pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'gltf-fixture',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        { guid: input.meshGuid, kind: 'mesh', payload: input.mesh, refs: [], artifacts: {} },
        {
          guid: input.materialGuid,
          kind: 'material',
          payload: input.material,
          refs: [],
          artifacts: {},
        },
        {
          guid: input.sceneGuid,
          kind: 'scene',
          payload: input.scene,
          refs: [input.meshGuid, input.materialGuid],
          artifacts: {},
        },
      ],
    },
  });
  const body = JSON.stringify(publication.pack, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  assets.setCatalogSource(
    createCatalogSource({
      entries: publication.pack.assets.map((row) => ({
        guid: row.guid,
        kind: row.kind,
        packageUrl,
        sourcePath: 'gltf-fixture',
        publication: publication.publication,
      })),
      fetch: async () => new Response(body),
    }),
  );
}
