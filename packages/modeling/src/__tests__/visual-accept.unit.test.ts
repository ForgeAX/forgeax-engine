import { describe, expect, it } from 'vitest';
import { accept, type ContractEntry, checkAccept, type GateResult } from '../tools/visual-accept';

const contract: ContractEntry[] = [
  { level: 'L0', part: 'body', gates: ['silhouette', 'validate'] },
  { level: 'L0', part: 'arm', gates: ['validate'] },
  { level: 'L1', part: 'body', gates: ['section'] },
  { level: 'L2', part: 'body', gates: ['shut-line'] },
];
const ran = (
  level: GateResult['level'],
  part: string,
  gate: string,
  pass = true,
  build = 'b1',
): GateResult => ({ level, part, gate, pass, build });
const L0: GateResult[] = [
  ran('L0', 'body', 'silhouette'),
  ran('L0', 'body', 'validate'),
  ran('L0', 'arm', 'validate'),
];

describe('model.accept pass table', () => {
  it('reaches the highest level whose gates and lower levels all pass', () => {
    const r = accept(contract, [...L0, ran('L1', 'body', 'section')], 'b1');
    expect(r.reached).toBe('L1');
    expect(r.pass).toBe(false);
    expect(r.levels.map((l) => [l.level, l.status, l.pass])).toEqual([
      ['L0', 'pass', true],
      ['L1', 'pass', true],
      ['L2', 'unmeasured', false],
    ]);
  });

  it('passes overall only when every level of the contract passes', () => {
    const all = [...L0, ran('L1', 'body', 'section'), ran('L2', 'body', 'shut-line')];
    expect(accept(contract, all, 'b1')).toMatchObject({ pass: true, reached: 'L2', issues: [] });
  });

  it('treats a missing gate as unmeasured, never as a pass', () => {
    const r = accept(contract, L0.slice(0, 2), 'b1');
    expect(r.levels[0]).toMatchObject({ status: 'unmeasured', pass: false });
    expect(r.levels[0]?.parts[1]).toMatchObject({ part: 'arm', pass: false });
    expect(r.reached).toBeUndefined();
    expect(
      r.issues.some((i) => i.code === 'gate-unmeasured' && i.detail.subject === 'L0/arm/validate'),
    ).toBe(true);
  });

  it('treats a result from another build as stale', () => {
    const r = accept(contract, [ran('L0', 'body', 'silhouette', true, 'b0'), ...L0.slice(1)], 'b1');
    expect(r.levels[0]?.parts[0]?.gates[0]?.status).toBe('stale');
    expect(r.issues[0]).toMatchObject({
      code: 'gate-stale',
      detail: { measuredOn: 'b0', build: 'b1' },
    });
    expect(r.pass).toBe(false);
  });

  it('a failed gate fails its level and blocks the levels above even when they pass', () => {
    const r = accept(
      contract,
      [ran('L0', 'body', 'silhouette', false), ...L0.slice(1), ran('L1', 'body', 'section')],
      'b1',
    );
    expect(r.levels[0]?.status).toBe('fail');
    expect(r.levels[1]).toMatchObject({ status: 'pass', pass: false, blockedBy: 'L0' });
    expect(r.issues.map((i) => i.code)).toContain('level-blocked');
    expect(r.reached).toBeUndefined();
  });

  it('records the evidence path per gate', () => {
    const r = accept(
      contract,
      [{ ...ran('L0', 'body', 'silhouette'), evidence: 'cmp/l0.json' }],
      'b1',
    );
    expect(r.levels[0]?.parts[0]?.gates[0]).toMatchObject({
      status: 'pass',
      evidence: 'cmp/l0.json',
    });
  });

  it('rejects a malformed contract or results', () => {
    expect(checkAccept(contract, L0, '')).toMatch(/build/);
    expect(checkAccept([], [], 'b1')).toMatch(/contract/);
    expect(checkAccept(contract, [ran('L3', 'body', 'x')], 'b1')).toMatch(/not in the contract/);
    expect(checkAccept(contract, [L0[0] as GateResult, L0[0] as GateResult], 'b1')).toMatch(
      /repeat/,
    );
    expect(
      checkAccept([contract[0] as ContractEntry, contract[0] as ContractEntry], [], 'b1'),
    ).toMatch(/repeats/);
    expect(checkAccept(contract, L0, 'b1')).toBeUndefined();
  });
});
