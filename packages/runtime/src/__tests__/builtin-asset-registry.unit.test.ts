// M6 w46 (AC-30): BuiltinAssetRegistry process-static resolution TDD.
//
// D-15 two-tier asset resolution: builtin payloads live in a process-static
// const keyed by fixed slot u32 (1..6), resolved without any World. Slots
// >= BUILTIN_BASE belong to the user tier (World.sharedRefs) and resolve to
// null here. R-13: module init order — importing BuiltinAssetRegistry then
// immediately resolving all 6 handles must not throw / return undefined.
// M6 w46 (AC-30): BuiltinAssetRegistry process-static resolution TDD.
//
// D-15 two-tier asset resolution: builtin payloads live in a process-static
// const keyed by fixed slot u32 (1..6), resolved without any World. Slots
// >= BUILTIN_BASE belong to the user tier (World.sharedRefs) and resolve to
// null here. R-13: module init order — importing BuiltinAssetRegistry then
// immediately resolving all 6 handles must not throw / return undefined.
import {
  BUILTIN_BASE,
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
  BuiltinAssetRegistry,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from '@forgeax/engine-assets-runtime';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('BuiltinAssetRegistry.resolve (AC-30)', () => {
  it('resolves each builtin slot 1..6 to its frozen payload', () => {
    expect(BuiltinAssetRegistry.resolve(HANDLE_CUBE)).toBe(BUILTIN_CUBE);
    expect(BuiltinAssetRegistry.resolve(HANDLE_TRIANGLE)).toBe(BUILTIN_TRIANGLE);
    expect(BuiltinAssetRegistry.resolve(HANDLE_QUAD)).toBe(BUILTIN_QUAD);
    expect(BuiltinAssetRegistry.resolve(HANDLE_SPHERE)).toBe(BUILTIN_SPHERE);
    expect(BuiltinAssetRegistry.resolve(HANDLE_NINESLICE_QUAD)).toBe(BUILTIN_NINESLICE_QUAD);
    expect(BuiltinAssetRegistry.resolve(HANDLE_CYLINDER)).toBe(BUILTIN_CYLINDER);
  });

  it('returns frozen payloads (Object.isFrozen)', () => {
    expect(Object.isFrozen(BUILTIN_CUBE)).toBe(true);
    expect(Object.isFrozen(BUILTIN_TRIANGLE)).toBe(true);
    expect(Object.isFrozen(BUILTIN_QUAD)).toBe(true);
    expect(Object.isFrozen(BUILTIN_SPHERE)).toBe(true);
    expect(Object.isFrozen(BUILTIN_NINESLICE_QUAD)).toBe(true);
    expect(Object.isFrozen(BUILTIN_CYLINDER)).toBe(true);
  });

  it('returns null for user-tier slots (slot >= BUILTIN_BASE)', () => {
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(BUILTIN_BASE))).toBeNull();
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(BUILTIN_BASE + 1))).toBeNull();
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(99999))).toBeNull();
  });

  it('returns null for slot 0 (no builtin reserves slot 0)', () => {
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(0))).toBeNull();
  });

  it('R-13: module-first-import probe resolves all 6 handles without throwing or undefined', () => {
    // Importing BuiltinAssetRegistry then resolving must observe fully
    // constructed frozen payloads — no init-order hazard (synchronous,
    // module-level, no side effect).
    for (const handle of [
      HANDLE_CUBE,
      HANDLE_TRIANGLE,
      HANDLE_QUAD,
      HANDLE_SPHERE,
      HANDLE_NINESLICE_QUAD,
      HANDLE_CYLINDER,
    ]) {
      const payload = BuiltinAssetRegistry.resolve(handle);
      expect(payload).not.toBeUndefined();
      expect(payload).not.toBeNull();
    }
  });
});

// bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu M2 / AC-02.
//
// Flat aabb layout is `Float32Array` of length 6 [minX, minY, minZ,
// maxX, maxY, maxZ] per `packages/types/src/index.ts:308` — the requirements
// wording "min/max both length-3 arrays with min[i] <= max[i]" reads as
// index [0..2] vs [3..5] within that flat array (no {min,max} object wrap).
describe('builtin payloads carry finite local-space AABBs (AC-02)', () => {
  it.each([
    ['HANDLE_CUBE', HANDLE_CUBE, BUILTIN_CUBE],
    ['HANDLE_TRIANGLE', HANDLE_TRIANGLE, BUILTIN_TRIANGLE],
    ['HANDLE_QUAD', HANDLE_QUAD, BUILTIN_QUAD],
    ['HANDLE_SPHERE', HANDLE_SPHERE, BUILTIN_SPHERE],
    ['HANDLE_NINESLICE_QUAD', HANDLE_NINESLICE_QUAD, BUILTIN_NINESLICE_QUAD],
    ['HANDLE_CYLINDER', HANDLE_CYLINDER, BUILTIN_CYLINDER],
  ])('%s exposes the same valid local AABB through registry and export', (_name, handle, exportedConst) => {
    const payload = BuiltinAssetRegistry.resolve(handle);
    expect(payload).not.toBeNull();
    expect(payload).toBe(exportedConst);
    const aabb = payload?.aabb;
    expect(aabb).toBeInstanceOf(Float32Array);
    expect(aabb).toHaveLength(6);
    if (aabb === undefined) return;
    for (let axis = 0; axis < 3; axis++) {
      const minV = aabb[axis];
      const maxV = aabb[axis + 3];
      expect(Number.isFinite(minV)).toBe(true);
      expect(Number.isFinite(maxV)).toBe(true);
      expect(minV as number).toBeLessThanOrEqual(maxV as number);
    }
  });
});
