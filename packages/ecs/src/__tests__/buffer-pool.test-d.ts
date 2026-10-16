// Compile-time type assertions for BufferPool.release (w6 + AC-13).
//
// Locks BufferPool.prototype.release return type to Result<void, never>:
// the slot id never escapes ECS internals, no generation tag, no stale-slot
// error arm. Any future PR adding a generation-tag error arm (e.g.
// Result<void, BufferPoolStaleSlotError>) breaks this file at compile time
// and blocks the PR (plan-strategy §4 R-spec-5.1 dual-enforce; OOS-3 guard).
//
// Spec: docs/specs/2026-06-14-ecs-managed-lifecycle-ssot-design.md §3.3
// "Managed handles are operational, not persistent" — BufferPool sub-section.
//
// This file is the type-layer half of the dual-enforce; packages/ecs/README.md
// §"Managed handles are operational, not persistent" (w8) is the documentation
// half. Both must ship together.

import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { BufferPool } from '../buffer-pool';

describe('BufferPool.release — type contract (w6)', () => {
  it('release returns Result<void, never> — no error arm; OOS-3 guard', () => {
    type ReleaseFn = BufferPool['release'];
    type ReleaseReturn = ReturnType<ReleaseFn>;
    expectTypeOf<ReleaseReturn>().toEqualTypeOf<Result<void, never>>();
  });

  it('release accepts a number id (slot id never escapes — no Handle<Buffer> public surface)', () => {
    type ReleaseFn = BufferPool['release'];
    type ReleaseParams = Parameters<ReleaseFn>;
    expectTypeOf<ReleaseParams>().toEqualTypeOf<[id: number]>();
  });
});
