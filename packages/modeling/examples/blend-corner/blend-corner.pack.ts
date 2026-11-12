import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildCorner, buildRoll, buildRunOut, buildSharp } from './body.ts';

/**
 * Case C-120 as an ordinary procedural asset: `mesh/blend-corner`. The `step` parameter
 * selects one of the four recorded builds (sharp knee, full 12 mm roll, run-out, setback
 * corner); only the chosen one is built, inside `build`.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c0120'),
  parameters: [
    { name: 'step', type: 'enum', default: 'run-out', values: ['sharp', 'roll', 'run-out', 'corner'] },
  ],
  build: ({ values }) => {
    const builders = { sharp: buildSharp, roll: buildRoll, 'run-out': buildRunOut, corner: buildCorner };
    return builders[values.step]().finish({ key: 'blend-corner', normals: { mode: 'weighted' } });
  },
});
