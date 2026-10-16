import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { expect, it, vi } from 'vitest';
import type { PluginSourceInventory } from '../build/plugin-assets.js';
import { projectBuildDescriptor } from '../tools/catalog.js';
import { createToolClient } from '../tools/client.js';

const build = vi.hoisted(() =>
  vi.fn(async (_options: unknown, _sources?: unknown) => ({ ok: true, value: {} })),
);
vi.mock('../commands.js', () => ({ buildCommand: build }));

it('hands CLI discovery sources to one matching build only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-build-source-handoff-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'package.json'), '{"name":"fixture","type":"module"}');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      id: 'fixture',
      name: 'Fixture',
      roots: {},
      assetRoots: ['assets'],
    }),
  );
  const sourceSnapshot = createScriptablePackSourceSnapshot();
  const inventory: PluginSourceInventory = {
    assets: new Map(),
    deferred: [],
    sourceInputs: sourceSnapshot.inputs,
    sourceSnapshot,
    filesystemInputs: undefined,
  };
  const client = await createToolClient({
    projectRoot: root,
    inventory,
    projectDiscovery: async () => [],
  });
  try {
    const first = await client.run(projectBuildDescriptor.id, {});
    expect(first.outcome).toBe('succeeded');
    expect(build.mock.calls[0]?.[1]).toBe(inventory);
    await client.run(projectBuildDescriptor.id, {});
    expect(build.mock.calls[1]?.[1]).toBeUndefined();
  } finally {
    await client.dispose?.();
    await rm(root, { recursive: true, force: true });
    build.mockClear();
  }
});
