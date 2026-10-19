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
    const RAPIER = await import('../pkg/rapier.mjs');
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
