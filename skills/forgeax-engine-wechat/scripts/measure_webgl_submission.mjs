// Diagnostic native WebGL timer. One query surrounds an entire synchronous
// submission; it never replaces GL methods or claims exclusive shader time.
const failure = (code) => Object.assign(new Error(code), { code });

export function createWebglSubmissionTimer(gl, { timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
    throw failure('invalid-query-timeout');
  const extension = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
  const bits = extension ? gl.getQuery(extension.TIME_ELAPSED_EXT, extension.QUERY_COUNTER_BITS_EXT) : 0;
  const capability = {
    extension: !!extension,
    counterBits: bits,
    scope: 'GPU elapsed interval around synchronous submission, including command-stream gaps; not exclusive shader time or frame latency.',
  };
  if (!extension || !(bits > 0)) {
    return { capability, status: 'unavailable', reason: extension ? 'timer-counter-unavailable' : 'timer-extension-unavailable', dispose() {} };
  }
  const query = gl.createQuery();
  if (!query) throw failure('query-allocation-failed');
  let busy = false, disposed = false, active = false;
  const end = () => { if (active) { gl.endQuery(extension.TIME_ELAPSED_EXT); active = false; } };
  return {
    capability,
    status: 'available',
    async measure(submit) {
      if (disposed || busy) throw failure(disposed ? 'timer-disposed' : 'query-already-pending');
      if (gl.isContextLost()) throw failure('context-lost');
      if (gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) throw failure('query-owned-elsewhere');
      if (gl.getParameter(extension.GPU_DISJOINT_EXT)) throw failure('gpu-disjoint');
      busy = true;
      try {
        const startedAtMs = performance.now();
        gl.beginQuery(extension.TIME_ELAPSED_EXT, query); active = true;
        const submissionStart = performance.now();
        let value, submissionEndedAtMs;
        try {
          value = submit();
          if (value && typeof value.then === 'function') throw failure('submission-must-be-synchronous');
        } finally { submissionEndedAtMs = performance.now(); end(); }
        const endedAtMs = performance.now();
        if (gl.getError() !== gl.NO_ERROR) throw failure('webgl-query-error');
        gl.flush(); // Publish the query end while the App is paused.
        const deadline = endedAtMs + timeoutMs;
        for (;;) {
          if (disposed) throw failure('timer-disposed');
          if (gl.isContextLost()) throw failure('context-lost');
          if (gl.getParameter(extension.GPU_DISJOINT_EXT)) throw failure('gpu-disjoint');
          if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
          if (performance.now() >= deadline) throw failure('query-result-timeout');
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const gpuNanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
        if (gl.getParameter(extension.GPU_DISJOINT_EXT)) throw failure('gpu-disjoint');
        if (!Number.isSafeInteger(gpuNanoseconds) || gpuNanoseconds <= 0) throw failure('invalid-query-result');
        return { value, gpuNanoseconds, startedAtMs, endedAtMs, observedAtMs: performance.now(), submissionCpuMs: submissionEndedAtMs - submissionStart };
      } finally { end(); busy = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      end();
      gl.deleteQuery(query);
    },
  };
}
