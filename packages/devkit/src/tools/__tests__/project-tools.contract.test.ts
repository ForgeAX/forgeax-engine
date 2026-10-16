import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPluginAssets } from '../../build/plugin-assets.js';
import { projectPluginPrograms } from '../../build/plugin-programs.js';
import { createToolClient } from '../client.js';
import { discoverProjectTools } from '../project-tools.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const namespace = '019fb7ce-4700-7000-8000-000000000000';
async function fixture(active: boolean) {
  const root = await mkdtemp(resolve(import.meta.dirname, '../../..', '.tools-fixture-'));
  roots.push(root);
  await mkdir(resolve(root, 'assets'));
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  const parsed = PackageId.parse(namespace);
  if (!parsed.ok) throw parsed.error;
  const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'plugin/tools'));
  await writeFile(
    resolve(root, 'package.json'),
    '{"type":"module","dependencies":{"@forgeax/engine":"workspace:*"}}',
  );
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({
      id: 'tools',
      name: 'Tools',
      schemaVersion: '3.0.0',
      roots: active ? { build: guid } : {},
    }),
  );
  await writeFile(
    resolve(root, 'assets/tools.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: namespace,
      assets: {
        'plugin/tools': {
          kind: 'plugin',
          payload: {
            module: { specifier: './plugin.ts' },
            toolContract: { specifier: './contract.ts' },
          },
        },
      },
    }),
  );
  await writeFile(
    resolve(root, 'assets/contract.ts'),
    `export default { schemaVersion: '1.0.0', commands: [{ id: 'fixture.echo', title: 'Echo', summary: 'Echo', realm: 'build', executor: './executor.ts' }] };`,
  );
  await writeFile(
    resolve(root, 'assets/plugin.ts'),
    `import { registerAssetTools } from '@forgeax/engine/plugin';
    export default { inject: ['toolApi', 'pluginPrograms'], apply(ctx) { ctx.effect(() => registerAssetTools(ctx)); } };`,
  );
  await writeFile(
    resolve(root, 'assets/executor.ts'),
    `export default args => ({ echoed: args.value, pid: process.pid });`,
  );
  return root;
}
describe('Pack-owned tool contracts', () => {
  it('discovers inline contracts relative to the Pack without using a module loader', async () => {
    const root = await fixture(true);
    const path = resolve(root, 'assets/tools.pack.json');
    const source = JSON.parse(await readFile(path, 'utf8'));
    source.assets['plugin/tools'].payload.toolContract = {
      schemaVersion: '1.0.0',
      commands: [
        {
          id: 'inline.run',
          title: 'Run',
          summary: '',
          realm: 'build',
          executor: './executor.ts',
          exportName: 'run',
        },
      ],
    };
    await writeFile(path, JSON.stringify(source));
    await rm(resolve(root, 'assets/contract.ts'));
    await writeFile(
      resolve(root, 'assets/plugin.ts'),
      'throw new Error("discovery evaluated plugin");',
    );
    await writeFile(
      resolve(root, 'assets/executor.ts'),
      'throw new Error("discovery evaluated executor");',
    );
    const load = vi.fn(async () => {
      throw new Error('inline discovery used a loader');
    });
    const close = vi.fn(async () => {});
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    const resolveModule = vi.fn(async () => undefined);
    const bindings = await discoverProjectTools(root, {
      inventory,
      moduleLoader: { load, close, resolve: resolveModule },
    });
    expect(load).not.toHaveBeenCalled();
    expect(resolveModule).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      moduleName: path,
      executor: resolve(root, 'assets/executor.ts'),
    });
    const projection = projectPluginPrograms(
      [...inventory.assets.values()],
      'build',
      bindings,
      root,
    );
    expect([...projection.tools.values()][0]?.commands[0]).toMatchObject({
      executor: 'project:assets/executor.ts#run',
    });
    expect([...projection.tools.values()][0]?.commands[0]).not.toHaveProperty('exportName');
  });

  it('runs an existing native build tool from an inline contract with no contract module', async () => {
    const root = await fixture(true);
    const path = resolve(root, 'assets/tools.pack.json');
    const source = JSON.parse(await readFile(path, 'utf8'));
    source.assets['plugin/tools'].payload.toolContract = {
      schemaVersion: '1.0.0',
      commands: [
        {
          id: 'fixture.echo',
          title: 'Echo',
          summary: '',
          realm: 'build',
          executor: './executor.ts',
        },
      ],
    };
    await writeFile(path, JSON.stringify(source));
    await rm(resolve(root, 'assets/contract.ts'));
    const client = await createToolClient({ projectRoot: root, baseContributions: [] });
    try {
      expect(await client.run('fixture.echo', { value: 'inline' })).toMatchObject({
        outcome: 'succeeded',
        result: { echoed: 'inline' },
      });
    } finally {
      await client.dispose?.();
    }
  }, 30_000);

  it('delivers serializable tool declarations and shares the plugin module graph with its executor', async () => {
    const root = await fixture(true);
    await writeFile(resolve(root, 'assets/shared.ts'), 'export const state = { value: 0 };');
    await writeFile(
      resolve(root, 'assets/plugin.ts'),
      `
      import { registerAssetTools } from '@forgeax/engine/plugin';
      import { state } from './shared';
      export default { inject: ['toolApi', 'pluginPrograms'], apply(ctx) {
        state.value = 41; ctx.effect(() => registerAssetTools(ctx));
      } };`,
    );
    await writeFile(
      resolve(root, 'assets/executor.ts'),
      `
      import { state } from './shared'; export default () => ++state.value;`,
    );
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    const tools = await discoverProjectTools(root, { inventory });
    const records = [...inventory.assets.values()];
    const projection = projectPluginPrograms(records, 'build', tools, root);
    const contract = [...projection.tools.values()][0];
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    expect(contract?.commands[0]?.executor).toBe('project:assets/executor.ts#default');
    expect(contract?.commands[0]?.exportName).toBeUndefined();
    expect(projection.programs.has('project:assets/executor.ts#default')).toBe(true);
    const frontend = projectPluginPrograms(records, 'frontend', tools, root);
    expect([...frontend.tools.values()][0]?.commands).toEqual([]);
    expect(frontend.programs.has('project:assets/executor.ts#default')).toBe(false);
    const client = await createToolClient({ projectRoot: root, baseContributions: [] });
    try {
      expect(await client.run('fixture.echo', {})).toMatchObject({
        outcome: 'succeeded',
        result: 42,
      });
      expect(await client.run('fixture.echo', {})).toMatchObject({
        outcome: 'succeeded',
        result: 43,
      });
    } finally {
      await client.dispose?.();
    }
  }, 30_000);

  it('discovers with neither plugin nor executor evaluation, then invokes the native build provider', async () => {
    const root = await fixture(true);
    // Discovery must not import either executable module.
    await writeFile(
      resolve(root, 'assets/plugin.ts'),
      'throw new Error("apply module evaluated during discovery");',
    );
    await writeFile(
      resolve(root, 'assets/executor.ts'),
      'throw new Error("executor evaluated during discovery");',
    );
    const bindings = await discoverProjectTools(root);
    expect(bindings).toHaveLength(1);
    if (!bindings[0]) throw new Error('required fixture bindings[0] missing');
    expect(bindings[0].sourceRevision).not.toBe('');
    await writeFile(
      resolve(root, 'assets/plugin.ts'),
      `import { registerAssetTools } from '@forgeax/engine/plugin';
      export default { inject: ['toolApi', 'pluginPrograms'], apply(ctx) { ctx.effect(() => registerAssetTools(ctx)); } };`,
    );
    await writeFile(
      resolve(root, 'assets/executor.ts'),
      `export default args => ({ echoed: args.value, pid: process.pid });`,
    );
    const client = await createToolClient({ projectRoot: root, baseContributions: [] });
    try {
      const result = await client.run('fixture.echo', { value: 'yes' });
      expect(result).toMatchObject({ outcome: 'succeeded', result: { echoed: 'yes' } });
      if (result.outcome === 'succeeded')
        expect((result.result as { pid: number }).pid).not.toBe(process.pid);
    } finally {
      await client.dispose?.();
    }
  }, 30_000);
  it('does not install an unselected plugin merely because its command is declared', async () => {
    const root = await fixture(false);
    const client = await createToolClient({ projectRoot: root, baseContributions: [] });
    try {
      expect(client.describe('fixture.echo')).toBeDefined();
      expect(await client.run('fixture.echo', {})).toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-capability-unavailable' },
      });
    } finally {
      await client.dispose?.();
    }
  });
});

it('keeps the executor module realm alive through awaited dynamic imports', async () => {
  const root = await fixture(true);
  await writeFile(
    resolve(root, 'assets/executor.ts'),
    `export default async () => {
    await Promise.resolve(); return { value: (await import('./runtime.ts')).value };
  };`,
  );
  await writeFile(resolve(root, 'assets/runtime.ts'), 'export const value: number = 42;');
  const client = await createToolClient({ projectRoot: root, baseContributions: [] });
  try {
    expect(await client.run('fixture.echo', {})).toMatchObject({
      outcome: 'succeeded',
      result: { value: 42 },
    });
  } finally {
    await client.dispose?.();
  }
});

it.each([
  undefined,
  'export default () => undefined;',
  `export default { schemaVersion: '1.0.0', commands: [{ id: 'repeat' }, { id: 'repeat' }] };`,
])('rejects a missing or invalid source tool contract before evaluating plugin code', async (source) => {
  const root = await fixture(true);
  if (source === undefined) await rm(resolve(root, 'assets/contract.ts'));
  else await writeFile(resolve(root, 'assets/contract.ts'), source);
  await writeFile(
    resolve(root, 'assets/plugin.ts'),
    'throw new Error("executed invalid candidate");',
  );
  await expect(discoverProjectTools(root)).rejects.toThrow();
});
