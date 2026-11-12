import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { regen } from '../regen';
import { recordSelectors, Selector, type SelectorLog, sel } from '../selectors';

const reasons = (r: ReturnType<typeof regen>) =>
  r.ok ? r.value.findings.map((f) => `${f.step}/${f.paramSet}/${f.reason}`) : r.error.code;

function cubeUp(pick: (flip: boolean) => Selector<'face'>) {
  return (flip: boolean) => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'cube' });
    m.extrude(pick(flip).one(), { distance: 0.5, region: 'merged', label: 'up' });
    return m;
  };
}

function manyLabels(which: 'zA' | 'zB', finish: 'translate' | 'assign') {
  const m = model();
  for (let i = 0; i < 16; i++) {
    m.box({ size: [0.1, 0.1, 0.1], center: [i, 0, 0], label: `l${String(i).padStart(2, '0')}` });
  }
  m.box({ size: [0.1, 0.1, 0.1], center: [20, 0, 0], label: 'zA' });
  m.box({ size: [0.1, 0.1, 0.1], center: [30, 0, 0], label: 'zB' });
  const drop = which === 'zA' ? 'zB' : 'zA';
  const subset = new Selector('face', 'subset', (mesh) =>
    sel
      .all()
      .evaluate(mesh)
      .filter((f) => mesh.labelNames[mesh.fLabel[f] as number] !== drop),
  );
  if (finish === 'translate') m.translate(subset, [0, 1, 0]);
  else m.assign(subset, 'paint');
  return m;
}

describe('regen', () => {
  it('A1: a stable-text pick that flips facing is caught by the signature', () => {
    const job = cubeUp(
      (flip) =>
        new Selector('face', 'top', (mesh) => sel.facing(flip ? '-y' : '+y').evaluate(mesh)),
    );
    const r = regen(job, [false, true]);
    expect(reasons(r)).toEqual(['2/1/selector-signature']);
    expect(r.ok && r.value.findings[0]?.expected).toContain('n[+y]');
  });

  it('A1: the same pick in every set stays green', () => {
    const job = cubeUp(
      () => new Selector('face', 'top', (mesh) => sel.facing('+y').evaluate(mesh)),
    );
    expect(reasons(regen(job, [false, true]))).toEqual([]);
  });

  it('A2: identical failures in every set do not pass', () => {
    const job = (s: number) => {
      const m = model();
      m.box({ size: [s, s, s], label: 'cube' });
      m.extrude(sel.tag('missing'), { distance: 1, region: 'merged', label: 'bad' });
      m.inset(sel.facing('+y').one(), { thickness: 0.1, region: 'merged', label: 'later' });
      return m;
    };
    const r = regen(job, [1, 2, 3]);
    expect(r.ok && r.value.pass).toBe(false);
    expect(reasons(r)).toEqual(['2/0/run-failed', '2/1/run-failed', '2/2/run-failed']);
  });

  it('A2: non-finite parameter sets do not pass', () => {
    const job = (s: number) => {
      const m = model();
      m.box({ size: [1, 1, 1], label: 'cube' });
      m.extrude(sel.facing('+y').one(), { distance: s, region: 'merged', label: 'up' });
      return m;
    };
    const both = regen(job, [Number.NaN, Number.NaN]);
    expect(both.ok && both.value.pass).toBe(false);
    const mixed = regen(job, [1, Number.NaN]);
    expect(mixed.ok && mixed.value.pass).toBe(false);
  });

  it('A3: vertex selectors record the faces around them and compare their signature', () => {
    const job = (k: number) => {
      const m = model();
      m.box({ size: [1, 1, 1], label: 'cube' });
      const vs = new Selector('vert', 'vertId', (mesh) => [mesh.vertices()[k] as number]);
      m.translate(vs.one(), [0, 0.3, 0]);
      return m;
    };
    expect(job(0).journal[1]?.selectors?.[0]?.provenance).toEqual(['cube/face:3']);
    expect(reasons(regen(job, [0, 5]))).toEqual(['2/1/selector-signature']);
  });

  it('A4: a difference beyond the 16th provenance key is still caught', () => {
    const r = regen((w: 'zA' | 'zB') => manyLabels(w, 'translate'), ['zA', 'zB']);
    expect(reasons(r)).toEqual(['19/1/selector-provenance']);
  });

  it('A6: the finding names the step whose selector differs, not the steps that made the labels', () => {
    const r = regen((w: 'zA' | 'zB') => manyLabels(w, 'assign'), ['zA', 'zB']);
    expect(r.ok && r.value.findings.map((f) => f.step)).toEqual([19]);
  });

  it('A4: uses beyond the recording cap are a finding', () => {
    const job = (variant: number) => {
      const m = model();
      m.box({ size: [1, 1, 1], label: 'cube' });
      const s = new Selector('face', 'looping', (mesh) => {
        for (let i = 0; i < 260; i++) sel.all().resolve(mesh);
        return variant === 0
          ? sel.facing('+y').evaluate(mesh)
          : [...sel.facing('+y').evaluate(mesh), ...sel.facing('+x').evaluate(mesh)];
      });
      m.inset(s, { thickness: 0.1, region: 'perFace', label: 'up' });
      return m;
    };
    expect(reasons(regen(job, [0, 1]))).toEqual(['2/1/selector-truncated']);
  });

  it('A5: declared scaling labels may change their face counts, undeclared ones may not', () => {
    const job = (seg: number) => {
      const m = model();
      m.box({ size: [1, 1, 1], label: 'cube' });
      m.bevel(sel.edges.all(), { width: 0.05, segments: seg, label: 'round' });
      m.assign(sel.createdBy('round'), 'polished');
      return m;
    };
    expect(reasons(regen(job, [2, 3]))).toEqual(['3/1/selector-count']);
    expect(reasons(regen(job, [2, 3], { scaling: ['round'] }))).toEqual([]);
    const roles = { scaling: ['round/bevel', 'round/corner'] };
    expect(reasons(regen(job, [2, 3], roles))).toEqual([]);
    expect(reasons(regen(job, [2, 3], { scaling: ['round/bevel'] }))).toEqual([
      '3/1/selector-provenance',
    ]);
    expect(reasons(regen(job, [2, 3], { scaling: ['other'] }))).toEqual(['3/1/selector-count']);
  });

  it('A7: a throwing job returns a Result', () => {
    const r = regen(
      (s: number) => {
        if (s > 1) throw new Error('boom');
        return model();
      },
      [1, 2],
    );
    expect(!r.ok && r.error.code).toBe('model-precondition');
    expect(!r.ok && r.error.detail).toMatchObject({ paramSet: 1, message: 'boom' });
  });

  it('A8: recording a whole-mesh selection stays under twice the plain cost', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'cube', segments: [90, 90, 90] });
    const mesh = m.editMesh;
    const time = (record: boolean) => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        if (record) {
          const log: SelectorLog = { uses: [], truncated: false };
          recordSelectors(log, () => sel.all().resolve(mesh));
        } else sel.all().resolve(mesh);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(true);
    time(false);
    const recorded = time(true);
    expect(recorded).toBeLessThan(time(false) * 2);
  });
});
