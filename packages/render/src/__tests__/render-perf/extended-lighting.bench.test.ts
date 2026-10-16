import { describe, expect, it } from 'vitest';
import { PROBE_MAX_CONTRIBUTORS, ProbeBlendSceneProjection } from '../../scene/probe-blend';

const OBJECT_COUNT = 8;
const PROBE_COUNT = PROBE_MAX_CONTRIBUTORS;
const SAMPLE_COUNT = 5;

function summarize(samplesMs: readonly number[]) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return {
    status: samplesMs.length === 0 ? 'not-run' : 'complete',
    workload: 'probe-blend-8-objects-64-admitted',
    sampleCount: samplesMs.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    recordByteLength: 160,
    contributorCapacity: 64,
  } as const;
}

function makeProbe(index: number) {
  return {
    identity: `m6-probe-${index}`,
    position: [0, 0, 0] as const,
    radius: 4,
    irradiance: new Float32Array(27).fill(1),
    admitted: true,
  };
}

describe('M6 extended-lighting CPU performance carrier', () => {
  it('measures all admitted contributors without a per-object top-K selection', () => {
    const projection = new ProbeBlendSceneProjection();
    const probes = Array.from({ length: PROBE_COUNT }, (_, index) => makeProbe(index));
    const objects = Array.from({ length: OBJECT_COUNT }, (_, objectKey) => ({
      objectKey,
      generation: 0,
      position: [0, 0, 0] as const,
    }));
    const samples: number[] = [];
    let sink = 0;

    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const start = performance.now();
      const result = projection.apply({
        objects: objects.map((object) => ({ ...object, generation: sample })),
        probes,
        skyIrradiance: [0.1, 0.2, 0.3],
      });
      samples.push(performance.now() - start);
      expect(result.error).toBeUndefined();
      expect(result.admittedProbeCount).toBe(PROBE_COUNT);
      expect(result.records).toHaveLength(OBJECT_COUNT);
      sink += result.records.reduce((sum, record) => sum + record.byteLength, 0);
    }

    const receipt = summarize(samples);
    // biome-ignore lint/suspicious/noConsole: benchmark emits host evidence for the carrier receipt
    console.info(JSON.stringify({ ...receipt, sink, host: process.platform }));
    expect(sink).toBe(OBJECT_COUNT * SAMPLE_COUNT * 160);
    expect(receipt.status).toBe('complete');
    expect(receipt.sampleCount).toBe(SAMPLE_COUNT);
    expect(Number.isFinite(receipt.medianMs)).toBe(true);
    expect(Number.isFinite(receipt.p95Ms)).toBe(true);
  }, 60_000);
});
