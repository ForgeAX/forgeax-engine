/// <reference types="node" />
import { createServer } from 'node:net';
import type { EndpointEvent, NetEndpoint, PeerId } from '@forgeax/engine-net';
import { listenWebSocketEndpoint } from '@forgeax/engine-net-websocket/node';
import { describe, expect, it, vi } from 'vitest';
import {
  createWechatSocketConnector,
  type WechatSocketOptions,
  type WechatSocketSource,
  type WechatSocketTask,
} from '../network.js';

function nativeTask() {
  let open = () => {};
  let message = (_event: { data: string | ArrayBuffer }) => {};
  let error = (_cause: unknown) => {};
  let close = (_event: { code: number; reason: string }) => {};
  const send = vi.fn<WechatSocketTask['send']>();
  const stop = vi.fn<WechatSocketTask['close']>();
  const task: WechatSocketTask = {
    onOpen: (listener) => {
      open = listener;
    },
    onMessage: (listener) => {
      message = listener;
    },
    onError: (listener) => {
      error = listener;
    },
    onClose: (listener) => {
      close = listener;
    },
    send,
    close: stop,
  };
  return {
    task,
    send,
    stop,
    open: () => open(),
    message: (data: string | ArrayBuffer) => message({ data }),
    error: (cause: unknown) => error(cause),
    close: () => close({ code: 1000, reason: 'server closed' }),
  };
}

async function connected(options: WechatSocketOptions = {}) {
  const native = nativeTask();
  const source = { connectSocket: vi.fn(() => native.task) };
  const signal = new AbortController();
  const remove = vi.spyOn(signal.signal, 'removeEventListener');
  const pending = createWechatSocketConnector(source, 'wss://game.example', options).connect(
    signal.signal,
  );
  native.open();
  const endpoint = (await pending).unwrap();
  const event = endpoint.poll()[0];
  if (event?.kind !== 'peer-connected') throw new Error('Missing connected event');
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  return { native, source, signal, endpoint, peer: event.peerId };
}

describe('native SocketTask NetEndpoint', () => {
  it('disconnects only the selected peer and fences every late native callback', async () => {
    const { native, endpoint, peer } = await connected();
    expect(endpoint.disconnect((peer + 1) as PeerId)).toMatchObject({
      ok: false,
      error: { code: 'peer-not-found' },
    });
    expect(native.stop).not.toHaveBeenCalled();
    expect(endpoint.send(peer, Uint8Array.of(1)).ok).toBe(true);
    const outgoing = native.send.mock.calls[0]?.[0];
    expect(endpoint.disconnect(peer).ok).toBe(true);
    native.message(Uint8Array.of(2).buffer);
    native.close();
    native.error({ errMsg: 'late error' });
    outgoing?.fail({ errMsg: 'late send' });
    expect(endpoint.poll()).toEqual([{ kind: 'peer-disconnected', peerId: peer }]);
    expect(endpoint.poll()).toEqual([]);
    expect(endpoint.send(peer, Uint8Array.of(3))).toMatchObject({
      ok: false,
      error: { code: 'connection-closed' },
    });
    expect(endpoint.disconnect(peer)).toMatchObject({
      ok: false,
      error: { code: 'connection-closed' },
    });
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps exact owned binary slices, order, and peer identity without browser WebSocket', async () => {
    const { native, source, endpoint, peer, signal } = await connected({
      header: { Authorization: 'game-session' },
      protocols: ['forgeax-v2'],
    });
    expect(source.connectSocket).toHaveBeenCalledWith({
      url: 'wss://game.example',
      header: { Authorization: 'game-session' },
      protocols: ['forgeax-v2'],
      fail: expect.any(Function),
    });
    const original = Uint8Array.of(9, 1, 2, 9);
    expect(endpoint.send(peer, original.subarray(1, 3)).ok).toBe(true);
    original.fill(8);
    const outgoing = native.send.mock.calls[0]?.[0];
    expect(new Uint8Array(outgoing?.data ?? new ArrayBuffer(0))).toEqual(Uint8Array.of(1, 2));
    const incoming = Uint8Array.of(3, 4);
    native.message(incoming.buffer);
    incoming.fill(8);
    native.message(Uint8Array.of(5).buffer);
    expect(endpoint.poll()).toEqual([
      { kind: 'message', peerId: peer, data: Uint8Array.of(3, 4) },
      { kind: 'message', peerId: peer, data: Uint8Array.of(5) },
    ]);
    expect(endpoint.send((peer + 1) as PeerId, Uint8Array.of(7))).toMatchObject({
      ok: false,
      error: { code: 'peer-not-found' },
    });
    signal.abort(); // The signal cancels connection attempts, not accepted endpoints.
    expect(native.stop).not.toHaveBeenCalled();
    expect(endpoint.close().ok).toBe(true);
    native.message(Uint8Array.of(6).buffer);
    native.error({ errMsg: 'late' });
    native.close();
    outgoing?.fail({ errMsg: 'late send' });
    expect(endpoint.poll()).toEqual([{ kind: 'peer-disconnected', peerId: peer }]);
    expect(endpoint.poll()).toEqual([]);
    expect(endpoint.send(peer, Uint8Array.of(7))).toMatchObject({
      ok: false,
      error: { code: 'already-closed' },
    });
    expect(endpoint.close()).toMatchObject({ ok: false, error: { code: 'already-closed' } });
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    'maxQueuedEvents',
    'maxQueuedBytes',
    'maxBufferedBytes',
  ] as const)('rejects invalid %s before touching the native host', async (name) => {
    const source = { connectSocket: vi.fn() };
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await createWechatSocketConnector(source, 'wss://game.example', {
        [name]: value,
      }).connect(new AbortController().signal);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'connection-failed',
          detail: { cause: `${name} must be a positive safe integer` },
        },
      });
    }
    expect(source.connectSocket).not.toHaveBeenCalled();
  });

  it('preserves missing capability, native startup and partial registration failures', async () => {
    const signal = new AbortController().signal;
    expect(
      await createWechatSocketConnector({} as WechatSocketSource, 'wss://game.example').connect(
        signal,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'connection-failed', detail: { cause: 'wx.connectSocket is unavailable' } },
    });
    const cause = { errMsg: 'connectSocket:fail forbidden domain', errno: 42 };
    expect(
      await createWechatSocketConnector(
        {
          connectSocket: () => {
            throw cause;
          },
        },
        'wss://game.example',
      ).connect(signal),
    ).toMatchObject({
      ok: false,
      error: { code: 'connection-failed', detail: { cause: cause.errMsg } },
    });
    const native = nativeTask();
    native.task.onMessage = () => {
      throw new Error('registration failed');
    };
    expect(
      await createWechatSocketConnector(
        { connectSocket: () => native.task },
        'wss://game.example',
      ).connect(signal),
    ).toMatchObject({ ok: false, error: { detail: { cause: 'registration failed' } } });
    expect(native.stop).toHaveBeenCalledTimes(1);
    native.open();
    expect(native.stop).toHaveBeenCalledTimes(2);
  });

  it('cancels pending attempts, fences a late open, and gives replacements new peers', async () => {
    const attempts: ReturnType<typeof nativeTask>[] = [];
    const source: WechatSocketSource = {
      connectSocket: () => {
        const item = nativeTask();
        attempts.push(item);
        return item.task;
      },
    };
    const connector = createWechatSocketConnector(source, 'wss://game.example');
    const early = new AbortController();
    early.abort(new Error('not needed'));
    expect(await connector.connect(early.signal)).toMatchObject({
      ok: false,
      error: { detail: { cause: 'not needed' } },
    });
    expect(attempts).toHaveLength(0);
    const signal = new AbortController();
    const pending = connector.connect(signal.signal);
    const stale = attempts[0];
    signal.abort(new Error('generation retired'));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'connection-failed', detail: { cause: 'generation retired' } },
    });
    stale?.open();
    stale?.message(Uint8Array.of(1).buffer);
    expect(stale?.stop).toHaveBeenCalledTimes(2);
    const firstPending = connector.connect(new AbortController().signal);
    attempts[1]?.open();
    const first = (await firstPending).unwrap();
    const firstPeer = first.poll()[0]?.peerId;
    const secondPending = connector.connect(new AbortController().signal);
    attempts[2]?.open();
    const second = (await secondPending).unwrap();
    expect(second.poll()[0]?.peerId).not.toBe(firstPeer);
    first.close();
    expect(attempts[2]?.stop).not.toHaveBeenCalled();
    second.close();
  });

  it.each([
    'open',
    'fail',
  ] as const)('rolls back partial startup even after a synchronous native %s callback', async (mode) => {
    const native = nativeTask();
    native.task.onMessage = () => {
      throw new Error('listener unavailable');
    };
    if (mode === 'open') native.task.onOpen = (callback) => callback();
    const result = await createWechatSocketConnector(
      {
        connectSocket: (options) => {
          if (mode === 'fail') options.fail({ errMsg: 'native creation failed' });
          return native.task;
        },
      },
      'wss://game.example',
    ).connect(new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'connection-failed',
        detail: {
          cause: mode === 'open' ? 'listener unavailable' : 'native creation failed',
        },
      },
    });
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    'error',
    'close',
    'fail',
  ] as const)('settles native %s before open once and removes cancellation lease', async (kind) => {
    const native = nativeTask();
    let fail = (_cause: unknown) => {};
    const signal = new AbortController();
    const remove = vi.spyOn(signal.signal, 'removeEventListener');
    const pending = createWechatSocketConnector(
      {
        connectSocket: (options) => {
          fail = options.fail;
          return native.task;
        },
      },
      'wss://game.example',
    ).connect(signal.signal);
    if (kind === 'fail') fail({ errMsg: 'native refused' });
    else if (kind === 'error') native.error({ errMsg: 'native refused' });
    else native.close();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'connection-failed' } });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    signal.abort();
    native.open();
  });

  it('bounds pending bytes and zero-byte sends, releasing capacity once per native completion', async () => {
    const { native, endpoint, peer } = await connected({ maxQueuedEvents: 2, maxBufferedBytes: 3 });
    expect(endpoint.send(peer, Uint8Array.of(1, 2)).ok).toBe(true);
    expect(endpoint.send(peer, Uint8Array.of(3, 4))).toMatchObject({
      ok: false,
      error: { code: 'send-failed' },
    });
    expect(native.send).toHaveBeenCalledTimes(1);
    const first = native.send.mock.calls[0]?.[0];
    first?.success();
    first?.success();
    first?.fail({ errMsg: 'duplicate completion' });
    expect(endpoint.send(peer, new Uint8Array()).ok).toBe(true);
    expect(endpoint.send(peer, new Uint8Array()).ok).toBe(true);
    expect(endpoint.send(peer, new Uint8Array())).toMatchObject({
      ok: false,
      error: { code: 'send-failed' },
    });
    expect(native.stop).not.toHaveBeenCalled();
    endpoint.close();
  });

  it.each([
    'throw',
    'sync',
    'async',
  ] as const)('retains a native send %s failure and disconnects exactly once', async (mode) => {
    const { native, endpoint, peer } = await connected();
    const cause = { errMsg: 'sendSocketMessage:fail network down' };
    if (mode === 'throw')
      native.send.mockImplementation(() => {
        throw cause;
      });
    if (mode === 'sync') native.send.mockImplementation((options) => options.fail(cause));
    const result = endpoint.send(peer, Uint8Array.of(1));
    if (mode === 'async') {
      expect(result.ok).toBe(true);
      native.send.mock.calls[0]?.[0].fail(cause);
    } else
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'send-failed', detail: { cause: cause.errMsg } },
      });
    native.close();
    native.error({ errMsg: 'later error' });
    expect(endpoint.poll()).toEqual([{ kind: 'peer-disconnected', peerId: peer }]);
    expect(endpoint.send(peer, Uint8Array.of(2))).toMatchObject({
      ok: false,
      error: { code: 'send-failed', detail: { cause: cause.errMsg } },
    });
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    'events',
    'bytes',
    'text',
  ] as const)('fails closed on incoming %s violations while retaining accepted messages', async (mode) => {
    const { native, endpoint, peer } = await connected({
      maxQueuedEvents: mode === 'events' ? 1 : 8,
      maxQueuedBytes: 2,
    });
    native.message(Uint8Array.of(1).buffer);
    native.message(
      mode === 'text' ? 'not binary' : new Uint8Array(mode === 'bytes' ? 3 : 1).buffer,
    );
    native.message(Uint8Array.of(9).buffer);
    native.close();
    expect(endpoint.poll()).toEqual([
      { kind: 'message', peerId: peer, data: Uint8Array.of(1) },
      { kind: 'peer-disconnected', peerId: peer },
    ]);
    expect(endpoint.poll()).toEqual([]);
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(endpoint.send(peer, Uint8Array.of(1))).toMatchObject({
      ok: false,
      error: { code: 'connection-failed' },
    });
  });

  it('reports remote closure and native close failures without resurrecting the endpoint', async () => {
    const remote = await connected();
    remote.native.close();
    expect(remote.endpoint.poll()).toEqual([{ kind: 'peer-disconnected', peerId: remote.peer }]);
    expect(remote.endpoint.send(remote.peer, new Uint8Array())).toMatchObject({
      ok: false,
      error: { code: 'connection-closed' },
    });
    const local = await connected();
    local.native.message(Uint8Array.of(1).buffer);
    local.native.stop.mockImplementation((options) =>
      options.fail({ errMsg: 'closeSocket:fail native failure' }),
    );
    expect(local.endpoint.close()).toMatchObject({
      ok: false,
      error: { code: 'already-closed', detail: { cause: 'closeSocket:fail native failure' } },
    });
    expect(local.endpoint.poll()).toEqual([{ kind: 'peer-disconnected', peerId: local.peer }]);
    expect(local.endpoint.close()).toMatchObject({
      ok: false,
      error: { detail: { cause: 'closeSocket:fail native failure' } },
    });
  });

  it('retains open-socket native errors and delayed local close failures', async () => {
    const failed = await connected();
    failed.native.error({ errMsg: 'socket disconnected from network' });
    expect(failed.endpoint.poll()).toEqual([{ kind: 'peer-disconnected', peerId: failed.peer }]);
    expect(failed.endpoint.send(failed.peer, new Uint8Array())).toMatchObject({
      ok: false,
      error: {
        code: 'connection-failed',
        detail: { cause: 'socket disconnected from network' },
      },
    });
    const local = await connected();
    expect(local.endpoint.close().ok).toBe(true);
    local.native.stop.mock.calls[0]?.[0].fail({ errMsg: 'closeSocket:fail delayed failure' });
    expect(local.endpoint.close()).toMatchObject({
      ok: false,
      error: {
        code: 'already-closed',
        detail: { cause: 'closeSocket:fail delayed failure' },
      },
    });
  });
});

it('carries ordered binary frames over a real local socket and retires both attachments', async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const listener = (await listenWebSocketEndpoint({ port, host: '127.0.0.1' })).unwrap();
  const sockets: WebSocket[] = [];
  const source: WechatSocketSource = {
    connectSocket(options) {
      // Only the native-call shape is supplied here. Payloads cross a real TCP socket.
      const socket = new WebSocket(options.url);
      sockets.push(socket);
      socket.binaryType = 'arraybuffer';
      return {
        onOpen: (callback) => socket.addEventListener('open', callback),
        onMessage: (callback) =>
          socket.addEventListener('message', (event) =>
            callback({ data: event.data as ArrayBuffer }),
          ),
        onError: (callback) => socket.addEventListener('error', callback),
        onClose: (callback) => socket.addEventListener('close', callback),
        send({ data, success, fail }) {
          try {
            socket.send(data);
            success();
          } catch (cause) {
            fail(cause);
          }
        },
        close({ code, fail }) {
          try {
            socket.close(code);
          } catch (cause) {
            fail(cause);
          }
        },
      };
    },
  };
  const connector = createWechatSocketConnector(source, `ws://127.0.0.1:${port}`);
  const clients: NetEndpoint[] = [];
  try {
    let previousPeer: PeerId | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = (await connector.connect(new AbortController().signal)).unwrap();
      clients.push(client);
      const local = await eventOf(client, 'peer-connected');
      const remote = await eventOf(listener, 'peer-connected');
      expect(local.peerId).not.toBe(previousPeer);
      previousPeer = local.peerId;
      for (const value of [0, 127, 255]) {
        expect(
          client.send(local.peerId, Uint8Array.of(9, value, attempt, 9).subarray(1, 3)).ok,
        ).toBe(true);
        const received = await eventOf(listener, 'message');
        expect(received).toMatchObject({ kind: 'message', data: Uint8Array.of(value, attempt) });
        expect(listener.send(remote.peerId, Uint8Array.of(value, attempt)).ok).toBe(true);
        expect(await eventOf(client, 'message')).toMatchObject({
          kind: 'message',
          data: Uint8Array.of(value, attempt),
        });
      }
      if (attempt === 0) {
        expect(client.disconnect(local.peerId).ok).toBe(true);
        expect(await eventOf(client, 'peer-disconnected')).toMatchObject({ peerId: local.peerId });
      } else client.close();
      await eventOf(listener, 'peer-disconnected');
    }
    await expect
      .poll(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED))
      .toBe(true);
  } finally {
    for (const client of clients) client.close();
    for (const socket of sockets) socket.close();
    listener.close();
  }
});

async function eventOf(endpoint: NetEndpoint, kind: EndpointEvent['kind']): Promise<EndpointEvent> {
  let found: EndpointEvent | undefined;
  await expect
    .poll(() => {
      found ??= endpoint.poll().find((event) => event.kind === kind);
      return found;
    })
    .toBeDefined();
  if (!found) throw new Error(`Missing ${kind}`);
  return found;
}
