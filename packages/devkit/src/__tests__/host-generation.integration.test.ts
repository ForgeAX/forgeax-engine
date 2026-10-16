import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Plugin } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('keeps live entry files unchanged while resource preview and build configure the same project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-host-generation-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'package.json'), '{"name":"generation-fixture","type":"module"}');
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        id: 'generation-fixture',
        name: 'Generation fixture',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw new Error(JSON.stringify(facts.error));
    const live = await createViteConfig(facts.value, 'serve');
    if (live.root === undefined) throw new Error('Live root missing');
    const initial = await readFile(join(live.root, 'main.ts'), 'utf8');
    const resource = await createViteConfig(facts.value, 'serve', '/', {
      bootstrapRoot: 'resource-bootstrap',
    });
    if (resource.root === undefined) throw new Error('Resource root missing');
    const build = await createViteConfig(facts.value, 'build');
    expect(new Set([live.root, resource.root, build.root]).size).toBe(3);
    expect(await readFile(join(live.root, 'main.ts'), 'utf8')).toBe(initial);
    expect(await readFile(join(resource.root, 'main.ts'), 'utf8')).toContain('resource-bootstrap');
    const owner = (live.plugins as Plugin[]).find(
      (plugin) => plugin.name === 'forgeax:generated-host-owner',
    );
    const server = await createServer({
      ...live,
      plugins: owner === undefined ? [] : [owner],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { ...live.server, middlewareMode: true },
    });
    await writeFile(join(live.root, 'memory-fixture.js'), 'export const value = 1;');
    await server.transformRequest('/memory-fixture.js');
    const retiredModule =
      await server.environments.client?.moduleGraph.getModuleByUrl('/memory-fixture.js');
    expect(retiredModule?.transformResult?.code).toContain('value');
    try {
      await server.restart();
      expect(retiredModule?.transformResult).toBeNull();
      expect(await readFile(join(live.root, 'main.ts'), 'utf8')).toBe(initial);
    } finally {
      await server.close();
    }
    await expect(readFile(join(live.root, 'main.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(resource.root, 'main.ts'), 'utf8')).toContain('resource-bootstrap');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
