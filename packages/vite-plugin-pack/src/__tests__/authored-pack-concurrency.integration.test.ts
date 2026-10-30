import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { expect, it, vi } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

it('retains native cooker concurrency through dev publication and publishes every cooked output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'authored-pack-concurrency-'));
  const finish: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const cooker: NativeCooker = {
    key: 'test-volume',
    concurrency: 'parallel',
    async cook(raw) {
      const input = raw as { guid: string; source: object };
      peak = Math.max(peak, ++active);
      try {
        return await new Promise<NativeCookDraft>((resolve) => {
          finish.push(() =>
            resolve({
              guid: input.guid,
              payload: { kind: 'test-volume', ...input.source },
              refs: [],
              artifacts: {},
              inputFingerprint: 'sha256:fixture',
            }),
          );
        });
      } finally {
        active--;
      }
    },
  };
  const plugin = createPluginPackInternal({ roots: [root], watch: false, cookers: [cooker] });
  let pending: Promise<void> | undefined;
  try {
    await writeFile(
      join(root, 'fixture.pack.ts'),
      `export default {
      schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(79),
      build() { return { ok: true, value: Object.fromEntries(Array.from({ length: 4 }, (_, marker) => [
        'volume/' + marker, { kind: 'test-volume', execution: 'cooked', source: { marker } },
      ])) }; },
    };`,
    );
    plugin.configureServer({ middlewares: { use() {} }, ws: { send() {} } });
    pending = plugin.ready();
    await vi.waitFor(() => expect(finish).toHaveLength(4));
  } finally {
    const drain = setInterval(() => {
      for (const complete of finish) complete();
    }, 1);
    try {
      await pending;
      expect(peak).toBe(4);
      expect(plugin.catalogSnapshot()).toHaveLength(4);
      for (const entry of plugin.catalogSnapshot())
        expect(entry).toMatchObject({ kind: 'test-volume', publication: {} });
    } finally {
      clearInterval(drain);
      await plugin.closeBundle();
      await rm(root, { recursive: true, force: true });
    }
  }
});
