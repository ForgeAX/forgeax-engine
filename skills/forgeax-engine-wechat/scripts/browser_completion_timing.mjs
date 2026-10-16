/** Self-contained: may be passed directly to page.addInitScript(fn, options). */
export function installBrowserCompletionTiming(options) {
  // biome-ignore lint/suspicious/noRedundantUseStrict: This function is serialized into a classic script.
  'use strict';
  options ??= {};
  const host = globalThis;
  const globalName = options.globalName ?? '__forgeaxCompletionTiming';
  const capacity = options.capacity ?? 32768;
  if (typeof globalName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(globalName))
    throw new Error('Completion timing requires a JavaScript global identifier');
  if (!Number.isSafeInteger(capacity) || capacity < 8 || capacity > 262144)
    throw new Error('Completion timing capacity must be an integer in 8..262144');
  if (globalName in host) throw new Error(`Completion timing global already exists: ${globalName}`);
  const clockOwner = host.performance;
  const clock = clockOwner?.now;
  if (typeof clock !== 'function') throw new Error('Completion timing requires performance.now');
  const apply = Reflect.apply;
  const rows = new Float64Array(capacity * 10);
  const contexts = new WeakMap();
  const syncs = new WeakMap();
  // Timer and rAF native IDs occupy separate namespaces and can be equal.
  const pending = { timer: new Map(), raf: new Map() };
  const patches = [];
  const unavailable = [];
  const restoreConflicts = [];
  const kinds = [
    'fenceSync',
    'getSyncParameter',
    'flush',
    'deleteSync',
    'timer-schedule',
    'timer-fire',
    'timer-cancel',
    'raf-schedule',
    'raf-fire',
    'raf-cancel',
  ];
  let active = false,
    restored = false,
    count = 0,
    dropped = 0;
  let firstDroppedAtMs = null,
    lastDroppedAtMs = null;
  let nextContext = 0,
    nextSync = 0,
    nextSchedule = 0;
  let startMs = null,
    stopMs = null,
    pendingAtStart = [],
    pendingAtStop = [];
  let clockErrors = 0,
    observationErrors = 0,
    untrackedSyncCalls = 0;
  let unsupportedTimerCallbacks = 0,
    pendingTrackingOverflow = 0,
    unknownCancellations = 0;
  const numeric = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);
  const objectLike = (value) =>
    value !== null && (typeof value === 'object' || typeof value === 'function');
  function now() {
    try {
      const value = apply(clock, clockOwner, []);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      /* Instrumentation must not replace application results or errors. */
    }
    clockErrors++;
    return NaN;
  }
  function contextId(value) {
    if (!objectLike(value)) return 0;
    let id = contexts.get(value);
    if (id === undefined) {
      id = ++nextContext;
      contexts.set(value, id);
    }
    return id;
  }
  // Fixed storage only; materialize event objects when the caller exports a snapshot.
  function record(
    kind,
    at,
    end,
    id = 0,
    context = 0,
    arg0 = NaN,
    arg1 = NaN,
    value = NaN,
    flags = 0,
    nativeId = NaN,
  ) {
    if (!active) return;
    if (count === capacity) {
      dropped++;
      firstDroppedAtMs ??= at;
      lastDroppedAtMs = at;
      return;
    }
    const offset = count++ * 10;
    rows[offset] = kind;
    rows[offset + 1] = at;
    rows[offset + 2] = end;
    rows[offset + 3] = id;
    rows[offset + 4] = context;
    rows[offset + 5] = arg0;
    rows[offset + 6] = arg1;
    rows[offset + 7] = value;
    rows[offset + 8] = flags;
    rows[offset + 9] = nativeId;
  }
  function observe(callback) {
    try {
      callback();
    } catch {
      observationErrors++;
    }
  }
  function patch(target, name, create) {
    let owner = target,
      descriptor;
    while (owner) {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) break;
      owner = Object.getPrototypeOf(owner);
    }
    if (!descriptor || typeof descriptor.value !== 'function') {
      unavailable.push({ name, reason: 'missing-data-method' });
      return;
    }
    try {
      const wrapper = create(descriptor.value);
      Object.defineProperty(owner, name, { ...descriptor, value: wrapper });
      patches.push({ owner, name, descriptor, wrapper });
    } catch {
      unavailable.push({ name, reason: 'method-not-replaceable' });
    }
  }
  const glPrototype = host.WebGL2RenderingContext?.prototype;
  for (const [kind, name] of ['fenceSync', 'getSyncParameter', 'flush', 'deleteSync'].entries()) {
    patch(
      glPrototype,
      name,
      (original) =>
        function (...args) {
          if (restored) return apply(original, this, args);
          const at = active ? now() : NaN;
          let result,
            threw = true;
          try {
            result = apply(original, this, args);
            threw = false;
            return result;
          } finally {
            observe(() => {
              let id = 0;
              if (kind === 0 && !threw && objectLike(result)) {
                id = ++nextSync;
                syncs.set(result, id);
              } else if (kind === 1 || kind === 3) {
                id = objectLike(args[0]) ? (syncs.get(args[0]) ?? 0) : 0;
                if (active && args[0] != null && id === 0) untrackedSyncCalls++;
              }
              if (active)
                record(
                  kind,
                  at,
                  now(),
                  id,
                  contextId(this),
                  numeric(kind === 0 ? args[0] : args[1]),
                  numeric(kind === 0 ? args[1] : undefined),
                  numeric(result),
                  threw ? 1 : 0,
                );
              // Retain the weak identity: a later use-after-delete must stay attributable.
            });
          }
        },
    );
  }
  function schedule(kind, original) {
    return function (...args) {
      if (restored) return apply(original, this, args);
      const id = ++nextSchedule,
        at = now(),
        callback = args[0];
      let handle,
        threw = true;
      const isFunction = typeof callback === 'function';
      const entry = {
        id,
        kind: kind === 4 ? 'timer' : 'raf',
        scheduledAtMs: at,
        delayMs: kind === 4 && Number.isFinite(numeric(args[1])) ? args[1] : null,
        nativeId: null,
      };
      const pendingKind = pending[entry.kind];
      // Native string timers retain native evaluation/CSP semantics; wake is unavailable.
      const forwarded = isFunction
        ? [
            function (...callbackArgs) {
              if (!restored)
                observe(() => {
                  pendingKind.delete(handle);
                  const firedAt = active ? now() : NaN;
                  record(
                    kind + 1,
                    firedAt,
                    firedAt,
                    id,
                    0,
                    entry.scheduledAtMs,
                    numeric(entry.delayMs),
                    numeric(callbackArgs[0]),
                    0,
                    numeric(handle),
                  );
                });
              return apply(callback, this, callbackArgs);
            },
            ...args.slice(1),
          ]
        : args;
      try {
        handle = apply(original, this, forwarded);
        threw = false;
        return handle;
      } finally {
        observe(() => {
          entry.nativeId = Number.isFinite(numeric(handle)) ? handle : null;
          if (!threw && isFunction) {
            if (pending.timer.size + pending.raf.size < capacity) pendingKind.set(handle, entry);
            else pendingTrackingOverflow++;
          }
          if (!isFunction && !threw && kind === 4) unsupportedTimerCallbacks++;
          record(
            kind,
            at,
            active ? now() : NaN,
            id,
            0,
            kind === 4 ? numeric(args[1]) : NaN,
            Math.max(0, args.length - 2),
            NaN,
            (threw ? 1 : 0) | (!isFunction ? 2 : 0),
            numeric(handle),
          );
        });
      }
    };
  }
  function cancel(kind, original) {
    return function (...args) {
      if (restored) return apply(original, this, args);
      const at = active ? now() : NaN;
      let threw = true;
      try {
        const result = apply(original, this, args);
        threw = false;
        return result;
      } finally {
        observe(() => {
          const pendingKind = kind === 6 ? pending.timer : pending.raf;
          const entry = pendingKind.get(args[0]);
          if (!threw) pendingKind.delete(args[0]);
          if (active && !entry) unknownCancellations++;
          record(
            kind,
            at,
            active ? now() : NaN,
            entry?.id ?? 0,
            0,
            NaN,
            NaN,
            NaN,
            threw ? 1 : 0,
            numeric(args[0]),
          );
        });
      }
    };
  }
  patch(host, 'setTimeout', (original) => schedule(4, original));
  patch(host, 'clearTimeout', (original) => cancel(6, original));
  patch(host, 'requestAnimationFrame', (original) => schedule(7, original));
  patch(host, 'cancelAnimationFrame', (original) => cancel(9, original));

  const pendingRows = () =>
    [...pending.timer.values(), ...pending.raf.values()].map((entry) => ({ ...entry }));
  function snapshot() {
    const events = [];
    const finite = (value) => (Number.isFinite(value) ? value : null);
    for (let index = 0; index < count; index++) {
      const offset = index * 10,
        kind = rows[offset],
        flags = rows[offset + 8];
      const event = {
        kind: kinds[kind],
        atMs: finite(rows[offset + 1]),
        endMs: finite(rows[offset + 2]),
        threw: !!(flags & 1),
      };
      if (kind < 4) {
        event.contextId = rows[offset + 4];
        if (kind !== 2) event.syncId = rows[offset + 3] || null;
        if (kind === 0) {
          event.condition = finite(rows[offset + 5]);
          event.flags = finite(rows[offset + 6]);
        }
        if (kind === 1) {
          event.pname = finite(rows[offset + 5]);
          event.value = finite(rows[offset + 7]);
        }
      } else {
        event.id = rows[offset + 3] || null;
        event.nativeId = finite(rows[offset + 9]);
        if (kind === 4) {
          event.delayMs = finite(rows[offset + 5]);
          event.extraArgumentCount = rows[offset + 6];
          event.callbackObservable = !(flags & 2);
        }
        if (kind === 5 || kind === 8) event.scheduledAtMs = finite(rows[offset + 5]);
        if (kind === 5) event.delayMs = finite(rows[offset + 6]);
        if (kind === 8) event.rafTimestampMs = finite(rows[offset + 7]);
      }
      events.push(event);
    }
    return {
      schemaVersion: 'forgeax-browser-completion-timing/1',
      state: restored
        ? 'restored'
        : active
          ? 'recording'
          : startMs === null
            ? 'installed'
            : 'stopped',
      clock: 'performance.now',
      startMs,
      stopMs,
      capacity,
      recordedEvents: count,
      overflow: { droppedEvents: dropped, firstAtMs: firstDroppedAtMs, lastAtMs: lastDroppedAtMs },
      coverage: {
        installedHooks: patches.map((p) => p.name),
        unavailableHooks: [...unavailable],
        restoreConflicts: [...restoreConflicts],
        clockErrors,
        observationErrors,
        untrackedSyncCalls,
        unsupportedTimerCallbacks,
        pendingTrackingOverflow,
        unknownCancellations,
        workScheduledBeforeInstallation: 'unknown',
        callsThroughPreviouslyCachedMethods: 'unknown',
        unknownDelayValues:
          'non-numeric delay arguments are forwarded unchanged and reported as null',
      },
      pendingAtStart: pendingAtStart.map((entry) => ({ ...entry })),
      pendingAtStop: (active ? pendingRows() : pendingAtStop).map((entry) => ({ ...entry })),
      events,
    };
  }
  const api = {
    start() {
      if (restored || active)
        throw new Error('Completion timing start requires installed/stopped state');
      count = dropped = clockErrors = observationErrors = untrackedSyncCalls = 0;
      unknownCancellations = 0;
      firstDroppedAtMs = lastDroppedAtMs = stopMs = null;
      pendingAtStart = pendingRows();
      pendingAtStop = [];
      startMs = now();
      active = true;
      return {
        startMs,
        clock: 'performance.now',
        capacity,
        pendingAtStart: pendingAtStart.length,
        unavailableHooks: [...unavailable],
      };
    },
    stop() {
      if (active) {
        stopMs = now();
        active = false;
        pendingAtStop = pendingRows();
      }
      return snapshot();
    },
    snapshot,
    restore() {
      if (!restored) {
        api.stop();
        for (const { owner, name, descriptor, wrapper } of patches.slice().reverse()) {
          try {
            if (Object.getOwnPropertyDescriptor(owner, name)?.value !== wrapper) {
              restoreConflicts.push({ name, reason: 'replaced-after-install' });
              continue;
            }
            Object.defineProperty(owner, name, descriptor);
          } catch {
            restoreConflicts.push({ name, reason: 'restore-failed' });
          }
        }
        restored = true;
        pending.timer.clear();
        pending.raf.clear();
        try {
          if (Object.getOwnPropertyDescriptor(host, globalName)?.value === api)
            delete host[globalName];
        } catch {
          restoreConflicts.push({ name: globalName, reason: 'restore-failed' });
        }
      }
      return snapshot();
    },
  };
  try {
    Object.defineProperty(host, globalName, { value: api, configurable: true });
  } catch (error) {
    api.restore();
    throw error;
  }
  return api;
}

/** No build dependency: inject this content before the game's own scripts load. */
export function browserCompletionTimingSource(options = {}) {
  return `;(${installBrowserCompletionTiming.toString()})(${JSON.stringify(options)});`;
}
