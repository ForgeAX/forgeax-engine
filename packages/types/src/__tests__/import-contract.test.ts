import { describe, expect, it } from 'vitest';
import {
  IMPORT_ERROR_HINTS as DIRECT_IMPORT_ERROR_HINTS,
  ImportError as DirectImportError,
  parseConservativeAnimatedBounds as directParseConservativeAnimatedBounds,
  readConservativeAnimatedBounds as directReadConservativeAnimatedBounds,
} from '../import.js';
import type {
  ImportedArtifactBody,
  ImportProduct,
  ImportResult,
  SourceDependency,
} from '../index.js';
import {
  IMPORT_ERROR_HINTS,
  ImportError,
  parseConservativeAnimatedBounds,
  readConservativeAnimatedBounds,
} from '../index.js';

describe('generic import contract', () => {
  it('keeps the main entry and import module on one runtime contract', () => {
    expect(ImportError).toBe(DirectImportError);
    expect(IMPORT_ERROR_HINTS).toBe(DIRECT_IMPORT_ERROR_HINTS);
    expect(parseConservativeAnimatedBounds).toBe(directParseConservativeAnimatedBounds);
    expect(readConservativeAnimatedBounds).toBe(directReadConservativeAnimatedBounds);
  });

  it('keeps producer bounds parsing behavior on the public barrel', () => {
    const bounds = [[-2, -1, -3, 2, 1, 3]];
    expect(parseConservativeAnimatedBounds(bounds[0])).toEqual(
      Float32Array.of(-2, -1, -3, 2, 1, 3),
    );
    expect(readConservativeAnimatedBounds({ conservativeAnimatedBounds: bounds }, 0)).toEqual(
      Float32Array.of(-2, -1, -3, 2, 1, 3),
    );
  });

  it('models a product with asset-local artifacts and normalized source dependencies', () => {
    const product: ImportProduct = {
      assets: [],
      sourceDependencies: ['ui/main.html', 'ui/main.css'],
    };
    expect(product.sourceDependencies).toEqual(['ui/main.html', 'ui/main.css']);
    const dependency: SourceDependency = 'ui/main.css';
    expect(dependency).toBe('ui/main.css');
  });

  it('models logical artifact bytes without publish facts', () => {
    const artifact: ImportedArtifactBody = {
      mediaType: 'image/svg+xml',
      bytes: new Uint8Array([60, 115, 118, 103, 62]),
    };
    expect(artifact.mediaType).toContain('image');
    expect(artifact.bytes).toBeInstanceOf(Uint8Array);
  });

  it('keeps artifact ownership on the logical asset envelope', () => {
    const product: ImportProduct = {
      assets: [
        {
          guid: 'texture-guid',
          kind: 'texture',
          payload: { kind: 'texture' },
          refs: [],
          artifacts: { source: artifactFixture() },
        },
      ],
      sourceDependencies: [],
    } as never;
    expect(product.assets[0]?.artifacts).toHaveProperty('source');
    expect(product).not.toHaveProperty('bins');
  });

  it('supports structured success and failure results without legacy arrays', () => {
    const success: ImportResult = {
      ok: true,
      value: { assets: [], sourceDependencies: [] },
    };
    const failure: ImportResult = {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: 'a readable source',
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: { source: 'main.html', reason: 'ENOENT' },
      }),
    };
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });
});

function artifactFixture(): ImportedArtifactBody {
  return { mediaType: 'image/png', bytes: Uint8Array.of(1, 2, 3) };
}
