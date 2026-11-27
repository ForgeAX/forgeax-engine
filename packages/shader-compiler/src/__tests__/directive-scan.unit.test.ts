import * as types from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { compileShaderProgram, compileShaderWithComposition } from '../compile.js';
import * as conditionals from '../conditionals.js';
import { compileShader } from '../index.js';

afterEach(() => vi.restoreAllMocks());

it('projects each reachable import once while preserving conditional dependency admission', async () => {
  const helper = `#define_import_path test::helper
#ifdef EXTRA
#import test::extra::{extra}
#else
#import test::base::{base}
#endif
fn helper() {}`;
  const imports = {
    'test::helper': helper,
    'test::base': '#define_import_path test::base\nfn base() {}',
    'test::extra': '#define_import_path test::extra\nfn extra() {}',
  };
  const projection = vi.spyOn(conditionals, 'projectShaderConditionals');
  const compose = vi.fn(
    async (_source: string, _imports: Record<string, string>, _defines: Record<string, boolean>) =>
      '@compute @workgroup_size(1) fn main() {}',
  );
  const source = '#import test::helper::{helper}\n@compute @workgroup_size(1) fn main() {}';
  for (const enabled of [false, true]) {
    projection.mockClear();
    compose.mockClear();
    const result = await compileShaderWithComposition(
      source,
      { imports, defines: { EXTRA: enabled } },
      compose,
      compileShaderProgram,
    );
    expect(result.ok).toBe(true);
    expect(projection.mock.calls.filter(([source]) => source === helper)).toHaveLength(1);
    const selected = compose.mock.calls[0]?.[1] as Record<string, string> | undefined;
    expect(Object.keys(selected ?? {}).sort()).toEqual(
      ['test::helper', enabled ? 'test::extra' : 'test::base'].sort(),
    );
  }
  const missing = { ...imports, 'test::extra': '#define_import_path test::extra\n#import absent' };
  compose.mockClear();
  const rejected = await compileShaderWithComposition(
    source,
    { imports: missing },
    compose,
    compileShaderProgram,
  );
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error.code).toBe('shader-import-not-found');
  expect(compose).not.toHaveBeenCalled();
});

it('shares one projected import scan across reachability and diagnostic checks', async () => {
  const helper = '#define_import_path test::helper\nfn helper() {}';
  const unused = '#define_import_path test::unused\nfn unused() {}';
  const scan = vi.spyOn(types, 'stripWgslComments');
  const result = await compileShaderWithComposition(
    '#import test::helper::{helper}\n@compute @workgroup_size(1) fn main() {}',
    { imports: { 'test::helper': helper, 'test::unused': unused } },
    async () => '@compute @workgroup_size(1) fn main() {}',
  );
  expect(result.ok).toBe(true);
  expect(scan.mock.calls.filter(([source]) => source === helper)).toHaveLength(1);
  expect(scan.mock.calls.filter(([source]) => source === unused)).toHaveLength(1);
});

it('does not scan conditional branches in already projected ordinary modules', async () => {
  const plain = '#define_import_path test::plain\r\nfn value() -> f32 { return 0.25; }';
  const projection = vi.spyOn(conditionals, 'projectShaderConditionals');
  const compose = vi.fn(
    async (_source: string, _imports: Record<string, string>, _defines: Record<string, boolean>) =>
      '@compute @workgroup_size(1) fn main() {}',
  );
  const result = await compileShaderWithComposition(
    '#import test::plain::{value}\n@compute @workgroup_size(1) fn main() {}',
    { imports: { 'test::plain': plain }, defines: { UNUSED: true } },
    compose,
  );
  expect(result.ok).toBe(true);
  expect(projection.mock.calls.filter(([source]) => source === plain)).toHaveLength(0);
  expect(compose.mock.calls[0]?.[1]['test::plain']).toBe(plain.replace(/\r\n/g, '\n'));
});

it('keeps conditional and group-import projection behind inline comments', async () => {
  const helper = `#define_import_path test::helper
/* prefix */ #ifdef EXTRA
#import test::shared::{first}
#else
#import test::shared::{second}
#endif
#import test::shared::{third}
fn helper() {}`;
  const compose = vi.fn(
    async (_source: string, _imports: Record<string, string>, _defines: Record<string, boolean>) =>
      '@compute @workgroup_size(1) fn main() {}',
  );
  for (const enabled of [false, true]) {
    const result = await compileShaderWithComposition(
      '#import test::helper::{helper}\n@compute @workgroup_size(1) fn main() {}',
      {
        imports: {
          'test::helper': helper,
          'test::shared':
            '#define_import_path test::shared\nfn first() {}\nfn second() {}\nfn third() {}',
        },
        defines: { EXTRA: enabled },
      },
      compose,
    );
    expect(result.ok).toBe(true);
    const selected = compose.mock.lastCall?.[1]['test::helper'];
    expect(selected).toContain(`#import test::shared::{${enabled ? 'first' : 'second'}, third}`);
    expect(selected).not.toContain('#ifdef');
  }
});

it.each([
  '\n',
  '\r\n',
])('retains unused-module directive diagnostics with %j lines', async (newline) => {
  for (const indent of ['', '\t', '\v', '\f', '\uFEFF', '\u2028']) {
    const result = await compileShader('@compute @workgroup_size(1) fn main() {}', {
      id: 'test::entry',
      imports: {
        'test::unused': [
          '#define_import_path test::unused',
          '// A declaration in an unused module must still fail before Naga composition.',
          `${indent}#define VALUE 2`,
          'fn unused() {}',
        ].join(newline),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('shader-compile-failed');
      expect(result.error.message).toContain("module 'test::unused': #define VALUE 2");
    }
  }
});

it('validates directives around ordinary bodies without hiding unused missing imports', async () => {
  const body = '// #import ignored::comment\n'.repeat(128);
  const result = await compileShader(`${body}@compute @workgroup_size(1) fn main() {}`, {
    id: 'test::entry',
    imports: {
      'test::unused': `#define_import_path test::unused\n${body}\t#import missing::module`,
    },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('shader-import-not-found');
    expect(result.error.message).toContain('missing::module');
  }
});
