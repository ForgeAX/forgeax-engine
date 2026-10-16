import { vec3 } from '@forgeax/engine/math';

type Position = readonly [number, number, number];

interface PlayerJoint {
  readonly name: string;
  readonly parent: number;
  readonly local: Position;
  readonly world: Position;
}

function createPlayerRig(): readonly PlayerJoint[] {
  const joints: PlayerJoint[] = [];
  const add = (name: string, parent: number, local: Position) => {
    const world = vec3.add(vec3.create(), local, parent < 0 ? [0, 0, 0] : joints[parent]!.world);
    joints.push({ name, parent, local, world: [world[0], world[1], world[2]] });
    return joints.length - 1;
  };
  const hips = add('Hips', -1, [0, -0.12, 0]);
  const spine = add('Spine', hips, [0, 0.3, 0]);
  const chest = add('Chest', spine, [0, 0.31, 0]);
  add('Head', chest, [0, 0.36, 0]);
  // Local joint offsets are the rest-pose authority. Mirror each chain once;
  // world anchors, mesh placement and inverse binds all follow from this rig.
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    const upper = add(`UpperArm.${suffix}`, chest, [side * 0.34, 0.02, 0]);
    add(`Forearm.${suffix}`, upper, [side * 0.3, -0.28, 0]);
  }
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    const thigh = add(`Thigh.${suffix}`, hips, [side * 0.17, -0.13, 0]);
    const shin = add(`Shin.${suffix}`, thigh, [side * 0.01, -0.34, 0]);
    add(`Foot.${suffix}`, shin, [0, -0.29, -0.06]);
  }
  return joints;
}

export const PLAYER_RIG = createPlayerRig();
export const PLAYER_JOINT_NAMES = PLAYER_RIG.map((joint) => joint.name);
