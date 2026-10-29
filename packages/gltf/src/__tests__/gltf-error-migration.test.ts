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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function hasLegacyTypesImport(source: string): boolean {
  return source.split(/\r?\n/).some((line) => {
    let offset = 0;
    return ['import', 'GltfError', 'from', '@forgeax/engine-types'].every((part) => {
      const match = line.indexOf(part, offset);
      if (match < 0) return false;
      offset = match + part.length;
      return true;
    });
  });
}

function grepCountImportGltfErrorFromTypes(root = REPO_ROOT): number {
  let candidates: string;
  try {
    // Git owns the tracked-file boundary. A fixed-string prefilter avoids
    // parsing irrelevant report lines. Ordered literal matching preserves the
    // import.*GltfError.*from.*types predicate without regex backtracking.
    candidates = execFileSync(
      'git',
      [
        'grep',
        '--no-color',
        '-F',
        '-l',
        '-z',
        '-e',
        'GltfError',
        '--',
        'packages',
        'apps',
        ':(exclude)packages/gltf/src/__tests__/gltf-error-migration.test.ts',
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (cause: unknown) {
    if ((cause as { status?: number }).status === 1) return 0;
    throw cause;
  }
  return candidates
    .split('\0')
    .filter((file) => file && hasLegacyTypesImport(readFileSync(resolve(root, file), 'utf8')))
    .length;
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

it('retains the tracked packages/apps boundary and exact per-file import predicate', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'forgeax-gltf-migration-gate-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    mkdirSync(resolve(root, 'packages/probe'), { recursive: true });
    mkdirSync(resolve(root, 'apps/probe'), { recursive: true });
    // Large lines stay cheap whether the prefilter accepts or rejects them.
    writeFileSync(resolve(root, 'packages/probe/report.json'), 'import '.repeat(1024 * 1024));
    writeFileSync(
      resolve(root, 'packages/probe/candidate.txt'),
      `import ${'from '.repeat(1024 * 1024)}GltfError`,
    );
    writeFileSync(
      resolve(root, 'packages/probe/a.ts'),
      'import type { GltfError } from "@forgeax/engine-types";\n',
    );
    writeFileSync(
      resolve(root, 'apps/probe/b.txt'),
      'import { GltfErrorCode } from "@forgeax/engine-types";\n',
    );
    execFileSync('git', ['add', 'packages', 'apps'], { cwd: root });
    writeFileSync(
      resolve(root, 'packages/probe/untracked.ts'),
      'import { GltfError } from "@forgeax/engine-types";\n',
    );
    expect(grepCountImportGltfErrorFromTypes(root)).toBe(2);
    writeFileSync(
      resolve(root, 'packages/probe/a.ts'),
      'import type { GltfError } from "@forgeax/engine-gltf";\n',
    );
    expect(grepCountImportGltfErrorFromTypes(root)).toBe(1);
    writeFileSync(resolve(root, 'apps/probe/b.txt'), 'GltfErrorCode is owned by gltf.\n');
    expect(grepCountImportGltfErrorFromTypes(root)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves the old import predicate without backtracking on report lines', () => {
  const parts = ['import', 'GltfError', 'from', '@forgeax/engine-types'];
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
      for (let c = 0; c < 4; c++)
        for (let d = 0; d < 4; d++) {
          const source = [parts[a], parts[b], parts[c], parts[d]].join(' x ');
          expect(hasLegacyTypesImport(source)).toBe(
            /import.*GltfError.*from.*@forgeax\/engine-types/.test(source),
          );
        }
  expect(hasLegacyTypesImport('import GltfError\nfrom @forgeax/engine-types')).toBe(false);
});
