/** One-shot test fault bound to the device generation that armed it. */
export interface GtaoCandidatePreparationFaultState {
  gtaoCandidatePreparationFailureGeneration?: number | undefined;
}

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
  const ssao =
    passNames.includes('ssao-calc') &&
    passNames.some((name) => name.startsWith('ssao-furthest-hzb-seed'));
  const gtao =
    passNames.includes('gtao-resolve') &&
    (passNames.includes('gtao-calc') || passNames.includes('gtao-calc-compute'));
  if (!ssao && !gtao) return false;
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
