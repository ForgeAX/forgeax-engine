import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
  type TilesetAsset,
} from '@forgeax/engine-types';

/** Decode source atlas edges; AssetsRuntime owns complete admission validation. */
export const tilesetContribution: AssetDecoderContribution<TilesetAsset, 'tileset'> = {
  kind: { kind: 'tileset' } as AssetKind<TilesetAsset, 'tileset'>,
  consumer: 'Renderer native Tilemap source',
  decoder: {
    async decode({ envelope, artifacts }) {
      const invalid = () =>
        err({
          code: 'asset-package-invalid' as const,
          expected: 'a tileset descriptor whose atlas GUIDs exactly match envelope refs',
          hint: 'recook the Tileset descriptor and its declared atlas closure',
          detail: { guid: envelope.guid, reason: 'tileset owner validation failed' },
        });
      const descriptor = envelope.artifacts.body ?? Object.values(envelope.artifacts)[0];
      let payload: unknown = envelope.payload;
      if (descriptor !== undefined) {
        const bytes = await artifacts.read(descriptor);
        if (!bytes.ok) return bytes;
        try {
          payload = JSON.parse(new TextDecoder().decode(bytes.value));
        } catch {
          return invalid();
        }
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
        return invalid();
      const source = payload as Record<string, unknown>;
      const atlases = Array.isArray(source.atlases)
        ? source.atlases.map((value) =>
            typeof value === 'number' && Number.isSafeInteger(value) ? envelope.refs[value] : value,
          )
        : undefined;
      if (
        (source.kind !== 'tileset' && (descriptor !== undefined || source.kind !== undefined)) ||
        atlases === undefined ||
        atlases.length === 0 ||
        atlases.length !== envelope.refs.length ||
        atlases.some((atlas, index) => typeof atlas !== 'string' || atlas !== envelope.refs[index])
      )
        return invalid();
      // Grid, regions, pivots and collision metadata share the runtime create/edit gate.
      return ok({ ...source, kind: 'tileset', atlases } as unknown as TilesetAsset);
    },
  },
};
