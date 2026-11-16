import { frustum, mat4 } from '@forgeax/engine/math';
import {
  addCityGeometry,
  addCityInstance,
  createCityBatch,
  publishCityBatch,
  setCityVisibility,
} from './city-batches.js';

const FAR_SCREEN = 0.06,
  HYST = 1.15,
  SHADOW_MIN_R = 1.2;
const pause = () => new Promise((r) => setTimeout(r, 0));

export async function createWorld({ scene, geos, inst }, mats, onProgress = () => {}) {
  const { groups, meshes, materials: defs } = scene;
  const N = inst.n,
    { pos, quat, scl } = inst;

  const E = new Float64Array(16);
  function compose(i, m) {
    const x = quat[i * 4],
      y = quat[i * 4 + 1],
      z = quat[i * 4 + 2],
      w = quat[i * 4 + 3];
    const sx = scl[i * 3],
      sy = scl[i * 3 + 1],
      sz = scl[i * 3 + 2];
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
    const a0 = 1 - (yy + zz),
      a1 = xy + wz,
      a2 = xz - wy;
    const b0 = xy - wz,
      b1 = 1 - (xx + zz),
      b2 = yz + wx;
    const c0 = xz + wy,
      c1 = yz - wx,
      c2 = 1 - (xx + yy);
    const hx = sx * m.h[0],
      hy = sy * m.h[1],
      hz = sz * m.h[2],
      ox = sx * m.c[0],
      oy = sy * m.c[1],
      oz = sz * m.c[2];
    E[0] = a0 * hx;
    E[1] = a1 * hx;
    E[2] = a2 * hx;
    E[3] = 0;
    E[4] = b0 * hy;
    E[5] = b1 * hy;
    E[6] = b2 * hy;
    E[7] = 0;
    E[8] = c0 * hz;
    E[9] = c1 * hz;
    E[10] = c2 * hz;
    E[11] = 0;
    E[12] = pos[i * 3] + a0 * ox + b0 * oy + c0 * oz;
    E[13] = pos[i * 3 + 1] + a1 * ox + b1 * oy + c1 * oz;
    E[14] = pos[i * 3 + 2] + a2 * ox + b2 * oy + c2 * oz;
    E[15] = 1;
    return E;
  }

  const sph = new Float32Array(N * 4),
    mir = new Uint8Array(N);
  groups.forEach((g) => {
    const m = meshes[g.m];
    for (let i = g.o; i < g.o + g.n; i++) {
      compose(i, m);
      const sx = scl[i * 3],
        sy = scl[i * 3 + 1],
        sz = scl[i * 3 + 2];
      sph[i * 4] = E[12];
      sph[i * 4 + 1] = E[13];
      sph[i * 4 + 2] = E[14];
      sph[i * 4 + 3] = m.r * Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz));
      mir[i] = sx * sy * sz < 0 ? 1 : 0;
    }
  });

  const cache = new Map();
  function section(gi, si, start, count, flip) {
    const key = (gi * 64 + si) * 2 + flip;
    let s = cache.get(key);
    if (s) return s;
    const g = geos[gi],
      end = Math.min(start + count, g.index.length),
      ni = Math.max(end - start, 0);
    const remap = new Int32Array(g.vc).fill(-1),
      index = new Uint32Array(ni);
    let nv = 0;
    for (let j = start; j < end; j++) {
      const v = g.index[j];
      if (remap[v] < 0) remap[v] = nv++;
      index[j - start] = remap[v];
    }
    if (flip)
      for (let j = 0; j + 2 < ni; j += 3) {
        const t = index[j + 1];
        index[j + 1] = index[j + 2];
        index[j + 2] = t;
      }
    const position = new Int16Array(nv * 3),
      normal = new Int8Array(nv * 3),
      uv = new Float32Array(nv * 2);
    for (let v = 0; v < g.vc; v++) {
      const k = remap[v];
      if (k < 0) continue;
      const a = v * 10,
        b = v * 20,
        c = v * 5;
      position[k * 3] = g.i16[a];
      position[k * 3 + 1] = g.i16[a + 1];
      position[k * 3 + 2] = g.i16[a + 2];
      normal[k * 3] = g.i8[b + 8];
      normal[k * 3 + 1] = g.i8[b + 9];
      normal[k * 3 + 2] = g.i8[b + 10];
      for (let channel = 0; channel < 2; channel++) {
        const value = g.f32[c + 3 + channel];
        if (!Number.isFinite(value)) {
          if (!globalThis.__looty.assetRepairs)
            globalThis.__looty.assetRepairs = { nonFiniteUv: 0, examples: [] };
          const diagnostics = globalThis.__looty.assetRepairs;
          diagnostics.nonFiniteUv++;
          if (diagnostics.examples.length < 64)
            diagnostics.examples.push({
              geometry: gi,
              vertex: v,
              channel,
              value: String(value),
              rawBits: new Uint32Array(g.f32.buffer)[c + 3 + channel],
            });
          // Explicit import policy for malformed reference UVs. Preserve every
          // vertex/index and record each repaired lane; source bytes stay intact.
          uv[k * 2 + channel] = 0;
        } else uv[k * 2 + channel] = value;
      }
    }
    s = { key, position, normal, uv, index, nv, ni };
    cache.set(key, s);
    return s;
  }

  const batches = new Map();
  const batchOf = (id) =>
    batches.get(id) ??
    batches
      .set(id, {
        mat: id,
        keys: new Set(),
        verts: 0,
        idx: 0,
        inst: 0,
        geoIds: new Map(),
        shown: 0,
        mesh: null,
      })
      .get(id);
  const reserve = (b, s) => {
    if (!b.keys.has(s.key)) {
      b.keys.add(s.key);
      b.verts += s.nv;
      b.idx += s.ni;
    }
  };
  const shadowy = (id) => {
    const d = defs[id];
    return !!d && d.blend === 'opaque' && !d.foliage && !d.emissive && !d.glass;
  };
  const shadow = {
    mat: -2,
    keys: new Set(),
    verts: 0,
    idx: 0,
    inst: 0,
    geoIds: new Map(),
    mesh: null,
  };
  const decalMats = new Set();

  const plan = groups.map((g) => {
    const m = meshes[g.m],
      slots = g.mats ?? m.slots;
    let anyMir = false,
      anyReg = false,
      casters = 0;
    for (let i = g.o; i < g.o + g.n; i++) {
      if (mir[i]) anyMir = true;
      else anyReg = true;
      if (sph[i * 4 + 3] > SHADOW_MIN_R) casters++;
    }
    const lods = m.lods.map((lod) => {
      const out = [];
      lod.s.forEach(([slot, start, count], si) => {
        const id = slots[slot] ?? -1;
        if (id < 0 || mats.entry(id).dead || count <= 0) return;
        if (g.kind) decalMats.add(id);
        const b = batchOf(id);
        if (anyReg) reserve(b, section(lod.g, si, start, count, 0));
        if (anyMir) reserve(b, section(lod.g, si, start, count, 1));
        b.inst += g.n;
        out.push({ b, mat: id, g: lod.g, si, start, count, ids: new Int32Array(g.n) });
      });
      return out;
    });

    const sl = m.r >= 6 ? 0 : Math.min(1, m.lods.length - 1),
      sh = [];
    if (!g.kind && casters)
      m.lods[sl].s.forEach(([slot, start, count], si) => {
        if (!shadowy(slots[slot] ?? -1) || count <= 0) return;
        reserve(shadow, section(m.lods[sl].g, si, start, count, 0));
        shadow.inst += casters;
        sh.push({ g: m.lods[sl].g, si, start, count, ids: new Int32Array(g.n).fill(-1) });
      });
    return { lods, sh };
  });

  for (const b of batches.values()) {
    const e = mats.entry(b.mat),
      d = e.def;
    b.mesh = createCityBatch(e.material);
    b.mesh.receiveShadow = !(d.glass || d.blend === 'translucent' || d.blend === 'additive');
    if (e.transparent) b.mesh.renderOrder = 1;
    if (decalMats.has(b.mat) && !e.material.polygonOffset) {
      e.material.polygonOffset = true;
      e.material.polygonOffsetFactor = -1;
      e.material.polygonOffsetUnits = -2;
    }
  }
  const shadowMaterial = { colorWrite: false, depthWrite: false, visible: true, userData: {} };
  if (shadow.inst) {
    shadow.mesh = createCityBatch(shadowMaterial);
    shadow.mesh.visible = true;
  }

  function geometryId(b, s, full) {
    let id = b.geoIds.get(s.key);
    if (id !== undefined) return id;
    id = addCityGeometry(b.mesh, s, full);
    b.geoIds.set(s.key, id);
    return id;
  }

  let last = performance.now();
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi],
      m = meshes[g.m],
      p = plan[gi];
    for (const secs of p.lods)
      for (const sec of secs) {
        const mesh = sec.b.mesh;
        for (let i = g.o; i < g.o + g.n; i++) {
          const id = addCityInstance(
            mesh,
            geometryId(sec.b, section(sec.g, sec.si, sec.start, sec.count, mir[i]), true),
            compose(i, m),
          );
          sec.ids[i - g.o] = id;
        }
      }
    for (const sec of p.sh) {
      const gid = geometryId(shadow, section(sec.g, sec.si, sec.start, sec.count, 0), false);
      for (let i = g.o; i < g.o + g.n; i++) {
        if (sph[i * 4 + 3] <= SHADOW_MIN_R) continue;
        const id = addCityInstance(shadow.mesh, gid, compose(i, m));
        sec.ids[i - g.o] = id;
      }
    }
    if (performance.now() - last > 40) {
      onProgress(gi + 1, groups.length);
      await pause();
      last = performance.now();
    }
  }
  cache.clear();

  const cur = new Int8Array(N).fill(-1),
    tier = new Uint8Array(groups.length);
  const pm = mat4.create(),
    pl = frustum.create();
  let drawn = 0;

  function selectVisibleLod(O, prev, x, y, z, r, screen, nl) {
    for (let p = 0; p < 24; p += 4)
      if (pl[p] * x + pl[p + 1] * y + pl[p + 2] * z + pl[p + 3] < -r * 1.5) return -1;
    let lod = 0;
    for (let c = nl - 1; c >= 0; c--)
      if (O < screen[c]) {
        lod = c;
        break;
      }
    if (prev >= 0 && prev !== lod) {
      const finer = lod < prev,
        t = finer ? screen[prev] * HYST : screen[lod] / HYST;
      if (finer ? O < t : O > t) lod = prev;
    }
    return lod;
  }

  function update(camera, { lodScale = 1, minScreen = 0.0035 } = {}) {
    mat4.multiply(pm, camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.fromViewProjection(pl, pm);
    const [cx, cy, cz] = camera.position;
    const f = lodScale / Math.tan((camera.fov * Math.PI) / 360);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi],
        lods = plan[gi].lods,
        screen = meshes[g.m].screen,
        nl = lods.length;
      for (let i = g.o, e = g.o + g.n; i < e; i++) {
        const k = i * 4,
          x = sph[k],
          y = sph[k + 1],
          z = sph[k + 2],
          r = sph[k + 3];
        const O = (r * f) / Math.max(Math.hypot(x - cx, y - cy, z - cz), 0.5);
        const prev = cur[i];
        const lod = O >= minScreen ? selectVisibleLod(O, prev, x, y, z, r, screen, nl) : -1;
        if (lod === prev) continue;
        const local = i - g.o;
        if (prev >= 0) {
          drawn--;
          for (const s of lods[prev]) {
            setCityVisibility(s.b.mesh, s.ids[local], false);
            s.b.shown--;
          }
        }
        if (lod >= 0) {
          drawn++;
          for (const s of lods[lod]) {
            setCityVisibility(s.b.mesh, s.ids[local], true);
            s.b.shown++;
          }
          const want = lod <= 1 && O >= FAR_SCREEN ? 2 : 1;
          if (tier[gi] < want) {
            tier[gi] = want;
            for (const s of lods[lod]) mats.want(s.mat, want, O);
          }
        }
        cur[i] = lod;
      }
    }
    for (const b of batches.values()) {
      b.mesh.visible = b.shown > 0;
      publishCityBatch(b.mesh);
    }
  }

  const lit = new Uint8Array(N);
  let casting = 0;
  function updateShadow(x, z, radius) {
    if (!shadow.mesh) return;
    for (let gi = 0; gi < groups.length; gi++) {
      const sh = plan[gi].sh;
      if (!sh.length) continue;
      const g = groups[gi];
      for (let i = g.o, e = g.o + g.n; i < e; i++) {
        const r = sph[i * 4 + 3];
        if (r <= SHADOW_MIN_R) continue;
        const on = Math.hypot(sph[i * 4] - x, sph[i * 4 + 2] - z) < radius + r ? 1 : 0;
        if (on === lit[i]) continue;
        lit[i] = on;
        casting += on ? 1 : -1;
        for (const s of sh) setCityVisibility(shadow.mesh, s.ids[i - g.o], !!on);
      }
    }
  }

  const updateWithShadow = updateShadow;
  return {
    update,
    updateShadow: (...args) => {
      updateWithShadow(...args);
      shadow.mesh && publishCityBatch(shadow.mesh);
    },
    stats: () => ({
      drawn,
      casting,
      batches: batches.size,
      shown: [...batches.values()].filter((b) => b.shown > 0).length,
    }),
    totals: {
      instances: [...batches.values()].reduce((a, b) => a + b.inst, 0),
      shadowInstances: shadow.inst,
      shadowVerts: shadow.verts,
    },
  };
}
