// feat-20260708-composited-multi-world-rendering M3 / m3-t1 — AC-10 two new
// RhiErrorCode members + the pure draw-args validation helper.
//
// Plan-strategy 2 D-5: renderer.draw(worlds, { cameraOwner, resourceOwner }) validates its inputs at
// the entry (before any extract) and returns Result.err on:
//   - empty worlds array        -> 'render-system-empty-worlds'
//   - owner index out of range  -> 'render-system-owner-out-of-range'
//                                  (.detail = { owner, worldCount })
//
// The two codes are NOT mutually exclusive: an empty array with an out-of-range
// owner surfaces the empty-worlds code first (entry check short-circuits before
// the owner-range check). requirements AC-10: illegal input is a structured,
// property-accessible failure (.code / .hint / .detail) — never silent.
//
// Why the validation lives in @forgeax/engine-rhi (World-free primitives, not
// @forgeax/engine-runtime): rhi owns the RhiErrorCode closed union (SSOT), and
// this package depends only on @forgeax/engine-types — it cannot import the
// runtime Renderer. `validateDrawArgs(worldCount, owner)` takes plain numbers
// (no World, no math), so it belongs with the codes it emits; createRenderer's
// draw entry calls it (D-5 "validate at the draw entry"). This keeps the code
// + validation + test in one package (architecture-principles §1 SSOT + §3
// Schema as Contract: the validator is the machine-checkable contract).
//
// AC-01 single path: only the explicit camera/resource owner form exists; there
// is no draw(world) overload. AC-02's owner-required compile-time narrowing is
// verified at the real hello-triangle callsite (m3-t2), not here.

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  RhiError,
  type RhiErrorCode,
  type RhiErrorDetail,
  type RhiOwnerOutOfRangeDetail,
  validateDrawArgs,
} from '../errors';

describe('M3 / m3-t1 — two new RhiErrorCode members', () => {
  it("contains 'render-system-empty-worlds' in the closed RhiErrorCode union", () => {
    expectTypeOf<'render-system-empty-worlds'>().toMatchTypeOf<RhiErrorCode>();
  });

  it("contains 'render-system-owner-out-of-range' in the closed RhiErrorCode union", () => {
    expectTypeOf<'render-system-owner-out-of-range'>().toMatchTypeOf<RhiErrorCode>();
  });

  it('the two new members are distinct from each other', () => {
    type Empty = Extract<RhiErrorCode, 'render-system-empty-worlds'>;
    type Oob = Extract<RhiErrorCode, 'render-system-owner-out-of-range'>;
    expectTypeOf<Empty>().not.toEqualTypeOf<Oob>();
  });

  it('exhaustive switch reaches both new members without a default arm', () => {
    // A narrow switch over just the two new members: tsc proves both literals
    // are members of the union (otherwise the case labels would not compile);
    // the runtime assertion proves the mapping is reachable.
    function describeNew(
      code: 'render-system-empty-worlds' | 'render-system-owner-out-of-range',
    ): string {
      switch (code) {
        case 'render-system-empty-worlds':
          return 'empty';
        case 'render-system-owner-out-of-range':
          return 'oob';
      }
    }
    expect(describeNew('render-system-empty-worlds')).toBe('empty');
    expect(describeNew('render-system-owner-out-of-range')).toBe('oob');
  });
});

describe('M3 / m3-t1 — RhiOwnerOutOfRangeDetail shape', () => {
  // feat-20260709-editor-world-partition M1 / w7: the detail grew a `role`
  // discriminator when the single draw owner was split into cameraOwner +
  // resourceOwner (plan-strategy §2 D-3; new SSOT contract in
  // owner-out-of-range-role.test.ts). This precursor shape assertion is
  // migrated to the two-index form — no new error code, only `.detail` grows.
  it('detail equals { role, owner: number, worldCount: number }', () => {
    expectTypeOf<RhiOwnerOutOfRangeDetail>().toEqualTypeOf<{
      readonly role: 'camera' | 'resource';
      readonly owner: number;
      readonly worldCount: number;
    }>();
  });

  it('detail is a member of the RhiErrorDetail discriminated union', () => {
    const detail: RhiOwnerOutOfRangeDetail = { role: 'resource', owner: 2, worldCount: 1 };
    const widened: RhiErrorDetail = detail;
    expectTypeOf(widened).toMatchTypeOf<RhiErrorDetail>();
  });
});

describe('M3 / m3-t1 — validateDrawArgs (D-5 draw entry validation)', () => {
  it('empty worlds -> err render-system-empty-worlds with a non-empty hint', () => {
    const r = validateDrawArgs(0, { cameraOwner: 0, resourceOwner: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-empty-worlds');
      expect(r.error.hint.length).toBeGreaterThan(0);
      // AI users recover from the hint text (charter P3 actionable hint).
      expect(r.error.hint).toContain('at least one world');
      // empty-worlds carries no detail (the failure is fully described by .code).
      expect(r.error.detail).toBeUndefined();
    }
  });

  it('owner out of range (owner >= worldCount) -> err with detail { owner, worldCount }', () => {
    const r = validateDrawArgs(1, { cameraOwner: 1, resourceOwner: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-owner-out-of-range');
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.hint).toContain('0..worlds.length-1');
      // .detail is reachable via property access after narrowing on .code.
      const d = r.error.detail as RhiOwnerOutOfRangeDetail;
      expect(d.owner).toBe(1);
      expect(d.worldCount).toBe(1);
    }
  });

  it('owner out of range (owner < 0) -> err render-system-owner-out-of-range', () => {
    const r = validateDrawArgs(2, { cameraOwner: -1, resourceOwner: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-owner-out-of-range');
      const d = r.error.detail as RhiOwnerOutOfRangeDetail;
      expect(d.owner).toBe(-1);
      expect(d.worldCount).toBe(2);
    }
  });

  it('two codes are non-exclusive: empty array + out-of-range owner short-circuits to empty-worlds', () => {
    // Entry check order: the empty-worlds guard runs first, so an empty array
    // with a nonsense owner (5) never reaches the owner-range branch (D-5).
    const r = validateDrawArgs(0, { cameraOwner: 5, resourceOwner: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-empty-worlds');
    }
  });

  it('valid args (owner within [0, worldCount)) -> ok', () => {
    expect(validateDrawArgs(1, { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(validateDrawArgs(3, { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(validateDrawArgs(3, { cameraOwner: 2, resourceOwner: 2 }).ok).toBe(true);
  });

  it('returned errors are RhiError instances (structured, not thrown strings)', () => {
    const r = validateDrawArgs(1, { cameraOwner: 9, resourceOwner: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RhiError);
      expect(r.error.expected.length).toBeGreaterThan(0);
    }
  });
});
