import { box3, ray, vec3 } from '@forgeax/engine/math';

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const a = vec3.create(),
  b = vec3.create(),
  c = vec3.create();
const ab = vec3.create(),
  ac = vec3.create(),
  ap = vec3.create(),
  bp = vec3.create(),
  cp = vec3.create();
function closestTriangle(out, point, x, y, z) {
  vec3.sub(ab, y, x);
  vec3.sub(ac, z, x);
  vec3.sub(ap, point, x);
  const d1 = vec3.dot(ab, ap),
    d2 = vec3.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return vec3.copy(out, x);
  vec3.sub(bp, point, y);
  const d3 = vec3.dot(ab, bp),
    d4 = vec3.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return vec3.copy(out, y);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    for (let i = 0; i < 3; i++) out[i] = x[i] + v * ab[i];
    return out;
  }
  vec3.sub(cp, point, z);
  const d5 = vec3.dot(ab, cp),
    d6 = vec3.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return vec3.copy(out, z);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    for (let i = 0; i < 3; i++) out[i] = x[i] + w * ac[i];
    return out;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    for (let i = 0; i < 3; i++) out[i] = y[i] + w * (z[i] - y[i]);
    return out;
  }
  return closestTriangleFace(out, x, va, vb, vc);
}

function closestTriangleFace(out, x, va, vb, vc) {
  const denominator = va + vb + vc;
  if (Math.abs(denominator) < 1e-20) return vec3.copy(out, x);
  const v = vb / denominator,
    w = vc / denominator;
  for (let i = 0; i < 3; i++) out[i] = x[i] + ab[i] * v + ac[i] * w;
  return out;
}
const edge0 = vec3.create(),
  edge1 = vec3.create(),
  separation = vec3.create();
function closestSegments(out0, out1, p0, p1, q0, q1) {
  vec3.sub(edge0, p1, p0);
  vec3.sub(edge1, q1, q0);
  vec3.sub(separation, p0, q0);
  const aa = vec3.dot(edge0, edge0),
    ee = vec3.dot(edge1, edge1),
    ff = vec3.dot(edge1, separation);
  let s = 0,
    t = 0;
  if (aa <= 1e-20 && ee <= 1e-20) {
    vec3.copy(out0, p0);
    vec3.copy(out1, q0);
    return;
  }
  if (aa <= 1e-20) t = clamp01(ff / ee);
  else {
    const cc = vec3.dot(edge0, separation);
    if (ee <= 1e-20) s = clamp01(-cc / aa);
    else {
      const bb = vec3.dot(edge0, edge1),
        denominator = aa * ee - bb * bb;
      s = denominator > 1e-20 ? clamp01((bb * ff - cc * ee) / denominator) : 0;
      t = (bb * s + ff) / ee;
      if (t < 0) {
        t = 0;
        s = clamp01(-cc / aa);
      } else if (t > 1) {
        t = 1;
        s = clamp01((bb - cc) / aa);
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    out0[i] = p0[i] + edge0[i] * s;
    out1[i] = q0[i] + edge1[i] * t;
  }
}
const candidate0 = vec3.create(),
  candidate1 = vec3.create(),
  segmentRay = new Float32Array(6),
  segmentDirection = vec3.create();
export function closestTriangleSegment(trianglePoint, segmentPoint, start, end, x, y, z) {
  vec3.sub(segmentDirection, end, start);
  const length = vec3.length(segmentDirection);
  if (length > 1e-12) {
    vec3.normalize(segmentDirection, segmentDirection);
    segmentRay.set(start);
    segmentRay.set(segmentDirection, 3);
    const hit = ray.rayTriangleIntersects(segmentRay, x, y, z);
    if (hit.hit && hit.t <= length) {
      for (let i = 0; i < 3; i++)
        trianglePoint[i] = segmentPoint[i] = start[i] + segmentDirection[i] * hit.t;
      return 0;
    }
  }
  closestTriangle(trianglePoint, start, x, y, z);
  vec3.copy(segmentPoint, start);
  let best = vec3.distanceSq(trianglePoint, start);
  closestTriangle(candidate0, end, x, y, z);
  let distance = vec3.distanceSq(candidate0, end);
  if (distance < best) {
    best = distance;
    vec3.copy(trianglePoint, candidate0);
    vec3.copy(segmentPoint, end);
  }
  for (const [u, v] of [
    [x, y],
    [y, z],
    [z, x],
  ]) {
    closestSegments(candidate0, candidate1, u, v, start, end);
    distance = vec3.distanceSq(candidate0, candidate1);
    if (distance < best) {
      best = distance;
      vec3.copy(trianglePoint, candidate0);
      vec3.copy(segmentPoint, candidate1);
    }
  }
  return Math.sqrt(best);
}

export function createCollisionBvh(positions, indices) {
  const triangleCount = indices.length / 3;
  const ids = Uint32Array.from({ length: triangleCount }, (_, i) => i);
  const bounds = new Float32Array(triangleCount * 6);
  for (let t = 0; t < triangleCount; t++)
    for (let axis = 0; axis < 3; axis++) {
      const x = positions[indices[t * 3] * 3 + axis],
        y = positions[indices[t * 3 + 1] * 3 + axis],
        z = positions[indices[t * 3 + 2] * 3 + axis];
      bounds[t * 6 + axis] = Math.min(x, y, z);
      bounds[t * 6 + axis + 3] = Math.max(x, y, z);
    }
  const nodes = [];
  function build(start, end) {
    const box = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = start; i < end; i++)
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis], bounds[ids[i] * 6 + axis]);
        box[axis + 3] = Math.max(box[axis + 3], bounds[ids[i] * 6 + axis + 3]);
      }
    const index = nodes.length,
      node = { box, start, end, left: -1, right: -1 };
    nodes.push(node);
    if (end - start <= 16) return index;
    let axis = 0;
    if (box[4] - box[1] > box[3] - box[0]) axis = 1;
    if (box[5] - box[2] > box[axis + 3] - box[axis]) axis = 2;
    const center = box[axis] + box[axis + 3];
    let left = start,
      right = end - 1;
    while (left <= right) {
      const base = ids[left] * 6;
      if (bounds[base + axis] + bounds[base + axis + 3] < center) left++;
      else {
        const temp = ids[left];
        ids[left] = ids[right];
        ids[right--] = temp;
      }
    }
    const middle = left === start || left === end ? (start + end) >>> 1 : left;
    node.left = build(start, middle);
    node.right = build(middle, end);
    return index;
  }
  build(0, triangleCount);
  const stack = [];
  function triangle(id) {
    for (let axis = 0; axis < 3; axis++) {
      a[axis] = positions[indices[id * 3] * 3 + axis];
      b[axis] = positions[indices[id * 3 + 1] * 3 + axis];
      c[axis] = positions[indices[id * 3 + 2] * 3 + axis];
    }
  }
  return {
    query(box, visitor) {
      stack.length = 0;
      stack.push(0);
      while (stack.length) {
        const node = nodes[stack.pop()];
        if (!box3.intersectsBox(box, node.box)) continue;
        if (node.left >= 0) {
          stack.push(node.left, node.right);
          continue;
        }
        for (let i = node.start; i < node.end; i++) {
          triangle(ids[i]);
          visitor(a, b, c);
        }
      }
    },
    raycast(origin, direction, far) {
      const input = ray.create(new Float32Array(6), origin, direction);
      let nearest = far,
        found = false;
      stack.length = 0;
      stack.push(0);
      while (stack.length) {
        const node = nodes[stack.pop()],
          test = ray.rayAabbIntersects(input, node.box);
        if (!test.hit || test.tmin > nearest) continue;
        if (node.left >= 0) {
          stack.push(node.left, node.right);
          continue;
        }
        for (let i = node.start; i < node.end; i++) {
          triangle(ids[i]);
          const hit = ray.rayTriangleIntersects(input, a, b, c);
          if (hit.hit && hit.t <= nearest) {
            nearest = hit.t;
            found = true;
          }
        }
      }
      return found
        ? {
            distance: nearest,
            point: vec3.create(
              origin[0] + direction[0] * nearest,
              origin[1] + direction[1] * nearest,
              origin[2] + direction[2] * nearest,
            ),
          }
        : null;
    },
    nodeCount: nodes.length,
  };
}
