// These states retain all native/reference pixels. Camera uniforms use
// the already-replayed layout; bit31 equals the retained shadow layer picture,
const deferredCoreReplays = new Set(['camera-moved', 'shadow-layer-bit31']);

/** New states remain admitted; full validation replays every immutable capture. */
export function shouldReplayAuthoredShadow(name: string, coreValidation = false) {
  return !coreValidation || !deferredCoreReplays.has(name);
}
