import { expect, it } from 'vitest';
import { compileShader, shaderImportClosure } from '../compile.js';
import { prepareShaderCompiler } from '../program.js';

const source = `#import test::palette::tint
@group(0) @binding(0) var<storage, read_write> output: array<vec4<u32>>;
@compute @workgroup_size(1) fn main() {
#if TINT == true
  output[0] = tint();
#else
  output[0] = vec4<u32>(0u, 255u, 0u, 255u);
#endif
}`;
const imports = {
  'test::palette':
    '#define_import_path test::palette\nfn tint() -> vec4<u32> { return vec4<u32>(255u, 0u, 0u, 255u); }',
};

it('uses the same compiler semantics for prepared runtime and asynchronous build requests', async () => {
  const prepared = (await prepareShaderCompiler()).unwrap();
  for (const tint of [false, true]) {
    const options = { imports, defines: { TINT: tint }, computeEntry: 'main' };
    const runtime = prepared.compile(source, options);
    expect(runtime).not.toBeInstanceOf(Promise);
    const build = await compileShader(source, options);
    expect(runtime).toEqual(build);
    const result = runtime.unwrap();
    expect(result.reflection?.entryPoints).toEqual([
      expect.objectContaining({ name: 'main', stage: 'compute' }),
    ]);
    expect(result.bindings[0]?.entries).toEqual([
      expect.objectContaining({ binding: 0, buffer: expect.objectContaining({ type: 'storage' }) }),
    ]);
  }
});

it('preserves structured source failures and a usable compiler after rejection', async () => {
  const compiler = (await prepareShaderCompiler()).unwrap();
  const invalid = compiler.compile('@compute fn broken() { ??? }');
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe('shader-compile-failed');
  expect(
    compiler.compile(source, { imports, defines: { TINT: true }, computeEntry: 'main' }).ok,
  ).toBe(true);
});

it('keeps both conditional module branches and aliases without including unrelated catalog modules', async () => {
  const root = `#if USE_RED == true
#import paint::colors::{red}
#else
#import paint::colors::{green}
#endif
@compute @workgroup_size(1) fn main() {
#if USE_RED == true
  let value = red();
#else
  let value = green();
#endif
}`;
  const modules = {
    'paint::colors':
      '#define_import_path paint::colors\n#import paint::shared as shared\nfn red() -> f32 { return shared::scale(); }\nfn green() -> f32 { return 0.0; }',
    'paint::shared': '#define_import_path paint::shared\nfn scale() -> f32 { return 1.0; }',
    unrelated: '#define_import_path unrelated\nfn unused() {}',
  };
  const closure = shaderImportClosure(root, modules);
  expect(Object.keys(closure).sort()).toEqual(['paint::colors', 'paint::shared']);
  const compiler = (await prepareShaderCompiler()).unwrap();
  for (const selected of [false, true]) {
    const options = { defines: { USE_RED: selected }, computeEntry: 'main' };
    const complete = compiler.compile(root, { ...options, imports: modules }).unwrap();
    const scoped = compiler.compile(root, { ...options, imports: closure }).unwrap();
    expect(scoped.wgsl).toBe(complete.wgsl);
    expect(scoped.reflection).toEqual(complete.reflection);
  }
});
