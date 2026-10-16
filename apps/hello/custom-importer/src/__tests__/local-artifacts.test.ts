import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORT_ERROR_HINTS, ImportError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { reelGameBlobImporter } from '../reel-game-blob-importer';

const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const sourceName = 'level-1.reel.json';
const sourcePath = resolve(assetsDir, sourceName);
const metaPath = `${sourcePath}.meta.json`;
const thumbnailName = `${sourceName}.thumb`;

async function fixtureContext(siblingName = thumbnailName) {
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
    readonly subAssets: readonly [{ readonly guid: string; readonly kind: string; readonly sourceIndex: number }];
  };
  return {
    source: sourceName,
    readSource: async () => ({ ok: true as const, value: new Uint8Array(await readFile(sourcePath)) }),
    readSibling: async (path: string) => {
      const fixturePath = path === thumbnailName ? siblingName : path;
      try {
        return {
          ok: true as const,
          value: new Uint8Array(await readFile(resolve(assetsDir, fixturePath))),
        };
      } catch (error) {
        return {
          ok: false as const,
          error: new ImportError({
            code: 'source-read-failed',
            expected: `readable host companion "${path}"`,
            hint: IMPORT_ERROR_HINTS['source-read-failed'],
            detail: { source: path, reason: error instanceof Error ? error.message : String(error) },
          }),
        };
      }
    },
    decodeImage: async () => {
      throw new Error('host importer does not decode images');
    },
    subAssets: meta.subAssets,
    importSettings: { siblingName },
  };
}

describe('host importer local artifacts', () => {
  it('keeps multiple artifacts from the real source/meta fixture', async () => {
    const importer = reelGameBlobImporter();
    const result = await importer.import(await fixtureContext());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const asset = result.value.assets[0] as unknown as Record<string, unknown>;
    const artifacts = asset.artifacts as Record<string, Record<string, unknown>>;
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { subAssets: [{ guid: string }] };
    const sourceBytes = new Uint8Array(await readFile(sourcePath));
    const thumbnailBytes = new Uint8Array(await readFile(resolve(assetsDir, thumbnailName)));
    expect(artifacts.payload).toBeDefined();
    expect(artifacts.thumbnail).toBeDefined();
    if (artifacts.payload === undefined || artifacts.thumbnail === undefined) return;
    expect(asset.guid).toBe(meta.subAssets[0].guid);
    expect(Object.keys(artifacts)).toEqual(['payload', 'thumbnail']);
    expect(artifacts.payload.bytes).toEqual(sourceBytes);
    expect(artifacts.thumbnail.bytes).toEqual(thumbnailBytes);
    expect(artifacts.payload).not.toHaveProperty('path');
    expect(result.value.sourceDependencies).toEqual([sourceName, thumbnailName]);
  });

  it('returns the sibling read failure instead of a successful empty product', async () => {
    const result = await reelGameBlobImporter().import(await fixtureContext('missing.thumb'));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'source-read-failed',
        detail: { source: 'level-1.reel.json.thumb' },
      },
    });
  });
});
