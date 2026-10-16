import { describe, expect, it } from 'vitest';
import { MaterialGenerationCache } from '../material/generation-cache.js';

describe('material generation cache', () => {
  it('reuses promises by material GUID and artifacts by specialization key', async () => {
    const cache = new MaterialGenerationCache();
    const first = cache.resolve('mat-a', 'key-a', async () => ({ value: 1 }));
    const second = cache.resolve('mat-a', 'key-a', async () => ({ value: 2 }));

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ value: 1 });
    cache.storeArtifact('key-a', Object.freeze({ bytes: new Uint8Array([1]) }));
    expect(cache.getArtifact('key-a')).toEqual({ bytes: new Uint8Array([1]) });
  });

  it('allows distinct authored GUIDs to share one artifact', () => {
    const cache = new MaterialGenerationCache();
    const artifact = Object.freeze({ bytes: new Uint8Array([1]) });

    cache.storeArtifact('key-a', artifact);
    cache.linkResolved('mat-a', 'key-a');
    cache.linkResolved('mat-b', 'key-a');

    expect(cache.getResolvedKey('mat-a')).toBe('key-a');
    expect(cache.getResolvedKey('mat-b')).toBe('key-a');
    expect(cache.getArtifact('key-a')).toBe(artifact);
  });

  it('evicts a published specialization when a tracked dependency advances', async () => {
    const cache = new MaterialGenerationCache();
    let calls = 0;
    const load = () =>
      cache.loadWithGeneration('mat-a', ['shader/a'], async (generation) => ({
        generation,
        value: ++calls,
      }));

    const first = await cache.resolve('mat-a', 'key-a', load);
    expect(first).toMatchObject({ ok: true, value: 1 });

    cache.bump('shader/a');
    const second = await cache.resolve('mat-a', 'key-a', load);
    expect(second).toMatchObject({ ok: true, value: 2 });
    expect(calls).toBe(2);
  });
  it('keeps a replacement promise when an evicted request fails late', async () => {
    const cache = new MaterialGenerationCache();
    await cache.loadWithGeneration('mat-a', ['shader/a'], async (generation) => ({
      generation,
      value: 0,
    }));
    let rejectOld!: (reason: Error) => void;
    const first = cache.resolve(
      'mat-a',
      'key-a',
      () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    );
    cache.linkResolved('mat-a', 'key-a');
    cache.bump('shader/a');
    const replacement = cache.resolve('mat-a', 'key-a', async () => 2);
    rejectOld(new Error('late failure'));
    await expect(first).rejects.toThrow('late failure');
    expect(cache.resolve('mat-a', 'key-a', async () => 3)).toBe(replacement);
    expect(cache.getResolvedKey('mat-a')).toBe('key-a');
  });

  it('replaces dependency membership without evicting on the old dependency', async () => {
    const cache = new MaterialGenerationCache();
    for (const dependency of ['shader/old', 'shader/new']) {
      await cache.loadWithGeneration('mat-a', [dependency], async (generation) => ({
        generation,
        value: 0,
      }));
    }
    const first = cache.resolve('mat-a', 'key-a', async () => 1);
    cache.bump('shader/old');
    expect(cache.resolve('mat-a', 'key-a', async () => 2)).toBe(first);
    cache.bump('shader/new');
    expect(cache.resolve('mat-a', 'key-a', async () => 3)).not.toBe(first);
  });
});
