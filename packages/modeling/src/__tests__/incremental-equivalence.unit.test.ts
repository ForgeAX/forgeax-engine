import { readFileSync } from 'node:fs';
import type { ByteCache } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  autoBakeSample,
  DETERMINISM_FIXTURES,
  digestOf,
  type FixtureDigest,
  fixtureDigests,
} from './determinism-fixtures';

const GOLDEN = JSON.parse(
  readFileSync(new URL('./golden/determinism.json', import.meta.url), 'utf8'),
) as Record<string, FixtureDigest>;

function store(): ByteCache & { entries: Map<string, Uint8Array>; hits: number; puts: number } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    hits: 0,
    puts: 0,
    get(key) {
      const found = entries.get(key);
      if (found !== undefined) this.hits++;
      return found;
    },
    put(key, bytes) {
      this.puts++;
      entries.set(key, bytes);
    },
  };
}

// Incremental builds (a warm compute-job cache, an edit that is then reverted) must
// produce the cold bytes; the golden digests are the cold reference.
describe('incremental equivalence (AS-12-T2)', { timeout: 120_000 }, () => {
  it('a build served from the compute cache has the golden FXEM and MeshAsset digests', async () => {
    const cache = store();
    const filled = await fixtureDigests(cache);
    expect(cache.puts).toBeGreaterThan(0);
    expect(cache.hits).toBe(0);
    const puts = cache.puts;
    const warm = await fixtureDigests(cache);
    expect(cache.puts).toBe(puts);
    expect(cache.hits).toBeGreaterThan(0);
    expect(Object.keys(warm)).toEqual(Object.keys(DETERMINISM_FIXTURES));
    expect(filled).toEqual(GOLDEN);
    expect(warm).toEqual(GOLDEN);
  });

  it('an edit recomputes, and reverting it returns to the cold digests from the cache', async () => {
    const cache = store();
    expect(await digestOf(autoBakeSample(cache))).toEqual(GOLDEN['bake-vertex']);
    const base = cache.puts;
    const edited = await digestOf(autoBakeSample(cache, 8));
    expect(edited.fxem).not.toBe(GOLDEN['bake-vertex']?.fxem);
    expect(cache.puts).toBe(base + 1);
    const hits = cache.hits;
    expect(await digestOf(autoBakeSample(cache))).toEqual(GOLDEN['bake-vertex']);
    expect(cache.hits).toBe(hits + 1);
    expect(cache.puts).toBe(base + 1);
  });
});
