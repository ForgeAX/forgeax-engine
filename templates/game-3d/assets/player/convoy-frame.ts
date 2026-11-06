import { model, sel, type DesignedContact, type Model, type Tuple3 } from '@forgeax/engine/modeling';
import { createPlayerRig, nativeJointName as native } from './player-rig.ts';
import { CONVOY_LAYOUT, type ConvoyLayout } from './convoy-layout.ts';
import { addConvoyPart, appendConvoyParts, type ConvoyBinding } from './convoy-parts.ts';

/** Load-bearing members stay geometry; tread, fasteners and surface finish bake down. */
export function convoyFrame(base: Model, detail: Model, binding: ConvoyBinding[], layout: ConvoyLayout = CONVOY_LAYOUT) {
  const contacts: DesignedContact[] = [];
  const lowParts: Model[] = [], highParts: Model[] = [];
  let serial = 0;
  const add = (joint: string, build: (part: Model, high: boolean) => void) => {
    const tag = `bake:mount-${native(joint)}-${serial++}`;
    addConvoyPart([lowParts, highParts], binding, joint, tag, (part, high) => {
      build(part, high);
      const sharp = sel.edges.dihedral('>', 40);
      if (part.count(sharp) > 0) part.markSharp(sharp);
      part.uv.project({ mode: 'box', scale: 8 });
    }, { structural: true });
  };
  const tube = (joint: string, center: Tuple3, outer: number, inner: number, length: number, axis: 'x' | 'y' | 'z', material = 'steel') => add(joint, (part, high) => {
    if (inner > 0) part.revolve({ points: [[inner, -length / 2], [outer, -length / 2], [outer, length / 2], [inner, length / 2], [inner, -length / 2]], segments: high ? 48 : 16, material });
    else part.cylinder({ radiusTop: outer, radiusBottom: outer, height: length, radialSegments: high ? 40 : 16, material });
    if (axis !== 'y') part.rotate(sel.all(), axis === 'x' ? 'z' : 'x', 90);
    part.translate(sel.all(), center);
  });
  const rod = (joint: string, a: Tuple3, b: Tuple3, radius = 0.012) => add(joint, (part, high) => {
    const count = high ? 16 : 8;
    const profile = Array.from({ length: count }, (_, n) => [Math.cos(n * Math.PI * 2 / count) * radius, Math.sin(n * Math.PI * 2 / count) * radius] as const);
    part.sweep({ profile, path: [a, b], material: 'dark' });
  });
  const fit = (a: string, b: string, min = 0.0008, max = 0.006) => contacts.push({ parts: [a, b], kind: 'fit', gap: [min, max] });
  const ball = (joint: string, center: Tuple3, radius: number) => add(joint, (part, high) => {
    part.sphere({ radius, widthSegments: high ? 40 : 16, heightSegments: high ? 24 : 12, center, material: 'steel' });
  });
  const socket = (joint: string, center: Tuple3, inner: number, outer: number, outward: -1 | 0 | 1 = 0) => add(joint, (part, high) => {
    const steps = high ? 16 : 6;
    const arc = (r: number, reverse = false) => Array.from({ length: steps + 1 }, (_, k) => {
      const n = reverse ? steps - k : k, angle = n * Math.PI / (2 * steps);
      return [n === steps ? 0 : r * Math.cos(angle), r * Math.sin(angle)] as const;
    });
    const points = [...arc(inner, true), ...arc(outer)];
    part.revolve({ points, segments: high ? 40 : 16, material: 'dark' });
    if (outward !== 0) part.rotate(sel.all(), 'z', -outward * 90);
    part.translate(sel.all(), center);
  });
  const { body, cab, leg, arm, rear, head, abdomen } = layout;
  const anchors = new Map(createPlayerRig(layout).map(joint => [joint.name, joint.world]));
  const anchor = (name: string): Tuple3 => [...anchors.get(name)!];
  // Mating balls, sockets and load paths share the rig's solved hardpoints.
  rod('Hips', [0, body.hipsY + 0.08, 0], anchor('Spine'), 0.018);
  rod('Hips', [0, body.hipsY - 0.01, -0.06], [0, body.hipsY - 0.01, cab.front + 0.145], 0.025);
  ball('Hips', anchor('Spine'), 0.0275);
  socket('Spine', anchor('Spine'), 0.030, 0.045);
  rod('Spine', [0, body.spineY + 0.04, 0], anchor('Chest'), 0.018);
  ball('Spine', anchor('Chest'), 0.0275);
  socket('Chest', anchor('Chest'), 0.030, 0.045);
  const guideBottom = abdomen.centerY - abdomen.height / 2 + 0.042;
  const guideTop = abdomen.centerY + abdomen.stroke + 0.045;
  const guideLength = guideTop - guideBottom + 0.032;
  rod('Spine', [0, body.spineY + 0.07, 0], [0, body.spineY + 0.07, 0.21], 0.01);
  rod('Spine', [0, guideBottom, 0.21], [0, guideTop, 0.21], 0.01);
  for (const side of [-1, 1]) {
    tube('Spine', [side * 0.19, guideBottom - 0.002 + guideLength / 2, 0.175], 0.018, 0, guideLength, 'y');
    for (const y of [guideBottom, guideTop]) rod('Spine', [0, y, 0.21], [side * 0.19, y, 0.175], 0.005);
    tube('AbdomenSlide', [side * 0.19, abdomen.centerY - 0.065, 0.175], 0.030, 0.021, 0.16, 'y', 'gold');
    rod('AbdomenSlide', [side * 0.218, abdomen.centerY - 0.065, 0.175], [side * 0.247, abdomen.centerY - 0.065, 0.175], 0.008);
  }
  fit(native('Spine'), native('AbdomenSlide'), 0.001, 0.006);
  for (const offset of [-0.022, -0.006, 0.010, 0.026]) add('AbdomenSlide', (part, high) => {
    part.revolve({ points: [[0.19, -0.003], [0.21, -0.003], [0.21, 0.003], [0.19, 0.003], [0.19, -0.003]], segments: high ? 48 : 16, angle: 270, material: 'rubber' });
    part.fillHoles(sel.edges.meshBoundary(), { material: 'rubber' });
    part.rotate(sel.all(), 'y', 45);
    part.scale(sel.all(), [1, 1, 0.75]); part.translate(sel.all(), [0, abdomen.centerY - abdomen.height / 2 + offset, -0.02]);
  });
  for (const side of [-1, 1]) {
    rod('AbdomenSlide', [side * 0.215, abdomen.centerY - abdomen.height / 2 - 0.022, -0.02], [side * 0.215, body.hipsY + 0.12, -0.02], 0.006);
    rod('AbdomenSlide', [side * 0.215, body.hipsY + 0.12, -0.02], [side * 0.247, body.hipsY + 0.12, -0.02], 0.008);
    rod('Hips', [side * 0.08, body.hipsY - 0.01, cab.front + 0.145], [side * 0.18, body.hipsY - 0.04, cab.front + 0.02]);
    rod('Chest', [side * 0.03, body.chestY + 0.025, 0.02], [side * 0.03, body.chestY + 0.025, -0.06], 0.009);
    rod('Chest', [side * 0.03, body.chestY + 0.025, -0.06], [side * 0.03, cab.floorTop, -0.06], 0.009);
    rod('Chest', [side * 0.03, cab.floorTop, -0.06], [side * 0.03, cab.floorTop, 0.23], 0.009);
    rod('Chest', [side * 0.03, cab.floorTop, 0.23], [side * cab.floorSide.center[0], cab.floorY, 0.23], 0.009);
    rod('Chest', [side * cab.floorSide.center[0], cab.floorY, 0.23], [side * cab.floorSide.center[0], cab.floorY, 0.17], 0.009);
  }
  fit(native('Hips'), native('Spine')); fit(native('Spine'), native('Chest'));
  rod('Chest', [0, body.chestY + 0.04, 0], anchor('Head'), 0.015);
  ball('Chest', anchor('Head'), 0.0245);
  socket('Head', anchor('Head'), 0.028, 0.04);
  tube('Head', [head.guideX, body.neckY, 0], 0.030, 0.024, head.guideLength, 'y', 'dark');
  rod('Head', [0.035, body.neckY + 0.02, 0], [0.035, body.neckY + 0.02, 0.05], 0.004);
  rod('Head', [0.035, body.neckY + 0.02, 0.05], [head.guideX, body.neckY + 0.02, 0.05], 0.004);
  rod('Head', [head.guideX, body.neckY + 0.02, 0.05], [head.guideX, body.neckY + 0.02, 0.029], 0.004);
  tube('HeadSlideBase', [head.guideX, head.innerY, 0], 0.020, 0.014, head.innerLength, 'y');
  tube('HeadSlide', [head.guideX, head.rodY, 0], 0.011, 0, head.rodLength, 'y');
  fit(native('Chest'), native('Head')); fit(native('Head'), native('HeadSlideBase')); fit(native('HeadSlideBase'), native('HeadSlide'));
  tube('Hips', [0, body.thighY, 0], 0.025, 0, body.hipX * 2 + 0.10, 'x');
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'L' : 'R';
    const upper = `UpperArm.${suffix}`, gx = `FrontGimbalX.${suffix}`, gz = `FrontGimbalZ.${suffix}`;
    const shoulder = anchor(upper), elbow = anchor(`Forearm.${suffix}`);
    ball('Chest', shoulder, 0.022);
    socket(upper, shoulder, 0.025, 0.04, side as -1 | 1);
    rod('Chest', [side * (cab.frameWidth / 2 - 0.15), body.shoulderY + 0.06, cab.rear - 0.04], [side * (body.shoulderX - 0.04), body.shoulderY + 0.04, 0.08], 0.018);
    rod('Chest', [side * (body.shoulderX - 0.04), body.shoulderY + 0.04, 0.08], shoulder, 0.008);
    rod(upper, [shoulder[0] + side * 0.04, shoulder[1], 0], [elbow[0] - side * 0.09, shoulder[1], 0]);
    rod(upper, elbow, [elbow[0] + side * 0.02, elbow[1] + 0.15, 0], 0.025);
    fit(native('Chest'), native(upper));
    fit(native(upper), native(`Forearm.${suffix}`), 0.006, 0.01);
    const wheel = layout.wheels.find(w => w.name === `WheelFront.${suffix}`)!;
    const a = anchor(gx), b = anchor(gz);
    const yokeX = shoulder[0] + side * 0.46, yokeY = shoulder[1] - 0.03;
    // Perpendicular pins and the spindle use exactly the same anchors as the rig.
    tube(upper, a, 0.04, 0.022, arm.gimbalSpacing, 'x');
    rod(upper, [yokeX, yokeY, a[2] - 0.082], [yokeX, yokeY, a[2]]);
    rod(upper, [yokeX, yokeY, a[2]], [a[0], a[1] + 0.035, a[2]]);
    tube(gx, a, 0.02, 0, arm.gimbalSpacing + 0.02, 'x');
    tube(gx, b, 0.028, 0.018, 0.06, 'z');
    tube(gz, b, 0.016, 0, 0.12, 'z');
    const spindleX = b[0] + side * 0.045;
    rod(gz, [b[0], b[1], b[2] + 0.05], [spindleX, b[1], b[2] + 0.05], 0.009);
    rod(gz, [spindleX, b[1], b[2] + 0.05], [spindleX, b[1], b[2]], 0.009);
    rod(gz, [spindleX, b[1], b[2]], wheel.position, 0.018);
    tube(gz, wheel.position, 0.052, 0, 0.10, 'x', 'dark');
    fit(native(upper), native(gx)); fit(native(gx), native(gz)); fit(native(gz), native(wheel.name));

    const thigh = `Thigh.${suffix}`, shin = `Shin.${suffix}`, foot = `Foot.${suffix}`, cover = `ShinCover.${suffix}`;
    const hip = anchor(thigh), ankle = anchor(foot), coverPivot = anchor(cover);
    tube(thigh, hip, 0.048, 0.027, 0.09, 'x', 'dark');
    tube(thigh, [side * leg.guideX, leg.guideY, 0.1], leg.guideOuter, leg.guideBore, layout.dimensions.legGuideLength, 'y', 'dark');
    tube(thigh, [side * leg.guideX, leg.guideY - 0.03, 0.1], 0.065, leg.guideBore, 0.10, 'y');
    tube(shin, [side * leg.guideX, leg.rodY, 0.1], leg.rodRadius, 0, leg.rodLength, 'y');
    const carriageInner = leg.shellX - 0.12, carriageOuter = leg.shellX + 0.12;
    rod(shin, [side * carriageInner, leg.carriageY, 0.1], [side * carriageOuter, leg.carriageY, 0.1], 0.0025);
    for (const x of [side * carriageInner, side * carriageOuter]) {
      rod(shin, [x, leg.carriageY, 0.1], [x, leg.carriageY, leg.shellCenterZ], 0.0025);
      rod(shin, [x, leg.carriageY, leg.shellCenterZ], [x, leg.carriageY + 0.0275, leg.shellCenterZ], 0.004);
    }
    const strapY = leg.carriageY + 0.0275;
    for (const x of [side * (leg.footX - 0.15), side * (leg.footX + 0.15)]) rod(shin, [x, strapY, leg.shellCenterZ], [x, ankle[1], ankle[2]], 0.01);
    rod(shin, [side * (leg.footX - 0.15), strapY, leg.shellCenterZ], [side * rear.bogieX, strapY, leg.shellCenterZ], 0.01);
    const footBearing: Tuple3 = [side * leg.footX, ankle[1], ankle[2]];
    tube(shin, footBearing, 0.022, 0, 0.34, 'x');
    tube(foot, footBearing, 0.040, 0.026, 0.14, 'x', 'dark');
    const coverOffset = leg.halfWidth - leg.wall / 2;
    for (const offset of [-coverOffset, coverOffset]) rod(shin, [coverPivot[0] + offset, coverPivot[1] - 0.05, coverPivot[2] + 0.04], [coverPivot[0] + offset, coverPivot[1], coverPivot[2]], 0.008);
    tube(shin, coverPivot, 0.012, 0, 0.38, 'x');
    tube(cover, coverPivot, 0.024, 0.016, 0.24, 'x', 'dark');
    for (const offset of [-0.1, 0.1]) rod(cover, [coverPivot[0] + offset, coverPivot[1] - 0.024, coverPivot[2]], [coverPivot[0] + offset, coverPivot[1] - 0.05, coverPivot[2] + 0.02], 0.006);
    fit(native('Hips'), native(thigh), 0.001, 0.004);
    fit(native(thigh), native(shin), 0.002, 0.006);
    fit(native(shin), native(foot), 0.003, 0.005);
    fit(native(shin), native(cover), 0.001, 0.006);
    const bogie = `RearBogie.${suffix}`, first = `RearTrackBase.${suffix}`, track = `RearTrack.${suffix}`;
    const bridgeX = side * (rear.bogieX + 0.0336);
    add(bogie, (part, high) => {
      part.box({ center: [bridgeX, rear.wheelY, rear.pitch / 2], size: [0.01, 0.08, rear.bridgeLength], material: 'dark' });
      for (const z of [0, rear.pitch]) {
        const bore = model();
        bore.cylinder({ radiusTop: 0.032, radiusBottom: 0.032, height: 0.04, radialSegments: high ? 48 : 16, material: 'dark' });
        bore.rotate(sel.all(), 'z', 90); bore.translate(sel.all(), [bridgeX, rear.wheelY, z]);
        part.difference(bore);
      }
      if (high) part.bevel(sel.edges.all(), { width: 0.0018, segments: 2, material: 'steel' });
    });
    for (const wheel of layout.wheels.filter(w => w.name.startsWith('WheelRear') && w.name.endsWith(suffix))) {
      const z = wheel.position[2];
      tube(bogie, [side * (rear.bogieX + 0.03), rear.wheelY, z], 0.038, 0.032, rear.sleeveLength, 'x', 'dark');
      tube(first, [side * (rear.bogieX + 0.04), rear.wheelY, z], 0.030, 0.024, rear.intermediateLength, 'x');
      tube(track, [side * (rear.bogieX + 0.05), rear.wheelY, z], 0.022, 0, rear.spindleLength, 'x');
      tube(track, wheel.position, 0.052, 0.040, 0.10, 'x', 'dark');
      tube(track, [wheel.position[0] + side * 0.038, rear.wheelY, z], 0.052, 0, 0.014, 'x');
      fit(native(track), native(wheel.name));
    }
    fit(native(shin), native(bogie), 0.0035, 0.006);
    fit(native(bogie), native(first)); fit(native(first), native(track));
    fit(native(bogie), native(track), 0.001, rear.travel * 2 + 0.01);
  }
  appendConvoyParts(base, lowParts);
  appendConvoyParts(detail, highParts);
  return contacts;
}
