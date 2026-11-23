import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { AssetGuid, PackageId } from '../guid.js';
import { definePack, projectScriptablePackMeta } from '../pack-authoring.js';
import { createFileSystemPackAuthoringGateway } from '../pack-authoring-node.js';
import { installPackProjectDependencies } from './support/pack-project-dependencies.js';

const DIRECT_PACKAGE = '01900000-0000-7000-8000-000000000070';
const CLONE_PACKAGE = '01900000-0000-7000-8000-000000000071';
const SOURCE_PACKAGE = '01900000-0000-7000-8000-000000000072';
const INSTANCE_PACKAGE = '01900000-0000-7000-8000-000000000073';

function packageId(value: string) {
  const parsed = PackageId.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const scratch = temporaryDirectories();
afterEach(scratch.clear);

describe('Pack authoring gateway', () => {
  it('detaches vector defaults when the host retains its source inventory', async () => {
    const root = await scratch.make('forgeax-pack-parameter-inventory-');
    const sourcePath = join(root, 'scene.pack.ts');
    await writeFile(sourcePath, '');
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: packageId(SOURCE_PACKAGE),
      parameters: [{ name: 'position', type: 'vec3', default: [1, 2, 3] }],
      build: () => ok({}),
    });
    const inventory = {
      paths: [sourcePath],
      inventory: [],
      instances: new Map(),
      declarations: new Map([
        [
          sourcePath,
          {
            format: 'pack.ts' as const,
            sourcePath,
            sourceRevision: 'source',
            value: projectScriptablePackMeta(definition, sourcePath),
            definition,
            sourceClosure: [],
          },
        ],
      ]),
    };
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      inventory: async () => ok(inventory),
    });
    const inspect = (requestId: string) =>
      gateway.execute({ operation: 'asset.inspect', requestId, sourcePath: 'scene.pack.ts' });

    const first = (await inspect('first')).unwrap().parameters?.[0]?.default;
    if (!Array.isArray(first)) throw new TypeError('expected a vector default');
    first[0] = 99;
    expect((await inspect('second')).unwrap().parameters?.[0]?.default).toEqual([1, 2, 3]);
  });

  it('inspects parameter declarations without scanning siblings or executing user code', async () => {
    const root = await scratch.make('forgeax-pack-parameters-');
    await installPackProjectDependencies(root);
    const source = `throw new Error('inspection must not execute this module');
export default definePack({
  schemaVersion: '2.0.0', packageId: definePackageId('${SOURCE_PACKAGE}'),
  parameters: [
    { name: 'segments', type: 'u32', default: 12, minimum: 3 },
    { name: 'sunIntensity', type: 'f32', default: 3.2, maximum: 10,
      apply: { asset: 'scene/main', path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'] } },
  ],
  build() { throw new Error('inspection must not generate'); },
});\n`;
    await writeFile(join(root, 'scene.pack.ts'), source);
    await writeFile(join(root, 'broken.pack.json'), '{ invalid sibling');
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      inventory: async () => {
        throw new Error('parameter inspection must not scan');
      },
      catalog: () => {
        throw new Error('parameter inspection must not read Catalog');
      },
    });
    const inspected = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'parameters',
      subject: 'scene.pack.ts',
      parametersOnly: true,
    });
    expect(inspected).toMatchObject({
      ok: true,
      value: {
        sourcePath: 'scene.pack.ts',
        packageId: SOURCE_PACKAGE,
        status: 'identity',
        parameters: [
          {
            name: 'segments',
            mode: 'generation',
            type: 'u32',
            default: 12,
            minimum: 3,
            location: { line: 5 },
          },
          {
            name: 'sunIntensity',
            mode: 'runtime',
            type: 'f32',
            default: 3.2,
            maximum: 10,
            apply: {
              asset: 'scene/main',
              path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'],
            },
            location: { line: 6 },
          },
        ],
      },
    });
    expect(await readFile(join(root, 'scene.pack.ts'), 'utf8')).toBe(source);
    await writeFile(join(root, 'scene.pack.ts'), source.replace('default: 12', 'default: 1'));
    expect(
      await gateway.execute({
        operation: 'asset.inspect',
        requestId: 'invalid-parameters',
        subject: 'scene.pack.ts',
        parametersOnly: true,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'pack-parameter-invalid',
        detail: {
          sourcePath: 'scene.pack.ts',
          propertyPath: '$.parameters[0].default',
          location: { line: 5 },
        },
      },
    });
  });

  it('keeps healthy read queries and source diagnostics when a sibling is malformed', async () => {
    const root = await scratch.make('forgeax-pack-gateway-partial-');
    await installPackProjectDependencies(root);
    await writeFile(
      join(root, 'good.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: DIRECT_PACKAGE,
        assets: { 'mesh/main': { kind: 'mesh', payload: {}, refs: [] } },
      }),
    );
    await writeFile(join(root, 'broken.pack.json'), '{ invalid JSON');
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    const listed = await gateway.execute({ operation: 'asset.list', requestId: 'partial-list' });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        sources: [{ sourcePath: 'good.pack.json' }],
        diagnostics: [
          { sourcePath: join(root, 'broken.pack.json'), error: { code: 'pack-parameter-invalid' } },
        ],
      },
    });
    const guid = AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/main'));
    expect(
      await gateway.execute({
        operation: 'asset.resolve',
        requestId: 'resolve-good',
        subject: guid,
      }),
    ).toMatchObject({ ok: true, value: { guid } });
    expect(
      await gateway.execute({
        operation: 'asset.inspect',
        requestId: 'inspect-good',
        sourcePath: 'good.pack.json',
        sourceKey: 'mesh/main',
      }),
    ).toMatchObject({ ok: true, value: { guid } });
    expect(
      await gateway.execute({
        operation: 'asset.inspect',
        requestId: 'inspect-bad',
        sourcePath: 'broken.pack.json',
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
    expect(
      await gateway.execute({
        operation: 'asset.resolve',
        requestId: 'resolve-bad',
        subject: 'broken.pack.json',
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
    expect(
      await gateway.execute({ operation: 'asset.verify', requestId: 'verify-all' }),
    ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
    expect(
      await gateway.execute({
        operation: 'asset.source.create',
        requestId: 'mutate-all',
        targetPath: 'new.pack.json',
        format: 'pack.json',
        packageId: CLONE_PACKAGE,
        initialAssets: {},
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });

  it('creates, inspects and resolves guid-less direct sources with guarded replay', async () => {
    const root = await scratch.make('forgeax-pack-gateway-direct-');
    await installPackProjectDependencies(root);
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    const operation = {
      operation: 'asset.source.create' as const,
      requestId: 'create-direct',
      targetPath: 'assets/direct.pack.json',
      format: 'pack.json' as const,
      packageId: DIRECT_PACKAGE,
      initialAssets: {
        'mesh/main': { kind: 'mesh', payload: { vertices: [] }, refs: [] },
        'material/main': { kind: 'material', payload: { roughness: 0.4 }, refs: [] },
        'material/other': { kind: 'material', payload: { roughness: 0.9 }, refs: [] },
      },
    };

    const created = await gateway.execute(operation);
    expect(created).toMatchObject({
      ok: true,
      value: { packageId: DIRECT_PACKAGE, format: 'pack.json', targetPath: operation.targetPath },
    });
    const raw = JSON.parse(await readFile(join(root, operation.targetPath), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw).toEqual({
      schemaVersion: '3.0.0',
      packageId: DIRECT_PACKAGE,
      assets: operation.initialAssets,
    });
    expect(JSON.stringify(raw)).not.toContain('guid');

    const replay = await gateway.execute(operation);
    expect(replay).toEqual(created);
    const conflictingReplay = await gateway.execute({ ...operation, initialAssets: {} });
    expect(conflictingReplay).toMatchObject({
      ok: false,
      error: { code: 'pack-source-revision-conflict' },
    });

    const unresolved = await gateway.execute({
      operation: 'asset.resolve',
      requestId: 'resolve-direct',
      packageId: DIRECT_PACKAGE,
      sourceKey: 'mesh/main',
      require: 'ready',
    });
    expect(unresolved).toMatchObject({ ok: false, error: { code: 'asset-not-ready' } });

    const publishedGateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      catalog: () => [
        {
          packageId: DIRECT_PACKAGE,
          sourceKey: 'mesh/main',
          guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/main')),
          kind: 'mesh',
          sourcePath: 'dist/pack.json',
          subject: 'internal-asset',
          lifecycle: 'current',
          publication: { current: { packageUrl: '/assets/direct.runtime-pack.json' } },
        },
      ],
    });
    const resolved = await publishedGateway.execute({
      operation: 'asset.resolve',
      requestId: 'resolve-direct-published',
      packageId: DIRECT_PACKAGE,
      sourceKey: 'mesh/main',
      require: 'ready',
    });
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        packageId: DIRECT_PACKAGE,
        sourceKey: 'mesh/main',
        status: 'ready',
        guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/main')),
      },
    });

    const source = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'inspect-source',
      subject: operation.targetPath,
    });
    expect(source).toMatchObject({
      ok: true,
      value: {
        assets: [
          { sourceKey: 'material/main' },
          { sourceKey: 'material/other' },
          { sourceKey: 'mesh/main' },
        ],
      },
    });
    expect(source.unwrap().assets?.every((asset) => !('payload' in asset))).toBe(true);

    const selected = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'inspect-one-output',
      subject: operation.targetPath,
      sourceKey: 'material/main',
    });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'material/main')),
        payload: { roughness: 0.4 },
      },
    });
    expect(selected.unwrap().assets?.every((asset) => !('payload' in asset))).toBe(true);

    const clone = await gateway.execute({
      operation: 'asset.source.clone',
      requestId: 'clone-direct',
      sourcePath: operation.targetPath,
      targetPath: 'assets/clone.pack.json',
      packageId: CLONE_PACKAGE,
    });
    expect(clone).toMatchObject({ ok: false, error: { code: 'pack-source-mutation-unsupported' } });
  });

  it('creates ScriptablePack source and Pack instance documents with CAS-protected value edits', async () => {
    const root = await scratch.make('forgeax-pack-gateway-instance-');
    await installPackProjectDependencies(root);
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    const source = await gateway.execute({
      operation: 'asset.source.create',
      requestId: 'create-source',
      targetPath: 'assets/source.pack.ts',
      format: 'pack.ts',
      packageId: SOURCE_PACKAGE,
      parameters: [{ name: 'count', type: 'u32', default: 1, minimum: 1 }],
    });
    expect(source).toMatchObject({
      ok: true,
      value: { packageId: SOURCE_PACKAGE, format: 'pack.ts' },
    });
    const sourceText = await readFile(join(root, 'assets/source.pack.ts'), 'utf8');
    expect(sourceText).toContain(`definePackageId("${SOURCE_PACKAGE}")`);
    expect(sourceText).not.toContain('assets:');

    const listed = await gateway.execute({ operation: 'asset.list', requestId: 'list-source' });
    expect(listed).toMatchObject({
      ok: true,
      value: { sources: [{ packageId: SOURCE_PACKAGE, sourcePath: 'assets/source.pack.ts' }] },
    });
    const verified = await gateway.execute({
      operation: 'asset.verify',
      requestId: 'verify-source',
    });
    expect(verified).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 'asset-verification-v1',
        scope: {
          sourceCount: 1,
          assetCount: 0,
          scriptablePackSourceCount: 1,
          scriptablePackSources: [
            {
              sourcePath: expect.stringContaining(join('assets', 'source.pack.ts')),
              packageId: SOURCE_PACKAGE,
              output: 'unproduced',
            },
          ],
        },
        assets: [],
        summary: { unmaterializedScriptablePackCount: 1 },
      },
    });

    const instance = await gateway.execute({
      operation: 'asset.source.instance.create',
      requestId: 'create-instance',
      targetPath: 'assets/instance.pack.json',
      packageId: INSTANCE_PACKAGE,
      parentPackageId: SOURCE_PACKAGE,
      values: { count: 4 },
    });
    expect(instance).toMatchObject({
      ok: true,
      value: {
        packageId: INSTANCE_PACKAGE,
        parentPackageId: SOURCE_PACKAGE,
        effectiveValues: { count: 4 },
      },
    });
    if (!instance.ok) return;
    const instanceRevision = instance.value.revision;
    if (instanceRevision === undefined)
      throw new Error('create-instance did not return a revision');
    const applied = await gateway.execute({
      operation: 'asset.source.values.apply',
      requestId: 'apply-values',
      sourcePath: 'assets/instance.pack.json',
      expectedRevision: instanceRevision,
      values: { count: 5 },
    });
    expect(applied).toMatchObject({ ok: true, value: { effectiveValues: { count: 5 } } });
    const inspectedOutput = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'inspect-instance-output',
      subject: 'assets/instance.pack.json',
      sourceKey: 'mesh/main',
    });
    expect(inspectedOutput).toMatchObject({
      ok: true,
      value: {
        guid: AssetGuid.format(AssetGuid.derive(packageId(INSTANCE_PACKAGE), 'mesh/main')),
        effectiveValues: { count: 5 },
      },
    });
    const stale = await gateway.execute({
      operation: 'asset.source.values.apply',
      requestId: 'apply-stale',
      sourcePath: 'assets/instance.pack.json',
      expectedRevision: instanceRevision,
      values: { count: 6 },
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'pack-source-revision-conflict' } });
    if (!applied.ok || applied.value.revision === undefined)
      throw new Error('apply-values did not return a new revision');
    const expectedRevision = applied.value.revision;
    const contenders = await Promise.all(
      [7, 8].map((count) =>
        gateway.execute({
          operation: 'asset.source.values.apply',
          requestId: `concurrent-${count}`,
          sourcePath: 'assets/instance.pack.json',
          expectedRevision,
          values: { count },
        }),
      ),
    );
    const accepted = contenders.filter((entry) => entry.ok);
    expect(accepted).toHaveLength(1);
    expect(contenders.filter((entry) => !entry.ok)).toMatchObject([
      { ok: false, error: { code: 'pack-source-revision-conflict' } },
    ]);
    expect(
      JSON.parse(await readFile(join(root, 'assets/instance.pack.json'), 'utf8')).values,
    ).toEqual(accepted[0]?.value.effectiveValues);
  }, 15_000);

  it('fails closed when the current materialized projection violates derived identity', async () => {
    const root = await scratch.make('forgeax-pack-gateway-projection-');
    await installPackProjectDependencies(root);
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      catalog: () => [
        {
          packageId: DIRECT_PACKAGE,
          sourceKey: 'mesh/main',
          guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/other')),
          kind: 'mesh',
          subject: 'internal-asset',
          lifecycle: 'current',
          publication: { current: { packageUrl: '/assets/direct.runtime-pack.json' } },
        },
      ],
    });

    const result = await gateway.execute({ operation: 'asset.list', requestId: 'bad-projection' });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-guid-collision',
        detail: {
          expectedGuid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/main')),
        },
      },
    });
  });

  it('does not fall back from a missing sourcePath to another package locator', async () => {
    const root = await scratch.make('forgeax-pack-gateway-locator-');
    await installPackProjectDependencies(root);
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    await gateway.execute({
      operation: 'asset.source.create',
      requestId: 'create-locator-source',
      targetPath: 'assets/direct.pack.json',
      format: 'pack.json',
      packageId: DIRECT_PACKAGE,
      initialAssets: {},
    });
    const result = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'inspect-missing-locator',
      sourcePath: 'assets/missing.pack.json',
      packageId: DIRECT_PACKAGE,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-source-not-found' } });
  });

  it('converts a broken materialized projection callback into a structured error', async () => {
    const root = await scratch.make('forgeax-pack-gateway-projection-callback-');
    await installPackProjectDependencies(root);
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      catalog: () => {
        throw new Error('projection unavailable');
      },
    });
    const result = await gateway.execute({ operation: 'asset.list', requestId: 'bad-callback' });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });

  it('accepts references to published assets owned by another producer', async () => {
    const root = await scratch.make('forgeax-pack-gateway-external-ref-');
    await installPackProjectDependencies(root);
    const externalGuid = '01900000-0000-7000-8000-000000000099';
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      catalog: () => [
        {
          guid: externalGuid,
          kind: 'texture',
          subject: 'imported-output',
          lifecycle: 'current',
          publication: { current: { packageUrl: '/assets/external.runtime-pack.json' } },
        },
      ],
    });
    await gateway.execute({
      operation: 'asset.source.create',
      requestId: 'create-external-ref',
      targetPath: 'assets/direct.pack.json',
      format: 'pack.json',
      packageId: DIRECT_PACKAGE,
      initialAssets: {
        'material/main': { kind: 'material', payload: {}, refs: [externalGuid] },
      },
    });
    const verified = await gateway.execute({
      operation: 'asset.verify',
      requestId: 'verify-external-ref',
    });
    expect(verified).toMatchObject({ ok: true, value: { summary: { assetCount: 1 } } });
  });
});

it('inspects the exact source revision used by rebuild conflict checks', async () => {
  const root = await scratch.make('forgeax-inspect-revision-');
  await installPackProjectDependencies(root);
  const output = {
    packageId: SOURCE_PACKAGE,
    sourceKey: 'mesh/main',
    guid: AssetGuid.format(AssetGuid.derive(packageId(SOURCE_PACKAGE), 'mesh/main')),
    kind: 'mesh',
    sourcePath: 'assets/source.pack.ts',
  };
  const row = {
    ...output,
    subject: 'internal-asset',
    lifecycle: 'current',
    publication: { current: { packageUrl: '/assets/build.runtime-pack.json' } },
  };
  let published = false;
  const gateway = createFileSystemPackAuthoringGateway({
    gameRoot: root,
    catalog: () => (published ? [row] : []),
    rebuild: async () => ({ ok: true, value: undefined }),
  });
  const created = await gateway.execute({
    operation: 'asset.source.create',
    requestId: 'create',
    targetPath: 'assets/source.pack.ts',
    format: 'pack.ts',
    packageId: SOURCE_PACKAGE,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  published = true;
  const inspected = await gateway.execute({
    operation: 'asset.inspect',
    subject: 'assets/source.pack.ts',
    requestId: 'inspect',
  });
  expect(inspected).toMatchObject({
    ok: true,
    value: {
      revision: created.value.revision,
      sourcePath: 'assets/source.pack.ts',
      assets: [{ ...output, ready: true }],
    },
  });
  const rebuilt = await gateway.execute({
    operation: 'asset.source.rebuild',
    sourcePath: 'assets/source.pack.ts',
    expectedRevision: created.value.revision,
    requestId: 'rebuild',
  });
  expect(rebuilt).toMatchObject({
    ok: true,
    value: { assets: [{ ...output, ready: true }], revision: created.value.revision },
  });
  const path = join(root, 'assets/source.pack.ts');
  await writeFile(path, `${await readFile(path, 'utf8')}\n// source edit\n`);
  const changed = await gateway.execute({
    operation: 'asset.inspect',
    subject: 'assets/source.pack.ts',
    requestId: 'inspect-edited',
  });
  expect(changed.ok).toBe(true);
  if (changed.ok) expect(changed.value.revision).not.toBe(created.value.revision);
  const stale = await gateway.execute({
    operation: 'asset.source.rebuild',
    sourcePath: 'assets/source.pack.ts',
    expectedRevision: created.value.revision,
    requestId: 'stale',
  });
  expect(stale).toMatchObject({ ok: false, error: { code: 'pack-source-revision-conflict' } });
}, 15_000);
