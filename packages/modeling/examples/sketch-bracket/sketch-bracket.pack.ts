import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { BRACKET_DEFAULTS, buildBracket } from './sketch-bracket.ts';

/** Case sketch-bracket as an ordinary procedural asset, `mesh/bracket`. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0501'),
  parameters: [
    { name: 'length', type: 'f32', default: BRACKET_DEFAULTS.length, minimum: 0.1, maximum: 0.16 },
    { name: 'height', type: 'f32', default: BRACKET_DEFAULTS.height, minimum: 0.05, maximum: 0.08 },
    { name: 'slantDegrees', type: 'f32', default: BRACKET_DEFAULTS.slantDegrees, minimum: 60, maximum: 85 },
    { name: 'thickness', type: 'f32', default: BRACKET_DEFAULTS.thickness, minimum: 0.006, maximum: 0.016 },
  ],
  build: ({ values }) =>
    buildBracket({
      ...BRACKET_DEFAULTS,
      length: values.length as number,
      height: values.height as number,
      slantDegrees: values.slantDegrees as number,
      thickness: values.thickness as number,
    }).finish({ key: 'bracket', normals: { mode: 'weighted' } }),
});
