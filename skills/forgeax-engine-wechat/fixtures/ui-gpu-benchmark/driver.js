const methods = [
  'initialize',
  'active',
  'form',
  'performance',
  'cachedPerformance',
  'backgroundControl',
];
const copy = (value) => JSON.parse(JSON.stringify(value));
export const describeBenchmarkError = (error) => ({
  ...(error && typeof error === 'object' ? error : {}),
  name: error?.name,
  message: error?.message ?? error?.code ?? String(error),
  cause: error?.cause,
});

/** Independent real startup timers must expose the same state before pixel comparison. */
export async function waitForStartupState(gpuDocument, cpuDocument, now, timeoutMs = 2000) {
  const started = now();
  const read = (document) => {
    const node = document.querySelector('#forgeax-fps');
    if (!node) throw new Error('The original startup FPS element is required');
    return { text: node.textContent, display: node.style.display };
  };
  const snapshot = () => ({ gpu: read(gpuDocument), cpu: read(cpuDocument) });
  const before = snapshot();
  let after = before;
  while (after.gpu.text !== after.cpu.text || after.gpu.display !== after.cpu.display) {
    const waitedMs = now() - started;
    if (waitedMs >= timeoutMs)
      throw Object.assign(new Error('Independent startup states did not converge before parity'), {
        code: 'ui-benchmark-startup-state-timeout',
        detail: { before, after, waitedMs, timeoutMs },
      });
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, timeoutMs - waitedMs)));
    after = snapshot();
  }
  return { before, after, waitedMs: now() - started };
}

/** Official automation starts one shared step and polls; it never holds a long CLI call. */
export function createBenchmarkDriver(probe, identity) {
  const steps = [];
  let phase = 'ready',
    mode = 'correctness',
    current = null,
    failure = null,
    cleanup = null;
  const read = () =>
    copy({
      phase,
      mode,
      current,
      next:
        phase === 'ready'
          ? mode === 'correctness' && steps.length === 3
            ? 'dispose'
            : (methods[steps.length] ?? 'dispose')
          : null,
      completed: steps.map((step) => step.method),
      identity,
      failure,
      cleanup: cleanup && { success: cleanup.success, error: cleanup.error },
      accepted:
        cleanup?.success === true &&
        failure === null &&
        steps.length === (mode === 'performance' ? methods.length : 3) &&
        steps
          .filter((step) => methods.indexOf(step.method) >= 3)
          .every((step) => step.value.pass === true),
    });
  const dispose = () => {
    if (phase === 'running' || cleanup !== null) return read();
    phase = 'running';
    current = 'dispose';
    Promise.resolve()
      .then(() => probe.dispose())
      .then(
        (facts) => {
          cleanup = { success: true, facts };
          phase = failure ? 'failed' : 'complete';
          current = null;
        },
        (error) => {
          cleanup = { success: false, error: describeBenchmarkError(error) };
          phase = 'failed';
          current = null;
        },
      );
    return read();
  };
  const startNext = () => {
    if (phase !== 'ready') return read();
    const method = mode === 'correctness' && steps.length === 3 ? undefined : methods[steps.length];
    if (!method) return dispose();
    phase = 'running';
    current = method;
    const startedAtUtc = new Date().toISOString();
    Promise.resolve()
      .then(() =>
        probe[method](
          method === 'initialize'
            ? { backend: 'wgpu-webgl2', cpuReference: true, includeComposite: true }
            : undefined,
        ),
      )
      .then(
        (value) => {
          steps.push({ method, startedAtUtc, endedAtUtc: new Date().toISOString(), value });
          phase = 'ready';
          current = null;
        },
        (error) => {
          failure = {
            method,
            startedAtUtc,
            endedAtUtc: new Date().toISOString(),
            error: describeBenchmarkError(error),
          };
          phase = 'failed';
          current = null;
        },
      );
    return read();
  };
  return {
    read,
    readStep(method) {
      return copy(steps.find((step) => step.method === method) ?? null);
    },
    readFacts: () =>
      copy(
        cleanup?.facts
          ? Object.fromEntries(
              Object.entries(cleanup.facts).filter(([key]) => !methods.includes(key)),
            )
          : null,
      ),
    startNext,
    startPerformance() {
      if (phase !== 'ready' || steps.length !== 3 || cleanup !== null) return read();
      mode = 'performance';
      return startNext();
    },
    dispose,
  };
}
