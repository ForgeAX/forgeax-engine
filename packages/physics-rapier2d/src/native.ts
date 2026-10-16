import type { PhysicsWasmHost } from '@forgeax/engine-physics';
import { PhysicsError } from '@forgeax/engine-types';
import type { Rapier2DModule } from './wasm-browser.js';

let ready: Promise<Rapier2DModule | PhysicsError> | undefined;
const failure = (cause: unknown) =>
  new PhysicsError({
    code: 'wasm-load-failed',
    expected: 'the exact native Rapier 2D module initialized by the Host',
    hint: 'Initialize the published native physics WASM before activating the physics plugin.',
    detail: {
      code: 'wasm-load-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });

export function initializeNativeRapier2D(
  host: PhysicsWasmHost,
): Promise<Rapier2DModule | PhysicsError> {
  ready ??= import('../pkg/rapier-native.mjs')
    .then((binding) => binding.initialize(host))
    .catch((cause) => {
      ready = undefined;
      return failure(cause);
    });
  return ready;
}

/** Selected by the explicit forgeax-native build condition. */
export async function loadRapier2D(): Promise<Rapier2DModule | PhysicsError> {
  return ready ?? failure('Native physics Host has not initialized its WASM');
}
