// @forgeax/engine-physics-rapier2d — loader for the pinned Rapier 2D bundle.
//
// Browser and native transports share the source-built WASM and generated ABI.

import { PhysicsError } from '@forgeax/engine-types';

/**
 * The RAPIER module namespace — all constructors, types, and helpers exposed
 * by the package-local Rapier WASM after init(). This is the shape of the default
 * export of the generated package-local module.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier compat namespace type
export type Rapier2DModule = any;

let loadingPromise: Promise<Rapier2DModule | PhysicsError> | null = null;

export function loadRapier2D(): Promise<Rapier2DModule | PhysicsError> {
  if (loadingPromise !== null) return loadingPromise;

  loadingPromise = _doLoad();
  return loadingPromise;
}

async function _doLoad(): Promise<Rapier2DModule | PhysicsError> {
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
      hint: `dynamic import or init() failed: ${reason}. Rebuild or restore packages/physics-rapier2d/pkg with the pinned Rapier producer.`,
      detail: { code: 'wasm-load-failed', reason },
    });
  }
}
