import type { Tuple3 } from '@forgeax/engine/modeling';
import { vec3 } from '@forgeax/engine/math';
import { CONVOY_LAYOUT, type ConvoyLayout } from './convoy-layout.ts';

export const PLAYER_WALK_SECONDS = 1;
export const PLAYER_TRANSFORM_SECONDS = 4;
export const PLAYER_WHEEL_RADIUS = CONVOY_LAYOUT.wheel.radius;

type Position = readonly [number, number, number];

interface PlayerJoint {
  readonly name: string;
  readonly parent: number;
  readonly local: Position;
  readonly world: Position;
  readonly role: 'body' | 'mechanism';
}

export const CONVOY_WHEELS = CONVOY_LAYOUT.wheels;


export const PLAYER_COLLIDER = CONVOY_LAYOUT.collider;


export function createPlayerRig(layout: ConvoyLayout = CONVOY_LAYOUT): readonly PlayerJoint[] {
  const joints: PlayerJoint[] = [];
  const names = new Map<string, number>();
  const { body, arm, leg, rear } = layout;
  let role: PlayerJoint['role'] = 'body';
  const add = (name: string, parentName: string | undefined, anchor: Position) => {
    const parent = parentName === undefined ? -1 : names.get(parentName)!;
    const origin = parent < 0 ? [0, 0, 0] as const : joints[parent]!.world;
    const local: Position = [anchor[0] - origin[0], anchor[1] - origin[1], anchor[2] - origin[2]];
    const world = vec3.add(vec3.create(), local, origin);
    names.set(name, joints.length);
    joints.push({ name, parent, local, world: [world[0], world[1], world[2]], role });
  };
  add('Hips', undefined, [0, body.hipsY, 0]);
  add('Spine', 'Hips', [0, body.spineY, 0]);
  add('Chest', 'Spine', [0, body.chestY, 0]);
  add('Head', 'Chest', [0, body.neckY, 0]);
  // Names own topology; solved assembly hardpoints own anchors and inverse binds.
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    add(`UpperArm.${suffix}`, 'Chest', [side * body.shoulderX, body.shoulderY, 0]);
    add(`Forearm.${suffix}`, `UpperArm.${suffix}`, [side * arm.elbowX, arm.elbowY, 0]);
  }
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    add(`Thigh.${suffix}`, 'Hips', [side * body.hipX, body.thighY, 0]);
    add(`Shin.${suffix}`, `Thigh.${suffix}`, [side * body.ankleX, body.kneeY, 0]);
    add(`Foot.${suffix}`, `Shin.${suffix}`, [side * body.ankleX, body.ankleY, -0.06]);
  }
  role = 'mechanism';
  add('AbdomenSlide', 'Spine', [0, body.spineY, 0]);
  add('HeadSlideBase', 'Head', [0, body.neckY, 0]);
  add('HeadSlide', 'HeadSlideBase', [0, body.neckY, 0]);
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    add(`ShinCover.${suffix}`, `Shin.${suffix}`, [side * leg.shellX, leg.coverY, leg.coverZ]);
  }
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    const front = layout.wheels.find(wheel => wheel.name === `WheelFront.${suffix}`)!;
    add(`FrontGimbalX.${suffix}`, `UpperArm.${suffix}`, [front.position[0] - side * (arm.spindleOutboard + arm.gimbalSpacing), front.position[1], front.position[2]]);
    add(`FrontGimbalZ.${suffix}`, `FrontGimbalX.${suffix}`, [front.position[0] - side * arm.spindleOutboard, front.position[1], front.position[2]]);
    add(front.name, `FrontGimbalZ.${suffix}`, front.position);
    const bogie: Tuple3 = [side * rear.bogieX, rear.wheelY, 0];
    add(`RearBogie.${suffix}`, `Shin.${suffix}`, bogie);
    add(`RearTrackBase.${suffix}`, `RearBogie.${suffix}`, bogie);
    add(`RearTrack.${suffix}`, `RearTrackBase.${suffix}`, bogie);
    for (const wheel of layout.wheels.filter(wheel => wheel.name.startsWith('WheelRear') && wheel.name.endsWith(suffix))) {
      add(wheel.name, `RearTrack.${suffix}`, wheel.position);
    }
  }
  return joints;
}

export const PLAYER_RIG = createPlayerRig();
export const PLAYER_JOINT_NAMES = PLAYER_RIG.map((joint) => joint.name);

export function playerTargetPath(index: number): readonly string[] {
  const path: string[] = [];
  for (let joint = index; joint >= 0; joint = PLAYER_RIG[joint]!.parent) path.unshift(PLAYER_RIG[joint]!.name);
  return ['Player', ...path];
}
