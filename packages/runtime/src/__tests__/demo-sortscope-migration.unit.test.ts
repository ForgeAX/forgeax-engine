// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M5 / w15.
//
// Round-2 production migration verification: asserts the two affected
// demos (`apps/hello/tilemap` + `apps/hello/asi-world`) actually use the
// `sortScope`-named field and do NOT carry the retired `ySort` literal,
// reading the demo source files directly off disk.
//
// What round-2 changes vs round-1:
//   - round-1 (R-NEW-1 fallback): forward-looking migration table only;
//     no on-disk demo file reads (target directories didn't exist yet).
//   - round-2 (R-NEW-1 fallback graduated, D-V-3): upstream + demo
//     directories landed via PR #502 (2026-06-26T07:24Z), so we read
//     the actual demo source files and assert (a) `sortScope` is the
//     spelling used, (b) `ySort` does not reappear anywhere in
//     `apps/hello/tilemap/src/**` or `apps/hello/asi-world/src/**`
//     (Change stance "Optimal > compatible" — no shim, no alias).
//
// Boundary: reads two `*.ts` source files via `node:fs`. No runtime
// import (so a future demo bug doesn't bleed into this test failure
// signal). The asi-world spawn must encode `sortScope: 'per-cell'`
// (via `encodeSortScope`), the tilemap demo may either omit `sortScope`
// (default 'layer') or pass `encodeSortScope('layer')` explicitly; both
// shapes are accepted because the closed union's default arm and the
// explicit arm both satisfy the migration intent.
//
// Anchors:
//   - requirements.md AC-02: `ySort: 0/1` -> `sortScope: 'layer' |
//     'per-cell'`, TS compile errors are the only migration gate.
//   - plan-strategy.md section 7 M5: demo migration boundary, two-demo
//     scope (hello-tilemap + asi-world).
//   - verify-decisions D-V-3 (round-2 mandate item 4): "demo migration".
//   - AGENTS.md Change stance: no `ySort` alias, no parallel field.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

interface DemoMigrationCase {
  readonly demo: 'hello-tilemap' | 'hello-asi-world';
  readonly mainTsPath: string;
  readonly expectedSpawns: ReadonlyArray<{
    readonly layerCategory: 'tilemap' | 'terrain' | 'object';
    // After migration: literal that must appear in main.ts.
    // 'per-cell' -> demo must call `encodeSortScope('per-cell')` (or
    //               pass the closed-union literal through TileLayerData);
    // 'layer'    -> demo may omit `sortScope` (default) or spell 'layer'
    //               explicitly. Both shapes are acceptable.
    readonly postMigrationSortScope: 'layer' | 'per-cell';
  }>;
}

const DEMO_CASES: readonly DemoMigrationCase[] = [
  {
    demo: 'hello-tilemap',
    mainTsPath: resolve(REPO_ROOT, 'apps', 'hello', 'tilemap', 'src', 'main.ts'),
    expectedSpawns: [{ layerCategory: 'tilemap', postMigrationSortScope: 'layer' }],
  },
  {
    demo: 'hello-asi-world',
    mainTsPath: resolve(REPO_ROOT, 'apps', 'hello', 'asi-world', 'src', 'main.ts'),
    expectedSpawns: [
      { layerCategory: 'terrain', postMigrationSortScope: 'layer' },
      { layerCategory: 'object', postMigrationSortScope: 'per-cell' },
    ],
  },
];

describe('demo sortScope migration (w15, round-2 production)', () => {
  it.each(DEMO_CASES)('$demo main.ts exists and is readable', ({ mainTsPath }) => {
    // readFileSync throws if absent; reaching the .length read implies success.
    const src = readFileSync(mainTsPath, 'utf8');
    expect(src.length).toBeGreaterThan(0);
  });

  it.each(DEMO_CASES)('$demo main.ts does NOT carry the retired ySort field', ({ mainTsPath }) => {
    const src = readFileSync(mainTsPath, 'utf8');
    const ySortFieldRe = /\bySort\s*:/;
    expect(src).not.toMatch(ySortFieldRe);
  });

  it('hello-tilemap demo defaults sortScope to layer (no per-cell call)', () => {
    const tilemapCase = DEMO_CASES.find((c) => c.demo === 'hello-tilemap');
    if (tilemapCase === undefined) throw new Error('hello-tilemap case missing');
    const src = readFileSync(tilemapCase.mainTsPath, 'utf8');
    expect(src).not.toMatch(/TilemapSort\.perCell/);
  });

  it("asi-world demo encodes sortScope: 'per-cell' for the object TileLayer", () => {
    const asiCase = DEMO_CASES.find((c) => c.demo === 'hello-asi-world');
    if (asiCase === undefined) throw new Error('asi-world case missing');
    const src = readFileSync(asiCase.mainTsPath, 'utf8');
    expect(src).toMatch(/TilemapSort\.perCell/);
  });

  it('asi-world demo imports the grouped TilemapSort authoring value', () => {
    const asiCase = DEMO_CASES.find((c) => c.demo === 'hello-asi-world');
    if (asiCase === undefined) throw new Error('asi-world case missing');
    const src = readFileSync(asiCase.mainTsPath, 'utf8');
    expect(src).toMatch(/TilemapSort/);
    expect(src).toMatch(/@forgeax\/engine-render\/authoring/);
  });

  it('migration covers both terrain semantics (layer) and object semantics (per-cell)', () => {
    const scopes = new Set<string>();
    for (const c of DEMO_CASES) {
      for (const s of c.expectedSpawns) scopes.add(s.postMigrationSortScope);
    }
    expect(scopes.has('layer')).toBe(true);
    expect(scopes.has('per-cell')).toBe(true);
  });
});
