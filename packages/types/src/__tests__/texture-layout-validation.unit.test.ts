import { expect, it } from 'vitest';
import {
  deriveTextureLayout,
  type TextureLayoutInput,
  validateTextureLayout,
} from '../texture/layout';

const input = (): TextureLayoutInput => ({
  shape: { viewDimension: '3d', extent: { width: 16, height: 8, depth: 4 } },
  format: 'rgba8unorm',
  mips: { kind: 'packed', levelCount: 3 },
});

it.each([
  input(),
  {
    shape: { viewDimension: '2d', extent: { width: 16, height: 8 } },
    format: 'rgba8unorm',
    mips: { kind: 'generate' },
  },
  { ...input(), mips: { kind: 'none' } },
  { ...input(), mips: { kind: 'packed', levelCount: 3 } },
  { ...input(), format: 'bc1-rgba-unorm' },
  { ...input(), actualByteLength: 17 },
  { ...input(), order: 'unsupported' },
  { ...input(), shape: { viewDimension: '3d', extent: { width: 0, height: 8, depth: 4 } } },
] satisfies TextureLayoutInput[])('keeps the full canonical validation result for %o', (value) => {
  const expected = deriveTextureLayout(value);
  const actual = validateTextureLayout(value);
  expect(actual.ok).toBe(expected.ok);
  if (!expected.ok && !actual.ok) expect(actual.error).toEqual(expected.error);
  if (actual.ok) expect(actual.value).toBeUndefined();
});

it('omits per-mip row retention rather than bypassing validation', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push');
  if (descriptor === undefined) throw new Error('Missing native array push');
  const original = Array.prototype.push;
  let records = 0;
  let fullRecords = 0;
  let levelCount = 0;
  Object.defineProperty(Array.prototype, 'push', {
    ...descriptor,
    value(this: unknown[], ...values: unknown[]) {
      for (const value of values) {
        if (
          value !== null &&
          typeof value === 'object' &&
          'bytesPerRow' in value &&
          'level' in value
        )
          records++;
      }
      return Reflect.apply(original, this, values);
    },
  });
  try {
    levelCount = deriveTextureLayout(input()).unwrap().levels.length;
    fullRecords = records;
    records = 0;
    validateTextureLayout(input()).unwrap();
  } finally {
    Object.defineProperty(Array.prototype, 'push', descriptor);
  }
  expect(fullRecords).toBe(levelCount);
  expect(records).toBe(0);
});

it.each([
  undefined,
  'shape.extent.width',
  'shape.extent.depth',
  'mips.kind',
  'actualByteLength',
])('retains nested author observation and thrown identity for %s', (failurePath) => {
  const failure = new Error('author layout field');
  const invoke = (validateOnly: boolean) => {
    const events: string[] = [];
    const seen = new WeakMap<object, object>();
    const wrap = (value: object, path: string): object => {
      const prior = seen.get(value);
      if (prior !== undefined) return prior;
      const proxy = new Proxy(value, {
        get(target, key, receiver) {
          const location = path === '' ? String(key) : `${path}.${String(key)}`;
          events.push(location);
          if (location === failurePath) throw failure;
          const result = Reflect.get(target, key, receiver);
          return result !== null && typeof result === 'object' ? wrap(result, location) : result;
        },
      });
      seen.set(value, proxy);
      return proxy;
    };
    let error: unknown;
    try {
      const value = wrap(input(), '') as TextureLayoutInput;
      if (validateOnly) validateTextureLayout(value).unwrap();
      else deriveTextureLayout(value).unwrap();
    } catch (cause) {
      error = cause;
    }
    return { events, error };
  };
  const full = invoke(false),
    status = invoke(true);
  expect(status.events).toEqual(full.events);
  expect(status.error).toBe(full.error);
});
