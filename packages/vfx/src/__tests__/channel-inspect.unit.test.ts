import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { VfxGpuRuntime } from '../gpu-runtime.js';

const player = 7 as EntityHandle;

describe('VFX channel inspect counters', () => {
  it('keeps bounded event counters observable without GPU readback', () => {
    const runtime = new VfxGpuRuntime();
    runtime.markEventDispatched(player, {
      queued: 4,
      produced: 4,
      consumed: 0,
      dropped: 2,
      overflow: 1,
      fanOut: 2,
      recursionDepth: 1,
      lastSequence: 9,
    });

    expect(runtime.eventCounters(player)).toEqual({
      queued: 0,
      produced: 4,
      consumed: 4,
      dropped: 2,
      overflow: 1,
      fanOut: 2,
      recursionDepth: 1,
      lastSequence: 9,
    });
  });

  it('merges a consumer dispatch into the producer snapshot', () => {
    const runtime = new VfxGpuRuntime();
    runtime.markEventDispatched(player, {
      queued: 1,
      produced: 1,
      consumed: 0,
      dropped: 0,
      overflow: 0,
      fanOut: 2,
      recursionDepth: 1,
      lastSequence: 3,
    });
    runtime.markEventDispatched(player, {
      queued: 1,
      produced: 0,
      consumed: 2,
      dropped: 0,
      overflow: 0,
      fanOut: 2,
      recursionDepth: 1,
      lastSequence: 3,
    });

    expect(runtime.eventCounters(player)).toMatchObject({
      queued: 0,
      produced: 1,
      consumed: 2,
      fanOut: 2,
      recursionDepth: 1,
      lastSequence: 3,
    });
  });
});
