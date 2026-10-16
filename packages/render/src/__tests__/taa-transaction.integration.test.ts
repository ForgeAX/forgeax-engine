import { describe, expect, it } from 'vitest';
import { TemporalFrameCoordinator } from '../temporal/frame-coordinator';

describe('TAA transaction integration', () => {
  it('commits epoch, previous and history together only after submit', () => {
    const coordinator = new TemporalFrameCoordinator<string>({ epoch: 0 });
    const frame = coordinator.begin({ current: 'current-1', antialias: 'taa' });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;

    const committed = coordinator.commit(frame.value);
    expect(committed.ok).toBe(true);
    expect(coordinator.inspect()).toMatchObject({ epoch: 1, previous: 'current-1' });
    expect(coordinator.inspect().historyAttempt).toBe('committed');
  });

  it('requires an explicit abort for a failed submission', () => {
    const coordinator = new TemporalFrameCoordinator({ epoch: 2, previous: 'stable' });
    const frame = coordinator.begin({ current: 'next', antialias: 'taa' });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    coordinator.abort(frame.value, 'submit');
    expect(coordinator.inspect()).toMatchObject({ epoch: 2, previous: 'stable' });
    expect(coordinator.historyStore.inspect()).toMatchObject({
      attempt: 'aborted',
      generation: 0,
      valid: false,
    });
  });
});
