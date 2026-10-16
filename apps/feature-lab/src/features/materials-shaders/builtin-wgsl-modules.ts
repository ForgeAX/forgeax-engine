import {
  BUILTIN_MATERIAL_MODULES,
  createBuiltinMaterialAsset,
  DEFAULT_MSDF_TEXT_PARAM_SCHEMA,
  DEFAULT_SPRITE_PARAM_SCHEMA,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  ENGINE_MATERIAL_MODULES,
  isEngineMaterialModule,
} from '@forgeax/engine/shader';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Built-in WGSL modules',
  catalog: 'Built-in WGSL modules',
  kind: 'headless',
  summary:
    'The shader package ships engine-owned material modules (Standard PBR, skinned PBR, unlit, sprite, sprite-lit, MSDF text, shadow caster) and their default param schemas.',
  expect:
    'All checks pass: every family is in ENGINE_MATERIAL_MODULES, built-in assets point at them, and a game module id is not treated as engine-owned.',
  run(checks) {
    for (const id of [
      'forgeax::default-standard-pbr',
      'forgeax::default-standard-pbr-skin',
      'forgeax::default-unlit',
      'forgeax::default-shadow-caster',
      'forgeax::sprite',
      'forgeax::sprite-lit',
      'forgeax::msdf-text',
    ]) {
      checks.ok(`engine module ${id}`, (ENGINE_MATERIAL_MODULES as readonly string[]).includes(id));
    }
    for (const kind of ['standard', 'unlit', 'sprite'] as const) {
      const asset = createBuiltinMaterialAsset(kind);
      checks.equal(
        `${kind} asset module`,
        asset.passes?.[0]?.program.module,
        BUILTIN_MATERIAL_MODULES[kind],
      );
      checks.ok(
        `${kind} module is engine-owned`,
        isEngineMaterialModule(BUILTIN_MATERIAL_MODULES[kind]),
      );
    }
    checks.ok('game module is not engine-owned', !isEngineMaterialModule('game::pulse'));
    checks.ok(
      'Standard schema has baseColor',
      DEFAULT_STANDARD_PBR_PARAM_SCHEMA.some((e) => e.name === 'baseColor'),
    );
    checks.ok('Unlit schema is non-empty', DEFAULT_UNLIT_PARAM_SCHEMA.length > 0);
    checks.ok('Sprite schema is non-empty', DEFAULT_SPRITE_PARAM_SCHEMA.length > 0);
    checks.ok('MSDF text schema is non-empty', DEFAULT_MSDF_TEXT_PARAM_SCHEMA.length > 0);
  },
});
