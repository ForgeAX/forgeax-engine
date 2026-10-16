// hello-triangle tree-shake test (feat-20260615-debug-draw M4 / w27)
// @perf-budget-skip: scans production code; duration scales with bundle size.
//
// Proves AC-12: production build of @forgeax/hello-triangle (which does NOT
// import @forgeax/engine-debug-draw) contains zero 'DebugDraw' literals in
// the dist JS bundle.
//
// Prepare the real production bundle, including in a fresh source worktree.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const TRIANGLE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_ROOT = resolve(TRIANGLE_DIR, '../../..');

beforeAll(() => {
  // CI coverage groups share one checkout, so reuse their manifest instead of replacing it.
  const sharedInputManifest = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  const result = spawnSync(
    process.execPath,
    [
      join(ENGINE_ROOT, 'scripts/build-apps.mjs'),
      'apps/hello/triangle',
      ...(sharedInputManifest === undefined
        ? []
        : ['--shared-input-manifest', sharedInputManifest]),
    ],
    {
      cwd: ENGINE_ROOT,
      env: { ...process.env, FORGEAX_BUILD_PACKAGES_READY: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 130_000);

function filesContaining(root: string, needle: string): string[] {
  const matches: string[] = [];
  let codeFiles = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
        // Pack payloads, textures and WASM cannot contain JavaScript imports
        // or symbols. Decoding them made this code gate depend on asset size.
        codeFiles += 1;
        if (readFileSync(path, 'utf8').includes(needle)) {
          matches.push(relative(root, path));
        }
      }
    }
  };
  visit(root);
  expect(codeFiles, `expected code files under ${root}`).toBeGreaterThan(0);
  return matches;
}

describe('w27: tree-shake (AC-12)', () => {
  it('hello-triangle source does not import debug-draw', () => {
    const sourceMatches = filesContaining(join(TRIANGLE_DIR, 'src'), 'engine-debug-draw');
    expect(sourceMatches).toEqual([]);
  });

  it('hello-triangle dist contains zero DebugDraw symbols', () => {
    const distMatches = filesContaining(join(TRIANGLE_DIR, 'dist'), 'DebugDraw');
    expect(distMatches).toEqual([]);
  });
});
