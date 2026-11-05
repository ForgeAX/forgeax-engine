import { deserialize, Serializer } from 'node:v8';
import { bakeSources, model } from '@forgeax/engine/modeling';
import type { ByteCache, TextureAsset } from '@forgeax/engine/types';
import { describe, expect, it } from 'vitest';
import { convoyFinishKey, readConvoyFinish, writeConvoyFinish, type ConvoyFinish } from '../convoy-finish-cache.ts';
import { createConvoyCooker } from '../convoy-finish.ts';
import { convoyBakeSettings } from '../convoy-model.ts';

function store() {
  const entries = new Map<string, Uint8Array>();
  const cache: ByteCache = {
    get: key => entries.get(key),
    put: (key, bytes) => { entries.set(key, bytes.slice()); },
  };
  return { entries, cache };
}

function finished(): ConvoyFinish {
  const names = ['normal', 'ormh', 'baseColor', 'emissive', 'coat'];
  const textures = Object.fromEntries(names.map((name, i) => [name, {
    kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    data: new Uint8Array(64).fill(i * 10), mips: { kind: 'packed', levelCount: 1 },
  } satisfies TextureAsset]));
  const facts = Object.fromEntries(names.filter(name => name !== 'coat').map(name =>
    [name, { inputFingerprint: `native:${name}`, refs: [], artifacts: {} }]));
  return { textures, facts };
}

describe('Convoy producer-owned finished texture cache', () => {
  it('keys plain values independently of object order without collapsing invalid inputs', () => {
    expect(convoyFinishKey({ a: 1, b: [2, 3] })).toBe(convoyFinishKey({ b: [2, 3], a: 1 }));
    expect(convoyFinishKey(-0)).not.toBe(convoyFinishKey(0));
    expect(convoyFinishKey(undefined)).not.toBe(convoyFinishKey(null));
    for (const value of [NaN, Infinity, () => 0, new Date()]) expect(() => convoyFinishKey(value)).toThrow();
  });

  it('restores every byte and fact with independent per-texture backing storage', () => {
    const { cache } = store(), key = convoyFinishKey('recipe:1'), value = finished();
    writeConvoyFinish(cache, key, value);
    const restored = readConvoyFinish(cache, key)!;
    expect(restored).toEqual(value);
    expect(new Set(Object.values(restored.textures).map(t => t.data.buffer)).size).toBe(5);
    for (const texture of Object.values(restored.textures)) expect(texture.data.buffer.byteLength).toBe(texture.data.byteLength);
    (restored.textures.normal!.data as Uint8Array)[0] = 255;
    expect(readConvoyFinish(cache, key)).toEqual(value);
  });

  it('rejects altered pixels, mismatched input keys and incomplete facts', () => {
    const { cache, entries } = store(), key = convoyFinishKey('recipe:1');
    writeConvoyFinish(cache, key, finished());
    const other = convoyFinishKey('recipe:2');
    expect(other).not.toBe(key);
    entries.set(other, entries.get(key)!);
    expect(readConvoyFinish(cache, other)).toBeUndefined();
    const record = deserialize(entries.get(key)!) as { value: ConvoyFinish };
    (record.value.textures.normal!.data as Uint8Array)[0] ^= 1;
    const serializer = new Serializer();
    serializer.writeHeader(); serializer.writeValue(record);
    entries.set(key, serializer.releaseBuffer());
    expect(readConvoyFinish(cache, key)).toBeUndefined();
    writeConvoyFinish(cache, key, { ...finished(), facts: {} });
    expect(readConvoyFinish(cache, key)).toBeUndefined();
  });

  it('a fresh cooker restores the final native product without reopening the raw bake', async () => {
    const base = model(); base.box({ size: [1, 1, 1] });
    expect(base.uv.auto({ resolution: 16, padding: 1 }).status).toBe('ok');
    const baked = bakeSources({ base, detail: base, ...convoyBakeSettings(16), resolution: 16, key: 'cache' });
    if (!baked.ok) throw baked.error;
    const source = baked.value['texture/cache-normal']!.source as Record<string, unknown>;
    const { cache, entries } = store();
    const firstGuid = '019fb7ce-4200-7000-8000-0000000cac0e';
    const first = await createConvoyCooker().cook({ guid: firstGuid, source }, { cache });
    expect(entries.size).toBe(2);
    const rawKey = entries.keys().next().value!;
    const finalOnly: ByteCache = {
      get(key) { if (key === rawKey) throw new Error('raw bake reopened'); return entries.get(key); },
      put() { throw new Error('finished product recomputed'); },
    };
    const nextGuid = '019fb7ce-4200-7000-8000-0000000cac0f';
    const restored = await createConvoyCooker().cook({ guid: nextGuid, source }, { cache: finalOnly });
    expect(restored).toEqual({ ...first, guid: nextGuid });
    expect(await createConvoyCooker().cook({ guid: firstGuid, source })).toEqual(first);
    await expect(createConvoyCooker().cook({ guid: nextGuid, source: { ...source, base: 'invalid' } }, { cache })).rejects.toThrow();
  });
});


it('coalesces concurrent texture outputs into one finished atlas job', { timeout: 30000 }, async () => {
  const base = model(); base.box({ size: [1, 1, 1] });
  expect(base.uv.auto({ resolution: 16, padding: 1 }).status).toBe('ok');
  const sources = bakeSources({ base, detail: base, ...convoyBakeSettings(16), resolution: 16, key: 'concurrent' }).unwrap();
  const source = sources['texture/concurrent-normal']!.source as Record<string, unknown>;
  const entries = new Map<string, Uint8Array>();
  let finishedWrites = 0;
  const cache: ByteCache = {
    get: key => entries.get(key),
    put(key, bytes) {
      if (key.startsWith('convoy-finish/1:')) finishedWrites++;
      entries.set(key, bytes.slice());
    },
  };
  const cooker = createConvoyCooker();
  const names = ['normal', 'ormh', 'baseColor', 'emissive', 'coat'];
  const results = await Promise.all(names.map(finishMap => cooker.cook({
    guid: '019fb7ce-4200-7000-8000-0000000cac0e',
    source: { ...source, map: finishMap === 'coat' ? 'ormh' : finishMap, finishMap },
  }, { cache })));
  expect(finishedWrites).toBe(1);
  for (const result of results) expect(result.payload.shape.extent).toEqual({ width: 16, height: 16 });
});


it('releases a failed shared job so the same recipe can recover', { timeout: 30000 }, async () => {
  const base = model(); base.box({ size: [1, 1, 1] });
  expect(base.uv.auto({ resolution: 16, padding: 1 }).status).toBe('ok');
  const source = bakeSources({ base, detail: base, ...convoyBakeSettings(16), resolution: 16, key: 'retry' }).unwrap()['texture/retry-normal']!.source;
  const { entries } = store();
  let interrupted = true;
  const cache: ByteCache = {
    get(key) { if (interrupted) { interrupted = false; throw new Error('interrupted cache read'); } return entries.get(key); },
    put(key, bytes) { entries.set(key, bytes.slice()); },
  };
  const cooker = createConvoyCooker();
  const input = { guid: '019fb7ce-4200-7000-8000-0000000cac0e', source };
  await expect(Promise.all([cooker.cook(input, { cache }), cooker.cook(input, { cache })])).rejects.toThrow('interrupted cache read');
  expect((await cooker.cook(input, { cache })).payload.shape.extent).toEqual({ width: 16, height: 16 });
});

it('re-cooks changed parameters and restores the previous recipe from DDC', { timeout: 30000 }, async () => {
  const base = model(); base.box({ size: [1, 1, 1] });
  expect(base.uv.auto({ resolution: 16, padding: 1 }).status).toBe('ok');
  const source = bakeSources({ base, detail: base, ...convoyBakeSettings(16), resolution: 16, key: 'parameters' }).unwrap()['texture/parameters-normal']!.source as Record<string, unknown>;
  const { cache, entries } = store(), cooker = createConvoyCooker();
  const input = { guid: '019fb7ce-4200-7000-8000-0000000cac0e', source };
  const initial = await cooker.cook(input, { cache });
  const changed = await cooker.cook({ ...input, source: { ...source, params: { ...source.params as object, resolution: 32 } } }, { cache });
  expect(changed.payload.shape.extent).toEqual({ width: 32, height: 32 });
  expect(changed.inputFingerprint).not.toBe(initial.inputFingerprint);
  expect([...entries.keys()].filter(key => key.startsWith('convoy-finish/1:'))).toHaveLength(2);
  const restored = await createConvoyCooker().cook(input, { cache });
  expect(restored).toEqual(initial);
});
