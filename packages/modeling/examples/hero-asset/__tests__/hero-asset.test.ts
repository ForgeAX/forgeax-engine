// Invariants of the blaster fixture that the one-source outputs (outputs.ts, deliverAsset) depend on: every claimed
// part is a valid solid, and the one named refusal is recorded as data rather than hidden.
import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/brep/validate.ts';
import { buildBlaster } from '../../../src/__tests__/fixtures/hero-blaster.ts';

describe('exact model', () => {
  const b = buildBlaster();
  it('builds every claimed part as a valid solid', () => {
    expect(b.parts.length).toBeGreaterThanOrEqual(11);
    for (const p of b.parts) expect(validate(p.shape).ok, p.name).toBe(true);
  });
  it('records the named refusals instead of hiding them', () => {
    // Trunk 844ec84f: R1 (single loft slot) still refuses; M0 (two holed-face booleans) now succeeds
    // and is no longer a refusal. Pinned to the current trunk; a change here must be deliberate.
    const refused = b.steps.filter((s) => !s.ok).map((s) => s.id);
    expect(refused).toEqual(['R1']);
  });
});
