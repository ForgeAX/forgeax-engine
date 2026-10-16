/** Serializable, opt-in public wx evidence. Never dispatches input or observes Move. */
export function nativeReleaseWitness({ action, token }) {
  const key = '__forgeaxNativeReleaseWitness';
  const fail = (code) => ({ failure: { code } });
  if (typeof token !== 'string' || !token) return fail('native-release-token-invalid');
  const existing = globalThis[key];
  if (action !== 'install') {
    if (existing?.token !== token) return fail('native-release-witness-replaced');
    if (action === 'snapshot') return existing.snapshot();
    if (action === 'release') return existing.release();
    return fail('native-release-action-invalid');
  }
  if (existing) return fail('native-release-witness-already-present');
  const game = globalThis.GameGlobal?.__gameContextWindow;
  const source = game?.wx,
    inspection = game?.__forgeaxGameInspection,
    observer = game?.__gameplayBenchmark;
  const clock = globalThis.performance,
    clockNow = clock?.now;
  const names = ['Start', 'End', 'Cancel'];
  const methods = Object.fromEntries(
    names.flatMap((name) =>
      [`onTouch${name}`, `offTouch${name}`].map((method) => [method, source?.[method]]),
    ),
  );
  if (
    !game ||
    !inspection ||
    !observer ||
    typeof clockNow !== 'function' ||
    Object.values(methods).some((fn) => typeof fn !== 'function')
  )
    return fail('native-release-api-unavailable');
  const events = [],
    leases = [];
  let active = new Set(),
    eventCount = 0,
    starts = 0,
    released = false,
    failure = null,
    firstAnomaly = null;
  const identity = () => {
    if (
      globalThis[key] !== witness ||
      globalThis.GameGlobal?.__gameContextWindow !== game ||
      game.wx !== source ||
      game.__forgeaxGameInspection !== inspection ||
      game.__gameplayBenchmark !== observer ||
      globalThis.performance !== clock ||
      clock.now !== clockNow ||
      Object.entries(methods).some(([method, fn]) => source[method] !== fn)
    )
      failure ??= 'native-release-owner-changed';
  };
  const readClock = () => ({ pageNowMs: clockNow.call(clock), utcMs: Date.now() });
  const snapshot = () => ({
    source: 'public-wx-start-end-cancel',
    token,
    released,
    failure,
    firstAnomaly: firstAnomaly && JSON.parse(JSON.stringify(firstAnomaly)),
    starts,
    clock: readClock(),
    eventCount,
    ringCapacity: 16,
    discardedEvents: Math.max(0, eventCount - events.length),
    active: [...active],
    events: events.map((event) => ({
      ...event,
      changed: [...event.changed],
      active: [...event.active],
    })),
    nativeReleased:
      !failure &&
      !released &&
      starts > 0 &&
      active.size === 0 &&
      ['End', 'Cancel'].includes(events.at(-1)?.phase),
  });
  const witness = {
    token,
    clock() {
      identity();
      return { ...readClock(), failure };
    },
    snapshot() {
      identity();
      return snapshot();
    },
    release() {
      identity();
      for (let index = leases.length - 1; index >= 0; index--) {
        const [name, listener] = leases[index];
        try {
          methods[`offTouch${name}`].call(source, listener);
          leases.splice(index, 1);
        } catch {
          failure ??= 'native-release-observer-cleanup-failed';
        }
      }
      released = leases.length === 0;
      if (released && globalThis[key] === witness) delete globalThis[key];
      return snapshot();
    },
  };
  const ids = (points) => {
    if (
      !Array.isArray(points) ||
      points.length > 8 ||
      points.some((point) => !Number.isSafeInteger(point?.identifier))
    )
      return null;
    const result = points.map((point) => point.identifier);
    return new Set(result).size === result.length ? result : null;
  };
  const boundedValue = (value) => {
    if (typeof value === 'string')
      return value.length <= 128
        ? value
        : { type: 'string', prefix: value.slice(0, 128), length: value.length };
    if (typeof value === 'number')
      return Number.isFinite(value) ? value : { type: 'number', value: String(value) };
    return value === null || typeof value === 'boolean' ? value : { type: typeof value };
  };
  const rawTouches = (points) =>
    Array.isArray(points)
      ? {
          length: points.length,
          truncated: points.length > 8,
          points: points.slice(0, 8).map((point) => {
            if (!point || typeof point !== 'object') return { value: boundedValue(point) };
            return Object.fromEntries(
              ['identifier', 'clientX', 'clientY', 'pageX', 'pageY', 'x', 'y', 'force']
                .filter((key) => point[key] !== undefined)
                .map((key) => [key, boundedValue(point[key])]),
            );
          }),
        }
      : { type: typeof points };
  const rejectTouch = (code, phase, event) => {
    if (failure) return;
    failure = code;
    const observed = readClock();
    firstAnomaly = {
      code,
      phase,
      afterEventCount: eventCount,
      pageNowMs: observed.pageNowMs,
      atUtcMs: observed.utcMs,
      nativeTimestamp: Number.isFinite(event?.timeStamp) ? event.timeStamp : null,
      priorActive: [...active],
      changedTouches: rawTouches(event?.changedTouches),
      touches: rawTouches(event?.touches),
    };
  };
  globalThis[key] = witness;
  try {
    for (const name of names) {
      const listener = (event) => {
        identity();
        if (failure || released) return;
        const changed = ids(event?.changedTouches),
          remaining = ids(event?.touches);
        if (!changed || changed.length === 0 || !remaining) {
          rejectTouch('native-release-invalid-touch-batch', name, event);
          return;
        }
        const next = new Set(active);
        for (const id of changed) {
          if (name === 'Start') {
            if (next.has(id)) {
              rejectTouch('native-release-duplicate-start', name, event);
              return;
            }
            next.add(id);
          } else {
            if (!next.delete(id)) {
              rejectTouch('native-end-without-start', name, event);
              return;
            }
          }
        }
        if (
          next.size > 8 ||
          next.size !== remaining.length ||
          remaining.some((id) => !next.has(id))
        ) {
          rejectTouch('native-release-active-list-mismatch', name, event);
          return;
        }
        active = next;
        if (name === 'Start') starts++;
        eventCount++;
        if (events.length === 16) events.shift();
        const observed = readClock();
        events.push({
          phase: name,
          pageNowMs: observed.pageNowMs,
          atUtcMs: observed.utcMs,
          nativeTimestamp: Number.isFinite(event.timeStamp) ? event.timeStamp : null,
          changed,
          active: remaining,
        });
      };
      leases.push([name, listener]);
      methods[`onTouch${name}`].call(source, listener);
    }
  } catch {
    const cleanup = witness.release();
    return { failure: { code: 'native-release-install-failed', detail: cleanup } };
  }
  return { installed: true, token, source: 'public-wx-start-end-cancel' };
}
