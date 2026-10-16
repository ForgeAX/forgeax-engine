import { type CatalogDelta, type CatalogEntry, catalogOperationsFor } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { CatalogReplica } from '../registry/catalog-state.js';

type EnumerationResult = { readonly ok: true; readonly value: readonly CatalogEntry[] };

const base = {
  guid: '11111111-1111-4111-8111-111111111111',
  packageUrl: '/preview/base',
  packageId: 'fixture-package',
  kind: 'mesh',
  sourcePath: 'model.source',
  sourceKey: 'mesh/main',
  sourceIndex: 0,
  provenance: { provider: 'fixture', version: '1' },
  revision: { digest: 'digest-1', observedAt: 1, rootId: 'fixture-root' },
  relations: [],
  lifecycle: 'current' as const,
  diagnostics: [{ code: 'fixture-note', severity: 'info' as const, hint: 'none' }],
};

const other = {
  ...base,
  guid: '22222222-2222-4222-8222-222222222222',
  sourceKey: 'mesh/other',
  sourceIndex: 1,
  packageUrl: '/preview/other',
};

function source() {
  let listener: ((delta: CatalogDelta) => void) | undefined;
  let enumerate: (() => Promise<EnumerationResult>) | undefined;
  const source = {
    subscribe(next: (delta: CatalogDelta) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    enumerate() {
      return enumerate?.() ?? Promise.resolve({ ok: true as const, value: [base] });
    },
  };
  return {
    source,
    emit(delta: CatalogDelta) {
      listener?.(delta);
    },
    deferEnumeration() {
      let resolve!: (result: EnumerationResult) => void;
      enumerate = () => new Promise((next) => (resolve = next));
      return (result: EnumerationResult) => resolve(result);
    },
  };
}

describe('CatalogReplica', () => {
  it('retains accepted LKG evidence on producer failure without adopting degraded identities', async () => {
    const fixture = source();
    const release = fixture.deferEnumeration();
    const replica = new CatalogReplica(fixture.source as never);
    const started = replica.start();
    const accepted = {
      ...base,
      projection: {
        subject: 'imported-output' as const,
        execution: 'cooked' as const,
        lifecycle: 'current' as const,
        operations: catalogOperationsFor({
          subject: 'imported-output',
          execution: 'cooked',
          lifecycle: 'current',
        }),
      },
    };
    release({ ok: true, value: [accepted, other] });
    await started;
    const before = replica.snapshot();
    fixture.emit({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [
        {
          code: 'source-package-conversion-failed',
          severity: 'blocking',
          hint: 'repair source',
          evidence: [{ type: 'asset', id: base.guid }],
        },
      ],
    });
    const failed = replica.snapshot();
    expect(failed.stale).toBe(true);
    expect(failed.version).toBe(before.version);
    expect(failed.entries[0]).toEqual({
      ...accepted,
      projection: {
        ...accepted.projection,
        lastKnownGood: { packageUrl: base.packageUrl },
      },
    });
    expect(failed.entries[1]).toEqual(other);
    fixture.emit({
      added: [],
      changed: [{ ...accepted, packageUrl: '/rejected' }],
      removed: [],
      authority: 'degraded',
    });
    expect(replica.snapshot().entries[0]?.packageUrl).toBe(base.packageUrl);
    replica.dispose();
  });

  it('subscribes before enumerate and folds an early delta after the baseline', async () => {
    const fixture = source();
    const release = fixture.deferEnumeration();
    const replica = new CatalogReplica(fixture.source as never);
    const started = replica.start();

    fixture.emit({ added: [other], changed: [], removed: [] });
    release({ ok: true, value: [base] });
    await expect(started).resolves.toMatchObject({ ok: true });
    expect(replica.snapshot().entries.map((entry) => entry.guid)).toEqual([base.guid, other.guid]);
  });

  it('is idempotent, rejects older revisions, and preserves complete producer facts', async () => {
    const fixture = source();
    const replica = new CatalogReplica(fixture.source as never);
    await replica.start();
    const delta = {
      added: [],
      changed: [
        { ...base, packageUrl: '/preview/new', revision: { ...base.revision, observedAt: 2 } },
      ],
      removed: [],
      revisions: {
        baseline: [{ rootId: 'fixture-root', revision: 1 }],
        current: [{ rootId: 'fixture-root', revision: 2 }],
      },
    };

    fixture.emit(delta);
    fixture.emit(delta);
    fixture.emit({
      ...delta,
      changed: [
        { ...base, packageUrl: '/preview/old', revision: { ...base.revision, observedAt: 1 } },
      ],
      revisions: {
        baseline: [{ rootId: 'fixture-root', revision: 2 }],
        current: [{ rootId: 'fixture-root', revision: 1 }],
      },
    });

    const row = replica.snapshot().entries.find((entry) => entry.guid === base.guid);
    expect(row).toMatchObject({
      packageUrl: '/preview/new',
      sourceKey: 'mesh/main',
      provenance: base.provenance,
      relations: base.relations,
      diagnostics: base.diagnostics,
    });
    expect(replica.snapshot().version).toBe(1);
  });

  it('marks degraded gaps stale and reconcile restores the authoritative set', async () => {
    const fixture = source();
    const release = fixture.deferEnumeration();
    const replica = new CatalogReplica(fixture.source as never);
    const started = replica.start();
    release({ ok: true, value: [base] });
    await started;

    fixture.emit({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [{ code: 'catalog-gap', severity: 'blocking', hint: 'reconcile' }],
    });
    expect(replica.snapshot()).toMatchObject({ stale: true });

    const reconciling = replica.reconcile();
    release({ ok: true, value: [other] });
    await expect(reconciling).resolves.toMatchObject({ ok: true });
    expect(replica.snapshot()).toMatchObject({ stale: false, entries: [other] });
  });

  it('reuses a baseline accepted by reconcile when a consumer starts later', async () => {
    const enumerate = vi.fn().mockResolvedValue({ ok: true as const, value: [base] });
    const replica = new CatalogReplica({
      enumerate,
      subscribe: () => () => {},
      expectedRevision: base.revision,
    } as never);

    await expect(replica.reconcile()).resolves.toMatchObject({
      ok: true,
      value: { entries: [base] },
    });
    await expect(replica.start()).resolves.toMatchObject({ ok: true, value: { entries: [base] } });
    expect(enumerate).toHaveBeenCalledTimes(1);
  });

  it('does not publish or apply a changed row whose revision window is stale', async () => {
    const fixture = source();
    const replica = new CatalogReplica(fixture.source as never);
    await replica.start();
    const received: CatalogDelta[] = [];
    replica.subscribe((delta) => received.push(delta));
    const staleEntry = {
      ...base,
      packageUrl: '/preview/stale',
      revision: { ...base.revision, observedAt: 3 },
    };

    fixture.emit({
      added: [],
      changed: [staleEntry],
      removed: [],
      revisions: {
        baseline: [{ rootId: 'fixture-root', revision: 2 }],
        current: [{ rootId: 'fixture-root', revision: 1 }],
      },
    });

    expect(replica.snapshot()).toMatchObject({
      stale: true,
      entries: [{ guid: base.guid, packageUrl: base.packageUrl }],
      diagnostics: [{ code: 'catalog-revision-stale', severity: 'blocking' }],
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [{ code: 'catalog-revision-stale', severity: 'blocking' }],
    });
  });

  it('rejects a changed payload that reuses the verified row revision', async () => {
    const fixture = source();
    const replica = new CatalogReplica(fixture.source as never);
    await replica.start();
    const received: CatalogDelta[] = [];
    replica.subscribe((delta) => received.push(delta));

    fixture.emit({
      added: [],
      changed: [{ ...base, packageUrl: '/preview/unchanged-revision' }],
      removed: [],
    });

    expect(replica.snapshot()).toMatchObject({
      stale: true,
      entries: [{ guid: base.guid, packageUrl: base.packageUrl }],
      diagnostics: [{ code: 'catalog-revision-conflict', severity: 'blocking' }],
    });
    expect(received[0]).toMatchObject({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [{ code: 'catalog-revision-conflict', severity: 'blocking' }],
    });
  });

  it('applies a failed lifecycle projection when the producer advances its observation revision', async () => {
    const fixture = source();
    const replica = new CatalogReplica(fixture.source as never);
    await replica.start();

    fixture.emit({
      added: [],
      changed: [
        {
          ...base,
          lifecycle: 'failed',
          revision: {
            digest: 'failure:source-package-ddc-failed:sha256:old',
            observedAt: 2,
            rootId: base.revision.rootId,
          },
          diagnostics: [
            {
              code: 'source-package-ddc-failed',
              severity: 'blocking',
              hint: 'repair and retry',
            },
          ],
        },
      ],
      removed: [],
    });

    expect(replica.snapshot().entries[0]).toMatchObject({
      guid: base.guid,
      lifecycle: 'failed',
      revision: { observedAt: 2 },
    });
    expect(replica.snapshot().stale).toBe(false);
  });
});
