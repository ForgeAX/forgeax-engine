/**
 * Bounded live diagnostic. Evaluate the exported function in the game realm with
 * { canvas, readReceipt }. It observes existing GL calls, never issues GL queries,
 * schedules frames, changes pixels or owns the device. Read report()/read() before
 * release(). The two unhooked windows expose instrumentation overhead.
 */
export function installLiveWebglProbe(options = {}) {
  const root = options.root ?? globalThis, key = '__forgeaxLiveWebglProbe';
  if (root[key]) return { status: 'already-installed' };
  const canvas = options.canvas, readReceipt = options.readReceipt;
  if (!canvas || typeof readReceipt !== 'function') return { status: 'unavailable', reason: 'explicit-canvas-and-receipt-required' };
  let gl;
  try { gl = canvas.getContext('webgl2'); } catch { /* handled below */ }
  if (!gl || typeof gl.fenceSync !== 'function' || typeof gl.clientWaitSync !== 'function') return { status: 'unavailable', reason: 'webgl2-fence-required' };
  const now = () => root.performance.now();
  const startedAtMs = now(), startedAtUtcMs = Date.now(), deadlineMs = startedAtMs + 20000;
  const durations = [2000, 3000, 2000], phaseNames = ['control-before', 'instrumented', 'control-after'];
  const segments = [], receipts = [], windows = [], errors = [], hooks = [];
  const fences = new WeakMap();
  let phaseIndex = 0, status = 'running', stopReason, current, initial, latest;
  let timer, deadline, frameSerial = 0, restoreFailures = 0, skippedPrefix = false;
  const error = (stage, value) => { if (errors.length < 8) errors.push({ stage, message: String(value?.message ?? value).slice(0, 200) }); };
  function snapshot() {
    const value = readReceipt();
    if (!value || typeof value.then === 'function') throw Error('synchronous Renderer receipt required');
    const s = { atMs: now(), utcMs: Date.now(), generation: value.generation, phase: value.phase, completed: value.completed, presented: value.presented,
      frameId: value.frame?.frameId, deviceGeneration: value.frame?.deviceGeneration,
      pendingCompletionCount: value.frame?.pendingCompletionCount,
      completedFrameId: value.lastCompletion?.frameId, presentation: value.lastCompletion?.presentation,
      width: canvas.width, height: canvas.height };
    if (![s.completed, s.presented, s.frameId, s.completedFrameId, s.deviceGeneration, s.width, s.height].every(Number.isFinite) || s.phase !== 'ready') throw Error('ready Renderer receipt required');
    return s;
  }
  function restore() {
    for (const h of hooks.splice(0).reverse()) {
      try {
        if (Object.getOwnPropertyDescriptor(gl, h.name)?.value !== h.wrapper) { restoreFailures++; error('restore-conflict', h.name); }
        else if (h.descriptor) Object.defineProperty(gl, h.name, h.descriptor);
        else if (!Reflect.deleteProperty(gl, h.name)) throw Error('restore-delete-failed');
      } catch (cause) { restoreFailures++; error('restore', cause); }
    }
  }
  function finish(next, reason) {
    if (status !== 'running') return;
    restore(); status = restoreFailures ? 'restore-failed' : next; stopReason = reason;
    root.clearTimeout(timer); root.clearTimeout(deadline);
  }
  function observe() {
    const s = snapshot();
    if (initial && (s.generation !== initial.generation || s.deviceGeneration !== initial.deviceGeneration || s.width !== initial.width || s.height !== initial.height || s.completed < latest.completed || s.presented < latest.presented)) throw Error('generation-extent-or-counter-changed');
    if (!latest || s.completed !== latest.completed || s.frameId !== latest.frameId) {
      if (receipts.length >= 512) throw Error('receipt-limit');
      s.previousAtMs = latest?.atMs; s.completedDelta = latest ? s.completed - latest.completed : null;
      receipts.push(s);
    }
    latest = s;
    for (const frame of segments) {
      if (frame.completion || frame.frameId === undefined || s.completedFrameId < frame.frameId || s.presentation !== 'ready') continue;
      frame.completion = { atMs: s.atMs, completedFrameId: s.completedFrameId, exact: s.completedFrameId === frame.frameId };
    }
    return s;
  }
  function hook(name, wrapper) {
    const descriptor = Object.getOwnPropertyDescriptor(gl, name);
    if (descriptor && !('value' in descriptor)) throw Error('accessor:' + name);
    Object.defineProperty(gl, name, descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, configurable: true, writable: true });
    hooks.push({ name, descriptor, wrapper });
  }
  function install() {
    const methods = ['bindBuffer', 'bindBufferBase', 'bindBufferRange', 'bufferData', 'bufferSubData', 'copyBufferSubData',
      'bindTexture', 'activeTexture', 'bindSampler', 'texImage2D', 'texSubImage2D', 'texSubImage3D',
      'bindFramebuffer', 'framebufferTexture2D', 'framebufferTextureLayer', 'blitFramebuffer', 'invalidateFramebuffer',
      'bindVertexArray', 'useProgram', 'viewport', 'scissor', 'enable', 'disable', 'depthMask', 'depthFunc',
      'colorMask', 'blendFuncSeparate', 'blendEquationSeparate', 'drawBuffers', 'pixelStorei',
      'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi',
      'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i',
      'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform1iv', 'uniformMatrix4fv',
      'drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements', 'flush'];
    for (const name of methods) {
      const original = gl[name]; if (typeof original !== 'function') continue;
      hook(name, function (...args) {
        if (this !== gl || status !== 'running' || phaseIndex !== 1) return Reflect.apply(original, this, args);
        const begin = now();
        current ??= { serial: frameSerial++, firstCallAtMs: begin, lastCallAtMs: begin, glCpuMs: 0, calls: 0, draws: 0, methods: {} };
        const frame = current;
        try { return Reflect.apply(original, this, args); }
        catch (cause) { error('native:' + name, cause); finish('aborted', 'native-call-threw'); throw cause; }
        finally {
          const end = now(), dt = end - begin;
          frame.lastCallAtMs = end; frame.glCpuMs += dt; frame.calls++;
          if (name !== 'flush') { frame.firstNonFlushAtMs ??= begin; frame.lastNonFlushAtMs = end; }
          if (name.startsWith('draw') && name !== 'drawBuffers') frame.draws++;
          const row = frame.methods[name] ??= { count: 0, cpuMs: 0 };
          row.count++; row.cpuMs += dt;
        }
      });
    }
    const originalFence = gl.fenceSync;
    hook('fenceSync', function (...args) {
      if (this !== gl || status !== 'running' || phaseIndex !== 1) return Reflect.apply(originalFence, this, args);
      const begin = now(); let sync;
      try { sync = Reflect.apply(originalFence, this, args); }
      catch (cause) { error('native:fenceSync', cause); finish('aborted', 'native-call-threw'); throw cause; }
      if (sync === null) { finish('aborted', 'null-fence'); return sync; }
      const frame = current; current = undefined;
      if (!skippedPrefix) { skippedPrefix = true; return sync; }
      if (!frame) { finish('aborted', 'fence-without-observed-gl-work'); return sync; }
      frame.fenceCalledAtMs = begin; frame.fenceReturnedAtMs = now(); frame.fenceCpuMs = frame.fenceReturnedAtMs - begin;
      frame.submitWallMs = begin - frame.firstCallAtMs;
      frame.polls = 0; frame.timeouts = 0; frame.waitCpuMs = 0;
      if (segments.length >= 4096) { finish('aborted', 'fence-segment-limit'); return sync; }
      segments.push(frame); fences.set(sync, frame);
      root.queueMicrotask(() => {
        if (status !== 'running') return;
        try { const s = observe(); frame.frameId = s.frameId; frame.submittedReceipt = s; }
        catch (cause) { error('after-fence', cause); finish('aborted', 'receipt-failed'); }
      });
      return sync;
    });
    const originalWait = gl.clientWaitSync;
    hook('clientWaitSync', function (...args) {
      const frame = this === gl ? fences.get(args[0]) : undefined;
      if (!frame || status !== 'running') return Reflect.apply(originalWait, this, args);
      const begin = now(); let result;
      try { result = Reflect.apply(originalWait, this, args); }
      catch (cause) { error('native:clientWaitSync', cause); finish('aborted', 'native-call-threw'); throw cause; }
      const end = now(); frame.polls++; frame.waitCpuMs += end - begin; frame.firstPollAtMs ??= begin; frame.lastPollAtMs = begin;
      // WebGL2 status constants: no getParameter/getSyncParameter/query calls.
      if (result === 0x911b) frame.timeouts++;
      else if (result === 0x911a || result === 0x911c) frame.signaledAtMs ??= end;
      else { frame.otherStatus = result; finish('aborted', 'unexpected-fence-status'); }
      return result;
    });
  }
  function poll() {
    if (status !== 'running') return;
    try {
      for (const h of hooks) if (Object.getOwnPropertyDescriptor(gl, h.name)?.value !== h.wrapper) throw Error('method-replaced');
      const s = observe(), window = windows[phaseIndex];
      if (s.atMs - window.start.atMs >= durations[phaseIndex]) {
        window.end = s;
        if (phaseIndex === 2) { finish(segments.length ? 'complete' : 'aborted', segments.length ? 'restored-control-observed' : 'no-observed-fences'); return; }
        phaseIndex++;
        if (phaseIndex === 1) install(); else { current = undefined; restore(); }
        windows.push({ phase: phaseNames[phaseIndex], start: snapshot() });
      }
      timer = root.setTimeout(poll, 10);
    } catch (cause) { error('poll', cause); finish('aborted', 'observation-failed'); }
  }
  function groupedFrames() {
    const grouped = new Map();
    for (const segment of segments) {
      if (segment.frameId === undefined) continue;
      let frame = grouped.get(segment.frameId);
      if (!frame) {
        frame = { frameId: segment.frameId, fenceSerials: [], draws: 0, calls: 0, glCpuMs: 0, waitCpuMs: 0, polls: 0, timeouts: 0 };
        grouped.set(segment.frameId, frame);
      }
      frame.fenceSerials.push(segment.serial);
      for (const field of ['draws', 'calls', 'glCpuMs', 'waitCpuMs', 'polls', 'timeouts']) frame[field] += segment[field];
      if (segment.firstNonFlushAtMs !== undefined) frame.firstNonFlushAtMs = Math.min(frame.firstNonFlushAtMs ?? Infinity, segment.firstNonFlushAtMs);
      frame.firstFenceAtMs = Math.min(frame.firstFenceAtMs ?? Infinity, segment.fenceCalledAtMs);
      frame.lastFenceAtMs = Math.max(frame.lastFenceAtMs ?? -Infinity, segment.fenceReturnedAtMs);
      if (segment.signaledAtMs !== undefined) frame.lastSignaledAtMs = Math.max(frame.lastSignaledAtMs ?? -Infinity, segment.signaledAtMs);
      if (segment.completion !== undefined) frame.completion = segment.completion;
    }
    return [...grouped.values()].map(frame => ({ ...frame,
      nonFlushToFenceSpanMs: frame.firstNonFlushAtMs === undefined ? null : frame.lastFenceAtMs - frame.firstNonFlushAtMs,
      fenceToObservedSignalMs: frame.lastSignaledAtMs === undefined ? null : frame.lastSignaledAtMs - frame.lastFenceAtMs,
      fenceToObservedCompletionMs: frame.completion === undefined ? null : frame.completion.atMs - frame.lastFenceAtMs,
    }));
  }
  function summary() {
    const frames = groupedFrames(), methods = new Map();
    const distribution = values => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      return sorted.length ? { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) } : null;
    };
    for (const segment of segments) for (const [name, value] of Object.entries(segment.methods)) {
      const row = methods.get(name) ?? { name, count: 0, cpuMs: 0 }; row.count += value.count; row.cpuMs += value.cpuMs; methods.set(name, row);
    }
    return { groupedRendererFrames: frames.length, fenceSegments: segments.length,
      windows: windows.map(w => ({ phase: w.phase, seconds: w.end ? (w.end.atMs - w.start.atMs) / 1000 : null,
        completedFrames: w.end ? w.end.completed - w.start.completed : null,
        completedFps: w.end ? (w.end.completed - w.start.completed) * 1000 / (w.end.atMs - w.start.atMs) : null })),
      fencesPerObservedFrame: distribution(frames.map(f => f.fenceSerials.length)),
      drawsPerObservedFrame: distribution(frames.map(f => f.draws)),
      nativeGlCpuMs: distribution(frames.map(f => f.glCpuMs)),
      nonFlushToFenceSpanMs: distribution(frames.map(f => f.nonFlushToFenceSpanMs)),
      fenceToObservedSignalMs: distribution(frames.map(f => f.fenceToObservedSignalMs)),
      fenceToObservedCompletionMs: distribution(frames.map(f => f.fenceToObservedCompletionMs)),
      nativeMethods: [...methods.values()].sort((a, b) => b.cpuMs - a.cpuMs),
    };
  }
  const api = {
    report() { return { kind: 'bounded-live-webgl-segments', status, phase: phaseNames[phaseIndex], stopReason, startedAtMs, startedAtUtcMs, deadlineMs,
      methodsRestored: hooks.length === 0 && restoreFailures === 0, restoreFailures, skippedPrefix, errors: errors.slice(), windows,
      summary: summary(), collections: { frames: groupedFrames().length, segments: segments.length, receipts: receipts.length },
      interpretation: 'Raw segments end at each native fence; several fences can share the Renderer frameId observed by the following microtask. Frames group that identity, never count fences as frames. Spans are wall observations, not GPU timestamps or pure CPU time. Non-flush spans exclude a preceding trailing flush. Completion exact=false is coalesced. Controls retain receipt polling without GL hooks.' }; },
    read(collection, offset = 0, count = 4) {
      const rows = { frames: groupedFrames(), segments, receipts }[collection];
      if (!rows || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 64) return { status: 'invalid-page' };
      let page;
      do {
        page = { collection, offset, total: rows.length, rows: rows.slice(offset, offset + count), nextOffset: Math.min(rows.length, offset + count) };
        // Bound both compact batching and the CLI's pretty/escaped envelope.
        const envelope = { ok: true, tool: 'automation_evaluate', clientName: 'Codex', result: { success: true, result: page } };
        if (JSON.stringify(page).length < 9000 && JSON.stringify(JSON.stringify(envelope, null, 2)).length + 4096 < 32768) return page;
        count = Math.floor(count / 2);
      } while (count >= 1);
      return { status: 'page-too-large', collection, offset };
    },
    cancel() { finish('cancelled', 'cancelled'); return api.report(); },
    release() { api.cancel(); if (root[key] === api) delete root[key]; return { released: true, methodsRestored: hooks.length === 0 && restoreFailures === 0 }; },
  };
  root[key] = api;
  try {
    initial = observe(); windows.push({ phase: phaseNames[0], start: initial });
    timer = root.setTimeout(poll, 10);
    deadline = root.setTimeout(() => finish('timeout', 'deadline'), 20000);
  } catch (cause) { error('start', cause); finish('aborted', 'receipt-unavailable'); }
  return api.report();
}
