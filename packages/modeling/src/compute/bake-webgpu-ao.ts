import type { BakeRows, PreparedBake } from './bake-ts';
import { withBakeGpuBuffers } from './bake-webgpu';

const WIDTH = 64;

const shader = `
struct Config { width: u32, height: u32, rays: u32, epsilon: f32 }
struct Node { low: vec3<f32>, first: i32, high: vec3<f32>, endAndCount: u32 }
struct Triangle { a: vec3<f32>, e1: vec3<f32>, e2: vec3<f32> }
struct Group { root: i32, reach: f32 }
struct Sample { point: vec3<f32>, group: i32, normal: vec3<f32> }
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(3) var<storage, read> groups: array<Group>;
@group(0) @binding(4) var<storage, read> samples: array<Sample>;
@group(0) @binding(5) var<storage, read> rays: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> out: array<f32>;

fn intersect(node: Node, o: vec3<f32>, d: vec3<f32>, limit: f32) -> bool {
  var near = 0.0;
  var far = limit;
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

fn distance(tri: Triangle, o: vec3<f32>, d: vec3<f32>, limit: f32) -> f32 {
  let p = cross(d, tri.e2);
  let det = dot(tri.e1, p);
  if (det == 0.0) { return limit; }
  let s = o - tri.a;
  let u = dot(s, p) / det;
  if (u < 0.0 || u > 1.0) { return limit; }
  let q = cross(s, tri.e1);
  let v = dot(d, q) / det;
  if (v < 0.0 || u + v > 1.0) { return limit; }
  let t = dot(tri.e2, q) / det;
  return select(limit, t, t >= 0.0 && t < limit);
}

fn traceDistance(root: i32, o: vec3<f32>, d: vec3<f32>, reach: f32) -> f32 {
  var limit = reach;
  var i = u32(root);
  let end = nodes[i].endAndCount >> 4;
  while i < end {
    let node = nodes[i];
    if !intersect(node, o, d, limit) {
      i = node.endAndCount >> 4;
      continue;
    }
    if node.first < 0 {
      let start = u32(-1 - node.first);
      let count = node.endAndCount & 15u;
      for (var t = 0u; t < count; t++) {
        limit = distance(triangles[start + t], o, d, limit);
      }
    }
    i++;
  }
  return limit;
}

fn turn(i: u32) -> f32 {
  var h = (i * 16u * 0x27d4eb2du) ^ 0x9c5cd5d7u;
  h = (h ^ (h >> 15)) * 0x85ebca6bu;
  h = (h ^ (h >> 13)) * 0xc2b2ae35u;
  return f32(h ^ (h >> 16)) * (6.283185307179586 / 4294967296.0);
}

@compute @workgroup_size(${WIDTH})
fn occlusion(@builtin(global_invocation_id) id: vec3<u32>) {
  if id.x >= cfg.width || id.y >= cfg.height { return; }
  let i = id.y * cfg.width + id.x;
  let at = samples[i];
  if at.group < 0 { return; }
  let group = groups[at.group];
  if group.root < 0 {
    out[i] = 1.0;
    return;
  }
  let n = at.normal;
  let a = abs(n);
  let helper = select(
    select(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), a.y <= a.z),
    vec3(1.0, 0.0, 0.0), a.x <= a.y && a.x <= a.z,
  );
  let e1 = normalize(cross(helper, n));
  let e2 = cross(n, e1);
  let o = at.point + cfg.epsilon * n;
  let c = cos(turn(i));
  let s = sin(turn(i));
  var sum = 0.0;
  for (var k = 0u; k < cfg.rays; k++) {
    let r = rays[k];
    let d = e1 * (r.x * c - r.y * s) + e2 * (r.x * s + r.y * c) + n * r.z;
    sum += traceDistance(group.root, o, d, group.reach) / group.reach;
  }
  out[i] = sum / f32(cfg.rays);
}
`;

export function prepareBakeOcclusion(
  device: GPUDevice,
  { params, baker, groups }: PreparedBake,
  width: number,
  height: number,
) {
  const { ao } = params;
  const aoMaps = params.maps.flatMap((kind, index) =>
    kind === 'ao' || kind === 'ormh' ? [index] : [],
  );
  if (
    params.samples !== 1 ||
    ao.scope !== 'group' ||
    ao.floor !== undefined ||
    ao.attenuation !== 'linear' ||
    ao.rays > 64 ||
    ao.denoise === 0 ||
    aoMaps.length === 0 ||
    device.limits.maxStorageBuffersPerShaderStage < 6 ||
    width * height * 32 > device.limits.maxStorageBufferBindingSize ||
    height > device.limits.maxComputeWorkgroupsPerDimension
  )
    return undefined;
  const nodes: number[] = [];
  const triangles: number[] = [];
  const roots = groups.map(({ solid }) => solid._appendOcclusionTree(nodes, triangles));
  if (Math.max(nodes.length, triangles.length) * 4 > device.limits.maxStorageBufferBindingSize)
    return undefined;
  if (nodes.length === 0) return undefined;
  const sampleGroups = new Int32Array(width * height).fill(-1);
  const { offset, rays } = baker.occlusionInputs();
  return {
    sampleGroups,
    async apply(rows: BakeRows) {
      await withBakeGpuBuffers(device, async ({ input, uniform, readStorage, dispatch }) => {
        const config = uniform(16, (data) => {
          new Uint32Array(data).set([width, height, ao.rays]);
          new Float32Array(data)[3] = offset;
        });
        const nodeData = input(nodes.length * 4, (data) => {
          const lanes = new Float32Array(data);
          const indices = new Int32Array(data);
          for (let i = 0; i < nodes.length; i++) {
            if (i % 4 === 3) indices[i] = nodes[i] as number;
            else lanes[i] = nodes[i] as number;
          }
        });
        const triangleData = input(triangles.length * 4, (data) =>
          new Float32Array(data).set(triangles),
        );
        const groupData = input(groups.length * 8, (data) => {
          const ints = new Int32Array(data);
          const reals = new Float32Array(data);
          for (const [i, group] of groups.entries()) {
            ints[i * 2] = roots[i] as number;
            reals[i * 2 + 1] = group.aoDistance;
          }
        });
        const samples = input(sampleGroups.length * 32, (data) => {
          const coords = new Float32Array(data);
          const index = new Int32Array(data);
          for (const [i, group] of sampleGroups.entries()) {
            const at = i * 8;
            index[at + 3] = group;
            if (group < 0) continue;
            for (let c = 0; c < 3; c++) {
              coords[at + c] = rows.point[i * 3 + c] as number;
              coords[at + 4 + c] = rows.normal[i * 3 + c] as number;
            }
          }
        });
        const rayData = input(ao.rays * 16, (data) => {
          const coords = new Float32Array(data);
          for (let i = 0; i < ao.rays; i++) coords.set(rays.subarray(i * 3, i * 3 + 3), i * 4);
        });
        const result = readStorage(sampleGroups.byteLength);
        const read = new Float32Array(
          await dispatch(
            shader,
            'occlusion',
            [config, nodeData, triangleData, groupData, samples, rayData, result],
            result,
            Math.ceil(width / WIDTH),
            height,
          ),
        );
        for (const map of aoMaps) {
          const values = rows.sums[map] as Float64Array;
          for (let i = 0; i < sampleGroups.length; i++)
            if ((sampleGroups[i] as number) >= 0) values[i * 4] = read[i] as number;
        }
      });
    },
  };
}
