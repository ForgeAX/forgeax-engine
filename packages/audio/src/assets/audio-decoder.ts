import {
  type AssetDecoderContribution,
  AssetError,
  type AssetKind,
  type AudioClipAsset,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { admitAudioStream, validAudioStream } from '../audio-stream';

/** Shared admission for loaded and code-created content; the host owns native decoding. */
function prepareRuntimeAudioClip(value: AudioClipAsset): Result<AudioClipAsset, AssetError> {
  const valid =
    value.kind === 'audio' &&
    typeof value.sourceKey === 'string' &&
    value.sourceKey.length > 0 &&
    typeof value.mediaType === 'string' &&
    /^audio\/[a-zA-Z0-9.+-]+$/.test(value.mediaType) &&
    (value.stream === undefined
      ? value.bytes instanceof Uint8Array && value.bytes.byteLength > 0
      : value.bytes === undefined &&
        value.mediaType === 'audio/wav' &&
        validAudioStream(value.stream) &&
        typeof value.stream.url === 'string');
  return valid
    ? ok(value)
    : err(
        new AssetError({
          code: 'asset-invalid-value',
          expected:
            'audio identity, media type and either non-empty bytes or a complete HTTP PCM stream',
          hint: 'supply complete audio content through its runtime owner',
        }),
      );
}

export const audioContribution: AssetDecoderContribution<AudioClipAsset, 'audio'> = {
  kind: { kind: 'audio' } as AssetKind<AudioClipAsset, 'audio'>,
  consumer: 'AudioBackend',
  decoder: {
    prepare: prepareRuntimeAudioClip,
    async decode({ envelope, artifacts }) {
      const invalid = () =>
        err({
          code: 'asset-package-invalid' as const,
          expected: 'complete audio source bytes or a verified PCM16 HTTP stream',
          hint: 'recook the audio source with its media type and delivery descriptor',
          detail: { guid: envelope.guid, reason: 'audio owner validation failed' },
        });
      const payload: unknown = envelope.payload;
      if (payload === null || typeof payload !== 'object') return invalid();
      const source = payload as Record<string, unknown>;
      if (source.kind !== 'audio' || typeof source.mediaType !== 'string') return invalid();
      const body = envelope.artifacts.body ?? envelope.artifacts.source;
      if (
        body !== undefined &&
        (!body.mediaType.startsWith('audio/') || source.mediaType !== body.mediaType)
      )
        return err({
          code: 'asset-decode-failed',
          expected: 'payload.mediaType matching the audio/* source artifact',
          hint: 'recook the audio source with its correct media type',
          detail: {
            guid: envelope.guid,
            kind: 'audio',
            cause: {
              code: 'asset-artifact-media-unsupported',
              expected: body.mediaType,
              hint: 'match payload.mediaType to the verified artifact media type',
              detail: {
                artifactKey: envelope.artifacts.body ? 'body' : 'source',
                observed: String(source.mediaType),
              },
            },
          },
        });
      const sourceKey =
        typeof source.sourceKey === 'string' && source.sourceKey.length > 0
          ? source.sourceKey
          : envelope.guid;
      let candidate: AudioClipAsset;
      if (body?.delivery === 'stream') {
        const stream = admitAudioStream(source.stream, body, artifacts.locate?.(body) ?? '');
        if (stream === undefined) return invalid();
        candidate = { kind: 'audio', sourceKey, mediaType: 'audio/wav', stream };
      } else {
        let bytes =
          source.bytes instanceof Uint8Array
            ? source.bytes
            : Array.isArray(source.bytes) &&
                source.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
              ? Uint8Array.from(source.bytes as number[])
              : undefined;
        if (body !== undefined) {
          const read = await artifacts.read(body);
          if (!read.ok) return read;
          bytes = read.value;
        }
        if (bytes === undefined) return invalid();
        candidate = {
          kind: 'audio',
          sourceKey,
          mediaType: source.mediaType as `audio/${string}`,
          bytes,
        };
      }
      const prepared = prepareRuntimeAudioClip(candidate);
      return prepared.ok ? prepared : invalid();
    },
  },
};
