import { calculateSampleStatistics, type SampleStatistics } from './statistics.js';

export interface BenchmarkRecipe {
  readonly snapshotDigest: string;
  readonly backend: string;
  readonly viewport: readonly [number, number];
  readonly inputDigest: string;
  readonly frameCount: number;
  readonly rhiDebug: boolean;
  readonly profiler: boolean;
  readonly carrierRendezvous: boolean;
  readonly digest: string;
}

export interface BenchmarkSample {
  readonly mode: 'private' | 'service';
  readonly phase: 'cold' | 'warm';
  readonly durationMs: number;
  readonly peakRssBytes: number;
  readonly exclusivePhasesMs: Readonly<Record<string, number>>;
  readonly rhiDebugOverheadMs: number;
  readonly carrierRendezvousMs: number;
  readonly cleanupPassed: boolean;
  readonly evictionPassed: boolean;
  readonly recipeDigest: string;
}

export interface BenchmarkModeReport {
  readonly samples: number;
  readonly durationMs: SampleStatistics;
  readonly peakRssBytes: SampleStatistics;
  readonly cleanupPassed: boolean;
  readonly evictionPassed: boolean;
  readonly exclusivePhasesMs: Readonly<Record<string, SampleStatistics>>;
}

export interface AdmissionThresholds {
  readonly sampleCountPerPhase: number;
  readonly medianImprovement: number;
  readonly p95Improvement: number;
  readonly maxRegression: number;
  readonly peakRssMultiplier: number;
}

export const DEFAULT_ADMISSION_THRESHOLDS: AdmissionThresholds = {
  sampleCountPerPhase: 30,
  medianImprovement: 0.2,
  p95Improvement: 0.1,
  maxRegression: 0.1,
  peakRssMultiplier: 1.25,
};

export interface BenchmarkAdmissionReport {
  readonly schema: 'forgeax.tool-service-admission.v1';
  readonly recipe: BenchmarkRecipe;
  readonly thresholds: AdmissionThresholds;
  readonly order: readonly BenchmarkSample['mode'][];
  readonly private: BenchmarkModeReport;
  readonly service: BenchmarkModeReport;
  readonly valid: boolean;
  readonly admitted: boolean;
  readonly reasons: readonly string[];
}

export function summarizeBenchmarkSamples(
  samples: readonly BenchmarkSample[],
): BenchmarkModeReport {
  if (samples.length === 0) {
    return {
      samples: 0,
      durationMs: { count: 0, median: 0, p95: 0, max: 0 },
      peakRssBytes: { count: 0, median: 0, p95: 0, max: 0 },
      cleanupPassed: false,
      evictionPassed: false,
      exclusivePhasesMs: {},
    };
  }
  const durations = samples.map((sample) => sample.durationMs);
  const rss = samples.map((sample) => sample.peakRssBytes);
  const phaseNames = [
    ...new Set(samples.flatMap((sample) => Object.keys(sample.exclusivePhasesMs))),
  ];
  const exclusivePhasesMs = Object.fromEntries(
    phaseNames.map((phase) => [
      phase,
      calculateSampleStatistics(samples.map((sample) => sample.exclusivePhasesMs[phase] ?? 0)),
    ]),
  );
  return {
    samples: samples.length,
    durationMs: calculateSampleStatistics(durations),
    peakRssBytes: calculateSampleStatistics(rss),
    cleanupPassed: samples.every((sample) => sample.cleanupPassed),
    evictionPassed: samples.every((sample) => sample.evictionPassed),
    exclusivePhasesMs,
  };
}

export function createAdmissionReport(
  recipe: BenchmarkRecipe,
  samples: readonly BenchmarkSample[],
  thresholds: AdmissionThresholds = DEFAULT_ADMISSION_THRESHOLDS,
): BenchmarkAdmissionReport {
  const privateSamples = samples.filter((sample) => sample.mode === 'private');
  const serviceSamples = samples.filter((sample) => sample.mode === 'service');
  const order = samples.map((sample) => sample.mode);
  const privateReport = summarizeBenchmarkSamples(privateSamples);
  const serviceReport = summarizeBenchmarkSamples(serviceSamples);
  const reasons: string[] = [];
  const expectedSamples = thresholds.sampleCountPerPhase * 2;
  const complete =
    privateSamples.length === expectedSamples && serviceSamples.length === expectedSamples;
  if (!complete) {
    reasons.push('sample count is incomplete');
  }
  if (samples.some((sample) => sample.recipeDigest !== recipe.digest)) {
    reasons.push('recipe identity drifted');
  }
  if (!privateReport.cleanupPassed || !serviceReport.cleanupPassed) reasons.push('cleanup failed');
  if (!privateReport.evictionPassed || !serviceReport.evictionPassed)
    reasons.push('eviction failed');
  if (order.some((mode, index) => index > 0 && mode === order[index - 1])) {
    reasons.push('private and service samples were not alternated');
  }
  const medianLimit = privateReport.durationMs.median * (1 - thresholds.medianImprovement);
  const p95Limit = privateReport.durationMs.p95 * (1 - thresholds.p95Improvement);
  const maxLimit = privateReport.durationMs.max * (1 + thresholds.maxRegression);
  const rssLimit = privateReport.peakRssBytes.median * thresholds.peakRssMultiplier;
  if (complete && serviceReport.durationMs.median > medianLimit)
    reasons.push('median improvement threshold missed');
  if (complete && serviceReport.durationMs.p95 > p95Limit)
    reasons.push('p95 improvement threshold missed');
  if (complete && serviceReport.durationMs.max > maxLimit)
    reasons.push('max regression threshold exceeded');
  if (complete && serviceReport.peakRssBytes.median > rssLimit)
    reasons.push('peak RSS threshold exceeded');
  return {
    schema: 'forgeax.tool-service-admission.v1',
    recipe,
    thresholds,
    order,
    private: privateReport,
    service: serviceReport,
    valid:
      complete &&
      !reasons.some((reason) =>
        [
          'recipe identity drifted',
          'cleanup failed',
          'eviction failed',
          'private and service samples were not alternated',
        ].includes(reason),
      ),
    admitted: reasons.length === 0,
    reasons,
  };
}
