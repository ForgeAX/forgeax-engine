import { describe, expect, it } from 'vitest';
import {
  type TimberJointKind,
  type TimberJointOptions,
  timberJoint,
} from '../recipes/timber-joint';
import { sel } from '../selectors';

const kinds: readonly TimberJointKind[] = ['through', 'blind'];
const POST = 'timber-joint-post';
const TENON = 'timber-joint-beam-tenon';
const PEG = 'timber-joint-beam-peg';

function confirmedCrossings(issues: readonly { code: string; detail?: unknown }[]) {
  return issues.filter(
    (i) =>
      i.code === 'self-intersection' &&
      (i.detail as { certainty?: string } | undefined)?.certainty === 'confirmed',
  );
}

describe('timberJoint', () => {
  it.each(kinds)('%s defaults build a closed joint with no confirmed crossing', (kind) => {
    const r = timberJoint({ postWidth: 0.1, kind });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.model.validate({ contacts: r.value.contacts ?? [] });
    expect(report.closed).toBe(true);
    expect(confirmedCrossings(report.issues)).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it.each(kinds)('%s measured tenon clearance is the declared 0.5 mm within 1e-9', (kind) => {
    const r = timberJoint({ postWidth: 0.1, kind });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dimensions.measuredClearance).toBeCloseTo(0.0005, 9);
    expect(r.value.dimensions.clearance).toBe(0.0005);
  });

  it('is deterministic: the same options give the same mesh bytes', () => {
    const options: TimberJointOptions = { postWidth: 0.12, kind: 'through', clearance: 0.0008 };
    const a = timberJoint(options);
    const b = timberJoint(options);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(
      Buffer.from(a.value.model.snapshot()).equals(Buffer.from(b.value.model.snapshot())),
    ).toBe(true);
  });

  it('derives the section proportions from the post width and beam height', () => {
    const r = timberJoint({ postWidth: 0.09 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dimensions.tenonThickness).toBeCloseTo(0.09 / 3, 12);
    expect(r.value.dimensions.tenonHeight).toBeCloseTo(
      0.5 * (r.value.dimensions.beamHeight ?? NaN),
      12,
    );
  });

  it('pegDiameter 0 builds a joint with no peg contact', () => {
    const r = timberJoint({ postWidth: 0.1, pegDiameter: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pegContacts = (r.value.contacts ?? []).filter((c) => c.parts.includes(PEG));
    expect(pegContacts).toEqual([]);
  });

  it('through tenon stands protrusion past the far face by default (0.15 of tenon height)', () => {
    const r = timberJoint({ postWidth: 0.1, kind: 'through' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dims = r.value.dimensions as Record<string, number | undefined>;
    const tenonHeight = dims.tenonHeight ?? NaN;
    const protrusion = dims.protrusion ?? NaN;
    const tenonReach = dims.tenonReach ?? NaN;
    const tenonLength = dims.tenonLength ?? NaN;
    expect(protrusion).toBeCloseTo(0.15 * tenonHeight, 12);
    expect(tenonReach).toBeCloseTo(tenonLength + protrusion, 12);
  });

  it('a through mortise opens at the far face: the tenon end passes beyond the post', () => {
    const r = timberJoint({ postWidth: 0.1, kind: 'through', protrusion: 0.004 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The post stays w = 0.1 wide; the tenon end stands 4 mm past its +X face, so the far mortise
    // is open for the tenon to pass through.
    const post = r.value.model.bounds(sel.createdBy(POST));
    const tenon = r.value.model.bounds(sel.createdBy(TENON));
    expect(post.ok && tenon.ok).toBe(true);
    if (!post.ok || !tenon.ok) return;
    expect(post.value.max[0] - post.value.min[0]).toBeCloseTo(0.1, 9);
    expect(tenon.value.max[0]).toBeGreaterThan(post.value.max[0]);
    expect(tenon.value.max[0] - post.value.max[0]).toBeCloseTo(0.004, 9);
  });

  it('a blind joint keeps a closed back: its tenon stops flush and the floor is declared', () => {
    const r = timberJoint({ postWidth: 0.1, kind: 'blind' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dimensions.protrusion).toBe(0);
    expect(r.value.dimensions.tenonReach).toBeCloseTo(r.value.dimensions.tenonLength as number, 12);
    const report = r.value.model.validate({ contacts: r.value.contacts ?? [] });
    expect(report.closed).toBe(true);
    expect(report.pass).toBe(true);
  });

  it('refuses a negative protrusion with a structured argument error', () => {
    const r = timberJoint({ postWidth: 0.1, kind: 'through', protrusion: -0.001 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('refuses a positive protrusion on a blind joint', () => {
    const r = timberJoint({ postWidth: 0.1, kind: 'blind', protrusion: 0.002 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('falsifier: the tenon reach is tenonLength + protrusion, so a longer reach moves the end', () => {
    const short = timberJoint({ postWidth: 0.1, kind: 'through', protrusion: 0 });
    const long = timberJoint({ postWidth: 0.1, kind: 'through', protrusion: 0.005 });
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    const a = short.value.model.bounds(sel.createdBy(TENON));
    const b = long.value.model.bounds(sel.createdBy(TENON));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.max[0] - a.value.max[0]).toBeCloseTo(0.005, 9);
  });

  it.each([
    ['postWidth too small', { postWidth: 0.01 }],
    ['postWidth too large', { postWidth: 0.5 }],
    ['clearance too large', { postWidth: 0.1, clearance: 0.01 }],
    ['unknown kind', { postWidth: 0.1, kind: 'dovetail' as never }],
    ['blind tenon breaks the back', { postWidth: 0.1, kind: 'blind' as const, tenonLength: 0.099 }],
    ['peg hole taller than the tenon height', { postWidth: 0.1, pegDiameter: 0.08 }],
    [
      'through joint given a tenonLength',
      { postWidth: 0.1, kind: 'through' as const, tenonLength: 0.06 },
    ],
  ])('refuses %s with a structured argument error', (_, options) => {
    const r = timberJoint(options as TimberJointOptions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('falsifier: a tenon displaced 1 mm toward its mortise wall (0.5 mm clearance) is a confirmed crossing', () => {
    const r = timberJoint({ postWidth: 0.1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Measured clearance is 0.5 mm per face. A 1 mm shift toward one Z wall overlaps it by 0.5 mm.
    const m = r.value.model;
    m.translate(sel.createdBy(TENON), [0, 0, 0.001]);
    const report = m.validate({
      contacts: [{ parts: [POST, TENON], kind: 'fit', gap: [0.00025, 0.001] }],
    });
    expect(confirmedCrossings(report.issues).length).toBeGreaterThan(0);
  });

  it('falsifier: pulling the tenon out past its peg is a confirmed interference with the peg', () => {
    const r = timberJoint({ postWidth: 0.1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The peg stays locked in the post holes. Moving only the tenon along -X lifts it out of the
    // mortise, but its peg hole is then displaced from the peg, which must read as a crossing.
    const m = r.value.model;
    m.translate(sel.createdBy(TENON), [-0.05, 0, 0]);
    const report = m.validate({ contacts: r.value.contacts ?? [] });
    const pegCrossings = confirmedCrossings(report.issues);
    expect(pegCrossings.length).toBeGreaterThan(0);
  });
});
