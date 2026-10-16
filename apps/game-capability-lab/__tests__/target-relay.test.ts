import { describe, expect, it, vi } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { Name } from '@forgeax/engine-scene';
import { createScoringTargetQuery, ScoringTarget } from '../assets/plugins/scoring-target';
import { createTargetRelay } from '../assets/plugins/target-relay';

describe('game-default authored target relay', () => {
  it('advances only the active authored target and owns the FBX variation interval', () => {
    const world = new World();
    const red = world.spawn(
      { component: Name, data: { value: 'RedBox' } },
      { component: ScoringTarget, data: { points: 10, relayStep: 2 } },
    ).unwrap();
    const blue = world.spawn(
      { component: Name, data: { value: 'BlueBall' } },
      { component: ScoringTarget, data: { points: 15, relayStep: 1 } },
    ).unwrap();
    const yellow = world.spawn(
      { component: Name, data: { value: 'YellowPillar' } },
      { component: ScoringTarget, data: { points: 10, relayStep: 3 } },
    ).unwrap();
    let variationActive = false;
    const setVariationActive = vi.fn((active: boolean) => { variationActive = active; });
    const relay = createTargetRelay(world, createScoringTargetQuery(world), {
      variationTarget: red,
      variationAvailable: true,
      setVariationActive,
    });

    expect(relay.snapshot()).toMatchObject({ status: 'locked', currentStep: 0, cleared: 0 });
    relay.begin();
    expect(relay.snapshot()).toMatchObject({ status: 'active', currentStep: 1, activeTargetName: 'BlueBall', variationActive: false });

    expect(relay.recordHit(red)).toBe(false);
    expect(relay.snapshot()).toMatchObject({ currentStep: 1, cleared: 0, rejectedHits: 1 });

    expect(relay.recordHit(blue)).toBe(true);
    expect(relay.snapshot()).toMatchObject({ currentStep: 2, cleared: 1, activeTargetName: 'RedBox', variationActive: true });
    expect(variationActive).toBe(true);

    expect(relay.recordHit(red)).toBe(true);
    expect(relay.snapshot()).toMatchObject({ currentStep: 3, cleared: 2, activeTargetName: 'YellowPillar', variationActive: false });
    expect(variationActive).toBe(false);

    expect(relay.recordHit(yellow)).toBe(true);
    expect(relay.snapshot()).toMatchObject({ status: 'complete', currentStep: 3, cleared: 3, activeTargetName: null });

    relay.reset();
    expect(relay.snapshot()).toMatchObject({ status: 'locked', currentStep: 0, cleared: 0, acceptedHits: 0, rejectedHits: 0, variationActive: false });
    expect(setVariationActive).toHaveBeenCalledWith(true);
    expect(setVariationActive).toHaveBeenLastCalledWith(false);
  });
});
