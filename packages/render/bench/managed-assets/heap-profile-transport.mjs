// A full-scale allocation profile can exceed V8's single-string limit. Keep
// Chrome's raw sample array as bytes and decode one sample at a time after the
// measured window. The call tree and CDP envelope remain ordinary JSON.
export function decodeProfileMessage(bytes) {
  const marker = Buffer.from('"samples":[');
  const markerAt = bytes.indexOf(marker);
  if (markerAt < 0) return JSON.parse(bytes.toString());
  const first = markerAt + marker.length;
  let end = first, depth = 1, quoted = false, escaped = false;
  for (; end < bytes.length; end++) {
    const char = bytes[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === 92) escaped = true;
      else if (char === 34) quoted = false;
    } else if (char === 34) quoted = true;
    else if (char === 91) depth++;
    else if (char === 93 && --depth === 0) break;
  }
  if (depth !== 0) throw new Error('Incomplete CDP allocation samples');
  const envelope = JSON.parse(Buffer.concat([bytes.subarray(0, first), bytes.subarray(end)]).toString());
  const profile = envelope.result?.profile;
  if (!profile?.head || !Array.isArray(profile.samples)) throw new Error('Invalid CDP allocation profile');
  profile.samples = {
    *[Symbol.iterator]() {
      let start = first;
      for (let index = first; index < end; index++) {
        // SamplingHeapProfileSample has only three numeric fields, with no
        // nested values. Parse each object to validate that protocol contract.
        if (bytes[index] !== 125) continue;
        while (bytes[start] === 44 || bytes[start] <= 32) start++;
        const sample = JSON.parse(bytes.subarray(start, index + 1).toString());
        if (!Number.isFinite(sample.size) || !Number.isFinite(sample.nodeId) || !Number.isFinite(sample.ordinal)) {
          throw new Error('Invalid CDP allocation sample');
        }
        yield sample;
        start = index + 1;
      }
      if (bytes.subarray(start, end).toString().trim()) throw new Error('Incomplete CDP allocation sample');
    },
  };
  return envelope;
}

// Installed only after timing and Tracing.end. Chromium's existing debugging
// pipe writes responses in 64 KiB packets and has no WebSocket 256 MiB ceiling.
// Preserve Playwright's ordinary traffic and restore its decoder on close.
export async function openHeapProfileTransport(root, evidence) {
  const session = root._connection?.toImpl?.(root)?._session;
  const connection = session?._connection, pipe = connection?._transport;
  if (typeof session?._sessionId !== 'string' || !session._sessionId || !pipe?._pipeRead || !pipe?._pipeWrite || typeof pipe._dispatch !== 'function'
      || !Array.isArray(pipe._pendingBuffers)
      || !Number.isSafeInteger(connection._lastId)) {
    throw new Error('Heap evidence requires the in-process Playwright Chromium pipe transport');
  }
  const originalDispatch = pipe._dispatch;
  const pending = new Map();
  let buffers = pipe._pendingBuffers, bufferedBytes = buffers.reduce((sum, value) => sum + value.length, 0);
  let messages = 0, closed = false;
  pipe._pendingBuffers = [];
  const transport = () => ({ kind: 'chrome-debugging-pipe', bytesRead: pipe._pipeRead.bytesRead,
    bytesWritten: pipe._pipeWrite.bytesWritten, bufferedBytes, completedMessages: messages });
  const describe = waiter => ({ id: waiter.id, method: waiter.method, target: waiter.target, sessionId: waiter.sessionId, sentAt: waiter.sentAt });
  const fail = error => {
    evidence.event({ stage: 'transport-error', error: String(error), pending: [...pending.values()].map(describe), transport: transport() });
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  const receive = bytes => {
    const receivedAt = performance.now(), number = ++messages;
    const receipt = evidence.save(`message-${number}.cdp.json`, bytes);
    try {
      const message = decodeProfileMessage(bytes), waiter = pending.get(message.id);
      if (!waiter) {
        setImmediate(() => pipe.onmessage?.(message));
        return;
      }
      evidence.event({ stage: 'command-response', ...describe(waiter), receipt, error: message.error,
        elapsedMs: performance.now() - waiter.sentAt, decodeAndSpoolSetupMs: performance.now() - receivedAt, transport: transport() });
      pending.delete(message.id); clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve({ result: message.result, receipt });
    } catch (error) { fail(error); }
  };
  pipe._dispatch = buffer => {
    let start = 0, end;
    while ((end = buffer.indexOf(0, start)) !== -1) {
      const part = buffer.subarray(start, end);
      buffers.push(part); bufferedBytes += part.length;
      const bytes = Buffer.concat(buffers, bufferedBytes);
      buffers = []; bufferedBytes = 0;
      receive(bytes); start = end + 1;
    }
    if (start < buffer.length) { const part = buffer.subarray(start); buffers.push(part); bufferedBytes += part.length; }
  };
  const onClose = () => fail(new Error('CDP heap pipe closed'));
  pipe._pipeRead.on('close', onClose);
  pipe._pipeRead.on('error', fail);
  pipe._pipeWrite.on('error', fail);
  evidence.event({ stage: 'pipe-decoder-installed', transport: transport() });
  const progress = setInterval(() => {
    if (pending.size) evidence.event({ stage: 'transport-progress', pending: [...pending.values()].map(describe), transport: transport() });
  }, 1000);
  progress.unref();
  const send = (method, params = {}, sessionId = session._sessionId, target) => new Promise((resolve, reject) => {
    const id = ++connection._lastId, sentAt = performance.now();
    const waiter = { id, method, target, sessionId, sentAt, resolve, reject };
    waiter.timer = setTimeout(() => {
      pending.delete(id);
      evidence.event({ stage: 'command-timeout', ...describe(waiter), deadlineMs: 120000, elapsedMs: performance.now() - sentAt, transport: transport() });
      reject(new Error(`CDP profile transport timed out: ${method}; target=${target?.targetId ?? 'browser'}`));
    }, 120000);
    pending.set(id, waiter);
    evidence.event({ stage: 'command-sent', ...describe(waiter), params, transport: transport() });
    try { pipe.send({ id, method, params, ...(sessionId ? { sessionId } : {}) }); }
    catch (error) { pending.delete(id); clearTimeout(waiter.timer); reject(error); }
  });
  return {
    async start(target, options) {
      const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined, target);
      await send('HeapProfiler.enable', {}, sessionId, target);
      await send('HeapProfiler.startSampling', options, sessionId, target);
      return sessionId;
    },
    async stop(target, sessionId) {
      if (!sessionId) throw new Error('Stop must use the frontend that started heap sampling');
      let failure;
      try {
        const { result, receipt } = await send('HeapProfiler.stopSampling', {}, sessionId, target);
        return { profile: result.profile, receipt };
      } catch (error) { failure = error; throw error; }
      finally {
        try { await send('Target.detachFromTarget', { sessionId }, undefined, target); }
        catch (error) { evidence.event({ stage: 'detach-error', target, error: String(error) }); if (!failure) throw error; }
      }
    },
    async close() {
      if (closed) return;
      closed = true; clearInterval(progress);
      pipe._pipeRead.off('close', onClose);
      pipe._pipeRead.off('error', fail);
      pipe._pipeWrite.off('error', fail);
      pipe._pendingBuffers = buffers;
      pipe._dispatch = originalDispatch;
      evidence.event({ stage: 'pipe-decoder-restored', transport: transport() });
      await evidence.flush();
    },
  };
}
