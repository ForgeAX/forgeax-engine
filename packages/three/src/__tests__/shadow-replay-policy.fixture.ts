// These states retain all native/reference pixels. Camera/target uniforms use
// the already-replayed layout; bit31 equals the retained shadow layer picture,
// and variance receiver-casts equals the retained variance picture.
const deferredCoreReplays = new Set([
  'camera-moved',
  'target',
  'shadow-layer-bit31',
  'variance-receiver-casts',
]);

/** New states remain admitted; full validation replays every immutable capture. */
export function shouldReplayAuthoredShadow(name: string, coreValidation = false) {
  return !coreValidation || !deferredCoreReplays.has(name);
}
