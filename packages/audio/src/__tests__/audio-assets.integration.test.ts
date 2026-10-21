import { createHash } from 'node:crypto';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { AudioClipAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { audioContribution } from '../assets/audio-decoder';

function fixture(mediaType: string | undefined, artifactMedia = 'audio/ogg') {
  const guid = '00000000-0000-7000-8000-000000000911';
  const bytes = Uint8Array.of(1, 2, 3);
  const packageUrl = 'https://audio.invalid/clip.pack.json';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'clip.ogg',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'audio',
          payload: { kind: 'audio', ...(mediaType === undefined ? {} : { mediaType }) },
          refs: [],
          artifacts: {
            source: {
              path: 'clip.ogg',
              mediaType: artifactMedia,
              contentEncoding: 'identity',
              byteLength: bytes.byteLength,
              integrity: {
                algorithm: 'sha256',
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
            },
          },
        },
      ],
    },
  });
  const fetch = vi.fn(async (url: RequestInfo | URL) =>
    String(url) === packageUrl ? Response.json(produced.pack) : new Response(bytes.slice()),
  );
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: [
        {
          guid,
          kind: 'audio',
          sourcePath: 'clip.ogg',
          packageUrl,
          publication: produced.publication,
        },
      ],
      fetch,
    }),
  });
  const lease = assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  return { assets, guid, bytes, fetch, lease };
}

it('loads authoritative audio bytes and media through the ordinary source owner', async () => {
  const { assets, guid, bytes, fetch } = fixture('audio/ogg');
  try {
    const handle = (await assets.load(guid, 'audio')).unwrap();
    const content = assets.read(handle).unwrap();
    expect(content).toEqual({ kind: 'audio', sourceKey: guid, mediaType: 'audio/ogg', bytes });
    content.bytes?.fill(0);
    expect(assets.read(handle).unwrap().bytes).toEqual(bytes);
    expect((await assets.load(guid, 'audio')).unwrap()).toBe(handle);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    assets.dispose();
  }
});

it.each([
  [undefined, 'audio/ogg'],
  ['audio/ogg', 'audio/wav'],
  ['audio/ogg', 'application/octet-stream'],
])('rejects mismatched persisted audio media before reading the body (%s, %s)', async (media, artifactMedia) => {
  const { assets, guid, fetch } = fixture(media, artifactMedia);
  try {
    const loaded = await assets.load(guid, 'audio');
    expect(loaded.ok).toBe(false);
    if (!loaded.ok)
      expect(loaded.error.code).toBe(
        media === undefined ? 'asset-package-invalid' : 'asset-decode-failed',
      );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    assets.dispose();
  }
});

it('validates code-created and replacement audio atomically through the active owner', () => {
  const assets = new AssetRegistry();
  const value: AudioClipAsset = {
    kind: 'audio',
    sourceKey: 'runtime-tone',
    mediaType: 'audio/wav',
    bytes: Uint8Array.of(1, 2),
  };
  expect(assets.create(value).ok).toBe(false);
  const lease = assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  try {
    const handle = assets.create(value).unwrap();
    const fixed = assets.snapshot(handle).unwrap();
    for (const invalid of [
      { mediaType: 'text/plain' },
      { bytes: new Uint8Array() },
      { stream: {} },
      { sourceKey: '' },
    ]) {
      expect(assets.update(handle, invalid as never).ok).toBe(false);
      expect(assets.replace(handle, { ...value, ...invalid } as never).ok).toBe(false);
      expect(assets.read(handle).unwrap()).toEqual(value);
    }
    assets.update(handle, { bytes: Uint8Array.of(3, 4) }).unwrap();
    expect(assets.read(handle).unwrap().bytes).toEqual(Uint8Array.of(3, 4));
    expect(fixed.read<AudioClipAsset>(handle).unwrap().bytes).toEqual(value.bytes);
    fixed.dispose();
    lease.dispose();
    expect(assets.update(handle, { sourceKey: 'new' }).ok).toBe(false);
    expect(assets.read(handle).ok).toBe(true);
  } finally {
    assets.dispose();
  }
});
