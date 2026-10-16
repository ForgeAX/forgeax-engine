import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { box3, mat4, quat, vec3, type QuatLike, type Vec3, type Vec3Like } from '@forgeax/engine/math';
import { definePack } from '@forgeax/engine/pack/source';
import type { AnimationClip, MeshAsset, SkeletonAsset, SkinAsset, VertexAttributeMap } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from './shared/asset-refs.ts';
import { PLAYER_JOINT_NAMES, PLAYER_RIG } from './player/player-rig.ts';

// A chamfered rectangular cross-section: height, half-width, half-depth, corner cut.
type Section = readonly [number, number, number, number];

function playerMesh(): MeshAsset {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const tangents: number[] = [], skinIndices: number[] = [], skinWeights: number[] = [];
  const groups: number[][] = [[], [], [], []];
  const ab = vec3.create(), ac = vec3.create(), normal = vec3.create(), tangent = vec3.create();
  const transform = mat4.create(), identity = quat.create();

  // Each face has its own vertices and normal. Plates remain rigid under the
  // existing walk clip; deliberate joint gaps expose the graphite mechanisms.
  const face = (points: readonly Vec3[], joint: number, material: number) => {
    const a = points[0]!, b = points[1]!, c = points[2]!;
    vec3.sub(ab, b, a);
    vec3.sub(ac, c, a);
    vec3.normalize(normal, vec3.cross(normal, ab, ac));
    vec3.normalize(tangent, ab);
    const base = positions.length / 3;
    for (let index = 0; index < points.length; index += 1) {
      positions.push(...points[index]!);
      normals.push(...normal);
      uvs.push(index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0);
      tangents.push(...tangent, 1);
      skinIndices.push(joint, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
    for (let index = 1; index < points.length - 1; index += 1) groups[material]!.push(base, base + index, base + index + 1);
  };

  // CCW sections viewed from above, oriented in the owning bone's rest frame.
  const plate = (joint: number, material: number, center: Vec3Like, sections: readonly Section[], orientation: QuatLike = identity) => {
    mat4.compose(transform, center, orientation, [1, 1, 1]);
    const rings = sections.map(([y, w, d, bevel]) => {
      const ring: Vec3Like[] = [
        [-w + bevel, y, -d], [w - bevel, y, -d], [w, y, -d + bevel], [w, y, d - bevel],
        [w - bevel, y, d], [-w + bevel, y, d], [-w, y, d - bevel], [-w, y, -d + bevel],
      ];
      return ring.map((point) => mat4.transformPoint(vec3.create(), transform, point));
    });
    face(rings[0]!, joint, material);
    face([...rings[rings.length - 1]!].reverse(), joint, material);
    for (let level = 0; level < rings.length - 1; level += 1) {
      const lower = rings[level]!, upper = rings[level + 1]!;
      for (let side = 0; side < 8; side += 1) {
        const next = (side + 1) % 8;
        face([lower[side]!, upper[side]!, upper[next]!, lower[next]!], joint, material);
      }
    }
  };
  const block = (joint: number, material: number, center: Vec3Like, size: Vec3Like, bevel: number, orientation: QuatLike = identity) => {
    const w = size[0]! / 2, h = size[1]! / 2, d = size[2]! / 2;
    const cut = Math.min(bevel, w * 0.45, d * 0.45, h * 0.45);
    plate(joint, material, center, [
      [-h, w - cut, d - cut, cut * 0.5], [-h + cut, w, d, cut],
      [h - cut, w, d, cut], [h, w - cut, d - cut, cut * 0.5],
    ], orientation);
  };

  // Torso proportions follow the rig; attached details share their parent's dimensions.
  const hipY = PLAYER_RIG[0].world[1], waistY = PLAYER_RIG[1].world[1];
  const chestY = PLAYER_RIG[2].world[1], headY = PLAYER_RIG[3].world[1];
  const shoulderSpan = PLAYER_RIG[6].world[0] - PLAYER_RIG[4].world[0];
  const halfWidth = shoulderSpan * 0.55;
  const halfDepth = halfWidth * 0.6, waistWidth = halfWidth * 0.72;
  const collarY = chestY + (headY - chestY) * 0.4;
  const chestHeight = collarY - waistY;
  const panelThickness = halfDepth * 0.16, seam = panelThickness / 2;
  const bevel = halfWidth * 0.2;

  const beltHeight = (waistY - hipY) * 0.75, beltDepth = halfDepth * 1.5;
  block(0, 2, [0, hipY - seam, 0], [waistWidth * 2, beltHeight, beltDepth], seam);
  const abdomenBottom = hipY + beltHeight / 2 - seam * 2;
  plate(1, 1, [0, 0, 0], [
    [abdomenBottom, waistWidth * 0.8, halfDepth * 0.7, bevel / 2],
    [waistY - panelThickness * 2, waistWidth * 0.95, halfDepth * 0.8, bevel / 2],
    [waistY + panelThickness, waistWidth, halfDepth * 0.75, bevel / 2],
  ]);
  const ribCount = 2, ribSpacing = (waistY - abdomenBottom) / (ribCount + 1);
  for (let rib = 1; rib <= ribCount; rib += 1) {
    block(1, 2, [0, abdomenBottom + rib * ribSpacing, -halfDepth * 0.8],
      [waistWidth * 1.4, panelThickness, panelThickness * 1.5], seam / 2);
  }
  block(0, 3, [0, hipY, -(beltDepth + panelThickness) / 2],
    [waistWidth / 2, beltHeight / 3, panelThickness], seam / 2);

  const chestSections: Section[] = [
    [waistY + seam, waistWidth, halfDepth * 0.8, bevel],
    [chestY - chestHeight * 0.2, halfWidth, halfDepth, bevel],
    [collarY - panelThickness * 2, halfWidth * 0.9, halfDepth * 0.85, bevel],
    [collarY, waistWidth * 0.9, halfDepth * 0.6, bevel / 2],
  ];
  plate(2, 0, [0, 0, 0], chestSections);
  // Inset the breastplate within the shell's lower three sections.
  const breastplate = chestSections.slice(0, -1).map(([y, w]): Section => [
    chestY + (y - chestY) * 0.75, w * 0.75, panelThickness * 1.5, panelThickness,
  ]);
  const breastplateFront = -(halfDepth * 0.85 + panelThickness * 1.5);
  plate(2, 1, [0, 0, -halfDepth * 0.85], breastplate);
  block(2, 3, [0, chestY - panelThickness * 2, breastplateFront - seam / 2],
    [panelThickness * 2, panelThickness * 3, seam], seam / 3);

  // Rails sit on the backpack's rear face; signals share their height and spacing.
  const packWidth = halfWidth * 1.1, packHeight = chestHeight * 0.9;
  const packDepth = halfDepth * 0.85, packY = waistY + packHeight / 2;
  const packZ = halfDepth * 0.7 + packDepth / 2;
  const packRear = packZ + packDepth / 2;
  const railWidth = panelThickness * 1.5, railHeight = packHeight * 0.75;
  const railOffset = packWidth / 2 - railWidth;
  block(2, 1, [0, packY, packZ], [packWidth, packHeight, packDepth], panelThickness);
  for (const side of [-1, 1]) {
    block(2, 0, [side * railOffset, packY, packRear],
      [railWidth, railHeight, panelThickness], seam / 2);
    block(2, 3, [side * (railOffset - railWidth), packY + railHeight / 2 - panelThickness, packRear + seam / 2],
      [panelThickness, panelThickness * 2, seam], seam / 4);
  }
  const neckTop = headY - panelThickness * 2, neckWidth = waistWidth * 0.75;
  block(2, 2, [0, (collarY + neckTop) / 2, 0],
    [neckWidth, neckTop - collarY, neckWidth], seam);

  // Helmet proportions; the rim, visor and chin attach to the same shell landmarks.
  const headHeight = (headY - chestY) * 1.25;
  const headWidth = shoulderSpan * 0.36, headDepth = headWidth * 0.84;
  const headBottom = headY - headHeight / 5, headTop = headBottom + headHeight;
  const jawY = headBottom + headHeight / 4, browY = headTop - headHeight / 4;
  const headBevel = headDepth * 0.3;
  plate(3, 0, [0, 0, 0], [
    [headBottom, headWidth * 0.7, headDepth * 0.8, headBevel],
    [jawY, headWidth, headDepth, headBevel],
    [browY, headWidth, headDepth, headBevel],
    [headTop, headWidth * 0.65, headDepth * 0.65, headBevel],
  ]);
  const visorBottom = jawY + seam, visorTop = browY - seam;
  const visorDepth = headDepth * 0.85, visorZ = -(headDepth - visorDepth + seam);
  const visorFront = visorZ - visorDepth;
  plate(3, 2, [0, 0, visorZ], [
    [visorBottom, headWidth - seam, visorDepth, headBevel],
    [visorTop, headWidth + seam / 2, visorDepth, headBevel],
  ]);
  plate(3, 3, [0, 0, visorFront - seam / 2], [
    [visorBottom + panelThickness, headWidth - panelThickness * 2, seam / 2, seam / 3],
    [visorTop - seam, headWidth - panelThickness, seam / 2, seam / 3],
  ]);
  block(3, 1, [0, browY, -headDepth],
    [headWidth * 2 - panelThickness, panelThickness * 1.5, panelThickness * 2], seam / 2);
  plate(3, 0, [0, 0, -headDepth * 0.75], [
    [headBottom + panelThickness, headWidth * 0.4, panelThickness, seam / 2],
    [jawY, headWidth * 0.6, panelThickness * 2, seam],
    [visorBottom, headWidth * 0.6, panelThickness * 1.5, seam],
  ]);
  block(3, 1, [0, headTop - panelThickness / 2, 0],
    [panelThickness * 2, panelThickness * 2, headDepth * 1.25], seam / 2);

  // A bone frame maps local -Y onto its endpoints. Positions use fractions of
  // bone length; X/Z offsets and all armor rotations use that same frame.
  const bone = (start: Vec3Like, end: Vec3Like) => {
    const direction = vec3.sub(vec3.create(), end, start);
    const length = vec3.length(direction);
    const orientation = quat.fromUnitVectors(quat.create(), [0, -1, 0], vec3.normalize(direction, direction));
    const frame = mat4.compose(mat4.create(), start, orientation, [1, 1, 1]);
    return {
      length, direction, orientation,
      at: (along: number, x = 0, z = 0) => mat4.transformPoint(vec3.create(), frame, [x, -along * length, z]),
    };
  };
  for (const side of [-1, 1]) {
    const upper = side < 0 ? 4 : 6, forearm = upper + 1;
    const thigh = side < 0 ? 8 : 11, shin = thigh + 1, foot = thigh + 2;
    const arm = bone(PLAYER_RIG[upper].world, PLAYER_RIG[forearm].world);
    // The 14-joint rig ends at the elbow. Extend a shorter, relaxed forearm
    // toward vertical; the hand belongs to that same rigid skin joint.
    const forearmLength = arm.length * 0.85;
    const forearmDirection = vec3.lerp(vec3.create(), arm.direction, [0, -1, 0], 0.4);
    vec3.normalize(forearmDirection, forearmDirection);
    const wrist = vec3.scale(vec3.create(), forearmDirection, forearmLength);
    vec3.add(wrist, PLAYER_RIG[forearm].world, wrist);
    const lowerArm = bone(PLAYER_RIG[forearm].world, wrist);
    const armWidth = arm.length * 0.28, shoulderWidth = armWidth * 1.8;
    const shoulderHeight = arm.length * 0.6;
    const armBevel = armWidth * 0.3;
    block(upper, 2, arm.at(0.1), [armWidth * 2, armWidth * 2, armWidth * 2], armBevel, arm.orientation);
    plate(upper, 0, arm.at(0.12, side * armWidth / 2), [
      [-shoulderHeight / 2, shoulderWidth * 0.8, shoulderWidth * 0.9, armBevel],
      [shoulderHeight / 4, shoulderWidth, shoulderWidth, armBevel],
      [shoulderHeight / 2, shoulderWidth * 0.7, shoulderWidth * 0.7, armBevel],
    ], arm.orientation);
    block(upper, 1, arm.at(0.6), [armWidth * 2, arm.length * 0.6, armWidth * 2], armBevel, arm.orientation);
    block(upper, 3, arm.at(0.05, side * armWidth / 2, -shoulderWidth),
      [shoulderWidth * 0.75, panelThickness, seam], seam / 3, arm.orientation);
    block(forearm, 2, lowerArm.at(0), [armWidth * 1.6, armWidth * 1.5, armWidth * 1.6], armBevel, lowerArm.orientation);
    const cuffLength = lowerArm.length * 0.8, cuffWidth = armWidth * 1.25;
    plate(forearm, 0, lowerArm.at(0.55), [
      [-cuffLength / 2, armWidth * 0.9, armWidth, armBevel],
      [cuffLength / 4, cuffWidth, cuffWidth, armBevel],
      [cuffLength / 2, armWidth, armWidth, armBevel],
    ], lowerArm.orientation);
    block(forearm, 1, lowerArm.at(0.55, 0, -cuffWidth),
      [cuffWidth, cuffLength / 2, panelThickness], seam / 2, lowerArm.orientation);
    const handSize = armWidth * 1.7;
    const handAlong = 1 + handSize / (2 * lowerArm.length);
    block(forearm, 2, lowerArm.at(handAlong), [handSize, handSize, handSize], armBevel, lowerArm.orientation);
    block(forearm, 0, lowerArm.at(handAlong, 0, -handSize / 2),
      [handSize * 0.8, handSize / 2, panelThickness], seam / 2, lowerArm.orientation);

    // Thigh and shin plates stop short of the joint hinges; boots extend from the ankle.
    const upperLeg = bone(PLAYER_RIG[thigh].world, PLAYER_RIG[shin].world);
    const lowerLeg = bone(PLAYER_RIG[shin].world, PLAYER_RIG[foot].world);
    const legWidth = upperLeg.length * 0.35, legBevel = legWidth / 4;
    block(thigh, 1, upperLeg.at(0, side * legWidth / 2),
      [legWidth * 1.6, upperLeg.length * 0.7, halfDepth * 1.6], legBevel, upperLeg.orientation);
    block(thigh, 2, upperLeg.at(0.5), [legWidth * 1.8, upperLeg.length * 0.85, legWidth * 2], legBevel, upperLeg.orientation);
    const thighLength = upperLeg.length * 0.75;
    plate(thigh, 0, upperLeg.at(0.5, 0, -legBevel), [
      [-thighLength / 2, legWidth * 0.85, legWidth, legBevel],
      [thighLength / 3, legWidth * 1.1, legWidth * 1.25, legBevel],
      [thighLength / 2, legWidth * 0.9, legWidth, legBevel],
    ], upperLeg.orientation);
    const kneeHeight = legWidth * 1.2;
    block(shin, 2, lowerLeg.at(0), [legWidth * 1.8, kneeHeight, legWidth * 2], legBevel, lowerLeg.orientation);
    block(shin, 1, lowerLeg.at(0, 0, -legWidth), [legWidth * 1.8, kneeHeight, legWidth], legBevel, lowerLeg.orientation);
    const shinLength = lowerLeg.length * 0.8;
    plate(shin, 0, lowerLeg.at(0.6, 0, -legBevel), [
      [-shinLength / 2, legWidth * 0.75, legWidth * 0.85, legBevel],
      [shinLength / 4, legWidth, legWidth * 1.2, legBevel],
      [shinLength / 2, legWidth, legWidth * 1.1, legBevel],
    ], lowerLeg.orientation);
    block(shin, 1, lowerLeg.at(0.6, 0, -legWidth * 1.3),
      [legWidth / 2, shinLength * 0.6, panelThickness], seam / 2, lowerLeg.orientation);
    const ankle = PLAYER_RIG[foot].world;
    const bootWidth = legWidth * 2.4, bootDepth = lowerLeg.length * 1.45, soleHeight = legWidth * 1.3;
    const bootZ = ankle[2] - bootDepth / 6, soleY = ankle[1] - soleHeight * 0.65;
    block(foot, 2, [ankle[0], soleY, bootZ], [bootWidth, soleHeight, bootDepth], legBevel);
    const toeDepth = bootDepth * 0.7, toeZ = bootZ - (bootDepth - toeDepth) / 2;
    const toeHeight = soleHeight * 0.7, toeY = soleY + soleHeight / 3;
    block(foot, 1, [ankle[0], toeY, toeZ], [bootWidth, toeHeight, toeDepth], legBevel);
    block(foot, 0, [ankle[0], toeY, toeZ - toeDepth / 2],
      [bootWidth * 0.85, toeHeight * 0.7, panelThickness * 2], seam);
  }

  const vertexCount = positions.length / 3;
  const attributes: VertexAttributeMap = { position: new Float32Array(positions), normal: new Float32Array(normals), uv: new Float32Array(uvs), tangent: new Float32Array(tangents), skinIndex: new Uint16Array(skinIndices), skinWeight: new Float32Array(skinWeights) };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount); if (!packed.ok) throw packed.error;
  const indices: number[] = [];
  const submeshes = groups.map((group, materialSlot) => {
    const indexOffset = indices.length;
    indices.push(...group);
    return { indexOffset, indexCount: group.length, vertexCount, topology: 'triangle-list' as const, materialSlot };
  });
  return { kind: 'mesh', vertices: packed.value.vertices, indices: new Uint32Array(indices), attributes, aabb: box3.fromPositions(box3.create(), positions), submeshes, materialSlots: [
    { slotName: 'Ceramic Armor', sourceKey: 'game-3d:player-body', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-body') },
    { slotName: 'Petrol Panels', sourceKey: 'game-3d:player-cloth', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-cloth') },
    { slotName: 'Graphite Joints', sourceKey: 'game-3d:player-accent', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-accent') },
    { slotName: 'Amber Signals', sourceKey: 'game-3d:player-signal', defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/player-signal') },
  ] };
}

function playerSkeleton(): SkeletonAsset {
  const matrices = new Float32Array(PLAYER_RIG.length * 16);
  const inverseBind = mat4.create(), inversePosition = vec3.create();
  for (const [joint, entry] of PLAYER_RIG.entries()) {
    vec3.negate(inversePosition, entry.world);
    mat4.fromTranslation(inverseBind, inversePosition);
    matrices.set(inverseBind, joint * 16);
  }
  return { kind: 'skeleton', inverseBindMatrices: matrices, jointCount: PLAYER_RIG.length };
}
function targetPath(joint: number): readonly string[] { const names: string[] = []; let cursor = joint; while (cursor >= 0) { const entry = PLAYER_RIG[cursor]; if (entry === undefined) break; names.unshift(entry.name); cursor = entry.parent; } return ['Player', ...names]; }
function walkClip(): AnimationClip {
  const duration = 1;
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
  build: () =>
    ok({
      'mesh/player': playerMesh(),
      'rig/player-skeleton': playerSkeleton(),
      'rig/player-skin': {
        kind: 'skin',
        skeletonGuid: guidText(assetGuid(PACKAGE_IDS.character, 'rig/player-skeleton')),
        jointPaths: [...PLAYER_JOINT_NAMES],
      } satisfies SkinAsset,
      'animation/player-walk': walkClip(),
    }),
});
