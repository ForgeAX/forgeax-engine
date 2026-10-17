import { vec3 } from '@forgeax/engine-math';
import {
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { derive, type ParamSchemaEntry, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { assert, describe, expect, it } from 'vitest';
import { packMaterialProgramRow, packStandardPbrMaterialRow } from '../material-row';
import type { MaterialSnapshot } from '../render-system-extract';

const snapshot = (): MaterialSnapshot => ({
  baseColor: vec3.create(0.25, 0.5, 0.75),
  metallic: 0.2,
  roughness: 0.8,
});
const float = (row: Uint8Array | undefined, offset = 0) => {
  assert(row, 'Material row must be packed');
  return new DataView(row.buffer, row.byteOffset, row.byteLength).getFloat32(offset, true);
};

describe('material row defaults', () => {
  it('packs admitted defaults with the same numeric WGSL encodings as raw schemas', () => {
    const schema: ParamSchemaEntry[] = [
      { name: 'color', type: 'vec4', default: [0.25, 0.5, 0.75, 1] },
      { name: 'flags', type: 'u32', default: 0xdeadbeef },
      { name: 'signed', type: 'i32', default: -12345 },
      { name: 'map', type: 'texture2d' },
    ];
    const admitted = new ParamSchemaProjectionOwner().admit({
      ownerId: 'defaults',
      revision: 1,
      schema,
    });
    expect(packMaterialProgramRow(admitted.schema, snapshot(), 128)).toEqual(
      packMaterialProgramRow(schema, snapshot(), 128),
    );
    const row = packMaterialProgramRow(admitted.schema, snapshot(), 128);
    assert(row, 'Material row must be packed');
    const members = derive(admitted.schema).numericMembers;
    const flags = members[1];
    const signed = members[2];
    assert(flags && signed, 'Integer members must be present');
    const view = new DataView(row.buffer);
    expect(view.getUint32(flags.offset, true)).toBe(0xdeadbeef);
    expect(view.getInt32(signed.offset, true)).toBe(-12345);
  });

  it('keeps defaults separate across same-layout owner revisions and caller mutation', () => {
    const owner = new ParamSchemaProjectionOwner();
    const schema: [ParamSchemaEntry] = [{ name: 'value', type: 'f32', default: 0.25 }];
    const first = owner.admit({ ownerId: 'defaults', revision: 1, schema });
    expect(float(packMaterialProgramRow(first.schema, snapshot(), 16))).toBe(0.25);
    Object.assign(schema[0], { default: 0.75 });
    const next = owner.admit({ ownerId: 'defaults', revision: 2, schema });
    expect(derive(first.schema).layoutIdentity).toBe(derive(next.schema).layoutIdentity);
    expect(float(packMaterialProgramRow(next.schema, snapshot(), 16))).toBe(0.75);
    expect(float(packMaterialProgramRow(first.schema, snapshot(), 16))).toBe(0.25);
  });

  it('reobserves mutable raw defaults and same-count field replacement', () => {
    const schema: [ParamSchemaEntry] = [{ name: 'value', type: 'f32', default: 0.25 }];
    expect(float(packMaterialProgramRow(schema, snapshot(), 16))).toBe(0.25);
    Object.assign(schema[0], { default: 0.5 });
    expect(float(packMaterialProgramRow(schema, snapshot(), 16))).toBe(0.5);
    schema[0] = { name: 'value', type: 'f32', default: 0.75 };
    expect(float(packMaterialProgramRow(schema, snapshot(), 16))).toBe(0.75);
  });

  it('does not borrow defaults authority from a frozen raw layout', () => {
    const values = [0.25, 0.5, 0.75, 1];
    const schema = Object.freeze([
      Object.freeze({ name: 'value', type: 'vec4' as const, default: values }),
    ]);
    derive(schema);
    expect(float(packMaterialProgramRow(schema, snapshot(), 16))).toBe(0.25);
    values[0] = 0.875;
    expect(float(packMaterialProgramRow(schema, snapshot(), 16))).toBe(0.875);
  });

  it('reads raw defaults after the current material getter and preserves failures', () => {
    const trace: string[] = [];
    let current = 0.25;
    let failure: Error | undefined;
    const schema: ParamSchemaEntry[] = [
      {
        name: 'value',
        type: 'f32',
        get default() {
          trace.push('default');
          if (failure) throw failure;
          return current;
        },
      },
    ];
    const material: MaterialSnapshot = {
      ...snapshot(),
      paramSnapshot: {
        get value() {
          trace.push('snapshot');
          current = 0.75;
          return 'use-default';
        },
      },
    };
    expect(float(packMaterialProgramRow(schema, material, 16))).toBe(0.75);
    expect(trace).toEqual(['snapshot', 'default']);
    failure = new Error('raw default unavailable');
    expect(() => packMaterialProgramRow(schema, material, 16)).toThrow(failure);
    expect(trace).toEqual(['snapshot', 'default', 'snapshot', 'default']);
  });

  it('does not read a raw default when a numeric snapshot value exists', () => {
    const schema: ParamSchemaEntry[] = [
      {
        name: 'value',
        type: 'f32',
        get default(): never {
          throw Error('Default must remain unread');
        },
      },
    ];
    expect(
      float(packMaterialProgramRow(schema, { ...snapshot(), paramSnapshot: { value: 0.5 } }, 16)),
    ).toBe(0.5);
  });

  it('preserves Standard fallback and numeric snapshot precedence on the canonical row', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const material = snapshot();
    const original = packStandardPbrMaterialRow(receipt, material);
    const derived = derive(STANDARD_PIPELINE_PARAM_SCHEMA);
    const offset = (name: string) => {
      const member = derived.numericMembers.find((member) => member.name === name);
      assert(member, `Numeric member ${name} must be present`);
      return member.offset;
    };
    expect(float(original, offset('baseColor'))).toBe(0.25);
    expect(float(original, offset('roughness'))).toBeCloseTo(0.8);
    const next = packStandardPbrMaterialRow(receipt, {
      ...material,
      paramSnapshot: { roughness: 0.125 },
    });
    expect(float(next, offset('roughness'))).toBe(0.125);
    expect(float(original, offset('roughness'))).toBeCloseTo(0.8);
  });
});
