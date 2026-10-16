import { emit_reflection, parse, validate } from '@forgeax/engine/naga';
import { defineFeature } from '../../lab/feature';

const GOOD = `struct Params { tint: vec4<f32> };
@group(1) @binding(0) var<uniform> params: Params;
@fragment
fn fs_main() -> @location(0) vec4<f32> { return params.tint; }
`;

export default defineFeature({
  title: 'Naga validation and reflection',
  catalog: 'Naga validation/reflection',
  kind: 'headless',
  summary:
    'The naga package is a thin shell over Naga WASM: parse, validate, and emit reflection JSON, with structured ShaderError on failure.',
  expect:
    'All checks pass: valid WGSL parses, validates and reflects group 1 binding 0; a syntax error fails parse and a type error fails validation with shader-compile-failed.',
  async run(checks) {
    const parsed = await parse(GOOD);
    checks.ok('valid WGSL parses', parsed.ok, parsed.ok ? undefined : parsed.error.message);
    if (!parsed.ok) return;
    const validated = await validate(parsed.value);
    checks.ok(
      'valid WGSL validates',
      validated.ok,
      validated.ok ? undefined : validated.error.message,
    );
    if (validated.ok) {
      const reflection = await emit_reflection(validated.value, '{}');
      checks.ok(
        'reflection emitted',
        reflection.ok,
        reflection.ok ? undefined : reflection.error.message,
      );
      if (reflection.ok) {
        checks.ok(
          'reflection names group 1 binding 0',
          /"group":\s*1/.test(reflection.value) && /"binding":\s*0/.test(reflection.value),
          reflection.value.slice(0, 200),
        );
      }
    }

    const syntax = await parse('fn broken( -> {');
    checks.equal(
      'syntax error code',
      syntax.ok ? 'ok' : syntax.error.code,
      'shader-compile-failed',
    );

    const typed = await parse(
      '@fragment fn fs_main() -> @location(0) vec4<f32> { let x: f32 = 1; return vec4<f32>(x); }\nfn bad() -> f32 { return vec2<f32>(1.0); }\n',
    );
    if (typed.ok) {
      const invalid = await validate(typed.value);
      checks.equal(
        'type error fails validation',
        invalid.ok ? 'ok' : invalid.error.code,
        'shader-compile-failed',
      );
    } else {
      checks.equal('type error rejected at parse', typed.error.code, 'shader-compile-failed');
    }
  },
});
