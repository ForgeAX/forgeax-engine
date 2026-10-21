import { terrainDerivedClosureValid, terrainDerivedLayoutValid } from '@forgeax/engine-terrain';
import {
  type Asset,
  AssetError,
  type AssetHandle,
  err,
  ok,
  type Result,
  type TerrainAsset,
} from '@forgeax/engine-types';
import type { AssetRecords } from './internal/asset-records';

/** Validate the actual runtime closure once during admission, after material linking. */
export function prepareRuntimeTerrain(
  root: TerrainAsset,
  records: AssetRecords,
  resolve: (guid: string) => AssetHandle | undefined,
): Result<{ value: TerrainAsset; dependencies: readonly number[] }, AssetError> {
  const invalid = () =>
    new AssetError({
      code: 'asset-invalid-value',
      expected: 'a complete terrain closure derived from the same author samples and layer values',
      hint: 'prepare and adopt matching terrain dependencies together; partial height or surface rewrites cannot be committed',
    });
  if (!terrainDerivedLayoutValid(root)) return err(invalid());
  const direct = new Set<number>();
  const reference = <K extends 'mesh' | 'texture' | 'material'>(
    value: string | AssetHandle<K>,
    kind: K,
  ): AssetHandle<K> => {
    const handle = typeof value === 'number' ? value : resolve(value.toLowerCase());
    if (handle === undefined || !records.validate(handle, kind).ok || handle === 0) throw invalid();
    direct.add(handle);
    return handle as AssetHandle<K>;
  };
  try {
    // Source references are linked once. Runtime roots never query the Catalog.
    const checked: TerrainAsset = {
      ...root,
      grids: root.grids.map((value) => reference(value, 'mesh')),
      layers: root.layers.map((layer) =>
        layer.blend === 'height'
          ? {
              ...layer,
              material: reference(layer.material, 'material'),
              height: reference(layer.height, 'texture'),
            }
          : { ...layer, material: reference(layer.material, 'material') },
      ),
      sections: root.sections.map((section) => ({
        ...section,
        heightTexture: reference(section.heightTexture, 'texture'),
        weightTexture: reference(section.weightTexture, 'texture'),
        material: reference(section.material, 'material'),
      })),
    };
    const borrowed = records.borrowClosure<Asset>([...direct]);
    if (!borrowed.ok) return borrowed;
    const closure = new Map([...borrowed.value].map(([handle, asset]) => [String(handle), asset]));
    return terrainDerivedClosureValid(checked, closure)
      ? ok({ value: checked, dependencies: [...direct] })
      : err(invalid());
  } catch (cause) {
    if (cause instanceof AssetError) return err(cause);
    throw cause;
  }
}
