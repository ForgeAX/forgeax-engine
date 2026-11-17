import { defineResource, type World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-types';

export const VFX_GPU_OUTPUT_CHANNELS = 16;
export const VFX_GPU_OUTPUT_HEADER_BYTES = 16 + VFX_GPU_OUTPUT_CHANNELS * 16;
export interface VfxGpuOutputEvent {
  readonly channel: number;
  readonly particleId: number;
  readonly position: readonly [number, number, number];
  readonly strength: number;
  readonly tick: number;
}
export interface VfxGpuOutputChannel {
  readonly channel: number;
  readonly capacity: number;
  readonly offset: number;
}
type Listener = (events: readonly VfxGpuOutputEvent[]) => void;
interface ChannelOwner {
  channel: number;
  capacity: number;
  listeners: Set<Listener>;
  active: boolean;
}
function acquireChannel(
  rows: Map<number, ChannelOwner>,
  channel: number,
  capacity: number,
  changed: () => void,
) {
  if (
    !Number.isSafeInteger(channel) ||
    channel < 1 ||
    channel > 0xffffffff ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > 1024
  )
    return err({
      code: 'vfx-output-channel-invalid' as const,
      expected: 'positive u32 channel and bounded capacity [1,1024]',
      hint: 'Reserve a distinct authored event channel',
      detail: { channel, capacity },
    });
  if (
    rows.has(channel) ||
    rows.size >= VFX_GPU_OUTPUT_CHANNELS ||
    [...rows.values()].reduce((n, r) => n + r.capacity, capacity) > 1024
  )
    return err({
      code: 'vfx-output-channel-unavailable' as const,
      expected: 'unowned channel and total event capacity at most 1024',
      hint: 'Release the previous channel lease or reduce its authored capacity',
      detail: { channel, capacity },
    });
  const row: ChannelOwner = { channel, capacity, listeners: new Set(), active: true };
  rows.set(channel, row);
  changed();
  return ok({
    get active() {
      return row.active;
    },
    subscribe(listener: Listener) {
      if (!row.active) throw Error('GPU output channel released');
      row.listeners.add(listener);
      return () => row.listeners.delete(listener);
    },
    release() {
      if (!row.active) return;
      row.active = false;
      row.listeners.clear();
      if (rows.get(channel) === row) {
        rows.delete(channel);
        changed();
      }
    },
  });
}
export interface VfxGpuEventOutput {
  readonly epoch: number;
  readonly capacity: number;
  readonly channels: readonly VfxGpuOutputChannel[];
  receive(generation: number, sequence: number, events: readonly VfxGpuOutputEvent[]): void;
  acquire(channel: number, capacity: number): ReturnType<typeof acquireChannel>;
}
export const VFX_GPU_EVENT_OUTPUT = defineResource<VfxGpuEventOutput>('VfxGpuEventOutput');
let nextEpoch = 0;
/** Channel contributions share the one native buffer/transport, with independent
 * per-frame quotas. No contribution may consume another owner's reserved slots. */
export function acquireVfxGpuEventChannel(world: World, channel: number, capacity: number) {
  if (!world.hasResource(VFX_GPU_EVENT_OUTPUT))
    return err({
      code: 'vfx-output-not-owned' as const,
      expected: 'World GPU output owner exists',
      hint: 'Acquire after the formal output owner is installed',
      detail: { channel },
    });
  return world.getResource(VFX_GPU_EVENT_OUTPUT).acquire(channel, capacity);
}
/** A bounded stream of GPU-produced events, never a particle-state mirror. */
export function createVfxGpuEventOutput(world: World, capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024)
    return err({
      code: 'vfx-output-capacity-invalid' as const,
      expected: 'GPU event capacity is an integer in [1,1024]',
      hint: 'Pass a bounded positive integer capacity',
      detail: { capacity },
    });
  if (world.hasResource(VFX_GPU_EVENT_OUTPUT))
    return err({
      code: 'vfx-output-already-owned' as const,
      expected: 'one GPU event output owner per World',
      hint: 'Reuse the existing output stream or release its owner before replacement',
      detail: { capacity },
    });
  let closed = false,
    last = -1,
    lastGeneration = -1,
    epoch = ++nextEpoch;
  const listeners = new Set<Listener>();
  const rows = new Map<number, ChannelOwner>([
    [1, { channel: 1, capacity, listeners: new Set(), active: true }],
  ]);
  const changed = () => {
    epoch = ++nextEpoch;
    last = lastGeneration = -1;
  };
  const output: VfxGpuEventOutput = {
    get epoch() {
      return epoch;
    },
    get capacity() {
      return [...rows.values()].reduce((n, r) => n + r.capacity, 0);
    },
    get channels() {
      let offset = 0;
      return [...rows.values()].map((r) => {
        const value = { channel: r.channel, capacity: r.capacity, offset };
        offset += r.capacity;
        return value;
      });
    },
    acquire(channel, count) {
      if (closed) throw Error('GPU event output disposed');
      return acquireChannel(rows, channel, count, changed);
    },
    receive(generation, sequence, events) {
      if (closed || generation < lastGeneration) return;
      if (generation > lastGeneration) {
        lastGeneration = generation;
        last = -1;
      }
      if (sequence <= last) return;
      last = sequence;
      const errors: unknown[] = [];
      for (const listener of [...listeners])
        try {
          listener(events);
        } catch (error) {
          errors.push(error);
        }
      for (const row of rows.values()) {
        const selected = events.filter((e) => e.channel === row.channel);
        for (const listener of [...row.listeners])
          try {
            listener(selected);
          } catch (error) {
            errors.push(error);
          }
      }
      if (errors.length) throw new AggregateError(errors, 'GPU output observers failed');
    },
  };
  world.insertResource(VFX_GPU_EVENT_OUTPUT, output);
  return ok({
    get epoch() {
      return output.epoch;
    },
    reset() {
      if (closed) throw Error('GPU event output disposed');
      changed();
    },
    subscribe(listener: Listener) {
      if (closed) throw Error('GPU event output disposed');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (closed) return;
      listeners.clear();
      for (const r of rows.values()) {
        r.active = false;
        r.listeners.clear();
      }
      rows.clear();
      if (
        world.hasResource(VFX_GPU_EVENT_OUTPUT) &&
        world.getResource(VFX_GPU_EVENT_OUTPUT) === output
      )
        world.removeResource(VFX_GPU_EVENT_OUTPUT);
      closed = true;
    },
  });
}
