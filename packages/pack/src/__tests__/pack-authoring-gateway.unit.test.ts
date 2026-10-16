import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetGuid, PackageId } from '../guid.js';
import { createFileSystemPackAuthoringGateway } from '../pack-authoring-node.js';

const DIRECT_PACKAGE = '01900000-0000-7000-8000-000000000070';
const CLONE_PACKAGE = '01900000-0000-7000-8000-000000000071';
const SOURCE_PACKAGE = '01900000-0000-7000-8000-000000000072';
const INSTANCE_PACKAGE = '01900000-0000-7000-8000-000000000073';

const roots: string[] = [];

function packageId(value: string) {
  const parsed = PackageId.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

afterEach(async () => {
  const root = roots.pop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('Pack authoring gateway', () => {
  it('keeps healthy read queries and source diagnostics when a sibling is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-partial-'));
    roots.push(root);
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

  it('writes guid-less direct JSON, derives identity, and makes mutations idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-direct-'));
    roots.push(root);
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    const operation = {
      operation: 'asset.source.create' as const,
      requestId: 'create-direct',
      targetPath: 'assets/direct.pack.json',
      format: 'pack.json' as const,
      packageId: DIRECT_PACKAGE,
      initialAssets: {
        'mesh/main': { kind: 'mesh', payload: { vertices: [] }, refs: [] },
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
      assets: { 'mesh/main': { kind: 'mesh', payload: { vertices: [] }, refs: [] } },
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
      materialized: () => [
        {
          packageId: DIRECT_PACKAGE,
          sourceKey: 'mesh/main',
          guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/main')),
          kind: 'mesh',
          sourcePath: 'dist/pack.json',
          ready: true,
          artifactsReady: true,
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

    const clone = await gateway.execute({
      operation: 'asset.source.clone',
      requestId: 'clone-direct',
      sourcePath: operation.targetPath,
      targetPath: 'assets/clone.pack.json',
      packageId: CLONE_PACKAGE,
    });
    expect(clone).toMatchObject({ ok: false, error: { code: 'pack-source-mutation-unsupported' } });
  });

  it('keeps source inspection as identity and returns only the selected direct payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-inspect-output-'));
    roots.push(root);
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    const created = await gateway.execute({
      operation: 'asset.source.create',
      requestId: 'create-two-outputs',
      targetPath: 'assets/direct.pack.json',
      format: 'pack.json',
      packageId: DIRECT_PACKAGE,
      initialAssets: {
        'material/main': { kind: 'material', payload: { roughness: 0.4 }, refs: [] },
        'material/other': { kind: 'material', payload: { roughness: 0.9 }, refs: [] },
      },
    });
    expect(created.ok).toBe(true);
    const source = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'inspect-source',
      subject: 'assets/direct.pack.json',
    });
    expect(source).toMatchObject({
      ok: true,
      value: { assets: [{ sourceKey: 'material/main' }, { sourceKey: 'material/other' }] },
    });
    if (!source.ok) return;
    expect(source.value.assets?.every((asset) => !('payload' in asset))).toBe(true);

    const selected = await gateway.execute({
      operation: 'asset.inspect',
      requestId: 'inspect-one-output',
      subject: 'assets/direct.pack.json',
      sourceKey: 'material/main',
    });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'material/main')),
        payload: { roughness: 0.4 },
      },
    });
    if (!selected.ok) return;
    expect(selected.value.assets?.every((asset) => !('payload' in asset))).toBe(true);
  });

  it('creates ScriptablePack source and Pack instance documents with CAS-protected value edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-instance-'));
    roots.push(root);
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
  }, 15_000);

  it('fails closed when the current materialized projection violates derived identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-projection-'));
    roots.push(root);
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      materialized: () => [
        {
          packageId: DIRECT_PACKAGE,
          sourceKey: 'mesh/main',
          guid: AssetGuid.format(AssetGuid.derive(packageId(DIRECT_PACKAGE), 'mesh/other')),
          kind: 'mesh',
          ready: true,
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
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-locator-'));
    roots.push(root);
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
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-projection-callback-'));
    roots.push(root);
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      materialized: () => {
        throw new Error('projection unavailable');
      },
    });
    const result = await gateway.execute({ operation: 'asset.list', requestId: 'bad-callback' });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });

  it('accepts references to published assets owned by another producer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-gateway-external-ref-'));
    roots.push(root);
    const externalGuid = '01900000-0000-7000-8000-000000000099';
    const gateway = createFileSystemPackAuthoringGateway({
      gameRoot: root,
      additionalKnownGuids: () => [externalGuid],
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
  const root = await mkdtemp(join(tmpdir(), 'forgeax-inspect-revision-'));
  roots.push(root);
  const outputs = [
    {
      packageId: SOURCE_PACKAGE,
      sourceKey: 'mesh/main',
      guid: AssetGuid.format(AssetGuid.derive(packageId(SOURCE_PACKAGE), 'mesh/main')),
      kind: 'mesh',
      sourcePath: 'assets/source.pack.ts',
      ready: true,
    },
  ];
  let published = false;
  const gateway = createFileSystemPackAuthoringGateway({
    gameRoot: root,
    materialized: () => (published ? outputs : []),
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
      assets: outputs,
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
    value: { assets: outputs, revision: created.value.revision },
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
