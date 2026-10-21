import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { audioContribution } from '@forgeax/engine-audio';
import { createRuntimePackPublication } from '@forgeax/engine-pack/build';
import { expect, it, vi } from 'vitest';
import { indexPcmWave } from '../pcm-wave';
import { toneWav } from './support-tone';

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
  const registry = new AssetRegistry({
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
    expect(registry.read((await registry.load(guid, 'audio')).unwrap()).unwrap()).toMatchObject({
      stream: { url: 'https://audio.test/bgm.wav' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registry.inspectSource()?.pending).toBe(0);
  } finally {
    registry.dispose();
  }
});
