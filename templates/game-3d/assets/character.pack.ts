import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { quat, vec3, type Vec3Like } from '@forgeax/engine/math';
import { definePack } from '@forgeax/engine/pack/source';
import { ok, type AnimationClip } from '@forgeax/engine/types';
import { PACKAGE_IDS } from './shared/asset-refs.ts';
import { PLAYER_RIG, PLAYER_WALK_SECONDS } from './player/player-rig.ts';
import { CONVOY_DEFAULT_RESOLUTION, convoyAssets } from './player/convoy-model.ts';

function targetPath(joint: number): readonly string[] { const names: string[] = []; let cursor = joint; while (cursor >= 0) { const entry = PLAYER_RIG[cursor]; if (entry === undefined) break; names.unshift(entry.name); cursor = entry.parent; } return ['Player', ...names]; }
function walkClip(): AnimationClip {
  const duration = PLAYER_WALK_SECONDS;
  // One closed cycle, with opposite limbs offset by half a cycle.
  const phases = [0, 1, 0, -1, 0];
  const times = Float32Array.from(phases, (_, key) => duration * key / (phases.length - 1));
  const rotationChannel = (joint: number, axis: Vec3Like, angles: readonly number[]): AnimationClip['channels'][number] => {
    const output = new Float32Array(angles.length * 4), rotation = quat.create();
    for (const [key, angle] of angles.entries()) {
      quat.fromAxisAngle(rotation, axis, angle);
      output.set(rotation, key * 4);
    }
    return { targetId: deriveAnimationTargetId(targetPath(joint)), property: 'rotation', sampler: { input: times, output, interpolation: 'LINEAR' } };
  };
  const hipSway = 0.018, hipLift = 0.035, hipTurn = 0.07, bodyLean = 0.09, chestTurn = 0.1;
  const hipPositions = new Float32Array(phases.length * 3), position = vec3.create();
  phases.forEach((phase, key) => {
    vec3.add(position, PLAYER_RIG[0].local, [hipSway * phase, hipLift * Math.abs(phase), 0]);
    hipPositions.set(position, key * 3);
  });
  const channels: AnimationClip['channels'][number][] = [
    { targetId: deriveAnimationTargetId(targetPath(0)), property: 'translation', sampler: { input: times, output: hipPositions, interpolation: 'LINEAR' } },
    rotationChannel(0, [0, 1, 0], phases.map((phase) => hipTurn * phase)),
    rotationChannel(1, [0, 0, 1], phases.map((phase) => -bodyLean * phase)),
    rotationChannel(2, [0, 1, 0], phases.map((phase) => chestTurn * phase)),
    rotationChannel(3, [0, 0, 1], phases.map((phase) => -bodyLean * phase / 2)),
  ];
  const armSwing = 0.62, legSwing = 0.48;
  const elbowRest = 0.18, elbowFlex = 0.38, elbowExtend = 0.08;
  const kneeRest = 0.05, kneeLift = 0.42, kneeStance = 0.08;
  const toeLift = 0.18, toePush = 0.12;
  for (const side of [-1, 1]) {
    const upper = side < 0 ? 4 : 6, forearm = upper + 1;
    const thigh = side < 0 ? 8 : 11, shin = thigh + 1, foot = thigh + 2;
    const swing = phases.map((phase) => -side * phase);
    channels.push(
      rotationChannel(upper, [1, 0, 0], swing.map((phase) => armSwing * phase)),
      rotationChannel(forearm, [1, 0, 0], swing.map((phase) =>
        elbowRest + Math.max(phase, 0) * (elbowFlex - elbowRest) + Math.max(-phase, 0) * (elbowExtend - elbowRest))),
      rotationChannel(thigh, [1, 0, 0], swing.map((phase) => -legSwing * phase)),
      rotationChannel(shin, [1, 0, 0], swing.map((phase) =>
        kneeRest + Math.max(phase, 0) * (kneeStance - kneeRest) + Math.max(-phase, 0) * (kneeLift - kneeRest))),
      rotationChannel(foot, [1, 0, 0], swing.map((phase) => phase * (phase > 0 ? toeLift : toePush))),
    );
  }
  return { kind: 'animation-clip', duration, channels };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.character,
  name: 'Game 3D / Character',
  parameters: [{ name: 'resolution', type: 'u32', default: 1024, minimum: 512, maximum: 2048 }],
  build: (context) =>
    ok({
      ...convoyAssets((context?.values.resolution as number | undefined) ?? CONVOY_DEFAULT_RESOLUTION),
      'animation/player-walk': walkClip(),
    }),
});
