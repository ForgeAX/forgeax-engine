import { vec3 } from '@forgeax/engine/math';
import { closestTriangleSegment, createCollisionBvh } from './collision-bvh.js';

export function createCollision({ scene, geos, inst }, { cell = 48, minRadius = 0.3 } = {}) {
  const { groups, meshes, materials } = scene;
  const solid = (id) =>
    id >= 0 && !!materials[id] && (!!materials[id].glass || materials[id].blend === 'opaque');

  const ranges = groups.map((g) => {
    if (g.kind) return null;
    const m = meshes[g.m],
      slots = g.mats ?? m.slots,
      lod = m.lods[0],
      list = [];
    const max = geos[lod.g].index.length;
    let count = 0;
    for (const [slot, start, cnt] of lod.s) {
      if (!solid(slots[slot] ?? -1)) continue;
      const c = Math.min(start + cnt, max) - start;
      if (c > 0) {
        list.push(start, c);
        count += c;
      }
    }
    return count ? { geo: lod.g, c: m.c, h: m.h, list, count } : null;
  });

  const A = new Float64Array(12);
  function basis(i) {
    const x = inst.quat[i * 4],
      y = inst.quat[i * 4 + 1],
      z = inst.quat[i * 4 + 2],
      w = inst.quat[i * 4 + 3];
    const sx = inst.scl[i * 3],
      sy = inst.scl[i * 3 + 1],
      sz = inst.scl[i * 3 + 2];
    const x2 = x + x,
      y2 = y + y,
      z2 = z + z;
    const xx = x * x2,
      xy = x * y2,
      xz = x * z2,
      yy = y * y2,
      yz = y * z2,
      zz = z * z2,
      wx = w * x2,
      wy = w * y2,
      wz = w * z2;
    A[0] = (1 - (yy + zz)) * sx;
    A[1] = (xy - wz) * sy;
    A[2] = (xz + wy) * sz;
    A[3] = (xy + wz) * sx;
    A[4] = (1 - (xx + zz)) * sy;
    A[5] = (yz - wx) * sz;
    A[6] = (xz - wy) * sx;
    A[7] = (yz + wx) * sy;
    A[8] = (1 - (xx + yy)) * sz;
    A[9] = inst.pos[i * 3];
    A[10] = inst.pos[i * 3 + 1];
    A[11] = inst.pos[i * 3 + 2];
  }

  const instGroup = new Int32Array(inst.n).fill(-1);
  const big = [],
    cells = new Map();
  groups.forEach((g, gi) => {
    const R = ranges[gi];
    if (!R) return;
    const m = meshes[g.m];
    for (let i = g.o; i < g.o + g.n; i++) {
      const r =
        m.r *
        Math.max(
          Math.abs(inst.scl[i * 3]),
          Math.abs(inst.scl[i * 3 + 1]),
          Math.abs(inst.scl[i * 3 + 2]),
        );
      if (r < minRadius) continue;
      instGroup[i] = gi;
      if (r > cell - 1) {
        big.push(i);
        continue;
      }
      basis(i);

      const cx = A[9] + A[0] * m.c[0] + A[1] * m.c[1] + A[2] * m.c[2];
      const cz = A[11] + A[6] * m.c[0] + A[7] * m.c[1] + A[8] * m.c[2];
      const k = `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`;
      const list = cells.get(k);
      list ? list.push(i) : cells.set(k, [i]);
    }
  });

  function build(list) {
    let nv = 0,
      ni = 0;
    for (const i of list) {
      const R = ranges[instGroup[i]];
      nv += geos[R.geo].vc;
      ni += R.count;
    }
    if (!ni) return null;
    const P = new Float32Array(nv * 3),
      I = new Uint32Array(ni);
    let vo = 0,
      io = 0;
    for (const i of list) {
      const R = ranges[instGroup[i]],
        g = geos[R.geo],
        src = g.i16,
        st = g.stride >> 1,
        ix = g.index;
      basis(i);
      const c0 = R.c[0],
        c1 = R.c[1],
        c2 = R.c[2],
        h0 = R.h[0] / 32767,
        h1 = R.h[1] / 32767,
        h2 = R.h[2] / 32767;
      for (let v = 0, o = vo * 3; v < g.vc; v++, o += 3) {
        const x = c0 + src[v * st] * h0,
          y = c1 + src[v * st + 1] * h1,
          z = c2 + src[v * st + 2] * h2;
        P[o] = A[9] + A[0] * x + A[1] * y + A[2] * z;
        P[o + 1] = A[10] + A[3] * x + A[4] * y + A[5] * z;
        P[o + 2] = A[11] + A[6] * x + A[7] * y + A[8] * z;
      }
      for (let k = 0; k < R.list.length; k += 2) {
        for (let j = R.list[k], e = j + R.list[k + 1]; j < e; j++) I[io++] = vo + ix[j];
      }
      vo += g.vc;
    }
    return { bvh: createCollisionBvh(P, I), tris: ni / 3 };
  }

  const bigNode = build(big);
  const built = new Map();
  function get(cx, cz, force) {
    const k = `${cx},${cz}`;
    if (built.has(k)) return built.get(k);
    if (!force) return undefined;
    const list = cells.get(k);
    const node = list ? build(list) : null;
    built.set(k, node);
    return node;
  }

  const active = [];
  function around(x, z) {
    active.length = 0;
    if (bigNode) active.push(bigNode.bvh);
    const cx = Math.floor(x / cell),
      cz = Math.floor(z / cell);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const node = get(cx + dx, cz + dz, true);
        if (node) active.push(node.bvh);
      }
    return active;
  }

  function prefetch(x, z) {
    const cx = Math.floor(x / cell),
      cz = Math.floor(z / cell);
    let best = null,
      bd = Infinity;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const k = `${cx + dx},${cz + dz}`;
        if (built.has(k) || !cells.has(k)) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dz)) * 10 + Math.abs(dx) + Math.abs(dz);
        if (d < bd) {
          bd = d;
          best = [cx + dx, cz + dz];
        }
      }
    if (best) get(best[0], best[1], true);
    for (const k of built.keys()) {
      const [a, b] = k.split(',').map(Number);
      if (Math.max(Math.abs(a - cx), Math.abs(b - cz)) > 3) built.delete(k);
    }
    return !!best;
  }

  const box = new Float32Array(6),
    triPoint = vec3.create(),
    capPoint = vec3.create(),
    normal = vec3.create(),
    ab = vec3.create(),
    ac = vec3.create();
  function collide(seg, radius) {
    const list = around(seg.start[0], seg.start[2]);
    for (let axis = 0; axis < 3; axis++) {
      box[axis] = Math.min(seg.start[axis], seg.end[axis]) - radius;
      box[axis + 3] = Math.max(seg.start[axis], seg.end[axis]) + radius;
    }
    for (const bvh of list)
      bvh.query(box, (a, b, c) => {
        const distance = closestTriangleSegment(triPoint, capPoint, seg.start, seg.end, a, b, c);
        if (distance >= radius) return;
        if (distance > 1e-8) vec3.normalize(normal, vec3.sub(normal, capPoint, triPoint));
        else {
          vec3.cross(normal, vec3.sub(ab, b, a), vec3.sub(ac, c, a));
          vec3.normalize(normal, normal);
          const side =
            normal[0] * ((seg.start[0] + seg.end[0]) / 2 - a[0]) +
            normal[1] * ((seg.start[1] + seg.end[1]) / 2 - a[1]) +
            normal[2] * ((seg.start[2] + seg.end[2]) / 2 - a[2]);
          if (side < 0) vec3.negate(normal, normal);
        }
        for (let axis = 0; axis < 3; axis++) {
          const delta = normal[axis] * (radius - distance);
          seg.start[axis] += delta;
          seg.end[axis] += delta;
        }
      });
  }
  function raycast(origin, direction, far = Infinity) {
    let best = null;
    for (const bvh of around(origin[0], origin[2])) {
      const hit = bvh.raycast(origin, direction, far);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }
  const down = vec3.create(0, -1, 0),
    from = vec3.create();
  function groundAt(x, y, z, far = 500) {
    const hit = raycast(vec3.set(from, x, y, z), down, far);
    return hit ? hit.point[1] : null;
  }

  return {
    collide,
    raycast,
    groundAt,
    prefetch,
    cell,
    stats: () => ({
      cells: cells.size,
      built: [...built.values()].filter(Boolean).length,
      bigTris: bigNode ? bigNode.tris : 0,
      bigInstances: big.length,
      tris: [...built.values()].reduce((a, n) => a + (n ? n.tris : 0), 0),
    }),
  };
}
