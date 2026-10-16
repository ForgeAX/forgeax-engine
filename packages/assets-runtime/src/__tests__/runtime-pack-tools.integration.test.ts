import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { PackV2 } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  prepareRuntimePackContent,
  projectRuntimePackTools,
  type RuntimePackCacheEntry,
  type RuntimePackContent,
  RuntimePackProducer,
} from '../../../import/src/runtime-pack.js';
import { scriptablePackFingerprint } from '../../../import/src/scriptable-pack-fingerprint.js';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';

const packageId = '01900000-0000-7000-8000-000000000981';
const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
function content(id = packageId): RuntimePackContent {
  const modules = {
    'plugin.js':
      'throw new Error("must not evaluate during admission"); export default { apply() {} };',
    'executor.js':
      'throw new Error("must not evaluate during admission"); export function run() {}',
  };
  return {
    source: {
      schemaVersion: '3.0.0',
      packageId: id,
      assets: {
        behavior: {
          kind: 'plugin',
          payload: {
            module: { specifier: './plugin.js' },
            toolContract: {
              schemaVersion: '1.0.0',
              commands: [
                {
                  id: 'tools.run',
                  title: 'Run',
                  summary: '',
                  realm: 'engine',
                  executor: './executor.js',
                  exportName: 'run',
                },
                {
                  id: 'tools.alias',
                  title: 'Alias',
                  summary: '',
                  realm: 'engine',
                  executor: './executor.js',
                  exportName: 'run',
                },
                { id: 'tools.unavailable', title: 'Unavailable', summary: '', realm: 'engine' },
              ],
            },
          },
        },
      },
    },
    programs: {
      plugin: {
        artifact: preparePackProgram({ entry: 'plugin.js', export: 'default', modules }).unwrap(),
      },
      executor: {
        artifact: preparePackProgram({ entry: 'executor.js', export: 'run', modules }).unwrap(),
      },
    },
  };
}
const producer = () =>
  new RuntimePackProducer({
    scopeId: 'tools-test',
    validate: (state, fetcher) => validateAssetPublication(state.rows, fetcher),
  });

it('admits and restores inline declarations without evaluating programs or creating another tools authority', async () => {
  const source = producer();
  const restored = producer();
  try {
    const input = content();
    const accepted = (await source.admit(input)).unwrap();
    expect(accepted.rows.map((row) => row.guid)).toEqual([guid]);
    const projected = projectRuntimePackTools(input).get(guid);
    expect(projected?.commands.map((command) => command.executor)).toEqual([
      'executor',
      'executor',
      undefined,
    ]);
    expect(projected?.commands.every((command) => command.exportName === undefined)).toBe(true);
    const saved = JSON.parse(JSON.stringify(source.snapshot()));
    expect(saved.packs[0]).not.toHaveProperty('tools');
    expect(saved.packs[0].source.assets.behavior.payload.toolContract.commands[0]).toMatchObject({
      executor: './executor.js',
      exportName: 'run',
    });
    (await restored.restore(saved)).unwrap();
    expect(projectRuntimePackTools(defined(restored.snapshot().packs[0]))).toEqual(
      projectRuntimePackTools(input),
    );
  } finally {
    source.dispose();
    restored.dispose();
  }
});

it.each([
  'missing executor',
  'wrong export',
  'ambiguous selection',
  'duplicate ID',
  'duplicate path',
  'unknown field',
  'module reference',
])('rejects %s atomically and leaves unrelated accepted tools intact', async (fault) => {
  const source = producer();
  try {
    (await source.admit(content('01900000-0000-7000-8000-000000000982'))).unwrap();
    const before = source.rows();
    const input = JSON.parse(JSON.stringify(content()));
    const contract = input.source.assets.behavior.payload.toolContract;
    if (fault === 'missing executor') delete input.programs.executor;
    if (fault === 'wrong export') contract.commands[0].exportName = 'absent';
    if (fault === 'ambiguous selection') input.programs.alias = input.programs.executor;
    if (fault === 'duplicate ID')
      contract.commands.push({ ...contract.commands[0], realm: 'host' });
    if (fault === 'duplicate path')
      contract.commands.push({ ...contract.commands[0], id: 'different', path: ['tools', 'run'] });
    if (fault === 'unknown field') contract.extra = true;
    if (fault === 'module reference')
      input.source.assets.behavior.payload.toolContract = { specifier: './contract.js' };
    const result = await source.admit(input);
    expect(result.ok).toBe(false);
    expect(source.rows()).toEqual(before);
    expect(source.snapshot().packs).toHaveLength(1);
  } finally {
    source.dispose();
  }
});

it('changes source and publication evidence when only the tool declaration changes', async () => {
  const source = producer();
  try {
    const original = content();
    const first = (await source.admit(original)).unwrap();
    const firstPack = (await (
      await source.fetch(defined(first.rows[0]).packageUrl)
    ).json()) as PackV2;
    const changed = JSON.parse(JSON.stringify(original));
    changed.source.assets.behavior.payload.toolContract.commands[0].title = 'Updated title';
    expect((await source.admit(changed)).ok).toBe(false);
    source.withdraw(packageId);
    const next = (await source.admit(changed)).unwrap();
    expect(
      ((await (await source.fetch(defined(next.rows[0]).packageUrl)).json()) as PackV2).assets,
    ).toEqual(firstPack.assets);
    expect(next.publication?.sourceRevision).not.toBe(first.publication?.sourceRevision);
    expect(next.publication?.generation).not.toBe(first.publication?.generation);
  } finally {
    source.dispose();
  }
});

it('prepares inline source with the same tool contract and rejects a missing executor before returning content', async () => {
  const input = content();
  if (!('assets' in input.source)) throw new Error('expected direct source');
  const source = defined(input.source.assets.behavior).payload;
  const asset = { ...source, kind: 'plugin' } as Parameters<
    typeof prepareRuntimePackContent
  >[1][string];
  const prepared = await prepareRuntimePackContent(
    packageId,
    { behavior: asset },
    { programs: input.programs },
  );
  expect(prepared.ok).toBe(true);
  expect(projectRuntimePackTools(prepared.unwrap())).toEqual(projectRuntimePackTools(input));
  expect(
    (
      await prepareRuntimePackContent(
        packageId,
        { behavior: asset },
        { programs: { plugin: defined(input.programs?.plugin) } },
      )
    ).ok,
  ).toBe(false);
});

it('generates plugin source and tool closure through cache and cold restore without executing either', async () => {
  const cache = new Map<string, RuntimePackCacheEntry>();
  const source = new RuntimePackProducer({
    scopeId: 'generated-tools',
    cache,
    validate: (state, fetcher) => validateAssetPublication(state.rows, fetcher),
  });
  const restored = producer();
  try {
    const direct = content();
    if (!('assets' in direct.source)) throw new Error('expected direct source');
    const payload = defined(direct.source.assets.behavior).payload;
    const generator = {
      artifact: preparePackProgram({
        entry: 'build.js',
        export: 'build',
        modules: {
          'build.js': `export function build({ values }) { const behavior = ${JSON.stringify(payload)};
          if (values.broken) behavior.toolContract.commands[0].executor = './missing.js';
          return { ok: true, value: { behavior: { ...behavior, kind: 'plugin', config: { amount: values.amount } } } }; }`,
        },
      }).unwrap(),
    };
    const parent = '01900000-0000-7000-8000-000000000985';
    (
      await source.admit({
        source: {
          schemaVersion: '2.0.0',
          kind: 'scriptable-pack-source',
          source: 'build.js',
          packageId: parent,
          program: 'build',
          runtime: { dependencies: [] },
          parameters: [
            { name: 'amount', type: 'f32', default: 2 },
            { name: 'broken', type: 'bool', default: false },
          ],
        },
        programs: { ...direct.programs, build: generator },
      })
    ).unwrap();
    const instance = { schemaVersion: '3.0.0' as const, packageId, parent, values: { amount: 4 } };
    const first = (await source.generate(instance)).unwrap();
    const firstPack = (await (
      await source.fetch(defined(first.rows[0]).packageUrl)
    ).json()) as PackV2;
    expect(projectRuntimePackTools(defined([...cache.values()][0]).content)).toEqual(
      projectRuntimePackTools(direct),
    );
    expect(firstPack.assets[0]?.payload).toMatchObject({
      program: 'plugin',
      config: { amount: 4 },
    });
    expect((await source.generate(instance)).unwrap().publication).toEqual(first.publication);
    const [key, cached] = defined([...cache.entries()][0]);
    const corrupt = JSON.parse(JSON.stringify(cached.content));
    corrupt.programs.plugin.artifact = preparePackProgram({
      entry: 'plugin.js',
      export: 'default',
      modules: { 'plugin.js': 'export default { apply() {} };' },
    }).unwrap();
    cache.set(key, {
      inputFingerprint: key,
      digest: scriptablePackFingerprint(corrupt),
      content: corrupt,
    });
    (await source.generate(instance)).unwrap();
    expect(defined([...cache.values()][0]).content.programs?.plugin).toEqual(
      direct.programs?.plugin,
    );
    const before = source.rows();
    expect((await source.generate({ ...instance, values: { amount: 4, broken: true } })).ok).toBe(
      false,
    );
    expect(source.rows()).toEqual(before);
    const saved = JSON.parse(JSON.stringify(source.snapshot()));
    expect(saved.packs).toHaveLength(1);
    cache.clear();
    (await restored.restore(saved)).unwrap();
    const replay = (await restored.generate(instance)).unwrap();
    expect(
      ((await (await restored.fetch(defined(replay.rows[0]).packageUrl)).json()) as PackV2).assets,
    ).toEqual(firstPack.assets);
    expect(restored.snapshot().packs[0]?.programs?.plugin).toEqual(direct.programs?.plugin);
  } finally {
    source.dispose();
    restored.dispose();
  }
});
