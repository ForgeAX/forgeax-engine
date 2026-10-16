import { compileShader, createMaterialSpecializationKey } from '@forgeax/engine/shader-compiler';
import { defineFeature } from '../../lab/feature';

const SOURCE = `@fragment
fn fs_main() -> @location(0) vec4<f32> {
#ifdef LAB_RED
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
#else
  return vec4<f32>(0.0, 0.0, 1.0, 1.0);
#endif
}
`;

function key(defs: Readonly<Record<string, boolean>>) {
  return createMaterialSpecializationKey({
    contractHash: 'lab-contract',
    passes: [{ name: 'Forward', module: 'lab::variant', defs }],
    vertexInputs: [],
    versions: { profile: 'lab', adapter: 'lab', compiler: 'lab' },
  }).digest;
}

export default defineFeature({
  title: 'Shader variants',
  catalog: 'Shader variants',
  kind: 'headless',
  summary:
    'Boolean #ifdef defines select deterministic specializations; each define set has its own WGSL, manifest hash, and material specialization key.',
  expect:
    'All checks pass: LAB_RED on/off produce different WGSL and hashes, recompiling the same set is byte-identical, and the specialization key follows the define set, not its key order.',
  async run(checks) {
    const red = await compileShader(SOURCE, { id: 'lab::variant', defines: { LAB_RED: true } });
    const blue = await compileShader(SOURCE, { id: 'lab::variant', defines: { LAB_RED: false } });
    const again = await compileShader(SOURCE, { id: 'lab::variant', defines: { LAB_RED: true } });
    checks.ok('both variants compile', red.ok && blue.ok);
    if (!red.ok || !blue.ok || !again.ok) return;
    checks.ok(
      'red variant keeps the red branch',
      red.value.wgsl.includes('1f, 0f, 0f') || red.value.wgsl.includes('1.0, 0.0, 0.0'),
    );
    checks.ok('variants differ in WGSL', red.value.wgsl !== blue.value.wgsl);
    checks.ok(
      'variants differ in manifest hash',
      red.value.manifestEntry.hash !== blue.value.manifestEntry.hash,
    );
    checks.equal(
      'same defines are deterministic',
      again.value.manifestEntry.hash,
      red.value.manifestEntry.hash,
    );

    checks.ok(
      'specialization key tracks defines',
      key({ LAB_RED: true }) !== key({ LAB_RED: false }),
    );
    checks.equal(
      'key ignores define order',
      key({ A: true, B: false }),
      key({ B: false, A: true }),
    );
  },
});
