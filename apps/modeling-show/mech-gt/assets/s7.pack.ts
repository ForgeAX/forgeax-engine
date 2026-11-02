import { definePack } from '@forgeax/engine/pack/source';
import s7 from '../../../../packages/modeling/examples/mech-gt/s7.pack.ts';

/** The S7 assembly with its forward clip: car -> robot once, ending on the robot hold. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: s7.packageId,
  sceneComponents: s7.sceneComponents ?? [],
  build: (context) =>
    (s7.build as (c: unknown) => ReturnType<typeof s7.build>)({ ...context, values: { sheet: 0, roundTrip: 0 } }),
});
