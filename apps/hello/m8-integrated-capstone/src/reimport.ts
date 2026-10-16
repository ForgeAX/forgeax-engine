import type { ImportContext, ImportedAsset, Importer, ImportResult, LoadContext, Loader, LoaderOutput } from '@forgeax/engine-types';

export const CAPSTONE_CONTENT_KIND = 'm8-capstone-blob';
export const CAPSTONE_CONTENT_GUID = '8215d398-8120-4ffa-baf2-4496216cd4f6';

export interface CapstoneContent {
  readonly kind: typeof CAPSTONE_CONTENT_KIND;
  readonly title: string;
  readonly version: number;
  readonly markers: ReadonlyArray<{ readonly id: string; readonly x: number }>;
}

export function capstoneContentImporter(): Importer {
  return {
    key: CAPSTONE_CONTENT_KIND,
    async import(ctx: ImportContext): Promise<ImportResult> {
      const sub = ctx.subAssets[0];
      if (sub === undefined) return { ok: true, value: { assets: [], sourceDependencies: [] } };
      const source = await ctx.readSource();
      if (!source.ok) return { ok: true, value: { assets: [], sourceDependencies: [] } };
      const parsed = JSON.parse(new TextDecoder().decode(source.value)) as Omit<CapstoneContent, 'kind'>;
      const payload: CapstoneContent = {
        kind: CAPSTONE_CONTENT_KIND,
        title: parsed.title,
        version: parsed.version,
        markers: parsed.markers,
      };
      return {
        ok: true,
        value: {
          assets: [{
            guid: sub.guid,
            kind: CAPSTONE_CONTENT_KIND,
            name: 'm8-capstone-content',
            payload: payload as unknown as ImportedAsset['payload'],
            refs: [],
            artifacts: {
              payload: {
                mediaType: 'application/json',
                assetCodec: { name: 'm8-capstone-json', version: '1' },
                bytes: source.value,
              },
            },
          }],
          sourceDependencies: [],
        },
      };
    },
  };
}

export function capstoneContentLoader(): Loader<CapstoneContent> {
  return {
    kind: CAPSTONE_CONTENT_KIND,
    load(payload: Record<string, unknown>, _refs: readonly string[] | undefined, _ctx: LoadContext): LoaderOutput<CapstoneContent> {
      return payload as unknown as CapstoneContent;
    },
  };
}
