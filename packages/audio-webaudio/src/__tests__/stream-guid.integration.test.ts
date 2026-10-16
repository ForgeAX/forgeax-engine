import {
  AssetRegistry,
  createAssetRegistry,
  createCatalogSource,
} from '@forgeax/engine-assets-runtime';
import { audioContribution } from '@forgeax/engine-audio';
import { createRuntimePackPublication } from '@forgeax/engine-pack/build';
import { expect, it, vi } from 'vitest';
import { audioLoader } from '../audio-loader';
import { indexPcmWave } from '../pcm-wave';
import { toneWav } from './support-tone';

it('loads a verified stream through GUID without reading the encoded artifact', async () => {
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stream = await indexPcmWave(toneWav());
  const registry = new AssetRegistry({} as never, undefined, [audioLoader]);
  registry.configurePackIndex('https://audio.test/pack-index.json');
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('pack-index.json'))
      return new Response(
        JSON.stringify([
          { guid, kind: 'audio', packageUrl: 'bgm.pack.json', sourcePath: 'bgm.wav' },
        ]),
      );
    if (!url.endsWith('bgm.pack.json'))
      throw new Error('stream loader fetched the complete artifact');
    return new Response(
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid,
            kind: 'audio',
            payload: { kind: 'audio', mediaType: 'audio/wav', stream },
            refs: [],
            artifacts: {
              source: {
                path: 'bgm.wav',
                mediaType: 'audio/wav',
                delivery: 'stream',
                contentEncoding: 'identity',
                byteLength: toneWav().length,
                integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}` },
                assetCodec: { name: 'forgeax-pcm16-stream', version: '1' },
              },
            },
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const loaded = await registry.loadByGuid(registry.parseGuid(guid));
    expect(loaded).toMatchObject({
      ok: true,
      value: { kind: 'audio', stream: { url: 'https://audio.test/bgm.wav' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (loaded.ok) expect(loaded.value).not.toHaveProperty('bytes');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('admits a streamed GUID through the decoder registry without populating its artifact cache', async () => {
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stream = await indexPcmWave(toneWav());
  const { pack, publication } = createRuntimePackPublication({
    pack: {
      assets: [
        {
          guid,
          kind: 'audio',
          payload: { kind: 'audio', mediaType: 'audio/wav', stream },
          refs: [],
          artifacts: {
            source: {
              path: 'bgm.wav',
              mediaType: 'audio/wav',
              delivery: 'stream',
              contentEncoding: 'identity',
              byteLength: toneWav().length,
              integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}` },
              assetCodec: { name: 'forgeax-pcm16-stream', version: '1' },
            },
          },
        },
      ],
    },
    scopeId: 'stream-test',
    sourcePath: 'bgm.wav',
    sourceRevision: 'r1',
    packageUrl: 'https://audio.test/bgm.pack.json',
    generation: 1,
  });
  const fetcher = vi.fn(async () => Response.json(pack));
  const registry = createAssetRegistry({
    scopeId: 'stream-test',
    catalog: createCatalogSource({
      entries: [
        {
          guid,
          kind: 'audio',
          sourcePath: 'bgm.wav',
          packageUrl: 'https://audio.test/bgm.pack.json',
          publication,
        },
      ],
    }),
    fetcher,
  });
  registry.installDecoder(audioContribution.kind, audioContribution.decoder);
  try {
    expect(await registry.load(guid, 'audio')).toMatchObject({
      ok: true,
      value: { stream: { url: 'https://audio.test/bgm.wav' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().pending).toBe(0);
  } finally {
    registry.dispose();
  }
});
