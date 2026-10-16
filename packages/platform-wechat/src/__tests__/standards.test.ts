import { afterEach, expect, it, vi } from 'vitest';
import type { StructuredClone } from '../standards.js';

const realm = globalThis as unknown as { structuredClone: StructuredClone };

afterEach(() => vi.unstubAllGlobals());

it('preserves native implementations and their identity', async () => {
  const native = realm.structuredClone;
  const controller = globalThis.AbortController;
  const signal = globalThis.AbortSignal;
  const encoder = globalThis.TextEncoder;
  const decoder = globalThis.TextDecoder;
  const url = globalThis.URL;
  const params = globalThis.URLSearchParams;
  const { installWechatStandards } = await import('../standards.js');
  installWechatStandards().unwrap();
  expect(realm.structuredClone).toBe(native);
  expect(globalThis.AbortController).toBe(controller);
  expect(globalThis.AbortSignal).toBe(signal);
  expect(globalThis.TextEncoder).toBe(encoder);
  expect(globalThis.TextDecoder).toBe(decoder);
  expect(globalThis.URL).toBe(url);
  expect(globalThis.URLSearchParams).toBe(params);
});

it('supplies each missing URL constructor without replacing its native peer', async () => {
  const url = globalThis.URL;
  const params = globalThis.URLSearchParams;
  const { installWechatStandards } = await import('../standards.js');
  vi.stubGlobal('URLSearchParams', undefined);
  installWechatStandards().unwrap();
  expect(globalThis.URL).toBe(url);
  expect(new URLSearchParams('a=1').get('a')).toBe('1');
  vi.unstubAllGlobals();
  vi.stubGlobal('URL', undefined);
  installWechatStandards().unwrap();
  expect(globalThis.URLSearchParams).toBe(params);
  expect(new URL('../mesh.bin', 'https://game.invalid/assets/pack.json').href).toBe(
    'https://game.invalid/mesh.bin',
  );
  const installed = globalThis.URL;
  installWechatStandards().unwrap();
  expect(globalThis.URL).toBe(installed);
});

it('supplies each missing encoding constructor without replacing its native peer', async () => {
  const encoder = globalThis.TextEncoder;
  const decoder = globalThis.TextDecoder;
  const { installWechatStandards } = await import('../standards.js');
  vi.stubGlobal('TextDecoder', undefined);
  installWechatStandards().unwrap();
  expect(globalThis.TextEncoder).toBe(encoder);
  expect(new TextDecoder().decode(Uint8Array.of(65))).toBe('A');
  vi.unstubAllGlobals();
  vi.stubGlobal('TextEncoder', undefined);
  installWechatStandards().unwrap();
  expect(globalThis.TextDecoder).toBe(decoder);
  expect([...new TextEncoder().encode('A')]).toEqual([65]);
});

it('provides cancellation in a realm without DOM globals and retains the first reason', async () => {
  vi.resetModules();
  for (const name of ['AbortController', 'AbortSignal', 'Event', 'EventTarget', 'DOMException'])
    vi.stubGlobal(name, undefined);
  const { installWechatStandards } = await import('../standards.js');
  installWechatStandards().unwrap();
  const controller = new AbortController();
  const reason = { cancelled: true };
  const observed: unknown[] = [];
  controller.signal.addEventListener(
    'abort',
    (event) => {
      observed.push([
        event.target === controller.signal,
        controller.signal.aborted,
        controller.signal.reason,
      ]);
      controller.abort('later');
    },
    { once: true },
  );
  controller.signal.onabort = () => observed.push('attribute');
  controller.signal.dispatchEvent(new Event('abort'));
  // Synthetic dispatch cannot mark a signal aborted; the listener calls abort.
  expect(observed[0]).toEqual([true, false, undefined]);
  expect(controller.signal.reason).toBe('later');
  const next = new AbortController();
  next.abort(reason);
  next.abort('second');
  expect(next.signal.reason).toBe(reason);
  expect(() => next.signal.throwIfAborted()).toThrow(reason);
  expect(() => new AbortSignal()).toThrow(TypeError);
  expect(AbortSignal.abort().reason.name).toBe('AbortError');
  const identity = globalThis.AbortController;
  installWechatStandards().unwrap();
  expect(globalThis.AbortController).toBe(identity);
});

it('marks dependent signals before abort events and cannot suppress cancellation with propagation', async () => {
  const { RealmAbortController: Controller, RealmAbortSignal: Signal } = await import(
    '../abort.js'
  );
  const source = new Controller();
  const other = new Controller();
  const joined = Signal.any(
    (function* () {
      yield source.signal;
      yield other.signal;
    })(),
  );
  const nested = Signal.any([joined]);
  const trace: unknown[] = [];
  source.signal.addEventListener('abort', (event) => {
    trace.push([joined.aborted, nested.aborted]);
    event.stopImmediatePropagation();
  });
  joined.addEventListener('abort', () => trace.push('joined'));
  nested.addEventListener('abort', () => trace.push('nested'));
  source.abort('first');
  other.abort('second');
  expect(trace).toEqual([[true, true], 'joined', 'nested']);
  expect(nested.reason).toBe('first');
  expect(() => Signal.any([source.signal, {} as InstanceType<typeof Signal>])).toThrow(TypeError);
});

it('times out asynchronously with TimeoutError and validates timer bounds', async () => {
  const { RealmAbortSignal: Signal } = await import('../abort.js');
  const signal = Signal.timeout(0);
  expect(signal.aborted).toBe(false);
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
  expect(signal.reason).toEqual(expect.objectContaining({ name: 'TimeoutError' }));
  for (const value of [-1, Infinity, NaN, 2 ** 53])
    expect(() => Signal.timeout(value)).toThrow(TypeError);
});

it('clones cyclic POD, shared view identities and collections without losing numeric data', async () => {
  vi.resetModules();
  vi.stubGlobal('structuredClone', undefined);
  const { installWechatStandards } = await import('../standards.js');
  installWechatStandards().unwrap();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const view = new DataView(bytes.buffer, 1, 3);
  const source = { bytes, view, map: new Map<object, unknown>(), value: -0, nan: NaN, big: 9n };
  source.map.set(source, view);
  const result = realm.structuredClone(source);
  expect(result).not.toBe(source);
  expect(result.bytes.buffer).not.toBe(bytes.buffer);
  expect(result.view.buffer).toBe(result.bytes.buffer);
  expect(result.view.byteOffset).toBe(1);
  expect(result.view.byteLength).toBe(3);
  expect(result.map.get(result)).toBe(result.view);
  expect([...result.bytes]).toEqual([1, 2, 3, 4, 5]);
  expect(Object.is(result.value, -0)).toBe(true);
  expect(Number.isNaN(result.nan)).toBe(true);
  expect(result.big).toBe(9n);
  expect(() => realm.structuredClone({ fn() {} })).toThrow(
    expect.objectContaining({ name: 'DataCloneError' }),
  );
  const installed = realm.structuredClone;
  installWechatStandards().unwrap();
  expect(realm.structuredClone).toBe(installed);
});
