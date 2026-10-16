import { FixedTime, Time, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

import type { AppAssembleArgs, CreateAppOptions } from '../types';

describe('createApp time policy surface', () => {
  it('exposes time policy only on the canvas-form options', () => {
    const canvasOptions: CreateAppOptions = {
      time: { fixedDeltaSeconds: 1 / 30, maxStepsPerUpdate: 2, maxDeltaSeconds: 0.1 },
    };
    expect(canvasOptions.time?.fixedDeltaSeconds).toBeCloseTo(1 / 30);

    const world = new World({
      time: { fixedDeltaSeconds: 1 / 30, maxStepsPerUpdate: 2, maxDeltaSeconds: 0.1 },
    });
    expect(world.getResource(Time).maxDeltaSeconds).toBeCloseTo(0.1);
    expect(world.getResource(FixedTime).delta).toBeCloseTo(1 / 30);
    expect(world.getResource(FixedTime).maxStepsPerUpdate).toBe(2);
  });

  it('keeps an assemble-form World policy host-owned', () => {
    const world = new World({ time: { fixedDeltaSeconds: 1 / 30 } });
    const args = { world } as Pick<AppAssembleArgs, 'world'>;
    expect(args.world.getResource(FixedTime).delta).toBeCloseTo(1 / 30);
  });
});
