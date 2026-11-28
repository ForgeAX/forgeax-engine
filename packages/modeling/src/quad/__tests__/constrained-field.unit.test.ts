import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bracket } from '../../../examples/quad-field/models';
import { holedPlate, wavyPatch } from '../../../examples/trimmed-faces/models';
import { tessellate, tessellateSampled } from '../../brep/tessellate';
import { constrainedFaceField } from '../constrained-field';
import { crossField } from '../cross-field';
import { cross3, dot3, sub3, unit3, type Vec3, vec } from '../trimesh';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function reasonOf(r: { ok: boolean; error?: unknown }): [string, string | undefined] {
  const e = (r as { error: { code: string; detail?: { reason?: string } } }).error;
  return [e.code, e.detail?.reason];
}

/** Angle in degrees, mod 90, between triangle t's field and the segment a->b. */
function offAxis(
  field: ReturnType<
    typeof must<
      ReturnType<typeof constrainedFaceField> extends infer R
        ? R extends { ok: true; value: infer V }
          ? V
          : never
        : never
    >
  >['field'],
  t: number,
  a: number,
  b: number,
): number {
  const m = field.mesh;
  const e = unit3(sub3(vec(m.positions, b), vec(m.positions, a)));
  const q = vec(field.direction, t);
  const n = vec(field.normal, t);
  const ang = Math.atan2(dot3(cross3(q, e), n), dot3(q, e));
  const r = Math.abs(ang) % (Math.PI / 2);
  return ((r > Math.PI / 4 ? Math.PI / 2 - r : r) * 180) / Math.PI;
}

describe('tessellateSampled', () => {
  it('returns the same mesh as tessellate plus per-edge samples and face owners', () => {
    const { shape } = holedPlate();
    const plain = must(tessellate(shape));
    const sampled = must(tessellateSampled(shape));
    expect(sampled.mesh.faceCount).toBe(plain.faceCount);
    expect(sampled.mesh.vertexCount).toBe(plain.vertexCount);
    expect(sampled.samples.size).toBeGreaterThan(0);
    expect(sampled.owner.length).toBeGreaterThanOrEqual(sampled.mesh.faceCount);
    for (const f of sampled.mesh.faces()) expect(sampled.owner[f]).toBe(0);
  });
});

describe('constrainedFaceField on a NURBS plate with holes', () => {
  const { shape } = holedPlate();
  const result = must(constrainedFaceField(shape));

  it('derives constraints from the B-rep: every loop is a trim loop with a hard even-count', () => {
    const loops = result.constraints.constraints.filter(
      (c) => c.origin === 'trim-loop' && c.kind === 'even-count',
    );
    expect(loops).toHaveLength(9);
    expect(loops.every((c) => c.hard)).toBe(true);
    expect(result.report.hardSegments).toBeGreaterThan(100);
    expect(result.report.alignedEdges).toBe(result.report.hardSegments);
  });

  it('pins the triangles beside every loop segment and aligns the field to it', () => {
    const m = result.field.mesh;
    let worst = 0;
    let checked = 0;
    for (const [a, b] of result.aligned) {
      for (let t = 0; t < m.triangles.length / 3; t++) {
        const ids = [0, 1, 2].map((k) => m.triangles[3 * t + k] as number);
        if (!ids.includes(a) || !ids.includes(b) || result.field.fixed[t] !== 1) continue;
        worst = Math.max(worst, offAxis(result.field, t, a, b));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(result.aligned.length * 0.9);
    expect(worst).toBeLessThan(1e-6);
    expect(result.report.cross.featureAngleError.max).toBeLessThan(1e-6);
  });

  it('the plate has forced singularities, none within the zone distance of a hard loop', () => {
    expect(result.report.zoneTriangles).toBeGreaterThan(200);
    expect(result.report.singularities).toBeGreaterThan(0);
    const m = result.field.mesh;
    let nearest = Infinity;
    for (const s of result.field.singularities) {
      const p = vec(m.positions, s.at);
      for (const [a, b] of result.hardLoops) {
        const pa = vec(m.positions, a);
        const ab = sub3(vec(m.positions, b), pa);
        const t = Math.min(1, Math.max(0, dot3(sub3(p, pa), ab) / dot3(ab, ab)));
        const q = sub3(p, [pa[0] + t * ab[0], pa[1] + t * ab[1], pa[2] + t * ab[2]]);
        nearest = Math.min(nearest, Math.sqrt(dot3(q, q)));
      }
    }
    expect(nearest).toBeGreaterThan(result.report.zoneDistance);
    expect(result.report.singularitiesInZone).toBe(0);
  });

  it('falsifier: the zone is what pins its band; with zoneWidth 0 those triangles are free', () => {
    const off = must(constrainedFaceField(shape, { zoneWidth: 0 }));
    expect(off.report.zoneTriangles).toBe(0);
    let pinnedWithZone = 0;
    let pinnedWithout = 0;
    for (const f of result.field.fixed) pinnedWithZone += f;
    for (const f of off.field.fixed) pinnedWithout += f;
    expect(pinnedWithZone).toBeGreaterThan(pinnedWithout);
    expect(pinnedWithZone - pinnedWithout).toBeGreaterThan(0);
  });

  it('zone triangles follow the loop direction: field mod 90 stays parallel or perpendicular', () => {
    expect(result.report.maxPinJumpDegrees).toBeLessThan(40);
    for (let t = 0; t < result.zone.length; t++)
      if (result.zone[t] === 1) expect(result.field.fixed[t]).toBe(1);
  });

  it('is deterministic', () => {
    const again = must(constrainedFaceField(shape));
    expect(Array.from(again.field.direction)).toEqual(Array.from(result.field.direction));
    expect(again.report.zoneTriangles).toBe(result.report.zoneTriangles);
  });
});

describe('constrainedFaceField is opt-in', () => {
  it('the default crossField path is unchanged by the pin hook', () => {
    const base = must(crossField(bracket()));
    const withHook = must(
      crossField(bracket(), { pinTriangles: () => ok(new Map<number, Vec3>()) }),
    );
    expect(Array.from(withHook.field.direction)).toEqual(Array.from(base.field.direction));
    expect(withHook.report.constrainedTriangles).toBe(base.report.constrainedTriangles);
  });
});

describe('constrainedFaceField fails closed', () => {
  const { shape } = holedPlate();

  it('rejects a bad zone width and a bad pin jump with model-invalid-argument', () => {
    expect(reasonOf(constrainedFaceField(shape, { zoneWidth: -1 }))).toEqual([
      'model-invalid-argument',
      'bad-zone-width',
    ]);
    expect(reasonOf(constrainedFaceField(shape, { maxPinJumpDegrees: 90 }))).toEqual([
      'model-invalid-argument',
      'bad-pin-jump',
    ]);
  });

  it('rejects an unknown face', () => {
    expect(reasonOf(constrainedFaceField(shape, { faces: [7] }))).toEqual([
      'model-invalid-argument',
      'unknown-face',
    ]);
  });

  it('a zone that two close loops pin to conflicting directions is model-partial, not a wrong field', () => {
    const r = constrainedFaceField(shape, { zoneWidth: 6, maxPinJumpDegrees: 5 });
    expect(reasonOf(r)).toEqual(['model-partial', 'no-singularity-zone-infeasible']);
  });

  it('a zone wide enough to contain a forced singularity is model-partial singularity-in-zone', () => {
    expect(reasonOf(constrainedFaceField(shape, { zoneWidth: 24, maxPinJumpDegrees: 45 }))).toEqual(
      ['model-partial', 'singularity-in-zone'],
    );
    expect(
      reasonOf(constrainedFaceField(wavyPatch(), { zoneWidth: 16, maxPinJumpDegrees: 45 })),
    ).toEqual(['model-partial', 'singularity-in-zone']);
  });
});

describe('constrainedFaceField on a curved NURBS dome with a hole', () => {
  it('aligns the field to the outline and the hole on a curved surface', () => {
    const r = must(constrainedFaceField(wavyPatch()));
    expect(r.report.cross.featureAngleError.max).toBeLessThan(1e-6);
    expect(r.report.singularitiesInZone).toBe(0);
    expect(r.report.zoneTriangles).toBeGreaterThan(0);
  });
});
