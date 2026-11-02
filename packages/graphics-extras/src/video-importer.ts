// Build-time video import keeps the encoded container bytes and publishes them
// as one streamed artifact. The payload never inlines video bytes: the runtime
// decoder resolves the artifact's published URL, and the Host provider plays it.

import {
  IMPORT_ERROR_HINTS,
  type ImportContext,
  ImportError,
  type ImportedAsset,
  type Importer,
  type ImportResult,
} from '@forgeax/engine-types';

/** Container extensions the browser `<video>` element decodes natively. */
export const VIDEO_SOURCE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
};

function videoMediaType(source: string): string | undefined {
  const lower = source.toLowerCase();
  const extension = Object.keys(VIDEO_SOURCE_MEDIA_TYPES).find((ext) => lower.endsWith(ext));
  return extension === undefined ? undefined : VIDEO_SOURCE_MEDIA_TYPES[extension];
}

function topologyError(ctx: ImportContext): ImportError | undefined {
  if (ctx.subAssets.length === 1 && ctx.subAssets[0]?.kind === 'video') return undefined;
  const actual =
    ctx.subAssets.length === 0
      ? 'subAssets[] is empty'
      : ctx.subAssets.map((sub, index) => `subAssets[${index}]=${sub.kind}:${sub.guid}`).join(', ');
  return new ImportError({
    code: 'source-validation-failed',
    expected: 'exactly one subAssets[] entry with kind "video"',
    actual,
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code: 'video-subasset-topology',
          severity: 'error',
          sourcePath: `${ctx.source}#subAssets`,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'video-required-single-output',
          expected: 'exactly one subAssets[] entry with kind "video"',
          actual,
          hint: 'declare exactly one video sub-asset and remove foreign or duplicate entries',
        },
      ],
    },
  });
}

async function importVideo(ctx: ImportContext): Promise<ImportResult> {
  const invalidTopology = topologyError(ctx);
  if (invalidTopology !== undefined) return { ok: false, error: invalidTopology };
  const mediaType = videoMediaType(ctx.source);
  if (mediaType === undefined)
    return {
      ok: false,
      error: new ImportError({
        code: 'source-validation-failed',
        expected: `a video container: ${Object.keys(VIDEO_SOURCE_MEDIA_TYPES).join(', ')}`,
        actual: ctx.source,
        hint: 'encode the clip as MP4 (H.264/AAC) or WebM (VP9/AV1) for browser playback',
        detail: { diagnostics: [] },
      }),
    };
  const read = await ctx.readSource();
  if (!read.ok)
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable source file at meta.source "${ctx.source}"`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: {
          source: ctx.source,
          reason: read.error instanceof Error ? read.error.message : String(read.error),
        },
      }),
    };
  const sub = ctx.subAssets[0] as ImportContext['subAssets'][number];
  const asset: ImportedAsset = {
    guid: sub.guid,
    kind: 'video',
    payload: { kind: 'video', mediaType } as unknown as ImportedAsset['payload'],
    refs: [],
    artifacts: {
      source: {
        delivery: 'stream',
        mediaType,
        assetCodec: { name: 'browser-video', version: '1' },
        bytes: read.value,
      },
    },
  };
  return { ok: true, value: { assets: [asset], sourceDependencies: [ctx.source] } };
}

/**
 * The video {@link Importer}: `.mp4`, `.m4v`, `.webm` and `.ogv` sources become
 * one `VideoAsset` whose container is published as a streamed artifact. The
 * runtime `videoContribution` decoder turns that artifact into the asset's
 * browser URL, so a material texture slot and a `VideoSourceProvider` consume
 * it exactly like a runtime `assets.create({ kind: 'video', url })` asset.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { videoImporter } from '@forgeax/engine-graphics-extras/video-importer';
 * const importers = new ImporterRegistry();
 * importers.register(videoImporter);
 * ```
 */
export const videoImporter: Importer = {
  key: 'video',
  import: importVideo,
  capabilities: {
    sourceFormats: [
      {
        extensions: Object.keys(VIDEO_SOURCE_MEDIA_TYPES),
        kind: 'video',
        sourceKey: 'video:video',
        importSettings: {},
      },
    ],
  },
};
