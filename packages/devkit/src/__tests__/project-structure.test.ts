import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('DevKit project structure characterization', () => {
  it('records the pre-migration public project and control-plane surface', async () => {
    const [indexSource, projectSource] = await Promise.all([
      readFile(resolve(root, 'index.ts'), 'utf8'),
      readFile(resolve(root, 'project.ts'), 'utf8'),
    ]);
    const snapshot = {
      rootExports: (indexSource.match(/^export\b/gm) ?? []).length,
      projectExports: (projectSource.match(/^export\b/gm) ?? []).length,
      projectUsesLegacyEntry: projectSource.includes('forge.entry'),
      projectUsesAssetImporterProjection: projectSource.includes('assetImporters'),
    };

    expect(snapshot.rootExports).toBeLessThanOrEqual(38);
    expect(snapshot.projectExports).toBe(4);
    expect(snapshot.projectUsesLegacyEntry).toBe(false);
    expect(snapshot.projectUsesAssetImporterProjection).toBe(false);
  });
});
