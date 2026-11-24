import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  SDF_SURFACE_INTERSECTION_WGSL,
  SDF_SURFACE_LOCAL_RAY_WGSL,
} from '../sdf-surface-intersection-wgsl';
import { SDF_SURFACE_MARCH_FOUNDATION_WGSL } from '../sdf-surface-march-wgsl';
import { SDF_SURFACE_TRACE_WGSL } from '../sdf-surface-trace-wgsl';

function requireMarchFoundation(source: string) {
  if (/\bfn\s+sdfSurface(?:Triangle|LeafTriangle|TraceRow|Accept)\s*\(/.test(source)) {
    throw new Error('Exact triangle traversal must stay out of the march foundation');
  }
  for (const name of ['sdfIntervalRaw', 'sdfSurfaceLocalRay', 'sdfSurfaceRootPrefix']) {
    expect(source.match(new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'g')), name).toHaveLength(1);
  }
}

it('composes the march foundation without an exact triangle CFG', () => {
  requireMarchFoundation(SDF_SURFACE_MARCH_FOUNDATION_WGSL);
});

// Lock composition after interval refinement, authored opacity and near-first traversal.
it('retains the current exact query and trace composition', () => {
  const entries = {
    SDF_SURFACE_INTERSECTION_WGSL,
    SDF_SURFACE_LOCAL_RAY_WGSL,
    SDF_SURFACE_TRACE_WGSL,
  };
  const expected = {
    SDF_SURFACE_INTERSECTION_WGSL:
      'e45f25518906fdc66ae2e1255b1b57c08dd1bdf9bb32f54abacc7fb798e6a769',
    SDF_SURFACE_LOCAL_RAY_WGSL: 'eb491ee0ec9e634aa04a994f5eef0a6578becdd2a7520dd68b4c927661de7dbd',
    SDF_SURFACE_TRACE_WGSL: 'b16e1ae23467776679ba812051f13add917492f6045c0629ecd101033c18bd0f',
  };
  const actual = Object.fromEntries(
    Object.entries(entries).map(([name, source]) => [
      name,
      createHash('sha256').update(source).digest('hex'),
    ]),
  );
  expect(actual).toEqual(expected);
});

it('rejects exact code appended to the actual foundation even when unreachable', () => {
  const wrong = SDF_SURFACE_MARCH_FOUNDATION_WGSL + SDF_SURFACE_INTERSECTION_WGSL;
  expect(() => requireMarchFoundation(wrong)).toThrow('Exact triangle traversal');
  expect(wrong).not.toBe(SDF_SURFACE_MARCH_FOUNDATION_WGSL);
});

it('exposes only preparation and one empty-prefix sample, without producing a surface hit', () => {
  expect(SDF_SURFACE_MARCH_FOUNDATION_WGSL).not.toMatch(
    /\bstruct\s+(Hit|SdfHit|SdfSurfaceTrace|SdfSurfaceIntersection)\b/,
  );
  expect(SDF_SURFACE_MARCH_FOUNDATION_WGSL).not.toMatch(/@binding|@group|var<storage/);
  expect(SDF_SURFACE_MARCH_FOUNDATION_WGSL).toContain('packet.prefixEligible!=1u');
  expect(SDF_SURFACE_MARCH_FOUNDATION_WGSL).toContain('ray.valid!=1u');
  expect(SDF_SURFACE_MARCH_FOUNDATION_WGSL).toContain('sdfInstanceWord(row,35u)!=0x40000000u');
});
