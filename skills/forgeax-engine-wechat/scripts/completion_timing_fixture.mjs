import { installPhoneCompletionTiming } from './phone_completion_timing.mjs';

const check = (condition, message) => {
  if (!condition) throw new Error(`Controlled completion fixture: ${message}`);
};
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

/** Private timers/Platform only; the factory must compile the actual repository driver. */
export function createControlledCompletionFixture(createDriver, { capacity = 65536 } = {}) {
  let time = 0,
    originalPromise;
  const timers = [],
    delays = [],
    callbacks = [];
  const setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    timers.push(() => callback(...args));
    return timers.length;
  };
  const target = { setTimeout };
  const originalDriver = createDriver(target, () => time);
  const observer = {
    observeOptions: (value) => value,
    arm: () => ({ startMs: 0, endMs: 1000 }),
    drain: async () => ({ status: 'complete' }),
  };
  const originalMethods = { ...observer };
  const platform = {
    now: () => ({ ok: true, value: time }),
    requestFrame(callback) {
      callbacks.push(callback);
      return { ok: true, value() {} };
    },
  };
  const originalRequest = platform.requestFrame;
  const api = installPhoneCompletionTiming(observer, { now: () => time, target, capacity });
  observer.observeOptions({ platform });
  observer.arm();
  const driver = api.driver(function (...args) {
    originalPromise = Reflect.apply(originalDriver, this, args);
    return originalPromise;
  });
  return {
    api,
    observer,
    driver,
    delays,
    timers,
    target,
    platform,
    originalMethods,
    originalRequest,
    originalTimer: setTimeout,
    originalPromise: () => originalPromise,
    at(value) {
      time = value;
    },
    async fire(value) {
      time = value;
      check(timers.length > 0, 'the real driver must schedule a timer');
      timers.shift()();
      await flush();
    },
    frame(callback) {
      platform.requestFrame(callback);
      check(callbacks.length === 1, 'one existing Platform request');
      callbacks.shift()(time);
    },
  };
}

/** Run the same scenarios in Node and a paused official game realm. Never FPS evidence. */
export async function runControlledCompletionScenarios(createDriver) {
  const scenarios = [];
  for (const name of ['late-timer', 'false-polls', 'fifo-predecessor']) {
    const fixture = createControlledCompletionFixture(createDriver);
    let polls = 0,
      frees = 0,
      release,
      settled = false;
    const previous =
      name === 'fifo-predecessor'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    const answers = name === 'false-polls' ? [false, false, true] : [true];
    let promise;
    fixture.frame(() => {
      promise = fixture.driver(
        () => ({
          poll() {
            polls++;
            return answers.shift();
          },
          free() {
            frees++;
          },
        }),
        previous,
      );
    });
    check(promise === fixture.originalPromise(), 'the original returned Promise is preserved');
    promise.then(() => {
      settled = true;
    });
    if (name === 'late-timer') await fixture.fire(20);
    else if (name === 'false-polls') {
      await fixture.fire(0);
      await fixture.fire(1);
      await fixture.fire(2);
    } else {
      await fixture.fire(0);
      check(!settled, 'ready request must still await its FIFO predecessor');
      fixture.at(30);
      release();
    }
    await promise;
    await flush();
    const capture = await fixture.observer.drain();
    check(frees === 1, 'the actual driver frees exactly once');
    check(
      JSON.stringify(fixture.delays) === JSON.stringify(name === 'false-polls' ? [0, 1, 1] : [0]),
      'original delays and timer count',
    );
    check(polls === (name === 'false-polls' ? 3 : 1), 'no extra native polls');
    check(
      capture.frameTiming?.events.some((row) => row.kind === 'callback-enter') &&
        capture.frameTiming.events.some((row) => row.kind === 'callback-exit'),
      'composed frame probe is armed and drained',
    );
    check(
      capture.frameTiming.startMs === capture.completionTiming.startMs,
      'shared observation window',
    );
    check(
      fixture.target.setTimeout === fixture.originalTimer &&
        fixture.platform.requestFrame === fixture.originalRequest,
      'native hooks restored',
    );
    for (const key of ['arm', 'drain', 'observeOptions'])
      check(fixture.observer[key] === fixture.originalMethods[key], `observer ${key} restored`);
    scenarios.push({ name, polls, frees, delays: fixture.delays, capture });
  }
  return {
    schemaVersion: 'forgeax-controlled-native-completion/1',
    status: 'passed',
    diagnosticOnly: true,
    scope:
      'Actual source driver with private controlled time, timers and Platform. Tool correctness only; no hardware timing or gameplay FPS.',
    scenarios,
  };
}
