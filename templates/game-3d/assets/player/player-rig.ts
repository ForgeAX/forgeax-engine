import type { JointSpec, Tuple3 } from '@forgeax/engine/modeling';
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
  readonly modeling: JointSpec;
}

export const CONVOY_WHEELS = CONVOY_LAYOUT.wheels;


export const PLAYER_COLLIDER = CONVOY_LAYOUT.collider;


export const nativeJointName = (name: string) => name.toLowerCase().replaceAll('.', '-');

export function createPlayerRig(layout: ConvoyLayout = CONVOY_LAYOUT): readonly PlayerJoint[] {
  const joints: PlayerJoint[] = [];
  const names = new Map<string, number>();
  const { body, arm, leg, rear } = layout;
  let role: PlayerJoint['role'] = 'body';
  const add = (name: string, parentName: string | undefined, anchor: Position, motion: Omit<JointSpec, 'name' | 'parent' | 'position'> = { kind: 'spherical' }) => {
    const parent = parentName === undefined ? -1 : names.get(parentName)!;
    const origin = parent < 0 ? [0, 0, 0] as const : joints[parent]!.world;
    const local: Position = [anchor[0] - origin[0], anchor[1] - origin[1], anchor[2] - origin[2]];
    const world = vec3.add(vec3.create(), local, origin);
    const position: Tuple3 = [world[0]!, world[1]!, world[2]!];
    names.set(name, joints.length);
    joints.push({ name, parent, local, world: position, role, modeling: { name: nativeJointName(name), parent: parentName === undefined ? null : nativeJointName(parentName), position, ...motion } });
  };
  add('Hips', undefined, [0, body.hipsY, 0], { kind: 'prismatic', axis: 'y', limits: [layout.vehicle.hipsFold, leg.stroke + 0.01] });
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
    add(`Thigh.${suffix}`, 'Hips', [side * body.hipX, body.thighY, 0], { kind: 'revolute', axis: 'x', limits: [-90, 0] });
    add(`Shin.${suffix}`, `Thigh.${suffix}`, [side * body.ankleX, body.kneeY, 0], { kind: 'prismatic', axis: 'y', limits: [-leg.stroke, 0] });
    add(`Foot.${suffix}`, `Shin.${suffix}`, [side * body.ankleX, body.ankleY, -0.06], { kind: 'revolute', axis: 'x', limits: [0, 90], mimic: { joint: nativeJointName(`Thigh.${suffix}`), ratio: -1 } });
  }
  role = 'mechanism';
  add('AbdomenSlide', 'Spine', [0, body.spineY, 0], { kind: 'prismatic', axis: 'y', limits: [0, layout.abdomen.stroke] });
  add('HeadSlideBase', 'Head', [0, body.neckY, 0], { kind: 'prismatic', axis: 'y', limits: [-layout.head.travel, 0] });
  add('HeadSlide', 'HeadSlideBase', [0, body.neckY, 0], { kind: 'prismatic', axis: 'y', limits: [-layout.head.travel, 0], mimic: { joint: nativeJointName('HeadSlideBase'), ratio: 1 } });
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    add(`ShinCover.${suffix}`, `Shin.${suffix}`, [side * leg.shellX, leg.coverY, leg.coverZ], { kind: 'revolute', axis: 'x', limits: [0, 210] });
  }
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    const front = layout.wheels.find(wheel => wheel.name === `WheelFront.${suffix}`)!;
    add(`FrontGimbalX.${suffix}`, `UpperArm.${suffix}`, [front.position[0] - side * (arm.spindleOutboard + arm.gimbalSpacing), front.position[1], front.position[2]], { kind: 'revolute', axis: 'x', limits: [-90, 90] });
    add(`FrontGimbalZ.${suffix}`, `FrontGimbalX.${suffix}`, [front.position[0] - side * arm.spindleOutboard, front.position[1], front.position[2]], { kind: 'revolute', axis: 'z', limits: [-90, 90] });
    add(front.name, `FrontGimbalZ.${suffix}`, front.position, { kind: 'revolute', axis: 'x' });
    const bogie: Tuple3 = [side * rear.bogieX, rear.wheelY, 0];
    add(`RearBogie.${suffix}`, `Shin.${suffix}`, bogie, { kind: 'revolute', axis: 'x', limits: [0, 90], mimic: { joint: nativeJointName(`Thigh.${suffix}`), ratio: -1 } });
    const track = { kind: 'prismatic', axis: 'x', limits: [Math.min(0, side * rear.travel), Math.max(0, side * rear.travel)] } as const;
    add(`RearTrackBase.${suffix}`, `RearBogie.${suffix}`, bogie, track);
    add(`RearTrack.${suffix}`, `RearTrackBase.${suffix}`, bogie, { ...track, mimic: { joint: nativeJointName(`RearTrackBase.${suffix}`), ratio: 1 } });
    for (const wheel of layout.wheels.filter(wheel => wheel.name.startsWith('WheelRear') && wheel.name.endsWith(suffix))) {
      add(wheel.name, `RearTrack.${suffix}`, wheel.position, { kind: 'revolute', axis: 'x' });
    }
  }
  return joints;
}

export const PLAYER_RIG = createPlayerRig();
export const PLAYER_JOINT_NAMES = PLAYER_RIG.map((joint) => joint.name);
const jointIndices = new Map(PLAYER_JOINT_NAMES.map((name, index) => [name, index]));
export const playerJointIndex = (name: string): number => {
  const index = jointIndices.get(name);
  if (index === undefined) throw new Error(`Unknown player joint: ${name}`);
  return index;
};
export const convoyJointSpecs = (layout: ConvoyLayout = CONVOY_LAYOUT) => createPlayerRig(layout).map(joint => joint.modeling);

export function playerTargetPath(index: number): readonly string[] {
  const path: string[] = [];
  for (let joint = index; joint >= 0; joint = PLAYER_RIG[joint]!.parent) path.unshift(PLAYER_RIG[joint]!.name);
  return ['Player', ...path];
}
