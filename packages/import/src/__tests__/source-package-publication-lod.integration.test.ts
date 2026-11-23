import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { commitImportPublication, stageImportPublication } from '../source-package-publication.js';

describe('LOD publication boundary', () => {
  const scratch = temporaryDirectories();

  afterEach(scratch.clear);

  it('publishes the complete root package through the shared host', async () => {
    const root = await scratch.make('forgeax-lod-publication-');
    const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
    const staged = await stageImportPublication({
      root,
      guid,
      desiredKey: 'a'.repeat(64),
      pack: { lods: [{ meshGuid: 'lod-1', screenCoverage: 0.5 }] },
      previousCatalog: [],
      nextCatalog: [],
      publishedGuids: [guid, 'lod-1'],
    });
    const result = staged.ok ? await commitImportPublication(staged.candidate) : staged;
    expect(result.ok).toBe(true);
  });
});
