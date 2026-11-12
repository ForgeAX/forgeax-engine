import { AnimationTargetId } from '@forgeax/engine-animation';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { buildPauldron, rigPauldron } from './pauldron.ts';

/**
 * Case C-014 as an ordinary procedural asset: the subdivided, deformed shoulder armor
 * rigged to the mech-gt skeleton (`scene/pauldron`, `mesh/pauldron.pauldron`,
 * `mesh/pauldron.mount`).
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0014'),
  // The components rig.finish() writes into scene/pauldron; the Pack producer externalizes them.
  sceneComponents: [AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Transform],
  parameters: [
    { name: 'length', type: 'f32', default: 0.7, minimum: 0.6, maximum: 0.8 },
    { name: 'width', type: 'f32', default: 0.9, minimum: 0.8, maximum: 1 },
    { name: 'curl', type: 'f32', default: 105, minimum: 80, maximum: 130 },
  ],
  build: ({ values, packageId }) =>
    rigPauldron(
      buildPauldron({
        length: values.length as number,
        width: values.width as number,
        curl: values.curl as number,
      }),
    ).finish({ key: 'pauldron', packageId }),
});
