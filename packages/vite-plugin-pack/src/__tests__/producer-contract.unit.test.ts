import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcceptedPublicationStore, scriptablePackOutputSetDigest } from '@forgeax/engine-ddc';
import { buildCatalogResult } from '@forgeax/engine-import';
import type { AssetPublicationEnvelope, AssetPublicationOutput } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceDeclarationForCatalogPath } from '../dev/source-path.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('producer-owned catalog contract', () => {
  function envelope(generation: number): AssetPublicationEnvelope {
    const outputs: AssetPublicationOutput[] = [
      {
        guid: '01890000-0000-7000-8000-111111111111',
        sourceKey: 'mesh/main',
        kind: 'mesh',
        digest: `sha256:mesh-${generation}`,
        refs: [],
      },
      {
        guid: '01890000-0000-7000-8000-222222222222',
        sourceKey: 'scene/main',
        kind: 'scene',
        digest: `sha256:scene-${generation}`,
        refs: ['01890000-0000-7000-8000-111111111111'],
      },
    ];
    const outputSetDigest = scriptablePackOutputSetDigest(outputs);
    const externalEvidence = [] as const;
    return {
      schemaVersion: 'asset-publication/1',
      sourcePath: 'fixture.pack.ts',
      sourceRevision: `sha256:source-${generation}`,
      generation,
      digest: `sha256:publication-${generation}`,
      outputSetDigest,
      outputs,
      receipt: {
        schemaVersion: 'asset-publication-receipt/1',
        sourcePath: 'fixture.pack.ts',
        sourceRevision: `sha256:source-${generation}`,
        inputFingerprint: `sha256:input-${generation}`,
        outputDigest: `sha256:publication-${generation}`,
        outputSetDigest,
        externalEvidence,
      },
      externalEvidence,
    };
  }

  it('commits one complete generation and preserves current/LKG on stale or failed routes', async () => {
    const store = createAcceptedPublicationStore();
    const firstEnvelope = envelope(1);
    expect(store.stage(firstEnvelope.sourcePath, { envelope: firstEnvelope }).ok).toBe(true);
    const first = await store.commit(
      firstEnvelope.sourcePath,
      { envelope: firstEnvelope },
      () => undefined,
    );
    expect(first.ok).toBe(true);
    expect(store.observe(firstEnvelope.sourcePath).current?.generation).toBe(1);

    let routeCommits = 0;
    const secondEnvelope = envelope(2);
    expect(store.stage(secondEnvelope.sourcePath, { envelope: secondEnvelope }).ok).toBe(true);
    const second = await store.commit(
      secondEnvelope.sourcePath,
      { envelope: secondEnvelope },
      () => {
        routeCommits += 1;
      },
    );
    expect(second.ok).toBe(true);
    expect(store.observe(secondEnvelope.sourcePath).current?.generation).toBe(2);

    const staleEnvelope = envelope(1);
    const stale = store.stage(staleEnvelope.sourcePath, { envelope: staleEnvelope });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'asset-publication-stale', stage: 'cancelled' },
    });
    expect(routeCommits).toBe(1);
    expect(store.observe(secondEnvelope.sourcePath).current?.generation).toBe(2);

    const failedEnvelope = envelope(3);
    expect(store.stage(failedEnvelope.sourcePath, { envelope: failedEnvelope }).ok).toBe(true);
    const failed = await store.commit(
      failedEnvelope.sourcePath,
      { envelope: failedEnvelope },
      () => {
        routeCommits += 1;
        throw new Error('route unavailable');
      },
    );
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: 'asset-publication-route-failed',
        stage: 'route',
        recovery: { preserveCurrent: true, useLastKnownGood: true },
      },
    });
    expect(routeCommits).toBe(2);
    expect(store.observe(failedEnvelope.sourcePath).current?.generation).toBe(2);
    expect(store.observe(failedEnvelope.sourcePath).lastKnownGood?.generation).toBe(1);
  });

  it('accepts an exact same-generation tuple as an idempotent republish', async () => {
    const store = createAcceptedPublicationStore();
    const first = envelope(1);
    expect(store.stage(first.sourcePath, { envelope: first }).ok).toBe(true);
    expect((await store.commit(first.sourcePath, { envelope: first }, () => undefined)).ok).toBe(
      true,
    );

    let routeCommits = 0;
    expect(store.stage(first.sourcePath, { envelope: first }).ok).toBe(true);
    const repeated = await store.commit(first.sourcePath, { envelope: first }, () => {
      routeCommits += 1;
    });

    expect(repeated).toMatchObject({ ok: true, value: { current: { generation: 1 } } });
    expect(routeCommits).toBe(1);
    expect(store.observe(first.sourcePath).failure).toBeUndefined();
  });

  it('keeps an overlapping identical tuple owned by the current candidate', async () => {
    const store = createAcceptedPublicationStore();
    const staleOwner = envelope(1);
    const currentOwner = envelope(1);

    expect(store.stage(staleOwner.sourcePath, { envelope: staleOwner }).ok).toBe(true);
    expect(store.stage(currentOwner.sourcePath, { envelope: currentOwner }).ok).toBe(true);
    store.discard(staleOwner.sourcePath, staleOwner);

    const committed = await store.commit(
      currentOwner.sourcePath,
      { envelope: currentOwner },
      () => undefined,
    );

    expect(committed.ok).toBe(true);
    expect(store.observe(currentOwner.sourcePath).current?.generation).toBe(1);
  });

  it('discards a staged candidate without changing the accepted DDC snapshot', async () => {
    const store = createAcceptedPublicationStore();
    const first = envelope(1);
    const second = envelope(2);
    expect(store.stage(first.sourcePath, { envelope: first }).ok).toBe(true);
    expect((await store.commit(first.sourcePath, { envelope: first }, () => undefined)).ok).toBe(
      true,
    );
    expect(store.stage(second.sourcePath, { envelope: second }).ok).toBe(true);

    store.discard(second.sourcePath, second);

    const restored = store.observe(first.sourcePath);
    expect(restored).toMatchObject({ current: { generation: 1, digest: first.digest } });
    expect(restored.lastKnownGood).toBeUndefined();
    expect(restored.failure).toBeUndefined();
  });

  it('restores the accepted publication snapshot after a failed generation commit', async () => {
    const store = createAcceptedPublicationStore();
    const first = envelope(1);
    const second = envelope(2);
    expect(store.stage(first.sourcePath, { envelope: first }).ok).toBe(true);
    expect((await store.commit(first.sourcePath, { envelope: first }, () => undefined)).ok).toBe(
      true,
    );
    const previous = store.observe(first.sourcePath);

    expect(store.stage(second.sourcePath, { envelope: second }).ok).toBe(true);
    expect((await store.commit(second.sourcePath, { envelope: second }, () => undefined)).ok).toBe(
      true,
    );
    expect(store.observe(second.sourcePath).current?.generation).toBe(2);

    store.restore(second.sourcePath, previous);

    expect(store.observe(second.sourcePath)).toEqual(previous);
  });

  it('does not expose a parallel material completion contract', async () => {
    const source = await readFile(new URL('../plugin-pack.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './material/");
    expect(source).not.toContain('MaterialCookResult');
  });

  it('publishes package, provenance, revision, relations, diagnostics, and topology key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-producer-'));
    roots.push(root);
    const guid = '01890000-0000-7000-8000-aaaaaaaaaaaa';
    const dep = '01890000-0000-7000-8000-bbbbbbbbbbbb';
    await writeFile(
      join(root, 'materials.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        packageId: 'pkg/materials',
        provenance: { provider: 'fixture-importer', version: '2.3.0', source: 'fixture' },
        revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
        diagnostics: [
          { code: 'fixture-warning', severity: 'warning', recoveryIntents: ['reimport'] },
        ],
        assets: [
          {
            guid,
            kind: 'material',
            sourceKey: 'material/main',
            payload: {},
            refs: [dep],
          },
        ],
      }),
    );

    const result = await buildCatalogResult([root]);
    expect(result.diagnostics).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      guid,
      packageId: 'pkg/materials',
      provenance: { provider: 'fixture-importer', version: '2.3.0', source: 'fixture' },
      revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
      sourceKey: 'material/main',
      sourceIndex: 0,
      relations: [
        {
          from: { type: 'asset', id: guid },
          to: { type: 'asset', id: dep },
          type: 'references',
        },
      ],
      diagnostics: [
        { code: 'fixture-warning', severity: 'warning', recoveryIntents: ['reimport'] },
      ],
    });
  });

  it('keeps an open host importer neutral without a concrete-kind branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-host-'));
    roots.push(root);
    await writeFile(
      join(root, 'host.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        packageId: 'pkg/host',
        provenance: { provider: 'host-fixture', version: '1.0.0' },
        assets: [
          {
            guid: '01890000-0000-7000-8000-cccccccccccc',
            kind: 'host/blob',
            sourceKey: 'blob/main',
            sourceIndex: 0,
            payload: {},
            refs: [],
          },
        ],
      }),
    );
    const result = await buildCatalogResult([root]);
    expect(result.diagnostics).toEqual([]);
    expect(result.entries[0]).toMatchObject({ kind: 'host/blob', sourceKey: 'blob/main' });
  });

  it('returns one authoritative result and derives the legacy array from it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-result-'));
    roots.push(root);
    await writeFile(
      join(root, 'result.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        packageId: 'pkg/result',
        provenance: { provider: 'result-fixture', version: '1.0.0' },
        revision: { digest: 'sha256:result', observedAt: 7, rootId: 'root-result' },
        assets: [
          {
            guid: '01890000-0000-7000-8000-dddddddddddd',
            kind: 'host/result',
            sourceKey: 'result/main',
            sourceIndex: 0,
            payload: {},
            refs: [],
          },
        ],
      }),
    );

    const result = await buildCatalogResult([root]);
    expect(result).toMatchObject({ authority: 'authoritative', diagnostics: [] });
    expect(result.entries).toHaveLength(1);
    expect({
      schemaVersion: 'catalog-legacy-v1',
      authority: 'authoritative',
      diagnostics: [],
      entries: [...result.entries],
    }).toEqual({
      schemaVersion: 'catalog-legacy-v1',
      authority: 'authoritative',
      diagnostics: [],
      entries: result.entries,
    });
    expect(result.entries[0]).toMatchObject({
      packageId: 'pkg/result',
      sourceKey: 'result/main',
      revision: { digest: 'sha256:result', rootId: 'root-result' },
    });
  });

  it('projects catalog locators through a stable host identity without changing scan paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-source-identity-'));
    roots.push(root);
    await writeFile(
      join(root, 'portable.pack.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: '01890000-0000-7000-8000-eeeeeeeeeeee',
            kind: 'mesh',
            payload: {},
            refs: [],
          },
        ],
      }),
    );

    const sourceIdentityFor = (sourcePath: string) =>
      sourcePath.endsWith('portable.pack.json') ? '@shared/portable.pack.json' : sourcePath;
    const result = await buildCatalogResult(
      [root],
      '/',
      new Set(),
      {},
      () => true,
      sourceIdentityFor,
    );

    expect(result.authority).toBe('authoritative');
    expect(result.entries[0]).toMatchObject({
      sourcePath: '@shared/portable.pack.json',
      packageUrl: '/@shared/portable.pack.json',
    });
    expect(result.sourceDeclarations.keys().next().value).toBe(join(root, 'portable.pack.json'));
    expect(
      sourceDeclarationForCatalogPath(
        '@shared/portable.pack.json',
        result.sourceDeclarations,
        sourceIdentityFor,
      )?.sourcePath,
    ).toBe(join(root, 'portable.pack.json'));
  });

  it('keeps producer identity and revision facts when a locator moves', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-locator-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-locator-b-'));
    roots.push(firstRoot, secondRoot);
    const pack = (source: string) => ({
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      packageId: 'pkg/relocated',
      provenance: { provider: 'relocation-fixture', version: '1.0.0' },
      revision: { digest: 'sha256:relocated', observedAt: 8, rootId: 'root-relocated' },
      assets: [
        {
          guid: '01890000-0000-7000-8000-eeeeeeeeeeee',
          kind: 'host/relocated',
          sourceKey: 'relocated/main',
          sourceIndex: 0,
          payload: { source },
          refs: [],
        },
      ],
    });
    await writeFile(join(firstRoot, 'old.pack.json'), JSON.stringify(pack('old')));
    await writeFile(join(secondRoot, 'new.pack.json'), JSON.stringify(pack('new')));

    const [oldResult, newResult] = await Promise.all([
      buildCatalogResult([firstRoot]),
      buildCatalogResult([secondRoot]),
    ]);
    expect(oldResult.entries[0]).toMatchObject({
      packageId: 'pkg/relocated',
      sourceKey: 'relocated/main',
      revision: { digest: 'sha256:relocated' },
    });
    expect(newResult.entries[0]).toMatchObject({
      packageId: 'pkg/relocated',
      sourceKey: 'relocated/main',
      revision: { digest: 'sha256:relocated' },
    });
    expect(newResult.entries[0]?.sourcePath).not.toBe(oldResult.entries[0]?.sourcePath);
  });
});
