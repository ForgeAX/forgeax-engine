import { describe, expect, it } from 'vitest';
import {
  assertNativeCookerRootTable,
  buildMaterialWitnessReceipt,
  canonicalRootGuidFromMeta,
  ensureStandardSurfaceModuleSlot,
  MaterialWitnessBlockedError,
  selectCanonicalRootPublication,
} from '../../../packages/vite-plugin-pack/scripts/material-witness-smoke.mjs';

const ROOT_GUID = '019f0000-0000-7000-8000-000000000201';
const CONTEXT = {
  kind: 'gltf',
  sourcePath: '/project/assets/box.gltf',
  metaPath: '/project/assets/box.gltf.meta.json',
};

describe('material witness root resolution', () => {
  it('projects a compact receipt without cooked bytes or absolute paths', () => {
    const receipt = buildMaterialWitnessReceipt('gltf', {
      guid: '019f0000-0000-7000-8000-000000000103',
      rootGuid: ROOT_GUID,
      rootPublicationSource: {
        guid: ROOT_GUID,
        format: 'ts',
        path: 'templates/game-3d/assets/materials.pack.ts',
        sourceKey: 'material/standard-root',
      },
      material: { kind: 'material', parent: ROOT_GUID, values: { roughness: 0.5 } },
      publication: {
        record: {
          artifactDigest: 'sha256:artifact',
          receipt: { identity: { artifactDigest: 'sha256:artifact' } },
        },
      },
      sourceClosure: [
        `${process.cwd()}/packages/shader/src/default-standard-pbr.wgsl`,
        'forgeax::module',
      ],
    });

    expect(receipt).toMatchObject({
      schemaVersion: 'material-witness-receipt/1',
      kind: 'material-witness-receipt',
      sourceKind: 'gltf',
      materialGuid: '019f0000-0000-7000-8000-000000000103',
      rootGuid: ROOT_GUID,
      child: { authoredKeys: ['kind', 'parent', 'values'], forbiddenFields: [] },
      artifactDigest: 'sha256:artifact',
      sourceClosure: ['packages/shader/src/default-standard-pbr.wgsl', 'forgeax::module'],
    });
    expect(JSON.stringify(receipt)).not.toContain('artifactBytes');
    expect(JSON.stringify(receipt)).not.toContain('/project/');
  });

  it('consumes only the source-declared canonical Standard root', () => {
    expect(
      canonicalRootGuidFromMeta({ importSettings: { standardMaterialGuid: ROOT_GUID } }, CONTEXT),
    ).toBe(ROOT_GUID);
  });

  it('blocks when an imported source has no canonical root declaration', () => {
    expect(() => canonicalRootGuidFromMeta({ importSettings: {} }, CONTEXT)).toThrow(
      MaterialWitnessBlockedError,
    );
    try {
      canonicalRootGuidFromMeta({ importSettings: {} }, CONTEXT);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-canonical-root-not-declared',
        detail: {
          field: 'importSettings.standardMaterialGuid',
          reason: 'missing-standard-material-guid',
        },
      });
    }
  });

  it('requires a Pack root table for parent-bearing material cooks', () => {
    expect(() =>
      assertNativeCookerRootTable(
        'gltf',
        { parent: ROOT_GUID },
        '/project/packages/shader/src/default-standard-pbr.wgsl',
        undefined,
      ),
    ).toThrow(MaterialWitnessBlockedError);
    try {
      assertNativeCookerRootTable('gltf', { parent: ROOT_GUID }, '/project/material.wgsl');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-canonical-root-table-unavailable',
        detail: {
          parentGuid: ROOT_GUID,
          table: 'missing',
          reason: 'native-cooker-input-has-no-pack-root-table',
        },
      });
    }
    expect(
      assertNativeCookerRootTable(
        'gltf',
        { parent: ROOT_GUID },
        '/project/packages/shader/src/default-standard-pbr.wgsl',
        { [ROOT_GUID]: { kind: 'material' } },
      ),
    ).toBe(undefined);
  });

  it('does not block leaf materials that have no parent edge', () => {
    expect(
      assertNativeCookerRootTable('builtin', { kind: 'material' }, '/project/material.wgsl'),
    ).toBe(undefined);
  });

  it('injects the Standard surface slot on root passes without adding fields to children', () => {
    const child = { kind: 'material', parent: ROOT_GUID, values: { roughness: 0.5 } };
    expect(ensureStandardSurfaceModuleSlot(child)).toBe(child);
    expect(Object.keys(ensureStandardSurfaceModuleSlot(child)).sort()).toEqual([
      'kind',
      'parent',
      'values',
    ]);

    const root = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    };
    expect(ensureStandardSurfaceModuleSlot(root)).toMatchObject({
      passes: [
        { program: { moduleSlots: { surface: 'forgeax_material::default_standard_surface' } } },
      ],
    });
  });

  it('requires one exact source-declared root publication', () => {
    const publication = {
      guid: ROOT_GUID,
      asset: { kind: 'material', values: {} },
      format: 'ts',
      path: 'templates/game-3d/assets/materials.pack.ts',
      sourceKey: 'material/standard-root',
    };
    expect(
      selectCanonicalRootPublication(ROOT_GUID, 'gltf', '/project/assets/box.gltf', [publication]),
    ).toEqual({
      asset: publication.asset,
      provenance: {
        guid: ROOT_GUID,
        format: publication.format,
        path: publication.path,
        sourceKey: publication.sourceKey,
      },
    });
    expect(() =>
      selectCanonicalRootPublication(ROOT_GUID, 'gltf', '/project/assets/box.gltf', []),
    ).toThrow(MaterialWitnessBlockedError);
    try {
      selectCanonicalRootPublication(ROOT_GUID, 'gltf', '/project/assets/box.gltf', []);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-canonical-root-not-published',
        detail: { matchCount: 0, reason: 'source-pack-root-row-unavailable' },
      });
    }
    expect(() =>
      selectCanonicalRootPublication(ROOT_GUID, 'gltf', '/project/assets/box.gltf', [
        publication,
        { ...publication, path: '/project/assets/duplicate.pack.json' },
      ]),
    ).toThrow(MaterialWitnessBlockedError);
    try {
      selectCanonicalRootPublication(ROOT_GUID, 'gltf', '/project/assets/box.gltf', [
        publication,
        { ...publication, path: '/project/assets/duplicate.pack.json' },
      ]);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'material-canonical-root-ambiguous',
        detail: { matchCount: 2, reason: 'duplicate-source-pack-root-rows' },
      });
    }
  });
});
