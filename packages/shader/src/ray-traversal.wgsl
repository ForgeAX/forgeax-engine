#define_import_path forgeax_ray::traversal

struct Triangle { a: vec4f, b: vec4f, c: vec4f, ids: vec4u, maskData: vec4u }
// Inner nodes: left child is the next node, `right` the far subtree, `axis` the split axis.
struct Node { lo: vec3f, escape: u32, hi: vec3f, first: u32, count: u32, right: u32, axis: u32, padding: u32 }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, maskData: vec4u }
struct Hit { ids: vec4u, metrics: vec4f }
// Zero direction components become tiny signed values: the slab test stays finite
// and conservative without relying on IEEE infinities.
fn inverseDirection(direction: vec3f) -> vec3f {
  let tiny = select(vec3f(1e-20), vec3f(-1e-20), direction < vec3f(0.0));
  return 1.0 / select(direction, tiny, abs(direction) < vec3f(1e-20));
}
fn boxHit(origin: vec3f, inverse: vec3f, node: Node, minimum: f32, maximum: f32) -> bool {
  let a = (node.lo - origin) * inverse;
  let b = (node.hi - origin) * inverse;
  let near = max(max(minimum, min(a.x, b.x)), max(min(a.y, b.y), min(a.z, b.z)));
  let far = min(min(maximum, max(a.x, b.x)), min(max(a.y, b.y), max(a.z, b.z)));
  // The slab distances and the triangle test round differently, so a box holding
  // a surface tied with `closest` can enter one ulp past it. Culling that box would
  // drop lower-index ties and break the total (t, triangle) order the cursor
  // relies on; the robust-traversal bound 1 + 2*gamma(3) keeps it.
  return near <= far * 1.0000004;
}
struct TraceResult { hit: Hit, triangleIndex: u32 }
const TRACE_CLOSEST = 0u;
// Return the first opaque (maskData.z == 0) hit, else the closest coverage candidate.
const TRACE_ANY_OPAQUE = 1u;
// Return the first hit of any triangle.
const TRACE_ANY = 2u;
const TRAVERSAL_STACK = 64u;
// Cursor is a (distance, ordered triangle) pair. Advancing tMin would lose
// coplanar or very closely layered surfaces after a rejected alpha candidate.
// Ordered depth-first traversal: the child on the ray's near side of the split is
// visited first, so `closest` prunes the far subtree. The (t, triangle) order is
// total, so the result is independent of visit order.
fn traceQuery(ray: Ray, afterT: f32, afterTriangle: u32, mode: u32) -> TraceResult {
  var triangleIndex = 0xffffffffu;
  var result = Hit(vec4u(0xffffffffu), vec4f(-1.0, 0.0, 0.0, 0.0));
  var closest = ray.tMax;
  let inverse = inverseDirection(ray.direction);
  var stack: array<u32, TRAVERSAL_STACK>;
  var top = 0u;
  var nodeIndex = 0u;
  let count = arrayLength(&nodes);
  loop {
    if (nodeIndex < count) {
      let node = nodes[nodeIndex];
      if (boxHit(ray.origin, inverse, node, ray.tMin, closest)) {
        if (node.count == 0u && node.right > nodeIndex && node.right < count) {
          var near = nodeIndex + 1u; var far = node.right;
          if (ray.direction[min(node.axis, 2u)] < 0.0) { near = node.right; far = nodeIndex + 1u; }
          // The builder bounds depth below TRAVERSAL_STACK (scene.ts BVH_SAH_DEPTH).
          stack[min(top, TRAVERSAL_STACK - 1u)] = far; top = min(top + 1u, TRAVERSAL_STACK);
          nodeIndex = near; continue;
        }
        for (var i = node.first; i < node.first + node.count; i++) {
          let triangle = triangles[i];
          if ((triangle.maskData.x & ray.maskData.x) == 0u) { continue; }
          let e1 = triangle.b.xyz - triangle.a.xyz;
          let e2 = triangle.c.xyz - triangle.a.xyz;
          let p = cross(ray.direction, e2); let det = dot(e1, p);
          if (det == 0.0 || (triangle.maskData.y == 1u && det < 0.0) || (triangle.maskData.y == 2u && det > 0.0)) { continue; }
          let s = ray.origin - triangle.a.xyz;
          let u = dot(s, p) / det;
          let q = cross(s, e1); let v = dot(ray.direction, q) / det;
          let t = dot(e2, q) / det;
          if (u < 0.0 || v < 0.0 || u + v > 1.0 || t < ray.tMin || t > closest) { continue; }
          if (afterTriangle != 0xffffffffu && (t < afterT || (t == afterT && i <= afterTriangle))) { continue; }
          if (result.ids.x != 0xffffffffu && t == closest && i >= triangleIndex) { continue; }
          let hit = Hit(triangle.ids, vec4f(t, u, v, select(0.0, 1.0, det > 0.0)));
          if (mode == TRACE_ANY || (mode == TRACE_ANY_OPAQUE && triangle.maskData.z == 0u)) {
            return TraceResult(hit, i);
          }
          closest = t;
          triangleIndex = i;
          result = hit;
        }
      }
    }
    if (top == 0u) { break; }
    top--;
    nodeIndex = stack[top];
  }
  return TraceResult(result, triangleIndex);
}
fn traceReferenceAfter(ray: Ray, afterT: f32, afterTriangle: u32) -> TraceResult {
  return traceQuery(ray, afterT, afterTriangle, TRACE_CLOSEST);
}
fn traceOccluder(ray: Ray, afterT: f32, afterTriangle: u32) -> TraceResult {
  return traceQuery(ray, afterT, afterTriangle, TRACE_ANY_OPAQUE);
}
fn traceAny(ray: Ray) -> TraceResult {
  return traceQuery(ray, 0.0, 0xffffffffu, TRACE_ANY);
}
fn traceReference(ray: Ray) -> TraceResult {
  return traceQuery(ray, 0.0, 0xffffffffu, TRACE_CLOSEST);
}

@group(0) @binding(0) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
