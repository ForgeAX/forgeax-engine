import { Buffer } from 'node:buffer';
import { ok, ShaderSource } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect, it, vi } from 'vitest';
import {
  createMaterialProgramArtifactReceipt,
  materialShaderPreparedSourceRows,
  ShaderRegistry,
} from '../index.js';

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

it('rejects a different digest for an admitted key and contradictory read metadata', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const admitted = entry();
  registry.installMaterialArtifactBytes('game::invalid-digest', admitted);
  expect(
    registry.validateMaterialArtifactBytes('game::invalid-digest', entry('other-content')),
  ).toMatchObject({
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
  expect([...registry.materialShaderIdentifiers()]).toEqual(['game::invalid-digest']);
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

it('keeps a private copy of caller bytes admitted from a Buffer', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const input = entry('buffer-snapshot');
  const buffer = Buffer.from(input.bytes);
  registry.installMaterialArtifactBytes('game::buffer-source', { ...input, bytes: buffer });
  buffer.fill(0);
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

it('admits a second registry by digest identity without rehashing its bytes', () => {
  const input = entry('first-admission');
  const first = new ShaderRegistry({ manifestUrl: undefined });
  first.installMaterialArtifactBytes('game::first', input);
  const second = new ShaderRegistry({ manifestUrl: undefined });
  expect(second.validateMaterialArtifactBytes('game::first', input)).toMatchObject({ ok: true });
  second.installMaterialArtifactBytes('game::first', input);
  expect([...second.materialShaderIdentifiers()]).toEqual(['game::first']);
});

it('prepares one selected source owner without reading other variants or repeating work in a fork', async () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const plain = 'game::source-plain';
  const clipped = 'game::source-clipped';
  const { bytes: plainBytes, ...plainInput } = entry('plain');
  const { bytes: clippedBytes, ...clippedInput } = entry('clipped');
  const compilePlain = vi.fn(async () => ok(plainBytes));
  const compileClipped = vi.fn(async () => ok(clippedBytes));

  registry.installMaterialArtifactSource(plain, {
    ...plainInput,
    prepare: compilePlain,
    variantReferences: [
      { identifier: plain, defines: { CLIPPING_PLANES: false } },
      { identifier: clipped, defines: { CLIPPING_PLANES: true } },
    ],
  });
  registry.installMaterialArtifactSource(clipped, { ...clippedInput, prepare: compileClipped });
  const target = new ShaderRegistry({ manifestUrl: undefined });
  target.installMaterialArtifactsFrom(registry, [plain, clipped]);

  expect(target.materialArtifactDeclaration(plain)?.kind).toBe('source');
  expect(target.materialParamSchemaProjection(plain)?.schema).toEqual([]);
  expect(target.materialVariantArtifactIdentifier(plain, '')).toBe(clipped);
  const family = target.materialShaderManifestEntry(plain);
  if (family === undefined) throw new Error('Missing source family');
  expect(materialShaderPreparedSourceRows(family)).toEqual([]);
  expect(target.findMaterialArtifact(clipped).ok).toBe(false);
  expect(compileClipped).not.toHaveBeenCalled();
  expect(target.pendingMaterialPreparations()).toBeUndefined();
  const targetPending = vi.fn();
  const sourcePending = vi.fn();
  expect(target.prepareMaterialArtifact(clipped, targetPending).unwrap()).toBe(false);
  expect(registry.prepareMaterialArtifact(clipped, sourcePending).unwrap()).toBe(false);
  expect(targetPending).toHaveBeenCalledTimes(1);
  expect(sourcePending).toHaveBeenCalledWith(targetPending.mock.calls[0]?.[0]);
  expect(compileClipped).toHaveBeenCalledTimes(1);
  const pending = target.pendingMaterialPreparations();
  expect(await targetPending.mock.calls[0]?.[0]).toMatchObject({ ok: true });
  (await pending)?.unwrap();
  expect(target.prepareMaterialArtifact(clipped, targetPending).unwrap()).toBe(true);
  expect(targetPending).toHaveBeenCalledTimes(1);
  expect(materialShaderPreparedSourceRows(family)).toEqual([
    family,
    family.variants.find(({ definesKey }) => definesKey === ''),
  ]);
  expect(target.findMaterialArtifact(clipped).unwrap().source).toBe(
    new TextDecoder().decode(clippedBytes),
  );
  expect(registry.findMaterialArtifact(clipped).unwrap().program).toBe(
    target.findMaterialArtifact(clipped).unwrap().program,
  );
  expect(compilePlain).not.toHaveBeenCalled();
  target.prepareMaterialArtifact(plain).unwrap();
  (await target.pendingMaterialPreparations())?.unwrap();
  target.findMaterialArtifact(plain).unwrap();
  expect(target.materialVariantArtifactIdentifier(plain, '')).toBe(clipped);
  expect(target.materialVariantArtifactIdentifier(plain, 'UNKNOWN=true')).toBe(plain);
});

it('reports a digest mismatch without publishing program source or retrying a rejected artifact', async () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const compiled = entry('wrong');
  const prepare = vi.fn(async () => ok(compiled.bytes));
  const { bytes: _expected, ...expected } = entry('expected');
  registry.installMaterialArtifactSource('game::source-digest', { ...expected, prepare });
  expect(registry.prepareMaterialArtifact('game::source-digest').unwrap()).toBe(false);
  expect(await registry.pendingMaterialPreparations()).toMatchObject({
    ok: false,
    error: { code: 'shader-compile-failed' },
  });
  expect(registry.findMaterialArtifact('game::source-digest').ok).toBe(false);
  expect(registry.prepareMaterialArtifact('game::source-digest').ok).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(1);
});
