import { describe, expect, it } from 'vitest';
import type { EndpointEvent, PeerId } from '@forgeax/engine-net';
import { BoundedEventQueue } from '../src/event-queue';

const peerId = 1 as PeerId;

function message(value: number): EndpointEvent {
  return { kind: 'message', peerId, data: new Uint8Array([value]) };
}

describe('BoundedEventQueue', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxQueuedEvents value %s',
    (maxQueuedEvents) => {
      expect(() => new BoundedEventQueue(maxQueuedEvents)).toThrow(
        'maxQueuedEvents must be a positive integer',
      );
    },
  );

  it('dequeues events in insertion order', () => {
    const queue = new BoundedEventQueue(3);

    expect(queue.enqueue(message(1))).toBe(true);
    expect(queue.enqueue(message(2))).toBe(true);
    expect(queue.enqueue(message(3))).toBe(true);

    expect(queue.drain()).toEqual([message(1), message(2), message(3)]);
  });

  it('returns an empty array when no events are queued', () => {
    const queue = new BoundedEventQueue(1);

    expect(queue.drain()).toEqual([]);
  });

  it('rejects overflow and closes with a disconnect reason', () => {
    const queue = new BoundedEventQueue(1);

    expect(queue.enqueue(message(1))).toBe(true);
    expect(queue.enqueue(message(2))).toBe(false);
    expect(queue.closed).toBe(true);
    expect(queue.disconnectReason).toContain('overflow');
  });

  it('drains events queued before close but rejects subsequent events', () => {
    const queue = new BoundedEventQueue(1);

    expect(queue.enqueue(message(1))).toBe(true);
    queue.close('socket closed');

    expect(queue.drain()).toEqual([message(1)]);
    expect(queue.drain()).toEqual([]);
    expect(queue.enqueue(message(2))).toBe(false);
    expect(queue.disconnectReason).toBe('socket closed');
  });
});

it('bounds retained payload bytes independently from event count and resets after drain', () => {
  const queue = new BoundedEventQueue(10, 2);
  expect(queue.enqueue(message(1))).toBe(true);
  expect(queue.enqueue(message(2))).toBe(true);
  queue.drain();
  expect(queue.enqueue(message(3))).toBe(true);
  expect(queue.enqueue(message(4))).toBe(true);
  expect(queue.enqueue(message(5))).toBe(false);
  expect(queue.closed).toBe(true);
});
