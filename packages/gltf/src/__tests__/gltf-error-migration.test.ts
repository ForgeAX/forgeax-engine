// gltf-error-migration.test.ts - M1 grep gate for GltfErrorCode migration.
//
// TDD red-green: written BEFORE migration (t6/t7/t8). Three grep assertions
// guard the DIP boundary: types must have zero gltf- literals, types must
// have zero GltfError* exports, and gltf/errors.ts must have >=1 GltfError*
// export. These are RED on first run (types still has GltfError*); they go
// GREEN after t6/t7/t8 complete the migration.
//
// Anchors:
// - requirements AC-28 (types grep GltfError = 0 hits)
// - requirements AC-27 (DIP three grep gates)
// - plan-strategy section 5.3 (DIP grep gate AC-27/AC-28)
// - charter P3 (explicit failure: grep gate fails-fast on drift)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..');
const TYPES_INDEX = resolve(REPO_ROOT, 'packages', 'types', 'src', 'core-contracts.ts');
const GLTF_ERRORS = resolve(REPO_ROOT, 'packages', 'gltf', 'src', 'errors.ts');

function grepCount(pattern: string, file: string): number {
  const expression = new RegExp(pattern);
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => expression.test(line)).length;
}

function grepCountImportGltfErrorFromTypes(): number {
  try {
    // Search tracked source paths so coverage runs do not recursively walk
    // generated or ignored trees on a busy CI runner. The migration contract
    // is about repository source, which is exactly the tracked worktree set.
    const out = execFileSync(
      'git',
      [
        'grep',
        '--no-color',
        '-E',
        '-l',
        '-e',
        'import.*GltfError.*from.*@forgeax/engine-types',
        '--',
        'packages',
        'apps',
        ':(exclude)packages/gltf/src/__tests__/gltf-error-migration.test.ts',
      ],
      { encoding: 'utf-8' },
    );
    return out.trim().split('\n').filter(Boolean).length;
  } catch (cause: unknown) {
    if ((cause as { status?: number }).status === 1) return 0;
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const out = execFileSync(
          'rg',
          [
            '--files-with-matches',
            '--glob',
            '*.ts',
            '--glob',
            '!**/node_modules/**',
            '--glob',
            '!**/dist/**',
            '--glob',
            '!**/gltf-error-migration.test.ts',
            '--regexp',
            'import.*GltfError.*from.*@forgeax/engine-types',
            resolve(REPO_ROOT, 'packages'),
            resolve(REPO_ROOT, 'apps'),
          ],
          { encoding: 'utf-8' },
        );
        return out.trim().split('\n').filter(Boolean).length;
      } catch (fallbackCause: unknown) {
        if ((fallbackCause as { status?: number }).status === 1) return 0;
        if ((fallbackCause as NodeJS.ErrnoException).code === 'ENOENT') {
          try {
            const out = execFileSync(
              'grep',
              [
                '-R',
                '-l',
                '-E',
                '--include=*.ts',
                '--exclude-dir=node_modules',
                '--exclude-dir=dist',
                'import.*GltfError.*from.*@forgeax/engine-types',
                resolve(REPO_ROOT, 'packages'),
                resolve(REPO_ROOT, 'apps'),
              ],
              { encoding: 'utf-8' },
            );
            return out
              .trim()
              .split('\n')
              .filter(
                (file) =>
                  file &&
                  !file.endsWith('/packages/gltf/src/__tests__/gltf-error-migration.test.ts'),
              ).length;
          } catch (grepCause: unknown) {
            if ((grepCause as { status?: number }).status === 1) return 0;
            throw grepCause;
          }
        }
        throw fallbackCause;
      }
    }
    throw cause;
  }
}

describe('M1 GltfErrorCode migration grep gate (AC-28)', () => {
  it("(a) types/src/core-contracts.ts contains zero 'gltf-' string literals", () => {
    const count = grepCount("'gltf-", TYPES_INDEX);
    expect(count).toBe(0);
  });

  it('(b) types/src/core-contracts.ts contains zero export type GltfError* exports', () => {
    const count = grepCount('export type GltfError', TYPES_INDEX);
    expect(count).toBe(0);
  });

  it('(c) gltf/errors.ts contains >=1 export type GltfError* exports', () => {
    const count = grepCount('export type GltfError', GLTF_ERRORS);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('(d) zero import GltfError from @forgeax/engine-types in all packages/apps', () => {
    const count = grepCountImportGltfErrorFromTypes();
    expect(count).toBe(0);
  });
});
