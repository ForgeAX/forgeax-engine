import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelingTools, type ModelBakeReport } from '@forgeax/engine-modeling/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPng } from '../tools/image-metrics';

const root = fileURLToPath(new URL('../../', import.meta.url));
let directory = '';
let source = '';

// Session 0: the low sphere with uv0; session 1: the dense sphere; session 2: a plane
// with a hard edge across a continuous uv0 (a V1 finding).
const PACK = `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000b20b'),
  build() {
    const low = model();
    low.sphere({ radius: 0.5, widthSegments: 16, heightSegments: 8 });
    low.uv.auto({ resolution: 64, padding: 2 });
    const high = model();
    high.sphere({ radius: 0.5, widthSegments: 96, heightSegments: 48 });
    const plate = model();
    plate.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    plate.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    plate.markSharp(sel.side([0, 0, 0], [1, 0, 0], { by: 'centroid' }).boundary());
    return low.finish({ key: 'low' });
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.isolation-bake-'));
  await writeFile(join(directory, 'sphere.pack.ts'), PACK);
  source = relative(root, join(directory, 'sphere.pack.ts'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function bake(args: Record<string, unknown>) {
  const tool = createModelingTools({ projectRoot: root }).find(
    (t) => t.descriptor.id === 'model.bake',
  );
  if (tool === undefined) throw new Error('model.bake missing');
  return tool.execute({ source, ...args } as never, {} as never) as Promise<{
    ok: boolean;
    value?: ModelBakeReport;
    error?: { code: string };
  }>;
}

describe('model.bake', () => {
  it('bakes the detail session onto the base session and reports metrics, maps and artifacts', {
    timeout: 120_000,
  }, async () => {
    const out = relative(root, join(directory, 'out'));
    const result = await bake({ base: 0, detail: 1, resolution: 64, out, compare: true });
    expect(result.ok).toBe(true);
    const report = result.value as ModelBakeReport;
    expect(report.schema).toBe('forgeax.model.bake/1');
    expect(report.pass).toBe(true);
    expect(report.base.session).toBe(0);
    expect(report.base.output).toBe('mesh/low');
    expect(report.detail.session).toBe(1);
    expect(report.metrics.rayHitRatio).toBe(1);
    expect(report.maps.normal?.covered).toBe(64 * 64);
    // A sphere over a sphere: the normal map stays near flat and AO open.
    expect(report.maps.normal?.mean[2]).toBeGreaterThan(0.95);
    expect(report.maps.ao?.min[0]).toBeGreaterThan(0.9);
    expect(report.artifacts).toHaveLength(2);
    for (const file of report.artifacts) expect(existsSync(join(root, file))).toBe(true);
    const png = readPng(new Uint8Array(await readFile(join(root, report.artifacts[0] as string))));
    expect(png.image.width).toBe(64);
    expect(report.compare?.map((c) => c.view.name)).toEqual([
      'front',
      'three-quarter',
      'top',
      'grazing',
    ]);
    expect(report.compare?.[0]?.high.session).toBe(1);
  });

  it('fails the report on a base finding: a hard edge without a UV seam (V1)', {
    timeout: 120_000,
  }, async () => {
    const result = await bake({ base: 2, detail: 2, resolution: 32, maps: ['normal'] });
    expect(result.ok).toBe(true);
    const report = result.value as ModelBakeReport;
    expect(report.pass).toBe(false);
    expect(report.issues[0]).toMatchObject({
      code: 'bake',
      detail: { check: 'sharp-not-seam', count: 4 },
    });
  });

  it('reports byte-identically for the same input', { timeout: 120_000 }, async () => {
    const [a, b] = await Promise.all([
      bake({ base: 0, detail: 1, resolution: 16 }),
      bake({ base: 0, detail: 1, resolution: 16 }),
    ]);
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });

  it('confines out to the project', { timeout: 120_000 }, async () => {
    const result = await bake({ base: 0, detail: 1, resolution: 16, out: '../elsewhere' });
    expect(result).toMatchObject({ ok: false, error: { code: 'tool-invalid-args' } });
  });
});
