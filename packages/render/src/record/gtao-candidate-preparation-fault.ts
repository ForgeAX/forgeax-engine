/** One-shot test fault bound to the device generation that armed it. */
export interface GtaoCandidatePreparationFaultState {
  gtaoCandidatePreparationFailureGeneration?: number | undefined;
}

const AO_CALC_PASSES = new Set(['ssao-calc', 'gtao-calc-compute']);

export function armGtaoCandidatePreparationFault(
  state: GtaoCandidatePreparationFaultState,
  deviceGeneration: number,
): void {
  state.gtaoCandidatePreparationFailureGeneration = deviceGeneration;
}

export function clearGtaoCandidatePreparationFault(
  state: GtaoCandidatePreparationFaultState,
): void {
  state.gtaoCandidatePreparationFailureGeneration = undefined;
}

/**
 * Consume only after a compiled candidate actually contains the complete AO
 * calculation and filter chain. Non-AO graph preparation leaves the one-shot
 * armed; a device-generation change discards it instead of carrying it over.
 */
export function consumeGtaoCandidatePreparationFault(
  state: GtaoCandidatePreparationFaultState,
  deviceGeneration: number,
  passNames: readonly string[],
): boolean {
  const armedGeneration = state.gtaoCandidatePreparationFailureGeneration;
  if (armedGeneration === undefined) return false;
  if (armedGeneration !== deviceGeneration) {
    clearGtaoCandidatePreparationFault(state);
    return false;
  }
  if (!passNames.some((name) => AO_CALC_PASSES.has(name)) || !passNames.includes('ssao-blur')) {
    return false;
  }
  clearGtaoCandidatePreparationFault(state);
  return true;
}

/** Expire an armed fault when its owning device generation has retired. */
export function clearStaleGtaoCandidatePreparationFault(
  state: GtaoCandidatePreparationFaultState,
  deviceGeneration: number,
): void {
  if (
    state.gtaoCandidatePreparationFailureGeneration !== undefined &&
    state.gtaoCandidatePreparationFailureGeneration !== deviceGeneration
  )
    clearGtaoCandidatePreparationFault(state);
}
