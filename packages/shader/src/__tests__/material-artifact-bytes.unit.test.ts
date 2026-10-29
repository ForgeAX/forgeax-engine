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
