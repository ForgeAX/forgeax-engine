import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { ImporterRegistry } from '@forgeax/engine-import';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionImporters, DEFAULT_IMPORTERS } from '../importers.js';

const state = vi.hoisted(() => ({
  bytes: 64 * 1024 ** 3,
  captured: undefined as undefined | readonly import('@forgeax/engine-types').Importer[],
}));
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof import('node:os')>('node:os')),
  availableParallelism: () => 8,
  totalmem: () => state.bytes,
  freemem: () => state.bytes,
}));
vi.mock('@forgeax/engine-vite-plugin-pack', async () => {
  const actual = await vi.importActual<typeof import('@forgeax/engine-vite-plugin-pack')>(
    '@forgeax/engine-vite-plugin-pack',
  );
  return {
    ...actual,
    pluginPack(options: Parameters<typeof actual.pluginPack>[0]) {
      state.captured = options?.importers;
      return actual.pluginPack(options);
    },
  };
});
afterEach(() => {
  state.bytes = 64 * 1024 ** 3;
  state.captured = undefined;
});
it('registers only the actual builtin image with admitted worker concurrency; custom same-key remains serial', async () => {
  const owned = createSessionImporters();
  try {
    const registry = new ImporterRegistry();
    for (const row of owned.importers) registry.register(row);
    expect(registry.get('image')).not.toBe(imageImporter);
    expect(registry.get('image')?.capabilities?.parallelPreparation).toBe(true);
  } finally {
    await owned.dispose();
  }
  const custom = { key: 'image', import: imageImporter.import };
  const session = createSessionImporters([custom]);
  expect(session.importers[0]).toBe(custom);
  expect(custom).not.toHaveProperty('capabilities.parallelPreparation');
  await session.dispose();
});
it('retains serial native encoding when default memory admission cannot host one worker', async () => {
  state.bytes = 256 * 1024 ** 2;
  const session = createSessionImporters();
  expect(session.importers).toBe(DEFAULT_IMPORTERS);
  expect(session.importers.find((row) => row.key === 'image')).toBe(imageImporter);
  await session.dispose();
});
it('wires the admitted default instance through actual createViteConfig into the Pack importer registry', async () => {
  const { createViteConfig } = await import('../host.js');
  const { readProjectFacts } = await import('../project.js');
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-image-host-')));
  let config: Awaited<ReturnType<typeof createViteConfig>> | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"image-host"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'image-host', name: 'Image host', roots: {} }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    config = await createViteConfig(facts.value, 'build');
    const registry = new ImporterRegistry();
    for (const row of state.captured ?? []) registry.register(row);
    expect(registry.get('image')?.capabilities?.parallelPreparation).toBe(true);
  } finally {
    for (const plugin of config?.plugins ?? []) {
      if (
        plugin &&
        typeof plugin === 'object' &&
        !Array.isArray(plugin) &&
        'closeBundle' in plugin &&
        typeof plugin.closeBundle === 'function'
      )
        await plugin.closeBundle.call({} as never);
    }
    await rm(root, { recursive: true, force: true });
  }
});
