import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { projectIblRawEvidence, type IblRawEvidence } from '../capability-status';
import type { PipelineAuditObservation } from '../status';

type ExpectedLifetime = PipelineAuditObservation['lifetime'];
type ReadyReadback = Extract<
  Parameters<typeof projectIblRawEvidence>[0]['readback'],
  { readonly status: 'ready' }
>;
type ReadyReadbackLifetime = ReadyReadback['lifetime']['state'];
type RawEvidenceLifetime = NonNullable<IblRawEvidence['lifetime']>['state'];

const capabilitySource = readFileSync(
  new URL('../capability-status.ts', import.meta.url),
  'utf8',
);

describe('IBL raw evidence lifetime owner', () => {
  it('projects the audit observation lifetime in both readback views', () => {
    expectTypeOf<ReadyReadbackLifetime>().toEqualTypeOf<ExpectedLifetime>();
    expectTypeOf<ExpectedLifetime>().toEqualTypeOf<ReadyReadbackLifetime>();
    expectTypeOf<RawEvidenceLifetime>().toEqualTypeOf<ExpectedLifetime>();
    expectTypeOf<ExpectedLifetime>().toEqualTypeOf<RawEvidenceLifetime>();
  });

  it('keeps the closed lifetime vocabulary and rejects an unknown state', () => {
    const acceptsLifetime = (lifetime: ExpectedLifetime): ExpectedLifetime => lifetime;
    acceptsLifetime('active');
    acceptsLifetime('retired');
    // @ts-expect-error Unknown attachment lifetimes are outside the audit owner.
    acceptsLifetime('expired');
  });

  it('removes the duplicated raw-evidence lifetime ledgers', () => {
    expect(capabilitySource).toContain("PipelineAuditObservation['lifetime']");
    expect(capabilitySource).not.toContain("state: 'active' | 'retired'");
  });
});
