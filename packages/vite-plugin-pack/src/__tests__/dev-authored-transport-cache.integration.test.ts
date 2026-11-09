import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

it('connects authored dev transport DDC across owners and invalidates changed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-dev-authored-transport-'));
  const path = join(root, 'fixture.pack.ts');
  const cache = join(root, 'build-cache');
  const entries = join(cache, 'scriptable-pack-transports', 'entries');
  const source = (value: number) => `export default {
    schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(79),
    build() { return { ok: true, value: {
      room: { kind: 'fixture-binary', execution: 'cooked', source: { text: '${value}' } }
    } }; }
  };`;
  const cook = vi.fn<NativeCooker['cook']>(({ guid, source }) => ({
    guid,
    payload: { kind: 'fixture-binary', ...(source as object) },
    refs: [],
    artifacts: {
      body: {
        mediaType: 'application/octet-stream',
        bytes: new TextEncoder().encode(JSON.stringify(source)),
      },
    },
    inputFingerprint: JSON.stringify(source),
  }));
  const serve = async (scope: string) => {
    const binding = createStandaloneRuntimeAssetBinding(scope);
    const plugin = createPluginPackInternal({
      roots: [path],
      watch: false,
      cookers: [{ key: 'fixture-binary', cacheIdentity: () => 'fixture/1', cook }],
      runtimeBinding: binding,
      ddc: { buildCacheRoot: cache, identityRoot: root, projectDdcRoot: join(root, 'project-ddc') },
    });
    try {
      plugin.configureServer({ middlewares: { use() {} }, ws: { send() {} } });
      await plugin.ready();
      const [row] = plugin.catalogSnapshot();
      expect(row?.publication).toBeDefined();
      return row?.publication?.digest;
    } finally {
      await plugin.closeBundle();
    }
  };
  try {
    await writeFile(path, source(1));
    const first = await serve('first');
    expect(await readdir(entries)).toHaveLength(1);
    expect(await serve('second')).toBe(first);
    expect(cook).toHaveBeenCalledTimes(1);
    expect(await readdir(entries)).toHaveLength(1);
    await writeFile(path, source(2));
    expect(await serve('edited')).not.toBe(first);
    expect(await readdir(entries)).toHaveLength(2);
    expect(cook).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
