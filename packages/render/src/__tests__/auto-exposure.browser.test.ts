import { describe, expect, it } from 'vitest';
import {
  AUTO_EXPOSURE_GPU_EXPECTED_CANDIDATE,
  AUTO_EXPOSURE_GPU_ORACLE_HISTOGRAM,
  AUTO_EXPOSURE_GPU_RESOLUTION,
  runAutoExposureGpuEvidence,
} from './auto-exposure-gpu-evidence';

describe('auto exposure real Browser WebGPU fixture', () => {
  it('records backend, resolution, raw readback, and the fused meter graph', async () => {
    const evidence = await runAutoExposureGpuEvidence('browser-vitest');
    expect(evidence.fixtureId).toBe('auto-exposure-uniform-outlier-v1');
    expect(evidence.runner).toBe('browser-vitest');
    expect(evidence.resolution).toEqual(AUTO_EXPOSURE_GPU_RESOLUTION);
    expect(evidence.backend).toBe('webgpu');
    expect(evidence.status).toBe('available');
    expect(evidence.graph.physicalPass).toBe('auto-exposure-meter');
    expect(evidence.graph.physicalPassCount).toBe(1);
    expect(evidence.graph.passes).toEqual([
      'auto-exposure-clear',
      'auto-exposure-histogram',
      'auto-exposure-adapt',
    ]);
    expect(evidence.stateReadback).toHaveLength(32);
    expect(evidence.candidateValues).toHaveLength(4);
    expect(Number.isFinite(evidence.candidateValues[0])).toBe(true);
    expect(evidence.candidateValues[0]).toBeGreaterThan(0);
    expect(evidence.candidateValues[0]).toBeCloseTo(AUTO_EXPOSURE_GPU_EXPECTED_CANDIDATE, 6);
    expect(evidence.candidateValues.slice(1)).toEqual([1, 1, 1]);
    expect(evidence.readback).toHaveLength(16);
    expect(evidence.histogramReadback).toEqual(AUTO_EXPOSURE_GPU_ORACLE_HISTOGRAM);
  });
});
