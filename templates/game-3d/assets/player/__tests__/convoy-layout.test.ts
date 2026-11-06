import { describe, expect, it } from 'vitest';
import { createPlayerRig, convoyJointSpecs, nativeJointName, playerJointIndex, playerTargetPath } from '../player-rig.ts';
import { createConvoyLayout } from '../convoy-layout.ts';

describe('Convoy dimension constraints', () => {
  it.each([{}, { cabWidth: 1.02 }, { cabDepth: 0.71 }, { cabInteriorHeight: 0.40 }, { wheelRadius: 0.245 }, { legGuideLength: 0.69 }])('solves wheel contact, fold reach and telescope engagement for %j', dimensions => {
    const layout = createConvoyLayout(dimensions);
    const { leg, rear, wheel, vehicle, body } = layout;
    expect(leg.rodY + leg.rodLength / 2 - leg.stroke - leg.guideBottom).toBeCloseTo(leg.minimumEngagement, 12);
    expect(leg.guideBottom - (leg.footY + leg.footHeight / 2)).toBeCloseTo(0.015, 12);
    expect(rear.pitch - wheel.radius * 2).toBeCloseTo(0.07, 12);
    for (const axle of layout.wheels) {
      expect(axle.vehicle[1] - wheel.radius).toBeCloseTo(vehicle.groundY, 12);
      expect(Math.abs(axle.vehicle[0])).toBeCloseTo(vehicle.trackX, 12);
    }
    expect(rear.wheelX + rear.travel * 2).toBeCloseTo(vehicle.trackX, 12);
    expect(body.thighY + vehicle.hipsFold).toBeCloseTo(vehicle.wheelY, 12);
    expect(vehicle.rearAxleZ).toBeCloseTo(body.thighY - rear.wheelY + leg.stroke, 12);
  });

  it.each([{}, { cabWidth: 1.02 }, { cabDepth: 0.71 }, { cabInteriorHeight: 0.40 }])('fits the retracting head and derives contiguous roof spans for %j', dimensions => {
    const { cab, head, abdomen, body } = createConvoyLayout(dimensions);
    expect(cab.roofSide.center[0] - cab.roofSide.size[0] / 2).toBeCloseTo(cab.opening.halfWidth, 12);
    expect(cab.roofRim.center[2] - cab.roofRim.size[2] / 2).toBeCloseTo(cab.opening.halfDepth, 12);
    expect(cab.opening.halfWidth - head.halfWidth).toBeCloseTo(0.035, 12);
    expect(cab.opening.halfDepth - head.halfDepth).toBeCloseTo(0.0385, 12);
    expect(head.centerY - head.travel * 2 - head.height / 2).toBeCloseTo(cab.floorTop + 0.025, 12);
    expect(head.stowedY + head.capBottom - (body.neckY + head.guideLength / 2)).toBeCloseTo(head.guideClearance, 12);
    expect(abdomen.top + abdomen.stroke).toBeCloseTo(cab.roofBottom - 0.01, 12);
  });

  it('changes longitudinal reach without changing the cab or axle pitch', () => {
    const original = createConvoyLayout(), longer = createConvoyLayout({ legGuideLength: 0.69 });
    expect(longer.leg.stroke - original.leg.stroke).toBeCloseTo(0.04, 12);
    expect(longer.vehicle.rearAxleZ - original.vehicle.rearAxleZ).toBeCloseTo(0.04, 12);
    expect(longer.cab).toEqual(original.cab);
    expect(longer.rear.pitch).toBe(original.rear.pitch);
  });
});


it('derives both rig views and animation paths from the same named hierarchy', () => {
  const layout = createConvoyLayout({ cabWidth: 1.02, legGuideLength: 0.69 });
  const joints = createPlayerRig(layout), specs = convoyJointSpecs(layout);
  for (const [index, joint] of joints.entries()) {
    expect(specs[index]!.name).toBe(nativeJointName(joint.name));
    expect(specs[index]!.position).toEqual(joint.world);
    expect(specs[index]!.parent).toBe(joint.parent < 0 ? null : specs[joint.parent]!.name);
  }
  expect(specs.find(joint => joint.name === 'shin-l')).toMatchObject({ kind: 'prismatic', axis: 'y', limits: [-layout.leg.stroke, 0] });
  expect(specs.find(joint => joint.name === 'headslide')).toMatchObject({ kind: 'prismatic', axis: 'y', limits: [-layout.head.travel, 0], mimic: { joint: 'headslidebase', ratio: 1 } });
  expect(specs.find(joint => joint.name === 'reartrackbase-l')).toMatchObject({ kind: 'prismatic', axis: 'x', limits: [-layout.rear.travel, 0] });
  expect(specs.find(joint => joint.name === 'reartrack-r')).toMatchObject({ kind: 'prismatic', axis: 'x', limits: [0, layout.rear.travel], mimic: { joint: 'reartrackbase-r', ratio: 1 } });
  expect(playerTargetPath(playerJointIndex('Foot.L'))).toEqual(['Player', 'Hips', 'Thigh.L', 'Shin.L', 'Foot.L']);
  expect(playerTargetPath(playerJointIndex('WheelRearB.R'))).toEqual(['Player', 'Hips', 'Thigh.R', 'Shin.R', 'RearBogie.R', 'RearTrackBase.R', 'RearTrack.R', 'WheelRearB.R']);
  expect(() => playerJointIndex('missing')).toThrow('Unknown player joint');
});
