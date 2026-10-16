import * as naga from '@forgeax/engine-naga';
import { ok } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import * as compiler from '../../compile.js';
import { createShaderProgramCompiler } from '../../program-compiler.js';

const source = `#import test::color::{color}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return color(); }`;
const options = {
  id: 'test::entry',
  imports: {
    'test::color':
      '#define_import_path test::color\nfn color() -> vec4<f32> { return vec4<f32>(0.25); }',
  },
  renderEntries: { vertex: 'vs_main', fragment: 'fs_main' },
};
afterEach(() => vi.restoreAllMocks());

it('does not collapse an explicit undefined selector into an admitted empty selector map', async () => {
  const admission = vi.spyOn(compiler, 'compileShaderWithComposition');
  const compile = createShaderProgramCompiler();
  expect((await compile(source, { ...options, defines: {} })).ok).toBe(true);
  const malformed = {
    ...options,
    defines: { UNUSED: undefined } as unknown as Record<string, boolean>,
  };
  const actual = await compile(source, malformed);
  expect(admission).toHaveBeenCalledTimes(2);
  const expected = await compiler.compileShader(source, malformed);
  expect(actual.ok).toBe(expected.ok);
  if (actual.ok && expected.ok) expect(actual.value).toEqual(expected.value);
  if (!actual.ok && !expected.ok) expect(actual.error.code).toBe(expected.error.code);
});

it('reuses successful source admission only for the complete unchanged invocation', async () => {
  const admission = vi.spyOn(compiler, 'compileShaderWithComposition');
  const compile = createShaderProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  first.deps.push('caller mutation');
  const second = (await compile(source, options)).unwrap();
  expect(second.deps).not.toContain('caller mutation');
  expect(admission).toHaveBeenCalledTimes(1);
  const changed = {
    ...options,
    imports: {
      ...options.imports,
      unused: '#define_import_path unused\nfn value() -> f32 { return 1.0; }',
    },
  };
  expect((await compile(source, changed)).unwrap().deps).toContain('unused');
  expect(admission).toHaveBeenCalledTimes(2);
  const malformed = { ...options, defines: { UNUSED: 1 } as unknown as Record<string, boolean> };
  expect((await compile(source, malformed)).ok).toBe(false);
  expect((await compile(source, malformed)).ok).toBe(false);
  expect(admission).toHaveBeenCalledTimes(4);
});

it('captures selector data before awaiting a shared composition', async () => {
  const original = naga.composeShader;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(naga, 'composeShader').mockImplementation(async (...args) => {
    await gate;
    return original(...args);
  });
  const compile = createShaderProgramCompiler();
  const selected = { ...options, renderEntries: { ...options.renderEntries } };
  const pending = compile(source, selected);
  selected.renderEntries.vertex = 'missing';
  release();
  expect((await pending).ok).toBe(true);
  expect((await compile(source, selected)).ok).toBe(false);
});

it('refreshes hot composition recency and evicts validation beyond its aggregate byte budget', async () => {
  const baseline = (
    await compiler.compileShader('@compute @workgroup_size(1) fn main() {}')
  ).unwrap();
  const padding = `/*${'x'.repeat(2 * 1024 * 1024)}*/`;
  const compose = vi
    .spyOn(naga, 'composeShader')
    .mockImplementation(async (source) => `${source}\n${padding}`);
  const validation = vi
    .spyOn(compiler, 'compileShaderProgram')
    .mockImplementation(async (wgsl) =>
      ok({ ...baseline, wgsl, manifestEntry: { ...baseline.manifestEntry, wgsl } }),
    );
  const compile = createShaderProgramCompiler();
  const entry = (index: number) =>
    `@compute @workgroup_size(1) fn main() { let value = ${index}u; }`;
  for (let index = 0; index < 6; index++) expect((await compile(entry(index))).ok).toBe(true);
  expect((await compile(entry(0))).ok).toBe(true);
  for (let index = 6; index < 8; index++) expect((await compile(entry(index))).ok).toBe(true);
  const compositions = compose.mock.calls.length;
  expect((await compile(entry(0))).ok).toBe(true);
  expect(compose).toHaveBeenCalledTimes(compositions);
  for (let index = 8; index < 21; index++) expect((await compile(entry(index))).ok).toBe(true);
  const validations = validation.mock.calls.length;
  expect((await compile(entry(1))).ok).toBe(true);
  expect(validation).toHaveBeenCalledTimes(validations + 1);
});

it('shares concurrent real composition and validation and keeps every result independently mutable', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const compile = createShaderProgramCompiler();
  const [firstResult, secondResult] = await Promise.all([
    compile(source, options),
    compile(source, options),
  ]);
  const first = firstResult.unwrap();
  const second = secondResult.unwrap();
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  first.deps.push('consumer-mutation');
  Object.assign(first.reflection, { consumerMutation: true });
  expect(second.deps).not.toContain('consumer-mutation');
  expect(second.reflection).not.toHaveProperty('consumerMutation');
  expect(compose).toHaveBeenCalledTimes(1);
  expect(validation).toHaveBeenCalledTimes(1);
});

it('releases concurrent failed composition and permits the same input to retry', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const bad = {
    ...options,
    imports: { 'test::color': '#define_import_path test::color\ninvalid source' },
  };
  const results = await Promise.all([compile(source, bad), compile(source, bad)]);
  expect(results.every((result) => !result.ok)).toBe(true);
  expect(compose).toHaveBeenCalledTimes(1);
  expect((await compile(source, bad)).ok).toBe(false);
  expect(compose).toHaveBeenCalledTimes(2);
  expect((await compile(source, options)).ok).toBe(true);
});

it('keeps each source location when a shared validation fails and permits retry', async () => {
  vi.spyOn(naga, 'composeShader').mockResolvedValue('invalid composed WGSL');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const compile = createShaderProgramCompiler();
  const broken = '@compute @workgroup_size(1) fn main() { let broken = ; }';
  const results = await Promise.all([compile(broken), compile(`\n\n${broken}`)]);
  expect(validation).toHaveBeenCalledTimes(2);
  for (const [index, result] of results.entries()) {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('invalid source compiled');
    expect(result.error.lineNum).toBe(1 + index * 2);
  }
  expect((await compile(broken)).ok).toBe(false);
  expect(validation).toHaveBeenCalledTimes(3);
});

it('shares composition across entry selections while validating every selected entry', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const alternate = `${source}\n@vertex fn vs_alternate() -> @builtin(position) vec4<f32> { return vec4<f32>(1.0); }`;
  const first = (await compile(alternate, options)).unwrap();
  const second = (
    await compile(alternate, {
      ...options,
      id: 'test::alternate-selection',
      renderEntries: { ...options.renderEntries, vertex: 'vs_alternate' },
    })
  ).unwrap();
  expect(second).toEqual(first);
  expect((await compile(alternate, { ...options, renderEntries: { vertex: 'missing' } })).ok).toBe(
    false,
  );
  expect(
    (
      await compile(alternate, {
        ...options,
        renderEntries: { ...options.renderEntries, colorFormats: ['r32uint'] },
      })
    ).ok,
  ).toBe(false);
  expect(compose).toHaveBeenCalledTimes(1);
});

it('reuses composition without sharing mutable results or material state', async () => {
  const underlying = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  const expected = structuredClone(first);
  first.deps.push('consumer-mutation');
  Object.assign(first.reflection, { consumerMutation: true });
  const second = (await compile(source, options)).unwrap();
  expect(second).toEqual(expected);
  expect(underlying).toHaveBeenCalledTimes(1);
  const independent = createShaderProgramCompiler();
  expect((await independent(source, options)).unwrap()).toEqual(expected);
  expect(underlying).toHaveBeenCalledTimes(2);
});

it('shares an in-flight composition while validating distinct concurrent selections', async () => {
  const underlying = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const [first, second, invalid] = await Promise.all([
    compile(source, options),
    compile(source, { ...options, id: 'test::concurrent-selection' }),
    compile(source, { ...options, renderEntries: { vertex: 'missing' } }),
  ]);
  expect(first.ok).toBe(true);
  expect(second.unwrap()).toEqual(first.unwrap());
  expect(invalid.ok).toBe(false);
  expect(underlying).toHaveBeenCalledTimes(1);
});

it('recompiles changed imported bytes and validates changed render entries and formats', async () => {
  const compile = createShaderProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  const changed = (
    await compile(source, {
      ...options,
      imports: { 'test::color': options.imports['test::color'].replace('0.25', '0.75') },
    })
  ).unwrap();
  expect(changed.wgsl).not.toBe(first.wgsl);
  expect(changed.manifestEntry.hash).not.toBe(first.manifestEntry.hash);
  expect((await compile(source, { ...options, renderEntries: { vertex: 'missing' } })).ok).toBe(
    false,
  );
  expect(
    (
      await compile(source, {
        ...options,
        renderEntries: {
          ...options.renderEntries,
          colorFormats: ['r32uint'],
        },
      })
    ).ok,
  ).toBe(false);
});

it('does not retain failed inputs and accepts their subsequent repair', async () => {
  const underlying = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const bad = {
    ...options,
    imports: { 'test::color': '#define_import_path test::color\ninvalid source' },
  };
  expect((await compile(source, bad)).ok).toBe(false);
  expect((await compile(source, bad)).ok).toBe(false);
  expect(underlying).toHaveBeenCalledTimes(2);
  expect((await compile(source, options)).ok).toBe(true);
});

it('retires a shared failed composition before retrying the same input', async () => {
  const underlying = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const bad = {
    ...options,
    imports: { 'test::color': '#define_import_path test::color\ninvalid source' },
  };
  const failures = await Promise.all([compile(source, bad), compile(source, bad)]);
  expect(failures.every((result) => !result.ok)).toBe(true);
  expect(underlying).toHaveBeenCalledTimes(1);
  expect((await compile(source, bad)).ok).toBe(false);
  expect(underlying).toHaveBeenCalledTimes(2);
  expect((await compile(source, options)).ok).toBe(true);
});

it('retains exact validation across a mixed small-program authoring set', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const compile = createShaderProgramCompiler();
  const first = (await compile(source, options)).unwrap();
  // The measured Lab batch publishes 110 distinct validated programs. Exercise
  // real Naga programs whose joint payload fits the unchanged byte budget.
  for (let index = 1; index < 110; index++) {
    const imported = options.imports['test::color'].replace('0.25', String(0.5 + index / 256));
    expect((await compile(source, { ...options, imports: { 'test::color': imported } })).ok).toBe(
      true,
    );
  }
  const composed = compose.mock.calls.length;
  const validated = validation.mock.calls.length;
  expect((await compile(source, options)).unwrap()).toEqual(first);
  expect(compose).toHaveBeenCalledTimes(composed);
  expect(validation).toHaveBeenCalledTimes(validated);
}, 30_000);

it('shares pending compositions beyond an arbitrary entry count', async () => {
  const result = await compiler.compileShader('@compute @workgroup_size(1) fn main() {}');
  vi.spyOn(compiler, 'compileShaderProgram').mockResolvedValue(result);
  const completions: Array<() => void> = [];
  const compose = vi
    .spyOn(naga, 'composeShader')
    .mockImplementation(
      (entry) => new Promise<string>((resolve) => completions.push(() => resolve(entry))),
    );
  const compile = createShaderProgramCompiler();
  const entry = (i: number) => `@compute @workgroup_size(1) fn main() { let value = ${i}u; }`;
  const pending = Array.from({ length: 257 }, (_, i) => compile(entry(i)));
  try {
    expect(compose).toHaveBeenCalledTimes(257);
    const repeated = compile(entry(0));
    pending.push(repeated);
    expect(compose).toHaveBeenCalledTimes(257);
  } finally {
    for (const complete of completions) complete();
    await Promise.all(pending);
  }
});

it('does not retain oversized pending inputs or completed WGSL payloads', async () => {
  const entry = '@compute @workgroup_size(1) fn main() {}';
  const result = await compiler.compileShader(entry);
  vi.spyOn(compiler, 'compileShaderProgram').mockResolvedValue(result);
  // Three-byte UTF-8 content keeps the same byte limit with fewer scanned characters.
  const oversized = `/*${'\u0800'.repeat(Math.ceil((16 * 1024 * 1024) / 3))}*/\n${entry}`;
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(16 * 1024 * 1024);
  const compose = vi.spyOn(naga, 'composeShader').mockResolvedValue(entry);
  const compile = createShaderProgramCompiler();
  expect((await Promise.all([compile(oversized), compile(oversized)])).every((r) => r.ok)).toBe(
    true,
  );
  expect(compose).toHaveBeenCalledTimes(2);
  compose.mockResolvedValue(oversized);
  expect((await compile(entry)).ok).toBe(true);
  expect((await compile(entry)).ok).toBe(true);
  expect(compose).toHaveBeenCalledTimes(4);
});

it('retains many selections of the same WGSL without charging its bytes repeatedly', async () => {
  const source = '@compute @workgroup_size(1) fn main() {}';
  const baseline = (await compiler.compileShader(source)).unwrap();
  const wgsl = `${baseline.wgsl}\n/*${'x'.repeat(200 * 1024)}*/`;
  vi.spyOn(naga, 'composeShader').mockResolvedValue(wgsl);
  const validation = vi.spyOn(compiler, 'compileShaderProgram').mockResolvedValue(
    ok({
      ...baseline,
      wgsl,
      manifestEntry: { ...baseline.manifestEntry, wgsl },
    }),
  );
  const compile = createShaderProgramCompiler();
  for (let i = 0; i < 148; i++)
    expect((await compile(source, { renderEntries: { vertex: `vs_${i}` } })).ok).toBe(true);
  expect(validation).toHaveBeenCalledTimes(148);
  expect((await compile(source, { renderEntries: { vertex: 'vs_0' } })).ok).toBe(true);
  expect(validation).toHaveBeenCalledTimes(148);
});

it('keeps compile-time branches distinct even when the source string is unchanged', async () => {
  const compile = createShaderProgramCompiler();
  const entry = `@group(0) @binding(0) var<storage, read_write> output: u32;
@compute @workgroup_size(1) fn main() {
#ifdef ALTERNATE
  output = 2u;
#else
  output = 1u;
#endif
}`;
  const first = (await compile(entry, { defines: { ALTERNATE: false } })).unwrap();
  const second = (await compile(entry, { defines: { ALTERNATE: true } })).unwrap();
  expect(first.wgsl).not.toBe(second.wgsl);
});

it('reuses composition for absent defines without changing pure compiler output', async () => {
  const plain = (await compiler.compileShader(source, options)).unwrap();
  const flaggedOptions = { ...options, defines: { UNUSED_CAPABILITY: true } };
  const flagged = (await compiler.compileShader(source, flaggedOptions)).unwrap();
  expect(flagged).toEqual(plain);
  const compose = vi.spyOn(naga, 'composeShader');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const compile = createShaderProgramCompiler();
  expect((await compile(source, options)).unwrap()).toEqual(plain);
  expect((await compile(source, flaggedOptions)).unwrap()).toEqual(flagged);
  expect(compose).toHaveBeenCalledTimes(1);
  expect(validation).toHaveBeenCalledTimes(1);
});

it('reflects dynamic offsets independently of retained composition', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const entry = `@group(0) @binding(0) var<uniform> offset: vec4<f32>;
@group(0) @binding(1) var<storage, read_write> output: vec4<f32>;
@compute @workgroup_size(1) fn main() { output = offset; }`;
  const first = (await compile(entry)).unwrap();
  const second = (await compile(entry, { dynamicOffsets: [{ group: 0, binding: 0 }] })).unwrap();
  expect(second.wgsl).toBe(first.wgsl);
  expect(second.bindings[0]?.entries[0]?.buffer?.hasDynamicOffset).toBe(true);
  expect(first.bindings[0]?.entries[0]?.buffer?.hasDynamicOffset).toBe(false);
  expect(compose).toHaveBeenCalledTimes(1);
});

it('does not let a retained composition hide malformed unused defines', async () => {
  const compile = createShaderProgramCompiler();
  expect((await compile(source, options)).ok).toBe(true);
  const malformed = { ...options, defines: { UNUSED: 1 } as unknown as Record<string, boolean> };
  const expected = await compiler.compileShader(source, malformed);
  const actual = await compile(source, malformed);
  expect(expected.ok).toBe(false);
  expect(actual.ok).toBe(false);
  if (!expected.ok && !actual.ok) expect(actual.error.code).toBe(expected.error.code);
});

it('shares actual WGSL validation while retaining each source dependency projection', async () => {
  const compile = createShaderProgramCompiler();
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  const first = (await compile(source, options)).unwrap();
  const expanded = {
    ...options,
    id: 'test::different-owner',
    imports: {
      ...options.imports,
      'test::unused': '#define_import_path test::unused\nfn unused() -> f32 { return 1.0; }',
    },
  };
  const second = (await compile(source, expanded)).unwrap();
  expect(second.wgsl).toBe(first.wgsl);
  expect(second.deps).toEqual(['test::color', 'test::unused']);
  expect(first.deps).toEqual(['test::color']);
  expect(validation).toHaveBeenCalledTimes(1);
  expect(second).toEqual((await compiler.compileShader(source, expanded)).unwrap());
});

it('retains one composition while validating many independent entry selections', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const compile = createShaderProgramCompiler();
  const expected = (await compiler.compileShader(source, options)).unwrap();
  compose.mockClear();
  for (let index = 0; index < 130; index++) {
    const actual = (await compile(source, { ...options, id: `test::selection-${index}` })).unwrap();
    expect(actual).toEqual(expected);
  }
  expect((await compile(source, { ...options, renderEntries: { vertex: 'missing' } })).ok).toBe(
    false,
  );
  expect(compose).toHaveBeenCalledTimes(1);
});

it('retires cold compositions before discarding the current validation working set', async () => {
  const baseline = (
    await compiler.compileShader('@compute @workgroup_size(1) fn main() {}')
  ).unwrap();
  const padding = `/*${'x'.repeat(2 * 1024 * 1024)}*/`;
  const compose = vi
    .spyOn(naga, 'composeShader')
    .mockImplementation(async (source) => `${source}\n${padding}`);
  const validation = vi
    .spyOn(compiler, 'compileShaderProgram')
    .mockImplementation(async (wgsl) =>
      ok({ ...baseline, wgsl, manifestEntry: { ...baseline.manifestEntry, wgsl } }),
    );
  const compile = createShaderProgramCompiler();
  const entry = (index: number) =>
    `@compute @workgroup_size(1) fn main() { let value = ${index}u; }`;
  for (let index = 0; index < 9; index++) expect((await compile(entry(index))).ok).toBe(true);
  const compositions = compose.mock.calls.length;
  const validations = validation.mock.calls.length;
  // The three recent programs fit together; cold compositions must retire first.
  expect((await compile(entry(6))).ok).toBe(true);
  expect(compose).toHaveBeenCalledTimes(compositions);
  expect(validation).toHaveBeenCalledTimes(validations);
});
