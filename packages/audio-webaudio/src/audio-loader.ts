import { admitAudioStream } from '@forgeax/engine-audio';
import { AssetError, type Loader, type LoaderAsyncResult } from '@forgeax/engine-types';
import { decodeAudioClipBytes } from './clip-loader';

/** Loads an audio catalog row through the browser's native decoder. */
export const audioLoader: Loader = {
  kind: 'audio',
  loadPack(input): Promise<LoaderAsyncResult> {
    if (input.kind !== 'audio') {
      return Promise.resolve({
        ok: false,
        error: new AssetError({
          code: 'asset-parse-failed',
          expected: "Pack v2 loader input with kind 'audio'",
          hint: 'pass the asset-local audio envelope to the audio loader',
          detail: { sourcePath: input.guid },
        }),
      });
    }
    const locator = input.streams?.source;
    if (locator) {
      const stream = admitAudioStream(input.payload.stream, locator.descriptor, locator.url);
      if (stream)
        return Promise.resolve({
          ok: true,
          value: { kind: 'audio', sourceKey: input.guid, mediaType: 'audio/wav', stream },
        });
      return Promise.resolve({
        ok: false,
        error: new AssetError({
          code: 'asset-parse-failed',
          expected: 'a verified PCM16 stream descriptor and HTTP locator',
          hint: 'recook the stream source and publish it over HTTP with Range support',
        }),
      });
    }
    const source = input.artifacts.source;
    const payloadMediaType =
      typeof input.payload.mediaType === 'string' ? input.payload.mediaType : undefined;
    if (
      source === undefined ||
      !source.descriptor.mediaType.startsWith('audio/') ||
      payloadMediaType !== source.descriptor.mediaType
    ) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'asset-artifact-media-unsupported',
          expected: 'an asset-local source artifact with an audio/* mediaType',
          hint: 'declare the audio source artifact with a supported mediaType and re-cook',
          detail: {
            guid: input.guid,
            artifactKey: 'source',
            observed: payloadMediaType ?? source?.descriptor.mediaType ?? 'missing',
            expected: 'payload.mediaType matching the audio/* source artifact',
          },
        },
      });
    }
    return decodeAudioClipBytes(input.guid, source.bytes, payloadMediaType as `audio/${string}`);
  },
  async load(): Promise<LoaderAsyncResult> {
    return {
      ok: false,
      error: new AssetError({
        code: 'asset-parse-failed',
        expected: 'Pack v2 audio input with an asset-local source artifact',
        hint: 're-cook the audio source into the Pack v2 asset envelope',
        detail: { sourcePath: 'audio-loader-input' },
      }),
    };
  },
};
