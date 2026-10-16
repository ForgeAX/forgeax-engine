import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { captureAssetPublication, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createFixedRuntimePackSnapshot } from '@forgeax/engine-import';
import { createRuntimePackPublication, preparePackProgram } from '@forgeax/engine-pack/runtime';
import { expect, it } from 'vitest';

it('restores one complete mixed plugin archive in fresh host and frontend realms with native tools and withdrawal', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'forgeax-mixed-archive-'));
  try {
    const guids = [
      '01900000-0000-7000-8000-000000000995',
      '01900000-0000-7000-8000-000000000996',
      '01900000-0000-7000-8000-000000000997',
    ];
    const publication = createRuntimePackPublication({
      scopeId: 'original',
      sourcePath: 'mixed.pack.json',
      sourceRevision: 'mixed',
      packageUrl: 'https://original.invalid/mixed.pack.json',
      pack: {
        assets: guids.map((guid) => ({
          guid,
          kind: 'plugin',
          payload: { kind: 'plugin', program: 'shared' },
          refs: [],
          artifacts: {},
        })),
      },
    });
    const rows = publication.publication.outputs.map((output) => ({
      guid: output.guid,
      kind: output.kind,
      sourceKey: output.sourceKey,
      sourcePath: 'mixed.pack.json',
      packageUrl: 'https://original.invalid/mixed.pack.json',
      publication: publication.publication,
    }));
    const { scopeId, generation, digest, outputSetDigest } = publication.pack;
    const executions = (['host', 'frontend'] as const).map((target, index) => {
      const members = guids.filter((_guid, position) => position === index || position === 2);
      const modules = {
        'plugin.js': `
        import { registerAssetTools } from 'plugin';
        ${target === 'host' ? "import path from 'node:path';" : ''}
        globalThis.mixedEvaluations = (globalThis.mixedEvaluations ?? 0) + 1;
        const state = { active: 0, count: 0 };
        export default { inject: ['probe', 'toolApi'], apply(ctx) {
          ctx.probe.target = ${JSON.stringify(target)};
          ctx.effect(() => { state.active++; return () => { state.active--; }; });
          ctx.effect(() => registerAssetTools(ctx));
        } };
        export function run() { return { target: ${JSON.stringify(target)}, active: state.active, count: ++state.count,
          dependency: ${target === 'host' ? "path.basename('/game/asset')" : "'browser'"} }; }
      `,
      };
      const select = (name: string) =>
        preparePackProgram({
          entry: 'plugin.js',
          export: name,
          modules,
          imports: {
            plugin: 'native-plugin',
            ...(target === 'host' ? { 'node:path': 'native-node' } : {}),
          },
        }).unwrap();
      return {
        target,
        programs: new Map([
          ['shared', { exportSource: async () => select('default') }],
          ['executor', { exportSource: async () => select('run') }],
        ]),
        tools: new Map(
          members.map((guid, index) => [
            guid,
            {
              schemaVersion: '1.0.0' as const,
              commands:
                index === 0
                  ? [
                      {
                        id: 'mixed.run',
                        title: 'Run',
                        summary: '',
                        realm: target,
                        executor: 'executor',
                      },
                    ]
                  : [],
            },
          ]),
        ),
        definitions: new Map(
          members.map((guid) => [
            guid,
            {
              kind: 'publication' as const,
              publication: { scopeId, generation, digest, outputSetDigest },
            },
          ]),
        ),
      };
    });
    const first = rows[0];
    if (!first) throw new Error('missing mixed fixture');
    const fixed = (
      await captureAssetPublication(
        first,
        rows,
        createCatalogSource({ entries: rows }),
        async () => new Response(JSON.stringify(publication.pack)),
        { executions },
      )
    ).unwrap();
    const archive = resolve(directory, 'archive.json');
    await writeFile(archive, JSON.stringify(await createFixedRuntimePackSnapshot(fixed)));
    const fixture = fileURLToPath(new URL('./fixtures/runtime-pack-mixed.mjs', import.meta.url));
    for (const target of ['host', 'frontend']) {
      const { stdout } = await promisify(execFile)(process.execPath, [fixture, archive, target], {
        timeout: 20000,
      });
      expect(JSON.parse(stdout)).toEqual({
        target,
        definitions: 3,
        executable: 2,
        blocked: true,
        active: 1,
        retired: 'failed',
        retainedGroups: 2,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
