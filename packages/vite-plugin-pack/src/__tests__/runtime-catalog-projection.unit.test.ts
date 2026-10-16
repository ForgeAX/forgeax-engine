import { projectRuntimeCatalogRow } from '@forgeax/engine-pack/build';
import { describe, expect, it } from 'vitest';

const tuple = {
  scopeId: 'dev-session',
  generation: 3,
  digest: 'sha256:asset',
  outputSetDigest: 'sha256:outputs',
};

describe('runtime Catalog projection', () => {
  it('derives one row from the producer tuple without content facts', () => {
    const result = projectRuntimeCatalogRow({
      ...tuple,
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d45a',
      kind: 'mesh',
      packageUrl: '/assets/mesh.pack.json',
      sourcePath: 'mesh.gltf',
      subject: 'imported-output',
      execution: 'cooked',
      lifecycle: 'current',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        ...tuple,
        guid: '019e2cc6-0c86-79da-aa76-b0984c86d45a',
        kind: 'mesh',
        packageUrl: '/assets/mesh.pack.json',
        sourcePath: 'mesh.gltf',
        subject: 'imported-output',
        execution: 'cooked',
        lifecycle: 'current',
        projection: {
          subject: 'imported-output',
          execution: 'cooked',
          lifecycle: 'current',
          operations: expect.any(Object),
        },
      },
    });
  });

  it('rejects an old publication object or a second row for one GUID', () => {
    const legacy = projectRuntimeCatalogRow({
      ...tuple,
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d45a',
      kind: 'mesh',
      packageUrl: '/assets/mesh.pack.json',
      sourcePath: 'mesh.gltf',
      publication: { schemaVersion: 'asset-publication/1' },
    });
    expect(legacy).toMatchObject({
      ok: false,
      error: { code: 'invalid-producer-fact', subject: { id: expect.any(String) } },
    });

    const duplicate = projectRuntimeCatalogRow([
      { ...tuple, guid: 'same-guid', kind: 'mesh', packageUrl: '/a', sourcePath: 'a' },
      { ...tuple, guid: 'same-guid', kind: 'mesh', packageUrl: '/b', sourcePath: 'b' },
    ]);
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: 'invalid-producer-fact', subject: { id: 'same-guid' } },
    });
  });
});
