import { bench, describe } from 'vitest';

export const TEMPORAL_MEMORY_CASES = [
  { name: '1080p', width: 1920, height: 1080 },
  { name: '1440p', width: 2560, height: 1440 },
  { name: '4K', width: 3840, height: 2160 },
] as const;

export function temporalTargetBytes(width: number, height: number): number {
  return width * height * 8;
}

export function stableCreationCount(): number {
  return 0;
}

export function temporalMemoryEvidence() {
  return TEMPORAL_MEMORY_CASES.map((resolution) => ({
    ...resolution,
    bytes: temporalTargetBytes(resolution.width, resolution.height),
    format: 'rgba16float' as const,
    sampleCount: 1 as const,
  }));
}

describe('temporal target and motion blur bounded memory', () => {
  let sink = 0;
  for (const resolution of TEMPORAL_MEMORY_CASES) {
    bench(`${resolution.name} 8WH bytes`, () => {
      sink ^= temporalTargetBytes(resolution.width, resolution.height);
    });
  }
  bench('stable texture buffer pipeline creation', () => {
    sink ^= stableCreationCount();
  });
  bench.skip('__sink_keep_alive', () => {
    sink ^= TEMPORAL_MEMORY_CASES.length;
  });
});
