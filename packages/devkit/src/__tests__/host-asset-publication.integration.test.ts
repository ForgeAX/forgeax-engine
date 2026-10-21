import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';

it('publishes and restores asset Pack edits while a borrowed frontend remains immutable', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-host-asset-publication-'));
  let publications = 0;
  const backend = await createBackendHost({
    startupPlugins: [
      {
        provide: ['engineWorkspaceCatalog'],
        apply(ctx) {
          ctx.provide('engineWorkspaceCatalog', {
            notePublished() {
              publications++;
            },
          });
        },
      },
    ],
  });
  let server: ViteDevServer | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../../../engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"asset-publication","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'asset-publication',
        name: 'Asset publication',
        assetRoots: ['assets'],
        roots: {},
      }),
    );
    const source = resolve(root, 'assets/image.pack.ts');
    const pack = (red: number) => `
      import { definePack, definePackageId } from '@forgeax/engine/pack/source';
      import { ok } from '@forgeax/engine/types';
      export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('019fb7ce-3200-7000-8000-000000003abc'), name: 'Image', build: () => ok({ image: {
        kind: 'texture', shape: { viewDimension: '2d', extent: { width: 1, height: 1 } }, format: 'rgba8unorm-srgb', colorSpace: 'srgb', mips: { kind: 'none' }, data: new Uint8Array([${red}, 0, 0, 255]),
      } }) });`;
    await writeFile(source, pack(255));
    const frontend = resolve(root, 'frontend.mjs');
    await writeFile(frontend, 'export default { apply() {} };');
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve', '/', {
      server: { port: await allocateLoopbackPort(), strictPort: true },
      host: {
        backend,
        frontendAssembly: createHostAssembly({
          root: { program: 'test:frontend', codeRevision: 'fixed' },
        }),
        frontendModule: { specifier: pathToFileURL(frontend).href, export: 'default' },
      },
    });
    server = await createServer(config);
    await server.listen();
    const producer = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:pack',
    ) as unknown as {
      ready(): Promise<void>;
      catalogSnapshot(): {
        sourceKey?: string;
        publication?: { outputs: { sourceKey?: string; digest: string }[] };
      }[];
    };
    await producer.ready();
    const digest = () =>
      producer
        .catalogSnapshot()
        .find((row) => row.sourceKey === 'image')
        ?.publication?.outputs.find((row) => row.sourceKey === 'image')?.digest;
    const initial = digest();
    expect(initial).toBeDefined();
    const generatedRoot = server.config.root;
    for (const red of [0, 255]) {
      await writeFile(source, pack(red));
      await expect
        .poll(digest, { timeout: 30_000 })
        .toSatisfy(
          (value: string | undefined) =>
            value !== undefined && (red === 255 ? value === initial : value !== initial),
        );
    }
    await expect.poll(() => publications).toBe(2);
    expect(server.config.root).toBe(generatedRoot);
    expect(await readFile(frontend, 'utf8')).toBe('export default { apply() {} };');
  } finally {
    await server?.close();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
