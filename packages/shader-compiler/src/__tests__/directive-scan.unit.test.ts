import { expect, it } from 'vitest';
import { compileShader } from '../index.js';

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
