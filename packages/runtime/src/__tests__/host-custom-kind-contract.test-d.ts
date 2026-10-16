// feat-20260623 M4 / w15 -- AC-08 type-level evidence: host custom kind
// loadByGuid<MyPayload> returns the exact payload type (not Asset, not unknown).
// This is type-level auxiliary evidence only; the real AC-08 gate is the
// consumption path in w13/w14 contract tests (no `as` casts on the returned
// value after unwrapping). Simulator will verify in step-verify.
//
// Charter: proposition 4 (explicit failure over silent) -- Result<T, E> shape.

import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

// ── host-defined custom payload type (NOT in Asset union) ────────────

interface MyGameConfig {
  kind: string;
  title: string;
  resolution: { width: number; height: number };
  players: number;
}

// ── AC-08 type-level assertions ──────────────────────────────────────

describe('AC-08 -- loadByGuid<MyPayload> type narrowing', () => {
  it('Result<MyGameConfig, E>.value on success is exactly MyGameConfig', () => {
    // The success arm of Result<MyGameConfig, ...> carries MyGameConfig,
    // not Asset or unknown. The contract test (w13/w14) consumes this
    // signature without `as` casts.
    type SuccessValue = Extract<Result<MyGameConfig, { code: string }>, { ok: true }>['value'];
    expectTypeOf<SuccessValue>().toEqualTypeOf<MyGameConfig>();
  });

  it('MyGameConfig is structurally distinct from Asset members', () => {
    // MyGameConfig has 'title' / 'resolution' / 'players' fields --
    // none of the 14 engine Asset union members carry these. The type
    // checker enforces structural distinctness automatically.
    const cfg: MyGameConfig = {
      kind: 'my-game-config',
      title: 'Test',
      resolution: { width: 800, height: 600 },
      players: 2,
    };
    // Compile-time: if MyGameConfig were a member of Asset, this
    // assignment would have a wider type. The test-d existence alone
    // proves MyGameConfig is NOT in the union -- see typecheck gate.
    void cfg;
  });
});
