/**
 * Collect one synchronous host callback per profiler frame. readFrame should
 * return readThreeFrame(renderer) from the ForgeaX Three facade.
 */
export function createThreeFrameCapture({
  profiler,
  readFrame,
  frameLimit,
  eventLimit = 24_000,
  detail = 'nested',
  now = () => performance.now(),
}) {
  const session = unwrap(profiler.startCapture({ frameLimit, eventLimit, detail }));
  const frames = [];
  const pending = [];
  let recording = false;
  let finished;

  function recordFrame(callback) {
    if (finished !== undefined || frames.length >= frameLimit || recording)
      throw new Error('Cannot record another Three frame');

    const profileFrame = unwrap(session.beginFrame());
    const beginMs = now();
    const row = { profileFrame, beginMs, cpuMs: null, phases: [], submission: null };
    frames.push(row);
    recording = true;

    function measure(phase, action) {
      if (!recording || frames.at(-1) !== row)
        throw new Error('Measure must run inside its owning frame callback');
      const startMs = now();
      try {
        return action();
      } finally {
        row.phases.push({ phase, startMs, endMs: now() });
      }
    }

    let returned;
    try {
      returned = callback(measure);
      if (typeof returned?.then === 'function')
        throw new Error('Three frame capture expects a synchronous callback');
    } catch (error) {
      row.callbackError = errorFact(error);
      throw error;
    } finally {
      row.cpuMs = now() - beginMs;
      recording = false;
      unwrap(session.endFrame());
    }

    const frame = readFrame();
    const receipt = frame?.receipt;
    if (
      receipt?.profileFrame?.captureId !== profileFrame.captureId ||
      receipt.profileFrame.frameId !== profileFrame.frameId
    )
      return returned;

    const submission = {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
      pendingReason: receipt.presentationPendingReason,
      passCpuIdentities: receipt.renderPassCpuIdentities,
      passCpuIdentitiesComplete: receipt.renderPassCpuIdentitiesComplete,
      completion: { status: 'unsettled' },
      observation: { status: 'unsettled' },
    };
    row.submission = submission;
    pending.push(
      receipt.completed.then(
        (result) => {
          const atMs = now();
          submission.completion = result.ok
            ? { status: 'complete', atMs }
            : { status: 'failed', atMs, error: errorFact(result.error) };
        },
        (error) => {
          submission.completion = { status: 'failed', atMs: now(), error: errorFact(error) };
        },
      ),
    );
    if (receipt.presentation === 'ready') {
      pending.push(
        frame.observe({ include: ['timings'] }).then(
          (result) => {
            submission.observation = result.ok
              ? { status: 'observed', timings: result.value.timings }
              : { status: 'failed', error: errorFact(result.error) };
          },
          (error) => {
            submission.observation = { status: 'failed', error: errorFact(error) };
          },
        ),
      );
    } else submission.observation = { status: 'presentation-pending' };
    return returned;
  }

  function finish({ timeoutMs = 10_000 } = {}) {
    if (recording) throw new Error('Finish after the current callback returns');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('A finite positive observation timeout is required');
    finished ??= finishCapture(timeoutMs);
    return finished;
  }

  async function finishCapture(timeoutMs) {
    const cpu = unwrap(session.finish());
    let timer;
    try {
      const observationComplete = await Promise.race([
        Promise.all(pending).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      return {
        kind: 'three-frame-capture',
        timeUnit: 'ms',
        observationComplete,
        cpu,
        frames: structuredClone(frames),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    recordFrame,
    finish,
    get attempted() {
      return frames.length;
    },
  };
}

function unwrap(result) {
  if (!result.ok) throw result.error;
  return result.value;
}

function errorFact(error) {
  return { code: error?.code, message: error?.message ?? String(error), detail: error?.detail };
}
