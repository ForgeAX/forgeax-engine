import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCookCache } from '@forgeax/engine-ddc';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The build child's registry hands each cooker its DDC store. Only parallel cookers
// reach that store from overlapping cooks; every entry, including one key written by
// several cooks, must read back whole.
it('keeps a parallel cooker DDC store whole under overlapping cooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-native-cook-admission-'));
  roots.push(root);
  const registry = new NativeCookerRegistry({
    cache: (key) => createNativeCookCache(root, key),
  });
  let active = 0;
  let peak = 0;
  registry.register({
    key: 'parallel-bake',
    concurrency: 'parallel',
    async cook(raw: unknown, context) {
      const index = (raw as { index: number }).index;
      peak = Math.max(peak, ++active);
      const own = new Uint8Array(4096).fill(index);
      context?.cache?.put(`entry-${index}`, own);
      await new Promise((resolve) => setTimeout(resolve, 8 - index));
      context?.cache?.put('shared', new Uint8Array(4096).fill(index));
      const read = context?.cache?.get(`entry-${index}`);
      active--;
      return {
        guid: `01900000-0000-7000-8000-00000000000${index}`,
        payload: { kind: 'test-bake', whole: read?.every((byte) => byte === index) === true },
        refs: [],
        artifacts: {},
        inputFingerprint: `sha256:${index}`,
      };
    },
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => registry.runDraft('parallel-bake', { index })),
  );
  expect(peak).toBeGreaterThan(1);
  for (const result of results) {
    if (!result.ok) throw new Error(result.error.hint);
    expect(result.value.payload).toEqual({ kind: 'test-bake', whole: true });
  }
  const store = createNativeCookCache(root, 'parallel-bake');
  const shared = store.get('shared');
  expect(shared?.byteLength).toBe(4096);
  // The last writer wins atomically: one cook's bytes, never a mix.
  expect(new Set(shared)).toHaveProperty('size', 1);
});
