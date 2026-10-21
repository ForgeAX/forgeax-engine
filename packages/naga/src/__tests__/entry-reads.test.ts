import { expect, it } from 'vitest';
import { emit_reflection, parse, readReflectionWire, validate } from '../index';

it('reflects each native entry through helper structure parameters and returns', async () => {
  const parsed = (
    await parse(`
struct Params { color: vec4<f32>, roughness: f32, alpha: f32, displacement: f32, }
@group(1) @binding(0) var<uniform> params: Params;
fn identity(p: Params) -> Params { return p; }
fn opacity(p: Params) -> f32 { return identity(p).alpha; }
fn unreachable() -> f32 { return params.roughness; }
@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(params.displacement, 0.0, 0.0, 1.0); }
@fragment fn fs() { if opacity(params) < 0.5 { discard; } }
`)
  ).unwrap();
  const module = (await validate(parsed)).unwrap();
  try {
    const reflected = readReflectionWire((await emit_reflection(module, '{}')).unwrap()).unwrap();
    expect(reflected.entryPoints).toEqual([
      {
        name: 'vs',
        stage: 'vertex',
        bindings: [{ group: 1, binding: 0, fields: ['displacement'] }],
      },
      { name: 'fs', stage: 'fragment', bindings: [{ group: 1, binding: 0, fields: ['alpha'] }] },
    ]);
  } finally {
    module.free();
  }
});

it('keeps the source aggregate when it is stored under a different local structure', async () => {
  const parsed = (
    await parse(`
struct Params { color: vec4<f32>, roughness: vec4<f32>, alpha: vec4<f32>, }
struct Wrapper { value: Params, }
@group(1) @binding(0) var<uniform> params: Params;
@fragment fn fs() -> @location(0) vec4<f32> {
  var local: Wrapper;
  local.value = params;
  return local.value.alpha + params.color;
}
`)
  ).unwrap();
  const module = (await validate(parsed)).unwrap();
  try {
    const reflection = readReflectionWire((await emit_reflection(module, '{}')).unwrap()).unwrap();
    expect(reflection.entryPoints?.[0]?.bindings[0]?.fields).toEqual([
      'color',
      'roughness',
      'alpha',
    ]);
  } finally {
    module.free();
  }
});

it('retains a dynamically indexed top-level field while excluding another entry texture', async () => {
  const parsed = (
    await parse(`
struct Entry { color: vec4<f32>, factor: vec4<f32>, }
struct Params { entries: array<Entry, 4>, roughness: vec4<f32>, }
@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(2) var color: texture_2d<f32>;
@group(1) @binding(3) var other: texture_2d<f32>;
fn unused() -> vec4<f32> { return textureLoad(other, vec2<i32>(0), 0); }
@fragment fn fs(@location(0) index: f32) -> @location(0) vec4<f32> {
  return params.entries[u32(index)].factor + textureLoad(color, vec2<i32>(0), 0);
}
`)
  ).unwrap();
  const module = (await validate(parsed)).unwrap();
  try {
    const reflection = readReflectionWire((await emit_reflection(module, '{}')).unwrap()).unwrap();
    expect(reflection.entryPoints?.[0]?.bindings).toEqual([
      { group: 1, binding: 0, fields: ['entries'] },
      { group: 1, binding: 2 },
    ]);
  } finally {
    module.free();
  }
});
