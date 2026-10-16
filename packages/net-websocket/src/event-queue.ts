import type { EndpointEvent } from '@forgeax/engine-net';

export const DEFAULT_MAX_QUEUED_EVENTS = 1024;
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export class BoundedEventQueue {
  readonly #events: EndpointEvent[] = [];
  #bytes = 0;
  #disconnectReason: string | undefined;

  constructor(
    readonly maxQueuedEvents: number,
    readonly maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
  ) {
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1)
      throw new RangeError('maxQueuedBytes must be a positive safe integer');
    if (!Number.isInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
      throw new RangeError('maxQueuedEvents must be a positive integer');
    }
  }

  get closed(): boolean {
    return this.#disconnectReason !== undefined;
  }

  get disconnectReason(): string | undefined {
    return this.#disconnectReason;
  }

  enqueue(event: EndpointEvent): boolean {
    if (this.closed) return false;
    const bytes = event.kind === 'message' ? event.data.byteLength : 0;
    if (this.#events.length === this.maxQueuedEvents || this.#bytes + bytes > this.maxQueuedBytes) {
      this.close(`event queue overflow (maxQueuedEvents=${this.maxQueuedEvents})`);
      return false;
    }
    this.#bytes += bytes;
    this.#events.push(event);
    return true;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.#disconnectReason = reason;
  }

  drain(): EndpointEvent[] {
    this.#bytes = 0;
    return this.#events.splice(0);
  }
}
