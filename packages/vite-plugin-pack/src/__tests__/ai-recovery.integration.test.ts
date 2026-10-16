import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { CatalogSession } from '@forgeax/engine-assets-runtime/internal';
import { createAcceptedPublicationStore, scriptablePackOutputSetDigest } from '@forgeax/engine-ddc';
import { sourcePackageError } from '@forgeax/engine-import';
import { validateProducerOutputs } from '@forgeax/engine-pack/build';
import type {
  AssetPublicationEnvelope,
  AssetPublicationOutput,
  CatalogDelta,
  CatalogEntry,
  ImportedOutputDeclaration,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const GUID = '019e2cc6-0c86-79da-aa76-b0984c86d411';
const DEPENDENCY_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d412';

function publication(generation: number): AssetPublicationEnvelope {
  const outputs: readonly AssetPublicationOutput[] = [
    {
      guid: GUID,
      sourceKey: 'fixture/main',
      kind: 'fixture/blob',
      digest: `sha256:output-${generation}`,
      refs: [DEPENDENCY_GUID],
    },
  ];
  const outputSetDigest = scriptablePackOutputSetDigest(outputs);
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: 'assets/fixture.pack.ts',
    sourceRevision: `sha256:source-${generation}`,
    generation,
    digest: `sha256:publication-${generation}`,
    outputSetDigest,
    outputs,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: 'assets/fixture.pack.ts',
      sourceRevision: `sha256:source-${generation}`,
      inputFingerprint: `sha256:input-${generation}`,
      outputDigest: `sha256:publication-${generation}`,
      outputSetDigest,
      externalEvidence: [],
    },
    externalEvidence: [],
  };
}

function catalogEntry(): CatalogEntry {
  return {
    guid: GUID,
    packageUrl: '/assets/fixture.pack.json',
    kind: 'fixture/blob',
    sourcePath: 'assets/fixture.json',
    sourceKey: 'fixture/main',
    sourceIndex: 0,
    publication: publication(1),
  };
}

describe('public AI recovery path', () => {
  it('branches on structured producer failure and repairs the same output topology', () => {
    const failure = sourcePackageError(
      'source-package-importer-missing',
      {
        sourceMeta: 'assets/fixture.json.meta.json',
        anchorGuid: GUID,
        affectedGuids: [GUID],
        producer: 'source-package/fixture',
        importer: 'fixture',
      },
      { stage: 'importer', registeredImporters: [] },
    );
    expect(failure.code).toBe('source-package-importer-missing');
    expect(failure.detail.anchorGuid).toBe(GUID);
    expect(failure.hint).toContain('rebuild');

    const outputs: ImportedOutputDeclaration[] = [
      { guid: GUID, kind: 'fixture/blob', sourceKey: 'fixture/main', sourceIndex: 0 },
      {
        guid: DEPENDENCY_GUID,
        kind: 'fixture/blob',
        sourceKey: 'fixture/main',
        sourceIndex: 1,
      },
    ];
    const invalid = validateProducerOutputs(outputs);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    const repaired: ImportedOutputDeclaration[] = outputs.map((output, index) => ({
      ...output,
      sourceKey: index === 0 ? 'fixture/main' : 'fixture/dependency',
    }));
    expect(validateProducerOutputs(repaired)).toMatchObject({ ok: true });
    expect(invalid.error.hint).toMatch(/semantic output key/);
  });

  it('rejects a scope-mismatched delta, reconciles it, and keeps the accepted rows', async () => {
    let emit: ((delta: CatalogDelta) => void) | undefined;
    const source = createCatalogSource({
      entries: [catalogEntry()],
      expectedScope: { scopeId: 'fixture', generation: 1 },
      subscribe: (listener) => {
        emit = listener;
        return () => {
          emit = undefined;
        };
      },
    });
    const session = new CatalogSession(source);
    const observed: Array<ReturnType<CatalogSession['snapshot']>> = [];
    await session.start();
    const stop = session.subscribe((snapshot) => observed.push(snapshot));

    emit?.({ added: [catalogEntry()], changed: [], removed: [], scopeId: 'other', generation: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observed.at(-1)).toMatchObject({
      stale: true,
      diagnostics: [{ code: 'catalog-scope-mismatch' }],
    });
    expect(session.snapshot().stale).toBe(true);
    const recovered = await session.reconcile();
    expect(recovered.ok).toBe(true);
    expect(session.snapshot()).toMatchObject({ stale: false, entries: [catalogEntry()] });
    stop();
    session.dispose();
  });

  it('does not promote a failed candidate and atomically restores it on retry', async () => {
    const store = createAcceptedPublicationStore();
    const first = publication(1);
    const second = publication(2);
    expect(store.stage(first.sourcePath, { envelope: first }).ok).toBe(true);
    expect((await store.commit(first.sourcePath, { envelope: first }, () => undefined)).ok).toBe(
      true,
    );

    expect(store.stage(second.sourcePath, { envelope: second }).ok).toBe(true);
    const failed = await store.commit(second.sourcePath, { envelope: second }, () => {
      throw new Error('fixture route unavailable');
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'asset-publication-route-failed', recovery: { preserveCurrent: true } },
    });
    expect(store.observe(first.sourcePath)).toMatchObject({ current: { generation: 1 } });

    expect(store.stage(second.sourcePath, { envelope: second }).ok).toBe(true);
    const recovered = await store.commit(second.sourcePath, { envelope: second }, () => undefined);
    expect(recovered).toMatchObject({
      ok: true,
      value: { current: { generation: 2 }, lastKnownGood: { generation: 1 } },
    });
  });
});
