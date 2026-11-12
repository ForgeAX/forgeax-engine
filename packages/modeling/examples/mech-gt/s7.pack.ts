import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine-animation';
import { rigJobSources } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { S7_JOB, S7_OUTPUTS } from './s7-job.ts';

/**
 * C-100 stage S7: the transformation animation. The rig writes one mesh per rigid part
 * (S3 panels and volumes, S5 joint hardware, cylinders and gears), `scene/s7` with the
 * joint hierarchy and `animation-clip/s7` that the scene's AnimationPlayer plays: the round
 * trip car -> mech -> car, or with `roundTrip` 0 the car -> mech run alone (u is then the
 * transformation progress). `sheet` 1 keeps the skin as open panels for
 * `forgeax model interference`. The rig takes about two minutes to build, so every output
 * is a `modeling-mesh-job` cook source: register `createMeshJobCooker([S7_JOB])` in the
 * project's build plugin (one cooker build serves all outputs).
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c1070'),
  sceneComponents: [AnimationPlayer, AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Transform],
  parameters: [
    { name: 'sheet', type: 'f32', default: 0, minimum: 0, maximum: 1 },
    { name: 'roundTrip', type: 'f32', default: 1, minimum: 0, maximum: 1 },
  ],
  build: ({ values, packageId }) =>
    rigJobSources(S7_JOB, {
      key: 's7',
      packageId,
      params: { sheet: (values.sheet as number) >= 0.5, roundTrip: (values.roundTrip as number) >= 0.5 },
      outputs: S7_OUTPUTS,
    }),
});
