// @forgeax/engine-physics-rapier3d — WASM loader for Rapier 3D compat variant.
//
// Package-local Rapier module rebuilt from pinned upstream source and patches.
//
// Usage:
//   const rapier = await loadRapier3D();
//   if ('code' in rapier) { /* handle PhysicsError */ }
//   const world = new rapier.World({ x: 0, y: -9.81, z: 0 });

import { PhysicsError } from '@forgeax/engine-types';

/**
 * The RAPIER module namespace — all constructors, types, and helpers exposed
 * by the pinned, locally rebuilt Rapier bindings after init().
 */
// biome-ignore lint/suspicious/noExplicitAny: existing Rapier backend injection boundary
export type Rapier3DModule = any;

/** Loading promise — ensures concurrent callers share one init. */
let loadingPromise: Promise<Rapier3DModule | PhysicsError> | null = null;

// A function returning i32x4.splat(0). Probe the actual WASM runtime rather
// than assuming that a browser, device family, or native Host supports SIMD.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 17,
  11,
]);

function supportsSimd(): boolean {
  try {
    return typeof WebAssembly !== 'undefined' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/**
 * Load the Rapier 3D WASM module and initialise it.
 *
 * Dynamically imports the package-local bundle, which includes its WASM bytes.
 * No network request or runtime source patching is required.
 *
 * Concurrent callers share a single loading promise; after the first
 * successful load the same settled promise is reused.
 *
 * @returns the RAPIER module namespace on success, or a PhysicsError with
 *          code 'wasm-load-failed' if dynamic import or init() rejects.
 */
export function loadRapier3D(): Promise<Rapier3DModule | PhysicsError> {
  if (loadingPromise !== null) return loadingPromise;

  loadingPromise = _doLoad();
  return loadingPromise;
}

async function _doLoad(): Promise<Rapier3DModule | PhysicsError> {
  try {
    const RAPIER = supportsSimd()
      ? await import('../pkg/rapier-simd.mjs')
      : await import('../pkg/rapier.mjs');
    await RAPIER.default.init();
    return RAPIER.default;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    loadingPromise = null;
    return new PhysicsError({
      code: 'wasm-load-failed',
      expected: 'successful dynamic import and init of the package-local Rapier WASM',
      hint: `dynamic import or init() failed: ${reason}. Rebuild or restore packages/physics-rapier3d/pkg with build:wasm.`,
      detail: { code: 'wasm-load-failed', reason },
    });
  }
}
