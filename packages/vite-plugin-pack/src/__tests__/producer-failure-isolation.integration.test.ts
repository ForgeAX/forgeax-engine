import { sourcePackageError } from '@forgeax/engine-import';
import { currentProjectionFor } from '@forgeax/engine-pack/build';
import { expect, it } from 'vitest';
import { projectSourcePackageFailure } from '../dev/transport-routes.js';

const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const sibling = '019e3969-1d48-7c3b-ac24-6d68f4570660';
const packageUrl = (id: string) => `/__forgeax-ddc/${id}.runtime-pack.json`;
const current = currentProjectionFor('imported-output', 'cooked');
const error = sourcePackageError(
  'source-package-conversion-failed',
  {
    sourceMeta: 'broken.fixture.meta.json',
    anchorGuid: guid,
    affectedGuids: [guid],
    producer: 'source-package/fixture',
    importer: 'fixture',
  },
  { stage: 'conversion', reason: 'fixture conversion failed' },
);

it.each([
  'inventory',
  'accepted',
  'last-known-good',
] as const)('projects structured failure from a %s row while preserving unrelated packages', (prior) => {
  const input = {
    guid,
    kind: 'fixture-mesh',
    sourcePath: 'broken.fixture',
    packageUrl: packageUrl(guid),
    ...current,
    ...(prior !== 'inventory'
      ? {
          revision: { digest: 'sha256:accepted', observedAt: 7, rootId: 'fixture-root' },
        }
      : {}),
    ...(prior === 'last-known-good'
      ? {
          projection: {
            ...current.projection,
            lastKnownGood: { packageUrl: packageUrl(guid) },
          },
        }
      : {}),
  };
  const unrelated = {
    ...current,
    guid: sibling,
    kind: 'fixture-mesh',
    sourcePath: 'valid.fixture',
    packageUrl: packageUrl(sibling),
  };
  const [failed, unaffected] = projectSourcePackageFailure([input, unrelated], error);
  expect(unaffected).toEqual(unrelated);
  expect(failed).toMatchObject({
    lifecycle: 'failed',
    projection: { lifecycle: 'failed' },
    diagnostics: [
      expect.objectContaining({
        code: error.code,
        severity: 'blocking',
        expected: error.expected,
        hint: error.hint,
        authority: 'producer',
        evidence: [{ type: 'asset', id: guid }],
      }),
    ],
  });
  expect(failed?.projection?.lastKnownGood).toEqual(
    prior === 'inventory' ? undefined : { packageUrl: packageUrl(guid) },
  );
  if (prior !== 'inventory')
    expect(failed?.revision).toEqual({
      digest: `failure:${error.code}:${error.detail.stage}:sha256:accepted`,
      observedAt: expect.any(Number),
      rootId: 'fixture-root',
    });
});
