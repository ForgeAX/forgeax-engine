import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireVfxGpuEventChannel,
  createVfxGpuEventOutput,
  VFX_GPU_EVENT_OUTPUT,
  type VfxGpuOutputEvent,
} from '../gpu-event-output.js';
import { parseGpuSlotAllocatorSource } from '../gpu-slot-allocator-source.js';

const event = (channel: number): VfxGpuOutputEvent => ({
  channel,
  particleId: 7,
  position: [1, 2, 3],
  strength: 0.5,
  tick: 4,
});

describe('native GPU event ownership', () => {
  it('keeps contribution quotas independent and revokes borrowed channels on disposal', () => {
    const world = new World();
    const owner = createVfxGpuEventOutput(world, 3).unwrap();
    const lease = acquireVfxGpuEventChannel(world, 100, 47).unwrap();
    const output = world.getResource(VFX_GPU_EVENT_OUTPUT);
    expect(output.channels).toEqual([
      { channel: 1, capacity: 3, offset: 0 },
      { channel: 100, capacity: 47, offset: 3 },
    ]);
    expect(createVfxGpuEventOutput(world, 3).ok).toBe(false);
    expect(acquireVfxGpuEventChannel(world, 100, 1).ok).toBe(false);
    const listener = vi.fn();
    lease.subscribe(listener);
    output.receive(2, 1, [event(1), event(100)]);
    output.receive(2, 1, [event(100)]);
    output.receive(1, 2, [event(100)]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([event(100)]);
    owner.dispose();
    expect(lease.active).toBe(false);
    expect(world.hasResource(VFX_GPU_EVENT_OUTPUT)).toBe(false);
    lease.release();
  });
  it('delivers other observers before reporting a subscriber exception', () => {
    const world = new World();
    const owner = createVfxGpuEventOutput(world, 3).unwrap();
    const lease = acquireVfxGpuEventChannel(world, 100, 1).unwrap();
    const listener = vi.fn();
    owner.subscribe(() => {
      throw new Error('observer');
    });
    lease.subscribe(listener);
    expect(() => world.getResource(VFX_GPU_EVENT_OUTPUT).receive(1, 1, [event(100)])).toThrow(
      AggregateError,
    );
    expect(listener).toHaveBeenCalledWith([event(100)]);
    owner.dispose();
  });
});

describe('ordered GPU pool author contract', () => {
  const state = { active: 'alive', priority: 'priority', cursor: 'cursor', sequence: 'sequence' };
  it('admits control-only pools and rejects acquire without commands or aliased state', () => {
    expect(
      parseGpuSlotAllocatorSource({ control: 'control', state, commands: [], maxCommandCount: 1 })
        .ok,
    ).toBe(true);
    expect(
      parseGpuSlotAllocatorSource({ acquire: 'acquire', state, commands: [], maxCommandCount: 1 })
        .ok,
    ).toBe(false);
    expect(
      parseGpuSlotAllocatorSource({
        control: 'control',
        state: { ...state, priority: 'alive' },
        commands: [],
        maxCommandCount: 1,
      }).ok,
    ).toBe(false);
  });
});
