import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TS_BACKEND_IDENTITY, tsBackend } from '../compute/boolean-ts';
import { computeCacheKey, runComputeJob } from '../compute/job';
import { TS_KERNEL_DIGEST, TS_KERNEL_FILES } from '../compute/kernel-digest';
import { model } from '../model';
import {
  closureDigest,
  closureManifest,
  DIGEST_FILE,
  kernelClosure,
  rel,
  SRC,
} from './digest-guard';

const digest = closureDigest;
const manifest = closureManifest;

/** The whole generated kernel-digest.ts for a digest and its manifest. */
function digestSource(value: string, files: Readonly<Record<string, string>>): string {
  const head = readFileSync(DIGEST_FILE, 'utf8').replace(/\r\n/g, '\n');
  const doc = head.slice(0, head.indexOf('export const TS_KERNEL_DIGEST'));
  const rows = Object.entries(files)
    .map(([file, hash]) => `  '${file}': '${hash}',`)
    .join('\n');
  return `${doc}export const TS_KERNEL_DIGEST = '${value}';

/**
 * @internal Per-file sha256 (first 8 hex digits) of the digested closure, so the digest
 * test can name the files that changed; tests only, nothing reads it at runtime.
 */
export const TS_KERNEL_FILES: Readonly<Record<string, string>> = {
${rows}
};
`;
}

/** Why the recorded digest is stale: the changed, added and removed closure files, and what to do. */
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
    'the TS kernel source closure changed:',
    ...list('changed', changed),
    ...list('added', added),
    ...list('removed', removed),
    'regenerate: FORGEAX_UPDATE_GOLDEN=1 npx vitest run src/__tests__/kernel-digest.unit.test.ts (in packages/modeling)',
    'and say why in the PR body: a digest change invalidates every compute cache key and the TS backend identity',
  ].join('\n');
}

describe('TS backend identity tracks the kernel source (design R3)', () => {
  it('is the digest of every TS backend kernel source closure', () => {
    const files = kernelClosure();
    // Bake, voxel / remesh, charts and skin weights reuse the identity: a change to any of
    // their kernels must change the DDC key (the bake cooker's cache is on disk).
    expect([...files.keys()].map(rel)).toEqual(
      expect.arrayContaining([
        'compute/boolean-ts.ts',
        'compute/bsp.ts',
        'compute/job.ts',
        'geom.ts',
        'compute/bake-ts.ts',
        'compute/bvh.ts',
        'compute/chart-ts.ts',
        'compute/remesh-ts.ts',
        'compute/skin-ts.ts',
        'compute/voxel-ts.ts',
      ]),
    );
    const actual = digest(files);
    const actualFiles = manifest(files);
    const stale =
      actual !== TS_KERNEL_DIGEST ||
      JSON.stringify(actualFiles) !== JSON.stringify(TS_KERNEL_FILES);
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1' && stale) {
      writeFileSync(DIGEST_FILE, digestSource(actual, actualFiles));
    }
    expect(TS_KERNEL_DIGEST, staleReport(TS_KERNEL_FILES, actualFiles)).toBe(actual);
    expect(TS_KERNEL_FILES, staleReport(TS_KERNEL_FILES, actualFiles)).toEqual(actualFiles);
    expect(TS_BACKEND_IDENTITY).toBe(`forgeax-modeling-ts@${actual}`);
  });

  it('a kernel source change changes the identity and so the DDC cache key', () => {
    const files = kernelClosure();
    const edited = new Map(files);
    const bsp = join(SRC, 'compute/bsp.ts');
    edited.set(bsp, `${files.get(bsp) as string}\n`);
    const changed = digest(edited);
    expect(changed).not.toBe(digest(files));

    const plate = model();
    plate.box({ size: [0.4, 0.02, 0.25] });
    const drill = model();
    drill.cylinder({ radiusTop: 0.01, radiusBottom: 0.01, height: 0.05, radialSegments: 16 });
    const request = {
      kind: 'boolean' as const,
      inputs: [plate.snapshot(), drill.snapshot()],
      params: { operation: 'difference' as const, tolerance: 1e-5 },
    };
    const r = runComputeJob(request, tsBackend);
    if (!r.ok) throw r.error;
    expect(r.value.report.backendIdentity).toBe(TS_BACKEND_IDENTITY);
    expect(r.value.report.cacheKey).toBe(computeCacheKey(request, TS_BACKEND_IDENTITY));
    expect(computeCacheKey(request, `forgeax-modeling-ts@${changed}`)).not.toBe(
      r.value.report.cacheKey,
    );
  });

  it('a stale digest names the changed, added and removed closure files (falsifier)', () => {
    const files = kernelClosure();
    const recorded = manifest(files);
    const edited = new Map(files);
    const bsp = join(SRC, 'compute/bsp.ts');
    edited.set(bsp, `${files.get(bsp) as string}\n`);
    edited.delete(join(SRC, 'geom.ts'));
    edited.set(join(SRC, 'compute/new-kernel.ts'), 'export {};\n');
    const report = staleReport(recorded, manifest(edited));
    expect(report).toContain('  changed: compute/bsp.ts');
    expect(report).toContain('  added: compute/new-kernel.ts');
    expect(report).toContain('  removed: geom.ts');
    expect(report).toContain('FORGEAX_UPDATE_GOLDEN=1');
    expect(report).toContain('say why in the PR body');
    expect(staleReport(recorded, recorded)).not.toContain('  changed:');
  });
});
