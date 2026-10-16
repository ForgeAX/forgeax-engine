// feat-20260709-editor-world-partition-editorworld-super-composite / M1 / w3
// (RED — impl lands in w6/w7). Contract test for the `role` field added to the
// `render-system-owner-out-of-range` structured error detail.
//
// Today the draw entry validates a SINGLE `owner` index and, on out-of-range,
// returns `RhiError { code: 'render-system-owner-out-of-range', detail: {
// owner, worldCount } }` (errors.ts validateDrawArgs). This feature splits the
// single owner into `cameraOwner` + `resourceOwner`, so a validation failure
// must say WHICH index was out of range. w7 extends the detail to
// `{ role: 'camera' | 'resource', owner, worldCount }`; w6 threads two indices
// through the draw entry and validates cameraOwner BEFORE resourceOwner.
//
// This test pins the future contract as the SSOT for w6/w7. The rhi package is
// World-free (it owns the RhiErrorCode closed union, architecture-principles §1
// SSOT) and cannot import the runtime Renderer — so, exactly like the existing
// draw-validation-errors.test.ts, the contract is exercised through the pure
// `validateDrawArgs` primitive rather than through `renderer.draw` itself. The
// future primitive shape is `validateDrawArgs(worldCount, { cameraOwner,
// resourceOwner })`. Until w6/w7 evolve the signature + detail, these calls are
// a type/shape mismatch and this file is RED (test-first).
//
// No new error code is added (D-3: 0 new error codes) — only `.detail` grows a
// `role` discriminator.
//
// Anchors:
//   requirements AC-08 (out-of-range/missing returns a structured error aligned
//     with the existing `render-system-owner-out-of-range` + `.detail`)
//   plan-strategy §3.3 interface example (err.detail === { role: 'resource',
//     owner: 3, worldCount: 2 }) + §2 D-3
//   research F2.3 (existing .detail = { owner, worldCount }; add role field)

import { describe, expect, it } from 'vitest';
import { validateDrawArgs } from '../errors';

// The role-carrying detail w7 will attach to the existing code. Declared
// locally so this test states the future contract independent of the
// (not-yet-updated) RhiOwnerOutOfRangeDetail export.
interface OwnerOutOfRangeRoleDetail {
  readonly role: 'camera' | 'resource';
  readonly owner: number;
  readonly worldCount: number;
}

describe('owner-out-of-range role detail (w3, AC-08)', () => {
  it("cameraOwner out of range -> code render-system-owner-out-of-range, detail.role === 'camera'", () => {
    // worldCount=2, cameraOwner=99 is out of range; resourceOwner=0 is valid.
    const r = validateDrawArgs(2, { cameraOwner: 99, resourceOwner: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-owner-out-of-range');
      const d = r.error.detail as OwnerOutOfRangeRoleDetail;
      expect(d.role).toBe('camera');
      expect(d.owner).toBe(99);
      expect(d.worldCount).toBe(2);
    }
  });

  it("resourceOwner out of range -> code render-system-owner-out-of-range, detail.role === 'resource'", () => {
    // worldCount=2, cameraOwner=0 is valid; resourceOwner=99 is out of range.
    const r = validateDrawArgs(2, { cameraOwner: 0, resourceOwner: 99 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-owner-out-of-range');
      const d = r.error.detail as OwnerOutOfRangeRoleDetail;
      expect(d.role).toBe('resource');
      expect(d.owner).toBe(99);
      expect(d.worldCount).toBe(2);
    }
  });

  it("both indices out of range -> reports the FIRST offender (camera), detail.role === 'camera'", () => {
    // Both out of range. D-3 / w6 orders the check cameraOwner-before-resource,
    // so the reported role is 'camera' (the first offender) with its own index.
    const r = validateDrawArgs(2, { cameraOwner: 7, resourceOwner: 8 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('render-system-owner-out-of-range');
      const d = r.error.detail as OwnerOutOfRangeRoleDetail;
      expect(d.role).toBe('camera');
      expect(d.owner).toBe(7);
      expect(d.worldCount).toBe(2);
    }
  });
});
