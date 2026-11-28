import { ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { buildGpuBakeBvhGroups } from '@forgeax/modeling-kernel';
import { maxOf, minOf } from '../arrays';
import { atan2, hypot3 } from '../dmath';
import type { ModelingError } from '../errors';
import { cross, dot, length, type Tuple3 } from '../geom';
import { NONE } from '../mesh';
import {
  type AtlasBleedReport,
  type AtlasGrid,
  atlasBleedReport,
  type DilateAtlasOptions,
  MIXED,
  mipBleed,
  prepareAtlasDilation,
  UNOWNED,
} from './atlas-ts';
import { averagedPart, FACING_MIN, rayDirection } from './bake-cage';
import {
  BAKE_TILE,
  encodeMaps,
  ensureGroupBvhs,
  finishBake,
  gridOf,
  guided,
  mapBackground,
  type PreparedBake,
} from './bake-ts';
import { withBakeGpuBuffers } from './bake-webgpu';
import type {
  BackendOutput,
  BakeDirection,
  BakeHandedness,
  BakeMapKind,
  BakeStack,
  WorkMeter,
} from './job';

const STORAGE = 0x80;
const UNIFORM = 0x40;
const COPY_SRC = 0x4;
const COPY_DST = 0x8;
const MAP_READ = 0x1;

const WORKGROUP_1D = 64;
const WORKGROUP_2D = 8;
const OWN_SIDE_COS = 0.5;
const STACK_ANGLE = 5;
const STACK_HEIGHT = 0.02;
const GROUP_COUNTERS = 5;

const MAP_KIND_ID: Readonly<Partial<Record<BakeMapKind, number>>> = {
  normal: 0,
  normalObject: 1,
  height: 2,
  position: 3,
  curvature: 4,
  cavity: 4,
  edgeWear: 4,
  ormh: 5,
  baseColor: 6,
  emissive: 7,
  materialId: 8,
  ao: 9,
};

const ENCODE_KIND_ID: Readonly<Partial<Record<BakeMapKind, number>>> = {
  normal: 0,
  normalObject: 0,
  height: 1,
  position: 2,
  curvature: 3,
  edgeWear: 4,
  cavity: 5,
  ao: 6,
  ormh: 7,
  baseColor: 8,
  emissive: 9,
  materialId: 10,
};

const CORRESPOND_WGSL = /* wgsl */ `
const FACING_MIN: f32 = ${FACING_MIN};
const OWN_SIDE_COS: f32 = ${OWN_SIDE_COS};
const EDGE_SLACK: f32 = 1e-6;

struct Config {
  width: u32,
  height: u32,
  activeCount: u32,
  mapCount: u32,
  slotOffset: u32,
  rayOffset: u32,
  aoRays: u32,
  flags: u32, // bit 0: rawCage, bit 1: needAo
  aoEps: f32,
  noiseScale: f32,
  noiseSeed: i32,
  texels: u32,
  mapKinds0: vec4<u32>,
  mapKinds1: vec4<u32>,
}

struct Node {
  low: vec3<f32>,
  first: i32,
  high: vec3<f32>,
  endAndCount: u32,
}

struct BakeTri {
  a: vec3<f32>,
  triId: u32,
  e1: vec3<f32>,
  flags: u32, // bit 0: floater, bit 1: stray
  e2: vec3<f32>,
  slot: u32,
  faceN: vec3<f32>,
  pad: u32,
}

struct BakeTriNormals {
  n0: vec4<f32>,
  n1: vec4<f32>,
  n2: vec4<f32>,
}

struct ActiveTexel {
  posGroup: vec4<f32>,    // xyz = pos, w = bitcast<f32>(group)
  nrmFlags: vec4<f32>,    // xyz = nrm, w = bitcast<f32>(averaged)
  cageIsland: vec4<f32>,  // xyz = cage, w = bitcast<f32>(island)
  tanHand: vec4<f32>,     // xyz = tan, w = handedness
  info: vec4<u32>,        // x = texelIndex
}

struct Guide {
  point: vec3<f32>,
  weight: f32,
  normal: vec3<f32>,
  chart: i32,
}

struct HitRecord {
  q_height: vec4<f32>,
  nd_tri: vec4<f32>,
  slot_g_flags: vec4<u32>,
}

@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> tris: array<BakeTri>;
@group(0) @binding(3) var<storage, read> triNormals: array<BakeTriNormals>;
@group(0) @binding(4) var<storage, read> metaBuf: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> activeTexels: array<ActiveTexel>;
@group(0) @binding(6) var<storage, read_write> guides: array<Guide>;
@group(0) @binding(7) var<storage, read_write> sampled: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> hitsBuf: array<HitRecord>;

fn mapKind(m: u32) -> u32 {
  if (m < 4u) { return cfg.mapKinds0[m]; }
  return cfg.mapKinds1[m - 4u];
}

fn intersectBox(node: Node, o: vec3<f32>, d: vec3<f32>, limit: f32) -> bool {
  var near = 0.0;
  var far = limit + limit * 1e-5 + 1e-6;
  for (var i = 0u; i < 3u; i++) {
    if (abs(d[i]) <= 1e-20) {
      if (o[i] < node.low[i] || o[i] > node.high[i]) { return false; }
    } else {
      let lo = (node.low[i] - o[i]) / d[i];
      let hi = (node.high[i] - o[i]) / d[i];
      near = max(near, min(lo, hi));
      far = min(far, max(lo, hi));
    }
  }
  return near <= far;
}

fn boxDistSq(node: Node, p: vec3<f32>) -> f32 {
  let d = max(max(node.low - p, p - node.high), vec3<f32>(0.0));
  return dot(d, d);
}

struct HitResult {
  hit: bool,
  triIdx: u32,
  triId: u32,
  t: f32,
  u: f32,
  v: f32,
}

fn raycastFacing(root: i32, o: vec3<f32>, d: vec3<f32>, maxT: f32, facingDir: vec3<f32>, anyHit: bool) -> HitResult {
  var res = HitResult(false, 0u, 0xffffffffu, maxT, 0.0, 0.0);
  if (root < 0) { return res; }
  var i = u32(root);
  let end = nodes[i].endAndCount >> 4u;
  while (i < end) {
    let node = nodes[i];
    if (!intersectBox(node, o, d, res.t)) {
      i = node.endAndCount >> 4u;
      continue;
    }
    if (node.first < 0) {
      let start = u32(-1 - node.first);
      let count = node.endAndCount & 15u;
      for (var k = 0u; k < count; k++) {
        let ti = start + k;
        let tri = tris[ti];
        if (dot(tri.faceN, facingDir) <= FACING_MIN) { continue; }
        let p = cross(d, tri.e2);
        let det = dot(tri.e1, p);
        if (det == 0.0) { continue; }
        let inv = 1.0 / det;
        let s = o - tri.a;
        let u = dot(s, p) * inv;
        if (u < -EDGE_SLACK || u > 1.0 + EDGE_SLACK) { continue; }
        let q = cross(s, tri.e1);
        let v = dot(d, q) * inv;
        if (v < -EDGE_SLACK || u + v > 1.0 + EDGE_SLACK) { continue; }
        let t = dot(tri.e2, q) * inv;
        if (t >= 0.0 && (t < res.t || (t == res.t && (!res.hit || tri.triId < res.triId)))) {
          let cu = clamp(u, 0.0, 1.0);
          let cv = clamp(v, 0.0, 1.0 - cu);
          res = HitResult(true, ti, tri.triId, t, cu, cv);
          if (anyHit) { return res; }
        }
      }
    }
    i++;
  }
  return res;
}

fn closestOnTri(tri: BakeTri, p: vec3<f32>) -> vec3<f32> {
  let a = tri.a;
  let ab = tri.e1;
  let ac = tri.e2;
  let ap = p - a;
  let d1 = dot(ab, ap);
  let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) {
    let q = a - p;
    return vec3<f32>(0.0, 0.0, dot(q, q));
  }
  let bp = p - (a + ab);
  let d3 = dot(ab, bp);
  let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) {
    let q = a + ab - p;
    return vec3<f32>(1.0, 0.0, dot(q, q));
  }
  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    let u = d1 / (d1 - d3);
    let q = a + u * ab - p;
    return vec3<f32>(u, 0.0, dot(q, q));
  }
  let cp = p - (a + ac);
  let d5 = dot(ab, cp);
  let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) {
    let q = a + ac - p;
    return vec3<f32>(0.0, 1.0, dot(q, q));
  }
  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    let v = d2 / (d2 - d6);
    let q = a + v * ac - p;
    return vec3<f32>(0.0, v, dot(q, q));
  }
  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
    let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    let u = 1.0 - w;
    let v = w;
    let q = a + u * ab + v * ac - p;
    return vec3<f32>(u, v, dot(q, q));
  }
  let denom = va + vb + vc;
  if (!(denom > 0.0)) {
    let q = a - p;
    return vec3<f32>(0.0, 0.0, dot(q, q));
  }
  let u = vb / denom;
  let v = vc / denom;
  let q = a + u * ab + v * ac - p;
  return vec3<f32>(u, v, dot(q, q));
}

fn nearestInBvh(root: i32, p: vec3<f32>, facingDir: vec3<f32>, checkFacing: bool) -> HitResult {
  var res = HitResult(false, 0u, 0xffffffffu, 1e30, 0.0, 0.0);
  if (root < 0) { return res; }
  var stackNode: array<u32, 64>;
  var stackDist: array<f32, 64>;
  var sp: i32 = 0;
  stackNode[0] = u32(root);
  stackDist[0] = boxDistSq(nodes[u32(root)], p);
  sp = 1;
  while (sp > 0) {
    sp -= 1;
    let ni = stackNode[sp];
    let nd = stackDist[sp];
    if (res.hit && nd > res.t + res.t * 1e-5 + 1e-7) { continue; }
    let node = nodes[ni];
    if (node.first < 0) {
      let start = u32(-1 - node.first);
      let count = node.endAndCount & 15u;
      for (var k = 0u; k < count; k++) {
        let ti = start + k;
        let tri = tris[ti];
        if (checkFacing && dot(tri.faceN, facingDir) <= FACING_MIN) { continue; }
        let uvD = closestOnTri(tri, p);
        if (!res.hit || uvD.z < res.t || (uvD.z == res.t && tri.triId < res.triId)) {
          res = HitResult(true, ti, tri.triId, uvD.z, uvD.x, uvD.y);
        }
      }
    } else {
      let leftIdx = ni + 1u;
      let rightIdx = nodes[leftIdx].endAndCount >> 4u;
      let dl = boxDistSq(nodes[leftIdx], p);
      let dr = boxDistSq(nodes[rightIdx], p);
      if (dl <= dr) {
        if (sp < 62) {
          stackNode[sp] = rightIdx; stackDist[sp] = dr; sp += 1;
          stackNode[sp] = leftIdx;  stackDist[sp] = dl; sp += 1;
        }
      } else {
        if (sp < 62) {
          stackNode[sp] = leftIdx;  stackDist[sp] = dl; sp += 1;
          stackNode[sp] = rightIdx; stackDist[sp] = dr; sp += 1;
        }
      }
    }
  }
  return res;
}

fn traceAoDistance(root: i32, o: vec3<f32>, d: vec3<f32>, reach: f32) -> f32 {
  var limit = reach;
  var i = u32(root);
  let end = nodes[i].endAndCount >> 4u;
  while (i < end) {
    let node = nodes[i];
    if (!intersectBox(node, o, d, limit)) {
      i = node.endAndCount >> 4u;
      continue;
    }
    if (node.first < 0) {
      let start = u32(-1 - node.first);
      let count = node.endAndCount & 15u;
      for (var k = 0u; k < count; k++) {
        let tri = tris[start + k];
        let p = cross(d, tri.e2);
        let det = dot(tri.e1, p);
        if (det == 0.0) { continue; }
        let inv = 1.0 / det;
        let s = o - tri.a;
        let u = dot(s, p) * inv;
        if (u < 0.0 || u > 1.0) { continue; }
        let q = cross(s, tri.e1);
        let v = dot(d, q) * inv;
        if (v < 0.0 || u + v > 1.0) { continue; }
        let t = dot(tri.e2, q) * inv;
        if (t >= 0.0 && t < limit) { limit = t; }
      }
    }
    i++;
  }
  return limit;
}

fn interpNormal(triIdx: u32, u: f32, v: f32) -> vec3<f32> {
  let tn = triNormals[triIdx];
  let w0 = 1.0 - u - v;
  let n = tn.n0.xyz * w0 + tn.n1.xyz * u + tn.n2.xyz * v;
  let len = length(n);
  return select(vec3<f32>(0.0, 0.0, 1.0), n / len, len > 0.0);
}

fn helperBasisX(n: vec3<f32>) -> vec3<f32> {
  let a = abs(n);
  let h = select(
    select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 0.0), a.y <= a.z),
    vec3<f32>(1.0, 0.0, 0.0),
    a.x <= a.y && a.x <= a.z,
  );
  return normalize(cross(h, n));
}

fn tangentNormal(nd: vec3<f32>, n: vec3<f32>, tanHand: vec4<f32>) -> vec3<f32> {
  var t0 = tanHand.xyz - n * dot(tanHand.xyz, n);
  let tLen = length(t0);
  if (tLen > 0.0) {
    t0 = t0 / tLen;
  } else {
    t0 = helperBasisX(n);
  }
  let b = cross(n, t0);
  let handed = select(tanHand.w, 1.0, tanHand.w == 0.0);
  let tn = vec3<f32>(dot(nd, t0), dot(nd, b) / handed, dot(nd, n));
  let len = length(tn);
  return select(vec3<f32>(0.0, 0.0, 1.0), tn / len, len > 0.0);
}

fn hash3(x: i32, y: i32, z: i32, seed: i32) -> f32 {
  var h = (bitcast<u32>(x) * 0x27d4eb2du) ^
          (bitcast<u32>(y) * 0x165667b1u) ^
          (bitcast<u32>(z) * 0x9e3779b1u) ^
          (bitcast<u32>(seed) * 0x85ebca77u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  return f32(h ^ (h >> 16u)) * (1.0 / 4294967296.0);
}

fn valueNoise3(p: vec3<f32>, scale: f32, seed: i32) -> f32 {
  let s = p / scale;
  let fl = floor(s);
  let ix = i32(fl.x);
  let iy = i32(fl.y);
  let iz = i32(fl.z);
  let f = s - fl;
  let u = f * f * (vec3<f32>(3.0) - 2.0 * f);
  let c000 = hash3(ix,     iy,     iz,     seed);
  let c100 = hash3(ix + 1, iy,     iz,     seed);
  let c010 = hash3(ix,     iy + 1, iz,     seed);
  let c110 = hash3(ix + 1, iy + 1, iz,     seed);
  let c001 = hash3(ix,     iy,     iz + 1, seed);
  let c101 = hash3(ix + 1, iy,     iz + 1, seed);
  let c011 = hash3(ix,     iy + 1, iz + 1, seed);
  let c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  let p0 = mix(mix(c000, c100, u.x), mix(c010, c110, u.x), u.y);
  let p1 = mix(mix(c001, c101, u.x), mix(c011, c111, u.x), u.y);
  return mix(p0, p1, u.z);
}

fn turnAngle(texelIdx: u32) -> f32 {
  var h = (texelIdx * 16u * 0x27d4eb2du) ^ 0x9c5cd5d7u;
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  return f32(h ^ (h >> 16u)) * (6.283185307179586 / 4294967296.0);
}

fn resolveCorrespond(at: ActiveTexel) -> HitRecord {
  let p = at.posGroup.xyz;
  let g = bitcast<i32>(at.posGroup.w);
  let n = at.nrmFlags.xyz;
  let averaged = bitcast<u32>(at.nrmFlags.w) != 0u;
  let cage = at.cageIsland.xyz;

  let gMeta0 = metaBuf[u32(g) * 2u];
  let root = bitcast<i32>(gMeta0.x);
  let solidRoot = bitcast<i32>(gMeta0.y);
  let offset = gMeta0.z;
  let maxRay = gMeta0.w;

  let cBase = u32(g) * 5u;
  atomicAdd(&counters[cBase], 1u);

  var c = cage;
  var origin = p + c * offset;
  var found = raycastFacing(root, origin, -c, maxRay, c, false);
  var rayHit = found.hit;
  var q = vec3<f32>(0.0);
  if (found.hit) {
    q = origin - c * found.t;
  } else {
    found = nearestInBvh(root, p, c, true);
    if (!found.hit) {
      found = nearestInBvh(root, p, c, false);
    }
    let tri = tris[found.triIdx];
    q = tri.a + tri.e1 * found.u + tri.e2 * found.v;
  }

  if (averaged && rayHit && (cfg.flags & 1u) == 0u) {
    let nd0 = interpNormal(found.triIdx, found.u, found.v);
    let turned = dot(nd0, n);
    if (turned < OWN_SIDE_COS) {
      let ownOrigin = p + n * offset;
      let own = raycastFacing(root, ownOrigin, -n, maxRay, n, false);
      if (own.hit) {
        let ndOwn = interpNormal(own.triIdx, own.u, own.v);
        if (dot(ndOwn, n) > turned) {
          found = own;
          c = n;
          q = ownOrigin - n * own.t;
        }
      }
    }
  }

  if (rayHit) {
    atomicAdd(&counters[cBase + 1u], 1u);
  } else {
    atomicAdd(&counters[cBase + 2u], 1u);
  }

  let cageOrigin = p + cage * offset;
  let clipAbove = raycastFacing(root, cageOrigin, cage, maxRay, cage, true);
  var isClipped = clipAbove.hit;
  if (!isClipped && !rayHit) {
    let cageEnd = cageOrigin - cage * maxRay;
    let clipBelow = raycastFacing(root, cageEnd, -cage, maxRay, cage, true);
    isClipped = clipBelow.hit;
  }
  if (isClipped) {
    atomicAdd(&counters[cBase + 3u], 1u);
  }

  let tri = tris[found.triIdx];
  if ((tri.flags & 2u) != 0u) {
    atomicAdd(&counters[cBase + 4u], 1u);
  }

  let nd = interpNormal(found.triIdx, found.u, found.v);

  var heightVal = dot(q - p, c);
  if ((tri.flags & 1u) != 0u) {
    let solidOrigin = p + c * offset;
    var solidHit = raycastFacing(solidRoot, solidOrigin, -c, maxRay, c, false);
    if (solidHit.hit) {
      let sq = solidOrigin - c * solidHit.t;
      heightVal = dot(sq - p, c);
    } else {
      solidHit = nearestInBvh(solidRoot, p, c, true);
      if (!solidHit.hit) { solidHit = nearestInBvh(solidRoot, p, c, false); }
      if (solidHit.hit) {
        let stri = tris[solidHit.triIdx];
        let sq = stri.a + stri.e1 * solidHit.u + stri.e2 * solidHit.v;
        heightVal = dot(sq - p, c);
      } else {
        heightVal = 0.0;
      }
    }
  }
  var hitFlags = 0u;
  if (rayHit) { hitFlags |= 1u; }
  if (isClipped) { hitFlags |= 2u; }
  if ((tri.flags & 2u) != 0u) { hitFlags |= 4u; }
  return HitRecord(
    vec4<f32>(q, heightVal),
    vec4<f32>(nd, bitcast<f32>(found.triIdx)),
    vec4<u32>(tri.slot, u32(g), hitFlags, 0u),
  );
}

fn evaluateHit(at: ActiveTexel, hr: HitRecord) {
  let texel = at.info.x;
  let n = at.nrmFlags.xyz;
  let island = bitcast<i32>(at.cageIsland.w);
  let tanHand = at.tanHand;
  let q = hr.q_height.xyz;
  let heightVal = hr.q_height.w;
  let nd = hr.nd_tri.xyz;
  let slotId = hr.slot_g_flags.x;
  let g = hr.slot_g_flags.y;

  let gMeta0 = metaBuf[g * 2u];
  let gMeta1 = metaBuf[g * 2u + 1u];
  let solidRoot = bitcast<i32>(gMeta0.y);
  let aoReach = gMeta1.x;

  guides[texel] = Guide(q, 1.0, nd, island);

  var aoVal = 1.0;
  if ((cfg.flags & 2u) != 0u && solidRoot >= 0 && cfg.aoRays > 0u) {
    let e1 = helperBasisX(nd);
    let e2 = cross(nd, e1);
    let aoO = q + nd * cfg.aoEps;
    let ang = turnAngle(texel);
    let ca = cos(ang);
    let sa = sin(ang);
    var sum = 0.0;
    for (var k = 0u; k < cfg.aoRays; k++) {
      let r = metaBuf[cfg.rayOffset + k];
      let d = e1 * (r.x * ca - r.y * sa) + e2 * (r.x * sa + r.y * ca) + nd * r.z;
      sum += traceAoDistance(solidRoot, aoO, d, aoReach) / aoReach;
    }
    aoVal = sum / f32(cfg.aoRays);
  }

  let slotBase = cfg.slotOffset + slotId * 4u;
  let slotBaseColor = metaBuf[slotBase];
  let slotEmissive = metaBuf[slotBase + 1u];
  let slotRm = metaBuf[slotBase + 2u];
  let slotMatId = metaBuf[slotBase + 3u];

  for (var m = 0u; m < cfg.mapCount; m++) {
    let kind = mapKind(m);
    let outIdx = m * cfg.texels + texel;
    var val = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    if (kind == 0u) {
      let tn = tangentNormal(nd, n, tanHand);
      val = vec4<f32>(tn, 1.0);
    } else if (kind == 1u) {
      val = vec4<f32>(nd, 1.0);
    } else if (kind == 2u) {
      val = vec4<f32>(heightVal, 0.0, 0.0, 1.0);
    } else if (kind == 3u) {
      val = vec4<f32>(q, 1.0);
    } else if (kind == 4u) {
      let nv = valueNoise3(q, cfg.noiseScale, cfg.noiseSeed);
      val = vec4<f32>(0.0, nv, 0.0, 1.0);
    } else if (kind == 5u) {
      val = vec4<f32>(aoVal, slotRm.x, slotRm.y, heightVal);
    } else if (kind == 6u) {
      val = slotBaseColor;
    } else if (kind == 7u) {
      val = vec4<f32>(slotEmissive.xyz, 1.0);
    } else if (kind == 8u) {
      val = vec4<f32>(slotMatId.xyz, 1.0);
    } else if (kind == 9u) {
      val = vec4<f32>(aoVal, 0.0, 0.0, 1.0);
    }
    sampled[outIdx] = val;
  }
}

@compute @workgroup_size(${WORKGROUP_1D})
fn correspondAndAo(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= cfg.activeCount) { return; }
  let at = activeTexels[idx];
  let hr = resolveCorrespond(at);
  evaluateHit(at, hr);
}

@compute @workgroup_size(${WORKGROUP_1D})
fn correspondOnly(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= cfg.activeCount) { return; }
  hitsBuf[idx] = resolveCorrespond(activeTexels[idx]);
}

@compute @workgroup_size(${WORKGROUP_1D})
fn evalFromCorrespond(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= cfg.activeCount) { return; }
  evaluateHit(activeTexels[idx], hitsBuf[idx]);
}
`;

const FILTER_WGSL = /* wgsl */ `
struct FilterConfig {
  width: u32,
  height: u32,
  texels: u32,
  radius: i32,
  spline: u32,
  curvMap: i32,
  curvOutOffset: u32,
  pad1: u32,
  kind: vec4<u32>,
  rest: vec4<u32>,
}

struct Guide {
  point: vec3<f32>,
  weight: f32,
  normal: vec3<f32>,
  chart: i32,
}

@group(0) @binding(0) var<uniform> cfg: FilterConfig;
@group(0) @binding(1) var<storage, read> guides: array<Guide>;
@group(0) @binding(2) var<storage, read> sampled: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> scratch: array<f32>;
@group(0) @binding(4) var<storage, read_write> result: array<vec4<f32>>;

fn neighbor(p: vec2<i32>, chart: i32) -> i32 {
  if (any(p < vec2<i32>(0)) || p.x >= i32(cfg.width) || p.y >= i32(cfg.height)) {
    return -1;
  }
  let j = p.y * i32(cfg.width) + p.x;
  if (guides[j].weight <= 0.0 || guides[j].chart != chart) { return -1; }
  return j;
}

fn tag(map: u32) -> u32 {
  if (map < 4u) { return cfg.kind[map]; }
  return cfg.rest[map - 4u];
}

fn curvature(p: vec2<i32>, g: Guide) -> f32 {
  var sum = 0.0;
  var count = 0.0;
  let offsets = array(vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1));
  for (var n = 0u; n < 4u; n++) {
    let j = neighbor(p + offsets[n], g.chart);
    if (j < 0) { continue; }
    let dq = guides[j].point - g.point;
    let l2 = dot(dq, dq);
    if (l2 > 0.0) {
      sum += dot(guides[j].normal - g.normal, dq) / l2;
      count += 1.0;
    }
  }
  return sum / max(1.0, count);
}

fn denoise(p: vec2<i32>, g: Guide, base: u32, own: f32) -> f32 {
  var sum = 0.0;
  var total = 0.0;
  let r = cfg.radius;
  let reach = f32((r + 1) * (r + 1));
  for (var y = -r; y <= r; y++) {
    for (var x = -r; x <= r; x++) {
      let j = neighbor(p + vec2(x, y), g.chart);
      if (j < 0) { continue; }
      let agree = dot(g.normal, guides[j].normal);
      let fall = 1.0 - f32(x * x + y * y) / reach;
      if (agree <= 0.0 || fall <= 0.0) { continue; }
      let a2 = agree * agree;
      let a4 = a2 * a2;
      let w = fall * fall * a4 * a4;
      sum += w * (sampled[base + u32(j)].x / guides[j].weight);
      total += w;
    }
  }
  if (total > 0.0) { return sum / total; }
  return own;
}

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn prefilter(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let kind = tag(id.z);
  if (kind != 1u && kind != 2u) { return; }
  let i = id.y * cfg.width + id.x;
  let g = guides[i];
  if (g.weight <= 0.0) { return; }
  let base = id.z * cfg.texels;
  let p = vec2<i32>(id.xy);
  if (kind == 1u) {
    scratch[base + i] = curvature(p, g);
  } else {
    scratch[base + i] = denoise(p, g, base, sampled[base + i].x / g.weight);
  }
}

fn filteredValue(i: u32, base: u32, kind: u32) -> vec4<f32> {
  var channels = sampled[base + i] / guides[i].weight;
  if (kind == 1u || kind == 2u) { channels.x = scratch[base + i]; }
  return channels;
}

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn splineFilter(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  let g = guides[i];
  if (g.weight <= 0.0) { return; }
  let base = id.z * cfg.texels;
  let kind = tag(id.z);
  if (kind == 3u) {
    result[base + i] = sampled[base + i];
    return;
  }
  var finalVal: vec4<f32>;
  if (cfg.spline == 0u) {
    finalVal = filteredValue(i, base, kind);
  } else {
    var sum = vec4<f32>(0.0);
    var total = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let j = neighbor(vec2<i32>(id.xy) + vec2(x, y), g.chart);
        if (j < 0) { continue; }
        let n = guides[j].normal;
        if (u32(j) != i && dot(g.normal, g.normal) > 0.5 &&
            dot(n, n) > 0.5 && dot(g.normal, n) < 0.9396926207859084) { continue; }
        let w = select(1.0, 4.0, x == 0) * select(1.0, 4.0, y == 0);
        sum += w * filteredValue(u32(j), base, kind);
        total += w;
      }
    }
    finalVal = sum / total;
  }
  result[base + i] = finalVal;
  // Store |curvature| of the primary curvature map in scratch[curvOutOffset..+texels) for 4 MB readback
  if (i32(id.z) == cfg.curvMap) {
    scratch[cfg.curvOutOffset + i] = abs(finalVal.x);
  }
}
`;

const JFA_WGSL = /* wgsl */ `
struct JfaConfig {
  width: u32,
  height: u32,
  step: i32,
  gutter: u32,
}

struct Guide {
  point: vec3<f32>,
  weight: f32,
  normal: vec3<f32>,
  chart: i32,
}

@group(0) @binding(0) var<uniform> cfg: JfaConfig;
@group(0) @binding(1) var<storage, read> guides: array<Guide>;
@group(0) @binding(2) var<storage, read> seedIn: array<i32>;
@group(0) @binding(3) var<storage, read_write> seedOut: array<i32>;

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn jfaInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  seedOut[i] = select(-1, i32(i), guides[i].weight > 0.0);
}

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn jfaInitMask(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  seedOut[i] = select(-1, i32(i), seedIn[i] >= 0);
}

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn jfaStep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  let w = i32(cfg.width);
  let h = i32(cfg.height);
  let px = i32(id.x);
  let py = i32(id.y);
  var bestSeed = seedIn[i];
  var bestDist = 0x7fffffff;
  if (bestSeed >= 0) {
    let sx = bestSeed % w;
    let sy = bestSeed / w;
    let dx = px - sx;
    let dy = py - sy;
    bestDist = dx * dx + dy * dy;
  }
  let s = cfg.step;
  for (var oy = -1; oy <= 1; oy++) {
    let ny = py + oy * s;
    if (ny < 0 || ny >= h) { continue; }
    for (var ox = -1; ox <= 1; ox++) {
      let nx = px + ox * s;
      if (nx < 0 || nx >= w) { continue; }
      let cand = seedIn[u32(ny * w + nx)];
      if (cand < 0) { continue; }
      let sx = cand % w;
      let sy = cand / w;
      let dx = px - sx;
      let dy = py - sy;
      let d2 = dx * dx + dy * dy;
      if (d2 < bestDist || (d2 == bestDist && cand < bestSeed)) {
        bestDist = d2;
        bestSeed = cand;
      }
    }
  }
  seedOut[i] = bestSeed;
}
`;

const ENCODE_DILATE_U8_WGSL = /* wgsl */ `
struct EncodeConfig {
  width: u32,
  height: u32,
  texels: u32,
  mapCount: u32,
  gutterDistSq: u32,
  flags: u32, // bit 0: isFill, bit 1: hasJfa
  pad0: u32,
  pad1: u32,
  heightMin: f32,
  invHeightSpan: f32,
  invCurvRange: f32,
  ewNoiseAmt: f32,
  ew0: f32,
  ew1: f32,
  cav0: f32,
  cav1: f32,
  posMin: vec4<f32>,
  posExt: vec4<f32>,
  enc0: vec4<u32>,
  enc1: vec4<u32>,
  bg: array<vec4<f32>, 8>,
}

struct Guide {
  point: vec3<f32>,
  weight: f32,
  normal: vec3<f32>,
  chart: i32,
}

@group(0) @binding(0) var<uniform> cfg: EncodeConfig;
@group(0) @binding(1) var<storage, read> guides: array<Guide>;
@group(0) @binding(2) var<storage, read> filtered: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> valOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> srcOut: array<i32>;

fn encKind(m: u32) -> u32 {
  if (m < 4u) { return cfg.enc0[m]; }
  return cfg.enc1[m - 4u];
}

fn srgbChannel(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn smoothStepRange(a: f32, b: f32, x: f32) -> f32 {
  if (b <= a) { return select(0.0, 1.0, x >= b); }
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn encodePixel(v: vec4<f32>, kind: u32) -> vec4<f32> {
  if (kind == 0u) {
    let len = length(v.xyz);
    let n = select(vec3<f32>(0.0, 0.0, 1.0), v.xyz / len, len > 0.0);
    return vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0);
  }
  if (kind == 1u) {
    let h = clamp((v.x - cfg.heightMin) * cfg.invHeightSpan, 0.0, 1.0);
    return vec4<f32>(h, h, h, 1.0);
  }
  if (kind == 2u) {
    let px = select(0.5, (v.x - cfg.posMin.x) / cfg.posExt.x, cfg.posExt.x > 0.0);
    let py = select(0.5, (v.y - cfg.posMin.y) / cfg.posExt.y, cfg.posExt.y > 0.0);
    let pz = select(0.5, (v.z - cfg.posMin.z) / cfg.posExt.z, cfg.posExt.z > 0.0);
    return vec4<f32>(px, py, pz, 1.0);
  }
  if (kind == 3u) {
    let c = clamp(0.5 + 0.5 * v.x * cfg.invCurvRange, 0.0, 1.0);
    return vec4<f32>(c, c, c, 1.0);
  }
  if (kind == 4u) {
    let wear = smoothStepRange(cfg.ew0, cfg.ew1, v.x * cfg.invCurvRange) * (1.0 - cfg.ewNoiseAmt * v.y);
    return vec4<f32>(wear, wear, wear, 1.0);
  }
  if (kind == 5u) {
    let c = smoothStepRange(cfg.cav0, cfg.cav1, -v.x * cfg.invCurvRange);
    return vec4<f32>(c, c, c, 1.0);
  }
  if (kind == 6u) {
    return vec4<f32>(v.x, v.x, v.x, 1.0);
  }
  if (kind == 7u) {
    let h = clamp((v.w - cfg.heightMin) * cfg.invHeightSpan, 0.0, 1.0);
    return vec4<f32>(v.x, v.y, v.z, h);
  }
  if (kind == 8u) {
    return vec4<f32>(srgbChannel(v.x), srgbChannel(v.y), srgbChannel(v.z), clamp(v.w, 0.0, 1.0));
  }
  if (kind == 9u) {
    return vec4<f32>(v.x, v.y, v.z, 1.0);
  }
  // kind == 10u: materialId (sRGB)
  return vec4<f32>(srgbChannel(v.x), srgbChannel(v.y), srgbChannel(v.z), 1.0);
}

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn encodeCovered(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  let m = id.z;
  let kind = encKind(m);
  let outIdx = m * cfg.texels + i;
  let covered = guides[i].weight > 0.0;
  if (m == 0u) {
    srcOut[i] = select(-1, max(0, guides[i].chart), covered);
  }
  if (covered) {
    valOut[outIdx] = encodePixel(filtered[outIdx], kind);
  } else {
    var bgCol = cfg.bg[m];
    if (kind == 8u || kind == 10u) {
      bgCol = vec4<f32>(srgbChannel(bgCol.x), srgbChannel(bgCol.y), srgbChannel(bgCol.z), bgCol.w);
    }
    valOut[outIdx] = bgCol;
  }
}
`;

const DILATE_RING_WGSL = /* wgsl */ `
struct DilateConfig {
  width: u32,
  height: u32,
  texels: u32,
  rings: u32,
  categoricalMask: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<uniform> cfg: DilateConfig;
@group(0) @binding(1) var<storage, read> srcIn: array<i32>;
@group(0) @binding(2) var<storage, read_write> srcOut: array<i32>;
@group(0) @binding(3) var<storage, read> valIn: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> valOut: array<vec4<f32>>;

var<workgroup> tileSrcA: array<i32, 256>;
var<workgroup> tileSrcB: array<i32, 256>;
var<workgroup> tileValA: array<vec4<f32>, 256>;
var<workgroup> tileValB: array<vec4<f32>, 256>;

fn readSharedSrc(idx: u32, phase: u32) -> i32 {
  if ((phase & 1u) == 0u) { return tileSrcA[idx]; }
  return tileSrcB[idx];
}

fn readSharedVal(idx: u32, phase: u32) -> vec4<f32> {
  if ((phase & 1u) == 0u) { return tileValA[idx]; }
  return tileValB[idx];
}

fn writeShared(idx: u32, phase: u32, s: i32, v: vec4<f32>) {
  if ((phase & 1u) == 0u) {
    tileSrcB[idx] = s;
    tileValB[idx] = v;
  } else {
    tileSrcA[idx] = s;
    tileValA[idx] = v;
  }
}

@compute @workgroup_size(16, 16)
fn dilateRings(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let m = wid.z;
  let lx = lid.x;
  let ly = lid.y;
  let li = ly * 16u + lx;
  let px = i32(wid.x * 8u) + i32(lx) - 4;
  let py = i32(wid.y * 8u) + i32(ly) - 4;
  let inImg = px >= 0 && py >= 0 && px < i32(cfg.width) && py < i32(cfg.height);
  let gi = select(0u, u32(py) * cfg.width + u32(px), inImg);
  let mapOff = m * cfg.texels;
  tileSrcA[li] = select(-1, srcIn[gi], inImg);
  tileValA[li] = select(vec4<f32>(0.0), valIn[mapOff + gi], inImg);
  let categorical = (cfg.categoricalMask & (1u << m)) != 0u;

  for (var r = 0u; r < cfg.rings; r++) {
    workgroupBarrier();
    let curSrc = readSharedSrc(li, r);
    let curVal = readSharedVal(li, r);
    if (!inImg || curSrc >= 0) {
      writeShared(li, r, curSrc, curVal);
    } else {
      var nSrc: array<i32, 8>;
      var nIdx: array<u32, 8>;
      var nCnt = 0u;
      for (var dy = -1; dy <= 1; dy++) {
        let ny = i32(ly) + dy;
        if (ny < 0 || ny >= 16) { continue; }
        for (var dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) { continue; }
          let nx = i32(lx) + dx;
          if (nx < 0 || nx >= 16) { continue; }
          let ni = u32(ny * 16 + nx);
          let s = readSharedSrc(ni, r);
          if (s >= 0) {
            nSrc[nCnt] = s;
            nIdx[nCnt] = ni;
            nCnt += 1u;
          }
        }
      }
      if (nCnt == 0u) {
        writeShared(li, r, -1, curVal);
      } else {
        var dom = -1;
        var bestCount = 0u;
        for (var k = 0u; k < nCnt; k++) {
          let cand = nSrc[k];
          var c = 0u;
          for (var p = 0u; p <= k; p++) {
            if (nSrc[p] == cand) { c += 1u; }
          }
          if (c > bestCount) {
            bestCount = c;
            dom = cand;
          }
        }
        var sum = vec4<f32>(0.0);
        var hits = 0u;
        for (var k = 0u; k < nCnt; k++) {
          if (nSrc[k] != dom) { continue; }
          sum += readSharedVal(nIdx[k], r);
          hits += 1u;
          if (categorical) { break; }
        }
        writeShared(li, r, dom, sum / f32(hits));
      }
    }
  }
  workgroupBarrier();
  if (lx >= 4u && lx < 12u && ly >= 4u && ly < 12u && inImg) {
    let finalSrc = readSharedSrc(li, cfg.rings);
    let finalVal = readSharedVal(li, cfg.rings);
    if (m == 0u) {
      srcOut[gi] = finalSrc;
    }
    valOut[mapOff + gi] = finalVal;
  }
}
`;

const PACK_U8_WGSL = /* wgsl */ `
struct EncodeConfig {
  width: u32,
  height: u32,
  texels: u32,
  mapCount: u32,
  gutterDistSq: u32,
  flags: u32,
  pad0: u32,
  pad1: u32,
  heightMin: f32,
  invHeightSpan: f32,
  invCurvRange: f32,
  ewNoiseAmt: f32,
  ew0: f32,
  ew1: f32,
  cav0: f32,
  cav1: f32,
  posMin: vec4<f32>,
  posExt: vec4<f32>,
  enc0: vec4<u32>,
  enc1: vec4<u32>,
  bg: array<vec4<f32>, 8>,
}

@group(0) @binding(0) var<uniform> cfg: EncodeConfig;
@group(0) @binding(1) var<storage, read> srcChart: array<i32>;
@group(0) @binding(2) var<storage, read> dilated: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> seeds: array<i32>;
@group(0) @binding(4) var<storage, read_write> packedOut: array<u32>;

fn encKind(m: u32) -> u32 {
  if (m < 4u) { return cfg.enc0[m]; }
  return cfg.enc1[m - 4u];
}

fn srgbChannel(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn packRgba8(c: vec4<f32>) -> u32 {
  let r = u32(clamp(round(c.x * 255.0), 0.0, 255.0));
  let g = u32(clamp(round(c.y * 255.0), 0.0, 255.0));
  let b = u32(clamp(round(c.z * 255.0), 0.0, 255.0));
  let a = u32(clamp(round(c.w * 255.0), 0.0, 255.0));
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@compute @workgroup_size(${WORKGROUP_2D}, ${WORKGROUP_2D})
fn packU8(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  let m = id.z;
  let kind = encKind(m);
  let outIdx = m * cfg.texels + i;
  if (srcChart[i] >= 0) {
    packedOut[outIdx] = packRgba8(dilated[outIdx]);
    return;
  }
  var fallbackIdx: i32 = -1;
  if ((cfg.flags & 2u) != 0u) {
    let s = seeds[i];
    if (s >= 0) {
      if ((cfg.flags & 1u) != 0u) {
        fallbackIdx = s;
      } else {
        let sx = s % i32(cfg.width);
        let sy = s / i32(cfg.width);
        let dx = i32(id.x) - sx;
        let dy = i32(id.y) - sy;
        if (u32(dx * dx + dy * dy) <= cfg.gutterDistSq) {
          fallbackIdx = s;
        }
      }
    }
  }
  if (fallbackIdx >= 0) {
    packedOut[outIdx] = packRgba8(dilated[m * cfg.texels + u32(fallbackIdx)]);
    return;
  }
  var bgCol = cfg.bg[m];
  if (kind == 8u || kind == 10u) {
    bgCol = vec4<f32>(srgbChannel(bgCol.x), srgbChannel(bgCol.y), srgbChannel(bgCol.z), bgCol.w);
  }
  packedOut[outIdx] = packRgba8(bgCol);
}
`;

interface CachedGpuBakePipelines {
  readonly correspondLayout: GPUBindGroupLayout;
  readonly correspondPipeline: GPUComputePipeline;
  readonly correspondOnlyLayout: GPUBindGroupLayout;
  readonly correspondOnlyPipeline: GPUComputePipeline;
  readonly evalCorrespondLayout: GPUBindGroupLayout;
  readonly evalCorrespondPipeline: GPUComputePipeline;
  readonly filterLayout: GPUBindGroupLayout;
  readonly prefilterPipeline: GPUComputePipeline;
  readonly splineFilterPipeline: GPUComputePipeline;
  readonly jfaLayout: GPUBindGroupLayout;
  readonly jfaInitPipeline: GPUComputePipeline;
  readonly jfaInitMaskPipeline: GPUComputePipeline;
  readonly jfaStepPipeline: GPUComputePipeline;
  readonly encodeLayout: GPUBindGroupLayout;
  readonly encodePipeline: GPUComputePipeline;
  readonly dilateLayout: GPUBindGroupLayout;
  readonly dilatePipeline: GPUComputePipeline;
  readonly packLayout: GPUBindGroupLayout;
  readonly packPipeline: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, CachedGpuBakePipelines>();

function getGpuBakePipelines(device: GPUDevice): CachedGpuBakePipelines {
  const existing = pipelineCache.get(device);
  if (existing !== undefined) return existing;

  const storageEntry = (binding: number, readOnly: boolean): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: 4,
    buffer: { type: readOnly ? 'read-only-storage' : 'storage' },
  });
  const uniformEntry: GPUBindGroupLayoutEntry = {
    binding: 0,
    visibility: 4,
    buffer: { type: 'uniform' },
  };

  const correspondLayout = device.createBindGroupLayout({
    entries: [
      uniformEntry,
      storageEntry(1, true),
      storageEntry(2, true),
      storageEntry(3, true),
      storageEntry(4, true),
      storageEntry(5, true),
      storageEntry(6, false),
      storageEntry(7, false),
      storageEntry(8, false),
    ],
  });
  const correspondOnlyLayout = device.createBindGroupLayout({
    entries: [
      uniformEntry,
      storageEntry(1, true),
      storageEntry(2, true),
      storageEntry(3, true),
      storageEntry(4, true),
      storageEntry(5, true),
      storageEntry(8, false),
      storageEntry(9, false),
    ],
  });
  const evalCorrespondLayout = device.createBindGroupLayout({
    entries: [
      uniformEntry,
      storageEntry(1, true),
      storageEntry(2, true),
      storageEntry(4, true),
      storageEntry(5, true),
      storageEntry(6, false),
      storageEntry(7, false),
      storageEntry(9, false),
    ],
  });
  const correspondMod = device.createShaderModule({
    label: 'Modeling GPU correspond + AO baker',
    code: CORRESPOND_WGSL,
  });
  const correspondPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [correspondLayout] }),
    compute: { module: correspondMod, entryPoint: 'correspondAndAo' },
  });
  const correspondOnlyPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [correspondOnlyLayout] }),
    compute: { module: correspondMod, entryPoint: 'correspondOnly' },
  });
  const evalCorrespondPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [evalCorrespondLayout] }),
    compute: { module: correspondMod, entryPoint: 'evalFromCorrespond' },
  });

  const filterLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'storage' } },
      { binding: 4, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  const filterMod = device.createShaderModule({
    label: 'Modeling GPU bake filter',
    code: FILTER_WGSL,
  });
  const filterPipeLayout = device.createPipelineLayout({ bindGroupLayouts: [filterLayout] });
  const prefilterPipeline = device.createComputePipeline({
    layout: filterPipeLayout,
    compute: { module: filterMod, entryPoint: 'prefilter' },
  });
  const splineFilterPipeline = device.createComputePipeline({
    layout: filterPipeLayout,
    compute: { module: filterMod, entryPoint: 'splineFilter' },
  });

  const jfaLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  const jfaMod = device.createShaderModule({
    label: 'Modeling GPU JFA dilation',
    code: JFA_WGSL,
  });
  const jfaPipeLayout = device.createPipelineLayout({ bindGroupLayouts: [jfaLayout] });
  const jfaInitPipeline = device.createComputePipeline({
    layout: jfaPipeLayout,
    compute: { module: jfaMod, entryPoint: 'jfaInit' },
  });
  const jfaInitMaskPipeline = device.createComputePipeline({
    layout: jfaPipeLayout,
    compute: { module: jfaMod, entryPoint: 'jfaInitMask' },
  });
  const jfaStepPipeline = device.createComputePipeline({
    layout: jfaPipeLayout,
    compute: { module: jfaMod, entryPoint: 'jfaStep' },
  });

  const encodeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'storage' } },
      { binding: 4, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  const encodeMod = device.createShaderModule({
    label: 'Modeling GPU encode covered texels',
    code: ENCODE_DILATE_U8_WGSL,
  });
  const encodePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [encodeLayout] }),
    compute: { module: encodeMod, entryPoint: 'encodeCovered' },
  });

  const dilateLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  const dilateMod = device.createShaderModule({
    label: 'Modeling GPU tiled ring dilation',
    code: DILATE_RING_WGSL,
  });
  const dilatePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [dilateLayout] }),
    compute: { module: dilateMod, entryPoint: 'dilateRings' },
  });

  const packLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  const packMod = device.createShaderModule({
    label: 'Modeling GPU pack RGBA8',
    code: PACK_U8_WGSL,
  });
  const packPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [packLayout] }),
    compute: { module: packMod, entryPoint: 'packU8' },
  });

  const created: CachedGpuBakePipelines = {
    correspondLayout,
    correspondPipeline,
    correspondOnlyLayout,
    correspondOnlyPipeline,
    evalCorrespondLayout,
    evalCorrespondPipeline,
    filterLayout,
    prefilterPipeline,
    splineFilterPipeline,
    jfaLayout,
    jfaInitPipeline,
    jfaInitMaskPipeline,
    jfaStepPipeline,
    encodeLayout,
    encodePipeline,
    dilateLayout,
    dilatePipeline,
    packLayout,
    packPipeline,
  };
  pipelineCache.set(device, created);
  return created;
}

export interface GpuBakeCorrespondResult {
  readonly output: BackendOutput<'bake'>;
  readonly prepackedTextures?: Partial<Record<BakeMapKind, TextureAsset>>;
}

/**
 * Reusable WebGPU correspondence state computed once per `(base, detail, cage, resolution)`.
 * Stores the compact `ActiveTexel` descriptors, GPU `HitRecord` words (12 u32/f32 per active texel),
 * UV chart/island masks, audit counters, and cached flat BVH arrays so subsequent
 * `evaluateBakeMapsWithGpu` calls can iterate on AO, curvature/edgeWear, slots, or new map sets
 * without re-rasterizing UVs or repeating primary correspondence raycasts.
 */
export interface GpuCorrespondenceData {
  readonly prepared: PreparedBake;
  readonly width: number;
  readonly height: number;
  readonly texels: number;
  readonly activeCount: number;
  readonly activeF32: Float32Array;
  readonly hitsWords: Uint32Array;
  readonly weight: Float64Array;
  readonly island: Int32Array;
  readonly counters: Uint32Array;
  readonly stack: BakeStack;
  readonly handedness: BakeHandedness;
  readonly nodesU32: Uint32Array;
  readonly trisU32: Uint32Array;
  readonly triNormalsF32: Float32Array;
  readonly groupRoots: Int32Array;
  readonly groupSolidRoots: Int32Array;
}

function validateGpuEvalCapabilities(
  prepared: PreparedBake,
  device: GPUDevice,
  wantMips: boolean,
):
  | {
      readonly width: number;
      readonly height: number;
      readonly texels: number;
      readonly mapKindIds: number[];
      readonly encodeKindIds: number[];
      readonly canEmitU8Direct: boolean;
    }
  | undefined {
  const { params } = prepared;
  if (
    params.target !== 'texture' ||
    params.analytic !== undefined ||
    params.samples !== 1 ||
    params.maps.length === 0 ||
    params.maps.length > 8 ||
    !guided(params) ||
    params.ao.scope !== 'group' ||
    params.ao.floor !== undefined ||
    params.ao.attenuation !== 'linear' ||
    params.ao.rays > 64 ||
    device.limits.maxStorageBuffersPerShaderStage < 8
  ) {
    return undefined;
  }
  const grid = gridOf(params);
  if (grid.u || grid.v) return undefined;
  const mapKindIds: number[] = [];
  const encodeKindIds: number[] = [];
  let canEmitU8Direct = !wantMips;
  for (const kind of params.maps) {
    const id = MAP_KIND_ID[kind];
    const eid = ENCODE_KIND_ID[kind];
    if (id === undefined || eid === undefined) return undefined;
    if (kind === 'height' && params.height.bits === 16) canEmitU8Direct = false;
    mapKindIds.push(id);
    encodeKindIds.push(eid);
  }
  const { w: width, h: height } = grid;
  const texels = width * height;
  const atlasBytes = texels * 16 * params.maps.length;
  const guideBytes = texels * 32;
  if (
    Math.max(atlasBytes, guideBytes) > device.limits.maxStorageBufferBindingSize ||
    Math.ceil(width / WORKGROUP_2D) > device.limits.maxComputeWorkgroupsPerDimension ||
    Math.ceil(height / WORKGROUP_2D) > device.limits.maxComputeWorkgroupsPerDimension
  ) {
    return undefined;
  }
  return { width, height, texels, mapKindIds, encodeKindIds, canEmitU8Direct };
}

interface FlatGpuBvh {
  readonly nodesU32: Uint32Array;
  readonly trisU32: Uint32Array;
  readonly triNormalsF32: Float32Array;
  readonly groupRoots: Int32Array;
  readonly groupSolidRoots: Int32Array;
}

function buildFlatGpuBvh(prepared: PreparedBake, device: GPUDevice): FlatGpuBvh | undefined {
  const { baker, groups } = prepared;
  const gpu = baker._gpuInputs();
  const detailTriCount = gpu.detail.indices.length / 3;
  const combinedStray = new Uint8Array(detailTriCount);
  let totalGroupTris = 0;
  for (const g of groups) {
    totalGroupTris += g.map.length;
    if (g.solidMap !== g.map) totalGroupTris += g.solidMap.length;
    if (g.stray.length > 0) {
      for (let i = 0; i < g.stray.length; i++) {
        if ((g.stray[i] as number) !== 0) combinedStray[i] = 1;
      }
    }
  }
  const groupTris = new Uint32Array(totalGroupTris);
  const groupRanges = new Uint32Array(groups.length * 4);
  let cursor = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g === undefined) continue;
    const a0 = cursor;
    groupTris.set(g.map, cursor);
    cursor += g.map.length;
    const a1 = cursor;
    let s0 = a0;
    let s1 = a1;
    if (g.solidMap !== g.map) {
      s0 = cursor;
      groupTris.set(g.solidMap, cursor);
      cursor += g.solidMap.length;
      s1 = cursor;
    }
    groupRanges[gi * 4] = a0;
    groupRanges[gi * 4 + 1] = a1;
    groupRanges[gi * 4 + 2] = s0;
    groupRanges[gi * 4 + 3] = s1;
  }

  const wasmBvh = buildGpuBakeBvhGroups({
    positions: gpu.detail.position,
    normals: gpu.detail.normal,
    indices: gpu.detail.indices,
    slots: gpu.detail.triangleSlot,
    floater: gpu.floater,
    stray: combinedStray,
    groupTris,
    groupRanges,
  });

  if (wasmBvh !== undefined) {
    const nodesByteLen = wasmBvh.nodesU32.byteLength;
    const trisByteLen = wasmBvh.trisU32.byteLength;
    const triNormalsByteLen = wasmBvh.triNormalsF32.byteLength;
    if (
      nodesByteLen === 0 ||
      trisByteLen === 0 ||
      Math.max(nodesByteLen, trisByteLen, triNormalsByteLen) >
        device.limits.maxStorageBufferBindingSize
    ) {
      wasmBvh.release();
      return undefined;
    }
    const nodesU32 = wasmBvh.nodesU32.slice(0);
    const trisU32 = wasmBvh.trisU32.slice(0);
    const triNormalsF32 = wasmBvh.triNormalsF32.slice(0);
    const groupRoots = new Int32Array(groups.length);
    const groupSolidRoots = new Int32Array(groups.length);
    for (let g = 0; g < groups.length; g++) {
      groupRoots[g] = wasmBvh.groupRootsI32[g * 2] as number;
      groupSolidRoots[g] = wasmBvh.groupRootsI32[g * 2 + 1] as number;
    }
    wasmBvh.release();
    return { nodesU32, trisU32, triNormalsF32, groupRoots, groupSolidRoots };
  }

  ensureGroupBvhs(prepared);
  const jsNodesF32: number[] = [];
  const jsNodesI32Mask: number[] = [];
  const jsTrisF32: number[] = [];
  const jsTrisU32: number[] = [];
  const jsTriNormals: number[] = [];
  const groupRoots = new Int32Array(groups.length);
  const groupSolidRoots = new Int32Array(groups.length);
  for (const [gi, g] of groups.entries()) {
    const root = g.bvh._appendBakeTree(
      jsNodesF32,
      jsNodesI32Mask,
      jsTrisF32,
      jsTrisU32,
      jsTriNormals,
      g.map,
      gpu.detail,
      gpu.faceNormal,
      gpu.floater,
      g.stray,
    );
    const solidRoot =
      g.solid === g.bvh
        ? root
        : g.solid._appendBakeTree(
            jsNodesF32,
            jsNodesI32Mask,
            jsTrisF32,
            jsTrisU32,
            jsTriNormals,
            g.solidMap,
            gpu.detail,
            gpu.faceNormal,
            gpu.floater,
            g.stray,
          );
    groupRoots[gi] = root;
    groupSolidRoots[gi] = solidRoot;
  }
  const nodesByteLen = jsNodesF32.length * 4;
  const trisByteLen = jsTrisF32.length * 4;
  const triNormalsByteLen = jsTriNormals.length * 4;
  if (
    nodesByteLen === 0 ||
    trisByteLen === 0 ||
    Math.max(nodesByteLen, trisByteLen, triNormalsByteLen) >
      device.limits.maxStorageBufferBindingSize
  ) {
    return undefined;
  }
  const nodesF32 = new Float32Array(jsNodesF32);
  const nodesU32 = new Uint32Array(nodesF32.buffer);
  const nodesI32 = new Int32Array(nodesF32.buffer);
  for (let k = 0; k < jsNodesI32Mask.length; k += 2) {
    nodesI32[jsNodesI32Mask[k] as number] = jsNodesI32Mask[k + 1] as number;
  }
  const trisF32 = new Float32Array(jsTrisF32);
  const trisU32 = new Uint32Array(trisF32.buffer);
  for (let k = 0; k < jsTrisU32.length; k += 2) {
    trisU32[jsTrisU32[k] as number] = jsTrisU32[k + 1] as number;
  }
  const triNormalsF32 = new Float32Array(jsTriNormals);
  return { nodesU32, trisU32, triNormalsF32, groupRoots, groupSolidRoots };
}

function rasterizeBaseUv(
  prepared: PreparedBake,
  width: number,
  height: number,
  texels: number,
  device: GPUDevice,
):
  | {
      readonly activeCount: number;
      readonly activeF32: Float32Array;
      readonly weight: Float64Array;
      readonly island: Int32Array;
      readonly stack: BakeStack;
      readonly handedness: BakeHandedness;
    }
  | undefined {
  const { baker, triangles, directions, hard, encoding, atlas } = prepared;
  if (atlas === undefined) return undefined;
  const { surface: b, islands, tiles, bins } = atlas;
  const weight = new Float64Array(texels);
  const island = new Int32Array(texels).fill(NONE);
  const claimed = new Uint8Array(texels);
  const claimant = new Int32Array(texels);
  const [innerH, outerH] = encoding.heightRange;
  const heightTolerance = STACK_HEIGHT * (outerH - innerH);
  const stack = { samples: 0, conflicts: 0, maxAngle: 0, maxHeight: 0, face: -1 };
  const handedness = { samples: 0, face: -1 };
  let firstStackTexel = -1;

  const activeF32 = new Float32Array(texels * 20);
  const activeI32 = new Int32Array(activeF32.buffer);
  const activeU32 = new Uint32Array(activeF32.buffer);
  let activeCount = 0;

  const tileRows = Math.ceil(height / BAKE_TILE);
  const bIdx = b.indices;
  const bUv = b.uv;
  const bPos = b.position;
  const bNrm = b.normal;
  const bTan = b.tangent;
  const bFace = b.triangleFace;
  const triGroup = triangles.group;

  const surfaceAt = (t: number, w0: number, w1: number, w2: number) => {
    const i0 = bIdx[t * 3] as number;
    const i1 = bIdx[t * 3 + 1] as number;
    const i2 = bIdx[t * 3 + 2] as number;
    const px =
      w0 * (bPos[i0 * 3] as number) + w1 * (bPos[i1 * 3] as number) + w2 * (bPos[i2 * 3] as number);
    const py =
      w0 * (bPos[i0 * 3 + 1] as number) +
      w1 * (bPos[i1 * 3 + 1] as number) +
      w2 * (bPos[i2 * 3 + 1] as number);
    const pz =
      w0 * (bPos[i0 * 3 + 2] as number) +
      w1 * (bPos[i1 * 3 + 2] as number) +
      w2 * (bPos[i2 * 3 + 2] as number);
    let nx =
      w0 * (bNrm[i0 * 3] as number) + w1 * (bNrm[i1 * 3] as number) + w2 * (bNrm[i2 * 3] as number);
    let ny =
      w0 * (bNrm[i0 * 3 + 1] as number) +
      w1 * (bNrm[i1 * 3 + 1] as number) +
      w2 * (bNrm[i2 * 3 + 1] as number);
    let nz =
      w0 * (bNrm[i0 * 3 + 2] as number) +
      w1 * (bNrm[i1 * 3 + 2] as number) +
      w2 * (bNrm[i2 * 3 + 2] as number);
    const nLen = hypot3(nx, ny, nz);
    if (nLen > 0) {
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;
    }
    const tx =
      w0 * (bTan[i0 * 4] as number) + w1 * (bTan[i1 * 4] as number) + w2 * (bTan[i2 * 4] as number);
    const ty =
      w0 * (bTan[i0 * 4 + 1] as number) +
      w1 * (bTan[i1 * 4 + 1] as number) +
      w2 * (bTan[i2 * 4 + 1] as number);
    const tz =
      w0 * (bTan[i0 * 4 + 2] as number) +
      w1 * (bTan[i1 * 4 + 2] as number) +
      w2 * (bTan[i2 * 4 + 2] as number);
    const tw =
      w0 * (bTan[i0 * 4 + 3] as number) +
      w1 * (bTan[i1 * 4 + 3] as number) +
      w2 * (bTan[i2 * 4 + 3] as number);
    const g = triGroup[t] as number;
    const dir = directions[g] as BakeDirection;
    const pos: Tuple3 = [px, py, pz];
    const nrm: Tuple3 = [nx, ny, nz];
    const ray = dir === 'shading' ? nrm : rayDirection(triangles, t, [w0, w1, w2], dir, pos, hard);
    const avg = averagedPart(triangles, t, dir, pos, hard);
    return { g, pos, nrm, ray, tx, ty, tz, tw, avg };
  };

  for (let ty = 0; ty < tileRows; ty++) {
    const y0 = ty * BAKE_TILE;
    const y1 = Math.min(height, y0 + BAKE_TILE);
    for (let tx = 0; tx < tiles; tx++) {
      for (const t of bins[ty * tiles + tx] as number[]) {
        const i0 = bIdx[t * 3] as number;
        const i1 = bIdx[t * 3 + 1] as number;
        const i2 = bIdx[t * 3 + 2] as number;
        const x0 = (bUv[i0 * 2] as number) * width;
        const y0u = (bUv[i0 * 2 + 1] as number) * height;
        const x1 = (bUv[i1 * 2] as number) * width;
        const y1u = (bUv[i1 * 2 + 1] as number) * height;
        const x2 = (bUv[i2 * 2] as number) * width;
        const y2u = (bUv[i2 * 2 + 1] as number) * height;
        const area = (x1 - x0) * (y2u - y0u) - (x2 - x0) * (y1u - y0u);
        if (area === 0) continue;
        const invArea = 1 / area;
        const xa = Math.max(tx * BAKE_TILE, Math.floor(minOf([x0, x1, x2])));
        const xb = Math.min((tx + 1) * BAKE_TILE - 1, width - 1, Math.floor(maxOf([x0, x1, x2])));
        const ya = Math.max(y0, Math.floor(minOf([y0u, y1u, y2u])));
        const yb = Math.min(y1 - 1, Math.floor(maxOf([y0u, y1u, y2u])));

        const h0 = (bTan[i0 * 4 + 3] as number) < 0 ? -1 : 1;
        const h1 = (bTan[i1 * 4 + 3] as number) < 0 ? -1 : 1;
        const h2 = (bTan[i2 * 4 + 3] as number) < 0 ? -1 : 1;
        const isMixed = h0 !== h1 || h0 !== h2;
        const isl = islands[t] as number;
        const face = bFace[t] as number;

        for (let y = ya; y <= yb; y++) {
          const py = y + 0.5;
          for (let x = xa; x <= xb; x++) {
            const px = x + 0.5;
            const w1 = ((px - x0) * (y2u - y0u) - (x2 - x0) * (py - y0u)) * invArea;
            const w2 = ((x1 - x0) * (py - y0u) - (px - x0) * (y1u - y0u)) * invArea;
            const w0 = 1 - w1 - w2;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const texel = y * width + x;
            if (claimed[texel] !== 0) {
              if (w0 > 0 && w1 > 0 && w2 > 0) {
                ensureGroupBvhs(prepared);
                const first = claimant[texel] as number;
                const fi0 = bIdx[first * 3] as number;
                const fi1 = bIdx[first * 3 + 1] as number;
                const fi2 = bIdx[first * 3 + 2] as number;
                const fx0 = (bUv[fi0 * 2] as number) * width;
                const fy0 = (bUv[fi0 * 2 + 1] as number) * height;
                const fx1 = (bUv[fi1 * 2] as number) * width;
                const fy1 = (bUv[fi1 * 2 + 1] as number) * height;
                const fx2 = (bUv[fi2 * 2] as number) * width;
                const fy2 = (bUv[fi2 * 2 + 1] as number) * height;
                const fa = (fx1 - fx0) * (fy2 - fy0) - (fx2 - fx0) * (fy1 - fy0);
                const fw1 = ((px - fx0) * (fy2 - fy0) - (fx2 - fx0) * (py - fy0)) / fa;
                const fw2 = ((fx1 - fx0) * (py - fy0) - (px - fx0) * (fy1 - fy0)) / fa;
                const aAt = surfaceAt(first, 1 - fw1 - fw2, fw1, fw2);
                const cAt = surfaceAt(t, w0, w1, w2);
                const aS = baker.stackSample(
                  aAt.pos,
                  aAt.nrm,
                  aAt.ray,
                  [[aAt.tx, aAt.ty, aAt.tz], aAt.tw],
                  aAt.g,
                  aAt.avg,
                );
                const cS = baker.stackSample(
                  cAt.pos,
                  cAt.nrm,
                  cAt.ray,
                  [[cAt.tx, cAt.ty, cAt.tz], cAt.tw],
                  cAt.g,
                  cAt.avg,
                );
                const angle =
                  (atan2(length(cross(aS.normal, cS.normal)), dot(aS.normal, cS.normal)) * 180) /
                  Math.PI;
                const gap = Math.abs(aS.height - cS.height);
                stack.samples++;
                if (gap > stack.maxHeight) stack.maxHeight = gap;
                if (angle > stack.maxAngle) stack.maxAngle = angle;
                if (angle > STACK_ANGLE || gap > heightTolerance) {
                  stack.conflicts++;
                  if (firstStackTexel < 0 || texel < firstStackTexel) {
                    firstStackTexel = texel;
                    stack.face = face;
                  }
                }
              }
              continue;
            }
            claimed[texel] = 1;
            claimant[texel] = t;
            weight[texel] = 1;
            island[texel] = isl;
            if (isMixed) {
              handedness.samples++;
              if (handedness.face === -1 || face < handedness.face) handedness.face = face;
            }
            const at = surfaceAt(t, w0, w1, w2);
            const o = activeCount * 20;
            activeF32[o] = at.pos[0];
            activeF32[o + 1] = at.pos[1];
            activeF32[o + 2] = at.pos[2];
            activeI32[o + 3] = at.g;
            activeF32[o + 4] = at.nrm[0];
            activeF32[o + 5] = at.nrm[1];
            activeF32[o + 6] = at.nrm[2];
            activeU32[o + 7] = at.avg ? 1 : 0;
            activeF32[o + 8] = at.ray[0];
            activeF32[o + 9] = at.ray[1];
            activeF32[o + 10] = at.ray[2];
            activeI32[o + 11] = isl;
            activeF32[o + 12] = at.tx;
            activeF32[o + 13] = at.ty;
            activeF32[o + 14] = at.tz;
            activeF32[o + 15] = at.tw;
            activeU32[o + 16] = texel;
            activeCount++;
          }
        }
      }
    }
  }
  if (
    activeCount === 0 ||
    activeCount * 80 > device.limits.maxStorageBufferBindingSize ||
    Math.ceil(activeCount / WORKGROUP_1D) > device.limits.maxComputeWorkgroupsPerDimension
  ) {
    return undefined;
  }
  return {
    activeCount,
    activeF32: activeF32.subarray(0, activeCount * 20),
    weight,
    island,
    stack,
    handedness,
  };
}

function packMetaBufData(
  prepared: PreparedBake,
  groupRoots: Int32Array,
  groupSolidRoots: Int32Array,
  includeSlotsAndRays: boolean,
): Float32Array {
  const { params, baker, groups } = prepared;
  const gpu = baker._gpuInputs();
  const slotOffset = groups.length * 2;
  const rayOffset = slotOffset + gpu.slotSurface.length * 4;
  const aoRayCount = includeSlotsAndRays ? params.ao.rays : 0;
  const metaVec4Count = Math.max(1, includeSlotsAndRays ? rayOffset + aoRayCount : slotOffset);
  const f32 = new Float32Array(metaVec4Count * 4);
  const i32 = new Int32Array(f32.buffer);
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    if (grp === undefined) continue;
    const o = g * 8;
    i32[o] = groupRoots[g] as number;
    i32[o + 1] = groupSolidRoots[g] as number;
    f32[o + 2] = grp.offset;
    f32[o + 3] = grp.maxRay;
    f32[o + 4] = grp.aoDistance;
  }
  if (includeSlotsAndRays) {
    for (let s = 0; s < gpu.slotSurface.length; s++) {
      const surf = gpu.slotSurface[s];
      const idCol = gpu.slotIds[s];
      if (surf === undefined || idCol === undefined) continue;
      const o = (slotOffset + s * 4) * 4;
      f32[o] = surf.baseColor[0] ?? 1;
      f32[o + 1] = surf.baseColor[1] ?? 1;
      f32[o + 2] = surf.baseColor[2] ?? 1;
      f32[o + 3] = surf.baseColor[3] ?? 1;
      f32[o + 4] = surf.emissive[0] ?? 0;
      f32[o + 5] = surf.emissive[1] ?? 0;
      f32[o + 6] = surf.emissive[2] ?? 0;
      f32[o + 7] = 1;
      f32[o + 8] = surf.roughness;
      f32[o + 9] = surf.metallic;
      f32[o + 12] = idCol[0] ?? 0;
      f32[o + 13] = idCol[1] ?? 0;
      f32[o + 14] = idCol[2] ?? 0;
      f32[o + 15] = 1;
    }
    for (let r = 0; r < aoRayCount; r++) {
      const o = (rayOffset + r) * 4;
      f32[o] = gpu.rays[r * 3] as number;
      f32[o + 1] = gpu.rays[r * 3 + 1] as number;
      f32[o + 2] = gpu.rays[r * 3 + 2] as number;
    }
  }
  return f32;
}

function jfaStepsFor(width: number, height: number, gutterDist: number): number[] {
  const jfaSteps: number[] = [];
  if (gutterDist > 0) {
    let step = 1;
    while (step * 2 < Math.min(Math.max(width, height), gutterDist * 2)) step *= 2;
    for (let s = step; s >= 1; s >>= 1) jfaSteps.push(s);
  }
  return jfaSteps;
}

function dispatchJfaCompute(
  encoder: GPUCommandEncoder,
  device: GPUDevice,
  pipes: CachedGpuBakePipelines,
  make: (bytes: number, usage: number, init?: (range: ArrayBuffer) => void) => GPUBuffer,
  guidesBuf: GPUBuffer,
  initMaskBuf: GPUBuffer | undefined,
  seedA: GPUBuffer,
  seedB: GPUBuffer,
  seedRead: GPUBuffer,
  width: number,
  height: number,
  gutterDist: number,
): { readonly finalSeedBuf: GPUBuffer; readonly jfaSteps: readonly number[] } {
  const jfaSteps = jfaStepsFor(width, height, gutterDist);
  if (jfaSteps.length === 0) return { finalSeedBuf: seedA, jfaSteps };
  const wx = Math.ceil(width / WORKGROUP_2D);
  const wy = Math.ceil(height / WORKGROUP_2D);
  const initCfg = make(16, UNIFORM, (range) => {
    new Uint32Array(range).set([width, height, 0, gutterDist]);
  });
  const initBg = device.createBindGroup({
    layout: pipes.jfaLayout,
    entries: [
      { binding: 0, resource: { buffer: initCfg } },
      { binding: 1, resource: { buffer: guidesBuf } },
      { binding: 2, resource: { buffer: initMaskBuf ?? seedB } },
      { binding: 3, resource: { buffer: seedA } },
    ],
  });
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(initMaskBuf !== undefined ? pipes.jfaInitMaskPipeline : pipes.jfaInitPipeline);
    pass.setBindGroup(0, initBg);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }
  let src = seedA;
  let dst = seedB;
  for (const step of jfaSteps) {
    const stepCfg = make(16, UNIFORM, (range) => {
      const u = new Uint32Array(range);
      u[0] = width;
      u[1] = height;
      new Int32Array(range)[2] = step;
      u[3] = gutterDist;
    });
    const stepBg = device.createBindGroup({
      layout: pipes.jfaLayout,
      entries: [
        { binding: 0, resource: { buffer: stepCfg } },
        { binding: 1, resource: { buffer: guidesBuf } },
        { binding: 2, resource: { buffer: src } },
        { binding: 3, resource: { buffer: dst } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.jfaStepPipeline);
    pass.setBindGroup(0, stepBg);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  encoder.copyBufferToBuffer(src, 0, seedRead, 0, width * height * 4);
  return { finalSeedBuf: src, jfaSteps };
}

function dispatchRingDilateAndPack(
  targetEncoder: GPUCommandEncoder,
  device: GPUDevice,
  pipes: CachedGpuBakePipelines,
  make: (bytes: number, usage: number, init?: (range: ArrayBuffer) => void) => GPUBuffer,
  params: {
    readonly width: number;
    readonly height: number;
    readonly texels: number;
    readonly mapCount: number;
    readonly gutterDist: number;
    readonly categoricalMask: number;
    readonly encCfg: GPUBuffer;
    readonly srcA: GPUBuffer;
    readonly srcB: GPUBuffer;
    readonly valA: GPUBuffer;
    readonly valB: GPUBuffer;
    readonly finalSeedBuf: GPUBuffer;
    readonly packedBuf: GPUBuffer;
    readonly packedRead: GPUBuffer;
  },
): void {
  const {
    width,
    height,
    texels,
    mapCount,
    gutterDist,
    categoricalMask,
    encCfg,
    srcA,
    srcB,
    valA,
    valB,
    finalSeedBuf,
    packedBuf,
    packedRead,
  } = params;
  const wx = Math.ceil(width / WORKGROUP_2D);
  const wy = Math.ceil(height / WORKGROUP_2D);
  let curVal = valA;
  let altVal = valB;
  let curSrc = srcA;
  let altSrc = srcB;
  let rem = Math.min(gutterDist, 64);
  const dwx = Math.ceil(width / 8);
  const dwy = Math.ceil(height / 8);
  while (rem > 0) {
    const rings = Math.min(4, rem);
    rem -= rings;
    const dilCfg = make(32, UNIFORM, (range) => {
      new Uint32Array(range).set([width, height, texels, rings, categoricalMask]);
    });
    const dilBg = device.createBindGroup({
      layout: pipes.dilateLayout,
      entries: [dilCfg, curSrc, altSrc, curVal, altVal].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const pass = targetEncoder.beginComputePass();
    pass.setPipeline(pipes.dilatePipeline);
    pass.setBindGroup(0, dilBg);
    pass.dispatchWorkgroups(dwx, dwy, mapCount);
    pass.end();
    const tmpVal = curVal;
    curVal = altVal;
    altVal = tmpVal;
    const tmpSrc = curSrc;
    curSrc = altSrc;
    altSrc = tmpSrc;
  }
  const packBg = device.createBindGroup({
    layout: pipes.packLayout,
    entries: [encCfg, curSrc, curVal, finalSeedBuf, packedBuf].map((buffer, binding) => ({
      binding,
      resource: { buffer },
    })),
  });
  {
    const pass = targetEncoder.beginComputePass();
    pass.setPipeline(pipes.packPipeline);
    pass.setBindGroup(0, packBg);
    pass.dispatchWorkgroups(wx, wy, mapCount);
    pass.end();
  }
  targetEncoder.copyBufferToBuffer(packedBuf, 0, packedRead, 0, texels * 4 * mapCount);
}

function computeBleedOwnerFromSeeds(
  width: number,
  height: number,
  weight: ArrayLike<number>,
  island: Int32Array,
  seeds: Int32Array | undefined,
  gutterDist: number,
  isFill: boolean,
): { readonly chart: Uint8Array; readonly owner: Int32Array; readonly bleed: number[] } {
  const texels = width * height;
  const chart = new Uint8Array(texels);
  const owner = new Int32Array(texels).fill(UNOWNED);
  for (let i = 0; i < texels; i++) {
    if ((weight[i] as number) > 0) {
      chart[i] = 1;
      owner[i] = island[i] as number;
    }
  }
  if (seeds !== undefined && gutterDist > 0) {
    const maxDistSq = gutterDist * gutterDist;
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        const i = rowOff + x;
        if (chart[i] === 1) continue;
        const s = seeds[i] as number;
        if (s < 0) continue;
        if (!isFill) {
          const sx = s % width;
          const sy = (s - sx) / width;
          const dx = x - sx;
          const dy = y - sy;
          if (dx * dx + dy * dy > maxDistSq) continue;
        }
        const sChart = island[s] as number;
        let own = sChart;
        if (x > 0) {
          const ns = seeds[i - 1] as number;
          if (ns >= 0 && (island[ns] as number) !== sChart) own = MIXED;
        }
        if (own !== MIXED && x + 1 < width) {
          const ns = seeds[i + 1] as number;
          if (ns >= 0 && (island[ns] as number) !== sChart) own = MIXED;
        }
        if (own !== MIXED && y > 0) {
          const ns = seeds[i - width] as number;
          if (ns >= 0 && (island[ns] as number) !== sChart) own = MIXED;
        }
        if (own !== MIXED && y + 1 < height) {
          const ns = seeds[i + width] as number;
          if (ns >= 0 && (island[ns] as number) !== sChart) own = MIXED;
        }
        owner[i] = own;
      }
    }
  }
  const bleed = mipBleed(owner, chart, { w: width, h: height, u: false, v: false });
  return { chart, owner, bleed };
}

function finalizeGpuOutput(
  prepared: PreparedBake,
  work: WorkMeter,
  width: number,
  height: number,
  texels: number,
  activeCount: number,
  weight: Float64Array,
  island: Int32Array,
  stack: BakeStack,
  handedness: BakeHandedness,
  gpuOut: {
    readonly filtered?: Float32Array[];
    readonly packedU8?: Uint8Array[];
    readonly curvatureRange: number;
    readonly counters: Uint32Array;
    readonly seeds: Int32Array | undefined;
  },
): Result<GpuBakeCorrespondResult, ModelingError> {
  const { params, groups, encoding } = prepared;
  const gutterDist =
    params.gutter === 'fill' ? Math.max(width, height) : Math.max(0, Math.floor(params.gutter));
  const { chart, owner, bleed } = computeBleedOwnerFromSeeds(
    width,
    height,
    weight,
    island,
    gpuOut.seeds,
    gutterDist,
    params.gutter === 'fill',
  );
  const FINISH_GROUP_COUNTERS = 11;
  const counts = new Float64Array(groups.length * FINISH_GROUP_COUNTERS);
  for (let g = 0; g < groups.length; g++) {
    const src = g * GROUP_COUNTERS;
    const dst = g * FINISH_GROUP_COUNTERS;
    const samples = gpuOut.counters[src] ?? 0;
    const rayHits = gpuOut.counters[src + 1] ?? 0;
    const nearest = gpuOut.counters[src + 2] ?? 0;
    counts[dst] = samples;
    counts[dst + 1] = rayHits;
    counts[dst + 2] = nearest;
    counts[dst + 3] = gpuOut.counters[src + 3] ?? 0;
    counts[dst + 4] = gpuOut.counters[src + 4] ?? 0;
    counts[dst + 6] = samples;
    counts[dst + 7] = rayHits + nearest;
  }
  const syntheticPart = {
    rows: [],
    sums: [],
    weight,
    island,
    point: new Float64Array(0),
    normal: new Float64Array(0),
    hits: new Float64Array(0),
    counts,
    findings: new Float64Array(0),
    stack: new Float64Array(8),
  };

  if (gpuOut.packedU8 !== undefined) {
    const prepackedTextures: Partial<Record<BakeMapKind, TextureAsset>> = {};
    for (let m = 0; m < params.maps.length; m++) {
      const map = params.maps[m] as BakeMapKind;
      const srgb = map === 'baseColor' || map === 'materialId';
      prepackedTextures[map] = {
        kind: 'texture',
        format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
        colorSpace: srgb ? 'srgb' : 'linear',
        shape: { viewDimension: '2d', extent: { width, height } },
        mips: { kind: 'none' },
        data: gpuOut.packedU8[m] as Uint8Array,
      };
    }
    const done = finishBake(prepared, [syntheticPart], work, {
      values: params.maps.map(() => new Float32Array(0)),
      covered: activeCount,
      curvatureRange: gpuOut.curvatureRange,
      bleed,
      stack,
      handedness,
    });
    if (!done.ok) return done;
    return ok({ output: done.value, prepackedTextures });
  }

  const values = gpuOut.filtered as Float32Array[];
  const curvatureRange = encodeMaps(params.maps, values, weight, encoding);
  if (gpuOut.seeds !== undefined && gutterDist > 0) {
    for (let i = 0; i < texels; i++) {
      if (chart[i] === 1 || owner[i] === UNOWNED) continue;
      const s = gpuOut.seeds[i] as number;
      if (s < 0) continue;
      const dst4 = i * 4;
      const src4 = s * 4;
      for (let m = 0; m < values.length; m++) {
        const buf = values[m];
        if (buf === undefined) continue;
        buf[dst4] = buf[src4] as number;
        buf[dst4 + 1] = buf[src4 + 1] as number;
        buf[dst4 + 2] = buf[src4 + 2] as number;
        buf[dst4 + 3] = buf[src4 + 3] as number;
      }
    }
  }
  const done = finishBake(prepared, [syntheticPart], work, {
    values,
    covered: activeCount,
    curvatureRange,
    bleed,
    stack,
    handedness,
  });
  if (!done.ok) return done;
  return ok({ output: done.value });
}

async function runFilterJfaAndPackStage(
  device: GPUDevice,
  pipes: CachedGpuBakePipelines,
  make: (bytes: number, usage: number, init?: (range: ArrayBuffer) => void) => GPUBuffer,
  firstEncoder: GPUCommandEncoder,
  opts: {
    readonly prepared: PreparedBake;
    readonly width: number;
    readonly height: number;
    readonly texels: number;
    readonly activeCount: number;
    readonly weight: Float64Array;
    readonly encodeKindIds: readonly number[];
    readonly canEmitU8Direct: boolean;
    readonly guidesBuf: GPUBuffer;
    readonly sampledBuf: GPUBuffer;
    readonly countersBuf: GPUBuffer | undefined;
    readonly countersBytes: number;
  },
) {
  const {
    prepared,
    width,
    height,
    texels,
    activeCount,
    weight,
    encodeKindIds,
    canEmitU8Direct,
    guidesBuf,
    sampledBuf,
    countersBuf,
    countersBytes,
  } = opts;
  const { params, encoding } = prepared;
  const atlasBytes = texels * 16 * params.maps.length;
  const curvMapIdx = params.maps.findIndex(
    (k) => k === 'curvature' || k === 'cavity' || k === 'edgeWear',
  );
  const gutterDist =
    params.gutter === 'fill' ? Math.max(width, height) : Math.max(0, Math.floor(params.gutter));
  const curvOutOffset = params.maps.length * texels;
  const curvOutByteOffset = curvOutOffset * 4;
  const filterCfg = make(64, UNIFORM, (range) => {
    const words = new Uint32Array(range);
    const i32 = new Int32Array(range);
    words[0] = width;
    words[1] = height;
    words[2] = texels;
    words[3] = params.ao.denoise;
    words[4] = params.filter === 'bspline' ? 1 : 0;
    i32[5] = curvMapIdx;
    words[6] = curvOutOffset;
    for (const [index, map] of params.maps.entries()) {
      words[8 + index] =
        map === 'materialId'
          ? 3
          : map === 'curvature' || map === 'cavity' || map === 'edgeWear'
            ? 1
            : params.ao.denoise > 0 && (map === 'ao' || map === 'ormh')
              ? 2
              : 0;
    }
  });
  const scratchBuf = make(
    curvOutByteOffset + (curvMapIdx >= 0 ? texels * 4 : 0),
    STORAGE | COPY_SRC,
  );
  const resultBuf = make(atlasBytes, STORAGE | COPY_SRC);
  const seedBytes = texels * 4;
  const seedA = make(seedBytes, STORAGE | COPY_SRC);
  const seedB = make(seedBytes, STORAGE | COPY_SRC);
  const seedRead = make(seedBytes, MAP_READ | COPY_DST);
  const countersRead =
    countersBuf !== undefined ? make(countersBytes, MAP_READ | COPY_DST) : undefined;

  const filterBg = device.createBindGroup({
    layout: pipes.filterLayout,
    entries: [filterCfg, guidesBuf, sampledBuf, scratchBuf, resultBuf].map((buffer, binding) => ({
      binding,
      resource: { buffer },
    })),
  });
  const wx = Math.ceil(width / WORKGROUP_2D);
  const wy = Math.ceil(height / WORKGROUP_2D);
  for (const pipe of [pipes.prefilterPipeline, pipes.splineFilterPipeline]) {
    const pass = firstEncoder.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, filterBg);
    pass.dispatchWorkgroups(wx, wy, params.maps.length);
    pass.end();
  }
  const { finalSeedBuf, jfaSteps } = dispatchJfaCompute(
    firstEncoder,
    device,
    pipes,
    make,
    guidesBuf,
    undefined,
    seedA,
    seedB,
    seedRead,
    width,
    height,
    gutterDist,
  );
  if (countersBuf !== undefined && countersRead !== undefined) {
    firstEncoder.copyBufferToBuffer(countersBuf, 0, countersRead, 0, countersBytes);
  }

  if (canEmitU8Direct) {
    const curvBytes = texels * 4;
    const curvRead = curvMapIdx >= 0 ? make(curvBytes, MAP_READ | COPY_DST) : undefined;
    if (curvRead !== undefined) {
      firstEncoder.copyBufferToBuffer(scratchBuf, curvOutByteOffset, curvRead, 0, curvBytes);
    }
    const packedBytes = texels * 4 * params.maps.length;
    const packedBuf = make(packedBytes, STORAGE | COPY_SRC);
    const packedRead = make(packedBytes, MAP_READ | COPY_DST);
    const srcA = make(seedBytes, STORAGE);
    const srcB = make(seedBytes, STORAGE);
    let categoricalMask = 0;
    for (let m = 0; m < params.maps.length; m++) {
      if (params.maps[m] === 'materialId') categoricalMask |= 1 << m;
    }
    const buildEncodeCfg = (curvRange: number) =>
      make(256, UNIFORM, (range) => {
        const u32 = new Uint32Array(range);
        const f32 = new Float32Array(range);
        const [hMin, hMax] = encoding.heightRange;
        const { min, max } = encoding.positionBounds;
        u32[0] = width;
        u32[1] = height;
        u32[2] = texels;
        u32[3] = params.maps.length;
        u32[4] = gutterDist * gutterDist;
        u32[5] = (params.gutter === 'fill' ? 1 : 0) | (jfaSteps.length > 0 ? 2 : 0);
        f32[8] = hMin;
        f32[9] = 1 / (hMax - hMin);
        f32[10] = curvRange > 0 ? 1 / curvRange : 1;
        f32[11] = params.edgeWear.noise.amount;
        f32[12] = params.edgeWear.range[0] as number;
        f32[13] = params.edgeWear.range[1] as number;
        f32[14] = params.cavity.range[0] as number;
        f32[15] = params.cavity.range[1] as number;
        f32[16] = min[0] as number;
        f32[17] = min[1] as number;
        f32[18] = min[2] as number;
        f32[20] = (max[0] as number) - (min[0] as number);
        f32[21] = (max[1] as number) - (min[1] as number);
        f32[22] = (max[2] as number) - (min[2] as number);
        for (let m = 0; m < encodeKindIds.length; m++) u32[24 + m] = encodeKindIds[m] as number;
        for (let m = 0; m < params.maps.length; m++) {
          const bg = mapBackground(params.maps[m] as BakeMapKind, params);
          f32[32 + m * 4] = bg[0] ?? 0;
          f32[32 + m * 4 + 1] = bg[1] ?? 0;
          f32[32 + m * 4 + 2] = bg[2] ?? 0;
          f32[32 + m * 4 + 3] = bg[3] ?? 1;
        }
      });

    const encodeAndPack = (targetEncoder: GPUCommandEncoder, curvatureRange: number) => {
      const encCfg = buildEncodeCfg(curvatureRange);
      const encBg = device.createBindGroup({
        layout: pipes.encodeLayout,
        entries: [encCfg, guidesBuf, resultBuf, sampledBuf, srcA].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
      {
        const pass = targetEncoder.beginComputePass();
        pass.setPipeline(pipes.encodePipeline);
        pass.setBindGroup(0, encBg);
        pass.dispatchWorkgroups(wx, wy, params.maps.length);
        pass.end();
      }
      dispatchRingDilateAndPack(targetEncoder, device, pipes, make, {
        width,
        height,
        texels,
        mapCount: params.maps.length,
        gutterDist,
        categoricalMask,
        encCfg,
        srcA,
        srcB,
        valA: sampledBuf,
        valB: resultBuf,
        finalSeedBuf,
        packedBuf,
        packedRead,
      });
    };

    let curvatureRange = 0;
    if (curvRead === undefined) {
      encodeAndPack(firstEncoder, 1);
      device.queue.submit([firstEncoder.finish()]);
      const reads: Promise<void>[] = [packedRead.mapAsync(MAP_READ)];
      if (countersRead !== undefined) reads.push(countersRead.mapAsync(MAP_READ));
      if (jfaSteps.length > 0) reads.push(seedRead.mapAsync(MAP_READ));
      await Promise.all(reads);
    } else {
      device.queue.submit([firstEncoder.finish()]);
      const reads1: Promise<void>[] = [curvRead.mapAsync(MAP_READ)];
      if (countersRead !== undefined) reads1.push(countersRead.mapAsync(MAP_READ));
      if (jfaSteps.length > 0) reads1.push(seedRead.mapAsync(MAP_READ));
      await Promise.all(reads1);

      const curvView = new Float32Array(curvRead.getMappedRange());
      const mags = new Float32Array(activeCount);
      let k = 0;
      for (let i = 0; i < texels; i++) {
        if ((weight[i] as number) > 0) mags[k++] = curvView[i] as number;
      }
      curvRead.unmap();
      mags.sort();
      curvatureRange = k > 0 ? (mags[Math.floor((k - 1) * 0.95)] as number) : 0;
      if (!(curvatureRange > 0)) curvatureRange = 1;

      const enc2 = device.createCommandEncoder();
      encodeAndPack(enc2, curvatureRange);
      device.queue.submit([enc2.finish()]);
      await packedRead.mapAsync(MAP_READ);
    }

    const packedBytesCopy = packedRead.getMappedRange().slice(0);
    packedRead.unmap();
    let countersCopy = new Uint32Array(0);
    if (countersRead !== undefined) {
      countersCopy = new Uint32Array(countersRead.getMappedRange().slice(0));
      countersRead.unmap();
    }
    let seeds: Int32Array | undefined;
    if (jfaSteps.length > 0) {
      seeds = new Int32Array(seedRead.getMappedRange().slice(0));
      seedRead.unmap();
    }
    const mapU8Bytes = texels * 4;
    const packedU8 = params.maps.map(
      (_, i) => new Uint8Array(packedBytesCopy, i * mapU8Bytes, mapU8Bytes),
    );
    return { packedU8, curvatureRange, counters: countersCopy, seeds };
  }

  const resultRead = make(atlasBytes, MAP_READ | COPY_DST);
  firstEncoder.copyBufferToBuffer(resultBuf, 0, resultRead, 0, atlasBytes);
  device.queue.submit([firstEncoder.finish()]);
  const reads: Promise<void>[] = [resultRead.mapAsync(MAP_READ)];
  if (countersRead !== undefined) reads.push(countersRead.mapAsync(MAP_READ));
  if (jfaSteps.length > 0) reads.push(seedRead.mapAsync(MAP_READ));
  await Promise.all(reads);

  const atlasCopy = resultRead.getMappedRange().slice(0);
  resultRead.unmap();
  let countersCopy = new Uint32Array(0);
  if (countersRead !== undefined) {
    countersCopy = new Uint32Array(countersRead.getMappedRange().slice(0));
    countersRead.unmap();
  }
  let seeds: Int32Array | undefined;
  if (jfaSteps.length > 0) {
    seeds = new Int32Array(seedRead.getMappedRange().slice(0));
    seedRead.unmap();
  }
  const mapBytes = texels * 16;
  const filtered = params.maps.map((_, i) => new Float32Array(atlasCopy, i * mapBytes, texels * 4));
  return { filtered, curvatureRange: 0, counters: countersCopy, seeds };
}

/**
 * Full WebGPU high-to-low baker (single submission fused path):
 * 1) Rust WASM batch SAH BVH builder (zero JS TriangleBvh overhead, zero-copy into GPU buffers)
 * 2) Fast zero-allocation UV rasterization into compact active texels
 * 3) GPU Pass 1 (Correspond + AO) -> Pass 2 (Curvature/Denoise/B-Spline) -> Pass 3 (JFA)
 * 4) GPU Pass 4 (Encode + Dilate + sRGB + RGBA8 quantization) reading back 32 MB instead of 128 MB!
 */
export async function runBakeCorrespondGpu(
  device: GPUDevice,
  prepared: PreparedBake,
  work: WorkMeter,
  wantMips: boolean,
): Promise<Result<GpuBakeCorrespondResult, ModelingError> | undefined> {
  const caps = validateGpuEvalCapabilities(prepared, device, wantMips);
  if (caps === undefined) return undefined;
  const bvh = buildFlatGpuBvh(prepared, device);
  if (bvh === undefined) return undefined;
  const raster = rasterizeBaseUv(prepared, caps.width, caps.height, caps.texels, device);
  if (raster === undefined) return undefined;

  const { width, height, texels, mapKindIds, encodeKindIds, canEmitU8Direct } = caps;
  const { activeCount, activeF32, weight, island, stack, handedness } = raster;
  const { params, baker, groups } = prepared;
  const slotOffset = groups.length * 2;
  const rayOffset = slotOffset + baker._gpuInputs().slotSurface.length * 4;
  const needAo = params.maps.some((k) => k === 'ao' || k === 'ormh');
  const metaData = packMetaBufData(prepared, bvh.groupRoots, bvh.groupSolidRoots, true);
  const pipes = getGpuBakePipelines(device);

  const gpuOut = await withBakeGpuBuffers(device, async ({ make }) => {
    const corrCfg = make(80, UNIFORM, (range) => {
      const u32 = new Uint32Array(range);
      const i32 = new Int32Array(range);
      const f32 = new Float32Array(range);
      u32[0] = width;
      u32[1] = height;
      u32[2] = activeCount;
      u32[3] = params.maps.length;
      u32[4] = slotOffset;
      u32[5] = rayOffset;
      u32[6] = params.ao.rays;
      u32[7] = (params.rawCage === true ? 1 : 0) | (needAo ? 2 : 0);
      f32[8] = baker._gpuInputs().eps;
      f32[9] = params.edgeWear.noise.scale;
      i32[10] = params.edgeWear.noise.seed | 0;
      u32[11] = texels;
      for (let m = 0; m < mapKindIds.length; m++) u32[12 + m] = mapKindIds[m] as number;
    });
    const nodeBuf = make(bvh.nodesU32.byteLength, STORAGE, (r) =>
      new Uint32Array(r).set(bvh.nodesU32),
    );
    const triBuf = make(bvh.trisU32.byteLength, STORAGE, (r) =>
      new Uint32Array(r).set(bvh.trisU32),
    );
    const triNormBuf = make(bvh.triNormalsF32.byteLength, STORAGE, (r) =>
      new Float32Array(r).set(bvh.triNormalsF32),
    );
    const metaBuf = make(metaData.byteLength, STORAGE, (r) => new Float32Array(r).set(metaData));
    const activeBuf = make(activeCount * 80, STORAGE, (r) => new Float32Array(r).set(activeF32));
    const guidesBuf = make(texels * 32, STORAGE);
    const sampledBuf = make(texels * 16 * params.maps.length, STORAGE);
    const countersBytes = Math.max(16, groups.length * GROUP_COUNTERS * 4);
    const countersBuf = make(countersBytes, STORAGE | COPY_SRC);

    const corrBg = device.createBindGroup({
      layout: pipes.correspondLayout,
      entries: [
        { binding: 0, resource: { buffer: corrCfg } },
        { binding: 1, resource: { buffer: nodeBuf } },
        { binding: 2, resource: { buffer: triBuf } },
        { binding: 3, resource: { buffer: triNormBuf } },
        { binding: 4, resource: { buffer: metaBuf } },
        { binding: 5, resource: { buffer: activeBuf } },
        { binding: 6, resource: { buffer: guidesBuf } },
        { binding: 7, resource: { buffer: sampledBuf } },
        { binding: 8, resource: { buffer: countersBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipes.correspondPipeline);
      pass.setBindGroup(0, corrBg);
      pass.dispatchWorkgroups(Math.ceil(activeCount / WORKGROUP_1D));
      pass.end();
    }
    return runFilterJfaAndPackStage(device, pipes, make, encoder, {
      prepared,
      width,
      height,
      texels,
      activeCount,
      weight,
      encodeKindIds,
      canEmitU8Direct,
      guidesBuf,
      sampledBuf,
      countersBuf,
      countersBytes,
    });
  });

  return finalizeGpuOutput(
    prepared,
    work,
    width,
    height,
    texels,
    activeCount,
    weight,
    island,
    stack,
    handedness,
    gpuOut,
  );
}

/**
 * Decoupled GPU Pass 1 (`correspondOnly`): resolves UV rasterization + primary BVH correspondence +
 * cage clips + stray part audits once, returning compact reusable `HitRecord`s + cached BVH buffers.
 */
export async function bakeCorrespondGpu(
  device: GPUDevice,
  prepared: PreparedBake,
): Promise<GpuCorrespondenceData | undefined> {
  if (
    prepared.params.target !== 'texture' ||
    prepared.params.analytic !== undefined ||
    prepared.params.samples !== 1 ||
    device.limits.maxStorageBuffersPerShaderStage < 8
  ) {
    return undefined;
  }
  const grid = gridOf(prepared.params);
  if (grid.u || grid.v) return undefined;
  const { w: width, h: height } = grid;
  const texels = width * height;
  if (
    Math.ceil(width / WORKGROUP_2D) > device.limits.maxComputeWorkgroupsPerDimension ||
    Math.ceil(height / WORKGROUP_2D) > device.limits.maxComputeWorkgroupsPerDimension
  ) {
    return undefined;
  }
  const bvh = buildFlatGpuBvh(prepared, device);
  if (bvh === undefined) return undefined;
  const raster = rasterizeBaseUv(prepared, width, height, texels, device);
  if (raster === undefined) return undefined;

  const { activeCount, activeF32, weight, island, stack, handedness } = raster;
  const hitsBytes = activeCount * 48;
  if (hitsBytes > device.limits.maxStorageBufferBindingSize) return undefined;

  const { params, groups } = prepared;
  const metaData = packMetaBufData(prepared, bvh.groupRoots, bvh.groupSolidRoots, false);
  const pipes = getGpuBakePipelines(device);

  const { hitsWords, counters } = await withBakeGpuBuffers(device, async ({ make }) => {
    const corrCfg = make(80, UNIFORM, (range) => {
      const u32 = new Uint32Array(range);
      u32[0] = width;
      u32[1] = height;
      u32[2] = activeCount;
      u32[3] = 0;
      u32[4] = groups.length * 2;
      u32[5] = groups.length * 2;
      u32[6] = 0;
      u32[7] = params.rawCage === true ? 1 : 0;
      u32[11] = texels;
    });
    const nodeBuf = make(bvh.nodesU32.byteLength, STORAGE, (r) =>
      new Uint32Array(r).set(bvh.nodesU32),
    );
    const triBuf = make(bvh.trisU32.byteLength, STORAGE, (r) =>
      new Uint32Array(r).set(bvh.trisU32),
    );
    const triNormBuf = make(bvh.triNormalsF32.byteLength, STORAGE, (r) =>
      new Float32Array(r).set(bvh.triNormalsF32),
    );
    const metaBuf = make(metaData.byteLength, STORAGE, (r) => new Float32Array(r).set(metaData));
    const activeBuf = make(activeCount * 80, STORAGE, (r) => new Float32Array(r).set(activeF32));
    const countersBytes = Math.max(16, groups.length * GROUP_COUNTERS * 4);
    const countersBuf = make(countersBytes, STORAGE | COPY_SRC);
    const countersRead = make(countersBytes, MAP_READ | COPY_DST);
    const hitsBuf = make(hitsBytes, STORAGE | COPY_SRC);
    const hitsRead = make(hitsBytes, MAP_READ | COPY_DST);

    const bg = device.createBindGroup({
      layout: pipes.correspondOnlyLayout,
      entries: [
        { binding: 0, resource: { buffer: corrCfg } },
        { binding: 1, resource: { buffer: nodeBuf } },
        { binding: 2, resource: { buffer: triBuf } },
        { binding: 3, resource: { buffer: triNormBuf } },
        { binding: 4, resource: { buffer: metaBuf } },
        { binding: 5, resource: { buffer: activeBuf } },
        { binding: 8, resource: { buffer: countersBuf } },
        { binding: 9, resource: { buffer: hitsBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.correspondOnlyPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(activeCount / WORKGROUP_1D));
    pass.end();
    encoder.copyBufferToBuffer(hitsBuf, 0, hitsRead, 0, hitsBytes);
    encoder.copyBufferToBuffer(countersBuf, 0, countersRead, 0, countersBytes);
    device.queue.submit([encoder.finish()]);

    await Promise.all([hitsRead.mapAsync(MAP_READ), countersRead.mapAsync(MAP_READ)]);
    const hCopy = new Uint32Array(hitsRead.getMappedRange().slice(0));
    hitsRead.unmap();
    const cCopy = new Uint32Array(countersRead.getMappedRange().slice(0));
    countersRead.unmap();
    return { hitsWords: hCopy, counters: cCopy };
  });

  return {
    prepared,
    width,
    height,
    texels,
    activeCount,
    activeF32,
    hitsWords,
    weight,
    island,
    counters,
    stack,
    handedness,
    nodesU32: bvh.nodesU32,
    trisU32: bvh.trisU32,
    triNormalsF32: bvh.triNormalsF32,
    groupRoots: bvh.groupRoots,
    groupSolidRoots: bvh.groupSolidRoots,
  };
}

/**
 * Evaluate arbitrary maps (`normal`, `ormh`, `ao`, `edgeWear`, `slots`, etc.) on WebGPU
 * from a pre-computed `GpuCorrespondenceData`. Skips UV rasterization, BVH building, and
 * primary correspondence completely; skips uploading BVH nodes/tris altogether when `ao` is absent.
 */
export async function evaluateBakeMapsGpu(
  device: GPUDevice,
  correspondence: GpuCorrespondenceData,
  evalParams: PreparedBake,
  work: WorkMeter,
  wantMips: boolean,
): Promise<Result<GpuBakeCorrespondResult, ModelingError> | undefined> {
  const caps = validateGpuEvalCapabilities(evalParams, device, wantMips);
  if (caps === undefined) return undefined;
  const { width, height, texels, mapKindIds, encodeKindIds, canEmitU8Direct } = caps;
  if (width !== correspondence.width || height !== correspondence.height) return undefined;

  const { params, baker, groups } = evalParams;
  const { activeCount, activeF32, hitsWords, weight, island, counters, stack, handedness } =
    correspondence;
  const slotOffset = groups.length * 2;
  const rayOffset = slotOffset + baker._gpuInputs().slotSurface.length * 4;
  const needAo = params.maps.some((k) => k === 'ao' || k === 'ormh');
  const metaData = packMetaBufData(
    evalParams,
    correspondence.groupRoots,
    correspondence.groupSolidRoots,
    true,
  );
  const pipes = getGpuBakePipelines(device);

  const gpuOut = await withBakeGpuBuffers(device, async ({ make }) => {
    const corrCfg = make(80, UNIFORM, (range) => {
      const u32 = new Uint32Array(range);
      const i32 = new Int32Array(range);
      const f32 = new Float32Array(range);
      u32[0] = width;
      u32[1] = height;
      u32[2] = activeCount;
      u32[3] = params.maps.length;
      u32[4] = slotOffset;
      u32[5] = rayOffset;
      u32[6] = params.ao.rays;
      u32[7] = (params.rawCage === true ? 1 : 0) | (needAo ? 2 : 0);
      f32[8] = baker._gpuInputs().eps;
      f32[9] = params.edgeWear.noise.scale;
      i32[10] = params.edgeWear.noise.seed | 0;
      u32[11] = texels;
      for (let m = 0; m < mapKindIds.length; m++) u32[12 + m] = mapKindIds[m] as number;
    });
    const nodeBuf = needAo
      ? make(correspondence.nodesU32.byteLength, STORAGE, (r) =>
          new Uint32Array(r).set(correspondence.nodesU32),
        )
      : make(64, STORAGE);
    const triBuf = needAo
      ? make(correspondence.trisU32.byteLength, STORAGE, (r) =>
          new Uint32Array(r).set(correspondence.trisU32),
        )
      : make(64, STORAGE);
    const metaBuf = make(metaData.byteLength, STORAGE, (r) => new Float32Array(r).set(metaData));
    const activeBuf = make(activeCount * 80, STORAGE, (r) => new Float32Array(r).set(activeF32));
    const hitsBuf = make(hitsWords.byteLength, STORAGE, (r) => new Uint32Array(r).set(hitsWords));
    const guidesBuf = make(texels * 32, STORAGE);
    const sampledBuf = make(texels * 16 * params.maps.length, STORAGE);

    const evalBg = device.createBindGroup({
      layout: pipes.evalCorrespondLayout,
      entries: [
        { binding: 0, resource: { buffer: corrCfg } },
        { binding: 1, resource: { buffer: nodeBuf } },
        { binding: 2, resource: { buffer: triBuf } },
        { binding: 4, resource: { buffer: metaBuf } },
        { binding: 5, resource: { buffer: activeBuf } },
        { binding: 6, resource: { buffer: guidesBuf } },
        { binding: 7, resource: { buffer: sampledBuf } },
        { binding: 9, resource: { buffer: hitsBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipes.evalCorrespondPipeline);
      pass.setBindGroup(0, evalBg);
      pass.dispatchWorkgroups(Math.ceil(activeCount / WORKGROUP_1D));
      pass.end();
    }
    const tail = await runFilterJfaAndPackStage(device, pipes, make, encoder, {
      prepared: evalParams,
      width,
      height,
      texels,
      activeCount,
      weight,
      encodeKindIds,
      canEmitU8Direct,
      guidesBuf,
      sampledBuf,
      countersBuf: undefined,
      countersBytes: 0,
    });
    return { ...tail, counters };
  });

  return finalizeGpuOutput(
    evalParams,
    work,
    width,
    height,
    texels,
    activeCount,
    weight,
    island,
    stack,
    handedness,
    gpuOut,
  );
}

export interface RawGpuAtlasResult {
  readonly entries: readonly (readonly [string, TextureAsset])[];
  readonly grid: AtlasGrid;
  readonly packedBytesCopy: ArrayBuffer;
  readonly bleed: AtlasBleedReport;
}

/**
 * Dilate 2D atlas `TextureAsset` maps on WebGPU reusing the bake JFA + ring dilation +
 * RGBA8 pack pipelines. Returns `undefined` when GPU fallback (`r16unorm`, wrapped UVs,
 * >8 maps, or limits) should delegate to CPU `dilateAtlas`.
 */
export async function runGpuAtlasDilation(
  options: DilateAtlasOptions,
  device: GPUDevice,
): Promise<Result<RawGpuAtlasResult, ModelingError> | undefined> {
  const prep = prepareAtlasDilation(options);
  if (!prep.ok) return prep;
  const { entries, grid, mask, owner, frame, gutter, protectMip, categorical } = prep.value;
  const width = grid.w;
  const height = grid.h;
  const texels = width * height;
  const mapCount = entries.length;
  if (
    grid.u ||
    grid.v ||
    mapCount > 8 ||
    entries.some(([, t]) => t.format === 'r16unorm') ||
    texels * 16 * mapCount > device.limits.maxStorageBufferBindingSize ||
    Math.ceil(width / WORKGROUP_2D) > device.limits.maxComputeWorkgroupsPerDimension ||
    Math.ceil(height / WORKGROUP_2D) > device.limits.maxComputeWorkgroupsPerDimension ||
    device.limits.maxStorageBuffersPerShaderStage < 8
  ) {
    return undefined;
  }

  const pipes = getGpuBakePipelines(device);
  const gutterDist = Math.max(0, gutter);
  const seedBytes = texels * 4;
  let categoricalMask = 0;
  for (let m = 0; m < mapCount; m++) {
    if (categorical.has(entries[m]?.[0] as string)) categoricalMask |= 1 << m;
  }

  const { packedBytesCopy, seeds } = await withBakeGpuBuffers(device, async ({ make }) => {
    const valA = make(texels * 16 * mapCount, STORAGE, (range) => {
      const dst = new Float32Array(range);
      for (let m = 0; m < mapCount; m++) {
        const src = entries[m]?.[1].data as Uint8Array;
        const base = m * texels * 4;
        for (let i = 0; i < texels * 4; i++) dst[base + i] = (src[i] as number) / 255;
      }
    });
    const valB = make(texels * 16 * mapCount, STORAGE);
    const frameBuf = make(seedBytes, STORAGE, (range) => new Int32Array(range).set(frame));
    const srcA = make(seedBytes, STORAGE, (range) => new Int32Array(range).set(frame));
    const srcB = make(seedBytes, STORAGE);
    const seedA = make(seedBytes, STORAGE | COPY_SRC);
    const seedB = make(seedBytes, STORAGE | COPY_SRC);
    const seedRead = make(seedBytes, MAP_READ | COPY_DST);
    const dummyGuide = make(32, STORAGE);
    const packedBytes = texels * 4 * mapCount;
    const packedBuf = make(packedBytes, STORAGE | COPY_SRC);
    const packedRead = make(packedBytes, MAP_READ | COPY_DST);

    const encCfg = make(256, UNIFORM, (range) => {
      const u32 = new Uint32Array(range);
      const f32 = new Float32Array(range);
      const jfaCount = jfaStepsFor(width, height, gutterDist).length;
      u32[0] = width;
      u32[1] = height;
      u32[2] = texels;
      u32[3] = mapCount;
      u32[4] = gutterDist * gutterDist;
      u32[5] =
        (options.gutter === undefined || options.gutter === 'fill' ? 1 : 0) |
        (jfaCount > 0 ? 2 : 0);
      for (let m = 0; m < mapCount; m++) u32[24 + m] = 9;
      for (let m = 0; m < mapCount; m++) {
        f32[32 + m * 4] = 0;
        f32[32 + m * 4 + 1] = 0;
        f32[32 + m * 4 + 2] = 0;
        f32[32 + m * 4 + 3] = 0;
      }
    });

    const encoder = device.createCommandEncoder();
    const { finalSeedBuf, jfaSteps } = dispatchJfaCompute(
      encoder,
      device,
      pipes,
      make,
      dummyGuide,
      frameBuf,
      seedA,
      seedB,
      seedRead,
      width,
      height,
      gutterDist,
    );
    dispatchRingDilateAndPack(encoder, device, pipes, make, {
      width,
      height,
      texels,
      mapCount,
      gutterDist,
      categoricalMask,
      encCfg,
      srcA,
      srcB,
      valA,
      valB,
      finalSeedBuf,
      packedBuf,
      packedRead,
    });
    device.queue.submit([encoder.finish()]);
    const reads: Promise<void>[] = [packedRead.mapAsync(MAP_READ)];
    if (jfaSteps.length > 0) reads.push(seedRead.mapAsync(MAP_READ));
    await Promise.all(reads);

    const packedCopy = packedRead.getMappedRange().slice(0);
    packedRead.unmap();
    let seedsCopy: Int32Array | undefined;
    if (jfaSteps.length > 0) {
      seedsCopy = new Int32Array(seedRead.getMappedRange().slice(0));
      seedRead.unmap();
    }
    return { packedBytesCopy: packedCopy, seeds: seedsCopy };
  });

  const weight = Float64Array.from(mask);
  const bleedOwner = computeBleedOwnerFromSeeds(
    width,
    height,
    weight,
    owner,
    seeds,
    gutterDist,
    options.gutter === undefined || options.gutter === 'fill',
  );
  return ok({
    entries,
    grid,
    packedBytesCopy,
    bleed: atlasBleedReport(bleedOwner.owner, mask, grid, protectMip),
  });
}
