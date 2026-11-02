import { describe, expect, it } from 'vitest';
import { type BakeExecutor, type BakeOptions, bakeMaps, bakeMapsParallel } from '../bake';
import { bakePhases } from '../compute/bake-ts';
import { WorkMeter } from '../compute/job';
import { type Model, model } from '../model';
import { sel } from '../selectors';

/**
 * V5 stack-conflict gate: stacked or mirrored UVs share texels, so each triangle on a shared
 * sample must reproduce the same tangent-space normal. A mirrored island over a mirrored
 * detail, or a stack of identical modules, passes; an unmirrored detail under a mirrored
 * island, or stacked modules with different details, conflicts.
 */

const P = 0.1;
const RES = 64;
const TILT = 20;

/** Two plates at x = -P and x = +P mapped onto the same UV square; `mirror` flips the second in u. */
function plates(mirror: boolean): Model {
  const m = model();
  for (const cx of [-P, P]) {
    const plate = model();
    plate.plane({ width: P, height: P, widthSegments: 4, heightSegments: 4 });
    plate.translate(sel.all(), [cx, 0, 0]);
    m.append(plate);
  }
  const mesh = m.editMesh;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const [x, y] = mesh.position(mesh.hVert[h] as number);
      const second = x > 0;
      const local = (x - (second ? P : -P)) / P;
      mesh.setCorner('uv0', h, [second && mirror ? 0.5 - local : local + 0.5, y / P + 0.5]);
    }
  }
  return m;
}

/** Detail planes above each plate, turned about y by the given angles (degrees). */
function tilted(first: number, second: number): Model {
  const m = model();
  for (const [cx, angle] of [
    [-P, first],
    [P, second],
  ] as const) {
    const plane = model();
    plane.plane({ width: 1.2 * P, height: 1.2 * P, widthSegments: 2, heightSegments: 2 });
    if (angle !== 0) plane.rotate(sel.all(), 'y', angle);
    plane.translate(sel.all(), [cx, 0, 0.005]);
    m.append(plane);
  }
  return m;
}

function options(base: Model, detail: Model): BakeOptions {
  return {
    base,
    detail,
    maps: ['normal'],
    resolution: RES,
    cage: { offset: 0.03, maxRay: 0.06 },
    gutter: 'fill',
  };
}

function bake(base: Model, detail: Model) {
  const r = bakeMaps(options(base, detail));
  if (!r.ok) throw r.error;
  return r.value;
}

describe('stacked and mirrored UVs (V5): one tangent-space normal per shared sample (gate)', () => {
  it('a mirrored island over a mirrored detail passes; the same island over an unmirrored detail conflicts (falsifier)', {
    timeout: 30000,
  }, () => {
    const mirrored = bake(plates(true), tilted(TILT, -TILT));
    expect(mirrored.provenance.stack.samples).toBeGreaterThan(RES * RES * 0.9);
    expect(mirrored.provenance.stack.conflicts).toBe(0);
    expect(mirrored.issues).toEqual([]);
    expect(mirrored.pass).toBe(true);
    const wrong = bake(plates(true), tilted(TILT, TILT));
    expect(wrong.pass).toBe(false);
    const issue = wrong.issues.find((i) => i.code === 'stack-conflict');
    expect(issue?.severity).toBe('warn');
    expect(issue?.detail.conflicts).toBe(wrong.provenance.stack.samples);
    // The two tilts mirror into opposite tangent-space x: 2 * TILT apart.
    expect(wrong.provenance.stack.maxAngle).toBeCloseTo(2 * TILT, 0);
    expect(typeof issue?.detail.subject).toBe('number');
    expect(issue?.detail.subject).toBeGreaterThanOrEqual(0);
  });

  it('stacked identical modules pass; stacked modules with different details conflict (falsifier)', {
    timeout: 30000,
  }, () => {
    const same = bake(plates(false), tilted(TILT, TILT));
    expect(same.provenance.stack.samples).toBeGreaterThan(RES * RES * 0.9);
    expect(same.issues).toEqual([]);
    const different = bake(plates(false), tilted(TILT, 0));
    expect(different.issues.map((i) => i.code)).toEqual(['stack-conflict']);
    expect(different.provenance.stack.maxAngle).toBeCloseTo(TILT, 0);
  });

  it('split rows merge to the serial result; without a normal map the stack is still checked (audit A6)', {
    timeout: 30000,
  }, async () => {
    const base = plates(false);
    const detail = tilted(TILT, 0);
    const serial = bake(base, detail);
    const solo = bakeMaps({ ...options(base, detail), maps: ['ao'], ao: { rays: 4 } });
    if (!solo.ok) throw solo.error;
    // Without a normal map the stack is still re-derived: the same stacked samples, and
    // the tilted against the flat detail still conflicts.
    expect(solo.value.provenance.stack.samples).toBe(serial.provenance.stack.samples);
    expect(solo.value.provenance.stack.conflicts).toBeGreaterThan(0);
    const reversed: BakeExecutor = async (request, rows, { budget }) => {
      const prepared = bakePhases.prepare(request, new WorkMeter(Number.POSITIVE_INFINITY));
      if (!prepared.ok) throw prepared.error;
      const parts = [...rows].reverse().map((row) => {
        const part = bakePhases.rows(prepared.value, [row], new WorkMeter(budget));
        if (!part.ok) throw part.error;
        return part.value;
      });
      return { ok: true, parts, work: 0 };
    };
    const split = await bakeMapsParallel(options(base, detail), reversed);
    if (!split.ok) throw split.error;
    expect(split.value.provenance.stack).toEqual(serial.provenance.stack);
    expect(split.value.issues).toEqual(serial.issues);
    expect(Buffer.from(split.value.textures.normal?.data as Uint8Array)).toEqual(
      Buffer.from(serial.textures.normal?.data as Uint8Array),
    );
  });
});
