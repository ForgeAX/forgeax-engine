let received = false;
worker.onMessage((data) => {
  if (received) return;
  received = true;
  const result = { id: data?.id, runId: data?.runId, facts: {
    requestAnimationFrame: typeof requestAnimationFrame, WebAssembly: typeof WebAssembly,
    WXWebAssembly: typeof WXWebAssembly, SharedArrayBuffer: typeof SharedArrayBuffer,
    MessageChannel: typeof MessageChannel, Atomics: typeof Atomics,
    atomicsWait: typeof Atomics === 'object' && Atomics !== null ? typeof Atomics.wait : 'undefined',
    workerCreateWorker: typeof worker.createWorker, getFileSystemManager: typeof worker.getFileSystemManager,
    gpu: typeof navigator === 'object' && navigator !== null ? typeof navigator.gpu : 'undefined',
  }, errors: [] };
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    try { worker.postMessage(result); }
    catch (error) { console.error('[forgeax.worker.reply-failed]', String(error)); }
  };
  const fail = (error) => { result.errors.push(String(error?.message ?? error).slice(0, 1024)); finish(); };
  try {
    result.bufferBytes = data.buffer.byteLength;
    result.bufferValues = Array.from(new Uint8Array(data.buffer));
    if (data.shared) {
      result.sharedName = data.shared.constructor?.name;
      result.sharedAtomicAccess = typeof Atomics === 'object' && Atomics !== null
        && typeof Atomics.store === 'function' && typeof Atomics.load === 'function';
      if (result.sharedAtomicAccess) {
        const view = new Int32Array(data.shared);
        Atomics.store(view, data.id, 100 + data.id);
        result.sharedReadback = Atomics.load(view, data.id);
      }
    }
    if (!data.canvas) { finish(); return; }
    const gl = data.canvas.getContext('webgl2');
    result.webgl2 = Boolean(gl);
    if (!gl) { finish(); return; }
    result.glVersion = gl.getParameter(gl.VERSION);
    result.glRenderer = gl.getParameter(gl.RENDERER);
    result.drawCalls = 0;
    result.rafCallbacks = 0;
    const hasRaf = typeof requestAnimationFrame === 'function';
    function frame() {
      if (ended) return;
      try {
        if (hasRaf) result.rafCallbacks++;
        gl.clearColor(0.25, 0.75, 0.125, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        result.drawCalls++;
        if (hasRaf && result.drawCalls < 60) { requestAnimationFrame(frame); return; }
        const pixel = new Uint8Array(4);
        gl.readPixels(128, 128, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        result.pixel = Array.from(pixel); result.glError = gl.getError();
        result.pixelPassed = Math.abs(pixel[0] - 64) <= 1 && Math.abs(pixel[1] - 191) <= 1
          && Math.abs(pixel[2] - 32) <= 1 && pixel[3] === 255 && result.glError === 0;
        // A final readback checks this clear workload, not 60 Renderer completions or FPS.
        finish();
      } catch (error) { fail(error); }
    }
    if (hasRaf) requestAnimationFrame(frame); else frame();
  } catch (error) { fail(error); }
});
