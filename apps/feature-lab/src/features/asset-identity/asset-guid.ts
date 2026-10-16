import { BUILTIN_HANDLE_CUBE, deriveBuiltin } from '@forgeax/engine/pack/builtin';
import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';
import { defineFeature } from '../../lab/feature';

const SAMPLE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const PACKAGE = '0190a1b2-0000-7000-8000-000000000001';

export default defineFeature({
  title: 'AssetGuid',
  catalog: 'AssetGuid',
  kind: 'headless',
  summary:
    'UUID parse/format/equals/random plus UUIDv5 derive (PackageId + sourceKey) and builtin derivation.',
  expect:
    'Round trip is lossless, malformed strings return pack-guid-malformed, random is UUIDv7, derive is stable.',
  run(checks) {
    const parsed = AssetGuid.parse(SAMPLE);
    checks.ok('parse accepts dash-form UUID', parsed.ok);
    if (!parsed.ok) return;
    checks.equal('format round-trips lowercase', AssetGuid.format(parsed.value), SAMPLE);
    const upper = AssetGuid.parse(SAMPLE.toUpperCase());
    checks.ok(
      'parse is case-insensitive and equals()',
      upper.ok && AssetGuid.equals(upper.value, parsed.value),
    );
    checks.equal('guid is 16 bytes', parsed.value.byteLength, 16);

    const bad = AssetGuid.parse('not-a-guid');
    checks.equal(
      'malformed returns structured error',
      bad.ok ? 'ok' : bad.error.code,
      'pack-guid-malformed',
    );

    const a = AssetGuid.random();
    const b = AssetGuid.random();
    checks.ok('random mints distinct guids', !AssetGuid.equals(a, b));
    checks.equal('random is UUIDv7', AssetGuid.format(a)[14], '7');

    const pkg = PackageId.parse(PACKAGE);
    checks.ok('PackageId parses', pkg.ok);
    if (!pkg.ok) return;
    const d1 = AssetGuid.format(AssetGuid.derive(pkg.value, 'meshes/hero'));
    const d2 = AssetGuid.format(AssetGuid.derive(pkg.value, 'meshes/hero'));
    const d3 = AssetGuid.format(AssetGuid.derive(pkg.value, 'meshes/villain'));
    checks.equal('derive is deterministic', d1, d2);
    checks.ok('different sourceKey derives a different guid', d1 !== d3);
    checks.equal('derive is UUIDv5', d1[14], '5');
    let invalidCode = '';
    try {
      AssetGuid.derive(pkg.value, 'Bad Key');
    } catch (error) {
      invalidCode = String((error as { code?: string }).code);
    }
    checks.equal(
      'invalid sourceKey is a programmer error with code',
      invalidCode,
      'pack-source-key-invalid',
    );

    checks.equal(
      'builtin cube constant matches deriveBuiltin',
      AssetGuid.format(deriveBuiltin('HANDLE_CUBE')),
      BUILTIN_HANDLE_CUBE,
    );
  },
});
