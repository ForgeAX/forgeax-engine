import { utimesSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectNativeCookGarbage, createNativeCookCache } from '../native-cook-cache.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'native-cook-cache-'));
  roots.push(path);
  return path;
}

describe('createNativeCookCache', () => {
  it('round-trips opaque bytes per namespace and survives a new store instance', async () => {
    const dir = await root();
    const a = createNativeCookCache(dir, 'modeling-mesh-job');
    const b = createNativeCookCache(dir, 'modeling-bake');
    expect(a.get('key')).toBeUndefined();
    a.put('key', new Uint8Array([1, 2, 3]));
    expect(a.get('key')).toEqual(new Uint8Array([1, 2, 3]));
    expect(b.get('key')).toBeUndefined();
    a.put('key', new Uint8Array([4]));
    expect(createNativeCookCache(dir, 'modeling-mesh-job').get('key')).toEqual(new Uint8Array([4]));
    expect(await readdir(join(dir, 'native-cook'))).toHaveLength(1);
  });

  it('treats an unwritable root as a miss without throwing', async () => {
    const dir = await root();
    const file = join(dir, 'occupied');
    await writeFile(file, 'not a directory');
    const store = createNativeCookCache(file, 'kind');
    expect(() => store.put('key', new Uint8Array([1]))).not.toThrow();
    expect(store.get('key')).toBeUndefined();
  });

  it('rejects an empty namespace and an invalid byte bound', () => {
    expect(() => createNativeCookCache('/tmp', '')).toThrow(TypeError);
    expect(() => createNativeCookCache('/tmp', 'kind', { maxBytes: -1 })).toThrow(RangeError);
  });

  it('sweeps least recently used entries past the bound; a recently read entry survives', async () => {
    const dir = await root();
    const big = createNativeCookCache(dir, 'kind', { maxBytes: 1e9 });
    const other = createNativeCookCache(dir, 'other', { maxBytes: 1e9 });
    for (const key of ['read', 'stale-a', 'stale-b']) big.put(key, new Uint8Array(100));
    other.put('stale-c', new Uint8Array(100));
    const files = (await readdir(join(dir, 'native-cook'), { recursive: true })).filter((f) =>
      /^[0-9a-f]{64}\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(f),
    );
    expect(files).toHaveLength(4);
    const old = new Date(Date.now() - 3_600_000);
    for (const f of files) utimesSync(join(dir, 'native-cook', f), old, old);
    expect(big.get('read')).toHaveLength(100);
    const bounded = createNativeCookCache(dir, 'kind', { maxBytes: 250 });
    bounded.put('fresh', new Uint8Array(100));
    expect(bounded.get('fresh')).toHaveLength(100);
    expect(bounded.get('read')).toHaveLength(100);
    expect(bounded.get('stale-a')).toBeUndefined();
    expect(bounded.get('stale-b')).toBeUndefined();
    expect(other.get('stale-c')).toBeUndefined();
    expect(collectNativeCookGarbage(dir, { maxBytes: 0 }).retainedBytes).toBe(0);
    expect(bounded.get('read')).toBeUndefined();
  });
});
