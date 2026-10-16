import { installGameplayFrameTiming } from './gameplay_frame_timing.mjs';

export const COMPLETION_CLOCK =
  'Same normalized Platform.now as App CPU and frame observer, milliseconds';

/** Bounded observation of existing completion calls. No extra poll, timer or GL work. */
export function installPhoneCompletionTiming(
  observer,
  { now, capacity = 65536, target = globalThis } = {},
) {
  if (
    typeof now !== 'function' ||
    !Number.isSafeInteger(capacity) ||
    capacity < 16 ||
    capacity > 65536
  )
    throw new Error('Completion timing requires a clock and 16..65536 events');

  const values = new Float64Array(capacity * 8);
  const kinds = [
    'request-start',
    'request-return',
    'poll-enter',
    'poll-return',
    'free',
    'driver-resolved',
    'driver-rejected',
    'timer-schedule',
    'timer-fire',
    'timer-return',
    'sync-query-enter',
    'sync-query-return',
    'client-wait-enter',
    'client-wait-return',
    'native-throw',
  ];
  const apply = Reflect.apply;
  const timerDescriptor = Object.getOwnPropertyDescriptor(target, 'setTimeout');
  const originalTimer = target.setTimeout;
  if (!timerDescriptor || typeof timerDescriptor.value !== 'function')
    throw new Error('Completion timing requires an own timer method');
  const frameTiming = installGameplayFrameTiming(observer, { capacity: 8192 });
  const originalArm = observer.arm,
    originalDrain = observer.drain;
  const driverWrappers = new WeakMap(),
    contextWrappers = new Map();
  let armed = false,
    restored = false,
    startMs = null,
    endMs = null,
    count = 0,
    dropped = 0;
  let clockErrors = 0,
    observationErrors = 0,
    abiErrors = 0,
    lastClock = -Infinity,
    firstDroppedAtMs = null,
    lastDroppedAtMs = null;
  let nextTicket = 0,
    nextTimer = 0,
    pendingTimerTicket = 0,
    activePollTicket = 0;
  let driverCalls = 0,
    nativeHosts = 0,
    syncImports = 0,
    clientWaitUnavailable = 0;
  let unpairedSchedules = 0,
    restoredContexts = 0,
    restoreConflicts = 0;

  function clock() {
    if (!armed || restored) return NaN;
    try {
      const value = now();
      if (Number.isFinite(value) && value >= lastClock) {
        lastClock = value;
        return value;
      }
    } catch {}
    clockErrors++;
    return NaN;
  }
  function record(kind, ticket = 0, timer = 0, detail = NaN, scheduled = NaN, at = clock()) {
    if (!armed || restored || !Number.isFinite(at) || at < startMs || at >= endMs) return;
    if (count >= capacity) {
      dropped++;
      firstDroppedAtMs ??= at;
      lastDroppedAtMs = at;
      return;
    }
    const offset = count++ * 8;
    values[offset] = kind;
    values[offset + 1] = at;
    values[offset + 2] = ticket;
    values[offset + 3] = timer;
    values[offset + 4] = typeof detail === 'number' ? detail : NaN;
    values[offset + 5] = scheduled;
  }
  function timer(callback, delay, ...args) {
    const ticket = pendingTimerTicket;
    pendingTimerTicket = 0;
    if (!ticket || restored) return apply(originalTimer, this, [callback, delay, ...args]);
    if (typeof callback !== 'function' || (delay !== 0 && delay !== 1)) {
      unpairedSchedules++;
      return apply(originalTimer, this, [callback, delay, ...args]);
    }
    const id = ++nextTimer,
      scheduled = clock();
    record(7, ticket, id, delay, scheduled, scheduled);
    return apply(originalTimer, this, [
      function (...callbackArgs) {
        record(8, ticket, id, delay, scheduled);
        try {
          return apply(callback, this, callbackArgs);
        } finally {
          record(9, ticket, id, delay, scheduled);
        }
      },
      delay,
      ...args,
    ]);
  }
  try {
    Object.defineProperty(target, 'setTimeout', { ...timerDescriptor, value: timer });
  } catch (error) {
    frameTiming.restore();
    throw error;
  }

  function wrapClientWait(context) {
    if (restored || !context || contextWrappers.has(context)) return;
    if (contextWrappers.size >= 4) {
      clientWaitUnavailable++;
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(context, 'clientWaitSync');
    const original = context.clientWaitSync;
    if (typeof original !== 'function') {
      clientWaitUnavailable++;
      contextWrappers.set(context, null);
      return;
    }
    const wrapped = function (...args) {
      const ticket = activePollTicket;
      if (args.length !== 3) abiErrors++;
      record(12, ticket, 0, args[2]);
      try {
        const result = apply(original, this, args);
        record(13, ticket, 0, result);
        return result;
      } catch (error) {
        record(14, ticket, 0, 3);
        throw error;
      }
    };
    try {
      Object.defineProperty(
        context,
        'clientWaitSync',
        descriptor
          ? { ...descriptor, value: wrapped }
          : { configurable: true, writable: true, value: wrapped },
      );
      contextWrappers.set(context, { descriptor, original, wrapped });
    } catch {
      clientWaitUnavailable++;
      contextWrappers.set(context, null);
    }
  }

  const api = {
    driver(original) {
      if (restored) return original;
      if (typeof original !== 'function') throw new Error('Original completion driver required');
      let wrapped = driverWrappers.get(original);
      if (wrapped) return wrapped;
      wrapped = function (start, previous) {
        if (restored) return apply(original, this, [start, previous]);
        const ticket = ++nextTicket;
        driverCalls++;
        const wrappedStart = function (...args) {
          record(0, ticket);
          let request;
          try {
            request = apply(start, this, args);
          } catch (error) {
            record(14, ticket, 0, 0);
            throw error;
          }
          record(1, ticket);
          // The frozen driver immediately schedules its first awaited timer here.
          pendingTimerTicket = ticket;
          return {
            poll(...args) {
              record(2, ticket);
              const parent = activePollTicket;
              activePollTicket = ticket;
              try {
                const result = apply(request.poll, request, args);
                if (typeof result !== 'boolean') abiErrors++;
                record(3, ticket, 0, result === true ? 1 : result === false ? 0 : NaN);
                // False falls through directly to the next original awaited timer.
                pendingTimerTicket = result === false ? ticket : 0;
                return result;
              } catch (error) {
                pendingTimerTicket = 0;
                record(14, ticket, 0, 1);
                throw error;
              } finally {
                activePollTicket = parent;
              }
            },
            free(...args) {
              record(4, ticket);
              try {
                return apply(request.free, request, args);
              } catch (error) {
                record(14, ticket, 0, 2);
                throw error;
              }
            },
          };
        };
        let promise;
        try {
          promise = apply(original, this, [wrappedStart, previous]);
        } catch (error) {
          pendingTimerTicket = 0;
          record(14, ticket, 0, 4);
          throw error;
        }
        // Observe resolution without substituting/chaining the returned promise.
        promise.then(
          () => record(5, ticket),
          () => record(6, ticket),
        );
        return promise;
      };
      driverWrappers.set(original, wrapped);
      return wrapped;
    },
    wrapHost(host) {
      nativeHosts++;
      return {
        ...host,
        readWasm(...args) {
          return apply(host.readWasm, host, args);
        },
        instantiate(imports, ...rest) {
          const bindings = imports['./wgpu_wasm_bg.js'];
          if (!bindings) return apply(host.instantiate, host, [imports, ...rest]);
          const wrapped = Object.fromEntries(
            Object.entries(bindings).map(([name, original]) => {
              if (typeof original !== 'function' || !name.startsWith('__wbg_getSyncParameter_'))
                return [name, original];
              syncImports++;
              return [
                name,
                function (...args) {
                  const [context, , parameter] = args;
                  if (args.length !== 3) abiErrors++;
                  wrapClientWait(context);
                  const ticket = activePollTicket;
                  record(10, ticket, 0, parameter);
                  try {
                    const result = apply(original, this, args);
                    record(11, ticket, 0, result);
                    return result;
                  } catch (error) {
                    record(14, ticket, 0, 5);
                    throw error;
                  }
                },
              ];
            }),
          );
          // The original Host still performs its established native-status adaptation.
          return apply(host.instantiate, host, [
            { ...imports, './wgpu_wasm_bg.js': wrapped },
            ...rest,
          ]);
        },
      };
    },
    restore() {
      if (restored) return;
      if (target.setTimeout === timer) Object.defineProperty(target, 'setTimeout', timerDescriptor);
      else restoreConflicts++;
      for (const [context, row] of contextWrappers) {
        if (!row) continue;
        if (context.clientWaitSync !== row.wrapped) {
          restoreConflicts++;
          continue;
        }
        if (row.descriptor) Object.defineProperty(context, 'clientWaitSync', row.descriptor);
        else delete context.clientWaitSync;
        restoredContexts++;
      }
      restored = true;
      if (observer.arm === arm) observer.arm = originalArm;
      if (observer.drain === drain) observer.drain = originalDrain;
      frameTiming.restore();
    },
    snapshot() {
      const finite = (value) => (Number.isFinite(value) ? value : null);
      return {
        schemaVersion: 'forgeax-phone-completion-timing/1',
        diagnosticOnly: true,
        clock: COMPLETION_CLOCK,
        scope:
          'Existing request/start/poll/free, original 0/1ms timers, raw sync queries/clientWaitSync and ordered driver Promise. Poll=false means native request incomplete, not a hardware GPU duration. Driver resolution is not the private Rust callback timestamp.',
        startMs,
        endMs,
        capacity,
        count,
        coverage: {
          armed,
          restored,
          clockErrors,
          observationErrors,
          abiErrors,
          driverCalls,
          nativeHosts,
          syncImports,
          clientWaitUnavailable,
          restoredContexts,
          restoreConflicts,
          unpairedSchedules,
        },
        overflow: { dropped, firstDroppedAtMs, lastDroppedAtMs },
        events: Array.from({ length: count }, (_, index) => {
          const offset = index * 8;
          return {
            kind: kinds[values[offset]],
            atMs: values[offset + 1],
            ticket: values[offset + 2],
            timer: values[offset + 3],
            value: finite(values[offset + 4]),
            scheduledAtMs: finite(values[offset + 5]),
          };
        }),
      };
    },
  };
  const arm = function (...args) {
    const result = apply(originalArm, this, args);
    if (armed || !Number.isFinite(result.startMs) || !(result.endMs > result.startMs))
      throw new Error('One bounded timing window required');
    startMs = result.startMs;
    endMs = result.endMs;
    armed = true;
    return result;
  };
  const drain = async function (...args) {
    try {
      const result = await apply(originalDrain, this, args);
      api.restore();
      return { ...result, completionTiming: api.snapshot() };
    } finally {
      api.restore();
    }
  };
  observer.arm = arm;
  observer.drain = drain;
  return api;
}
