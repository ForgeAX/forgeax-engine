import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';

const guid = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const binding = {
  scopeId: 'game-a',
  generation: 4,
  status: 'ready',
  importUrlBase: '/preview/__pack/scopes/game-a/4/import/',
} as const;

afterEach(() => vi.unstubAllGlobals());

describe('explicit development import transport', () => {
  it('posts the encoded GUID to the bound generation and returns inline publication rows', async () => {
    const entries = [{ guid, kind: 'mesh', sourcePath: 'mesh.glb' }];
    const fetch = vi.fn(async () => Response.json(entries));
    vi.stubGlobal('fetch', fetch);
    const transport = createDevImportTransport(binding);
    expect(await transport.fetchPack('asset/with space', binding)).toEqual({ ok: true, entries });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/preview/__pack/scopes/game-a/4/import/asset%2Fwith%20space',
      { method: 'POST' },
    );
  });

  it.each([
    new Response(null, { status: 204 }),
    Response.json({}),
  ])('accepts a successful response without inline rows', async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    expect(await createDevImportTransport(binding).fetchPack(guid, binding)).toEqual({ ok: true });
  });

  it('reports unsuccessful HTTP and network results without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await createDevImportTransport(binding).fetchPack(guid, binding)).toEqual({ ok: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(await createDevImportTransport(binding).fetchPack(guid, binding)).toEqual({ ok: false });
  });

  it('rejects absent, inactive, foreign and stale bindings before a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createDevImportTransport().fetchPack(guid, binding)).toEqual({ ok: false });
    expect(await createDevImportTransport(binding).fetchPack(guid)).toEqual({ ok: false });
    const scopes: Pick<RuntimeAssetBinding, 'scopeId' | 'generation' | 'status'>[] = [
      { ...binding, generation: 3 },
      { ...binding, scopeId: 'another-game' },
      { ...binding, status: 'unavailable' },
    ];
    for (const scope of scopes) {
      expect(await createDevImportTransport(binding).fetchPack(guid, scope)).toEqual({ ok: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
