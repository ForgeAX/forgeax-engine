import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { sel } from '../selectors';

/** Three overlapping bodies: a block with a plate through its top and a post through its side. */
function bodies(): Model {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'block' });
  m.box({ size: [1.6, 0.1, 0.6], center: [0, 0.3, 0], tag: 'plate' });
  m.box({ size: [0.2, 0.2, 1.4], center: [0.2, -0.2, 0], tag: 'post' });
  return m;
}

const shellIssues = (m: Model, expected?: number) =>
  m
    .validate({ shells: expected === undefined ? {} : { expected } })
    .issues.filter((i) => i.code === 'shell-overlap');

describe('union-then-triangulate-once guard (validate shells)', () => {
  it('falsifier: appended instances cross without a shared edge, the gate is an error', () => {
    const appended = model();
    appended.append(bodies());
    const issues = shellIssues(appended, 1);
    expect(appended.editMesh.faceCount).toBeGreaterThan(0);
    const crossing = issues.find((i) => (i.detail as { reason: string }).reason === 'crossing');
    expect(crossing?.severity).toBe('error');
    expect((crossing?.detail as { crossings: number }).crossings).toBeGreaterThan(0);
    const count = issues.find((i) => (i.detail as { reason: string }).reason === 'component-count');
    expect(count?.detail).toMatchObject({ components: 3, expected: 1 });
    expect(appended.validate({ shells: { expected: 1 } }).pass).toBe(false);
  });

  it('the exact union resolves the intersection curves: one closed component, no crossing', () => {
    const m = bodies();
    expect(m.lowpoly(sel.all(), { targetFaces: 1_000_000, quads: false }).status).toBe('ok');
    expect(shellIssues(m, 1)).toEqual([]);
    const report = m.validate({ shells: { expected: 1 } });
    expect(report.closed).toBe(true);
    expect(report.boundaryEdges).toBe(0);
  });

  it('a separate part the design intends stays one counted component, not an overlap', () => {
    const m = bodies();
    m.box({ size: [0.1, 0.1, 0.1], center: [3, 0, 0], tag: 'rod' });
    expect(
      m.lowpoly(sel.all().minus(sel.tag('rod')), { targetFaces: 1_000_000, quads: false }).status,
    ).toBe('ok');
    expect(shellIssues(m, 2)).toEqual([]);
    expect(shellIssues(m, 1)).toMatchObject([
      { severity: 'warn', detail: { reason: 'component-count', components: 2 } },
    ]);
  });

  it('is off until requested, and reported as unchecked', () => {
    const report = bodies().validate();
    expect(report.issues.some((i) => i.code === 'shell-overlap')).toBe(false);
    expect(report.coverage.unchecked).toContainEqual(
      expect.objectContaining({ code: 'shell-overlap', reason: 'not-requested' }),
    );
  });
});
