import { AssetGuid } from '@forgeax/engine-pack/guid';
import { terrainDerivedLayoutValid, validateTerrain } from '@forgeax/engine-terrain';
import { AssetError, type Loader, type TerrainAsset } from '@forgeax/engine-types';

function readTerrain(
  payload: Record<string, unknown>,
  refs?: readonly string[],
): TerrainAsset | undefined {
  const floats = (value: unknown) =>
    value instanceof Float32Array
      ? value
      : Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v))
        ? Float32Array.from(value)
        : undefined;
  const heights = floats(payload.heights),
    weights = floats(payload.weights);
  if (!heights || !weights || payload.kind !== 'terrain') return undefined;
  const terrain = { ...payload, heights, weights } as unknown as TerrainAsset;
  if (!validateTerrain(terrain).ok || !terrainDerivedLayoutValid(terrain)) return undefined;
  const dependencies = [
    ...terrain.grids,
    ...terrain.layers.flatMap((l) =>
      l.blend === 'height' ? [l.material, l.height] : [l.material],
    ),
  ];
  for (const s of terrain.sections) {
    dependencies.push(s.heightTexture, s.weightTexture, s.material);
  }
  if (
    dependencies.some(
      (guid) =>
        typeof guid !== 'string' ||
        !AssetGuid.parse(guid).ok ||
        (refs !== undefined && !refs.includes(guid)),
    )
  )
    return undefined;
  return terrain;
}

/** Array bytes are reconstructed explicitly after JSON fetch, never cast to a typed array. */
export const terrainLoader: Loader<TerrainAsset> = {
  kind: 'terrain',
  load: (payload, refs) => readTerrain(payload, refs),
  loadPack: (input) => {
    let payload = input.payload;
    try {
      if (input.artifacts.body)
        payload = JSON.parse(new TextDecoder().decode(input.artifacts.body.bytes)) as Record<
          string,
          unknown
        >;
    } catch {
      throw new AssetError({
        code: 'asset-parse-failed',
        expected: 'terrain JSON with finite height/weight arrays',
        hint: 'rebuild the terrain producer for the same GUID',
      });
    }
    const value = readTerrain(payload, input.refs);
    if (value === undefined)
      throw new AssetError({
        code: 'asset-parse-failed',
        expected: 'complete validated Landscape asset and declared GUID closure',
        hint: 'repair terrain dimensions, layers or missing references and recook',
      });
    return value;
  },
};
