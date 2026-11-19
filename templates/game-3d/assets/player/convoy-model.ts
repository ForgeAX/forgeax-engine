import { CONVOY_SURFACES, CONVOY_HARDWARE_SLOTS } from './convoy-surfaces.ts';
import { addConvoyPart, type ConvoyBinding } from './convoy-parts.ts';
import { convoyFrame } from './convoy-frame.ts';
import { CONVOY_LAYOUT, mirrorPoint, type ConvoyLayout } from '../shared/convoy-layout.ts';
import { model, rig, sel, type Tuple3, type Pose, type PosePath, textStrokes } from '@forgeax/engine/modeling';
import { deriveAnimationTargetId } from '@forgeax/engine/animation';
import { Materials } from '@forgeax/engine/render';
import type { AnimationClip, MaterialAsset, MeshAsset, SkeletonAsset, SkinAsset } from '@forgeax/engine/types';
import type { PackageId } from '@forgeax/engine/pack/guid';
import { assetGuid, guidText } from '../shared/asset-refs.ts';
import { convoyHardwareTextures } from './convoy-finish.ts';
import { PLAYER_RIG, PLAYER_JOINT_NAMES, PLAYER_TRANSFORM_SECONDS, CONVOY_WHEELS, convoyJointSpecs, nativeJointName as nativeName, playerTargetPath } from '../shared/player-rig.ts';

export const CONVOY_NORMALS = { mode: 'weighted' } as const;
export const CONVOY_DEFAULT_RESOLUTION = 1024;
const CAB_BACK_BEVEL = 0.025;
const CAB_BEARING_RADIUS = 0.08;
export const CONVOY_MAPS = ['normal', 'ormh', 'baseColor', 'emissive', 'position', 'edgeWear', 'cavity', 'materialId'] as const;


export const CONVOY_TRIANGLE_BUDGET = 24000;
const wheelGroups = ['tire', 'barrel', 'hub', ...[-1, 1].flatMap(side => Array.from({ length: 6 }, (_, n) => `spoke-${side}-${n}`))];
export const convoyBakeSettings = (resolution: number) => ({
  protectMip: Math.max(0, Math.floor(Math.log2(resolution)) - 8),
  // Bound projection by the cab back bevel and bearing envelope; avoid re-solving
  // every known part's cage on each cold cook. Wheels keep their tighter group cages.
  cage: { offset: CAB_BACK_BEVEL, maxRay: CAB_BACK_BEVEL + CAB_BEARING_RADIUS },
  maps: CONVOY_MAPS,
  normals: CONVOY_NORMALS, detailNormals: CONVOY_NORMALS,
  tags: { groupPrefix: 'bake:', floater: 'bake-floater' }, slots: CONVOY_SURFACES,
  ao: { rays: 8, distance: 0.065, denoise: 2 },
  groups: Object.fromEntries(CONVOY_WHEELS.flatMap(wheel => wheelGroups.map(group => [
    `${wheel.name}/${group}`, { cage: group === 'tire' || group === 'hub' ? { offset: 0.015, maxRay: 0.035 } : { offset: 0.008, maxRay: 0.016 } },
  ]))),
});


type PlateRole = 'armor' | 'shoulder-seat' | 'thigh-sleeve' | 'shin-side' | 'shin-back' | 'foot-shell';

function createPlateShell(material: keyof typeof CONVOY_SURFACES, size: Tuple3, bevel: number, high: boolean, role: PlateRole, center: Tuple3, side: number, layout: ConvoyLayout) {
  const shell = model();
  shell.box({ size, material });
  if (bevel > 0) shell.bevel(sel.edges.all(), { width: Math.min(bevel, ...size.map(n => n * 0.2)), segments: high ? 3 : 1, material });
  if (role === 'shin-side') {
    const bore = model();
    bore.cylinder({ radiusTop: 0.043, radiusBottom: 0.043, height: size[0] + 0.07, radialSegments: high ? 32 : 16, material });
    bore.rotate(sel.all(), 'z', 90); bore.translate(sel.all(), [0, layout.rear.wheelY - center[1], -center[2]]);
    shell.difference(bore);
  }
  if (role === 'thigh-sleeve' || role === 'foot-shell') {
    const bore = model();
    const isFoot = role === 'foot-shell';
    bore.cylinder({ radiusTop: isFoot ? 0.03 : 0.029, radiusBottom: isFoot ? 0.03 : 0.029, height: 0.5, radialSegments: high ? 40 : 16, material });
    bore.rotate(sel.all(), 'z', 90); bore.translate(sel.all(), [0, (isFoot ? layout.body.ankleY : layout.body.thighY) - center[1], (isFoot ? -0.06 : 0) - center[2]]);
    shell.difference(bore);
    if (!isFoot) {
      const guide = model(); guide.cylinder({ radiusTop: layout.leg.guideBore + 0.001, radiusBottom: layout.leg.guideBore + 0.001, height: 0.5, radialSegments: high ? 40 : 16, center: [0, 0, 0.1 - center[2]], material }); shell.difference(guide);
    }
  }
  if (role === 'shoulder-seat') { const slot = model(); slot.box({ size: [0.14, 0.1, 0.08], center: [side * (layout.body.shoulderX + 0.045) - center[0], 0, -center[2]], material }); shell.difference(slot); }
  return shell;
}

function addPanelGreeble(part: ReturnType<typeof model>, bolt: ReturnType<typeof model>, size: Tuple3, serial: number) {
  // Detail floaters stay in this part's ray group, never in the runtime skin.
  const front = -size[2] / 2 - 0.002;
  part.panelLine({ faces: sel.facing('-z'), point: [0, 0, 0], normal: [0, 1, 0] }, { width: 0.006, depth: 0.004, material: 'dark' });
  for (const sign of [-1, 1]) {
    part.box({ size: [size[0] * 0.8, 0.007, 0.003], center: [0, sign * size[1] * 0.39, front], material: 'dark' });
    part.box({ size: [0.006, size[1] * 0.65, 0.003], center: [sign * size[0] * 0.4, 0, front], material: 'dark' });
  }
  part.box({ size: [size[0] * 0.6, size[1] * 0.44, 0.003], center: [0, 0, front], material: 'dark' });
  const slats = model();
  // Keep visible gaps on small panels and give each baked bar a useful texel footprint.
  const count = Math.max(3, Math.min(7, Math.floor(size[1] / 0.04)));
  const pitch = size[1] * 0.36 / (count - 1);
  slats.box({ size: [size[0] * 0.54, pitch * 0.38, 0.006], center: [0, -size[1] * 0.18, front - 0.003], material: 'steel', tag: 'louvre' });
  slats.array(sel.tag('louvre'), { linear: { count, offset: [0, pitch, 0] } });
  part.append(slats);
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    part.append(bolt, { translate: [x * size[0] * 0.32, y * size[1] * 0.32, front] });
  }
  // Tiny engineering marks are part of the high source, so they use the same atlas.
  if (size[0] > 0.2 && size[1] > 0.16) {
    const strokes = textStrokes(`${String(serial).padStart(2, '0')}`, { height: Math.min(0.035, size[1] * 0.11), align: 'center' });
    if (!strokes.ok) throw strokes.error;
    for (const path of strokes.value) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      part.sweep({ profile: [[-0.0015, -0.0008], [0.0015, -0.0008], [0.0015, 0.0008], [-0.0015, 0.0008]], path: [[a[0], a[1] + size[1] * 0.24, front - 0.002], [b[0], b[1] + size[1] * 0.24, front - 0.002]], material: 'ink' });
    }
  }
}

function createConvoyWheel(high: boolean, layout: ConvoyLayout) {
  const tire = model();
  const radius = layout.wheel.radius;
  const rimOuter = radius - 0.087, rimInner = rimOuter - 0.022;
  tire.revolve({ points: [[radius - 0.09, -0.055], [radius - 0.025, -0.07], [radius, -0.045], [radius, 0.045], [radius - 0.025, 0.07], [radius - 0.09, 0.055], [radius - 0.09, -0.055]], segments: high ? 96 : 20, material: 'rubber', tag: 'wheel:tire' });
  tire.revolve({ points: [[rimInner, -0.065], [rimOuter, -0.065], [rimOuter, 0.065], [rimInner, 0.065], [rimInner, -0.065]], segments: high ? 64 : 16, material: 'steel', tag: 'wheel:barrel' });
  tire.revolve({ points: [[0.055, -0.075], [0.078, -0.075], [0.078, 0.075], [0.055, 0.075], [0.055, -0.075]], segments: high ? 48 : 12, material: 'steel', tag: 'wheel:hub' });
  for (const side of [-1, 1]) for (let spoke = 0; spoke < 6; spoke++) {
    const arm = model();
    arm.box({ size: [rimInner - 0.078 + 0.022, 0.024, 0.026], center: [(rimInner + 0.078) / 2 + 0.001, side * 0.047, 0], material: 'steel' });
    if (high) arm.bevel(sel.edges.all(), { width: 0.003, segments: 2, material: 'steel' });
    arm.rotate(sel.all(), 'y', spoke * 60);
    tire.append(arm, { tag: `wheel:spoke-${side}-${spoke}` });
  }
  if (high) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const angle = k * Math.PI / 3;
        tire.cylinder({ radiusTop: 0.006, radiusBottom: 0.006, height: 0.01, radialSegments: 6, center: [Math.cos(angle) * 0.066, side * 0.0785, Math.sin(angle) * 0.066], material: 'steel', tag: 'wheel:hub' });
      }
      const ring = model();
      ring.torus({ radius: radius - 0.06, tube: 0.003, radialSegments: 8, tubularSegments: 72, material: 'rubber' });
      ring.rotate(sel.all(), 'x', 90);
      tire.append(ring, { translate: [0, side * 0.064, 0], tag: 'wheel:tire' });
      const lug = model();
      lug.box({ size: [0.013, 0.035, 0.018], center: [radius - 0.003, side * 0.024, 0], tag: 'tread', material: 'rubber' });
      lug.rotate(sel.all(), 'x', side * 30, [radius - 0.003, side * 0.024, 0]);
      lug.array(sel.tag('tread'), { radial: { count: 60, axis: 'y' } });
      tire.append(lug, { tag: 'wheel:tire' });
    }
  }
  tire.rotate(sel.all(), 'z', 90);
  return tire;
}

function appendConvoyWheels(base: ReturnType<typeof model>, detail: ReturnType<typeof model>, binding: ConvoyBinding[], layout: ConvoyLayout) {
  const wheelPrototypes = new Map<string, ReturnType<typeof model>>();
  for (const wheel of layout.wheels) {
    const tag = `wheel:${wheel.name}`;
    binding.push({ tag, joint: wheel.name });
    for (const target of [base, detail]) {
      const high = target === detail;
      const variant = `${high}`;
      let tire = wheelPrototypes.get(variant);
      if (tire === undefined) {
        tire = createConvoyWheel(high, layout);
        wheelPrototypes.set(variant, tire);
      }
      const part = model(); part.append(tire);
      for (const group of wheelGroups) part.tag(sel.tag(`wheel:${group}`), `bake:${wheel.name}/${group}`);
      target.append(part, { translate: wheel.position, tag });
    }
  }

}

/** Every visible low part has a matching high part and an independent bake group. */
export function buildConvoy(resolution = CONVOY_DEFAULT_RESOLUTION, layout: ConvoyLayout = CONVOY_LAYOUT) {
  const base = model(), detail = model();
  const { body, cab, arm, leg, head, abdomen } = layout;
  const binding: ConvoyBinding[] = [];
  let serial = 0;
  const bolt = model();
  bolt.cylinder({ radiusTop: 0.008, radiusBottom: 0.01, height: 0.005, radialSegments: 6, material: 'steel' });
  bolt.bevel(sel.edges.all(), { width: 0.001, segments: 2, material: 'steel' });
  bolt.rotate(sel.all(), 'x', 90);
  const plateShells = new Map<string, ReturnType<typeof model>>();
  const plate = (joint: string, material: keyof typeof CONVOY_SURFACES, center: Tuple3, size: Tuple3, bevel = 0.016, greeble = false, tilt = 0, role: PlateRole = 'armor') => {
    const tag = `bake:${nativeName(joint)}-${material}-${serial++}`;
    addConvoyPart([base, detail], binding, joint, tag, (part, high) => {
      const key = JSON.stringify([material, size, bevel, high, role, role === 'armor' ? 0 : center]);
      let shell = plateShells.get(key);
      if (shell === undefined) {
        shell = createPlateShell(material, size, bevel, high, role, center, Math.sign(center[0]), layout);
        plateShells.set(key, shell);
      }
      part.append(shell, { tag });
      if (high && material === 'glass') {
        const wiper = model();
        wiper.box({ size: [size[0] * 0.68, 0.005, 0.003], center: [0, -size[1] * 0.28, -size[2] / 2 - 0.002], material: 'dark' });
        wiper.rotate(sel.all(), 'z', -14, [0, -size[1] * 0.28, 0]);
        part.append(wiper);
        part.box({ size: [size[0] * 0.94, 0.012, 0.002], center: [0, size[1] * 0.43, -size[2] / 2 - 0.001], material: 'dark' });
      }
      if (high && greeble) {
        addPanelGreeble(part, bolt, size, serial);
      }
      if ((joint.includes('Arm.') || joint.includes('Shin.')) && material !== 'dark') part.taper(sel.all(), { axis: 'y', factor: 1.12, axes: ['x'], range: [-size[1] / 2, size[1] / 2], origin: [0, 0, 0] });
      if (role === 'shin-side' || role === 'shin-back') part.markSharp(sel.edges.all());
      if (tilt !== 0) part.rotate(sel.all(), 'z', tilt);
    }, { translate: center });
  };
  const cylinder = (joint: string, material: keyof typeof CONVOY_SURFACES, center: Tuple3, radius: number, length: number, axis: 'x' | 'y' | 'z' = 'y', bore = 0, structural = false, name?: string) => {
    const tag = `bake:${name ?? `mechanism-${serial++}`}`;
    addConvoyPart([base, detail], binding, joint, tag, (part, high) => {
      if (bore > 0) part.revolve({ points: [[bore, -length / 2], [radius, -length / 2], [radius, length / 2], [bore, length / 2], [bore, -length / 2]], segments: high ? 32 : 12, material });
      else part.cylinder({ radiusTop: radius, radiusBottom: radius, height: length, radialSegments: high ? 32 : 8, material });
      if (high && bore === 0 && (material === 'steel' || material === 'dark' || material === 'gold')) {
        // Circumferential bearing races and cooling fins collapse into the normal map.
        for (const t of [-0.38, -0.2, 0.2, 0.38]) part.cylinder({ radiusTop: radius * 1.08, radiusBottom: radius * 1.08, height: 0.006, center: [0, t * length, 0], radialSegments: 32, material: 'dark', tag: 'bake-floater' });
      }
      if (axis !== 'y') part.rotate(sel.all(), axis === 'x' ? 'z' : 'x', 90);
    }, { translate: center, structural });
  };
  // The hollow, framed cab receives the retracting head; the chest is its windshield.
  plate('Hips', 'dark', [0, body.hipsY - 0.01, 0.015], [0.11, 0.2, 0.17]);
  plate('Spine', 'steel', [0, body.spineY + 0.07, 0.02], [0.1, 0.04, 0.1], 0.018, true);
  plate('Chest', 'red', cab.back.center, cab.back.size, CAB_BACK_BEVEL, true);
  // An actual roof aperture leaves the complete head sweep clear.
  for (const side of [-1, 1]) {
    plate('Chest', 'red', mirrorPoint(side, cab.roofSide.center), cab.roofSide.size, 0.02);
    plate('Chest', 'red', [0, cab.roofY, side * cab.roofRim.center[2]], cab.roofRim.size, 0.015);
  }
  for (const side of [-1, 1]) plate('Chest', 'red', mirrorPoint(side, cab.floorSide.center), cab.floorSide.size, 0.016, false, 0, 'shoulder-seat');
  plate('Chest', 'red', cab.floorFront.center, cab.floorFront.size);
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    plate('Chest', 'red', mirrorPoint(side, cab.side.center), cab.side.size);
    plate('Chest', 'steel', mirrorPoint(side, cab.windowFrame.center), cab.windowFrame.size, 0.014);
    plate('Chest', 'glass', mirrorPoint(side, cab.glazing.center), cab.glazing.size, 0.006);
    plate('Chest', 'steel', [side * cab.glazing.center[0], cab.floorY + 0.05, cab.front + 0.002], [0.27, 0.012, 0.015], 0.002);
    plate('Hips', 'cyan', [side * 0.26, body.hipsY - 0.025, cab.front - 0.025], [0.10, 0.035, 0.02], 0.005);
    plate('Chest', 'amber', [side * (cab.frameWidth / 2 - 0.16), cab.roofY + 0.06, cab.front + 0.095], [0.06, 0.035, 0.06], 0.004);
    plate(`UpperArm.${suffix}`, 'red', [side * (arm.elbowX + 0.02), body.shoulderY + 0.06, 0.02], [arm.elbowX - body.shoulderX + 0.02, 0.4, 0.48], 0.035, true);
    plate(`UpperArm.${suffix}`, 'dark', [side * (arm.elbowX + 0.02), arm.elbowY + 0.13, 0.01], [0.18, 0.10, 0.23]);
    plate(`Forearm.${suffix}`, 'red', [side * (arm.elbowX + 0.09), arm.elbowY - 0.195, 0.015], [0.28, 0.27, 0.33], 0.024, true);
    plate(`Forearm.${suffix}`, 'dark', [side * (arm.elbowX + 0.1), arm.elbowY - 0.35, -0.015], [0.22, 0.17, 0.23], 0.015);
    plate(`Thigh.${suffix}`, 'steel', [side * leg.guideX, body.thighY - 0.13, 0.035], [0.27, 0.24, 0.33], 0.023, true, 0, 'thigh-sleeve');
    for (const offset of [-0.075, 0.075]) plate(`Thigh.${suffix}`, 'steel', [side * leg.guideX + offset, body.kneeY + 0.03, 0.035], [0.024, body.thighLength - 0.04, 0.07], 0.005);
    // Open sleeves receive the telescope rails and the folding toes.
    const sideOffset = leg.halfWidth - leg.wall / 2;
    for (const offset of [-sideOffset, sideOffset]) plate(`Shin.${suffix}`, 'blue', [side * leg.shellX + offset, leg.shellCenterY, leg.shellCenterZ], [leg.wall, leg.shellHeight, leg.shellDepth], 0.008, false, 0, 'shin-side');
    plate(`Shin.${suffix}`, 'blue', [side * leg.shellX, leg.shellCenterY, leg.shellCenterZ + (leg.shellDepth - leg.wall) / 2], [(leg.halfWidth - leg.wall) * 2, leg.shellHeight, leg.wall], 0.008, true, 0, 'shin-back');
    plate(`ShinCover.${suffix}`, 'blue', [side * leg.shellX, leg.shellCenterY, leg.coverZ + 0.04], [(leg.halfWidth - leg.wall) * 2 - 0.015, leg.shellHeight, leg.wall], 0.008, true);
    plate(`ShinCover.${suffix}`, 'steel', [side * leg.shellX, leg.shellCenterY + 0.03, leg.coverZ + 0.01], [0.22, 0.12, 0.055], 0.01, true);
    plate(`Foot.${suffix}`, 'blue', [side * leg.footX, leg.footY, -0.1], [0.25, leg.footHeight, 0.58], 0.024, true, 0, 'foot-shell');
    plate(`Foot.${suffix}`, 'steel', [side * leg.footX, leg.footY - 0.02, -0.39], [0.23, 0.09, 0.055], 0.01);
    // Layered armor changes the silhouette; machinery fills the exposed articulation.
    plate(`UpperArm.${suffix}`, 'red', [side * (arm.elbowX + 0.04), body.shoulderY + 0.27, -0.02], [0.30, 0.1, 0.48], 0.024, true, side * 9);
    plate(`UpperArm.${suffix}`, 'dark', [side * (arm.elbowX + 0.02), body.shoulderY + 0.05, -0.235], [0.24, 0.26, 0.035], 0.008, true);
    plate(`UpperArm.${suffix}`, 'red', [side * (arm.elbowX + 0.02), body.shoulderY + 0.10, -0.26], [0.2, 0.15, 0.038], 0.012, true);
    cylinder(`UpperArm.${suffix}`, 'steel', [side * arm.elbowX, arm.elbowY, 0], 0.053, 0.23, 'x', 0, true);
    cylinder(`Forearm.${suffix}`, 'dark', [side * (arm.elbowX + 0.14), arm.elbowY, 0], 0.075, 0.08, 'x', 0.062, true);
    plate(`Forearm.${suffix}`, 'steel', [side * (arm.elbowX + 0.09), arm.elbowY - 0.14, -0.17], [0.19, 0.11, 0.036], 0.009, true);
    for (const x of [-0.073, -0.024, 0.024, 0.073]) plate(`Forearm.${suffix}`, 'dark', [side * (arm.elbowX + 0.1) + x, arm.elbowY - 0.335, -0.143], [0.036, 0.115, 0.045], 0.004);
    cylinder(`Thigh.${suffix}`, 'gold', [side * (leg.guideX + 0.105), body.thighY - 0.12, -0.01], 0.028, 0.29);
    plate(`Thigh.${suffix}`, 'steel', [side * leg.guideX, body.thighY - 0.13, -0.145], [0.18, 0.2, 0.04], 0.018, true);
    plate(`ShinCover.${suffix}`, 'blue', [side * leg.shellX, leg.coverY - 0.075, leg.coverZ + 0.002], [0.26, 0.06, 0.075], 0.021, true, side * -8);
    plate(`ShinCover.${suffix}`, 'dark', [side * leg.shellX, leg.shellCenterY - 0.015, leg.coverZ + 0.016], [0.235, 0.14, 0.023], 0.005, true);
    for (const x of [-0.1, 0.1]) plate(`ShinCover.${suffix}`, 'blue', [side * leg.shellX + x, leg.shellCenterY - 0.015, leg.coverZ - 0.007], [0.034, 0.18, 0.04], 0.007);
    plate(`Foot.${suffix}`, 'dark', [side * leg.footX, layout.vehicle.groundY + 0.006, -0.1], [0.24, 0.012, 0.55], 0.002);
    cylinder('Chest', 'dark', [side * (layout.dimensions.cabWidth / 2 + 0.01), cab.back.center[1] + 0.01, cab.rear + 0.105], 0.045, 0.26);
    plate('Chest', 'red', [side * (cab.frameWidth / 2 - 0.12), cab.back.center[1], cab.back.center[2] + cab.back.size[2] / 2 + 0.017], [0.2, 0.26, 0.035], 0.012, true);
    cylinder('Chest', 'steel', [side * (cab.frameWidth / 2 - 0.04), body.shoulderY, cab.rear - 0.005], CAB_BEARING_RADIUS, 0.3, 'z');
    // Twin exhaust stacks remain part of the cab in both modes.
    for (const target of [base, detail]) {
      const tag = `bake:exhaust-${suffix}`;
      target.cylinder({ radiusTop: 0.035, radiusBottom: 0.035, height: cab.roofY + 0.19 - (cab.floorY - 0.03), radialSegments: target === detail ? 24 : 8, center: [side * (layout.dimensions.cabWidth / 2 + 0.03), (cab.roofY + 0.19 + cab.floorY - 0.03) / 2, cab.rear + 0.105], material: 'steel', tag });
      if (target === base) binding.push({ tag, joint: 'Chest' });
    }
  }
  // A retracting armored abdomen encloses the core and docks around the stowed head.
  for (const side of [-1, 1]) {
    plate('AbdomenSlide', 'dark', [side * 0.247, abdomen.centerY, -0.025], [0.03, abdomen.height, 0.42], 0.007);
    plate('AbdomenSlide', 'steel', [side * 0.23, abdomen.centerY, 0.1775], [0.04, abdomen.height, 0.025], 0.006);
    for (let row = 0; row < 3; row++) plate('AbdomenSlide', 'steel', [side * 0.116, abdomen.centerY - 0.035 + (row - 1) * 0.115, row === 1 ? -0.24 : -0.247], [0.23, 0.09, 0.025], 0.009, false, -side * 8);
  }
  plate('AbdomenSlide', 'red', [0, abdomen.top - 0.031, -0.247], [0.43, 0.06, 0.025], 0.007);
  cylinder('AbdomenSlide', 'gold', [0, abdomen.centerY - 0.015, -0.2525], 0.052, 0.015, 'z', 0.032);
  cylinder('AbdomenSlide', 'cyan', [0, abdomen.centerY - 0.015, -0.255], 0.028, 0.008, 'z', 0, false, 'power-core');
  plate('AbdomenSlide', 'dark', [0, abdomen.centerY, -0.232], [0.47, abdomen.height, 0.012], 0.003);
  plate('Hips', 'blue', [0, body.hipsY - 0.025, -0.20], [0.64, 0.10, 0.10], 0.015, true);
  plate('Hips', 'blue', [0, body.hipsY - 0.025, -0.18], [0.26, 0.10, 0.12], 0.02, true);
  plate('Chest', 'steel', [0, cab.floorY - 0.01, cab.front + 0.005], [0.12, 0.055, 0.025], 0.006);
  plate('Hips', 'steel', [0, body.hipsY - 0.04, cab.front + 0.02], [0.76, 0.065, 0.07], 0.012);
  for (const side of [-1, 1]) plate('HeadSlide', 'blue', [side * (head.halfWidth - 0.08), head.centerY, 0], [0.03, head.height, head.depth], 0.006, true);
  plate('HeadSlide', 'blue', [0, head.centerY, head.depth / 2 - 0.015], [head.halfWidth * 2 - 0.19, head.height, 0.03], 0.006, true);
  plate('HeadSlide', 'blue', [0, head.centerY + head.height / 2 - head.capInset, 0], [head.halfWidth * 2 - 0.13, head.capThickness, head.depth], 0.007);
  plate('HeadSlide', 'steel', [0, head.centerY - 0.025, head.faceZ], [head.halfWidth * 2 - 0.23, 0.13, head.faceDepth], 0.015, true);
  plate('HeadSlide', 'dark', [0, head.centerY + 0.075, head.faceZ + 0.01], [0.25, 0.065, 0.035], 0.008);
  for (const side of [-1, 1]) {
    plate('HeadSlide', 'blue', [side * (head.halfWidth - 0.03), head.centerY + 0.04, 0], [0.06, head.height + 0.03, 0.19], 0.013);
    plate('HeadSlide', 'blue', [side * (head.halfWidth - 0.101), head.centerY - 0.043, head.faceZ - 0.01], [0.055, 0.15, head.cheekDepth], 0.012, false, side * -12);
    cylinder('HeadSlide', 'steel', [side * (head.halfWidth - 0.035), head.centerY + 0.03, -0.016], 0.049, 0.035, 'x');
    plate('HeadSlide', 'blue', [side * (head.halfWidth - 0.145), head.centerY + 0.129, head.faceZ + 0.015], [0.14, 0.045, 0.045], 0.008, false, side * 12);
    plate('HeadSlide', 'cyan', [side * (head.halfWidth - 0.154), head.centerY + 0.08, head.faceZ - 0.015], [0.085, 0.029, 0.014], 0.003);
  }
  plate('HeadSlide', 'steel', [0, head.centerY + head.height / 2 + 0.005, -0.02], [0.052, 0.13, 0.16], 0.012);
  // Each tire, barrel, hub and spoke has its own high-to-low correspondence group.
  appendConvoyWheels(base, detail, binding, layout);
  base.markSharp(sel.edges.dihedral('>', 60));
  detail.markSharp(sel.edges.dihedral('>', 60));
  detail.uv.project({ mode: 'box', scale: 1 });
  base.assign(sel.all(), 'convoy');
  base.uv.auto({ resolution, padding: { mips: convoyBakeSettings(resolution).protectMip }, respectSharp: true });
  const bakeBase = base.snapshot(), bakeDetail = detail.snapshot();
  base.checkpoint('bake-receiver'); detail.checkpoint('bake-detail');
  const contacts = convoyFrame(base, detail, binding, layout);
  const assembly = rig(base, { joints: convoyJointSpecs(layout), contacts });
  for (const joint of new Set(binding.map(entry => entry.joint))) {
    const tags = binding.filter(entry => entry.joint === joint).map(entry => entry.tag);
    const faces = tags.slice(1).reduce((selection, tag) => selection.or(sel.tag(tag)), sel.tag(tags[0]!));
    assembly.bindRigid(faces, nativeName(joint), { part: nativeName(joint) });
  }
  const hardwareParts = new Set(binding.filter(entry => entry.tag.startsWith('bake:mount-')).map(entry => nativeName(entry.joint)));
  const hardware = (part: string) => hardwareParts.has(part);
  return { base, detail, bakeBase, bakeDetail, assembly, hardware };
}


export function convoyMotion(assembly = rig(model(), { joints: convoyJointSpecs() }), layout: ConvoyLayout = CONVOY_LAYOUT) {
  const rest: Record<string, number | { x?: number; z?: number }> = { hips: 0, headslidebase: 0, abdomenslide: 0 };
  for (const suffix of ['l', 'r']) Object.assign(rest, { [`upperarm-${suffix}`]: { x: 0, z: 0 }, [`shincover-${suffix}`]: 0, [`thigh-${suffix}`]: 0, [`shin-${suffix}`]: 0, [`reartrackbase-${suffix}`]: 0 });
  const head: Pose = { ...rest, headslidebase: -layout.head.travel, abdomenslide: layout.abdomen.stroke };
  const arms: Record<string, number | { x?: number; z?: number }> = { ...head, 'shincover-l': 110, 'shincover-r': 110 };
  for (const side of [-1, 1]) arms[`upperarm-${side < 0 ? 'l' : 'r'}`] = { x: -90, z: -side * 90 };
  const extended: Pose = { ...arms, hips: layout.leg.stroke, 'shin-l': -layout.leg.stroke, 'shin-r': -layout.leg.stroke, 'reartrackbase-l': -layout.rear.travel, 'reartrackbase-r': layout.rear.travel };
  const truck: Pose = { ...extended, hips: layout.vehicle.hipsFold, 'thigh-l': -90, 'thigh-r': -90, 'shincover-l': 210, 'shincover-r': 210 };
  return assembly.choreograph({ duration: PLAYER_TRANSFORM_SECONDS, keyStep: 1 / 30,
    phases: [
      { id: 'upper-body-stow', from: rest, to: head, beat: { span: [0, 0.48] } },
      { id: 'cab-fold', from: head, to: arms, beat: { span: [0.8, 1.6] } },
      { id: 'leg-extend', from: arms, to: extended, beat: { span: [1.92, 2.6], within: { reartrack: [0.65, 1] } } },
      { id: 'chassis-fold', from: extended, to: truck, beat: { span: [2.92, 3.72] } },
    ], extra(pose) {
      const result: Record<string, number> = {};
      const angle = -Number(pose['thigh-l']) * Math.PI / 180;
      if (angle > 0) {
        // The folding chassis stays above the authored contact plane. The foot
        // and counter-rotating bogie retain their world orientation. A 4 mm
        // lift covers interpolation between the exported pose keys.
        const thighY = layout.body.thighY, footY = layout.body.ankleY;
        const wheel = layout.wheels.find(wheel => wheel.name === 'WheelRearA.L')!;
        const footSupport = footY - thighY - (footY - layout.leg.stroke - thighY) * Math.cos(angle) + 0.06 * Math.sin(angle);
        const wheelSupport = layout.vehicle.groundY + layout.wheel.radius - thighY - (wheel.position[1] - layout.leg.stroke - thighY) * Math.cos(angle);
        result.hips = Math.max(Number(pose.hips), footSupport, wheelSupport) + 0.004;
      }
      for (const suffix of ['l', 'r']) {
        const arm = pose[`upperarm-${suffix}`] as { x?: number; z?: number } | undefined;
        result[`frontgimbalx-${suffix}`] = -(arm?.x ?? 0);
        result[`frontgimbalz-${suffix}`] = -(arm?.z ?? 0);
      }
      return result;
    },
  }).unwrap();
}

export function convoyPath(assembly?: ReturnType<typeof rig>, layout: ConvoyLayout = CONVOY_LAYOUT): PosePath { return convoyMotion(assembly, layout).path; }

function skinMaterial(material: MaterialAsset): MaterialAsset {
  if (material.passes === undefined) return material;
  const [first, ...rest] = material.passes;
  const skin = (pass: typeof first) => pass.name === 'shadow-caster' ? pass : { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } };
  return { ...material, passes: [skin(first), ...rest.map(skin)] };
}

export function prepareConvoyAssets(resolution: number, packageId: PackageId) {
  const guid = (key: string) => guidText(assetGuid(packageId, key));
  const { bakeBase, bakeDetail, assembly } = buildConvoy(resolution);
  const finished = assembly.finish({ key: 'player', packageId, form: 'skinned', normals: CONVOY_NORMALS, clips: [{ name: 'transform', path: convoyPath(assembly), duration: PLAYER_TRANSFORM_SECONDS, frameRate: 30 }, { name: 'wheels', duration: 1, frameRate: 30, path: { keys: [{ u: 0, pose: {} }, { u: 1, pose: Object.fromEntries(CONVOY_WHEELS.map(wheel => [nativeName(wheel.name), -360])) }] } }] });
  if (!finished.ok) throw finished.error;
  const mesh = finished.value['mesh/player'] as MeshAsset;
  const clip = finished.value['animation-clip/player/transform'] as AnimationClip;
  const nativeTargets = new Map(PLAYER_RIG.map((joint, index) => [deriveAnimationTargetId(['player', nativeName(joint.name)]), deriveAnimationTargetId(playerTargetPath(index))]));
  const wheelIds = new Set(CONVOY_WHEELS.map(wheel => deriveAnimationTargetId(['player', nativeName(wheel.name)])));
  const retarget = (source: AnimationClip, wheel: boolean): AnimationClip => ({ ...source, channels: source.channels.filter(channel => wheelIds.has(channel.targetId) === wheel && (!wheel || channel.property === 'rotation')).map(channel => ({ ...channel, targetId: nativeTargets.get(channel.targetId)! })) });
  const transformation = retarget(clip, false);
  // Native motion clips omit static channels. Declare the remaining rest rotations
  // so stopping a walk or reversing a transform cannot retain a previous pose.
  const rotationTargets = new Set(transformation.channels.filter(channel => channel.property === 'rotation').map(channel => channel.targetId));
  const restRotations: AnimationClip['channels'][number][] = PLAYER_RIG.flatMap((joint, index) => {
    const targetId = deriveAnimationTargetId(playerTargetPath(index));
    return joint.role !== 'body' || rotationTargets.has(targetId) ? [] : [{ targetId, property: 'rotation' as const, sampler: { input: new Float32Array([0]), output: new Float32Array([0, 0, 0, 1]), interpolation: 'LINEAR' as const } }];
  });
  return { bakeBase, bakeDetail, assets: {
    ...convoyHardwareTextures(),
    ...Object.fromEntries(CONVOY_HARDWARE_SLOTS.map(slot => {
      const { materialId: _materialId, ...surface } = CONVOY_SURFACES[slot];
      return [`material/${slot}`, skinMaterial(Materials.standard({ ...surface, normalTexture: { texture: guid(`texture/convoy-${slot === 'rubber' ? 'rubber' : 'brushed'}-normal`) }, metallicRoughnessTexture: { texture: guid('texture/convoy-hardware-ormh') } }))];
    })),
    'mesh/player': { ...mesh, materialSlots: mesh.materialSlots.map(({ slotName }) => ({ slotName, defaultMaterial: assetGuid(packageId, `material/${slotName}`) })) },
    'rig/player-skeleton': finished.value['skeleton/player'] as SkeletonAsset,
    'rig/player-skin': { kind: 'skin', skeletonGuid: guid('rig/player-skeleton'), jointPaths: [...PLAYER_JOINT_NAMES] } satisfies SkinAsset,
    'animation/player-transform': { ...transformation, channels: [...transformation.channels, ...restRotations] },
    'animation/player-wheels': retarget(finished.value['animation-clip/player/wheels'] as AnimationClip, true),
    'material/convoy': skinMaterial(Materials.standard({
      baseColor: [1, 1, 1, 1], metallic: 1, roughness: 1,
      baseColorTexture: { texture: guid('texture/convoy-base-color') },
      staticSwitches: { clearcoat: true }, clearcoat: 0.85, clearcoatRoughness: 1,
      clearcoatTexture: { texture: guid('texture/convoy-coat') }, clearcoatRoughnessTexture: { texture: guid('texture/convoy-coat') },
      normalTexture: { texture: guid('texture/convoy-normal') },
      metallicRoughnessTexture: { texture: guid('texture/convoy-ormh') },
      occlusionTexture: { texture: guid('texture/convoy-ormh') },
      emissive: [2, 2, 2], emissiveTexture: { texture: guid('texture/convoy-emissive') },
    })),
  } };
}
