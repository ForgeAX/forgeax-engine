import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { regen } from '../regen';
import { recordSelectors, Selector, type SelectorLog, sel } from '../selectors';

interface Params {
  readonly bevelSegments: number;
  readonly size: number;
}

const SETS: readonly Params[] = [
  { bevelSegments: 2, size: 1 },
  { bevelSegments: 3, size: 1.5 },
  { bevelSegments: 4, size: 0.8 },
];

/** A bracket-like part whose features are all chosen by what built them. */
function part(p: Params) {
  const m = model();
  m.box({ size: [p.size, p.size, p.size], label: 'block' });
  m.inset(sel.facing('+y').one(), { thickness: p.size * 0.2, region: 'merged', label: 'pocket' });
  m.extrude(sel.createdBy('pocket', 'inner').one(), {
    distance: -p.size * 0.2,
    region: 'merged',
    label: 'pocket-cut',
  });
  m.bevel(sel.createdBy('pocket-cut', 'side').toEdges('touching').and(sel.edges.concave()), {
    width: p.size * 0.05,
    segments: p.bevelSegments,
    label: 'round',
  });
  return m;
}

describe('journal selector recording', () => {
  it('records the text, domain, match count, assertion and provenance of each resolved selector', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'cube' });
    m.extrude(sel.facing('+y').one(), { distance: 0.5, region: 'merged', label: 'up' });
    const [box, extrude] = m.journal;
    expect(box?.selectors).toBeUndefined();
    expect(extrude?.selectors).toEqual([
      {
        text: 'facing(+y, 1)',
        domain: 'face',
        matched: 1,
        assert: { kind: 'exactly', count: 1 },
        provenance: ['cube/face:1'],
        signature: 'n[+y] a[cube/face]',
      },
    ]);
  });

  it('records a failing selector use and leaves selector-free calls without the field', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'cube' });
    const bad = m.extrude(sel.tag('nope'), { distance: 1, region: 'merged', label: 'bad' });
    expect(bad.status).toBe('failed');
    expect(m.journal[1]?.selectors?.[0]).toMatchObject({ text: "tag('nope')", matched: 0 });
    expect(m.journal[0]).not.toHaveProperty('selectors');
  });

  it('bounds the recorded uses of one operation', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'cube' });
    const log: SelectorLog = { uses: [], truncated: false };
    recordSelectors(log, () => {
      for (let i = 0; i < 300; i++) sel.all().resolve(m.editMesh);
    });
    expect(log.uses).toHaveLength(256);
    expect(log.truncated).toBe(true);
    sel.all().resolve(m.editMesh);
    expect(log.uses).toHaveLength(256);
  });
});

describe('regen gate', () => {
  it('passes C-123 under three parameter sets: same ops, same selector counts, paired provenance', () => {
    const report = regen(part, SETS);
    expect(report.ok && report.value.findings).toEqual([]);
    expect(report.ok && report.value.pass).toBe(true);
    const runs = report.ok ? report.value.runs : [];
    expect(runs.map((r) => r.operations)).toEqual([4, 4, 4]);
    expect(new Set(runs.map((r) => r.faces)).size).toBe(3);
    expect(runs.every((r) => r.poisoned === undefined)).toBe(true);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(regen(part, SETS));
    const b = JSON.stringify(regen(part, SETS));
    expect(a).toBe(b);
  });

  it('falsifier: an index-based face pick reports the naming-unstable step', () => {
    const ID = 30;
    const pick = (id: number) =>
      new Selector('face', `faceId(${id})`, (mesh) => mesh.faces().filter((f) => f === id));
    const indexed = (p: Params) => {
      const m = part(p);
      const k = m.journal.length;
      m.extrude(pick(ID).one(), { distance: 0.001, region: 'merged', label: 'by-index' });
      expect(m.journal).toHaveLength(k + 1);
      return m;
    };
    const report = regen(indexed, SETS);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.pass).toBe(false);
    const first = report.value.findings[0];
    expect(first).toMatchObject({
      step: 5,
      op: 'extrude',
      label: 'by-index',
      reason: 'selector-provenance',
    });
    expect(first?.message).toContain('step 5');
    expect(new Set(report.value.findings.map((f) => f.paramSet))).toEqual(new Set([1, 2]));
  });

  it('reports a diverging op sequence with the step', () => {
    const job = (extra: boolean) => {
      const m = model();
      m.box({ size: [1, 1, 1], label: 'cube' });
      if (extra) m.extrude(sel.facing('+y'), { distance: 0.5, region: 'merged', label: 'up' });
      return m;
    };
    const report = regen(job, [true, false]);
    expect(report.ok && report.value.findings[0]).toMatchObject({
      step: 2,
      reason: 'op-sequence',
      paramSet: 1,
    });
  });

  it('reports a selector count change', () => {
    const job = (w: number) => {
      const m = model();
      m.box({ size: [1, 1, 1], label: 'cube' });
      const same = new Selector('face', 'ends', (mesh) =>
        w === 0
          ? sel.extreme('+y').evaluate(mesh)
          : sel.extreme('+y').or(sel.extreme('-y')).evaluate(mesh),
      );
      m.inset(same, {
        thickness: 0.2,
        region: 'perFace',
        label: 'up',
      });
      return m;
    };
    const report = regen(job, [0, 1]);
    expect(report.ok && report.value.findings[0]).toMatchObject({
      step: 2,
      reason: 'selector-count',
    });
  });

  it('rejects fewer than two parameter sets', () => {
    const report = regen(part, [SETS[0] as Params]);
    expect(!report.ok && report.error.code).toBe('model-invalid-argument');
  });
});
