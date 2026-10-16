import { afterEach, expect, it, vi } from 'vitest';
import {
  RealmMessageChannel as Channel,
  RealmMessageEvent,
  RealmMessagePort,
} from '../message-channel.js';

const channels: Channel[] = [];
function channel() {
  const value = new Channel();
  channels.push(value);
  return value;
}
afterEach(() => {
  for (const value of channels.splice(0)) {
    value.port1.close();
    value.port2.close();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('queues before start, clones at post time and dispatches FIFO asynchronous events', async () => {
  vi.useFakeTimers();
  const { port1, port2 } = channel();
  const trace: unknown[] = [];
  port2.addEventListener('message', (event) => {
    trace.push([
      (event as RealmMessageEvent).data,
      event.target === port2,
      event.bubbles,
      event.cancelable,
    ]);
    queueMicrotask(() => {
      trace.push('microtask');
    });
  });
  const source = { value: 1, bytes: new Uint8Array([1, 2]) };
  port1.postMessage(source);
  source.value = 2;
  source.bytes[0] = 9;
  port1.postMessage('second');
  await vi.runAllTimersAsync();
  expect(trace).toEqual([]);
  port2.start();
  expect(trace).toEqual([]);
  await vi.runAllTimersAsync();
  expect(trace).toEqual([
    [{ value: 1, bytes: new Uint8Array([1, 2]) }, true, false, false],
    'microtask',
    ['second', true, false, false],
    'microtask',
  ]);
});
it('onmessage enables the queue and close cancels queued receiving work without replay', async () => {
  vi.useFakeTimers();
  const { port1, port2 } = channel();
  const receive = vi.fn();
  port2.onmessage = receive;
  port1.postMessage('queued');
  port2.close();
  port2.close();
  port2.start();
  await vi.runAllTimersAsync();
  expect(receive).not.toHaveBeenCalled();
  port1.postMessage('after close');
  await vi.runAllTimersAsync();
  expect(receive).not.toHaveBeenCalled();
});
it('does not cancel a previously sent message when only the sending port closes', async () => {
  vi.useFakeTimers();
  const { port1, port2 } = channel();
  const receive = vi.fn();
  port2.onmessage = receive;
  port1.postMessage('sent');
  port1.close();
  await vi.runAllTimersAsync();
  expect(receive).toHaveBeenCalledOnce();
  expect(receive.mock.calls[0]?.[0].data).toBe('sent');
});
it('rejects unsupported values and transfer without detaching the caller buffer', () => {
  const { port1 } = channel();
  const buffer = new ArrayBuffer(8);
  expect(() => port1.postMessage({ fn() {} })).toThrow(
    expect.objectContaining({ name: 'DataCloneError' }),
  );
  expect(() => port1.postMessage(buffer, [buffer])).toThrow(
    expect.objectContaining({ name: 'DataCloneError' }),
  );
  expect(() => port1.postMessage(buffer, { transfer: [buffer] })).toThrow(
    expect.objectContaining({ name: 'DataCloneError' }),
  );
  expect(buffer.byteLength).toBe(8);
  expect(() => new RealmMessagePort()).toThrow('Illegal constructor');
});
it('installs a coherent missing pair while preserving native MessageChannel identity', async () => {
  const native = globalThis.MessageChannel;
  const { installWechatStandards } = await import('../standards.js');
  installWechatStandards().unwrap();
  expect(globalThis.MessageChannel).toBe(native);
  vi.stubGlobal('MessageChannel', undefined);
  vi.stubGlobal('MessagePort', undefined);
  vi.stubGlobal('MessageEvent', undefined);
  installWechatStandards().unwrap();
  expect(globalThis.MessageChannel).toBe(Channel);
  expect(globalThis.MessagePort).toBe(RealmMessagePort);
  expect(globalThis.MessageEvent).toBe(RealmMessageEvent);
});

it('preserves undefined as message data and retained native MessageEvent identity', async () => {
  vi.useFakeTimers();
  const { port1, port2 } = channel();
  const received: unknown[] = [];
  port2.onmessage = (event) => {
    received.push([(event as MessageEvent).data, event instanceof globalThis.MessageEvent]);
  };
  port1.postMessage(undefined);
  await vi.runAllTimersAsync();
  expect(received).toEqual([[undefined, true]]);
});

it('delivers the ordinary port protocol when the realm has no DOM or message globals', async () => {
  vi.resetModules();
  for (const name of [
    'MessageChannel',
    'MessagePort',
    'MessageEvent',
    'EventTarget',
    'Event',
    'AbortController',
    'AbortSignal',
  ])
    vi.stubGlobal(name, undefined);
  const { installWechatStandards } = await import('../standards.js');
  installWechatStandards().unwrap();
  const native = new MessageChannel();
  try {
    const received = new Promise<unknown>((resolve) => {
      native.port2.addEventListener(
        'message',
        (event) => {
          expect(event).toBeInstanceOf(MessageEvent);
          expect(event.target).toBe(native.port2);
          resolve((event as MessageEvent).data);
        },
        { once: true },
      );
      native.port2.start();
    });
    native.port1.postMessage({ kind: 'generate', values: { radius: 0.8 } });
    expect(await received).toEqual({ kind: 'generate', values: { radius: 0.8 } });
  } finally {
    native.port1.close();
    native.port2.close();
  }
});
