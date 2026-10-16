#define_import_path forgeax_ray::query
#import forgeax_ray::traversal::{Ray, Hit, traceReference}

@group(0) @binding(2) var<storage, read> rays: array<Ray>;
@group(0) @binding(3) var<storage, read_write> hits: array<Hit>;
@compute @workgroup_size(64) fn queryTriangles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  hits[id.x] = traceReference(rays[id.x]).hit;
}
