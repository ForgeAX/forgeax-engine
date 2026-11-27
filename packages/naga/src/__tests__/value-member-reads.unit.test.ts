import type { ShaderReflectionTypeDescriptor } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { emit_reflection, parse, parseReflectionWire, validate } from '../index';

interface ValueEntry {
  readonly name: string;
  readonly valueReads?: {
    readonly schemaVersion: string;
    readonly structs: readonly {
      readonly typeDescriptor: ShaderReflectionTypeDescriptor;
      readonly fields?: readonly string[];
      readonly consumerGlobals?: readonly {
        readonly kind: string;
        readonly group?: number;
        readonly binding?: number;
      }[];
    }[];
  };
}
async function reflectValues(source: string): Promise<readonly ValueEntry[]> {
  const module = (await validate((await parse(source)).unwrap())).unwrap();
  try {
    const wire = parseReflectionWire(
      (
        await emit_reflection(
          module,
          JSON.stringify({ valueMemberReads: 'shader-value-member-reads/1' }),
        )
      ).unwrap(),
    );
    return wire.entryPoints ?? [];
  } finally {
    module.free();
  }
}
function input(entry: ValueEntry | undefined) {
  expect(entry?.valueReads?.schemaVersion).toBe('shader-value-member-reads/1');
  const row = entry?.valueReads?.structs.find(
    (item) => item.typeDescriptor.kind === 'struct' && item.typeDescriptor.name === 'Input',
  );
  assert(row);
  return row;
}
const prefix = `
struct Input { uv: vec2f, view: vec3f, time: f32, }
@group(0) @binding(2) var<uniform> eye: vec4f;
@group(1) @binding(0) var<uniform> material: vec4f;
fn makeInput(uv: vec2f) -> Input { return Input(uv, eye.xyz, 0.0); }
fn identity(value: Input) -> Input { return value; }
fn unusedView(value: Input) -> vec3f { return value.view; }
fn surface(value: Input) -> vec4f { return vec4f(identity(value).uv, 0.0, 1.0) * material; }
`;
it('separates construction, actual helper member reads and a different entry', async () => {
  const rows = await reflectValues(`${prefix}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return surface(makeInput(uv)); }
@fragment fn other(@location(0) uv: vec2f) -> @location(0) vec4f { let value=makeInput(uv); return vec4f(value.view, value.time); }
`);
  const fs = input(rows.find((row) => row.name === 'fs'));
  expect(fs.fields).toEqual(['uv']);
  expect(fs.consumerGlobals).toEqual([{ kind: 'bound', group: 1, binding: 0 }]);
  expect(input(rows.find((row) => row.name === 'other')).fields).toEqual(['view', 'time']);
});

it('keeps typed reads separate from helpers reading a bound global', async () => {
  const rows = await reflectValues(`${prefix}
fn eyeHelper() -> vec4f { return eye; }
fn dependent(value: Input) -> vec4f { return vec4f(value.uv, 0.0, 1.0) + eyeHelper(); }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return dependent(makeInput(uv)); }
`);
  expect(input(rows[0]).fields).toEqual(['uv']);
  expect(input(rows[0]).consumerGlobals).toEqual([{ kind: 'bound', group: 0, binding: 2 }]);
});

it('reports private mutable dependencies explicitly rather than dropping unbound globals', async () => {
  const rows = await reflectValues(`${prefix}
var<private> scratchValue: vec4f;
fn dependent(value: Input) -> vec4f { return vec4f(value.uv, 0.0, 1.0) + scratchValue; }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return dependent(makeInput(uv)); }
`);
  expect(input(rows[0]).consumerGlobals).toMatchObject([{ kind: 'unbound', name: 'scratchValue' }]);
});

it('treats escaping a whole aggregate as all members rather than no reads', async () => {
  const rows = await reflectValues(`
struct Input { uv: vec2f, view: vec3f, time: f32, }
@group(2) @binding(0) var<storage, read_write> output: array<Input>;
@compute @workgroup_size(1) fn cs() { output[0] = Input(vec2f(0), vec3f(0), 0.0); }
`);
  expect(input(rows[0]).fields).toBeUndefined();
});

it('follows pointer aliases to actual members in the executing WASM producer', async () => {
  const rows = await reflectValues(`
struct Input { uv: vec2f, view: vec3f, time: f32, }
fn fromPointer(value: ptr<function, Input>) -> vec3f { let forwarded=value; return (*forwarded).view; }
@fragment fn fs() -> @location(0) vec4f { var value=Input(vec2f(0),vec3f(0),0.0); return vec4f(fromPointer(&value),1); }
`);
  expect(input(rows[0]).fields).toEqual(['view']);
  expect(input(rows[0]).consumerGlobals).toEqual([]);
});
