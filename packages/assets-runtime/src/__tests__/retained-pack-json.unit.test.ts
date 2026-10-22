import { compressZstd } from '@forgeax/engine-codec/encode';
import { expect, it, vi } from 'vitest';
import {
  isRetainedJsonTree,
  parseRetainedPackJson,
  readDocumentJson,
  readRetainedPackJson,
} from '../internal/retained-pack-json.js';

it('brands only parsed JSON objects and never inspects an unbranded Proxy', () => {
  const parsed = parseRetainedPackJson('{"nested":{"value":1},"array":[true,null]}');
  expect(isRetainedJsonTree(parsed)).toBe(true);
  expect(isRetainedJsonTree(structuredClone(parsed))).toBe(false);
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error('must not inspect proxy');
      },
    },
  );
  expect(isRetainedJsonTree(proxy)).toBe(false);
});

it.each([
  'getter',
  'symbol',
  'extra',
  'alias',
  'undefined',
  'nonfinite',
  'prototype',
] as const)('rejects a parsed object after a %s mutation without invoking accessors', (mutation) => {
  const parsed = parseRetainedPackJson('{"left":{"value":1},"right":{"value":2}}') as {
    left: { value: unknown };
    right: { value: unknown };
  };
  if (mutation === 'getter')
    Object.defineProperty(parsed.left, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not invoke getter');
      },
    });
  if (mutation === 'symbol') Reflect.set(parsed.left, Symbol('extra'), 1);
  if (mutation === 'extra') Reflect.set(parsed.left, 'extra', 1);
  if (mutation === 'alias') parsed.right = parsed.left;
  if (mutation === 'undefined') parsed.left.value = undefined;
  if (mutation === 'nonfinite') parsed.left.value = Infinity;
  if (mutation === 'prototype') Object.setPrototypeOf(parsed.left, null);
  expect(isRetainedJsonTree(parsed)).toBe(false);
});

it.each([
  'hole',
  'extra',
  'length',
] as const)('rejects a parsed array with changed %s shape', (mutation) => {
  const parsed = parseRetainedPackJson('[1,2]') as number[];
  if (mutation === 'hole') delete parsed[0];
  if (mutation === 'extra') Reflect.set(parsed, 'extra', 3);
  if (mutation === 'length') parsed.length = 3;
  expect(isRetainedJsonTree(parsed)).toBe(false);
});

it('does not accept a new nested object or nonfinite JSON number and preserves JSON syntax errors', () => {
  const parsed = parseRetainedPackJson('{"nested":{}}') as { nested: object };
  parsed.nested = {};
  expect(isRetainedJsonTree(parsed)).toBe(false);
  expect(isRetainedJsonTree(parseRetainedPackJson('{"number":1e400}'))).toBe(false);
  expect(() => parseRetainedPackJson('{')).toThrow(SyntaxError);
});

it('retains nested and empty arrays while rejecting a replacement Proxy without invoking traps', () => {
  const parsed = parseRetainedPackJson('[[],[null,true,"value",1,{"nested":[]}]]') as unknown[][];
  expect(isRetainedJsonTree(parsed)).toBe(true);
  const fail = () => {
    throw new Error('must not inspect replacement proxy');
  };
  parsed[0] = new Proxy([], { ownKeys: fail, get: fail, getPrototypeOf: fail });
  expect(isRetainedJsonTree(parsed)).toBe(false);
});

it.each([
  'getter',
  'hidden',
  'symbol',
  'index-spelling',
  'alias',
  'undefined',
  'nonfinite',
  'prototype',
] as const)('rejects a parsed array after a %s mutation', (mutation) => {
  const parsed = parseRetainedPackJson('[[1],[2]]') as unknown[][];
  if (mutation === 'getter')
    Object.defineProperty(parsed, '0', {
      enumerable: true,
      get() {
        throw new Error('must not invoke index getter');
      },
    });
  if (mutation === 'hidden') Object.defineProperty(parsed, '0', { enumerable: false });
  if (mutation === 'symbol' || mutation === 'index-spelling') {
    delete parsed[0];
    Reflect.set(parsed, mutation === 'symbol' ? Symbol('0') : '00', 1);
  }
  if (mutation === 'alias') Reflect.set(parsed, 1, parsed[0]);
  if (mutation === 'undefined') Reflect.set(parsed, 0, undefined);
  if (mutation === 'nonfinite') Reflect.set(parsed, 0, Infinity);
  if (mutation === 'prototype') Object.setPrototypeOf(parsed, null);
  expect(isRetainedJsonTree(parsed)).toBe(false);
});

it('reads platform Response JSON into an owned retained tree without sharing results', async () => {
  const text = '{"assets":[{"payload":{"config":{"label":"night"}}}],"shader":"WGSL \u03c0"}';
  const first = await readRetainedPackJson(new Response(text));
  const second = await readRetainedPackJson(new Response(text));
  expect(first).toEqual(JSON.parse(text));
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(isRetainedJsonTree(first)).toBe(true);
  expect(isRetainedJsonTree(second)).toBe(true);
  expect(isRetainedJsonTree(structuredClone(first))).toBe(false);
});

it('decodes a zstd-stored platform Response document', async () => {
  const text = '{"assets":[{"payload":{"config":{"label":"night"}}}]}';
  const compressed = await compressZstd(new TextEncoder().encode(text));
  if (!compressed.ok) throw new Error('compress failed');
  const value = await readRetainedPackJson(new Response(compressed.value));
  expect(value).toEqual(JSON.parse(text));
  expect(isRetainedJsonTree(value)).toBe(true);
  expect(await readDocumentJson(new Response(compressed.value))).toEqual(JSON.parse(text));
  await expect(
    readDocumentJson(new Response(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0]))),
  ).rejects.toBeInstanceOf(SyntaxError);
});

it('preserves json-only reader identity and receiver without using function.call', async () => {
  const value = { assets: [], opaque: Symbol('custom') };
  let calls = 0;
  const response = {
    json: async function () {
      expect(this).toBe(response);
      calls++;
      return value;
    },
  };
  Object.defineProperty(response.json, 'call', {
    get() {
      throw new Error('must not read function.call');
    },
  });
  expect(await readRetainedPackJson(response)).toBe(value);
  expect(calls).toBe(1);
  expect(isRetainedJsonTree(value)).toBe(false);
});

it('reads a custom json getter exactly once and never reads its text getter', async () => {
  let reads = 0;
  let calls = 0;
  const value = { assets: [] };
  const response = {
    get json() {
      reads++;
      return async function (this: unknown) {
        expect(this).toBe(response);
        calls++;
        return value;
      };
    },
    get text(): never {
      throw new Error('must not read text');
    },
  };
  expect(await readRetainedPackJson(response)).toBe(value);
  expect(reads).toBe(1);
  expect(calls).toBe(1);
  expect(isRetainedJsonTree(value)).toBe(false);
});

it('preserves a Response subclass custom json result with an opaque body', async () => {
  const value = { assets: [], custom: true };
  let calls = 0;
  class JsonResponse extends Response {
    override async json() {
      calls++;
      return value;
    }
  }
  const response = new JsonResponse('not JSON');
  Object.defineProperty(response, 'text', {
    get() {
      throw new Error('must not read custom text');
    },
  });
  expect(await readRetainedPackJson(response)).toBe(value);
  expect(calls).toBe(1);
  expect(isRetainedJsonTree(value)).toBe(false);
});

it('preserves inherited platform json for a subclass overriding text', async () => {
  class TextResponse extends Response {
    override async text(): Promise<string> {
      throw new Error('must not call custom text');
    }
  }
  const value = await readRetainedPackJson(new TextResponse('{"assets":[]}'));
  expect(value).toEqual({ assets: [] });
  expect(isRetainedJsonTree(value)).toBe(false);
});

it('never reads an own arrayBuffer getter on an exact platform Response', async () => {
  const response = new Response('{"assets":[]}');
  Object.defineProperty(response, 'arrayBuffer', {
    get() {
      throw new Error('must not read arrayBuffer getter');
    },
  });
  const value = await readRetainedPackJson(response);
  expect(value).toEqual({ assets: [] });
  expect(isRetainedJsonTree(value)).toBe(false);
});

it('does not brand an exact platform Response with an own json override', async () => {
  const value = { assets: [] };
  const response = new Response('opaque');
  let reads = 0;
  Object.defineProperty(response, 'json', {
    get() {
      reads++;
      return async () => value;
    },
  });
  expect(await readRetainedPackJson(response)).toBe(value);
  expect(reads).toBe(1);
  expect(isRetainedJsonTree(value)).toBe(false);
});

it('preserves malformed platform JSON and custom reader rejection', async () => {
  await expect(readRetainedPackJson(new Response('{'))).rejects.toBeInstanceOf(SyntaxError);
  const failure = new Error('custom reader failed');
  const response = {
    json: async () => {
      throw failure;
    },
  };
  await expect(readRetainedPackJson(response)).rejects.toBe(failure);
});

it('falls back without reading a changed platform arrayBuffer descriptor', async () => {
  const prototype = Response.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'arrayBuffer');
  if (original === undefined) throw new Error('platform arrayBuffer descriptor is absent');
  const response = new Response('{"assets":[]}');
  try {
    Object.defineProperty(prototype, 'arrayBuffer', {
      configurable: true,
      get() {
        throw new Error('must not read changed platform arrayBuffer');
      },
    });
    const value = await readRetainedPackJson(response);
    expect(value).toEqual({ assets: [] });
    expect(isRetainedJsonTree(value)).toBe(false);
  } finally {
    Object.defineProperty(prototype, 'arrayBuffer', original);
  }
});

it('uses legacy json when a global Response subclass is present at module import', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Response');
  if (original === undefined) throw new Error('platform Response descriptor is absent');
  const PlatformResponse = Response;
  const value = { assets: [], adapter: true };
  let jsonCalls = 0;
  let textCalls = 0;
  class AdapterResponse extends PlatformResponse {
    override async json() {
      jsonCalls++;
      return value;
    }
    override async text() {
      textCalls++;
      return '{"assets":[],"wrong":true}';
    }
  }
  try {
    Object.defineProperty(globalThis, 'Response', {
      configurable: true,
      writable: true,
      value: AdapterResponse,
    });
    vi.resetModules();
    const reader = await import('../internal/retained-pack-json.js');
    const response = new AdapterResponse('opaque custom body');
    expect(await reader.readRetainedPackJson(response)).toBe(value);
    expect(jsonCalls).toBe(1);
    expect(textCalls).toBe(0);
    expect(reader.isRetainedJsonTree(value)).toBe(false);
  } finally {
    Object.defineProperty(globalThis, 'Response', original);
    vi.resetModules();
  }
});

it('omits unused retention records for resource-only production packages', () => {
  const raw = {
    kind: 'internal-text-package',
    assets: [
      {
        kind: 'texture',
        payload: {
          kind: 'texture',
          data: Array.from({ length: 16384 }, (_, i) => i % 256),
        },
      },
    ],
  };
  const parsed = parseRetainedPackJson(JSON.stringify(raw));
  expect(parsed).toEqual(raw);
  expect(isRetainedJsonTree(parsed)).toBe(false);
  const mixed = parseRetainedPackJson(
    JSON.stringify({
      ...raw,
      assets: [...raw.assets, { kind: 'plugin', payload: { kind: 'plugin', config: {} } }],
    }),
  );
  expect(isRetainedJsonTree(mixed)).toBe(true);
});
