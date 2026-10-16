/** Observation only: the original App owns update, scheduling and submission. */
export function createGameplayObserver({ schedule = setTimeout, cancel = clearTimeout } = {}) {
  let platform, app, renderer, hostIdentity, worldIdentity, unsubscribe;
  let latestReceipt,
    latestFrame = -1,
    latestDevice,
    latestWorld,
    latestHost;
  let readyCompletions = 0,
    active = false,
    armed = false,
    ended = false,
    timer;
  let startMs = 0,
    endMs = 0,
    endedAtMs = 0,
    phases,
    capacity = 0,
    length = 0;
  let times,
    frames,
    kinds,
    phaseIndices,
    failure = null,
    captureIdentity;
  let lastClock = -Infinity,
    phaseIndex = 0,
    lastCompletionFrame = -1;
  let postEndSubmissions = 0,
    postEndCompletions = 0;
  const fail = (code) => {
    if (failure === null) failure = code;
  };
  const clock = () => {
    const result = platform.now();
    if (!result.ok || !Number.isFinite(result.value) || result.value < lastClock) {
      fail('invalid-clock');
      return NaN;
    }
    lastClock = result.value;
    return result.value;
  };
  function finish() {
    if (!armed || ended) return;
    endedAtMs = clock();
    active = false;
    ended = true;
    cancel(timer);
  }
  function record(kind, detail, host) {
    if (!armed) return;
    const at = clock();
    if (ended) {
      if (kind === 1) postEndSubmissions++;
      else postEndCompletions++;
      return;
    }
    if (at >= endMs) {
      finish();
      return;
    }
    if (at < startMs) return;
    active = true;
    if (!platform.visible()) fail('hidden');
    if (
      host !== captureIdentity.host ||
      detail.worldIdentity !== captureIdentity.world ||
      detail.deviceGeneration !== captureIdentity.device
    ) {
      fail('identity-mismatch');
      return;
    }
    if (!Number.isSafeInteger(detail.frameId) || detail.frameId < 0) {
      fail('invalid-frame-id');
      return;
    }
    if (kind === 2 && detail.presentation !== 'ready') {
      fail('non-ready-completion');
      return;
    }
    if (kind === 2 && detail.frameId <= lastCompletionFrame) {
      fail('completion-order');
      return;
    }
    if (length >= capacity) {
      fail('overflow');
      return;
    }
    while (phaseIndex + 1 < phases.length && at - startMs >= phases[phaseIndex].endMs) phaseIndex++;
    times[length] = at;
    frames[length] = detail.frameId;
    kinds[length] = kind;
    phaseIndices[length] = phaseIndex;
    length++;
    if (kind === 2) lastCompletionFrame = detail.frameId;
  }
  return {
    observeOptions(options, host) {
      if (armed) fail('host-rebound');
      platform = options.platform;
      renderer = options.renderer;
      hostIdentity = host;
      worldIdentity = options.world.identity;
      const submitted = options.onFrameSubmitted,
        completed = options.onFrameCompleted;
      if (typeof submitted !== 'function' || typeof completed !== 'function')
        throw new Error('Existing App callbacks required');
      return {
        ...options,
        onFrameSubmitted(detail) {
          latestReceipt = detail.receipt;
          record(1, detail, host);
          submitted(detail);
        },
        onFrameCompleted(detail) {
          record(2, detail, host);
          if (detail.presentation === 'ready') {
            readyCompletions++;
            latestFrame = detail.frameId;
            latestDevice = detail.deviceGeneration;
            latestWorld = detail.worldIdentity;
            latestHost = host;
          }
          completed(detail);
        },
      };
    },
    bindApp(value) {
      if (armed) fail('app-rebound');
      app = value;
      app.onError(() => fail('app-error'));
      unsubscribe?.();
      unsubscribe = platform
        .subscribe((event) => {
          if (!armed || ended) return;
          if (event.kind === 'visibility' && !event.visible) fail('hidden');
          if (event.kind === 'display' || event.kind === 'surface-lost') fail('surface-changed');
        })
        .unwrap();
      return value;
    },
    status() {
      if (active && !ended) throw new Error('No inspection during timed window');
      return { bound: !!app, readyCompletions, latestFrame, failure, armed, ended };
    },
    arm({ phases: requestedPhases, durationMs, delayMs = 1000, maxEvents = 65536 }) {
      if (
        !app ||
        armed ||
        failure ||
        readyCompletions < 60 ||
        latestWorld !== worldIdentity ||
        latestHost !== hostIdentity ||
        !platform.visible()
      )
        throw new Error('Observer not ready for an isolated capture');
      if (
        !Number.isSafeInteger(maxEvents) ||
        maxEvents < 1 ||
        maxEvents > 262144 ||
        !Number.isFinite(durationMs) ||
        durationMs <= 0 ||
        durationMs > 120000 ||
        !Number.isFinite(delayMs) ||
        delayMs < 100
      )
        throw new Error('Invalid bounded capture');
      let boundary = 0;
      for (const phase of requestedPhases) {
        if (phase.startMs !== boundary || !(phase.endMs > boundary))
          throw new Error('Invalid capture phases');
        boundary = phase.endMs;
      }
      if (boundary !== durationMs) throw new Error('Capture phases must cover duration');
      phases = requestedPhases;
      capacity = maxEvents;
      times = new Float64Array(capacity);
      frames = new Float64Array(capacity);
      kinds = new Uint8Array(capacity);
      phaseIndices = new Uint8Array(capacity);
      captureIdentity = { host: hostIdentity, world: worldIdentity, device: latestDevice };
      startMs = clock() + delayMs;
      endMs = startMs + durationMs;
      armed = true;
      timer = schedule(finish, delayMs + durationMs);
      return { startMs, endMs, nowMs: clock(), identity: captureIdentity };
    },
    abort() {
      if (!armed || ended) return;
      fail('interrupted');
      finish();
    },
    async drain({ timeoutMs = 10000 } = {}) {
      if (!armed || !ended) throw new Error('Drain is allowed only after timed capture ends');
      app.pause().unwrap();
      const receipt = latestReceipt;
      let timeout;
      let drainFailure = null;
      try {
        if (!receipt || typeof receipt.completed?.then !== 'function')
          throw new Error('Actual last submission receipt is missing');
        const result = await Promise.race([
          receipt.completed,
          new Promise((_, reject) => {
            timeout = schedule(() => reject(new Error('Receipt completion timed out')), timeoutMs);
          }),
        ]);
        if (!result.ok) throw new Error('Last receipt completed with an error');
      } catch (error) {
        drainFailure = error.message;
        fail('drain-failed');
      } finally {
        cancel(timeout);
      }
      // Queued completion callbacks run before this continuation. Inspection is
      // intentionally deferred until the App no longer submits.
      const rendererState = renderer.inspect();
      if (rendererState.frame?.pendingCompletionCount !== 0) fail('pending-completions');
      if (latestFrame !== receipt?.frameId) fail('outstanding-frame');
      if (
        latestHost !== captureIdentity.host ||
        latestWorld !== captureIdentity.world ||
        latestDevice !== captureIdentity.device
      )
        fail('identity-mismatch');
      if (app.lastError) fail('app-error');
      return {
        schemaVersion: 'forgeax-gameplay-capture/1',
        status: failure ? 'partial' : 'complete',
        failure,
        startMs,
        endMs,
        endedAtMs,
        phases,
        identity: captureIdentity,
        events: Array.from({ length }, (_, index) => ({
          atMs: times[index],
          frameId: frames[index],
          kind: kinds[index] === 1 ? 'submitted' : 'completed',
          phase: phaseIndices[index],
        })),
        capacity,
        postEndSubmissions,
        postEndCompletions,
        drain: {
          success: drainFailure === null,
          error: drainFailure,
          lastSubmittedFrame: receipt?.frameId,
          lastCompletedFrame: latestFrame,
          renderer: rendererState,
        },
      };
    },
  };
}
