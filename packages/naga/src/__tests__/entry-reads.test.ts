import { expect, it } from 'vitest';
import { emit_reflection, parse, parseReflectionWire, validate } from '../index';

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
    const reflected = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
    expect(reflected.entryPoints).toEqual([
      {
        name: 'vs',
        stage: 'vertex',
        bindings: [{ group: 1, binding: 0, fields: ['displacement'] }],
        effects: {
          mayDiscard: false,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
      {
        name: 'fs',
        stage: 'fragment',
        bindings: [{ group: 1, binding: 0, fields: ['alpha'] }],
        effects: {
          mayDiscard: true,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
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
    const reflection = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
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
    const reflection = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
    expect(reflection.entryPoints?.[0]?.bindings).toEqual([
      { group: 1, binding: 0, fields: ['entries'] },
      { group: 1, binding: 2 },
    ]);
  } finally {
    module.free();
  }
});

it('publishes native entry effects independently of other entries and unused helpers', async () => {
  const parsed = (
    await parse(`
@group(0) @binding(0) var<storage, read_write> values: array<u32>;
fn kill(alpha: f32) { if alpha < 0.5 { discard; } }
fn nested(alpha: f32) { kill(alpha); }
fn unused() { values[0] = 1u; discard; }
@fragment fn opaque() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn masked(@location(0) alpha: f32) -> @location(0) vec4<f32> { nested(alpha); return vec4<f32>(1.0); }
struct Output { @builtin(frag_depth) depth: f32, @builtin(sample_mask) mask: u32, }
@fragment fn depth_mask() -> Output { return Output(0.5, 1u); }
fn store() { values[0] = 1u; }
@fragment fn storage_fs() -> @location(0) vec4<f32> { store(); return vec4<f32>(1.0); }
@group(0) @binding(1) var image: texture_storage_2d<rgba8unorm, write>;
@fragment fn image_write() { textureStore(image, vec2<i32>(0), vec4<f32>(1.0)); }
var<private> scratch: u32;
@fragment fn private_write() { scratch = 1u; }
@fragment fn scalar_depth() -> @builtin(frag_depth) f32 { return 0.5; }
@group(0) @binding(2) var<uniform> opacity: f32;
fn uniform_kill() { if opacity < 0.5 { discard; } }
@fragment fn uniform_masked() { uniform_kill(); }
@fragment fn unconditional_kill() { discard; }


`)
  ).unwrap();
  const module = (await validate(parsed)).unwrap();
  try {
    const reflection = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
    expect(reflection.entryPoints?.map(({ name, effects }) => ({ name, effects }))).toEqual([
      {
        name: 'opaque',
        effects: {
          mayDiscard: false,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
      {
        name: 'masked',
        effects: {
          mayDiscard: true,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
      {
        name: 'depth_mask',
        effects: {
          mayDiscard: false,
          writesDepth: true,
          writesSampleMask: true,
          writesStorage: false,
        },
      },
      {
        name: 'storage_fs',
        effects: {
          mayDiscard: false,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: true,
        },
      },
      {
        name: 'image_write',
        effects: {
          mayDiscard: false,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: true,
        },
      },
      {
        name: 'private_write',
        effects: {
          mayDiscard: false,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
      {
        name: 'scalar_depth',
        effects: {
          mayDiscard: false,
          writesDepth: true,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
      {
        name: 'uniform_masked',
        effects: {
          mayDiscard: true,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
      {
        name: 'unconditional_kill',
        effects: {
          mayDiscard: true,
          writesDepth: false,
          writesSampleMask: false,
          writesStorage: false,
        },
      },
    ]);
  } finally {
    module.free();
  }
});
