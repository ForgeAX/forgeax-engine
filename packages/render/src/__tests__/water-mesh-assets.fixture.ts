import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { materialContribution } from '../assets/asset-decoders';
import { Materials } from '../materials';

export async function waterMeshTestAssets(
  materialGuid: string,
  materials: ReadonlyMap<string, MaterialAsset> = new Map([
    [materialGuid, Materials.unlit([0.2, 0.4, 0.8, 1])],
  ]),
): Promise<AssetRegistry> {
  const sourcePath = 'water-mesh-fixture.pack.ts';
  const packageUrl = 'https://water-mesh-fixture.invalid/material.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'water-mesh-fixture',
    generation: 1,
    sourcePath,
    sourceRevision: '1',
    packageUrl,
    sourceKeys: new Map([...materials.keys()].map((guid, index) => [guid, `surface${index}`])),
    pack: {
      assets: [...materials].map(([guid, payload]) => ({
        guid,
        kind: 'material',
        payload,
        refs: [],
        artifacts: {},
      })),
    },
  });
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(materialContribution.kind, materialContribution.decoder);
  assets.setCatalogSource(
    createCatalogSource({
      expectedScope: { scopeId: 'water-mesh-fixture', generation: 1 },
      entries: [...materials.keys()].map((guid, index) => ({
        guid,
        kind: 'material',
        sourcePath,
        sourceKey: `surface${index}`,
        packageUrl,
        publication: publication.publication,
      })),
    }),
    async () => Response.json(publication.pack),
  );
  for (const guid of materials.keys()) (await assets.load(guid, 'material')).unwrap();
  return assets;
}
