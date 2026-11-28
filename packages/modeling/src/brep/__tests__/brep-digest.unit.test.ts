import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BREP_DIGEST_FILE,
  brepClosure,
  brepViolations,
  closureDigest,
  closureManifest,
  kernelClosure,
  rel,
  SRC,
} from '../../__tests__/digest-guard';
import { TS_BACKEND_IDENTITY } from '../../compute/boolean-ts';
import { TS_KERNEL_DIGEST } from '../../compute/kernel-digest';
import { createMeshJobCooker, type MeshJob } from '../../mesh-job';
import { model } from '../../model';
import { BREP_KERNEL_DIGEST, BREP_KERNEL_FILES } from '../kernel-digest';

const digest = closureDigest;
const manifest = closureManifest;

function digestSource(value: string, files: Readonly<Record<string, string>>): string {
  const head = readFileSync(BREP_DIGEST_FILE, 'utf8').replace(/\r\n/g, '\n');
  const doc = head.slice(0, head.indexOf('export const BREP_KERNEL_DIGEST'));
  const rows = Object.entries(files)
    .map(([file, hash]) => `  '${file}': '${hash}',`)
    .join('\n');
  return `${doc}export const BREP_KERNEL_DIGEST = '${value}';

/**
 * @internal Per-file sha256 (first 8 hex digits) of the digested closure, so the digest
 * test can name the files that changed; tests only, nothing reads it at runtime.
 */
export const BREP_KERNEL_FILES: Readonly<Record<string, string>> = {
${rows}
};
`;
}

function staleReport(
  recorded: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string {
  const changed = Object.keys(actual).filter((f) => f in recorded && recorded[f] !== actual[f]);
  const added = Object.keys(actual).filter((f) => !(f in recorded));
  const removed = Object.keys(recorded).filter((f) => !(f in actual));
  const list = (name: string, files: readonly string[]) =>
    files.length === 0 ? [] : [`  ${name}: ${files.join(', ')}`];
  return [
    'the exact-stage source closure changed:',
    ...list('changed', changed),
    ...list('added', added),
    ...list('removed', removed),
    'regenerate: FORGEAX_UPDATE_GOLDEN=1 npx vitest run src/brep/__tests__/brep-digest.unit.test.ts (in packages/modeling)',
    'and say why in the PR body: a digest change invalidates every mesh-job cook key',
  ].join('\n');
}

const edit = (files: ReadonlyMap<string, string>, name: string) => {
  const edited = new Map(files);
  const file = join(SRC, name);
  edited.set(file, `${files.get(file) as string}\n`);
  return edited;
};

const JOB: MeshJob<never> = {
  name: 'plate',
  build: () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    return m;
  },
};

describe('BREP_KERNEL_DIGEST tracks the exact-stage source (plan 1.5)', () => {
  it('is the digest of the relative-import closure of brep/index.ts', () => {
    const files = brepClosure();
    expect([...files.keys()].map(rel)).toEqual(
      expect.arrayContaining([
        'brep/index.ts',
        'brep/surfaces.ts',
        'brep/tessellate.ts',
        'mesh.ts',
        'dmath.ts',
      ]),
    );
    const actual = digest(files);
    const actualFiles = manifest(files);
    const stale =
      actual !== BREP_KERNEL_DIGEST ||
      JSON.stringify(actualFiles) !== JSON.stringify(BREP_KERNEL_FILES);
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1' && stale) {
      writeFileSync(BREP_DIGEST_FILE, digestSource(actual, actualFiles));
    }
    expect(BREP_KERNEL_DIGEST, staleReport(BREP_KERNEL_FILES, actualFiles)).toBe(actual);
    expect(BREP_KERNEL_FILES, staleReport(BREP_KERNEL_FILES, actualFiles)).toEqual(actualFiles);
  });

  it('the closure imports neither model.ts nor its own digest and hides no import', () => {
    expect(brepViolations(brepClosure())).toEqual([]);
    const seeded = new Map(brepClosure());
    const types = join(SRC, 'brep/types.ts');
    seeded.set(types, `import type { Model } from '../model';\n${seeded.get(types)}`);
    expect(brepViolations(seeded)).toContainEqual({
      file: 'brep/types.ts',
      rule: 'imports-exact-stage',
      detail: 'imports model.ts',
    });
  });

  it('editing brep/surfaces.ts moves the BREP digest and not the TS digest (cook-key falsifier)', () => {
    const brep = brepClosure();
    const ts = kernelClosure();
    expect(ts.has(join(SRC, 'brep/surfaces.ts'))).toBe(false);
    expect(digest(edit(brep, 'brep/surfaces.ts'))).not.toBe(digest(brep));
    expect(digest(kernelClosure())).toBe(TS_BACKEND_IDENTITY.split('@')[1]);
    expect(TS_BACKEND_IDENTITY).toBe(`forgeax-modeling-ts@${TS_KERNEL_DIGEST}`);
  });

  it('shared modules move both digests (mesh.ts, nurbs.ts, dmath.ts)', () => {
    const brep = brepClosure();
    const ts = kernelClosure();
    for (const name of ['mesh.ts', 'nurbs.ts', 'dmath.ts']) {
      const file = join(SRC, name);
      expect(brep.has(file), `${name} in the brep closure`).toBe(true);
      expect(ts.has(file), `${name} in the TS closure`).toBe(true);
      expect(digest(edit(brep, name))).not.toBe(digest(brep));
      expect(digest(edit(ts, name))).not.toBe(digest(ts));
    }
  });

  it('the cooker identity carries BREP_KERNEL_DIGEST next to the TS identity', () => {
    const identity = createMeshJobCooker([JOB]).cacheIdentity?.() ?? '';
    expect(identity).toContain(TS_BACKEND_IDENTITY);
    expect(identity).toContain(`forgeax-modeling-brep@${BREP_KERNEL_DIGEST}`);
  });

  it('a stale digest names the changed, added and removed closure files (falsifier)', () => {
    const files = brepClosure();
    const recorded = manifest(files);
    const edited = edit(files, 'brep/surfaces.ts');
    edited.delete(join(SRC, 'brep/measure.ts'));
    edited.set(join(SRC, 'brep/new-kernel.ts'), 'export {};\n');
    const report = staleReport(recorded, manifest(edited));
    expect(report).toContain('  changed: brep/surfaces.ts');
    expect(report).toContain('  added: brep/new-kernel.ts');
    expect(report).toContain('  removed: brep/measure.ts');
    expect(staleReport(recorded, recorded)).not.toContain('  changed:');
  });
});
