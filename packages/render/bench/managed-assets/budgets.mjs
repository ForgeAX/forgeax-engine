/** Frozen before candidate timing; absolute values announced before baseline diagnostics. */
export const budgets = Object.freeze({
  targetHz: 60,
  assetP95Ms: 2,
  denseAssetP95Ms: 8,
  structuralAssetP95Ms: 50,
  commitToAckP95Ms: 50,
  commitToAckP99Ms: 100,
  gpuDescriptorPeakBytes: 512 * 1024 * 1024,
  heapAndBackingPeakBytes: 2 * 1024 * 1024 * 1024,
  oracleMinimumDifference: 8,
  settledPixelMaxDifference: 2,
  settledPixelMeanDifference: 0.01,
  noiseRule: 'maximum absolute difference between matching same-version A/A window summaries across three pairs',
  stableDifferenceRule: 'median paired candidate-minus-baseline difference exceeds the frozen A/A radius; report each paired difference',
});

export function assetBudget(config) {
  if (['texture-resize', 'mesh-topology', 'lifecycle'].includes(config.kind)) return budgets.structuralAssetP95Ms;
  if ((config.kind === 'mesh' && config.changed === config.vertices) || (config.kind === 'texture' && config.region === config.extent)) return budgets.denseAssetP95Ms;
  return budgets.assetP95Ms;
}
