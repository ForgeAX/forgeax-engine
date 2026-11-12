import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildWheel } from './wheel.ts';

/** Case C-013 as an ordinary procedural asset: `mesh/wheel`, a tire and hub cap unwrapped (LSCM, ExpMap) and packed into one atlas. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0013'),
  parameters: [
    { name: 'grooveDepth', type: 'f32', default: 0.01, minimum: 0.004, maximum: 0.014 },
    { name: 'pocketDepth', type: 'f32', default: 0.007, minimum: 0.003, maximum: 0.01 },
    { name: 'segments', type: 'u32', default: 64, minimum: 32, maximum: 96 },
  ],
  build: ({ values }) =>
    buildWheel({
      grooveDepth: values.grooveDepth as number,
      pocketDepth: values.pocketDepth as number,
      segments: values.segments as number,
    }).finish({ key: 'wheel', normals: { mode: 'autoSmooth', angle: 40 } }),
});
