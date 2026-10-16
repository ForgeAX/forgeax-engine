import { createHash } from 'node:crypto';
import { createMeshBuilder } from '@forgeax/engine-geometry';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePack } from '../scriptable-pack-build.js';
import {
  scriptablePackFingerprint,
  scriptablePackFingerprintAsync,
} from '../scriptable-pack-fingerprint.js';

it('batches numeric JSON tokens while preserving the published fingerprint encoding', () => {
  const values = Array.from({ length: 256 * 1024 }, (_, index) => index & 255);
  const expected = `sha256:${createHash('sha256')
    .update(`scriptable-pack-fingerprint/3:${JSON.stringify(values)}`)
    .digest('hex')}`;
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(scriptablePackFingerprint(values)).toBe(expected);
    expect(encode.mock.calls.length).toBeLessThan(128);
  } finally {
    encode.mockRestore();
  }
});

it('fingerprints mesh buffers without enumerating a JSON property for every float', async () => {
  const mesh = createMeshBuilder({
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    indices: [0, 1, 2],
  })
    .build()
    .unwrap();
  const outputs = new AssetOutputProducerRegistry();
  outputs.register({
    kind: 'mesh',
    version: 'test',
    produce: () => ok({ payload: mesh, refs: [], artifacts: {} }),
  });
  const definition = definePack({
    schemaVersion: '2.0.0',
    packageId: definePackageId('01900000-0000-7000-8000-000000000089'),
    build: () => ok({ 'mesh/large': mesh }),
  });
  const keys = Object.keys;
  let enumeratedBuffers = 0;
  const spy = vi.spyOn(Object, 'keys').mockImplementation((value) => {
    if (ArrayBuffer.isView(value)) enumeratedBuffers++;
    return keys(value);
  });
  try {
    const result = await buildScriptablePack({ definition, sourcePath: 'large.pack.ts', outputs });
    expect(result.ok).toBe(true);
    expect(enumeratedBuffers).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('hashes the selected byte range, type and content with stable object order', () => {
  const values = new Float32Array([99, 1.25, -2, 88]);
  const view = values.subarray(1, 3);
  expect(scriptablePackFingerprint({ z: view, a: 1 })).toBe(
    scriptablePackFingerprint({ a: 1, z: new Float32Array([1.25, -2]) }),
  );
  expect(scriptablePackFingerprint(view)).not.toBe(
    scriptablePackFingerprint(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
  );
  const before = scriptablePackFingerprint(view);
  view[1] = 3;
  expect(scriptablePackFingerprint(view)).not.toBe(before);
  expect(scriptablePackFingerprint(new ArrayBuffer(4))).not.toBe(scriptablePackFingerprint({}));
});

// This checks bounded serialization, not throughput under coverage instrumentation.
it('streams a representative large mesh buffer without a giant JSON string', () => {
  const vertices = new Float32Array(16 * 1024 * 1024);
  vertices[0] = 1.25;
  vertices[vertices.length - 1] = -2;
  const first = scriptablePackFingerprint({ kind: 'mesh', vertices });
  vertices[vertices.length - 1] = -3;
  expect(scriptablePackFingerprint({ kind: 'mesh', vertices })).not.toBe(first);
}, 60000);

it('native hashing matches synchronous identities and captures bytes before yielding', async () => {
  const bytes = new Uint8Array(1024 * 1024 + 17).fill(91).subarray(7);
  const input = { a: [1, 'unicode: \u{1f680}', false], bytes, nested: { z: null } };
  const expected = scriptablePackFingerprint(input);
  const pending = scriptablePackFingerprintAsync(input);
  bytes.fill(42);
  input.nested.z = 7 as never;
  expect(await pending).toBe(expected);
  expect(await scriptablePackFingerprintAsync(input)).toBe(scriptablePackFingerprint(input));
});

it('retains the published binary lane encoding in both hash implementations', async () => {
  const bytes = new Uint8Array([0, 255, 1, 128]);
  const expected = `sha256:${createHash('sha256').update('scriptable-pack-fingerprint/3:\0Uint8Array:4:').update(createHash('sha256').update(bytes).digest('hex')).update('\0').digest('hex')}`;
  expect(scriptablePackFingerprint(bytes)).toBe(expected);
  expect(await scriptablePackFingerprintAsync(bytes)).toBe(expected);
});
