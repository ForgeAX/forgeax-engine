enable wgpu_ray_query;
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, maskData: vec4u }
struct Hit { ids: vec4u, metrics: vec4f }
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> rays: array<Ray>;
@group(0) @binding(2) var<storage, read> identities: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> hits: array<Hit>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  let ray = rays[id.x];
  var query: ray_query;
  rayQueryInitialize(&query, scene, RayDesc(0u, ray.maskData.x, ray.tMin, ray.tMax, ray.origin, ray.direction));
  while (rayQueryProceed(&query)) {}
  let hit = rayQueryGetCommittedIntersection(&query);
  var result = Hit(vec4u(0xffffffffu), vec4f(-1.0, 0.0, 0.0, 0.0));
  if (hit.kind == 1u) {
    result = Hit(identities[hit.instance_custom_data + hit.primitive_index], vec4f(hit.t, hit.barycentrics, select(0.0, 1.0, hit.front_face)));
  }
  hits[id.x] = result;
}
