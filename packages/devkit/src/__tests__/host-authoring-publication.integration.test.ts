import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createBackendHost } from '@forgeax/engine-host/backend';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';

it('publishes saved authoring sources without replacing the editing document', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-authoring-publication-')));
  const backend = await createBackendHost();
  let server: ViteDevServer | undefined;
  const source = resolve(root, 'assets/scene.pack.json');
  const authored = (intensity: number) =>
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000001906',
      assets: {
        'scene/main': {
          kind: 'scene',
          refs: [],
          artifacts: {},
          payload: { entities: { sun: { components: { DirectionalLight: { intensity } } } } },
        },
      },
    });
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(
      resolve(root, 'package.json'),
      '{"name":"authoring-publication","type":"module"}',
    );
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'authoring-publication',
        name: 'Authoring',
        roots: {},
      }),
    );
    await writeFile(source, authored(3.2));
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const consumed: string[] = [];
    const config = await createViteConfig(facts.value, 'serve', '/', {
      host: {
        backend,
        authoringSourceChanged(path) {
          consumed.push(path);
          return true;
        },
      },
    });
    server = await createServer({
      ...config,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...config.server,
        port: await allocateLoopbackPort(),
        strictPort: true,
        watch: null,
      },
    });
    await server.listen();
    const pack = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:pack',
    ) as PluginPack;
    await pack.ready();
    const initial = pack.catalogSnapshot().find((row) => row.kind === 'scene');
    expect(initial?.revision?.digest).toBeDefined();
    const lifecycle = server.config.plugins.find(
      (plugin) => plugin.name === 'forgeax:project-session',
    ) as Plugin;
    if (typeof lifecycle.hotUpdate !== 'function') throw new Error('Project HMR owner missing');
    const reloads: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((...args: Parameters<typeof send>) => {
      const message: unknown = args[0];
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'full-reload'
      )
        reloads.push(message);
      return send(...args);
    }) as typeof server.ws.send;
    for (const intensity of [1, 3.2]) {
      const previous = pack.catalogSnapshot().find((row) => row.kind === 'scene')?.revision?.digest;
      await writeFile(source, authored(intensity));
      await expect(
        lifecycle.hotUpdate.call(
          { environment: { name: 'client' } } as never,
          { file: source, server } as never,
        ),
      ).resolves.toEqual([]);
      await expect
        .poll(() => pack.catalogSnapshot().find((row) => row.kind === 'scene')?.revision?.digest, {
          timeout: 3000,
        })
        .not.toBe(previous);
    }
    expect(consumed).toEqual([source, source]);
    expect(reloads).toEqual([]);
    expect(pack.catalogSnapshot().find((row) => row.kind === 'scene')?.revision?.digest).toBe(
      initial?.revision?.digest,
    );
  } finally {
    await server?.close();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
