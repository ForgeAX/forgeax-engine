import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { BroadcastChannel, MessageChannel } from 'node:worker_threads';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { runtimePacksSource } from '../runtime-packs-source.js';

type Delivery = { scope: string } | { error: string };

function deliveryModule(prepare = async () => 'https://game.test/', available = true) {
  const exports = {} as {
    createRuntimePackDeliveryClient(
      name: string | undefined,
      signal: AbortSignal,
    ): () => Promise<Delivery>;
    serveRuntimePackDelivery(name: string): () => void;
  };
  const code = ts.transpileModule(runtimePacksSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, {
    exports,
    require: (name: string) =>
      name === '@forgeax/engine/pack/runtime-browser'
        ? { prepareBrowserPackProgramScope: prepare }
        : { default: {} },
    crypto: { randomUUID },
    BroadcastChannel: available ? BroadcastChannel : undefined,
    setTimeout,
    clearTimeout,
    document: { baseURI: 'https://game.test/index.html' },
    location: { protocol: 'https:' },
    URL,
  });
  return exports;
}

it('requests once on first use and leaves unrelated game messages and port ownership intact', async () => {
  let calls = 0;
  const module = deliveryModule(async () => {
    calls++;
    return 'https://game.test/';
  });
  const channel = new MessageChannel();
  const lifetime = new AbortController();
  const name = randomUUID();
  channel.port2.postMessage({ kind: 'game', value: 7 });
  const stop = module.serveRuntimePackDelivery(name);
  const prepare = module.createRuntimePackDeliveryClient(name, lifetime.signal);
  try {
    expect(calls).toBe(0);
    const first = prepare();
    expect(prepare()).toBe(first);
    expect(await first).toEqual({ scope: 'https://game.test/' });
    expect(calls).toBe(1);
    stop();
    const gameMessage = new Promise((resolve) => channel.port1.once('message', resolve));
    expect(await gameMessage).toEqual({ kind: 'game', value: 7 });
    lifetime.abort();
    expect(await prepare()).toEqual({ error: 'Runtime Pack delivery owner is disposed' });
  } finally {
    stop();
    lifetime.abort();
    channel.port1.close();
    channel.port2.close();
  }
});

it('retires an old World request and rejects its late reply while a replacement uses the same page channel', async () => {
  const module = deliveryModule();
  const name = randomUUID();
  const channel = new BroadcastChannel(name);
  const old = new AbortController();
  const current = new AbortController();
  try {
    const firstRequest = new Promise<{ id: string }>((resolve) =>
      channel.addEventListener(
        'message',
        (event) => resolve((event as MessageEvent<{ id: string }>).data),
        {
          once: true,
        },
      ),
    );
    const first = module.createRuntimePackDeliveryClient(name, old.signal)();
    const stale = await firstRequest;
    old.abort();
    expect(await first).toEqual({ error: 'Runtime Pack delivery owner is disposed' });
    const nextRequest = new Promise<{ id: string }>((resolve) =>
      channel.addEventListener(
        'message',
        (event) => resolve((event as MessageEvent<{ id: string }>).data),
        {
          once: true,
        },
      ),
    );
    let settled = false;
    const next = module
      .createRuntimePackDeliveryClient(name, current.signal)()
      .then((value) => {
        settled = true;
        return value;
      });
    const fresh = await nextRequest;
    expect(fresh.id).not.toBe(stale.id);
    channel.postMessage({
      kind: 'forgeax:pack-program-delivery',
      id: stale.id,
      delivery: { scope: 'https://stale.test/' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    channel.postMessage({
      kind: 'forgeax:pack-program-delivery',
      id: fresh.id,
      delivery: { scope: 'https://game.test/' },
    });
    expect(await next).toEqual({ scope: 'https://game.test/' });
  } finally {
    old.abort();
    current.abort();
    channel.close();
  }
});

it('bounds a missing page response and allows a later retry', async () => {
  vi.useFakeTimers();
  const module = deliveryModule();
  const lifetime = new AbortController();
  const prepare = module.createRuntimePackDeliveryClient(randomUUID(), lifetime.signal);
  try {
    const first = prepare();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await first).toEqual({ error: 'Runtime Pack page delivery timed out' });
    const retry = prepare();
    expect(retry).not.toBe(first);
    lifetime.abort();
    expect(await retry).toEqual({ error: 'Runtime Pack delivery owner is disposed' });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    lifetime.abort();
    vi.useRealTimers();
  }
});

it('keeps static startup available when the private browser channel is unavailable', async () => {
  const module = deliveryModule(undefined, false);
  const lifetime = new AbortController();
  const stop = module.serveRuntimePackDelivery('unavailable');
  try {
    const prepare = module.createRuntimePackDeliveryClient('unavailable', lifetime.signal);
    expect(await prepare()).toEqual({ error: 'Runtime Pack delivery requires its page channel' });
  } finally {
    stop();
    lifetime.abort();
  }
});
