import { describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';

describe('compileShader source-attributed composition failures', () => {
  it('keeps the composition error instead of inventing an unresolved imported helper', async () => {
    const result = await compileShader(
      '#import test::helper::{helper}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(helper() + actually_missing); }',
      {
        id: 'test::importing-entry',
        imports: {
          'test::helper': '#define_import_path test::helper\nfn helper() -> f32 { return 1.0; }',
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('actually_missing');
  });

  it('does not replace a linked type validation failure with an unknown import', async () => {
    const result = await compileShader(
      '#import test::types::{Value}\n@fragment fn fs_main() -> @location(0) u32 { let v = Value(1u); return vec4f(f32(v.index)); }',
      {
        imports: {
          'test::types': '#define_import_path test::types\nstruct Value { index: u32, };',
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain('invalid');
    expect(result.error.message).not.toContain('no definition in scope');
  });

  it('strips host pragmas and specializes axes in imported modules', async () => {
    const outputs: string[] = [];
    for (const enabled of [false, true]) {
      const result = await compileShader(
        '#import test::helper::{helper}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(helper()); }',
        {
          id: 'test::imported-axis',
          defines: { EXTRA: enabled },
          imports: {
            'test::helper': `#define_import_path test::helper
#pragma variant_axis EXTRA
fn helper() -> f32 {
#ifdef EXTRA
return 1.0;
#else
return 0.25;
#endif
}`,
          },
        },
      );
      if (!result.ok) throw result.error;
      expect(result.value.wgsl).not.toContain('#pragma');
      outputs.push(result.value.wgsl);
    }
    expect(outputs[0]).not.toBe(outputs[1]);
  });

  it('retains structured line and column when composition rejects WGSL syntax', async () => {
    const source = [
      '#define_import_path test::pulse',
      '#import forgeax_view::common',
      '',
      '@fragment',
      'fn fs_main() -> @location(0) vec4<f32> {',
      '  let broken = ;',
      '  return vec4<f32>(1.0);',
      '}',
    ].join('\n');

    const result = await compileShader(source, {
      id: '/workspace/pulse.wgsl',
      imports: {
        'forgeax_view::common': '#define_import_path forgeax_view::common\n',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.lineNum).toBe(6);
    expect(result.error.linePos).toBeGreaterThan(0);
    expect(result.error.expected).toBe('WGSL source parses + validates against naga IR');
    expect(result.error.hint).toContain('indicated line/column');
  });
});
