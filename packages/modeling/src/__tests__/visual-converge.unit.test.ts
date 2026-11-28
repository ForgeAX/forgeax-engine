import { describe, expect, it } from 'vitest';
import { type ConvergeEntry, converge } from '../tools/visual-converge';

const e = (fidelity: number, extra: Partial<ConvergeEntry> = {}): ConvergeEntry => ({
  fidelity,
  defectTags: [],
  reverted: false,
  ...extra,
});

describe('model.converge stop policy', () => {
  it('continues on an empty history', () => {
    const r = converge([]);
    expect(r).toMatchObject({ stop: false, rule: 'empty', action: 'continue-iterating' });
  });

  it('accepts when the target is met with no open defects, but not with one open', () => {
    expect(converge([e(0.9)])).toMatchObject({ stop: true, rule: 'success', action: 'accept' });
    expect(converge([e(0.9, { defectTags: ['ears'] })]).rule).not.toBe('success');
  });

  it('a hard gate outranks success and routes to code', () => {
    const r = converge([e(0.95, { hardGateFailures: ['silhouette-mismatch'] })]);
    expect(r).toMatchObject({ stop: true, rule: 'hard-gate', action: 'refine-code' });
    expect(r.issues[0]?.code).toBe('hard-gate');
  });

  it('a non-pass verdict stops for review even above the target', () => {
    const r = converge([e(0.95, { verdict: 'low-confidence' })]);
    expect(r).toMatchObject({ stop: true, rule: 'pending-review', action: 'request-input' });
  });

  it('stops on a defect that survives two consecutive iterations', () => {
    const r = converge([e(0.4, { defectTags: ['eye', 'tail'] }), e(0.6, { defectTags: ['tail'] })]);
    expect(r).toMatchObject({ stop: true, rule: 'repeated-defect', action: 'refine-spec' });
    expect(r.issues[0]?.detail.subject).toBe('tail');
  });

  it('stops on two trailing reverts and not on one', () => {
    expect(converge([e(0.5), e(0.4, { reverted: true })]).rule).not.toBe('oscillation');
    const r = converge([e(0.5), e(0.4, { reverted: true }), e(0.45, { reverted: true })]);
    expect(r.rule).toBe('oscillation');
    expect(r.best).toBe(0);
  });

  it('stops on a plateau below the target', () => {
    const r = converge([e(0.6), e(0.61)]);
    expect(r).toMatchObject({ stop: true, rule: 'plateau', action: 'request-input' });
  });

  it('keeps going while improving and the ceiling is not reached', () => {
    expect(converge([e(0.4), e(0.55), e(0.7)])).toMatchObject({ stop: false, rule: 'improving' });
  });

  it('enforces the ceiling even for a loop that keeps improving', () => {
    let history: ConvergeEntry[] = [];
    let steps = 0;
    while (!converge(history, { maxIter: 5 }).stop) {
      history = [...history, e(0.1 + 0.1 * history.length)];
      steps++;
      expect(steps).toBeLessThanOrEqual(5);
    }
    expect(history).toHaveLength(5);
    expect(converge(history, { maxIter: 5 }).rule).toBe('ceiling');
  });
});
