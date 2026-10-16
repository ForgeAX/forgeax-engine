import { describe, expect, it } from 'vitest';
import { MaterialArtifactRegistry } from '../material/artifact-registry.js';

describe('material artifact deduplication', () => {
  it('shares immutable artifacts by specialization key and rejects conflicts', () => {
    const registry = new MaterialArtifactRegistry();
    const first = Object.freeze({ key: 'key-a', bytes: new Uint8Array([1]) });
    const second = Object.freeze({ key: 'key-a', bytes: new Uint8Array([2]) });

    expect(registry.register(first)).toEqual({ ok: true, value: first });
    expect(registry.register({ key: 'key-a', bytes: new Uint8Array([1]) })).toEqual({
      ok: true,
      value: first,
    });
    expect(registry.register(second)).toMatchObject({
      ok: false,
      error: { code: 'material-artifact-conflict' },
    });
    expect(registry.get('key-a')).toBe(first);
  });

  it('rejects an ABI receipt change when artifact bytes and parameters are unchanged', () => {
    const registry = new MaterialArtifactRegistry();
    const first = {
      key: 'key-receipt',
      bytes: new Uint8Array([1]),
      metadata: { paramSchema: [], receipt: { receiptIdentity: 'plain' } },
    };
    expect(registry.register(first)).toMatchObject({ ok: true });
    expect(
      registry.register({
        key: first.key,
        bytes: new Uint8Array([1]),
        metadata: { paramSchema: [], receipt: { receiptIdentity: 'colored' } },
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { dimension: 'receipt' } },
    });
  });

  it.each([
    'tail',
    'length',
  ])('rejects %s byte conflicts even with an identical advertised digest', (difference) => {
    const registry = new MaterialArtifactRegistry();
    const bytes = new Uint8Array(4096).fill(7);
    const first = { key: 'key-byte-boundary', bytes, digest: 'same-advertised-digest' };
    registry.register(first).unwrap();
    const incoming = difference === 'length' ? bytes.subarray(0, bytes.length - 1) : bytes.slice();
    if (difference === 'tail') incoming[incoming.length - 1] = 8;
    expect(
      registry.register({ key: first.key, bytes: incoming, digest: first.digest }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-artifact-conflict', detail: { dimension: 'bytes' } },
    });
    expect(registry.get(first.key)).toBe(first);
  });

  it('compares equal offset byte views and retains the original artifact owner', () => {
    const registry = new MaterialArtifactRegistry();
    const first = { key: 'key-view', bytes: new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4) };
    const incoming = new Uint8Array([8, 8, 1, 2, 3, 8]).subarray(2, 5);
    registry.register(first).unwrap();
    expect(registry.register({ key: first.key, bytes: incoming }).unwrap()).toBe(first);
    incoming.fill(0);
    expect(registry.get(first.key)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('retains parameter schema conflicts after comparing equal bytes', () => {
    const registry = new MaterialArtifactRegistry();
    const first = {
      key: 'key-schema',
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { paramSchema: [] },
    };
    registry.register(first).unwrap();
    expect(
      registry.register({
        ...first,
        bytes: first.bytes.slice(),
        metadata: { paramSchema: [{ name: 'changed' }] },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-artifact-conflict', detail: { dimension: 'param-schema' } },
    });
    expect(registry.get(first.key)).toBe(first);
  });
  it.each([
    'detached',
    'out-of-bounds',
  ])('rejects a retained %s left byte view against empty bytes', (state) => {
    const registry = new MaterialArtifactRegistry();
    const buffer = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]) as ArrayBuffer;
    const bytes = new Uint8Array(buffer, 0, 4);
    registry.register({ key: 'key-invalid-left', bytes }).unwrap();
    if (state === 'detached') structuredClone(buffer, { transfer: [buffer] });
    else {
      const resize = Reflect.get(buffer, 'resize');
      if (typeof resize !== 'function') throw new Error('Expected resizable ArrayBuffer');
      resize.call(buffer, 0);
    }
    expect(() => registry.register({ key: 'key-invalid-left', bytes: new Uint8Array() })).toThrow(
      TypeError,
    );
  });

  it('preserves the empty-left comparison when only incoming storage was detached', () => {
    const registry = new MaterialArtifactRegistry();
    const first = { key: 'key-invalid-right', bytes: new Uint8Array() };
    registry.register(first).unwrap();
    const incoming = new Uint8Array(4);
    structuredClone(incoming.buffer, { transfer: [incoming.buffer] });
    expect(registry.register({ key: first.key, bytes: incoming }).unwrap()).toBe(first);
  });
});
