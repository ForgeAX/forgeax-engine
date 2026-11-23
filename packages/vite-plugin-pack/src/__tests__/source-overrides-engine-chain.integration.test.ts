import {
  type BuildDdcInput,
  DdcEntryStore,
  DdcLifecycle,
  ddcOutputDigest,
  semanticBuildKey,
} from '@forgeax/engine-ddc';
import {
  ImporterRegistry,
  projectImportPack,
  publishImportedCatalogRows,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import { currentProjectionFor } from '@forgeax/engine-pack/build';
import {
  type Asset,
  createAssetPublication,
  type ImportContext,
  type ImportedAsset,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';

const GUID = '11111111-1111-4111-8111-111111111111';
const scratch = temporaryDirectories();

function meta(sourceOverrides?: Record<string, Record<string, unknown>>): RunImportMeta {
  return {
    importer: 'fixture',
    source: 'fixture.source',
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'mesh/main', kind: 'mesh' }],
  } as RunImportMeta;
}

function semantic(sourceOverrides?: Record<string, unknown>): BuildDdcInput {
  return {
    schemaVersion: '2.0.0',
    importerVersion: 'fixture@1',
    codecVersion: 'fixture-codec@1',
    sourceDependencies: [{ path: 'fixture.source', digest: 'source-digest' }],
    settings: { profile: 'dev' },
    declaredGuids: [GUID],
    cookProfile: 'dev',
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
  } as BuildDdcInput;
}

function asset(): ImportedAsset {
  return {
    guid: GUID,
    kind: 'mesh',
    payload: { vertices: new Float32Array(), indices: new Uint16Array(), attributes: {} } as Asset,
    refs: [],
    artifacts: {},
  };
}

function registry(received: { value?: unknown }): ImporterRegistry {
  const result = new ImporterRegistry();
  result.register({
    key: 'fixture',
    import: (ctx: ImportContext) => {
      received.value = ctx.sourceOverrides;
      return {
        ok: true,
        value: { assets: [asset()], sourceDependencies: [] },
      };
    },
  });
  return result;
}

function fs() {
  return { readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }) };
}

async function writeEntry(root: string, key: string, payload: unknown) {
  const entry = {
    key,
    guid: GUID,
    payload,
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'fixture-producer',
      inputFingerprint: key,
      outputDigest: '',
    },
  };
  await new DdcEntryStore(root).write({
    ...entry,
    receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) },
  });
}

afterEach(scratch.clear);

describe('source override Engine consumer chain', () => {
  it('consumes producer Meta through ImportContext, DDC current, and Pack Catalog projection', async () => {
    const root = await scratch.make('forgeax-engine-chain-');
    const received: { value?: unknown } = {};
    const override = { 'mesh/main': { lod: 2 } };
    const imported = await runImport(meta(override), registry(received), fs());
    expect(imported.ok).toBe(true);
    expect(received.value).toEqual(override);
    if (!imported.ok || 'skipped' in imported.value) return;

    const desiredKey = semanticBuildKey(semantic(override));
    expect(desiredKey).not.toBe(semanticBuildKey(semantic()));
    const lifecycle = new DdcLifecycle(root);
    const missing = await lifecycle.begin(GUID, desiredKey);
    expect((await lifecycle.commit(missing, desiredKey)).result).toBe('invalid');
    expect((await lifecycle.inspect(GUID, desiredKey)).state).toBe('failed');

    await writeEntry(root, desiredKey, projectImportPack(imported.value.product));
    const lease = await lifecycle.begin(GUID, desiredKey);
    expect((await lifecycle.commit(lease, desiredKey)).result).toBe('current');

    const row = {
      guid: GUID,
      packageUrl: `/preview/${desiredKey}`,
      packageId: 'fixture-package',
      kind: 'mesh',
      sourcePath: 'fixture.source',
      sourceKey: 'mesh/main',
      revision: { digest: desiredKey, observedAt: 2, rootId: 'fixture-root' },
      lifecycle: 'current' as const,
      diagnostics: [],
    };
    expect(await lifecycle.inspect(GUID, desiredKey)).toMatchObject({ state: 'current' });
    expect(row).toMatchObject({
      packageUrl: `/preview/${desiredKey}`,
      revision: { digest: desiredKey },
    });
  });

  it('keeps LKG when the same producer chain fails validation', async () => {
    const root = await scratch.make('forgeax-engine-chain-');
    const oldKey = semanticBuildKey(semantic());
    const desiredKey = semanticBuildKey(semantic({ 'mesh/main': { lod: 3 } }));
    await writeEntry(root, oldKey, { version: 'old' });
    const lifecycle = new DdcLifecycle(root);
    const oldLease = await lifecycle.begin(GUID, oldKey);
    await lifecycle.commit(oldLease, oldKey);
    const failedLease = await lifecycle.begin(GUID, desiredKey);
    await lifecycle.fail(failedLease, { code: 'validation-failed', detail: 'fixture failure' });
    await expect(new DdcEntryStore(root).read(oldKey)).resolves.toMatchObject({ guid: GUID });
    expect(await lifecycle.inspect(GUID, desiredKey)).toMatchObject({
      state: 'failed',
      currentKey: oldKey,
      lastKnownGoodKey: oldKey,
      failure: { code: 'validation-failed' },
    });
  });

  it('projects a current cooked row without changing the Meta/DDC identity', async () => {
    const desiredKey = semanticBuildKey(semantic({ 'mesh/main': { lod: 4 } }));
    const entries: import('@forgeax/engine-types').PackIndexEntry[] = [
      {
        guid: GUID,
        packageUrl: 'fixture.source.meta.json',
        kind: 'mesh',
        sourcePath: 'fixture.source',
      },
    ];
    const [projected] = publishImportedCatalogRows(
      entries,
      {
        guids: [GUID],
        packageUrl: `/preview/${desiredKey}`,
        revision: { digest: desiredKey, observedAt: 4, rootId: 'fixture-root' },
        publication: createAssetPublication({
          sourcePath: 'fixture.source',
          sourceRevision: desiredKey,
          inputFingerprint: desiredKey,
          digest: desiredKey,
          packageUrl: `/preview/${desiredKey}`,
          externalEvidence: [],
          outputs: [
            {
              guid: GUID,
              sourceKey: 'mesh/main',
              kind: 'mesh',
              digest: desiredKey,
              refs: ['dependency-guid'],
            },
          ],
        }),
        projection: currentProjectionFor('imported-output', 'cooked'),
        meta: meta({ 'mesh/main': { lod: 4 } }),
      },
      new Map([[GUID, '/preview/cooked.receipt.json']]),
    );
    expect(projected).toMatchObject({
      guid: GUID,
      packageUrl: `/preview/${desiredKey}`,
      revision: { digest: desiredKey },
      subject: 'imported-output',
      execution: 'cooked',
      refs: ['dependency-guid'],
      sourceOverrides: { 'mesh/main': { lod: 4 } },
      cookReceiptUrl: '/preview/cooked.receipt.json',
      lifecycle: 'current',
      projection: { lifecycle: 'current' },
    });
  });
});
