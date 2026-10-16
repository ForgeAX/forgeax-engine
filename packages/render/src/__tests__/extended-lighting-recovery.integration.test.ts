import { describe, expect, it } from 'vitest';
import { createLightResourceUnavailable } from '../errors/render';
import type { ExtendedLightingResourceCandidate } from '../prepare/extended-lighting/resources';
import {
  createExtendedLightingState,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
  recordExtendedLightingFailure,
} from '../prepare/extended-lighting/state';

function candidate(generation: number, descriptorBytes: number): ExtendedLightingResourceCandidate {
  return {
    topology: 'extendedLighting',
    generation,
    scope: undefined as never,
    iesSliceCount: 1,
    cookieSliceCount: 1,
    cookieMatrices: 1,
    sampler: undefined as never,
    iesTexture: undefined,
    cookieTexture: undefined,
    cookieMatrixBuffer: undefined,
    descriptorBytes,
    uploadCount: 1,
  };
}

function failure(generation: number) {
  return createLightResourceUnavailable({
    entity: 3,
    feature: 'cookie',
    generation,
    sourceKey: 'parity/extended-lighting/recovery',
    reason: 'format',
    expected: 'rgba8unorm',
    actual: 'rgba16float',
    hint: 'retry the same source after renderer recovery',
  });
}

describe('extended-lighting recovery owner', () => {
  it('retains the accepted LKG while a replacement candidate fails', () => {
    const ready = promoteExtendedLightingCandidate(
      createExtendedLightingState(1),
      candidate(1, 128),
    );
    const degraded = recordExtendedLightingFailure(ready, failure(2));
    const inspection = projectExtendedLightingInspection(degraded);

    expect(inspection.generation).toBe(1);
    expect(inspection.accepted).toBe('extendedLighting:generation-1');
    expect(inspection.lastKnownGood).toBe('extendedLighting:generation-1');
    expect(inspection.failure).toBe('light-resource-unavailable');
  });

  it('publishes a replacement only after the new generation is complete', () => {
    const ready = promoteExtendedLightingCandidate(
      createExtendedLightingState(1),
      candidate(1, 128),
    );
    const replaced = promoteExtendedLightingCandidate(ready, candidate(2, 256));

    expect(replaced.generation).toBe(2);
    expect(replaced.accepted?.generation).toBe(2);
    expect(replaced.lastKnownGood?.generation).toBe(2);
    expect(replaced.descriptorBytes).toBe(256);
  });

  it('keeps resize-sized descriptor evidence bounded to the current accepted candidate', () => {
    const initial = promoteExtendedLightingCandidate(
      createExtendedLightingState(4),
      candidate(4, 160),
    );
    const resized = promoteExtendedLightingCandidate(initial, candidate(5, 320));

    expect(resized.generation).toBe(5);
    expect(resized.descriptorBytes).toBe(320);
    expect(resized.uploadCount).toBe(1);
    expect(resized.lastKnownGood?.generation).toBe(resized.generation);
  });
});
