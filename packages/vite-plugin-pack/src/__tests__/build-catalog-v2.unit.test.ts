import { projectCookedPackageEntry, projectPackageCatalog } from '@forgeax/engine-pack/build';
import { authoringCapabilityForAssetKind } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('catalog builder v2', () => {
  it('projects every asset in one package to the same packageUrl', () => {
    const rows = projectPackageCatalog(
      [
        {
          guid: 'a',
          kind: 'mesh',
          sourcePath: 'model.glb',
          name: 'body',
          refs: ['b'],
          authoring: authoringCapabilityForAssetKind('mesh'),
        },
        {
          guid: 'b',
          kind: 'texture',
          sourcePath: 'model.glb',
          name: 'albedo',
          refs: [],
          authoring: authoringCapabilityForAssetKind('texture'),
        },
      ],
      '/preview/packages/model',
    );

    expect(rows).toEqual([
      expect.objectContaining({
        guid: 'a',
        kind: 'mesh',
        sourcePath: 'model.glb',
        name: 'body',
        refs: ['b'],
        relations: [
          {
            from: { type: 'asset', id: 'a' },
            to: { type: 'asset', id: 'b' },
            type: 'references',
            policy: { strength: 'required' },
            provenance: { provider: 'pack', version: 'unknown' },
          },
        ],
        packageUrl: '/preview/packages/model',
        authoring: authoringCapabilityForAssetKind('mesh'),
        subject: 'internal-asset',
        execution: 'direct',
        lifecycle: 'current',
        projection: expect.objectContaining({
          subject: 'internal-asset',
          execution: 'direct',
          lifecycle: 'current',
        }),
      }),
      expect.objectContaining({
        guid: 'b',
        kind: 'texture',
        sourcePath: 'model.glb',
        name: 'albedo',
        refs: [],
        packageUrl: '/preview/packages/model',
        authoring: authoringCapabilityForAssetKind('texture'),
        subject: 'internal-asset',
        execution: 'direct',
        lifecycle: 'current',
        projection: expect.objectContaining({
          subject: 'internal-asset',
          execution: 'direct',
          lifecycle: 'current',
        }),
      }),
    ]);
  });

  it('keeps catalog rows free of artifact content facts', () => {
    const [row] = projectPackageCatalog(
      [{ guid: 'a', kind: 'host-kind', sourcePath: 'source.meta.json' }],
      '/preview/packages/source',
    );

    expect(row).toBeDefined();
    expect(row?.packageUrl).toBe('/preview/packages/source');
    expect(row).not.toHaveProperty('metadata');
    expect(row).not.toHaveProperty('compression');
    expect(row).not.toHaveProperty('artifacts');
    expect(row).not.toHaveProperty('authoring');
  });

  it('preserves a producer override for a new kind without consumer knowledge', () => {
    const authoring = {
      placement: { operation: 'spawnEntity' as const },
      binding: {
        operation: 'unavailable' as const,
        reason: { code: 'missing-producer-capability' as const, hint: 'provider-owned' },
      },
    };
    const [row] = projectPackageCatalog(
      [{ guid: 'custom', kind: 'host/new-kind', sourcePath: 'custom.meta.json', authoring }],
      '/preview/custom',
    );
    expect(row?.authoring).toEqual(authoring);
  });

  it('publishes the built-in UI authoring contract for legacy rows without an override', () => {
    const [row] = projectPackageCatalog(
      [{ guid: 'ui-guid', kind: 'ui', sourcePath: 'menu.ui.html' }],
      '/preview/ui',
    );

    expect(row?.authoring?.ui).toMatchObject({
      contractVersion: '1',
      profileVersion: '1',
      preview: { operation: 'createUiPreviewSession' },
      mount: { operation: 'mountUi' },
    });
  });

  it('preserves the producer revision on every projected navigation row', () => {
    const revision = {
      digest: 'sha256:revision',
      observedAt: 42,
      rootId: 'generated.pack.ts',
    };
    const [row] = projectPackageCatalog(
      [
        {
          guid: 'revision-guid',
          kind: 'scene',
          sourcePath: 'generated.pack.ts',
          revision,
        } as unknown as Parameters<typeof projectPackageCatalog>[0][number],
      ],
      '/assets/generated.pack.json',
    );

    expect(row).toMatchObject({
      packageUrl: '/assets/generated.pack.json',
      sourcePath: 'generated.pack.ts',
      revision,
      lifecycle: 'current',
    });
  });

  it('projects a complete cooked package as one current row with receipt and refs', () => {
    const row = projectCookedPackageEntry(
      {
        guid: 'cooked-guid',
        kind: 'mesh',
        sourcePath: 'generated.pack.ts',
        packageUrl: '/source.pack.json',
      },
      {
        packageUrl: '/assets/cooked.pack.json',
        cookReceiptUrl: '/assets/cooked.receipt.json',
        revision: { digest: 'sha256:generation', observedAt: 7, rootId: 'generated.pack.ts' },
        refs: ['dependency-guid'],
      },
    );

    expect(row).toMatchObject({
      packageUrl: '/assets/cooked.pack.json',
      cookReceiptUrl: '/assets/cooked.receipt.json',
      refs: ['dependency-guid'],
      subject: 'imported-output',
      execution: 'cooked',
      lifecycle: 'current',
      revision: { digest: 'sha256:generation' },
    });
  });
});
