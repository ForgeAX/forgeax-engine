import { Buffer } from 'node:buffer';
import { ShaderSource } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect, it, vi } from 'vitest';
import { createMaterialProgramArtifactReceipt, ShaderRegistry } from '../index.js';

function entry(suffix = 'byte-contract') {
  const bytes = new TextEncoder().encode(
    `@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); } // ${suffix}`,
  );
  return {
    bytes,
    digest: `sha256:${bytesToHex(sha256(bytes))}`,
    paramSchema: [],
    receipt: createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      vertexInputs: [],
    }),
  };
}

it('rejects digest and contradictory read metadata before lazy admission', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const invalid = entry();
  invalid.bytes[0] = 0;
  expect(registry.validateMaterialArtifactBytes('game::invalid-digest', invalid)).toMatchObject({
    ok: false,
    error: { code: 'material-artifact-conflict', detail: { dimension: 'bytes' } },
  });
  const valid = entry();
  const receipt = {
    ...valid.receipt,
    entryPoints: [{ name: 'vs_main', stage: 'vertex' as const, bindings: [] }],
  };
  expect(() =>
    registry.installMaterialArtifactBytes('game::invalid-reads', {
      ...valid,
      receipt,
      entryPoints: [{ name: 'other', stage: 'vertex', bindings: [] }],
    }),
  ).toThrow('conflicting shader entry');
  expect([...registry.materialShaderIdentifiers()]).toHaveLength(0);
  expect(registry.sourceInspection().programs).toBe(0);
});

it('preflights duplicate subset adoption and retains private pending metadata', () => {
  const source = new ShaderRegistry({ manifestUrl: undefined });
  const target = new ShaderRegistry({ manifestUrl: undefined });
  const input = {
    ...entry(),
    entryPoints: [{ name: 'vs_main', stage: 'vertex' as const, bindings: [] }],
  };
  source.installMaterialArtifactBytes('game::pending', input);
  const first = input.entryPoints[0];
  if (first === undefined) throw new Error('Missing input reads');
  first.name = 'mutated';
  expect(() =>
    target.installMaterialArtifactsFrom(source, ['game::pending', 'game::pending']),
  ).toThrow('already registered');
  expect([...target.materialShaderIdentifiers()]).toHaveLength(0);
  target.installMaterialArtifactsFrom(source, ['game::pending']);
  const declaration = target.materialArtifactDeclaration('game::pending');
  if (declaration?.kind !== 'bytes') throw new Error('Missing pending declaration');
  expect(declaration.entryPoints?.[0]?.name).toBe('vs_main');
  const reads = declaration.entryPoints?.[0];
  if (reads === undefined) throw new Error('Missing reads');
  Object.assign(reads, { name: 'poisoned' });
  expect(target.findMaterialArtifact('game::pending').unwrap().program.entryPoints?.[0]?.name).toBe(
    'vs_main',
  );
  expect(source.sourceInspection().programs).toBe(0);
});

it('rejects mutated retained Buffer bytes before decoding and permits a verified retry', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const input = entry('buffer-snapshot');
  const buffer = Buffer.from(input.bytes);
  registry.installMaterialArtifactBytes('game::buffer-source', { ...input, bytes: buffer });
  buffer.fill(0);
  expect(() => registry.findMaterialArtifact('game::buffer-source')).toThrow(
    'bytes changed after admission',
  );
  expect(registry.sourceInspection().programs).toBe(0);
  buffer.set(input.bytes);
  expect(registry.findMaterialArtifact('game::buffer-source').unwrap().source).toBe(
    new TextDecoder().decode(input.bytes),
  );
});

it('retains lazy material text whole without rebuilding a runtime fragment pool', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const copies = vi.spyOn(String, 'fromCharCode');
  try {
    registry.shaderSource('const SHARED: u32 = 1u;\n\n');
    const input = entry('whole-source-regression');
    registry.installMaterialArtifactBytes('game::fragments', input);
    expect(registry.materialArtifactDeclaration('game::fragments')?.kind).toBe('bytes');
    const ready = registry.findMaterialArtifact('game::fragments').unwrap();
    expect(ShaderSource.is(ready.program.sourceReference)).toBe(true);
    expect(ready.source).toBe(new TextDecoder().decode(input.bytes));
    expect(registry.findMaterialArtifact('game::fragments').unwrap()).toBe(ready);
    expect(copies).not.toHaveBeenCalled();
  } finally {
    copies.mockRestore();
  }
});

it('admits a pending or decoded program by its retained owner and still rejects other bytes', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const input = entry('retained-owner');
  registry.installMaterialArtifactBytes('game::retained', input);
  const copy = { ...input, bytes: new Uint8Array(input.bytes) };
  expect(registry.validateMaterialArtifactBytes('game::retained', copy)).toEqual({
    ok: true,
    value: true,
  });
  expect(registry.findMaterialArtifact('game::retained').ok).toBe(true);
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(registry.validateMaterialArtifactBytes('game::retained', input)).toEqual({
      ok: true,
      value: true,
    });
    expect(encode).not.toHaveBeenCalled();
  } finally {
    encode.mockRestore();
  }
  // The key already holds this verified content address: a repeat is not reread.
  const unread = {
    ...input,
    bytes: new Proxy(new Uint8Array(input.bytes.length), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property))
          throw new Error('repeated admission read program bytes');
        return Reflect.get(target, property, receiver);
      },
    }),
  };
  expect(registry.validateMaterialArtifactBytes('game::retained', unread)).toEqual({
    ok: true,
    value: true,
  });
  registry.installMaterialArtifactBytes('game::retained', unread);
  expect(registry.findMaterialArtifact('game::retained').unwrap().source).toBe(
    new TextDecoder().decode(input.bytes),
  );
  // Another program under this key carries another digest and is rejected by address.
  const other = entry('other-owner');
  expect(registry.validateMaterialArtifactBytes('game::retained', other)).toMatchObject({
    ok: false,
    error: {
      code: 'material-artifact-conflict',
      detail: { dimension: 'bytes', existingDigest: input.digest, incomingDigest: other.digest },
    },
  });
  expect(() => registry.installMaterialArtifactBytes('game::retained', other)).toThrow();
  // A ready program installed from source has no retained owner; equal bytes still compare.
  const sourced = new ShaderRegistry({ manifestUrl: undefined });
  sourced.installMaterialArtifact('game::sourced', {
    source: new TextDecoder().decode(input.bytes),
    paramSchema: [],
    receipt: input.receipt,
  });
  expect(sourced.validateMaterialArtifactBytes('game::sourced', other)).toMatchObject({
    ok: false,
    error: { code: 'material-artifact-conflict', detail: { dimension: 'bytes' } },
  });
});

it('rejects a different program under an admitted key while it is still pending', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const input = entry('pending-owner');
  registry.installMaterialArtifactBytes('game::pending-conflict', input);
  const other = entry('pending-other');
  expect(registry.validateMaterialArtifactBytes('game::pending-conflict', other)).toMatchObject({
    ok: false,
    error: { code: 'material-artifact-conflict', detail: { dimension: 'bytes' } },
  });
  expect(registry.findMaterialArtifact('game::pending-conflict').unwrap().source).toBe(
    new TextDecoder().decode(input.bytes),
  );
});

it.each([
  'pending',
  'decoded',
])('keeps parameter schema and receipt conflicts for an identical digest (%s)', (state) => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const input = entry(`metadata-${state}`);
  registry.installMaterialArtifactBytes('game::metadata', input);
  if (state === 'decoded') registry.findMaterialArtifact('game::metadata').unwrap();
  expect(
    registry.validateMaterialArtifactBytes('game::metadata', {
      ...input,
      paramSchema: [{ name: 'tint', type: 'f32' as const }],
    }),
  ).toMatchObject({
    ok: false,
    error: { code: 'material-artifact-conflict', detail: { dimension: 'param-schema' } },
  });
  const receipt = createMaterialProgramArtifactReceipt({
    schema: [],
    directEntry: 'vs_other',
    vertexInputs: [],
  });
  expect(
    registry.validateMaterialArtifactBytes('game::metadata', { ...input, receipt }),
  ).toMatchObject({
    ok: false,
    error: { code: 'material-artifact-conflict', detail: { dimension: 'receipt' } },
  });
});

it('verifies the digest when content first reaches a registry', () => {
  const input = entry('first-admission');
  const first = new ShaderRegistry({ manifestUrl: undefined });
  first.installMaterialArtifactBytes('game::first', input);
  // A second registry receiving altered bytes under the same digest checks them.
  const forged = { ...input, bytes: new Uint8Array(input.bytes) };
  forged.bytes[forged.bytes.length - 1] ^= 1;
  const second = new ShaderRegistry({ manifestUrl: undefined });
  expect(second.validateMaterialArtifactBytes('game::first', forged)).toMatchObject({
    ok: false,
    error: { code: 'material-artifact-conflict', detail: { dimension: 'bytes' } },
  });
  expect(() => second.installMaterialArtifactBytes('game::first', forged)).toThrow();
  expect([...second.materialShaderIdentifiers()]).toHaveLength(0);
});
