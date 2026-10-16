export type SsrInterval = {
  passName?: string;
  beginning: bigint;
  end: bigint;
};

export type SsrIntervalSummary = {
  measuredPassCount: number;
  sumTicks: string;
  unionTicks: string;
  outerSpanTicks: string;
  duplicatedTicks: string;
  overlapPairCount: number;
  longestOverlaps: Array<{
    left: string | undefined;
    right: string | undefined;
    overlapTicks: string;
  }>;
};

export declare function summarizeIntervalSet(
  intervals: readonly SsrInterval[],
): SsrIntervalSummary;

export declare function percentile(values: readonly number[], fraction: number): number | null;
export declare function projectTimingFrame(frame: import('@forgeax/engine-render').GpuPassTimingFrame): {
  status: 'complete' | 'partial' | 'failed';
  coverage?: Record<string, import('@forgeax/engine-render/internal').GpuPassTimingIntervalSummary>;
  reason?: unknown;
};
export declare function summarizeSamples(samplesMs: readonly number[]): {
  samplesMs: readonly number[]; sampleCount: number; p50Ms: number | null; p95Ms: number | null;
};

export declare function summarizePerformanceWindow(report: unknown, start?: number, count?: number): {
  complete: boolean;
  cpuSubmission: ReturnType<typeof summarizeSamples>;
  completionWait: ReturnType<typeof summarizeSamples>;
  endToEnd: ReturnType<typeof summarizeSamples>;
  gpuEnvelope: ReturnType<typeof summarizeSamples>;
  gpuUnion: ReturnType<typeof summarizeSamples>;
  ssrSumDiagnostic: ReturnType<typeof summarizeSamples>;
};
export declare function abbaIncrement(windows: readonly Record<string, ReturnType<typeof summarizeSamples>>[], key: string): {
  p50Ms: number; p95Ms: number;
  pairedOrdinalDeltas: ReturnType<typeof summarizeSamples>;
} | null;
