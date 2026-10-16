// Build-time audio import preserves encoded bytes; the Host owns native decode.
// The validated topology names exactly one output under its author-owned GUID.

import {
  IMPORT_ERROR_HINTS,
  type ImportContext,
  ImportError,
  type ImportedAsset,
  type Importer,
  type ImportResult,
} from '@forgeax/engine-types';

/** Audio output identity is semantic and independent of source path/index. */
export function sourceKeyForAudioOutput(kind = 'audio'): string | undefined {
  const normalizedKind = kind.trim();
  return normalizedKind.length === 0 ? undefined : `audio:${normalizedKind}`;
}

function audioMediaType(source: string): string {
  const lower = source.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}

function validateAudioOutputTopology(ctx: ImportContext): ImportError | undefined {
  if (ctx.subAssets.length === 1 && ctx.subAssets[0]?.kind === 'audio') return undefined;

  const actual =
    ctx.subAssets.length === 0
      ? 'subAssets[] is empty'
      : ctx.subAssets.map((sub, index) => `subAssets[${index}]=${sub.kind}:${sub.guid}`).join(', ');

  return new ImportError({
    code: 'source-validation-failed',
    expected: 'exactly one subAssets[] entry with kind "audio"',
    actual,
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code: 'audio-subasset-topology',
          severity: 'error',
          sourcePath: `${ctx.source}#subAssets`,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'audio-required-single-output',
          expected: 'exactly one subAssets[] entry with kind "audio"',
          actual,
          hint: 'declare exactly one audio sub-asset and remove foreign or duplicate entries',
        },
      ],
    },
  });
}

import { indexPcmWave } from './pcm-wave';

async function importAudio(ctx: ImportContext): Promise<ImportResult> {
  const topologyError = validateAudioOutputTopology(ctx);
  if (topologyError !== undefined) return { ok: false, error: topologyError };

  // Probe the source is readable so a missing file fails the build (the runner
  // already probes, but this keeps the importer self-validating, P3). No decode
  // happens here -- decodeAudioData is the runtime loader's job.
  const read = await ctx.readSource();
  if (!read.ok) {
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
  }

  const sub = ctx.subAssets[0] as ImportContext['subAssets'][number];
  const streaming = ctx.importSettings.playback === 'stream';
  const mediaType = streaming ? 'audio/wav' : audioMediaType(ctx.source);
  let stream: Awaited<ReturnType<typeof indexPcmWave>> | undefined;
  if (
    ctx.importSettings.playback !== undefined &&
    ctx.importSettings.playback !== 'stream' &&
    ctx.importSettings.playback !== 'buffer'
  )
    return {
      ok: false,
      error: new ImportError({
        code: 'source-validation-failed',
        expected: "playback 'buffer' or 'stream'",
        hint: 'correct the audio Meta importSettings.playback',
        detail: { diagnostics: [] },
      }),
    };
  if (streaming) {
    try {
      stream = await indexPcmWave(read.value);
    } catch (cause) {
      return {
        ok: false,
        error: new ImportError({
          code: 'source-validation-failed',
          expected: 'PCM16 WAV with 1/2 channels at 8..96 kHz and a bounded stream index',
          hint: 'encode the long BGM/dialogue as PCM16 WAV or select buffered playback',
          detail: {
            diagnostics: [
              {
                code: 'audio-stream-format',
                severity: 'error',
                sourcePath: ctx.source,
                sourceRange: { start: 0, end: 0, line: 1, column: 1 },
                rule: 'pcm16-stream',
                expected: 'RIFF PCM16 WAV',
                actual: String(cause),
                hint: 'recook a supported source',
              },
            ],
          },
        }),
      };
    }
  }
  const asset: ImportedAsset = {
    guid: sub.guid,
    kind: 'audio',
    payload: {
      kind: 'audio',
      mediaType,
      source: ctx.source,
      ...(stream ? { stream } : {}),
    } as unknown as ImportedAsset['payload'],
    refs: [],
    artifacts: {
      source: {
        mediaType,
        ...(stream ? { delivery: 'stream' as const } : {}),
        assetCodec: { name: stream ? 'forgeax-pcm16-stream' : 'browser-audio', version: '1' },
        bytes: read.value,
      },
    },
  };
  return { ok: true, value: { assets: [asset], sourceDependencies: [ctx.source] } };
}

/**
 * The audio {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'audio'` sidecars here.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
 * const importers = new ImporterRegistry();
 * importers.register(audioImporter);
 * ```
 */
export const audioImporter: Importer = {
  key: 'audio',
  import: importAudio,
};
