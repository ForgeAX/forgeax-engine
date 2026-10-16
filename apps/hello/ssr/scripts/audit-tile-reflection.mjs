// Independent planar-mirror oracle for the authored tiled-wall fixture.
// Inputs are selected-work RHI readbacks, not renderer inspection counters.
export function sampleLinearColor(image, uv, admitted) {
  const position = [uv[0] * image.width - 0.5, uv[1] * image.height - 0.5];
  const first = position.map(Math.floor);
  const fraction = position.map((v, i) => v - first[i]);
  const color = [0, 0, 0];
  let coverage = 0;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const px = Math.max(0, Math.min(image.width - 1, first[0] + x));
    const py = Math.max(0, Math.min(image.height - 1, first[1] + y));
    const weight = (x ? fraction[0] : 1 - fraction[0]) * (y ? fraction[1] : 1 - fraction[1]);
    if (admitted !== undefined && !admitted(py * image.width + px)) continue;
    for (let c = 0; c < 3; c++) color[c] += image.values[(py * image.width + px) * 4 + c] * weight;
    coverage += weight;
  }
  return color.map(value => value / Math.max(coverage, 1e-6));
}

// A planar mirror maps a straight wall edge to a straight screen segment.
// Distances are in full-resolution receiver pixels, not source-wall texels.
export function projectMirrorSegment(segment, floorY, projection, width, height) {
  const projected = segment.map(point => {
    const reflected = [point[0], 2 * floorY - point[1], point[2], 1];
    const clip = [0, 1, 2, 3].map(row => reflected.reduce(
      (sum, value, column) => sum + projection[column * 4 + row] * value, 0));
    if (!(clip[3] > 0)) return null;
    return [(clip[0] / clip[3] * 0.5 + 0.5) * width,
      (0.5 - clip[1] / clip[3] * 0.5) * height];
  });
  // This bounded outline diagnostic does not clip segments across the eye.
  return projected.some(point => point === null) ? null : projected;
}

export function mirrorSegmentDistance(pixel, segment) {
  const [a, b] = segment;
  const direction = b.map((v, axis) => v - a[axis]);
  const lengthSquared = direction[0] ** 2 + direction[1] ** 2;
  if (!(lengthSquared > 0)) throw new Error('Mirror outline must have nonzero length');
  const fraction = pixel.reduce((sum, v, axis) => sum + (v - a[axis]) * direction[axis], 0) / lengthSquared;
  if (fraction < 0 || fraction > 1) return Infinity;
  return Math.abs(direction[0] * (pixel[1] - a[1]) - direction[1] * (pixel[0] - a[0])) / Math.sqrt(lengthSquared);
}

export function auditTileReflection({ traced, base, depth, normal, camera }) {
  const multiply = (matrix, vector) => [0, 1, 2, 3].map((row) =>
    vector.reduce((sum, value, col) => sum + matrix[col * 4 + row] * value, 0));
  const inverse = camera.values.slice(44, 60);
  const projection = camera.values.slice(0, 16);
  const eye = camera.values.slice(24, 27);
  const rows = [];
  let eligible = 0, missed = 0, mismatch = 0;
  let errorSum = 0;
  for (let y = 0; y < traced.height; y += 1) {
    const row = { y, eligible: 0, missed: 0, mismatch: 0, confidenceSum: 0 };
    for (let x = 0; x < traced.width; x += 1) {
      const full = (y * 2 * base.width + x * 2) * 4;
      // The smooth floor is the low-roughness upward-facing receiver.
      if (normal.values[full + 1] < 0.999 || normal.values[full + 3] > 0.1) continue;
      const h = multiply(inverse, [(x * 2 + 0.5) / base.width * 2 - 1,
        1 - (y * 2 + 0.5) / base.height * 2, depth.values[full / 4], 1]);
      const origin = h.slice(0, 3).map((v) => v / h[3]);
      const incident = origin.map((v, i) => v - eye[i]);
      incident[1] *= -1;
      const length = Math.hypot(...incident);
      const direction = incident.map((v) => v / length);
      const distances = [0, 2].map((axis) => direction[axis] < 0
        ? (-3.89 - origin[axis]) / direction[axis] : Infinity);
      const distance = Math.min(...distances);
      if (!(distance > 0 && distance < 12)) continue;
      const target = origin.map((v, i) => v + direction[i] * distance);
      const clip = multiply(projection, [...target, 1]);
      const uv = [clip[0] / clip[3] * 0.5 + 0.5, 0.5 - clip[1] / clip[3] * 0.5];
      if (!uv.every((v) => v > 0.15 && v < 0.85)) continue;
      const sx = Math.floor(uv[0] * base.width), sy = Math.floor(uv[1] * base.height);
      const p = (sy * base.width + sx) * 4;
      const axis = distances[0] < distances[1] ? 0 : 2;
      // Discard grout/occluders and uncertain silhouette pixels. Their exact
      // tile geometry is not part of this infinite-plane comparison.
      if (normal.values[p + axis] < 0.999) continue;
      const ndc = clip[2] / clip[3];
      if (Math.abs(depth.values[p / 4] - ndc) > 0.0001) continue;
      eligible++; row.eligible++;
      const t = (y * traced.width + x) * 4;
      const confidence = traced.values[t + 3];
      row.confidenceSum += confidence;
      if (confidence <= 0) { missed++; row.missed++; continue; }
      // Read the exact nearest source pixel expected by the current trace.
      const error = Math.max(...[0, 1, 2].map((c) => Math.abs(traced.values[t + c] - base.values[p + c])));
      errorSum += error;
      if (error > 0.1) { mismatch++; row.mismatch++; }
    }
    if (row.eligible > 0) rows.push(row);
  }
  return { eligible, missed, mismatch, meanHitColorError: errorSum / Math.max(1, eligible - missed), rows };
}

// Finite authored wall boxes, including recessed backing and tile side faces.
// This oracle does not reuse the production ray march or its thickness test.
export function auditTileSeams({ traced, base, depth, normal, camera, fallback, colorFilter = 'nearest', maxRoughness = 0.1 }) {
  if (!['nearest', 'linear', 'linear-admitted'].includes(colorFilter)) throw new Error('Unknown oracle color filter');
  if (colorFilter === 'linear-admitted' && fallback === undefined) throw new Error('Admitted color oracle requires captured fallback coverage');
  if (!Number.isFinite(maxRoughness) || maxRoughness < 0 || maxRoughness > 1) throw new Error('Invalid oracle roughness range');
  const boxes = [];
  for (let wall = 0; wall < 2; wall++) {
    const box = (along, height, width, tall, center, kind) => {
      const position = wall === 0 ? [along, height, center] : [center, height, along];
      const size = wall === 0 ? [width, tall, 0.12] : [0.12, tall, width];
      boxes.push({ min: position.map((v, i) => v - size[i] / 2),
        max: position.map((v, i) => v + size[i] / 2), kind });
    };
    box(0, 1, 8.1, 4.1, -4.05, 'grout');
    for (let row = 0; row < 5; row++) for (let col = 0; col < 10; col++) {
      box(-3.6 + col * 0.8, -0.64 + row * 0.78, 0.75, 0.73, -3.95, 'tile');
    }
  }
  const multiply = (m, v) => [0, 1, 2, 3].map((r) =>
    v.reduce((sum, value, c) => sum + m[c * 4 + r] * value, 0));
  const inverse = camera.values.slice(44, 60), projection = camera.values.slice(0, 16);
  const eye = camera.values.slice(24, 27);
  const projectedOutlines = boxes.filter(box => box.kind === 'grout').map((box, wall) => {
    const along = wall === 0 ? 0 : 2, face = wall === 0 ? 2 : 0;
    const a = [...box.max], b = [...box.max];
    a[along] = box.min[along];
    a[face] = b[face] = box.max[face];
    return projectMirrorSegment([a, b], -1.025, projection, base.width, base.height);
  });
  const outlineSegments = projectedOutlines.filter(segment => segment !== null);
  const groups = Object.fromEntries(['grout', 'contact', 'tile', 'upper-edge'].map((name) => [name,
    { eligible: 0, missed: 0, mismatched: 0, unavailable: 0, witnesses: [] }]));
  const outsideSilhouette = { eligible: 0, falseHits: 0, witnesses: [],
    upperEdge: { segments: outlineSegments, unprojectableSegments: projectedOutlines.length - outlineSegments.length,
      falseHitsWithin16Pixels: 0, maximumReceiverPixelDistance: 0, witness: null } };
  const occludedFaces = { count: 0, witnesses: [] };
  let receiverNormalMaxDeviation = 0;
  for (let y = 0; y < traced.height; y++) for (let x = 0; x < traced.width; x++) {
    const pixel = y * 2 * base.width + x * 2, n = pixel * 4;
    if (normal.values[n + 1] < 0.999 || normal.values[n + 3] > maxRoughness) continue;
    receiverNormalMaxDeviation = Math.max(receiverNormalMaxDeviation,
      Math.abs(normal.values[n] * 2 - 1), Math.abs(normal.values[n + 1] * 2 - 2),
      Math.abs(normal.values[n + 2] * 2 - 1));
    const h = multiply(inverse, [(x * 2 + 0.5) / base.width * 2 - 1,
      1 - (y * 2 + 0.5) / base.height * 2, depth.values[pixel], 1]);
    const origin = h.slice(0, 3).map((v) => v / h[3]);
    // The roughness range also includes upward tile ledges on the walls.
    // This fixture oracle targets the paver top plane, not those receivers.
    if (Math.abs(origin[1] - (-1.1 + 0.15 / 2)) > 0.002) continue;
    const incident = origin.map((v, i) => (v - eye[i]) * (i === 1 ? -1 : 1));
    const length = Math.hypot(...incident), direction = incident.map((v) => v / length);
    let nearest = 12, hit, hitAxis = -1, hitSign = 0;
    for (const box of boxes) {
      let near = 0, far = nearest, nearAxis = -1, nearSign = 0;
      for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(direction[axis]) < 1e-8) {
          if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) far = -1;
        } else {
          const a = (box.min[axis] - origin[axis]) / direction[axis];
          const b = (box.max[axis] - origin[axis]) / direction[axis];
          const entry = Math.min(a, b);
          if (entry > near) { near = entry; nearAxis = axis; nearSign = a < b ? -1 : 1; }
          far = Math.min(far, Math.max(a, b));
        }
      }
      if (near > 0 && near <= far && near < nearest) {
        nearest = near; hit = box; hitAxis = nearAxis; hitSign = nearSign;
      }
    }
    if (!hit) {
      outsideSilhouette.eligible++;
      const t = (y * traced.width + x) * 4;
      if (traced.values[t + 3] > 0.001) {
        outsideSilhouette.falseHits++;
        if (outsideSilhouette.witnesses.length < 8) outsideSilhouette.witnesses.push({ receiver: [x * 2, y * 2], confidence: traced.values[t + 3] });
        const distance = Math.min(...outlineSegments.map(segment =>
          mirrorSegmentDistance([x * 2 + 0.5, y * 2 + 0.5], segment)));
        if (distance <= 16) {
          const upper = outsideSilhouette.upperEdge;
          upper.falseHitsWithin16Pixels++;
          if (distance > upper.maximumReceiverPixelDistance) {
            upper.maximumReceiverPixelDistance = distance;
            upper.witness = { receiver: [x * 2, y * 2], confidence: traced.values[t + 3], distance };
          }
        }
      }
      continue;
    }
    const target = origin.map((v, i) => v + direction[i] * nearest);
    const group = groups[target[1] < -0.8 ? 'contact' : target[1] > 2.7 ? 'upper-edge' : hit.kind];
    const clip = multiply(projection, [...target, 1]);
    const uv = [clip[0] / clip[3] * 0.5 + 0.5, 0.5 - clip[1] / clip[3] * 0.5];
    if (!uv.every((v) => v > 0.05 && v < 0.95)) { group.unavailable++; continue; }
    const sx = Math.floor(uv[0] * base.width), sy = Math.floor(uv[1] * base.height);
    const p = (sy * base.width + sx) * 4;
    // A physically correct mirror hit may be camera-occluded. SSR cannot
    // recover that surface; count it explicitly instead of calling it a miss.
    const sample = multiply(inverse, [...[uv[0] * 2 - 1, 1 - uv[1] * 2], depth.values[p / 4], 1]);
    if (Math.hypot(...target.map((v, i) => v - sample[i] / sample[3])) > 0.03) {
      group.unavailable++; continue;
    }
    // Nearby surfaces can have almost identical depth at the wall/floor
    // junction. A visible floor or tile front is not a captured wall or tile
    // underside. These fixture boxes have no normal maps, so the independent
    // slab-entry face must agree with the sampled G-buffer face as well.
    const sourceNormal = normal.values.slice(p, p + 3).map(v => v * 2 - 1);
    const normalLength = Math.hypot(...sourceNormal);
    if (!(normalLength > 0 && sourceNormal[hitAxis] * hitSign / normalLength > 0.99)) {
      group.unavailable++;
      occludedFaces.count++;
      if (occludedFaces.witnesses.length < 8) occludedFaces.witnesses.push({
        receiver: [x * 2, y * 2], source: [sx, sy], target,
        expectedNormal: [0, 1, 2].map(axis => axis === hitAxis ? hitSign : 0), sourceNormal,
      });
      continue;
    }
    group.eligible++;
    const t = (y * traced.width + x) * 4;
    const confidence = traced.values[t + 3];
    const expected = colorFilter === 'nearest' ? base.values.slice(p, p + 3)
      : sampleLinearColor(base, uv, colorFilter === 'linear-admitted' ? pixel => {
        // An unavailable or back-facing camera sample is not radiance from
        // the reflected wall, even when a bilinear footprint overlaps it.
        const n = pixel * 4;
        return fallback.values[n + 3] > 0.5 && direction.reduce((sum, value, axis) =>
          sum - value * (normal.values[n + axis] * 2 - 1), 0) > 0;
      } : undefined);
    const error = Math.max(...[0, 1, 2].map((c) => Math.abs(traced.values[t + c] - expected[c])));
    if (confidence <= 0) group.missed++;
    else if (error > 0.1) group.mismatched++;
    if (confidence <= 0 || error > 0.1) {
      const witness = { receiver: [x * 2, y * 2], source: [sx, sy], target,
        confidence, error, expected, actual: traced.values.slice(t, t + 3) };
      // Keep complete misses inspectable even if earlier color differences
      // have already filled the bounded witness list.
      if (confidence <= 0) {
        group.witnesses.unshift(witness);
        group.witnesses.length = Math.min(group.witnesses.length, 8);
      } else if (group.witnesses.length < 8) group.witnesses.push(witness);
    }
  }
  return { oracle: 'finite wall boxes; upward receivers in explicit roughness range; depth and entering-face visibility',
    colorFilter, maxRoughness, receiverNormalMaxDeviation, groups, outsideSilhouette, occludedFaces };
}
