import {
  type AssetDecoderContribution,
  type AssetKind,
  type AudioClipAsset,
  err,
  ok,
} from '@forgeax/engine-types';
import { admitAudioStream } from '../audio-stream';

export const audioContribution: AssetDecoderContribution<AudioClipAsset, 'audio'> = {
  kind: { kind: 'audio' } as AssetKind<AudioClipAsset, 'audio'>,
  consumer: 'AudioBackend',
  decoder: {
    async decode({ envelope, artifacts }) {
      const payload = envelope.payload as unknown;
      if (payload !== null && typeof payload === 'object') {
        const source = payload as Record<string, unknown>;
        let bytes =
          source.bytes instanceof Uint8Array
            ? source.bytes
            : Array.isArray(source.bytes)
              ? Uint8Array.from(source.bytes as number[])
              : undefined;
        const body = envelope.artifacts.body ?? envelope.artifacts.source;
        if (body?.delivery === 'stream') {
          const stream = admitAudioStream(source.stream, body, artifacts.locate?.(body) ?? '');
          if (stream)
            return ok({ kind: 'audio', sourceKey: envelope.guid, mediaType: 'audio/wav', stream });
          return err({
            code: 'asset-package-invalid',
            expected: 'a validated PCM16 stream index and HTTP locator',
            hint: 'recook the streaming source and use an HTTP Range delivery host',
            detail: { guid: envelope.guid, reason: 'invalid audio stream' },
          });
        }
        if (body !== undefined) {
          const bodyBytes = await artifacts.read(body);
          if (!bodyBytes.ok) return bodyBytes;
          bytes = bodyBytes.value;
        }
        if (
          source.kind === 'audio' &&
          typeof source.mediaType === 'string' &&
          source.mediaType.startsWith('audio/') &&
          bytes !== undefined &&
          bytes.byteLength > 0
        ) {
          return ok({
            kind: 'audio',
            sourceKey:
              typeof source.sourceKey === 'string' && source.sourceKey.length > 0
                ? source.sourceKey
                : envelope.guid,
            mediaType: source.mediaType as `audio/${string}`,
            bytes,
          });
        }
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'an audio payload with non-empty source bytes and audio mediaType',
        hint: 'recook the audio source with a browser-supported media type',
        detail: { guid: envelope.guid, reason: 'audio owner validation failed' },
      });
    },
  },
};
