import { generateMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import { FIXTURES, runScale, type ScaleDeps } from '../../bench/scale-f1.mjs';
import { lodTopologyReport } from '../lod-topology';
import { model } from '../model';
import { sel } from '../selectors';

/**
 * K5-6: `bench/scale-f1.mjs` on its tiny fixture. The report numbers are host-dependent and
 * ungated; the test proves the script runs end to end on the source modules and that the
 * counts it reports follow the fixture.
 */

const packageId = definePackageId('01900000-0000-7000-8000-0000000c1056');
const deps: ScaleDeps = {
  model,
  sel,
  lodTopologyReport,
  generateMeshLods: generateMeshLods as unknown as ScaleDeps['generateMeshLods'],
  deriveGuid: (name) => AssetGuid.derive(packageId, name),
};

describe('scale-f1 measurement script', () => {
  it('reports counts, phase times, memory and an extrapolation for the tiny fixture', async () => {
    const report = await runScale(deps, FIXTURES.tiny, 1000);

    expect(report.parts).toBe(FIXTURES.tiny.parts);
    expect(report.faces).toBeGreaterThan(report.parts);
    expect(report.triangles).toBeGreaterThanOrEqual(report.faces);
    expect(report.lodTriangles).toHaveLength(3);
    expect(report.lodTriangles[0]).toBe(report.triangles);
    expect(report.lodTriangles[2] as number).toBeLessThan(report.triangles);
    expect(report.lodTopology.every((lod) => lod.nonManifoldEdges === 0)).toBe(true);
    for (const ms of Object.values(report.phasesMs)) expect(ms).toBeGreaterThanOrEqual(0);
    expect(report.memory.peakRssMb).toBeGreaterThan(0);
    expect(report.memory.peakHeapUsedMb).toBeGreaterThan(0);
    expect(report.extrapolation.factor).toBeCloseTo(1000 / report.triangles, 2);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('scales the triangle count with the part count', async () => {
    const small = await runScale(deps, { ...FIXTURES.tiny, parts: 2 });
    const large = await runScale(deps, { ...FIXTURES.tiny, parts: 4 });
    expect(large.triangles).toBe(small.triangles * 2);
    expect(large.faces).toBe(small.faces * 2);
  });
});
