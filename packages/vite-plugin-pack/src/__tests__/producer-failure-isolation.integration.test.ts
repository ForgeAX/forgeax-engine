import { sourcePackageError } from '@forgeax/engine-import';
import { currentProjectionFor } from '@forgeax/engine-pack/build';
import { describe, expect, it } from 'vitest';
import { projectSourcePackageFailure } from '../dev/transport-routes.js';

const INVALID_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const VALID_GUID = '019e3969-1d48-7c3b-ac24-6d68f4570660';

describe('source-package failure isolation', () => {
  it('keeps an unrelated package ready beside structured unavailable evidence', () => {
    const rows = [
      {
        guid: INVALID_GUID,
        packageUrl: `/__forgeax-ddc/${INVALID_GUID}.pack.json`,
        kind: 'fixture-mesh',
        sourcePath: 'broken.fixture',
        revision: { digest: 'sha256:broken', observedAt: 7, rootId: 'fixture-root' },
        ...currentProjectionFor('imported-output', 'cooked'),
        projection: {
          ...currentProjectionFor('imported-output', 'cooked').projection,
          lastKnownGood: { packageUrl: `/__forgeax-ddc/${INVALID_GUID}.pack.json` },
        },
      },
      {
        guid: VALID_GUID,
        packageUrl: `/__forgeax-ddc/${VALID_GUID}.pack.json`,
        kind: 'fixture-mesh',
        sourcePath: 'valid.fixture',
        ...currentProjectionFor('imported-output', 'cooked'),
      },
    ];
    const error = sourcePackageError(
      'source-package-conversion-failed',
      {
        sourceMeta: 'broken.fixture.meta.json',
        anchorGuid: INVALID_GUID,
        affectedGuids: [INVALID_GUID],
        producer: 'source-package/fixture',
        importer: 'fixture',
      },
      {
        stage: 'conversion',
        reason: 'fixture conversion failed',
      },
    );

    const projected = projectSourcePackageFailure(rows, error);
    const invalid = projected[0];
    const valid = projected[1];

    expect(invalid?.lifecycle).toBe('failed');
    expect(invalid?.projection?.lifecycle).toBe('failed');
    expect(invalid?.diagnostics).toEqual([
      expect.objectContaining({
        code: error.code,
        severity: 'blocking',
        expected: error.expected,
        hint: error.hint,
        authority: 'producer',
      }),
    ]);
    expect(invalid?.diagnostics?.[0]).toHaveProperty('evidence', [
      { type: 'asset', id: INVALID_GUID },
    ]);
    expect(invalid?.projection?.lastKnownGood).toEqual({
      packageUrl: `/__forgeax-ddc/${INVALID_GUID}.pack.json`,
    });
    expect(invalid?.revision).toEqual({
      digest: `failure:${error.code}:${error.detail.stage}:sha256:broken`,
      observedAt: expect.any(Number),
      rootId: 'fixture-root',
    });
    expect(valid).toEqual(rows[1]);
  });

  it('does not promote an unaccepted current inventory row into a DDC LKG', () => {
    const rows = [
      {
        guid: INVALID_GUID,
        packageUrl: `/__forgeax-ddc/${INVALID_GUID}.pack.json`,
        kind: 'fixture-mesh',
        sourcePath: 'broken.fixture',
        ...currentProjectionFor('imported-output', 'cooked'),
      },
    ];
    const error = sourcePackageError(
      'source-package-conversion-failed',
      {
        sourceMeta: 'broken.fixture.meta.json',
        anchorGuid: INVALID_GUID,
        affectedGuids: [INVALID_GUID],
        producer: 'source-package/fixture',
        importer: 'fixture',
      },
      { stage: 'conversion', reason: 'fixture conversion failed' },
    );

    expect(projectSourcePackageFailure(rows, error)[0]?.projection?.lastKnownGood).toBeUndefined();
  });

  it('promotes an accepted current package to LKG on its first source failure', () => {
    const packageUrl = `/__forgeax-ddc/${INVALID_GUID}.pack.json`;
    const rows = [
      {
        guid: INVALID_GUID,
        packageUrl,
        kind: 'fixture-mesh',
        sourcePath: 'broken.fixture',
        revision: { digest: 'sha256:accepted', observedAt: 7, rootId: 'fixture-root' },
        ...currentProjectionFor('imported-output', 'cooked'),
      },
    ];
    const error = sourcePackageError(
      'source-package-conversion-failed',
      {
        sourceMeta: 'broken.fixture.meta.json',
        anchorGuid: INVALID_GUID,
        affectedGuids: [INVALID_GUID],
        producer: 'source-package/fixture',
        importer: 'fixture',
      },
      { stage: 'conversion', reason: 'fixture conversion failed' },
    );

    const failed = projectSourcePackageFailure(rows, error)[0];
    expect(failed?.projection?.lastKnownGood).toEqual({ packageUrl });
    expect(failed?.lifecycle).toBe('failed');
    expect(failed?.revision).toMatchObject({
      digest: `failure:${error.code}:${error.detail.stage}:sha256:accepted`,
      rootId: 'fixture-root',
    });
  });
});
