import type { Tuple3 } from '@forgeax/engine/modeling';

export interface ConvoyDimensions {
  readonly wheelRadius: number;
  readonly cabWidth: number;
  readonly cabDepth: number;
  readonly cabInteriorHeight: number;
  readonly legGuideLength: number;
}

const defaults: ConvoyDimensions = {
  wheelRadius: 0.235, cabWidth: 0.94, cabDepth: 0.65, cabInteriorHeight: 0.36, legGuideLength: 0.65,
};

const box = (center: Tuple3, size: Tuple3) => ({ center, size });
export const mirrorPoint = (side: number, point: readonly number[]): Tuple3 => [side * point[0]!, point[1]!, point[2]!];

/** Solve hardpoints, running fits and panel spans before constructing either mesh. */
export function createConvoyLayout(authored: Partial<ConvoyDimensions> = {}) {
  const dimensions = { ...defaults, ...authored };
  // Bone lengths and manufacturing allowances are authored; world coordinates are not.
  const hipsY = -0.12, spineLength = 0.3, chestLength = 0.31;
  const spineY = hipsY + spineLength, chestY = spineY + chestLength;
  const shoulderY = chestY + 0.02, neckY = chestY + 0.11;
  const hipX = 0.17, thighY = hipsY - 0.13, thighLength = 0.34;
  const kneeY = thighY - thighLength;
  const wall = 0.03, guideOuter = 0.04, guideBore = 0.029, rodRadius = guideBore - 0.004;
  const guideX = hipX + 0.035, ankleX = hipX + 0.01, footX = ankleX + wall / 2;
  const guideY = thighY - thighLength / 2 - 0.055;
  const rodLength = dimensions.legGuideLength - 0.02, rodY = guideY - 0.02;
  const guideBottom = guideY - dimensions.legGuideLength / 2;
  // The fixed guide clears the foot shell by 15 mm; the ankle sits 65 mm
  // below that shell's top. Extending the guide therefore lengthens the shin.
  const ankleY = guideBottom - 0.015 - 0.065, shinLength = kneeY - ankleY;
  const minimumEngagement = guideOuter * 2;
  const legStroke = rodY + rodLength / 2 - guideBottom - minimumEngagement;
  const footHeight = 0.19, footY = ankleY - 0.03;
  const groundY = footY - footHeight / 2;
  const vehicleWheelY = groundY + dimensions.wheelRadius;
  const hipsFold = vehicleWheelY - thighY;

  const cabWall = 0.08, floorThickness = 0.06, roofThickness = 0.1;
  const shoulderX = dimensions.cabWidth / 2 - 0.13;
  const floorY = shoulderY - 0.04 - floorThickness / 2 - 0.01;
  const floorTop = floorY + floorThickness / 2;
  const roofBottom = floorTop + dimensions.cabInteriorHeight, roofY = roofBottom + roofThickness / 2;
  const backHeight = roofBottom - floorTop + 0.04;
  const backY = floorTop - 0.01 + backHeight / 2;
  const cabFront = -dimensions.cabDepth / 2, cabRear = dimensions.cabDepth / 2;
  const headHalfWidth = 0.22, helmetHeight = 0.33, helmetDepth = 0.28;
  const faceZ = -helmetDepth / 2 - 0.02, faceDepth = 0.055, cheekDepth = 0.045;
  const headHalfDepth = -faceZ + 0.01 + cheekDepth / 2;
  const roofOpeningX = headHalfWidth + 0.035, roofOpeningZ = headHalfDepth + 0.0385;
  const roofOuterX = dimensions.cabWidth / 2 - 0.025;
  const roofSideWidth = roofOuterX - roofOpeningX;
  const roofSideX = (roofOuterX + roofOpeningX) / 2;
  const roofRimDepth = dimensions.cabDepth / 2 - roofOpeningZ;
  const roofRimZ = (dimensions.cabDepth / 2 + roofOpeningZ) / 2;
  const floorFront = cabFront - 0.025, floorRear = 0.19;
  const frameWidth = dimensions.cabWidth - cabWall;
  const windowOuterX = frameWidth / 2 - 0.015, windowInnerX = 0.015;
  const windowX = (windowOuterX + windowInnerX) / 2;
  const windowWidth = windowOuterX - windowInnerX;
  const windowBottom = floorTop + 0.015, windowTop = roofBottom - 0.025;
  const headY = roofY + 0.17, stowedHeadY = floorTop + 0.025 + helmetHeight / 2;
  const headTravel = (headY - stowedHeadY) / 2;
  const helmetCapThickness = 0.035, helmetCapInset = 0.015;
  const helmetCapBottom = helmetHeight / 2 - helmetCapInset - helmetCapThickness / 2;
  const headGuideClearance = 0.0125, headRodMountOffset = 0.08;
  const headGuideLength = (stowedHeadY + helmetCapBottom - headGuideClearance - neckY) * 2;
  const headInnerLength = headGuideLength - 0.04;
  const headInnerY = neckY + (headGuideLength + headInnerLength) / 2 - 0.13;
  const headRodLength = (helmetCapBottom + 0.0075 + headRodMountOffset) * 2;
  const abdomenY = 0.145, abdomenHeight = 0.41;
  const abdomenTop = abdomenY + abdomenHeight / 2;
  const abdomenStroke = roofBottom - 0.01 - abdomenTop;

  const wheelHalfWidth = 0.07, spindleOutboard = 0.14, gimbalSpacing = 0.06;
  const vehicleTrackX = dimensions.cabWidth / 2 + 0.28 + wheelHalfWidth;
  // The tire's rear tangent clears the cab rear face by 10 mm.
  const frontAxleZ = cabRear - dimensions.wheelRadius - 0.01;
  // Counter-rotating gimbals leave the outer spindle horizontal after the arm folds.
  const frontWheelX = shoulderX + spindleOutboard + shoulderY - thighY;
  const frontWheelY = shoulderY - frontAxleZ;
  const frontWheelZ = vehicleTrackX - shoulderX - spindleOutboard;
  const legShellX = guideX + wall / 2, legHalfWidth = 0.2;
  const rearWheelX = legShellX + legHalfWidth + wheelHalfWidth + 0.03;
  const rearWheelY = kneeY - 0.06;
  const bogieX = rearWheelX - 0.12;
  const rearAxlePitch = dimensions.wheelRadius * 2 + 0.07;
  // Folding the thigh maps the extended bogie drop onto the vehicle's length.
  const rearAxleZ = thighY - rearWheelY + legStroke;
  const rearTrackTravel = (vehicleTrackX - rearWheelX) / 2;
  const shellCenterY = kneeY - 0.07, shellCenterZ = 0.035, shellDepth = 0.39;
  const carriageY = rodY - rodLength / 2 + 0.0025;
  const shellHeight = (shellCenterY - carriageY - 0.0225) * 2;
  const coverZ = shellCenterZ - shellDepth / 2 - wall;
  const wheels = [-1, 1].flatMap(side => {
    const suffix = side < 0 ? 'L' : 'R';
    return [
      { name: `WheelFront.${suffix}`, position: [side * frontWheelX, frontWheelY, frontWheelZ] as Tuple3, vehicle: [side * vehicleTrackX, vehicleWheelY, frontAxleZ] as Tuple3 },
      ...[0, rearAxlePitch].map((z, index) => ({ name: `WheelRear${index === 0 ? 'A' : 'B'}.${suffix}`, position: [side * rearWheelX, rearWheelY, z] as Tuple3, vehicle: [side * vehicleTrackX, vehicleWheelY, rearAxleZ + z] as Tuple3 })),
    ];
  });
  return {
    dimensions,
    body: { hipsY, spineY, chestY, shoulderY, shoulderX, neckY, hipX, thighY, thighLength, shinLength, kneeY, ankleY, ankleX },
    wheel: { radius: dimensions.wheelRadius, halfWidth: wheelHalfWidth, axlePitch: rearAxlePitch }, wheels,
    vehicle: { groundY, wheelY: vehicleWheelY, trackX: vehicleTrackX, frontAxleZ, rearAxleZ, hipsFold },
    collider: { radius: 0.38, halfHeight: -groundY - 0.38 },
    cab: {
      front: cabFront, rear: cabRear, floorY, floorTop, roofY, roofBottom, frameWidth,
      opening: { halfWidth: roofOpeningX, halfDepth: roofOpeningZ },
      back: box([0, backY, cabRear + 0.035 - 0.06], [frameWidth, backHeight, 0.12]),
      roofSide: box([roofSideX, roofY, 0], [roofSideWidth, roofThickness, dimensions.cabDepth]),
      roofRim: box([0, roofY, roofRimZ], [roofOpeningX * 2 - 0.01, roofThickness, roofRimDepth]),
      floorSide: box([roofSideX, floorY, (floorFront + floorRear) / 2], [roofSideWidth - wall, floorThickness, floorRear - floorFront]),
      floorFront: box([0, floorY, floorFront + floorThickness / 2], [roofOpeningX * 2 + wall, floorThickness, floorThickness]),
      side: box([dimensions.cabWidth / 2 - cabWall / 2, roofBottom - 0.135, 0], [cabWall, 0.25, dimensions.cabDepth - 0.07]),
      windowFrame: box([windowX, (roofBottom + floorY) / 2 - 0.005, cabFront + 0.04], [windowWidth, roofBottom - floorY, 0.035]),
      glazing: box([windowX, (windowBottom + windowTop) / 2, cabFront + 0.017], [windowWidth - 0.056, windowTop - windowBottom, 0.018]),
    },
    head: { centerY: headY, stowedY: stowedHeadY, halfWidth: headHalfWidth, halfDepth: headHalfDepth, height: helmetHeight, depth: helmetDepth, faceZ, faceDepth, cheekDepth, capThickness: helmetCapThickness, capInset: helmetCapInset, capBottom: helmetCapBottom, guideClearance: headGuideClearance, guideLength: headGuideLength, innerLength: headInnerLength, innerY: headInnerY, rodLength: headRodLength, rodY: headY - headRodMountOffset, travel: headTravel, guideX: 0.08 },
    abdomen: { centerY: abdomenY, height: abdomenHeight, top: abdomenTop, stroke: abdomenStroke },
    arm: { elbowX: shoulderX + 0.3, elbowY: shoulderY - 0.28, spindleOutboard, gimbalSpacing },
    leg: { wall, shellX: legShellX, halfWidth: legHalfWidth, shellCenterY, shellCenterZ, shellDepth, shellHeight, carriageY, coverZ, footX, footY, footHeight, guideX, guideY, guideOuter, guideBore, rodRadius, rodY, rodLength, guideBottom, minimumEngagement, stroke: legStroke, coverY: kneeY + 0.09 },
    rear: { bogieX, wheelX: rearWheelX, wheelY: rearWheelY, pitch: rearAxlePitch, travel: rearTrackTravel, bridgeLength: rearAxlePitch + 0.1, sleeveLength: rearTrackTravel + 0.03, intermediateLength: rearTrackTravel + 0.05, spindleLength: rearTrackTravel + 0.07 },
  };
}

export type ConvoyLayout = ReturnType<typeof createConvoyLayout>;
export const CONVOY_LAYOUT = createConvoyLayout();
