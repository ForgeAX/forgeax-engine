import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  brepClosure,
  closureViolations,
  DIGEST_FILE,
  diffVerdict,
  KERNEL_ENTRIES,
  kernelClosure,
  recordedClosure,
  rel,
  SRC,
} from './digest-guard';

const real = kernelClosure();

/** The real closure with `edit` applied to one file's text, as if a PR had written it. */
function seeded(file: string, edit: (text: string) => string): Map<string, string> {
  const path = join(SRC, file);
  const out = new Map(real);
  out.set(path, edit(real.get(path) as string));
  return out;
}

describe('exact-stage guard (plan 1.5, P2-A7)', () => {
  it('the real TS kernel closure reaches neither brep/ nor model.ts and hides no import', () => {
    expect(closureViolations(real)).toEqual([]);
  });

  it('walks the same closure the recorded digest names', () => {
    const recorded = recordedClosure(readFileSync(DIGEST_FILE, 'utf8'));
    expect([...real.keys()].map(rel).sort()).toEqual([...recorded].sort());
    expect(KERNEL_ENTRIES.every((e) => real.has(e))).toBe(true);
  });

  it('is red on a static import of brep/ or model.ts (falsifier)', () => {
    const brep = closureViolations(
      seeded('geom.ts', (t) => `import { x } from './brep/types';\n${t}`),
    );
    expect(brep).toContainEqual({
      file: 'geom.ts',
      rule: 'imports-exact-stage',
      detail: 'imports brep/types.ts',
    });
    const model = closureViolations(
      seeded('compute/bsp.ts', (t) => `import type { Model } from '../model';\n${t}`),
    );
    expect(model).toContainEqual({
      file: 'compute/bsp.ts',
      rule: 'imports-exact-stage',
      detail: 'imports model.ts',
    });
  });

  it('is red when a brep/ or model.ts module enters the closure itself', () => {
    const files = new Map(real);
    files.set(join(SRC, 'brep/types.ts'), 'export {};\n');
    expect(closureViolations(files)).toContainEqual({
      file: 'brep/types.ts',
      rule: 'imports-exact-stage',
      detail: 'is in the TS kernel closure',
    });
  });

  it('is red on dynamic import(), side-effect and double-quoted imports the walk cannot follow (falsifier)', () => {
    for (const [line, detail] of [
      ["const m = await import('../brep/index');", 'dynamic import()'],
      ['const m = import(spec);', 'dynamic import()'],
      ["import '../brep/register';", 'side-effect import'],
      ['import { x } from "../brep/types";', 'double-quoted import'],
    ] as const) {
      const v = closureViolations(seeded('geom.ts', (t) => `${t}\n${line}\n`));
      expect(v, line).toContainEqual({ file: 'geom.ts', rule: 'unfollowed-import', detail });
    }
  });

  it('digests only this package src/ files, so the Engine checkout cannot move either closure (falsifier)', () => {
    for (const closure of [real, brepClosure()]) {
      expect(closure.size).toBeGreaterThan(1);
      for (const file of closure.keys()) {
        expect(file.startsWith(SRC), file).toBe(true);
      }
    }
  });

  it('does not follow an Engine package import, and is red on a self import it would miss (falsifier)', () => {
    expect(
      closureViolations(
        seeded('geom.ts', (t) => `${t}\nimport { err } from '@forgeax/engine-types';\n`),
      ),
    ).toEqual([]);
    const v = closureViolations(
      seeded('geom.ts', (t) => `${t}\nimport { Model } from '@forgeax/engine-modeling/brep';\n`),
    );
    expect(v).toContainEqual({
      file: 'geom.ts',
      rule: 'unfollowed-import',
      detail: 'workspace self import',
    });
    const umbrella = closureViolations(
      seeded('geom.ts', (t) => `${t}\nimport { Model } from '@forgeax/engine/modeling/brep';\n`),
    );
    expect(umbrella).toContainEqual({
      file: 'geom.ts',
      rule: 'unfollowed-import',
      detail: 'workspace self import',
    });
  });

  it('does not flag member calls named import or comment lines', () => {
    const text = (t: string) =>
      `${t}\n// an import (of sorts)\n * import('x') in a doc block\nconst a = obj.import(1);\n`;
    expect(closureViolations(seeded('geom.ts', text))).toEqual([]);
  });

  it('an exact-stage diff may not touch the closure or the digest file (falsifier)', () => {
    const names = new Set([...real.keys()].map(rel));
    const clean = diffVerdict(
      ['src/brep/types.ts', 'src/brep/__tests__/types.unit.test.ts', 'package.json', 'README.md'],
      names,
    );
    expect(clean).toEqual({ exactStage: true, touched: [] });

    const closureEdit = diffVerdict(['src/brep/types.ts', 'src/mesh.ts'], names);
    expect(closureEdit.touched).toEqual(['src/mesh.ts']);

    const digestEdit = diffVerdict(['src/brep/types.ts', 'src/compute/kernel-digest.ts'], names);
    expect(digestEdit.touched).toEqual(['src/compute/kernel-digest.ts']);

    const declared = diffVerdict(['src/geom.ts'], names, true);
    expect(declared).toEqual({ exactStage: true, touched: ['src/geom.ts'] });
  });

  it('a brep digest regen alone does not make a PR exact-stage', () => {
    const names = new Set([...real.keys()].map(rel));
    const regen = ['src/mesh.ts', 'src/compute/kernel-digest.ts', 'src/brep/kernel-digest.ts'];
    expect(diffVerdict(regen, names)).toEqual({ exactStage: false, touched: [] });
    expect(diffVerdict(['src/brep/types.ts', ...regen], names).touched).toEqual([
      'src/mesh.ts',
      'src/compute/kernel-digest.ts',
    ]);
    expect(diffVerdict(regen, names, true).exactStage).toBe(true);
  });

  it('a change to the brep digest test alone does not make a PR exact-stage', () => {
    const names = new Set([...real.keys()].map(rel));
    const edit = ['src/mesh.ts', 'src/brep/__tests__/brep-digest.unit.test.ts'];
    expect(diffVerdict(edit, names)).toEqual({ exactStage: false, touched: [] });
    expect(diffVerdict(['src/brep/__tests__/other.unit.test.ts', 'src/mesh.ts'], names)).toEqual({
      exactStage: true,
      touched: ['src/mesh.ts'],
    });
  });

  it('a digest-changing diff outside brep/ is not judged', () => {
    const names = new Set([...real.keys()].map(rel));
    expect(diffVerdict(['src/geom.ts', 'src/compute/kernel-digest.ts'], names)).toEqual({
      exactStage: false,
      touched: [],
    });
  });

  it('counts a closure file deleted by the PR through the recorded base manifest', () => {
    const base = "export const TS_KERNEL_FILES = {\n  'old-kernel.ts': 'deadbeef',\n};\n";
    const names = new Set(recordedClosure(base));
    expect(diffVerdict(['src/brep/types.ts', 'src/old-kernel.ts'], names).touched).toEqual([
      'src/old-kernel.ts',
    ]);
  });
});
