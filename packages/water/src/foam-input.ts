/** Independent accepted graph inputs, never a three-way source selector. */
export interface WaterFoamMaterialInput {
  readonly sourceGeneration: number;
  readonly staticTexture?: Readonly<{ guid: string; version: number }>;
  readonly staticNormalTexture?: Readonly<{ guid: string; version: number }>;
  readonly volumeNoiseTexture?: Readonly<{ guid: string; version: number }>;
  readonly fluidRt?: Readonly<{ targetKey: string; simulationGeneration: number }>;
  readonly bakedRef?: Readonly<{ guid: string; assetGeneration: number }>;
  readonly materialSwitches: Readonly<{
    waterOceanFoam: boolean;
    fluidSimulationFoam: boolean;
    waterBakedSimulation: boolean;
  }>;
}

/** Disabling one producer only retires its binding. BeachFoam keeps its static
 * maps and the renderer's separate no-simulation semantic FoamRT input. */
export function activeWaterFoamMaterialInput(
  input: WaterFoamMaterialInput,
): WaterFoamMaterialInput {
  const { fluidRt, bakedRef, ...base } = input;
  return Object.freeze({
    ...base,
    ...(input.materialSwitches.fluidSimulationFoam && fluidRt ? { fluidRt } : {}),
    ...(input.materialSwitches.waterBakedSimulation && bakedRef ? { bakedRef } : {}),
  });
}
