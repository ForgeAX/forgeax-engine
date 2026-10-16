import {
  type AssetGuid,
  type MaterialAsset,
  type MaterialTable,
  resolveMaterialAsset,
} from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GRANDCHILD = '33333333-3333-4333-8333-333333333333';
const MISSING = '44444444-4444-4444-8444-444444444444';

function guid(text: string): AssetGuid {
  const hex = text.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  ) as AssetGuid;
}

const root: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax_material::unlit' } }],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'glow', type: 'f32', optional: true },
  ],
  values: { baseColor: [1, 1, 1, 1], glow: 2 },
};

export default defineFeature({
  title: 'Material inheritance',
  catalog: 'Material inheritance',
  kind: 'headless',
  summary:
    'A child MaterialAsset names a parent GUID and carries only values; resolution walks the chain, inherits passes and parameters, overrides values, and a null clears an optional value.',
  expect:
    'All checks pass: the grandchild resolves to a three-link chain with the root pass, the child color override, and glow cleared; missing and circular parents return structured errors.',
  run(checks) {
    const table: MaterialTable = {
      [ROOT]: root,
      [CHILD]: { kind: 'material', parent: guid(ROOT), values: { baseColor: [1, 0, 0, 1] } },
      [GRANDCHILD]: { kind: 'material', parent: guid(CHILD), values: { glow: null } },
    };
    const resolved = resolveMaterialAsset(GRANDCHILD, table);
    checks.ok('grandchild resolves', resolved.ok, resolved.ok ? undefined : resolved.error.code);
    if (resolved.ok) {
      checks.equal('chain root -> child -> grandchild', resolved.value.chain, [
        ROOT,
        CHILD,
        GRANDCHILD,
      ]);
      checks.equal(
        'pass inherited from root',
        resolved.value.asset.passes?.[0]?.program.module,
        'forgeax_material::unlit',
      );
      checks.equal('child override wins', resolved.value.asset.values?.baseColor, [1, 0, 0, 1]);
      checks.ok('null clears the optional value', resolved.value.asset.values?.glow === undefined);
    }

    const orphan = resolveMaterialAsset(CHILD, {
      [CHILD]: { kind: 'material', parent: guid(MISSING) },
    });
    checks.equal(
      'missing parent code',
      orphan.ok ? 'ok' : orphan.error.code,
      'material-parent-not-found',
    );

    const loop = resolveMaterialAsset(CHILD, {
      [CHILD]: { kind: 'material', parent: guid(GRANDCHILD) },
      [GRANDCHILD]: { kind: 'material', parent: guid(CHILD) },
    });
    checks.equal('cycle code', loop.ok ? 'ok' : loop.error.code, 'material-circular-inheritance');

    const typo = resolveMaterialAsset(CHILD, {
      [ROOT]: root,
      [CHILD]: { kind: 'material', parent: guid(ROOT), values: { baseColour: [0, 0, 1, 1] } },
    });
    checks.equal(
      'unknown value name code',
      typo.ok ? 'ok' : typo.error.code,
      'material-value-unknown',
    );

    const wrongType = resolveMaterialAsset(CHILD, {
      [ROOT]: root,
      [CHILD]: { kind: 'material', parent: guid(ROOT), values: { glow: [1, 2] } },
    });
    checks.equal(
      'value type mismatch code',
      wrongType.ok ? 'ok' : wrongType.error.code,
      'material-value-type-mismatch',
    );
  },
});
