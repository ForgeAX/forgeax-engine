import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { IblGpuCaseResult } from '../ibl-adapter';
import type { IblRawEvidence } from '../../report/capability-status';

type ExpectedStatus = IblRawEvidence['status'];
type FinalDisplayStatus = IblGpuCaseResult['finalDisplay']['status'];

const adapterSource = readFileSync(new URL('../ibl-adapter.ts', import.meta.url), 'utf8');

describe('IBL final-display status owner', () => {
  it('keeps the final-display status projection exact in both directions', () => {
    expectTypeOf<FinalDisplayStatus>().toEqualTypeOf<ExpectedStatus>();
    expectTypeOf<ExpectedStatus>().toEqualTypeOf<FinalDisplayStatus>();
  });

  it('keeps the closed raw-evidence status vocabulary', () => {
    const acceptsStatus = (status: ExpectedStatus): ExpectedStatus => status;
    acceptsStatus('ready');
    acceptsStatus('failed');
    // @ts-expect-error Unknown IBL terminal statuses are outside the raw-evidence owner.
    acceptsStatus('pending');
  });

  it('derives both final-display branches from the raw-evidence status', () => {
    expect(adapterSource).toContain("readonly status: IblRawEvidence['status'];");
    expect(adapterSource).toContain('status: evidence.status');
    expect(adapterSource).not.toContain("finalDisplay: { status: 'failed'");
    expect(adapterSource).not.toContain("status: 'ready',\n        bytes: finalBytes");
  });
});
