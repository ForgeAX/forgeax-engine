import { describe, expect, it } from 'vitest';
import { composeShader, emit_reflection, parse, validate } from '../index';

const ENTRY = `
#ifdef USE_COMMON
#import test::common::marker
#endif
@compute @workgroup_size(1) fn main() {
#ifdef USE_COMMON
  marker();
#endif
}`;
const UNKNOWN_AXIS = `
#define_import_path test::common
#if EXTENDED_LIGHTING_AVAILABLE == true
fn marker() {}
#else
fn marker() {}
#endif`;
const PADDING = `
#define_import_path test::common
struct Data { @size(32) value: f32 }
fn marker() {}`;
const TRANSITIVE_ENTRY = `
#import test::root::root_marker
@compute @workgroup_size(1) fn main() { root_marker(); }`;
const ROOT = `
#define_import_path test::root
#ifdef USE_COMMON
#import test::common::marker
#endif
fn root_marker() {
#ifdef USE_COMMON
  marker();
#endif
}`;

describe('raw composer imported layout preflight', () => {
  it.each([
    ['direct', ENTRY, { 'test::common': UNKNOWN_AXIS }],
    ['transitive', TRANSITIVE_ENTRY, { 'test::root': ROOT, 'test::common': UNKNOWN_AXIS }],
  ] as const)('does not preprocess unrelated %s modules without padding attributes', async (_name, entry, imports) => {
    await expect(composeShader(entry, imports, {})).resolves.toContain('fn main');
  });

  it.each([
    ['direct', ENTRY, { 'test::common': PADDING }],
    ['transitive', TRANSITIVE_ENTRY, { 'test::root': ROOT, 'test::common': PADDING }],
  ] as const)('retains conservative registered %s padding admission', async (_name, entry, imports) => {
    await expect(composeShader(entry, imports, {})).rejects.toThrow(
      /naga-oil-import-layout-admission.*@size/,
    );
  });

  it.each([
    ['size', false],
    ['align', false],
    ['size', true],
    ['align', true],
  ] as const)('rejects registered @%s materialized across directives (selected=%s)', async (attribute, selected) => {
    const common = `
#define_import_path test::common
struct Data { @
#ifdef USE_PADDING
${attribute}(32)
#endif
value: f32 }
fn marker() {}`;
    await expect(
      composeShader(
        ENTRY,
        { 'test::common': common },
        { USE_PADDING: true, ...(selected ? { USE_COMMON: true } : {}) },
      ),
    ).rejects.toThrow(new RegExp(`naga-oil-import-layout-admission.*@${attribute}`));
  });

  it.each(['size', 'align'] as const)('allows inactive registered @%s', async (attribute) => {
    const common = `
#define_import_path test::common
#if USE_PADDING == true
struct Data { @${attribute}(32) value: f32 }
#endif
fn marker() {}`;
    await expect(
      composeShader(ENTRY, { 'test::common': common }, { USE_PADDING: false }),
    ).resolves.toContain('fn main');
  });

  it('retains unknown-definition failures in a selected module', async () => {
    await expect(
      composeShader(ENTRY, { 'test::common': UNKNOWN_AXIS }, { USE_COMMON: true }),
    ).rejects.toThrow(
      /shader-compile-failed:.*(?:UnknownShaderDef|Unknown shader def).*EXTENDED_LIGHTING_AVAILABLE/,
    );
  });

  it.each([
    ['direct', ENTRY, { 'test::common': PADDING }],
    ['transitive', TRANSITIVE_ENTRY, { 'test::root': ROOT, 'test::common': PADDING }],
  ] as const)('retains the %s selected-module padding guard', async (_name, entry, imports) => {
    await expect(composeShader(entry, imports, { USE_COMMON: true })).rejects.toThrow(
      /naga-oil-import-layout-admission.*@size/,
    );
  });

  it('retains module/source definition conflicts', async () => {
    await expect(
      composeShader(
        `#define USE_COMMON\n${ENTRY}`,
        { 'test::common': PADDING },
        { USE_COMMON: false },
      ),
    ).rejects.toThrow(/inconsistent shader definition 'USE_COMMON'/);
  });

  it('ignores comment-only padding tokens before conditional preprocessing', async () => {
    const common = UNKNOWN_AXIS.replace('#if', '// @size(32)\n/* @align(32) */\n#if');
    await expect(composeShader(ENTRY, { 'test::common': common }, {})).resolves.toContain(
      'fn main',
    );
  });
});

describe('definition-independent imported IR', () => {
  const imports = { 'test::reused': '#define_import_path test::reused\nfn helper() {}' };
  const entry = `#import test::reused::helper
#if CHOICE == true
fn selected_a() { helper(); }
#else
fn selected_b() { helper(); }
#endif
@compute @workgroup_size(1) fn main() {
#if CHOICE == true
selected_a();
#else
selected_b();
#endif
}`;

  it('retains fresh entry selection and recovers after a failed entry', async () => {
    for (const choice of [true, false, true]) {
      const output = await composeShader(entry, imports, { CHOICE: choice });
      expect(output).toContain(choice ? 'selected_a' : 'selected_b');
      expect(output).not.toContain(choice ? 'selected_b' : 'selected_a');
    }
    await expect(
      composeShader(
        '#import test::missing::helper\n@compute @workgroup_size(1) fn main() { helper(); }',
        imports,
        {},
      ),
    ).rejects.toThrow();
    await expect(composeShader(entry, imports, { CHOICE: false })).resolves.toContain('selected_b');
    await expect(
      composeShader(`#define CHOICE false\n${entry}`, imports, { CHOICE: true }),
    ).rejects.toThrow(/inconsistent shader definition|InconsistentShaderDefValue/);
    await expect(composeShader(entry, imports, { CHOICE: true })).resolves.toContain('selected_a');
  });

  it('rebuilds imports when their conditional definitions change', async () => {
    const conditional = {
      'test::reused': `#define_import_path test::reused
#if CHOICE == true
fn helper() -> u32 { return 11u; }
#else
fn helper() -> u32 { return 23u; }
#endif`,
    };
    for (const choice of [true, false, true]) {
      const output = await composeShader(entry, conditional, { CHOICE: choice });
      expect(output).toContain(choice ? '11u' : '23u');
    }
  });

  it('rebuilds changed dependency tails and removes obsolete imports', async () => {
    const source = `#import test::root::value
@compute @workgroup_size(1) fn main() { let result = value(); }`;
    const stable = '#define_import_path test::stable\nfn stable() -> u32 { return 3u; }';
    for (const number of [11, 23, 11]) {
      const graph = {
        'test::stable': stable,
        'test::root': `#define_import_path test::root
#import test::stable::stable
fn value() -> u32 { return stable() + ${number}u; }`,
      };
      const output = await composeShader(source, graph, {});
      expect(output).toContain(`${number}u`);
      expect(output).toContain('stable');
    }
    await expect(
      composeShader(
        source,
        {
          'test::root': '#define_import_path test::root\nfn value() -> u32 { return 31u; }',
        },
        {},
      ),
    ).resolves.toContain('31u');
    await expect(
      composeShader(
        source,
        {
          'test::stable': stable,
          'test::root':
            '#define_import_path test::root\n#import test::stable::stable\nfn value() -> u32 { return stable(); }',
        },
        {},
      ),
    ).resolves.toContain('stable');
  });

  it('validates a previously unselected imported module when selected later', async () => {
    const graph = {
      'test::invalid': '#define_import_path test::invalid\nfn broken() -> f32 { return true; }',
    };
    const good = '@compute @workgroup_size(1) fn main() {}';
    await expect(composeShader(good, graph, {})).resolves.toContain('fn main');
    await expect(
      composeShader(
        `#import test::invalid::broken
@compute @workgroup_size(1) fn main() { let result = broken(); }`,
        graph,
        {},
      ),
    ).rejects.toThrow(/shader-compile-failed/);
    await expect(composeShader(good, graph, {})).resolves.toContain('fn main');
  });

  it('starts automatic binding allocation fresh for every request', async () => {
    const automatic = {
      'test::automatic': `#define_import_path test::automatic
@group(0) @binding(auto) var<uniform> input_value: vec4<f32>;
fn read_value() -> vec4<f32> { return input_value; }`,
    };
    const source = `#import test::automatic::read_value
@compute @workgroup_size(1) fn main() { let result = read_value(); }`;
    for (let index = 0; index < 3; index++) {
      const output = await composeShader(source, automatic, {});
      expect(output).toContain('@binding(0)');
    }
  });
});

describe('checked writer handoff', () => {
  const source = `struct Data { value: vec4<f32> }
@group(0) @binding(0) var<uniform> data: Data;
@compute @workgroup_size(1) fn main() { let value = data.value; }`;
  async function bindings(wgsl: string) {
    const parsed = await parse(wgsl);
    if (!parsed.ok) throw parsed.error;
    const validated = await validate(parsed.value);
    if (!validated.ok) throw validated.error;
    try {
      const reflection = await emit_reflection(validated.value, '{}');
      if (!reflection.ok) throw reflection.error;
      return JSON.parse(reflection.value).bindings;
    } finally {
      validated.value.free();
    }
  }

  it('moves exact checked text once and parses changed inputs independently', async () => {
    const composed = await composeShader(source, {}, {});
    const expected = await bindings(composed);
    expect(await bindings(composed)).toEqual(expected);
    const again = await composeShader(source, {}, {});
    expect(await bindings(again.replace('@binding(0)', '@binding(1)'))).not.toEqual(expected);
    const third = await composeShader(source, {}, {});
    expect((await parse(`${third} invalid source !`)).ok).toBe(false);
    expect(await bindings(third)).toEqual(expected);
  });

  it('checks transformed consumer bytes before accepting the ABI', async () => {
    await expect(
      composeShader(source, {}, {}, (wgsl) => wgsl.replaceAll('vec4<f32>', 'vec2<f32>')),
    ).rejects.toThrow(/WGSL writer changed buffer ABI/);
    await expect(composeShader(source, {}, {}, () => 'invalid WGSL !')).rejects.toThrow(
      /writer output failed to parse/,
    );
    let calls = 0;
    const normalized = await composeShader(source, {}, {}, (wgsl) => {
      calls++;
      return `${wgsl}\n`;
    });
    expect(calls).toBe(1);
    expect((await bindings(normalized)).length).toBeGreaterThan(0);
  });
});

describe('composition workspace isolation', () => {
  const entry = `#import test::value::value
@compute @workgroup_size(1) fn main() { let result = value(); }`;
  const source = `#define_import_path test::value
fn value() -> u32 {
#if FIRST == true
  return 13u;
#else
  return 29u;
#endif
}`;

  it('retires imports and definitions after success and failure', async () => {
    const first = await composeShader(entry, { 'test::value': source }, { FIRST: true });
    expect(first).toContain('13u');
    const second = await composeShader(entry, { 'test::value': source }, { FIRST: false });
    expect(second).toContain('29u');
    expect(second).not.toContain('13u');
    await expect(composeShader(entry, {}, {})).rejects.toThrow(/shader-import-not-found/);
    await expect(
      composeShader('invalid WGSL', { 'test::value': source }, { FIRST: true }),
    ).rejects.toThrow(/shader-compile-failed/);
    await expect(composeShader(entry, {}, {})).rejects.toThrow(/shader-import-not-found/);
    const replaced = await composeShader(
      entry,
      { 'test::value': '#define_import_path test::value\nfn value() -> u32 { return 47u; }' },
      {},
    );
    expect(replaced).toContain('47u');
    expect(replaced).not.toContain('13u');
    expect(replaced).not.toContain('29u');
  });

  it('starts automatic binding allocation at zero after success and partial failure', async () => {
    const automatic = `@group(0) @binding(auto) var<storage, read> input: array<u32>;
@compute @workgroup_size(1) fn main() { let value = input[0]; }`;
    const first = await composeShader(automatic, {}, {});
    expect(first).toContain('@binding(0)');
    expect(await composeShader(automatic, {}, {})).toBe(first);
    await expect(composeShader(`#import missing::value\n${automatic}`, {}, {})).rejects.toThrow(
      /shader-import-not-found/,
    );
    expect(await composeShader(automatic, {}, {})).toBe(first);
    const importedAutomatic = '#define_import_path test::automatic\n// @binding(auto)';
    await composeShader(
      '@compute @workgroup_size(1) fn main() {}',
      {
        'test::automatic': importedAutomatic,
      },
      {},
    );
    expect(await composeShader(automatic, {}, {})).toBe(first);
  });
});

it('keeps dependent imported selections exact across entry definitions', async () => {
  const imports = {
    'cache::value': `#define_import_path cache::value
fn value() -> u32 {
#if MODE == 1
 return 11u;
#else
 return 22u;
#endif
}`,
  };
  const entry = (name: string, mode: number) => `#define MODE ${mode}
#import cache::value::value
@compute @workgroup_size(1) fn ${name}() { let result = value(); }`;
  await composeShader(entry('first', 1), imports, {});
  expect(await composeShader(entry('second', 1), imports, {})).toContain('11u');
  expect(await composeShader(entry('third', 2), imports, {})).toContain('22u');
  expect(await composeShader(entry('fourth', 1), imports, {})).toContain('11u');
});

it('checks normalized writer output and recovers after a failing or reentrant normalizer', async () => {
  const { prepareNagaCompiler } = await import('../index');
  const native = (await prepareNagaCompiler()).unwrap();
  const source = `struct Data { value: f32 };
@group(0) @binding(0) var<uniform> data: Data;
@compute @workgroup_size(1) fn main() { let value = data.value; }`;
  expect(() =>
    native.composeProgram(source, {}, {}, (written) =>
      written.replace('value: f32', 'value: vec2<f32>'),
    ),
  ).toThrow(/WGSL writer changed buffer ABI/);
  expect(() =>
    native.composeProgram(source, {}, {}, () => {
      throw Error('normalization failed');
    }),
  ).toThrow(/normalization failed/);
  const composed = native.composeProgram(source, {}, {}, (written) => {
    expect(native.composeShader('@compute @workgroup_size(1) fn nested() {}', {}, {})).toContain(
      'fn nested',
    );
    return written;
  });
  try {
    expect(native.emitReflection(composed.module, '{}').ok).toBe(true);
    expect(composed.source).toContain('fn main');
  } finally {
    composed.module.free();
  }
});
