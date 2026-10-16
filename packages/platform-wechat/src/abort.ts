import DOMException from 'core-js-pure/actual/dom-exception/index.js';
import {
  Event,
  EventTarget,
  getEventAttributeValue,
  setEventAttributeValue,
} from 'event-target-shim';

// The event implementation owns listeners. These slots only implement the
// standard abort algorithm, including dependent signals before event dispatch.
interface SignalState {
  aborted: boolean;
  reason: unknown;
  readonly dependents: Set<WeakRef<RealmAbortSignal>>;
  sources?: WeakRef<RealmAbortSignal>[];
}
const signals = new WeakMap<RealmAbortSignal, SignalState>();
const construction = Symbol('AbortSignal constructor');

function state(signal: RealmAbortSignal): SignalState {
  const value = signals.get(signal);
  if (!value) throw new TypeError('Expected an AbortSignal');
  return value;
}

function abort(signal: RealmAbortSignal, reason: unknown): void {
  if (state(signal).aborted) return;
  const pending: RealmAbortSignal[] = [];
  const mark = (current: RealmAbortSignal) => {
    const currentState = state(current);
    if (currentState.aborted) return;
    currentState.aborted = true;
    currentState.reason = reason;
    pending.push(current);
    for (const reference of currentState.dependents) {
      const dependent = reference.deref();
      if (dependent) mark(dependent);
    }
    currentState.dependents.clear();
  };
  mark(signal);
  for (const current of pending) current.dispatchEvent(new Event('abort'));
}

/** Realm fallback. Never replaces a native AbortSignal/AbortController pair. */
export class RealmAbortSignal extends EventTarget {
  constructor(token?: symbol) {
    super();
    if (token !== construction) throw new TypeError('Illegal constructor');
    signals.set(this, { aborted: false, reason: undefined, dependents: new Set() });
  }
  get aborted(): boolean {
    return state(this).aborted;
  }
  get reason(): unknown {
    return state(this).reason;
  }
  get onabort(): ((event: globalThis.Event) => void) | null {
    return getEventAttributeValue(this, 'abort');
  }
  set onabort(callback: ((event: globalThis.Event) => void) | null) {
    setEventAttributeValue(this, 'abort', callback);
  }
  get [Symbol.toStringTag](): string {
    return 'AbortSignal';
  }
  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  static abort(
    reason: unknown = new DOMException('The operation was aborted.', 'AbortError'),
  ): RealmAbortSignal {
    const signal = new RealmAbortSignal(construction);
    abort(signal, reason);
    return signal;
  }

  static any(sources: Iterable<RealmAbortSignal>): RealmAbortSignal {
    const inputs = [...sources];
    for (const input of inputs) state(input);
    const first = inputs.find((input) => input.aborted);
    if (first) return RealmAbortSignal.abort(first.reason);
    const signal = new RealmAbortSignal(construction);
    // Flatten to the original sources. An intermediate `any()` may be collected
    // while a downstream signal remains reachable.
    const original = new Set<RealmAbortSignal>();
    for (const input of inputs) {
      const sources = state(input).sources;
      if (!sources) original.add(input);
      else
        for (const reference of sources) {
          const source = reference.deref();
          if (source) original.add(source);
        }
    }
    state(signal).sources = [...original].map((source) => new WeakRef(source));
    for (const input of original) {
      const dependents = state(input).dependents;
      for (const reference of dependents) if (!reference.deref()) dependents.delete(reference);
      dependents.add(new WeakRef(signal));
    }
    return signal;
  }

  static timeout(milliseconds: number): RealmAbortSignal {
    const duration = Number(milliseconds);
    if (!Number.isFinite(duration) || duration < 0 || duration > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Timeout must be a finite unsigned millisecond duration');
    }
    const signal = new RealmAbortSignal(construction);
    let remaining = Math.trunc(duration);
    const schedule = () => {
      const delay = Math.min(remaining, 2_147_483_647);
      remaining -= delay;
      setTimeout(() => {
        if (remaining > 0) schedule();
        else abort(signal, new DOMException('The operation timed out.', 'TimeoutError'));
      }, delay);
    };
    schedule();
    return signal;
  }
}

export class RealmAbortController {
  readonly #signal = new RealmAbortSignal(construction);
  get signal(): RealmAbortSignal {
    return this.#signal;
  }
  get [Symbol.toStringTag](): string {
    return 'AbortController';
  }
  abort(reason: unknown = new DOMException('The operation was aborted.', 'AbortError')): void {
    abort(this.#signal, reason);
  }
}
