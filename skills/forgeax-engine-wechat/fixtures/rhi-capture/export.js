// Evaluated by the official automation driver; this state belongs to the script.
function exportTape(request) {
  const game = typeof GameGlobal === 'object' ? GameGlobal.__gameContextWindow : undefined;
  const key = '__forgeaxRhiCaptureExport';
  const fail = (code, detail) => ({ phase: 'failed', error: { code, detail } });
  if (!game) return fail('game-unavailable');
  let state = game[key];
  if (request.operation === 'release') {
    if (!state) return { phase: 'released' };
    if (state.id !== request.id) return fail('capture-export-identity');
    const released = state.release();
    return released?.then ? released.then(() => ({ phase: 'released' }),
      error => fail('capture-export-native-file-cleanup', { virtualPath: state.virtualPath, cause: error }))
      : { phase: 'released' };
  }
  if (request.operation === 'start') {
    if (state) return fail('capture-export-busy');
    if (!Number.isSafeInteger(request.chunkBytes) || request.chunkBytes < 1 || request.chunkBytes > 16384)
      return fail('capture-export-chunk-size', { max: 16384 });
    const inspection = game.__forgeaxGameInspection;
    const capture = inspection?.rhiCapture;
    if (typeof capture?.captureFrame !== 'function') return fail('capture-unavailable');
    const generation = inspection.renderer().generation;
    const controller = new (game.AbortController ?? AbortController)();
    state = { id: request.id, phase: 'capturing', generation, inspection,
      controller, offset: 0, artifact: undefined, iterator: undefined, last: undefined };
    let timer, pendingWrite, pendingRelease, fileCreated = false;
    const fs = request.nativeFile ? wx.getFileSystemManager?.() : undefined;
    const base = request.nativeFile ? wx.env?.USER_DATA_PATH : undefined;
    if (request.nativeFile && (typeof base !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(request.id)
        || !['writeFile', 'appendFile', 'stat', 'unlink'].every(name => typeof fs?.[name] === 'function')))
      return fail('capture-export-native-file-unavailable');
    const uniqueName = `forgeax-rhi-${request.id}.rhitape`;
    const virtualPath = request.nativeFile ? base.replace(/\/$/, '') + '/' + uniqueName : undefined;
    state.virtualPath = virtualPath;
    const fileCall = (method, options) => new Promise((resolve, reject) =>
      fs[method]({ ...options, success: resolve, fail: reject }));
    const removeFile = async () => {
      if (!fileCreated) return;
      await fileCall('unlink', { filePath: virtualPath });
      fileCreated = false;
    };
    state.release = () => {
      if (pendingRelease) return pendingRelease;
      const iterator = state.iterator;
      state.phase = 'released';
      state.artifact = state.iterator = state.last = state.nativeWindow = undefined;
      const forget = () => { if (game[key] === state) delete game[key]; };
      clearTimeout(timer);
      let failure;
      try { controller.abort(); } catch (error) { failure = error; }
      try { iterator?.return?.(); } catch (error) { failure ??= error; }
      if (request.nativeFile) {
        pendingRelease = Promise.resolve(pendingWrite).then(removeFile).then(() => {
          forget();
          if (failure) throw failure;
        }).catch(error => {
          // Retain the exact file owner after failed unlink. A release retry
          // must retry cleanup, never mistake a forgotten state for success.
          pendingRelease = undefined;
          throw error;
        });
        return pendingRelease;
      }
      forget();
      if (failure) throw failure;
    };
    const current = () => game[key] === state && state.phase !== 'released'
      && game.__forgeaxGameInspection === inspection
      && inspection.renderer().generation === generation;
    state.advance = (removePrevious = false) => {
      state.phase = 'writing';
      state.nativeWindow = undefined;
      const iterator = state.iterator;
      let writeFailure;
      pendingWrite = (async () => {
        try {
          // ACK is the only progression point: no next byte is written until
          // the previous window has been copied, verified and unlinked.
          if (removePrevious) await removeFile();
          if (!current()) throw { code: 'capture-export-generation' };
          if (state.offset === state.metadata.byteLength) {
            if (!iterator.next().done) throw { code: 'capture-export-chunk' };
            state.phase = 'complete';
            return;
          }
          const offset = state.offset;
          const end = Math.min(offset + 1048576, state.metadata.byteLength);
          while (state.offset < end) {
            if (!current()) throw { code: 'capture-export-generation' };
            const next = iterator.next();
            if (next.done) throw { code: 'capture-export-chunk' };
            const { offset: chunkOffset, bytes } = next.value;
            if (chunkOffset !== state.offset || bytes.byteLength < 1 || bytes.byteLength > 262144
                || state.offset + bytes.byteLength > end) throw { code: 'capture-export-chunk' };
            const method = fileCreated ? 'appendFile' : 'writeFile';
            // A failed native write may still leave a partial file.
            fileCreated = true;
            await fileCall(method, { filePath: virtualPath,
              data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
            state.offset += bytes.byteLength;
          }
          const result = await fileCall('stat', { path: virtualPath });
          if (!current()) throw { code: 'capture-export-generation' };
          if (result.stats?.size !== end - offset) throw { code: 'capture-export-file-size' };
          state.nativeWindow = { virtualPath, uniqueName, offset, length: end - offset };
          state.phase = 'native-window';
        } catch (error) {
          writeFailure = error;
          if (current()) { state.phase = 'failed'; state.error = { code: 'capture-export-native-file', detail: { virtualPath, cause: error } }; }
          await removeFile();
        }
      })().catch(error => {
        state.error = { code: 'capture-export-native-file-cleanup', detail: { virtualPath,
          cause: writeFailure ?? error, cleanupError: error } };
        if (current()) state.phase = 'failed';
      });
    };
    game[key] = state;
    timer = setTimeout(() => {
      try { Promise.resolve(state.release()).catch(error => { state.error = error; }); }
      catch (error) { state.error = error; }
    }, request.timeoutMs);
    // Return immediately: the official evaluation request has its own short timeout.
    Promise.resolve().then(() => capture.captureFrame({ signal: controller.signal,
      snapshotTimeoutMs: request.snapshotTimeoutMs, byteBudget: request.maxBytes,
      ...(request.seedMaxResourceBytes === undefined ? {} : { seed: { maxResourceBytes: request.seedMaxResourceBytes } }),
    })).then(result => {
      if (!current()) { state.release(); return; }
      if (!result.ok) { state.phase = 'failed'; state.error = result.error; return; }
      const artifact = result.value;
      if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1
          || artifact.byteLength > request.maxBytes) {
        state.phase = 'failed'; state.error = { code: 'capture-export-size' }; return;
      }
      state.artifact = artifact;
      state.iterator = artifact.chunks(request.nativeFile ? 262144 : request.chunkBytes)[Symbol.iterator]();
      state.metadata = { generation, byteLength: artifact.byteLength, digest: artifact.digest };
      if (request.nativeFile) state.advance();
      else state.phase = 'ready';
    }).catch(error => {
      if (current()) { state.phase = 'failed'; state.error = error; }
      else state.release();
    });
    return { phase: 'capturing', generation };
  }
  if (!state || state.id !== request.id) return fail('capture-export-identity');
  if (game.__forgeaxGameInspection !== state.inspection
      || state.inspection.renderer().generation !== state.generation) {
    const released = state.release();
    return released?.then ? released.then(() => fail('capture-export-generation'),
      error => fail('capture-export-native-file-cleanup', { cause: error })) : fail('capture-export-generation');
  }
  if (state.phase === 'failed') return JSON.parse(JSON.stringify({ phase: 'failed', error: state.error },
    (_key, value) => value instanceof Error
      ? { ...value, name: value.name, message: value.message, cause: value.cause } : value));
  if (request.operation === 'ack') {
    if (request.generation !== state.generation) return fail('capture-export-generation');
    const same = value => value && request.offset === value.offset && request.length === value.length;
    if (!same(state.lastAck)) {
      if (state.phase !== 'native-window' || !same(state.nativeWindow))
        return fail('capture-export-ack', { expected: state.nativeWindow?.offset });
      state.lastAck = { offset: request.offset, length: request.length };
      state.advance(true);
    }
  }
  if (state.phase === 'native-window') return { phase: state.phase, ...state.metadata, ...state.nativeWindow };
  if (state.phase === 'complete') return { phase: state.phase, offset: state.offset, ...state.metadata };
  if (state.phase !== 'ready') return { phase: state.phase, generation: state.generation, written: state.offset };
  if (request.operation === 'status') return { phase: 'ready', ...state.metadata };
  if (request.operation !== 'chunk') return fail('capture-export-operation');
  // A failed transport can retry the same offset without advancing the iterator.
  if (state.last?.offset === request.offset) return state.last;
  if (request.offset !== state.offset) return fail('capture-export-offset', { expected: state.offset });
  const next = state.iterator.next();
  if (next.done) return { phase: 'complete', offset: state.offset, ...state.metadata };
  const chunk = next.value;
  if (chunk.offset !== state.offset || chunk.bytes.byteLength < 1
      || state.offset + chunk.bytes.byteLength > state.artifact.byteLength) {
    return fail('capture-export-chunk');
  }
  const bytes = chunk.bytes;
  const encoded = wx.arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  state.last = { phase: 'chunk', offset: chunk.offset, byteLength: bytes.byteLength, data: encoded };
  state.offset += bytes.byteLength;
  return state.last;
}
