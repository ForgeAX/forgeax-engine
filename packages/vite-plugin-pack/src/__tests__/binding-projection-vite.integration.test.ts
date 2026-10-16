import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { pluginPack } from '../index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-binding-projection-'));
  const roots = [join(root, 'first'), join(root, 'second')] as const;
  for (const [index, assets] of roots.entries()) {
    await mkdir(assets);
    await writeFile(
      join(assets, 'effect.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: `01900000-0000-7000-8000-${index ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa'}`,
        assets: { [`effect/${index}`]: { kind: 'test-effect', payload: {}, refs: [] } },
      }),
    );
  }
  const plugin = pluginPack({
    roots: [roots[0]],
    runtimeBinding: createStandaloneRuntimeAssetBinding('binding-projection'),
    watch: false,
    ddc: { projectDdcRoot: join(root, 'ddc') },
  });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { noDiscovery: true },
  });
  await server.listen();
  await plugin.ready();
  return {
    root,
    plugin,
    server,
    bind: (index: 0 | 1) =>
      plugin.rebind(
        { ...createStandaloneRuntimeAssetBinding('binding-projection'), generation: index + 1 },
        [roots[index]],
      ),
    close: async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('publishes declarations under the resolved Vite root without changing process cwd', async () => {
  const host = await fixture();
  const other = await fixture();
  try {
    expect(host.root).not.toBe(process.cwd());
    await Promise.all([host.bind(0), other.bind(1)]);
    await expect(
      readFile(join(host.root, '.forgeax/generated/assets.d.ts'), 'utf8'),
    ).resolves.toContain('"effect/0"');
    const otherDeclaration = await readFile(
      join(other.root, '.forgeax/generated/assets.d.ts'),
      'utf8',
    );
    expect(otherDeclaration).toContain('"effect/1"');
    expect(otherDeclaration).not.toContain('"effect/0"');
    const declaration = join(host.root, '.forgeax/generated/assets.d.ts');
    const accepted = await lstat(declaration);
    await host.bind(0);
    const unchanged = await lstat(declaration);
    expect([unchanged.ino, unchanged.mtimeMs]).toEqual([accepted.ino, accepted.mtimeMs]);
  } finally {
    await Promise.all([host.close(), other.close()]);
  }
});

it('invalidates transformed asset bindings on rebind and retains them after failed replacement', async () => {
  const host = await fixture();
  const load = () => host.server.transformRequest('virtual:forgeax/assets');
  try {
    expect((await load())?.code).toContain('effect/0');
    const broken = join(host.root, 'broken');
    await mkdir(broken);
    await writeFile(join(broken, 'effect.pack.json'), '{invalid');
    await expect(
      host.plugin.rebind(
        { ...createStandaloneRuntimeAssetBinding('binding-projection'), generation: 2 },
        [broken],
      ),
    ).resolves.toMatchObject({ status: 'degraded' });
    expect((await load())?.code).toContain('effect/0');
    await expect(
      readFile(join(host.root, '.forgeax/generated/assets.d.ts'), 'utf8'),
    ).resolves.toContain('"effect/0"');
    await host.bind(1);
    const second = (await load())?.code;
    expect(second).toContain('effect/1');
    expect(second).not.toContain('effect/0');
  } finally {
    await host.close();
  }
});

it('projects the active runtime scope into the transformed runtime module', async () => {
  const host = await fixture();
  const load = () => host.server.transformRequest('virtual:forgeax/pack-runtime');
  try {
    expect((await load())?.code).toContain('"generation":1');
    await host.bind(1);
    expect((await load())?.code).toContain('"generation":2');
  } finally {
    await host.close();
  }
});
