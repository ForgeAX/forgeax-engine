import { describe, expect, it } from 'vitest';
import { TemporalFrameCoordinator } from '../temporal/frame-coordinator';

describe('TemporalFrameCoordinator', () => {
  it('keeps TAA state at the last submitted snapshot when a frame aborts', () => {
    const coordinator = new TemporalFrameCoordinator({ epoch: 4, previous: 'frame-4' });
    const candidate = coordinator.begin({ current: 'frame-5', antialias: 'taa' });

    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    coordinator.abort(candidate.value, 'submit');

    expect(coordinator.inspect()).toMatchObject({ epoch: 4, previous: 'frame-4' });
    expect(coordinator.inspect().attempt).toBe('aborted');
  });

  it.each([
    'build',
    'encode',
    'finish',
    'submit',
  ] as const)('does not advance state after %s failure', (stage) => {
    const coordinator = new TemporalFrameCoordinator({ epoch: 7, previous: 'stable' });
    const candidate = coordinator.begin({ current: 'candidate', antialias: 'taa' });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    coordinator.abort(candidate.value, stage);
    expect(coordinator.inspect().epoch).toBe(7);
    expect(coordinator.inspect().previous).toBe('stable');
  });

  it('does not silently turn an unavailable TAA request into no-AA', () => {
    const coordinator = new TemporalFrameCoordinator();
    const result = coordinator.begin({ current: 'frame', antialias: 'taa', available: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('taa-unavailable');
  });

  it('keeps Motion Blur-only retries in the shared submit transaction', () => {
    const coordinator = new TemporalFrameCoordinator({ epoch: 4, previous: 'frame-4' });
    const failed = coordinator.begin({
      current: 'frame-5',
      antialias: 'none',
      temporalDemand: true,
    });

    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    coordinator.abort(failed.value, 'submit');
    expect(coordinator.inspect()).toMatchObject({ epoch: 4, previous: 'frame-4' });

    const retry = coordinator.begin({
      current: 'frame-5',
      antialias: 'none',
      temporalDemand: true,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const committed = coordinator.commit(retry.value);
    expect(committed.ok).toBe(true);
    expect(coordinator.inspect()).toMatchObject({ epoch: 5, previous: 'frame-5' });
  });
});
