import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { decodeTape, buildFrameModel, halfToFloat } from '@forgeax/engine-rhi-debug';

// Diagnostic reconstruction from exact selected-work input bytes. This mirrors
// march decisions for explanation only; the finite-box oracle stays independent.
const inputs = JSON.parse(readFileSync(process.argv[2]));
const tapeBytes = new Uint8Array(readFileSync(resolve(dirname(process.argv[2]), 'frame.rhitape')));
assert.equal(createHash('sha256').update(tapeBytes).digest('hex'), inputs.artifactDigest);
const model = buildFrameModel(decodeTape(tapeBytes).unwrap());
const traceSource = process.env.SSR_TRACE_SOURCE === undefined
  ? model.works.find(work => work.workIndex === inputs.workIndex)?.pipeline.shaders
    .find(shader => shader.entryPoint === 'ssr_trace')?.source
  : readFileSync(resolve(process.env.SSR_TRACE_SOURCE), 'utf8');
const candidateSourceDigest = process.env.SSR_TRACE_SOURCE === undefined ? undefined
  : createHash('sha256').update(traceSource).digest('hex');
const texelIntervals = traceSource.includes('exitFraction');
const conservativeDepth = traceSource.includes('intervalDepth + thickness');
const faceRefinement = traceSource.includes('covered && dot(normal, -direction)');
const offsetOrigin = /worldPosition(?:_\d+)?\s*\+\s*normal(?:_\d+)?\s*\*/.test(traceSource);
const coarseSteps = Number(traceSource?.match(/const SSR_TRACE_MAX_COARSE_STEPS[_\d]*\s*:\s*u32\s*=\s*(\d+)u?\s*;/)?.[1]);
assert.ok(Number.isInteger(coarseSteps) && coarseSteps > 0);
const data = {};
for (const name of ['depth', 'normal', 'camera', 'fallback']) {
  const input = inputs[name], bytes = readFileSync(input.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), input.digest);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = input.format?.endsWith('16float') ? 2 : input.format === 'rgba8unorm' ? 1 : 4;
  data[name] = Array.from({ length: bytes.length / stride }, (_, i) => stride === 2
    ? halfToFloat(view.getUint16(i * 2, true)) : stride === 1 ? bytes[i] / 255 : view.getFloat32(i * 4, true));
}
const multiply = (m, v) => [0, 1, 2, 3].map(r => v.reduce((s, x, c) => s + m[c * 4 + r] * x, 0));
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const unit = a => scale(a, 1 / Math.hypot(...a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const matrix = data.camera.slice(0, 16), inverse = data.camera.slice(44, 60), eye = data.camera.slice(24, 27);
const [maxDistance, thickness] = data.camera.slice(236, 238);
const width = inputs.depth.width, height = inputs.depth.height;
const wallTopArg = process.argv.find(arg => arg.startsWith('--wall-top='));
const wallTop = wallTopArg === undefined ? undefined : Number(wallTopArg.slice(11));
assert.ok(wallTop === undefined || Number.isFinite(wallTop), 'wall-top must be finite');
const project = p => { const h = multiply(matrix, [...p, 1]); return [h[0] / h[3] * .5 + .5, .5 - h[1] / h[3] * .5]; };
const distance = p => multiply(matrix, [...p, 1])[3];
const reconstruct = (uv, d) => { const h = multiply(inverse, [uv[0] * 2 - 1, 1 - uv[1] * 2, d, 1]); return scale(h.slice(0, 3), 1 / h[3]); };
const sample = uv => {
  const pixel = [Math.max(0, Math.min(width - 1, Math.floor(uv[0] * width))), Math.max(0, Math.min(height - 1, Math.floor(uv[1] * height)))];
  const p = pixel[1] * width + pixel[0], depth = data.depth[p];
  return { pixel, depth, surface: reconstruct(uv, depth), center: reconstruct([(pixel[0] + .5) / width, (pixel[1] + .5) / height], depth),
    normal: data.normal.slice(p * 4, p * 4 + 3).map(v => v * 2 - 1), coverage: data.fallback[p * 4 + 3] };
};
for (const coordinates of process.argv.slice(3).filter(arg => !arg.startsWith('--wall-top='))) {
  const [x, y] = coordinates.split(',').map(Number), uv = [(x + .5) / width, (y + .5) / height];
  const receiver = sample(uv), normal = unit(receiver.normal), position = receiver.surface;
  const incident = unit(sub(position, eye)), direction = unit(sub(incident, scale(normal, 2 * dot(incident, normal))));
  const origin = offsetOrigin ? add(position, scale(normal, Math.max(distance(position) * 1e-4, 1e-4))) : position;
  const start = project(origin), end = project(add(origin, scale(direction, maxDistance))), delta = sub(end, start);
  const sd = distance(origin), ed = distance(add(origin, scale(direction, maxDistance)));
  let endFraction = 1;
  for (let axis = 0; axis < 2; axis++) if (Math.abs(delta[axis]) > 1e-6)
    endFraction = Math.min(endFraction, ((delta[axis] > 0 ? 1 : 0) - start[axis]) / delta[axis]);
  const count = Math.min(coarseSteps, Math.ceil(Math.max(Math.abs(delta[0] * endFraction * width), Math.abs(delta[1] * endFraction * height))));
  const events = [];
  let firstTangentCandidate;
  let lower, upper;
  for (let step = 1; step <= count; step++) {
    const t = step / count * endFraction, uv = add(start, scale(delta, t)), s = sample(uv);
    const rd = 1 / ((1 - t) / sd + t / ed), sceneDistance = distance(s.surface);
    let exit = t;
    if (texelIntervals) {
      const fractions = [width, height].map((size, axis) => Math.abs(delta[axis]) > 1e-8
        ? ((s.pixel[axis] + (delta[axis] > 0 ? 1 : 0)) / size - start[axis]) / delta[axis] : endFraction);
      const span = Math.max(Math.abs(delta[0]) * width, Math.abs(delta[1]) * height);
      exit = Math.max(t, Math.min(endFraction, ...fractions) - 1e-4 / Math.max(span, 1));
    }
    const intervalDepth = Math.max(rd, 1 / ((1 - exit) / sd + exit / ed));
    const separation = Math.hypot(...cross(sub(s.surface, origin), direction));
    const radius = Math.max(thickness, Math.hypot(...sub(s.surface, reconstruct(add(uv, [1 / width, 0]), s.depth))) * 3);
    // Diagnostic only: a ray can intersect the plane inside this depth texel
    // even when its point sample remains in front of the texel's center depth.
    if (firstTangentCandidate === undefined && s.depth < 1 && s.coverage > .5 && dot(s.normal, direction) < 0) {
      const planeDistance = dot(sub(s.center, origin), s.normal) / dot(direction, s.normal);
      const hitUv = project(add(origin, scale(direction, planeDistance)));
      const hitPixel = [Math.floor(hitUv[0] * width), Math.floor(hitUv[1] * height)];
      if (planeDistance > 0 && planeDistance <= maxDistance && hitPixel.every((value, axis) => value === s.pixel[axis])) {
        firstTangentCandidate = { step, pixel: s.pixel, planeDistance, hitUv, rd, sceneDistance };
      }
    }
    let planeDistance, planeUv;
    let insideFootprint = true;
    if (texelIntervals && rd < sceneDistance && dot(s.normal, direction) < 0) {
      planeDistance = dot(sub(s.center, origin), s.normal) / dot(direction, s.normal);
      planeUv = project(add(origin, scale(direction, planeDistance)));
      insideFootprint = planeDistance > 0 && planeDistance <= maxDistance
        && planeUv.every((v, axis) => v >= 0 && v < 1 && Math.floor(v * [width, height][axis]) === s.pixel[axis]);
    }
    const reason = s.depth >= 1 ? 'sky' : s.coverage <= .5 ? 'coverage'
      : intervalDepth + (conservativeDepth ? thickness : 0) < sceneDistance ? 'in-front'
      : !insideFootprint ? 'outside-texel-plane'
      : dot(s.normal, scale(direction, -1)) <= 0 ? 'backface' : separation > radius ? 'thickness' : 'candidate';
    events.push({ step, t, exit, pixel: s.pixel, normal: s.normal, rd, intervalDepth, sceneDistance,
      separation, radius, reason, planeDistance, planeUv });
    if (reason === 'candidate') {
      lower = rd >= sceneDistance ? (step - 1) / count * endFraction : t;
      upper = rd >= sceneDistance ? t : exit;
      break;
    }
  }
  let refined;
  if (upper !== undefined) {
    for (let i = 0; i < 5; i++) {
      const t = (lower + upper) / 2, s = sample(add(start, scale(delta, t)));
      const rd = 1 / ((1 - t) / sd + t / ed);
      const faceAccepted = !faceRefinement || (s.coverage > .5 && dot(s.normal, direction) < 0);
      if (s.depth < 1 && rd >= distance(s.center) && faceAccepted) upper = t; else lower = t;
    }
    const s = sample(add(start, scale(delta, upper)));
    const planeDistance = dot(sub(s.center, origin), s.normal) / dot(direction, s.normal);
    const intersection = add(origin, scale(direction, planeDistance));
    const hit = sample(project(intersection));
    refined = { ...s, planeDistance, intersection, hit, separation: Math.hypot(...sub(hit.surface, intersection)) };
  }
  let silhouette;
  if (wallTop !== undefined && refined !== undefined) {
    const intersection = refined.intersection;
    const hitUv = project(intersection);
    const edgeUv = project([intersection[0], wallTop, intersection[2]]);
    silhouette = { wallTop, overshootWorld: intersection[1] - wallTop,
      hitPixel: hitUv.map((value, axis) => value * [width, height][axis]),
      edgePixel: edgeUv.map((value, axis) => value * [width, height][axis]),
      projectedDistancePixels: Math.hypot(...hitUv.map((value, axis) => (value - edgeUv[axis]) * [width, height][axis])) };
  }
  // A half-resolution receiver texel spans two full-resolution pixels.
  // Project its four corners through the local receiver and hit tangent
  // planes, rather than guessing a source filter radius from roughness.
  // This is a local differential estimate, not visibility at the corners.
  let sourceFootprint;
  if (refined !== undefined) {
    const hitPlane = refined.hit;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => {
      const cornerUv = add(uv, [dx / width, dy / height]);
      const cameraRay = sub(reconstruct(cornerUv, receiver.depth), eye);
      const receiverDenominator = dot(cameraRay, normal);
      const receiverT = dot(sub(position, eye), normal) / receiverDenominator;
      if (!Number.isFinite(receiverT) || receiverT <= 0) return undefined;
      const point = add(eye, scale(cameraRay, receiverT));
      const incoming = unit(sub(point, eye));
      const reflected = sub(incoming, scale(normal, 2 * dot(incoming, normal)));
      const hitT = dot(sub(hitPlane.center, point), hitPlane.normal) / dot(reflected, hitPlane.normal);
      if (!Number.isFinite(hitT) || hitT <= 0) return undefined;
      const hitUv = project(add(point, scale(reflected, hitT)));
      return hitUv.map((v, axis) => v * [width, height][axis]);
    });
    if (corners.every(corner => corner !== undefined && corner.every(Number.isFinite))) {
      const spans = [0, 1].map(axis => Math.max(...corners.map(c => c[axis])) - Math.min(...corners.map(c => c[axis])));
      const signedArea = corners.reduce((sum, a, i) => {
        const b = corners[(i + 1) % corners.length];
        return sum + a[0] * b[1] - a[1] * b[0];
      }, 0) * 0.5;
      sourceFootprint = { receiverExtentFullPixels: [2, 2], corners, spans, areaSourcePixels: Math.abs(signedArea),
        caveat: 'Local planar projection only; corner visibility and texture bandwidth are not measured' };
    }
  }
  console.log(JSON.stringify({ artifact: inputs.artifactDigest, candidateSourceDigest, silhouette, sourceFootprint,
    coordinates: [x, y], receiver, direction, origin, count, firstTangentCandidate, events, refined }, null, 2));
}
