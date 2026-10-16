export const FRAME_CLOCK = 'The same Platform.now as the ordinary App observer, in milliseconds.';

/** Diagnostic only: observes the existing Platform request and callback path. */
export function installGameplayFrameTiming(observer, { capacity = 8192 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 8 || capacity > 262144)
    throw new Error('Frame timing capacity must be 8..262144');
  if (
    !observer ||
    ['arm', 'drain', 'observeOptions'].some((key) => typeof observer[key] !== 'function')
  )
    throw new Error('Frame timing requires the ordinary observer methods');
  const values = new Float64Array(capacity * 4);
  const kinds = ['request', 'callback-enter', 'callback-exit', 'cancel', 'request-error'];
  const apply = Reflect.apply;
  const originalObserve = observer.observeOptions;
  const originalArm = observer.arm;
  const originalDrain = observer.drain;
  let platform, originalRequest, requestDescriptor, wrappedRequest;
  let armed = false,
    restored = false,
    count = 0,
    dropped = 0,
    nextRequest = 0;
  let startMs = null,
    endMs = null,
    firstDroppedAtMs = null,
    lastDroppedAtMs = null;
  let lastClock = -Infinity,
    clockErrors = 0,
    observationErrors = 0,
    cancelWrappingFailures = 0;
  function clock() {
    try {
      const value = platform.now();
      if (value.ok && Number.isFinite(value.value) && value.value >= lastClock) {
        lastClock = value.value;
        return value.value;
      }
    } catch {
      /* Never replace a native result or error. */
    }
    clockErrors++;
    return NaN;
  }
  function record(kind, requestId, scheduledAtMs) {
    if (!armed || restored) return;
    try {
      const at = clock();
      if (!Number.isFinite(at) || at < startMs || at >= endMs) return;
      if (count >= capacity) {
        dropped++;
        firstDroppedAtMs ??= at;
        lastDroppedAtMs = at;
        return;
      }
      const offset = count++ * 4;
      values[offset] = kind;
      values[offset + 1] = at;
      values[offset + 2] = requestId;
      values[offset + 3] = scheduledAtMs;
    } catch {
      observationErrors++;
    }
  }
  const observeOptions = function (...args) {
    const options = apply(originalObserve, this, args);
    if (platform) throw new Error('Frame timing requires one ordinary Host assembly');
    platform = options.platform;
    requestDescriptor = Object.getOwnPropertyDescriptor(platform, 'requestFrame');
    if (!requestDescriptor || typeof requestDescriptor.value !== 'function')
      throw new Error('Expected an own Platform requestFrame method');
    originalRequest = requestDescriptor.value;
    wrappedRequest = function (callback) {
      const requestId = ++nextRequest;
      const scheduledAtMs = clock();
      record(0, requestId, scheduledAtMs);
      let result;
      try {
        result = apply(originalRequest, this, [
          function (...callbackArgs) {
            record(1, requestId, scheduledAtMs);
            try {
              return apply(callback, this, callbackArgs);
            } finally {
              record(2, requestId, scheduledAtMs);
            }
          },
        ]);
      } catch (error) {
        record(4, requestId, scheduledAtMs);
        throw error;
      }
      if (!result.ok) {
        record(4, requestId, scheduledAtMs);
        return result;
      }
      const cancel = result.value;
      // Engine ResultOk has an own writable value and shared unwrap methods.
      // Retain that exact result object/prototype, changing only its callback.
      const descriptor = Object.getOwnPropertyDescriptor(result, 'value');
      if (typeof cancel !== 'function' || descriptor?.writable !== true) {
        cancelWrappingFailures++;
        return result;
      }
      try {
        result.value = function (...cancelArgs) {
          record(3, requestId, scheduledAtMs);
          return apply(cancel, this, cancelArgs);
        };
      } catch {
        cancelWrappingFailures++;
      }
      return result;
    };
    Object.defineProperty(platform, 'requestFrame', {
      ...requestDescriptor,
      value: wrappedRequest,
    });
    return options;
  };
  const arm = function (...args) {
    const result = apply(originalArm, this, args);
    if (armed || !platform || !Number.isFinite(result.startMs) || !(result.endMs > result.startMs))
      throw new Error('Frame timing requires one bounded ordinary observer window');
    startMs = result.startMs;
    endMs = result.endMs;
    armed = true;
    return result;
  };
  const snapshot = () => ({
    schemaVersion: 'forgeax-gameplay-platform-frame-timing/1',
    diagnosticOnly: true,
    scope:
      'Actual Platform requests and callbacks; no additional frame, timer, poll or GL work. Not FPS acceptance.',
    clock: FRAME_CLOCK,
    startMs,
    endMs,
    capacity,
    count,
    coverage: { clockErrors, observationErrors, cancelWrappingFailures, restored },
    overflow: { dropped, firstDroppedAtMs, lastDroppedAtMs },
    events: Array.from({ length: count }, (_, index) => {
      const offset = index * 4;
      return {
        kind: kinds[values[offset]],
        atMs: values[offset + 1],
        requestId: values[offset + 2],
        scheduledAtMs: values[offset + 3],
      };
    }),
  });
  const restore = () => {
    if (!restored && platform) {
      if (platform.requestFrame === wrappedRequest)
        Object.defineProperty(platform, 'requestFrame', requestDescriptor);
      else observationErrors++;
    }
    restored = true;
    // An outer diagnostic may still own these methods; restore only our hooks.
    if (observer.observeOptions === observeOptions) observer.observeOptions = originalObserve;
    if (observer.arm === arm) observer.arm = originalArm;
    if (observer.drain === drain) observer.drain = originalDrain;
  };
  const drain = async function (...args) {
    try {
      const result = await apply(originalDrain, this, args);
      restore();
      return { ...result, frameTiming: snapshot() };
    } finally {
      restore();
    }
  };
  observer.observeOptions = observeOptions;
  observer.arm = arm;
  observer.drain = drain;
  return { snapshot, restore };
}
