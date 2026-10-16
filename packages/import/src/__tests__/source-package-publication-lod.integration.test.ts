import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishImportPublication } from '../source-package-publication.js';

describe('LOD publication boundary', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('publishes the complete root package through the shared host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-lod-publication-'));
    roots.push(root);
    const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
    const result = await publishImportPublication({
      root,
      guid,
      desiredKey: 'a'.repeat(64),
      pack: { lods: [{ meshGuid: 'lod-1', screenCoverage: 0.5 }] },
      previousCatalog: [],
      nextCatalog: [],
      publishedGuids: [guid, 'lod-1'],
    });
    expect(result.ok).toBe(true);
  });
});
