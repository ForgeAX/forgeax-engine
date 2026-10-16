import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type GateReceipt = {
  readonly terminalVerdict: string;
  readonly ac26: string;
  readonly carriers: readonly { readonly carrier: string; readonly status: string; readonly gpuStatus: string }[];
  readonly acceptanceCriteria: readonly { readonly id: string; readonly status: string; readonly evidence: string }[];
  readonly findings: readonly { readonly id: string; readonly status: string; readonly evidence: string }[];
  readonly oos: readonly { readonly id: string; readonly status: string; readonly evidence: string }[];
};

const receiptPath = resolve(
  import.meta.dirname,
  '../../../../../../.forgeax-harness/forgeax-loop/feat-20260828-rect-area-ies-cookie-light-probe/m6-ac-oos-finding-gate.json',
);

describe('M6 acceptance, finding, and OOS receipt', () => {
  it('keeps every terminal item explicit and blocks AC-26 on missing GPU evidence', () => {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as GateReceipt;
    expect(receipt.terminalVerdict).toBe('DONE_WITH_CONCERNS');
    expect(receipt.ac26).toBe('blocked');
    expect(receipt.carriers.map(({ carrier }) => carrier)).toEqual([
      'rect-area',
      'spot-modifiers',
      'probe',
      'recovery',
    ]);
    expect(receipt.carriers.every(({ status }) => status === 'structural-pass')).toBe(true);
    expect(receipt.carriers.every(({ gpuStatus }) => gpuStatus === 'not-run')).toBe(true);
    expect(receipt.acceptanceCriteria.map(({ id }) => id)).toEqual(
      Array.from({ length: 26 }, (_, index) => `AC-${String(index + 1).padStart(2, '0')}`),
    );
    expect(receipt.findings.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `F-G${index + 1}`),
    );
    expect(receipt.oos.map(({ id }) => id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `OOS-${String(index + 1).padStart(2, '0')}`),
    );
    expect(receipt.acceptanceCriteria.every(({ status, evidence }) => status !== '' && evidence !== '')).toBe(true);
    expect(receipt.findings.every(({ status, evidence }) => status !== '' && evidence !== '')).toBe(true);
    expect(receipt.oos.every(({ status, evidence }) => status !== '' && evidence !== '')).toBe(true);
  });
});
