import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { expect, it } from 'vitest';
import { discoverPluginAssets } from '../plugin-assets.js';
import { compileNodePluginPrograms } from '../plugin-programs-node.js';

it('archives existing static plugins and tools, then mounts them in a fresh process without the source or compiler output', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'forgeax-static-archive-'));
  try {
    const project = resolve(directory, 'original');
    const restored = resolve(directory, 'restored');
    const temporary = resolve(directory, 'compiled');
    for (const root of [project, restored]) {
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(import.meta.dirname, '../../../../engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'dir',
      );
      await writeFile(
        resolve(root, 'package.json'),
        '{"type":"module","dependencies":{"@forgeax/engine":"workspace:*"}}',
      );
    }
    await mkdir(resolve(project, 'assets'));
    await writeFile(
      resolve(project, 'assets/shared.js'),
      `
      import { defineComponent } from '@forgeax/engine/ecs';
      export const Tag = defineComponent('ArchiveTag', { value: 'u32' });
      export const state = { count: 0, active: 0 };
    `,
    );
    await writeFile(
      resolve(project, 'assets/plugin.js'),
      `
      import { registerAssetTools } from '@forgeax/engine/plugin';
      import { Transform } from '@forgeax/engine/scene';
      import { Tag, state } from './shared.js';
      globalThis.archiveEvaluations = (globalThis.archiveEvaluations ?? 0) + 1;
      export default { inject: ['world', 'toolApi', 'probe'], apply(ctx) {
        ctx.probe.sameEngineToken = Transform === ctx.probe.expected;
        ctx.probe.tag = Tag;
        ctx.effect(() => { state.active++; return () => { state.active--; }; });
        ctx.effect(() => registerAssetTools(ctx));
      } };
    `,
    );
    await writeFile(
      resolve(project, 'assets/sibling.js'),
      `
      import { Tag, state } from './shared.js';
      globalThis.siblingEvaluations = (globalThis.siblingEvaluations ?? 0) + 1;
      export default { inject: ['probe'], apply(ctx) {
        ctx.probe.sameProjectToken = ctx.probe.tag === Tag;
        ctx.effect(() => { state.active += 10; return () => { state.active -= 10; }; });
      } };
    `,
    );
    await writeFile(
      resolve(project, 'assets/executor.js'),
      `
      import { Tag, state } from './shared.js';
      globalThis.executorEvaluations = (globalThis.executorEvaluations ?? 0) + 1;
      export default () => ({ count: ++state.count, active: state.active, component: Tag.name });
    `,
    );
    await writeFile(
      resolve(project, 'assets/contract.js'),
      `export default {
      schemaVersion: '1.0.0', commands: [{ id: 'archive.run', title: 'Run', summary: '', realm: 'host', executor: './executor.js' }]
    };`,
    );
    await writeFile(
      resolve(project, 'assets/behavior.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000961',
        assets: {
          behavior: {
            kind: 'plugin',
            payload: {
              module: { specifier: './plugin.js' },
              toolContract: { specifier: './contract.js' },
              config: {
                sibling: {
                  $asset: AssetGuid.format(
                    AssetGuid.derive(
                      definePackageId('01900000-0000-7000-8000-000000000961'),
                      'sibling',
                    ),
                  ),
                },
              },
            },
          },
          sibling: { kind: 'plugin', payload: { module: { specifier: './sibling.js' } } },
        },
      }),
    );
    const inventory = await discoverPluginAssets({ root: project, assetRoots: ['assets'] });
    const records = [...inventory.assets.values()];
    const root = records.find((item) => item.sourceKey === 'behavior');
    if (!root) throw new Error('missing root plugin');
    const compiled = await compileNodePluginPrograms(
      {
        root: project,
        id: 'archive-test',
        name: 'Archive test',
        roots: { host: root.definition.guid },
        assetRoots: ['assets'],
        packageJson: {},
      },
      'host',
      inventory,
      temporary,
    );
    const packageUrl = 'https://original.invalid/behavior.pack.json';
    const publication = createRuntimePackPublication({
      scopeId: 'original',
      packageUrl,
      sourcePath: root.sourcePath,
      sourceRevision:
        root.definition.evidence.kind === 'source' ? root.definition.evidence.revision : '',
      pack: {
        assets: records.map((record) => ({
          guid: record.definition.guid,
          kind: 'plugin',
          payload: record.definition.asset,
          refs: record.refs,
          artifacts: {},
        })),
      },
      sourceKeys: new Map(records.map((record) => [record.definition.guid, record.sourceKey])),
    });
    const rows = publication.publication.outputs.map((output) => ({
      guid: output.guid,
      kind: output.kind,
      sourcePath: root.sourcePath,
      sourceKey: output.sourceKey,
      packageUrl,
      publication: publication.publication,
    }));
    const input = resolve(directory, 'input.json');
    const archive = resolve(directory, 'saved.json');
    await writeFile(input, JSON.stringify({ pack: publication.pack, rows, entry: compiled.entry }));
    const fixture = fileURLToPath(new URL('./fixtures/static-plugin-archive.mjs', import.meta.url));
    const run = async (mode: string, projectRoot: string) => {
      const result = await promisify(execFile)(
        process.execPath,
        [fixture, mode, projectRoot, input, archive],
        { timeout: 20000 },
      );
      return JSON.parse(result.stdout);
    };
    expect(await run('save', project)).toEqual({
      plugins: 2,
      executions: 2,
      sameEngineToken: true,
      sameProjectToken: true,
    });
    const saved = await readFile(archive, 'utf8');
    expect(saved).not.toContain(temporary);
    expect(saved).not.toContain('file:');
    // A new process has no producer ESM cache, original project, transport or compiler artifacts.
    await rm(project, { recursive: true });
    await rm(temporary, { recursive: true });
    await rm(input);
    expect(await run('restore', restored)).toEqual({
      plugins: 2,
      executions: 2,
      sameEngineToken: true,
      sameProjectToken: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
