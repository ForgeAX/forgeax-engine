import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoundedEventQueue, DEFAULT_MAX_QUEUED_EVENTS } from '../src/event-queue';

const queueSource = readFileSync(new URL('../src/event-queue.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(
  new URL('../src/websocket-client-core.ts', import.meta.url),
  'utf8',
);
const nodeSource = readFileSync(new URL('../src/node.ts', import.meta.url), 'utf8');

describe('WebSocket queue default owner', () => {
  it('keeps one shared default for client and Node transports', () => {
    expect(queueSource).toContain('export const DEFAULT_MAX_QUEUED_EVENTS = 1024');
    expect(clientSource).toContain('DEFAULT_MAX_QUEUED_EVENTS');
    expect(nodeSource).toContain('DEFAULT_MAX_QUEUED_EVENTS');
    expect(clientSource).not.toMatch(/const DEFAULT_MAX_QUEUED_EVENTS\b/);
    expect(nodeSource).not.toMatch(/const DEFAULT_MAX_QUEUED_EVENTS\b/);

    const queue = new BoundedEventQueue(DEFAULT_MAX_QUEUED_EVENTS);
    expect(queue.maxQueuedEvents).toBe(1024);
  });
});
