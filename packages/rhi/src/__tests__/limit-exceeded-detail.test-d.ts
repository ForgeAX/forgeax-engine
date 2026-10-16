// feat-20260513-instanced-mesh M5 (T-M5-2): LimitExceededDetail field
// reshape — type-level assertions (vitest typecheck layer, *.test-d.ts).
//
// Companion to `limit-exceeded-detail.test.ts` (runtime). Vitest's
// typecheck pass (vitest 4.x default `typecheck.include === **/*.test-d.{ts,tsx}`)
// runs `expectTypeOf` here against the source LimitExceededDetail type;
// a legacy regression that re-introduces `renderableCount` / `limit`
// fields would flip these red.
//
// Plan rationale: requirements AC-15 (LimitExceededDetail field reshape
// evolution major) + plan-strategy D-3 (rename + replace, AGENTS.md
// Change stance — optimal > compatible).

import { describe, expectTypeOf, it } from 'vitest';
import type { LimitExceededDetail, RhiErrorDetail } from '../errors';

describe('feat-20260513-instanced-mesh T-M5-2 LimitExceededDetail (type-level)', () => {
  it('equals the new { maxStorageBufferBindingSize, requestedBytes } shape', () => {
    expectTypeOf<LimitExceededDetail>().toEqualTypeOf<{
      readonly maxStorageBufferBindingSize: number;
      readonly requestedBytes: number;
    }>();
  });

  it('is a member of the RhiErrorDetail discriminated union', () => {
    const detail: LimitExceededDetail = {
      maxStorageBufferBindingSize: 256,
      requestedBytes: 4096,
    };
    const widened: RhiErrorDetail = detail;
    expectTypeOf(widened).toMatchTypeOf<RhiErrorDetail>();
  });
});
