import { compileShader } from '@forgeax/engine/shader-compiler';
import { defineFeature } from '../../lab/feature';

const COMMON = `#define_import_path lab::common
fn lab_tint(c: vec3<f32>) -> vec3<f32> { return c * vec3<f32>(1.0, 0.25, 0.5); }
`;

const ROOT = `#import lab::common::lab_tint
@fragment
fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(lab_tint(vec3<f32>(1.0)), 1.0); }
`;

export default defineFeature({
  title: 'WGSL #import composition',
  catalog: 'WGSL `#import` composition',
  kind: 'headless',
  summary:
    'compileShader composes the #import graph by module id at build time and reports missing modules and cycles as structured ShaderError codes.',
  expect:
    'All checks pass: the root flattens its import into one WGSL module and lists the dependency; a missing import and an import cycle fail with shader-import-not-found and shader-circular-import.',
  async run(checks) {
    const composed = await compileShader(ROOT, {
      id: 'lab::root',
      imports: { 'lab::common': COMMON },
    });
    checks.ok('composition compiles', composed.ok, composed.ok ? undefined : composed.error.code);
    if (composed.ok) {
      checks.ok('import is flattened into the output', !composed.value.wgsl.includes('#import'));
      checks.ok('fragment entry kept', composed.value.wgsl.includes('fs_main'));
      checks.equal('deps', composed.value.deps, ['lab::common']);
    }

    const missing = await compileShader(ROOT, { id: 'lab::root', imports: {} });
    checks.equal(
      'missing module code',
      missing.ok ? 'ok' : missing.error.code,
      'shader-import-not-found',
    );
    if (!missing.ok && missing.error.detail?.code === 'shader-import-not-found') {
      checks.equal('missing import path', missing.error.detail.importPath, 'lab::common::lab_tint');
    }

    const a = `#define_import_path cyc_a\n#import cyc_b::fb\nfn fa() -> f32 { return fb(); }\n`;
    const b = `#define_import_path cyc_b\n#import cyc_a::fa\nfn fb() -> f32 { return fa(); }\n`;
    const root = `#import cyc_a::fa\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(fa()); }\n`;
    const cycle = await compileShader(root, { id: 'cyc_root', imports: { cyc_a: a, cyc_b: b } });
    checks.equal('cycle code', cycle.ok ? 'ok' : cycle.error.code, 'shader-circular-import');
    if (!cycle.ok && cycle.error.detail?.code === 'shader-circular-import') {
      checks.equal('cycle chain', cycle.error.detail.cycle, ['cyc_a', 'cyc_b', 'cyc_a']);
    }

    const nsA = a.replaceAll('cyc_a', 'lab::cyc_a').replaceAll('cyc_b', 'lab::cyc_b');
    const nsB = b.replaceAll('cyc_a', 'lab::cyc_a').replaceAll('cyc_b', 'lab::cyc_b');
    const nsCycle = await compileShader(root.replaceAll('cyc_a', 'lab::cyc_a'), {
      id: 'lab::cyc_root',
      imports: { 'lab::cyc_a': nsA, 'lab::cyc_b': nsB },
    });
    checks.ok(
      'namespaced (module::path) cycle reports shader-circular-import',
      !nsCycle.ok && nsCycle.error.code === 'shader-circular-import',
      nsCycle.ok ? 'compiled' : `${nsCycle.error.code}: ${nsCycle.error.message.slice(0, 240)}`,
    );
  },
});
