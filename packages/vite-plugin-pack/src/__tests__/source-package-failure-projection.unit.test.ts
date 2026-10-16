import { describe, expect, it } from 'vitest';
import {
  catalogDiagnosticForSourcePackageError,
  projectSourcePackageFailure,
} from '../dev/transport-routes.js';

const BAD_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const GOOD_GUID = '019e3969-1d48-7c3b-ac24-6d68f4570650';

describe('source-package failure projection', () => {
  it('isolates one malformed source row and points the diagnostic at that source', () => {
    const sourcePath = '/game/assets/character.glb';
    const error = {
      code: 'source-package-conversion-failed' as const,
      expected: 'the configured importer to convert the source successfully',
      hint: 'repair the source or importer, then rebuild or cold-cook the source package',
      detail: {
        sourceMeta: sourcePath,
        anchorGuid: BAD_GUID,
        affectedGuids: [BAD_GUID],
        producer: 'vite-plugin-pack',
        importer: 'gltf',
        stage: 'conversion' as const,
        reason: 'parseGltf failed: gltf-buffer-out-of-bounds accessorIndex=7',
      },
    };
    const rows = [
      {
        guid: BAD_GUID,
        packageUrl: '/bad.pack.json',
        kind: 'mesh',
        sourcePath,
        revision: { digest: 'sha256:bad', observedAt: 1, rootId: 'root' },
        lifecycle: 'current' as const,
      },
      {
        guid: GOOD_GUID,
        packageUrl: '/good.pack.json',
        kind: 'mesh',
        sourcePath: '/game/assets/healthy.glb',
        revision: { digest: 'sha256:good', observedAt: 1, rootId: 'root' },
        lifecycle: 'current' as const,
      },
    ];

    const projected = projectSourcePackageFailure(rows, error);
    expect(projected[0]).toMatchObject({
      guid: BAD_GUID,
      lifecycle: 'failed',
      projection: { lastKnownGood: { packageUrl: '/bad.pack.json' } },
      diagnostics: [
        expect.objectContaining({
          subject: { type: 'resource', id: sourcePath },
          actual: expect.stringContaining('accessorIndex=7'),
        }),
      ],
    });
    expect(projected[1]).toEqual(rows[1]);
    expect(catalogDiagnosticForSourcePackageError(error).subject).toEqual({
      type: 'resource',
      id: sourcePath,
    });
  });
});
