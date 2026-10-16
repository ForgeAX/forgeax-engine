import DOMException from 'core-js-pure/actual/dom-exception/index.js';
import clone from 'core-js-pure/actual/structured-clone.js';
import { Event, EventTarget } from 'event-target-shim';

const EventBase: typeof globalThis.Event = globalThis.Event ?? Event;
const EventTargetBase: typeof globalThis.EventTarget = globalThis.EventTarget ?? EventTarget;

/** Standard same-realm event shape; no remote origin or transferred ports are invented. */
export class RealmMessageEvent<T = unknown> extends EventBase {
  readonly data: T;
  readonly origin: string;
  readonly lastEventId: string;
  readonly source: unknown;
  readonly ports: readonly RealmMessagePort[];
  constructor(
    type: string,
    init: {
      data?: T;
      origin?: string;
      lastEventId?: string;
      source?: unknown;
      ports?: readonly RealmMessagePort[];
      bubbles?: boolean;
      cancelable?: boolean;
      composed?: boolean;
    } = {},
  ) {
    super(type, init);
    this.data = (init.data ?? null) as T;
    this.origin = init.origin ?? '';
    this.lastEventId = init.lastEventId ?? '';
    this.source = init.source ?? null;
    this.ports = Object.freeze([...(init.ports ?? [])]);
  }
  get [Symbol.toStringTag](): string {
    return 'MessageEvent';
  }
}
interface PortState {
  peer?: RealmMessagePort;
  readonly queue: unknown[];
  started: boolean;
  closed: boolean;
  task?: ReturnType<typeof setTimeout>;
  readonly handlers: Map<
    string,
    { callback: (event: globalThis.Event) => void; listener: (event: globalThis.Event) => void }
  >;
}
const states = new WeakMap<RealmMessagePort, PortState>();
const construction = Symbol('MessagePort constructor');
function state(port: RealmMessagePort): PortState {
  const result = states.get(port);
  if (!result) throw new TypeError('Expected a MessagePort');
  return result;
}
function setHandler(
  port: RealmMessagePort,
  type: string,
  callback: ((event: globalThis.Event) => void) | null,
): void {
  const handlers = state(port).handlers;
  const existing = handlers.get(type);
  if (typeof callback !== 'function') {
    if (existing) port.removeEventListener(type, existing.listener);
    handlers.delete(type);
  } else if (existing) existing.callback = callback;
  else {
    const entry = {
      callback,
      listener: (event: globalThis.Event) => {
        handlers.get(type)?.callback.call(port, event);
      },
    };
    handlers.set(type, entry);
    port.addEventListener(type, entry.listener);
  }
}
function schedule(port: RealmMessagePort): void {
  const target = state(port);
  if (!target.started || target.closed || target.task !== undefined || target.queue.length === 0)
    return;
  target.task = setTimeout(() => {
    delete target.task;
    if (target.closed || !target.started || target.queue.length === 0) return;
    const data = target.queue.shift();
    try {
      const Constructor = globalThis.MessageEvent ?? RealmMessageEvent;
      const event = new Constructor('message', { data });
      // MessageEventInit defaults undefined to null; channel delivery must retain undefined.
      if (data === undefined) Object.defineProperty(event, 'data', { value: undefined });
      port.dispatchEvent(event);
    } finally {
      schedule(port);
    }
  }, 0);
}

/** Async, cloned, FIFO delivery for the host's own realm. Transfer is unsupported. */
export class RealmMessagePort extends EventTargetBase {
  constructor(token?: symbol) {
    super();
    if (token !== construction) throw new TypeError('Illegal constructor');
    states.set(this, { queue: [], started: false, closed: false, handlers: new Map() });
  }
  postMessage(
    value: unknown,
    options: readonly object[] | { transfer?: readonly object[] } = {},
  ): void {
    const sender = state(this);
    const transfer =
      'transfer' in options ? (options.transfer ?? []) : Array.isArray(options) ? options : [];
    if (transfer.length > 0)
      throw new DOMException(
        'Same-realm MessagePort does not support transfer lists',
        'DataCloneError',
      );
    const data = clone(value);
    const peer = sender.peer;
    if (sender.closed || !peer || state(peer).closed) return;
    state(peer).queue.push(data);
    schedule(peer);
  }
  start(): void {
    const current = state(this);
    if (current.closed) return;
    current.started = true;
    schedule(this);
  }
  close(): void {
    const current = state(this);
    if (current.closed) return;
    current.closed = true;
    current.queue.length = 0;
    if (current.task !== undefined) {
      clearTimeout(current.task);
      delete current.task;
    }
    if (current.peer) delete state(current.peer).peer;
    delete current.peer;
  }
  get onmessage(): ((event: globalThis.Event) => void) | null {
    return state(this).handlers.get('message')?.callback ?? null;
  }
  set onmessage(listener: ((event: globalThis.Event) => void) | null) {
    setHandler(this, 'message', listener);
    this.start();
  }
  get onmessageerror(): ((event: globalThis.Event) => void) | null {
    return state(this).handlers.get('messageerror')?.callback ?? null;
  }
  set onmessageerror(listener: ((event: globalThis.Event) => void) | null) {
    setHandler(this, 'messageerror', listener);
  }
  get [Symbol.toStringTag](): string {
    return 'MessagePort';
  }
}
export class RealmMessageChannel {
  readonly port1 = new RealmMessagePort(construction);
  readonly port2 = new RealmMessagePort(construction);
  constructor() {
    state(this.port1).peer = this.port2;
    state(this.port2).peer = this.port1;
  }
  get [Symbol.toStringTag](): string {
    return 'MessageChannel';
  }
}
