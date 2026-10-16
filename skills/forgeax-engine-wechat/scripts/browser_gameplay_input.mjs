/** Self-contained: install before game scripts with page.addInitScript(fn, options). */
export function installBrowserGameplayInput(options) {
  options ??= {};
  const host = globalThis;
  const globalName = options.globalName ?? '__forgeaxGameplayInput';
  const capacity = options.capacity ?? 16384;
  if (typeof globalName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(globalName))
    throw new Error('Gameplay input observation requires a JavaScript global identifier');
  if (!Number.isSafeInteger(capacity) || capacity < 8 || capacity > 262144)
    throw new Error('Gameplay input capacity must be an integer in 8..262144');
  if (globalName in host) throw new Error(`Gameplay input global already exists: ${globalName}`);
  if (
    host.window !== host ||
    !host.document ||
    typeof host.PointerEvent !== 'function' ||
    host.GameGlobal?.__gameContextWindow
  )
    throw new Error(
      'Gameplay input observation requires a Browser Window; native WeChat is unsupported',
    );

  const apply = Reflect.apply,
    descriptorOf = Object.getOwnPropertyDescriptor;
  const clockOwner = host.performance,
    clock = clockOwner?.now;
  if (typeof clock !== 'function')
    throw new Error('Gameplay input observation requires performance.now');
  const addListener = host.addEventListener,
    removeListener = host.removeEventListener;
  const pointerTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
  const fields = {
    look: ['x', 'y'],
    move: ['horizontal', 'vertical'],
    run: ['held'],
    reset: [],
    jump: [],
  };
  const events = [],
    portIds = new WeakMap(),
    unavailableHooks = [],
    restoreConflicts = [];
  const portPrototype = host.MessagePort?.prototype;
  const descriptor = portPrototype && descriptorOf(portPrototype, 'postMessage');
  let wrapper, api;
  let active = false,
    restored = false,
    installedPointerListeners = 0,
    nextPortId = 0;
  let startMs = null,
    stopMs = null,
    droppedEvents = 0,
    firstDroppedAtMs = null,
    lastDroppedAtMs = null;
  let clockErrors = 0,
    observationErrors = 0,
    unreadableControlMessages = 0,
    unknownControlKinds = 0;
  let pointerEvents = 0,
    controlMessages = 0,
    droppedPointers = 0,
    droppedMessages = 0;
  const objectLike = (value) =>
    value !== null && (typeof value === 'object' || typeof value === 'function');
  function now() {
    try {
      const value = apply(clock, clockOwner, []);
      if (Number.isFinite(value)) return value;
    } catch {
      /* Observation never replaces an application result or exception. */
    }
    clockErrors++;
    return null;
  }
  function observe(callback) {
    try {
      callback();
    } catch {
      observationErrors++;
    }
  }
  function record(event) {
    if (events.length >= capacity) {
      droppedEvents++;
      if (event.kind === 'pointer') droppedPointers++;
      else droppedMessages++;
      firstDroppedAtMs ??= event.atMs;
      lastDroppedAtMs = event.atMs;
      return;
    }
    events.push({ sequence: events.length, ...event });
  }
  function pointer(event) {
    if (!active || restored) return;
    observe(() => {
      pointerEvents++;
      record({
        kind: 'pointer',
        atMs: now(),
        type: event.type,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
        eventTimeStamp: event.timeStamp,
        trusted: event.isTrusted,
      });
    });
  }
  // Observe only own data fields. Reading accessors a second time could change
  // application behavior; unknown envelopes and payload fields are never copied.
  function control(value) {
    if (!objectLike(value)) return null;
    const channel = descriptorOf(value, 'channel');
    if (!channel || !Object.hasOwn(channel, 'value') || channel.value !== 'game-3d/player-controls')
      return null;
    const kind = descriptorOf(value, 'kind');
    if (!kind || !Object.hasOwn(kind, 'value')) {
      unreadableControlMessages++;
      return null;
    }
    if (typeof kind.value !== 'string' || !Object.hasOwn(fields, kind.value)) {
      unknownControlKinds++;
      return null;
    }
    const data = { kind: kind.value };
    for (const name of fields[kind.value]) {
      const property = descriptorOf(value, name);
      if (
        !property ||
        !Object.hasOwn(property, 'value') ||
        (name === 'held' ? typeof property.value !== 'boolean' : !Number.isFinite(property.value))
      ) {
        unreadableControlMessages++;
        return null;
      }
      data[name] = property.value;
    }
    return data;
  }
  if (!descriptor || typeof descriptor.value !== 'function') {
    unavailableHooks.push({
      name: 'MessagePort.prototype.postMessage',
      reason: 'missing-data-method',
    });
  } else {
    const original = descriptor.value;
    wrapper = function (...args) {
      if (!active || restored) return apply(original, this, args);
      const atMs = now();
      let threw = true;
      try {
        const result = apply(original, this, args);
        threw = false;
        return result;
      } finally {
        observe(() => {
          const data = control(args[0]);
          if (!data) return;
          let portId = 0;
          if (objectLike(this)) {
            portId = portIds.get(this);
            if (portId === undefined) {
              portId = ++nextPortId;
              portIds.set(this, portId);
            }
          }
          controlMessages++;
          record({ kind: 'control-message', atMs, endMs: now(), portId, threw, control: data });
        });
      }
    };
    try {
      Object.defineProperty(portPrototype, 'postMessage', { ...descriptor, value: wrapper });
    } catch {
      wrapper = null;
      unavailableHooks.push({
        name: 'MessagePort.prototype.postMessage',
        reason: 'method-not-replaceable',
      });
    }
  }
  try {
    for (const type of pointerTypes) {
      apply(addListener, host, [type, pointer, { capture: true, passive: true }]);
      installedPointerListeners++;
    }
  } catch {
    unavailableHooks.push({
      name: 'window pointer capture listeners',
      reason: 'listener-install-failed',
    });
  }

  function snapshot() {
    return {
      schemaVersion: 'forgeax-browser-gameplay-input/1',
      state: restored
        ? 'restored'
        : active
          ? 'recording'
          : startMs === null
            ? 'installed'
            : 'stopped',
      scope:
        'Passive Browser Window pointer dispatch and current-realm MessagePort sends; not game consumption or native WeChat input.',
      clock: 'performance.now',
      timeOrigin: Number.isFinite(clockOwner.timeOrigin) ? clockOwner.timeOrigin : null,
      startMs,
      stopMs,
      capacity,
      recordedEvents: events.length,
      observed: { pointerEvents, controlMessages },
      overflow: {
        droppedEvents,
        droppedPointers,
        droppedMessages,
        firstAtMs: firstDroppedAtMs,
        lastAtMs: lastDroppedAtMs,
      },
      coverage: {
        pointerCapture: 'window',
        pointerListeners: installedPointerListeners,
        messageChannel: 'game-3d/player-controls',
        messageHook: 'current-realm MessagePort.prototype.postMessage',
        unavailableHooks: unavailableHooks.map((row) => ({ ...row })),
        restoreConflicts: restoreConflicts.map((row) => ({ ...row })),
        clockErrors,
        observationErrors,
        unreadableControlMessages,
        unknownControlKinds,
        exclusions:
          'Other channels, non-data or invalid control fields, Worker/iframe realms, saved pre-install methods, coalesced samples, message delivery and game consumption are not observed.',
      },
      events: events.map((row) => ({
        ...row,
        ...(row.control ? { control: { ...row.control } } : {}),
      })),
    };
  }
  api = {
    start() {
      if (active || restored)
        throw new Error('Gameplay input start requires installed/stopped state');
      events.length = 0;
      droppedEvents = droppedPointers = droppedMessages = pointerEvents = controlMessages = 0;
      clockErrors = observationErrors = unreadableControlMessages = unknownControlKinds = 0;
      firstDroppedAtMs = lastDroppedAtMs = stopMs = null;
      startMs = now();
      active = true;
      return {
        startMs,
        clock: 'performance.now',
        capacity,
        unavailableHooks: unavailableHooks.map((row) => ({ ...row })),
      };
    },
    stop() {
      if (active) {
        stopMs = now();
        active = false;
      }
      return snapshot();
    },
    snapshot,
    restore() {
      if (!restored) {
        api.stop();
        restored = true;
        for (const type of pointerTypes.slice(0, installedPointerListeners)) {
          try {
            apply(removeListener, host, [type, pointer, true]);
          } catch {
            restoreConflicts.push({ name: type, reason: 'listener-remove-failed' });
          }
        }
        if (wrapper) {
          try {
            if (descriptorOf(portPrototype, 'postMessage')?.value === wrapper)
              Object.defineProperty(portPrototype, 'postMessage', descriptor);
            else
              restoreConflicts.push({
                name: 'MessagePort.prototype.postMessage',
                reason: 'replaced-after-install',
              });
          } catch {
            restoreConflicts.push({
              name: 'MessagePort.prototype.postMessage',
              reason: 'restore-failed',
            });
          }
        }
        try {
          if (descriptorOf(host, globalName)?.value === api) delete host[globalName];
          else restoreConflicts.push({ name: globalName, reason: 'replaced-after-install' });
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

/** Inject before the game's scripts; this module needs no browser-side imports. */
export function browserGameplayInputSource(options = {}) {
  return `;(${installBrowserGameplayInput.toString()})(${JSON.stringify(options)});`;
}
