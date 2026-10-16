export interface AssetBindingCatalog {
  readonly assets: readonly {
    readonly guid: string;
    readonly sourceKey: string;
    readonly kind: string;
  }[];
  readonly scenes: readonly {
    readonly sourceKey: string;
    readonly entityKeys: readonly string[];
  }[];
}

function quote(value: unknown): string {
  return JSON.stringify(value);
}

/** Render the inventory projection consumed by authored feature plugins. */
export function assetBindingModuleSource(catalog: AssetBindingCatalog): string {
  const seen = new Set<string>();
  for (const scene of catalog.scenes) {
    if (scene.sourceKey.length === 0) {
      throw Object.assign(new Error('scene sourceKey is empty'), {
        code: 'asset-binding-source-missing',
        expected: 'each scene binding row has a non-empty sourceKey',
        hint: 'declare the scene sourceKey in the owning Pack producer',
        detail: { sceneSourceKey: scene.sourceKey },
      });
    }
    for (const entityKey of scene.entityKeys) {
      const identity = `${scene.sourceKey}\0${entityKey}`;
      if (entityKey.length === 0 || seen.has(identity)) {
        throw Object.assign(new Error(`duplicate entity key ${entityKey}`), {
          code: 'asset-binding-duplicate',
          expected: 'entity keys are unique within one scene',
          hint: 'rename the duplicate entity key in the scene producer',
          detail: { sceneSourceKey: scene.sourceKey, address: entityKey },
        });
      }
      seen.add(identity);
    }
  }
  const assetRows = catalog.assets
    .map((asset) => `  ${quote(asset.sourceKey)}: ${quote(asset)},`)
    .join('\n');
  const sceneRows = catalog.scenes
    .map((scene) => `  ${quote(scene.sourceKey)}: ${quote(scene.entityKeys)},`)
    .join('\n');
  return `export const assets = {\n${assetRows}\n};\nexport const sceneEntityKeys = {\n${sceneRows}\n};\nexport function asset(sourceKey) { return assets[sourceKey]; }\nexport function sceneEntity(sceneSourceKey, address) { return { sceneSourceKey, address }; }\n`;
}

/** Emit the deletable declaration projection for the same inventory snapshot. */
export function assetBindingDeclarationSource(catalog: AssetBindingCatalog): string {
  const assetKeys = catalog.assets
    .map(
      (asset) =>
        `  ${quote(asset.sourceKey)}: import('@forgeax/engine/types').AssetRef<${quote(asset.kind)}> & { readonly sourceKey: ${quote(asset.sourceKey)} };`,
    )
    .join('\n');
  const sceneKeys = catalog.scenes
    .map(
      (scene) =>
        `  ${quote(scene.sourceKey)}: readonly [${scene.entityKeys.map((entityKey) => quote(entityKey)).join(', ')}];`,
    )
    .join('\n');
  const virtualModule = `declare module 'virtual:forgeax/assets' {\nexport const assets: {\n${assetKeys}\n};\nexport const sceneEntityKeys: {\n${sceneKeys}\n};\nexport function asset<const K extends keyof typeof assets>(sourceKey: K): (typeof assets)[K];\nexport function sceneEntity<const S extends keyof typeof sceneEntityKeys>(sceneSourceKey: S, address: (typeof sceneEntityKeys)[S][number] | readonly [string, ...string[]]): import('@forgeax/engine/types').SceneEntityRef;\n}`;
  return `${virtualModule}\n`;
}
