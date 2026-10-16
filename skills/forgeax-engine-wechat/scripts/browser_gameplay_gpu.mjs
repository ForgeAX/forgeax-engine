/** Self-contained opt-in diagnostic, serialized by page.addInitScript. */
export function installBrowserGameplayGpu(options) {
  // biome-ignore lint/suspicious/noRedundantUseStrict: Serialized into a classic script.
  'use strict';
  options ??= {};
  const name = options.globalName ?? '__forgeaxGameplayGpu';
  const capacity = options.capacity ?? 1024;
  if (typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name))
    throw new Error('GPU diagnostic global must be a JavaScript identifier');
  if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 16384)
    throw new Error('GPU diagnostic capacity must be an integer in 2..16384');
  if (options.now !== undefined && typeof options.now !== 'function')
    throw new Error('GPU diagnostic now must be a millisecond clock function');
  const clockName = options.clock ?? (options.now ? 'injected.now' : 'performance.now');
  if (typeof clockName !== 'string' || clockName.length === 0 || clockName.length > 80)
    throw new Error('GPU diagnostic clock must be a nonempty label of at most 80 characters');
  if (name in globalThis) throw new Error(`GPU diagnostic global already exists: ${name}`);
  const apply = Reflect.apply;
  const nativeNow = options.now ?? performance.now.bind(performance);
  const delay = globalThis.setTimeout.bind(globalThis);
  const operations = ['submit', 'present'];
  const exportNames = ['rhiwgpuqueue_submit', 'rhiwgpusurfacetexture_present'];
  const rows = new Float64Array(capacity * 8);
  const status = Array(capacity).fill('unused');
  const reasons = Array(capacity).fill(null);
  const queries = [];
  let gl, extension, projection, originals;
  let lifecycle = 'installed',
    startMs = null,
    stopMs = null,
    count = 0;
  let overflow = 0,
    observationErrors = 0,
    deletedQueries = 0,
    setupAttempts = 0;
  let invalid = null,
    collection;
  const calls = { submit: 0, present: 0 };
  let capability = {
    status: 'unavailable',
    reason: 'native-host-not-attached',
    extension: false,
    counterBits: 0,
  };

  function clock() {
    try {
      return nativeNow();
    } catch {
      observationErrors++;
      return NaN;
    }
  }
  function invalidate(reason) {
    invalid ??= reason;
    for (let index = 0; index < count; index++) {
      status[index] = 'unavailable';
      reasons[index] = invalid;
      rows[index * 8 + 6] = NaN;
    }
  }
  function healthy() {
    if (gl.isContextLost()) {
      invalidate('context-lost');
      return false;
    }
    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      invalidate('gpu-disjoint');
      return false;
    }
    return invalid === null;
  }
  function begin(index) {
    try {
      if (capability.status !== 'available' || invalid !== null) {
        reasons[index] = invalid ?? capability.reason;
        return false;
      }
      if (!healthy()) {
        reasons[index] = invalid;
        return false;
      }
      if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== null) {
        reasons[index] = 'query-owned-elsewhere';
        return false;
      }
      const query = queries[index];
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== query) {
        reasons[index] = 'query-begin-failed';
        return false;
      }
      status[index] = 'pending';
      return true;
    } catch {
      observationErrors++;
      reasons[index] = 'query-operation-failed';
      return false;
    }
  }
  function wrap(original, operation) {
    return function (...args) {
      if (lifecycle !== 'active') return apply(original, this, args);
      calls[operations[operation]]++;
      if (count === capacity) {
        overflow++;
        return apply(original, this, args);
      }
      const index = count++,
        offset = index * 8;
      rows[offset] = operation;
      rows[offset + 1] = typeof args[0] === 'number' ? args[0] : NaN;
      rows[offset + 6] = rows[offset + 7] = NaN;
      status[index] = 'unavailable';
      const started = begin(index);
      rows[offset + 2] = clock();
      let threw = true;
      try {
        const result = apply(original, this, args);
        threw = false;
        return result;
      } finally {
        rows[offset + 3] = clock();
        rows[offset + 5] = Number(threw);
        if (started) {
          try {
            if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) === queries[index])
              gl.endQuery(extension.TIME_ELAPSED_EXT);
            else {
              status[index] = 'unavailable';
              reasons[index] = 'query-ownership-changed';
            }
          } catch {
            observationErrors++;
            status[index] = 'unavailable';
            reasons[index] = 'query-operation-failed';
          }
        }
        rows[offset + 4] = clock();
      }
    };
  }
  function snapshot() {
    const finite = (value) => (Number.isFinite(value) ? value : null);
    const samples = Array.from({ length: count }, (_, index) => {
      const offset = index * 8;
      return {
        ordinal: index + 1,
        operation: operations[rows[offset]],
        nativePointer: finite(rows[offset + 1]),
        startedAtMs: rows[offset + 2],
        nativeEndedAtMs: rows[offset + 3],
        endedAtMs: rows[offset + 4],
        nativeCpuMs: rows[offset + 3] - rows[offset + 2],
        nativeThrew: rows[offset + 5] === 1,
        status: status[index],
        reason: reasons[index],
        gpuNanoseconds: finite(rows[offset + 6]),
        observedAtMs: finite(rows[offset + 7]),
      };
    });
    return {
      schemaVersion: 'forgeax-browser-gameplay-gpu/1',
      diagnosticOnly: true,
      lifecycle,
      scope:
        'Intrusive driver-reported elapsed queries around native submit and present. ANGLE Metal can split command buffers and sum their GPU lifetimes; these durations are not additive GPU busy time or ordinary-loop FPS. Not exclusive shader time, fence latency, browser composition or display timing.',
      clock: clockName,
      startMs,
      stopMs,
      capacity,
      capability: { ...capability },
      coverage: {
        calls: { ...calls },
        overflow,
        observationErrors,
        setupAttempts,
        invalid,
        allocatedQueries: queries.length,
        deletedQueries,
        available: samples.filter((row) => row.status === 'available').length,
        pending: samples.filter((row) => row.status === 'pending').length,
        unavailable: samples.filter((row) => row.status === 'unavailable').length,
      },
      samples,
    };
  }
  const api = {
    // NativeWgpuInstance is structural. Never mutate or Proxy frozen WASM exports.
    project(native, surfaces) {
      if (lifecycle === 'disposed') return native;
      if (lifecycle !== 'installed') {
        invalidate('native-host-attached-after-start');
        return native;
      }
      setupAttempts++;
      if (setupAttempts !== 1) {
        invalidate('multiple-native-instances');
        return native;
      }
      try {
        if (!Array.isArray(surfaces) || surfaces.length !== 1)
          throw new Error('requires-one-native-surface');
        originals = native.instance.exports;
        if (!exportNames.every((key) => typeof originals[key] === 'function'))
          throw new Error('native-export-abi-mismatch');
        gl = surfaces[0].getContext('webgl2');
        if (!gl) throw new Error('webgl2-unavailable');
        extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const bits = extension
          ? gl.getQuery(extension.TIME_ELAPSED_EXT, extension.QUERY_COUNTER_BITS_EXT)
          : 0;
        capability = {
          status: extension && bits > 0 ? 'available' : 'unavailable',
          extension: !!extension,
          counterBits: bits,
          reason: !extension
            ? 'timer-extension-unavailable'
            : bits > 0
              ? null
              : 'timer-counter-unavailable',
        };
        if (capability.status === 'available') {
          for (let index = 0; index < capacity; index++) {
            const query = gl.createQuery();
            if (!query) throw new Error('query-allocation-failed');
            queries.push(query);
          }
        }
        projection = Object.fromEntries(Object.entries(originals));
        exportNames.forEach((key, operation) => {
          projection[key] = wrap(originals[key], operation);
        });
        return { ...native, instance: { exports: projection } };
      } catch (error) {
        capability = {
          ...capability,
          status: 'unavailable',
          reason: error?.message ?? 'projection-failed',
        };
        invalidate(capability.reason);
        return native;
      }
    },
    start() {
      if (lifecycle !== 'installed')
        throw new Error('GPU diagnostic start requires a fresh installation');
      startMs = clock();
      lifecycle = 'active';
      return { startMs, clock: clockName, capacity, capability: { ...capability } };
    },
    stop() {
      if (lifecycle === 'active') {
        stopMs = clock();
        lifecycle = 'stopped';
      }
      return snapshot();
    },
    snapshot,
    collect({ timeoutMs = 2000, pollIntervalMs = 16 } = {}) {
      if (lifecycle !== 'stopped')
        return Promise.reject(new Error('Stop GPU diagnostic before collecting results'));
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > 30000 ||
        !Number.isFinite(pollIntervalMs) ||
        pollIntervalMs < 1 ||
        pollIntervalMs > 1000
      )
        return Promise.reject(new Error('Invalid GPU query collection bounds'));
      collection ??= (async () => {
        const deadline = clock() + timeoutMs;
        let remainingPolls = Math.ceil(timeoutMs / pollIntervalMs) + 1;
        while (
          lifecycle !== 'disposed' &&
          remainingPolls-- > 0 &&
          status.slice(0, count).includes('pending')
        ) {
          try {
            if (!healthy()) break;
            for (let index = 0; index < count; index++) {
              if (status[index] !== 'pending') continue;
              if (!gl.getQueryParameter(queries[index], gl.QUERY_RESULT_AVAILABLE)) continue;
              const value = gl.getQueryParameter(queries[index], gl.QUERY_RESULT);
              if (!healthy()) break;
              rows[index * 8 + 7] = clock();
              if (!Number.isSafeInteger(value) || value < 0) {
                status[index] = 'unavailable';
                reasons[index] = 'invalid-query-result';
              } else {
                rows[index * 8 + 6] = value;
                status[index] = 'available';
              }
            }
          } catch {
            observationErrors++;
            invalidate('query-operation-failed');
          }
          if (
            !status.slice(0, count).includes('pending') ||
            clock() >= deadline ||
            remainingPolls === 0
          )
            break;
          await new Promise((resolve) => delay(resolve, pollIntervalMs));
        }
        for (let index = 0; index < count; index++) {
          if (status[index] === 'pending') {
            status[index] = 'unavailable';
            reasons[index] = 'query-result-timeout';
          }
        }
        return snapshot();
      })();
      return collection;
    },
    dispose() {
      if (lifecycle !== 'disposed') {
        api.stop();
        lifecycle = 'disposed';
        for (let index = 0; index < count; index++) {
          if (status[index] === 'pending') {
            status[index] = 'unavailable';
            reasons[index] = 'disposed-before-result';
          }
        }
        for (const query of queries) {
          try {
            if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) === query)
              gl.endQuery(extension.TIME_ELAPSED_EXT);
            gl.deleteQuery(query);
            deletedQueries++;
          } catch {
            observationErrors++;
          }
        }
        if (projection)
          exportNames.forEach((key) => {
            projection[key] = originals[key];
          });
        if (globalThis[name] === api) delete globalThis[name];
      }
      return snapshot();
    },
  };
  Object.defineProperty(globalThis, name, { value: api, configurable: true });
  return api;
}

export function browserGameplayGpuSource(options = {}) {
  return `;(${installBrowserGameplayGpu.toString()})(${JSON.stringify(options)});`;
}
