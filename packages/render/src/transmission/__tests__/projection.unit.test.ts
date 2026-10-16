import { describe, expect, it } from 'vitest';
import {
  PersistentTransmissionDemandProjection,
  type TransmissionDemandCandidate,
} from '../projection';

function candidate(
  transmission: number,
  roughness: number,
  overrides: Partial<TransmissionDemandCandidate> = {},
): TransmissionDemandCandidate {
  return {
    attached: true,
    ready: true,
    transmission,
    roughness,
    ...overrides,
  };
}

describe('persistent transmission demand projection', () => {
  it('publishes only activeCount and needsRoughMips', () => {
    const projection = new PersistentTransmissionDemandProjection();

    expect(projection.inspect()).toEqual({ activeCount: 0, needsRoughMips: false });
  });

  it('counts only attached, ready materials with positive transmission', () => {
    const projection = new PersistentTransmissionDemandProjection();

    projection.apply([
      { kind: 'upsert', key: 'smooth', candidate: candidate(0.5, 0) },
      { kind: 'upsert', key: 'zero', candidate: candidate(0, 0.8) },
      { kind: 'upsert', key: 'detached', candidate: candidate(0.8, 0.8, { attached: false }) },
      { kind: 'upsert', key: 'unready', candidate: candidate(0.8, 0.8, { ready: false }) },
    ]);

    expect(projection.inspect()).toEqual({ activeCount: 1, needsRoughMips: false });
  });

  it('conservatively requests one shared rough mip chain for active rough transmission', () => {
    const projection = new PersistentTransmissionDemandProjection();

    projection.apply([{ kind: 'upsert', key: 'rough', candidate: candidate(0.8, 0.35) }]);

    expect(projection.inspect()).toEqual({ activeCount: 1, needsRoughMips: true });
  });

  it('returns exact zero after the final active material is detached or removed', () => {
    const projection = new PersistentTransmissionDemandProjection();
    projection.apply([{ kind: 'upsert', key: 'only', candidate: candidate(1, 0.5) }]);

    projection.apply([
      { kind: 'upsert', key: 'only', candidate: candidate(1, 0.5, { attached: false }) },
    ]);
    expect(projection.inspect()).toEqual({ activeCount: 0, needsRoughMips: false });

    projection.apply([{ kind: 'remove', key: 'only' }]);
    expect(projection.inspect()).toEqual({ activeCount: 0, needsRoughMips: false });
  });

  it('does not scan or rebuild when no material delta is published', () => {
    const projection = new PersistentTransmissionDemandProjection();
    projection.apply([{ kind: 'upsert', key: 'stable', candidate: candidate(0.6, 0.2) }]);
    const before = projection.inspect();

    projection.apply([]);

    expect(projection.inspect()).toEqual(before);
  });
});
