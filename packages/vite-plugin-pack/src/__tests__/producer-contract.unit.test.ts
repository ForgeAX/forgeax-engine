import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogImporterPolicyFor, sourceDeclarationForCatalogPath } from '@forgeax/engine-import';
import { buildCatalogProjection } from '@forgeax/engine-pack/build';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';

const scratch = temporaryDirectories();

afterEach(scratch.clear);

async function writeImportedFixture(
  root: string,
  source: string,
  facts: {
    readonly packageId: string;
    readonly provenance: {
      readonly provider: string;
      readonly version: string;
      readonly source?: string;
    };
    readonly revision?: {
      readonly digest: string;
      readonly observedAt: number;
      readonly rootId: string;
    };
    readonly diagnostics?: readonly {
      readonly code: string;
      readonly severity: string;
      readonly recoveryIntents: readonly string[];
    }[];
    readonly subAssets: readonly {
      readonly guid: string;
      readonly kind: string;
      readonly sourceKey: string;
      readonly sourceIndex: number;
    }[];
  },
): Promise<void> {
  await writeFile(join(root, source), 'producer fixture');
  await writeFile(
    join(root, `${source}.meta.json`),
    JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: facts.provenance.provider,
      source,
      importSettings: {},
      ...facts,
    }),
  );
}

describe('producer-owned catalog contract', () => {
  it('does not expose a parallel material completion contract', async () => {
    const source = await readFile(new URL('../plugin-pack.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './material/");
  });

  it('publishes Meta package, provenance, revision, diagnostics, and topology key', async () => {
    const root = await scratch.make('forgeax-vpp-producer-');
    const guid = '01890000-0000-7000-8000-aaaaaaaaaaaa';
    await writeImportedFixture(root, 'materials.source', {
      packageId: 'pkg/materials',
      provenance: { provider: 'fixture-importer', version: '2.3.0', source: 'fixture' },
      revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
      diagnostics: [
        { code: 'fixture-warning', severity: 'warning', recoveryIntents: ['reimport'] },
      ],
      subAssets: [{ guid, kind: 'material', sourceKey: 'material/main', sourceIndex: 0 }],
    });

    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(new Set(['fixture-importer'])),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      guid,
      packageId: 'pkg/materials',
      provenance: { provider: 'fixture-importer', version: '2.3.0', source: 'fixture' },
      revision: { digest: 'sha256:fixture', observedAt: 123, rootId: 'root-a' },
      sourceKey: 'material/main',
      sourceIndex: 0,
      diagnostics: [
        { code: 'fixture-warning', severity: 'warning', recoveryIntents: ['reimport'] },
      ],
    });
  });

  it('keeps an open host importer neutral without a concrete-kind branch', async () => {
    const root = await scratch.make('forgeax-vpp-host-');
    await writeImportedFixture(root, 'host.source', {
      packageId: 'pkg/host',
      provenance: { provider: 'host-fixture', version: '1.0.0' },
      subAssets: [
        {
          guid: '01890000-0000-7000-8000-cccccccccccc',
          kind: 'host/blob',
          sourceKey: 'blob/main',
          sourceIndex: 0,
        },
      ],
    });
    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(new Set(['host-fixture'])),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.entries[0]).toMatchObject({ kind: 'host/blob', sourceKey: 'blob/main' });
  });

  it('returns one authoritative result and derives the legacy array from it', async () => {
    const root = await scratch.make('forgeax-vpp-result-');
    await writeImportedFixture(root, 'result.source', {
      packageId: 'pkg/result',
      provenance: { provider: 'result-fixture', version: '1.0.0' },
      revision: { digest: 'sha256:result', observedAt: 7, rootId: 'root-result' },
      subAssets: [
        {
          guid: '01890000-0000-7000-8000-dddddddddddd',
          kind: 'host/result',
          sourceKey: 'result/main',
          sourceIndex: 0,
        },
      ],
    });
    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(new Set(['result-fixture'])),
    });
    expect(result).toMatchObject({ authority: 'authoritative', diagnostics: [] });
    expect(result.entries).toHaveLength(1);
    expect({
      authority: 'authoritative',
      diagnostics: [],
      entries: [...result.entries],
    }).toEqual({
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
    const root = await scratch.make('forgeax-vpp-source-identity-');
    const dep = '01890000-0000-7000-8000-aaaaaaaaaaaa';
    await writeFile(
      join(root, 'portable.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01890000-0000-7000-8000-eeeeeeeeeeee',
        assets: { 'mesh/main': { kind: 'mesh', payload: {}, refs: [dep] } },
      }),
    );

    const sourceIdentityFor = (sourcePath: string) =>
      sourcePath.endsWith('portable.pack.json') ? '@shared/portable.pack.json' : sourcePath;
    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(new Set()),
      visibility: () => true,
      sourceIdentityFor: sourceIdentityFor,
    });

    expect(result.authority).toBe('authoritative');
    expect(result.entries[0]).toMatchObject({
      sourcePath: '@shared/portable.pack.json',
      packageUrl: '/@shared/portable.pack.json',
      sourceKey: 'mesh/main',
      relations: [
        {
          from: { type: 'asset', id: result.entries[0]?.guid },
          to: { type: 'asset', id: dep },
          type: 'references',
        },
      ],
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
    const firstRoot = await scratch.make('forgeax-vpp-locator-a-');
    const secondRoot = await scratch.make('forgeax-vpp-locator-b-');
    const facts = {
      packageId: 'pkg/relocated',
      provenance: { provider: 'relocation-fixture', version: '1.0.0' },
      revision: { digest: 'sha256:relocated', observedAt: 8, rootId: 'root-relocated' },
      subAssets: [
        {
          guid: '01890000-0000-7000-8000-eeeeeeeeeeee',
          kind: 'host/relocated',
          sourceKey: 'relocated/main',
          sourceIndex: 0,
        },
      ],
    };
    await writeImportedFixture(firstRoot, 'old.source', facts);
    await writeImportedFixture(secondRoot, 'new.source', facts);

    const [oldResult, newResult] = await Promise.all([
      buildCatalogProjection([firstRoot], {
        importerPolicy: catalogImporterPolicyFor(new Set(['relocation-fixture'])),
      }),
      buildCatalogProjection([secondRoot], {
        importerPolicy: catalogImporterPolicyFor(new Set(['relocation-fixture'])),
      }),
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
