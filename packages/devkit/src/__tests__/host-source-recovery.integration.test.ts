import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { expect, it, vi } from 'vitest';

const build = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('vite', async (original) => ({
  ...(await original<typeof import('vite')>()),
  build,
}));

import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it.each([
  'saved',
  'moving',
  'invalid',
] as const)('handles %s source while preparing one project replacement', async (mode) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-host-source-recovery-')));
  let lifecycle: Plugin | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"source-recovery","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'source-recovery', name: 'Source', roots: {} }),
    );
    const source = resolve(root, 'behavior.ts');
    const behavior = (revision: number) =>
      `export const revision = ${revision}; export default { apply() {} };`;
    await writeFile(source, behavior(1));
    await writeFile(
      resolve(root, 'assets/behavior.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000001905',
        assets: {
          behavior: { kind: 'plugin', payload: { module: { specifier: '../behavior.ts' } } },
        },
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve');
    lifecycle = config.plugins
      ?.flat()
      .find(
        (plugin): plugin is Plugin =>
          !!plugin &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          plugin.name === 'forgeax:project-session',
      );
    if (typeof lifecycle?.hotUpdate !== 'function') throw new Error('project HMR owner missing');
    let finish: (outcome: 'restarted' | 'failed') => void = () => {
      throw new Error('completion owner missing');
    };
    const completed = new Promise<'restarted' | 'failed'>((resolve) => {
      finish = resolve;
    });
    const failures: unknown[] = [];
    const hotEvents: unknown[] = [];
    const restart = vi.fn(async () => {
      const nextRoot = server.config.inlineConfig.root;
      if (nextRoot === undefined) throw new Error('replacement root missing');
      Object.assign(server.config, { root: nextRoot });
      finish('restarted');
    });
    const server = {
      config: {
        root: config.root,
        inlineConfig: config,
        plugins: [],
        logger: { error: (error: unknown) => failures.push(error) },
      },
      moduleGraph: { getModulesByFile: () => [] },
      restart,
    } as unknown as ViteDevServer;
    build.mockReset();
    build.mockImplementation(async () => {
      if (mode === 'invalid') throw new Error('invalid authored source');
      if (mode === 'moving' || build.mock.calls.length === 1)
        await writeFile(source, behavior(build.mock.calls.length + 2));
    });
    await writeFile(source, behavior(2));
    // Dispatch once: a watcher may coalesce the later save while compilation
    // is in flight. The real source fence must reject that stale candidate.
    lifecycle.hotUpdate.call(
      {
        environment: {
          name: 'client',
          hot: {
            send: (event: unknown) => {
              hotEvents.push(event);
              finish('failed');
            },
          },
        },
      } as never,
      { file: source, server } as never,
    );
    const outcome = await completed;
    expect(outcome).toBe(mode === 'saved' ? 'restarted' : 'failed');
    expect(build).toHaveBeenCalledTimes(mode === 'invalid' ? 1 : 2);
    expect(restart).toHaveBeenCalledTimes(mode === 'saved' ? 1 : 0);
    if (mode === 'saved') {
      expect(failures).toEqual([]);
      expect(hotEvents).toEqual([]);
      expect(await readFile(source, 'utf8')).toContain('revision = 3');
      const replacement = config.plugins
        ?.flat()
        .find(
          (plugin): plugin is Plugin =>
            !!plugin &&
            typeof plugin === 'object' &&
            'name' in plugin &&
            plugin.name === 'forgeax:project-session',
        );
      if (typeof replacement?.closeBundle === 'function')
        await replacement.closeBundle.call({} as never);
    } else {
      expect(failures).toHaveLength(1);
      expect(hotEvents).toHaveLength(1);
      expect(hotEvents[0]).toMatchObject({ type: 'error' });
    }
  } finally {
    if (typeof lifecycle?.closeBundle === 'function') await lifecycle.closeBundle.call({} as never);
    await rm(root, { recursive: true, force: true });
  }
});
