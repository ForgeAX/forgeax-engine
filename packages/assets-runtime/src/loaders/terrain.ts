import { AssetGuid } from '@forgeax/engine-pack/guid';
import { terrainDerivedLayoutValid, validateTerrain } from '@forgeax/engine-terrain';
import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
  type TerrainAsset,
} from '@forgeax/engine-types';

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

export const terrainContribution: AssetDecoderContribution<TerrainAsset, 'terrain'> = {
  kind: { kind: 'terrain' } as AssetKind<TerrainAsset, 'terrain'>,
  consumer: 'Terrain',
  decoder: {
    async decode({ envelope, artifacts }) {
      let payload = envelope.payload;
      const body = envelope.artifacts.body;
      if (body !== undefined) {
        const bytes = await artifacts.read(body);
        if (!bytes.ok) return bytes;
        try {
          payload = JSON.parse(new TextDecoder().decode(bytes.value));
        } catch {
          return err({
            code: 'asset-package-invalid',
            expected: 'terrain JSON',
            hint: 'recook the terrain body',
            detail: { guid: envelope.guid, reason: 'invalid terrain body' },
          });
        }
      }
      const value = readTerrain(payload as unknown as Record<string, unknown>, envelope.refs);
      return value === undefined
        ? err({
            code: 'asset-package-invalid',
            expected: 'complete terrain data and declared references',
            hint: 'recook the terrain closure',
            detail: { guid: envelope.guid, reason: 'invalid terrain' },
          })
        : ok(value);
    },
  },
};
