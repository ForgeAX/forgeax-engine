import {
  type AdmissionThresholds,
  type BenchmarkAdmissionReport,
  type BenchmarkRecipe,
  type BenchmarkSample,
  createAdmissionReport,
} from './report.js';

export interface BenchmarkMeasurement {
  readonly durationMs: number;
  readonly peakRssBytes: number;
  readonly exclusivePhasesMs?: Readonly<Record<string, number>>;
  readonly rhiDebugOverheadMs?: number;
  readonly carrierRendezvousMs?: number;
  readonly cleanupPassed: boolean;
  readonly evictionPassed: boolean;
}

export interface BenchmarkHarnessOptions {
  readonly recipe: BenchmarkRecipe;
  readonly measure: (
    mode: BenchmarkSample['mode'],
    phase: BenchmarkSample['phase'],
    index: number,
  ) => Promise<BenchmarkMeasurement> | BenchmarkMeasurement;
  readonly thresholds?: AdmissionThresholds;
}

export async function runBenchmarkAdmission(
  options: BenchmarkHarnessOptions,
): Promise<BenchmarkAdmissionReport> {
  const sampleCount = options.thresholds?.sampleCountPerPhase ?? 30;
  const samples: BenchmarkSample[] = [];
  const phases = ['cold', 'warm'] as const satisfies readonly BenchmarkSample['phase'][];
  const modes = ['private', 'service'] as const satisfies readonly BenchmarkSample['mode'][];
  for (const phase of phases) {
    for (let index = 0; index < sampleCount; index += 1) {
      for (const mode of modes) {
        const measurement = await options.measure(mode, phase, index);
        samples.push({
          mode,
          phase,
          durationMs: measurement.durationMs,
          peakRssBytes: measurement.peakRssBytes,
          exclusivePhasesMs: measurement.exclusivePhasesMs ?? {},
          rhiDebugOverheadMs: measurement.rhiDebugOverheadMs ?? 0,
          carrierRendezvousMs: measurement.carrierRendezvousMs ?? 0,
          cleanupPassed: measurement.cleanupPassed,
          evictionPassed: measurement.evictionPassed,
          recipeDigest: options.recipe.digest,
        });
      }
    }
  }
  return createAdmissionReport(options.recipe, samples, options.thresholds);
}
