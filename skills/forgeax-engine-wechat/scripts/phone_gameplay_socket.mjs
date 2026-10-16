const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kind = 'forgeax-phone-gameplay-control/1';

/** Native socket/debug boundary shared by the real-phone probe and gameplay controller. */
export function createPhoneGameplaySocket(options, wx, report, { now, failure }) {
  let socket,
    open = false,
    closed = false,
    pending;
  report.debugReceipts ??= [];
  report.websocket ??= { events: [] };
  function event(name, value) {
    report.websocket.events.push({ name, atMs: now(), value });
  }
  function nativeError(stage, value) {
    const error = new Error(`${stage}: ${String(value?.errMsg ?? value)}`);
    error.native = {
      errMsg: String(value?.errMsg ?? value),
      ...(value?.errno !== undefined ? { errno: value.errno } : {}),
      ...(value?.errCode !== undefined ? { errCode: value.errCode } : {}),
    };
    return error;
  }
  function debug(enableDebug) {
    const receipt = {
      api: 'wx.setEnableDebug',
      enableDebug,
      startedAtMs: now(),
      status: 'pending',
    };
    report.debugReceipts.push(receipt);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        receipt.finishedAtMs = now();
        receipt.status = error ? 'failed' : 'success';
        if (error) {
          receipt.error = String(error);
          reject(error);
        } else resolve(receipt);
      };
      const timer = setTimeout(
        () => finish(new Error('wx.setEnableDebug: callback deadline')),
        5000,
      );
      try {
        if (typeof wx.setEnableDebug !== 'function')
          throw new Error('wx.setEnableDebug unavailable');
        wx.setEnableDebug({
          enableDebug,
          success(value) {
            receipt.success = value ?? null;
            finish();
          },
          fail(value) {
            receipt.fail = value;
            finish(nativeError('wx.setEnableDebug', value));
          },
          complete(value) {
            receipt.complete = value ?? null;
            receipt.completeAtMs = now();
          },
        });
      } catch (error) {
        finish(error);
      }
    });
  }
  function receive(action, stage, timeout) {
    if (pending) throw new Error('Overlapping control receive');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined;
        reject(new Error(`${stage}: socket deadline`));
      }, timeout);
      pending = {
        resolve(value) {
          clearTimeout(timer);
          pending = undefined;
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          pending = undefined;
          reject(error);
        },
        action,
        stage,
      };
    });
  }
  function send(stage, detail = {}) {
    const message = {
      kind,
      source: options.source,
      runId: options.runId,
      ...(options.probeOnly ? { probeOnly: true } : {}),
      stage,
      ...detail,
    };
    event('send', message);
    return new Promise((resolve, reject) => {
      socket.send({
        data: JSON.stringify(message),
        success(value) {
          event('send-success', { stage, native: value });
          resolve();
        },
        fail(value) {
          reject(nativeError(`socket.send/${stage}`, value));
        },
      });
    });
  }
  // Ready includes manual image review; armed/release remain short control exchanges.
  async function exchange(stage, action, detail, timeout = stage === 'ready' ? 120000 : 20000) {
    const response = receive(action, stage, timeout);
    // Attach both promises immediately so a failed send cannot leave an unhandled receive.
    try {
      return (await Promise.all([send(stage, detail), response]))[1];
    } catch (error) {
      pending?.reject(error);
      throw error;
    }
  }
  async function close() {
    if (!socket || closed) return;
    socket.close({
      code: 1000,
      reason: 'probe-complete',
      success(value) {
        event('close-success', value);
      },
      fail(value) {
        event('close-failure', value);
      },
    });
    const deadline = Date.now() + 5000;
    while (!closed && Date.now() < deadline) await wait(25);
    if (!closed) throw new Error('Socket close event unconfirmed');
  }
  async function connect() {
    event('connect-attempt', { url: `${options.controlUrl.replace(/^http:/, 'ws:')}/control` });
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket open deadline')), 10000);
      socket = wx.connectSocket({
        url: `${options.controlUrl.replace(/^http:/, 'ws:')}/control`,
        success(value) {
          event('connect-success', value);
        },
        fail(value) {
          clearTimeout(timer);
          reject(nativeError('wx.connectSocket', value));
        },
      });
      socket.onOpen((value) => {
        clearTimeout(timer);
        open = true;
        event('open', value);
        resolve();
      });
      socket.onError((value) => {
        const error = nativeError('SocketTask.onError', value);
        event('error', value);
        clearTimeout(timer);
        pending?.reject(error);
        reject(error);
      });
      socket.onClose((value) => {
        closed = true;
        event('close', value);
        pending?.reject(new Error('Socket closed before expected control response'));
        if (!open) {
          clearTimeout(timer);
          reject(new Error('Socket closed before open'));
        }
      });
      socket.onMessage((value) => {
        try {
          const message = JSON.parse(value.data);
          event('receive', message);
          if (
            !pending ||
            message.kind !== kind ||
            message.runId !== options.runId ||
            JSON.stringify(message.source) !== JSON.stringify(options.source) ||
            message.probeOnly !== (options.probeOnly ? true : undefined) ||
            message.stage !== pending.stage ||
            ![pending.action].flat().includes(message.action)
          )
            throw new Error('Socket response identity/stage mismatch');
          pending.resolve(message);
        } catch (error) {
          pending?.reject(error);
          failure(error, 'socket-message');
        }
      });
    });
    await opened;
  }
  return { debug, connect, exchange, close };
}
