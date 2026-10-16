/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  SerializedIblEvidence,
  SerializedIblFinalDisplay,
} from '../auxiliary-case-report';

type ExpectedIblReadiness = 'ready' | 'failed';
type EvidenceStatus = SerializedIblEvidence['status'];
type FinalDisplayStatus = SerializedIblFinalDisplay['status'];

const auxiliarySource = readFileSync(
  new URL('../auxiliary-case-report.ts', import.meta.url),
  'utf8',
);

describe('IBL readiness status owner', () => {
  it('derives final-display readiness from the evidence owner in both directions', () => {
    expectTypeOf<EvidenceStatus>().toEqualTypeOf<ExpectedIblReadiness>();
    expectTypeOf<ExpectedIblReadiness>().toEqualTypeOf<EvidenceStatus>();
    expectTypeOf<FinalDisplayStatus>().toEqualTypeOf<EvidenceStatus>();
    expectTypeOf<EvidenceStatus>().toEqualTypeOf<FinalDisplayStatus>();
  });

  it('preserves the exact closed readiness vocabulary', () => {
    const acceptsReadiness = (status: EvidenceStatus): EvidenceStatus => status;
    acceptsReadiness('ready');
    acceptsReadiness('failed');
    // @ts-expect-error IBL readiness has no partial state.
    acceptsReadiness('partial');
  });

  it('keeps the owner ledger and removes only the downstream duplicate', () => {
    expect(auxiliarySource).toContain(
      "export interface SerializedIblEvidence {\n  readonly status: 'ready' | 'failed';",
    );
    expect(auxiliarySource).toContain(
      "export interface SerializedIblFinalDisplay {\n  readonly status: SerializedIblEvidence['status'];",
    );
    expect(auxiliarySource).not.toContain(
      "export interface SerializedIblFinalDisplay {\n  readonly status: 'ready' | 'failed';",
    );
  });
});
