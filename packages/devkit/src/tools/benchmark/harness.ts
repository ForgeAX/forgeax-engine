import {
  type AdmissionThresholds,
  BENCHMARK_MODES,
  BENCHMARK_PHASES,
  type BenchmarkAdmissionReport,
  type BenchmarkRecipe,
  type BenchmarkSample,
  createAdmissionReport,
  DEFAULT_ADMISSION_THRESHOLDS,
} from './report.js';

export type BenchmarkMeasurement = Pick<
  BenchmarkSample,
  'durationMs' | 'peakRssBytes' | 'cleanupPassed' | 'evictionPassed'
> &
  Partial<
    Pick<BenchmarkSample, 'exclusivePhasesMs' | 'rhiDebugOverheadMs' | 'carrierRendezvousMs'>
  >;

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
  const thresholds = options.thresholds ?? DEFAULT_ADMISSION_THRESHOLDS;
  const samples: BenchmarkSample[] = [];
  for (const phase of BENCHMARK_PHASES) {
    for (let index = 0; index < thresholds.sampleCountPerPhase; index += 1) {
      for (const mode of BENCHMARK_MODES) {
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
  return createAdmissionReport(options.recipe, samples, thresholds);
}
