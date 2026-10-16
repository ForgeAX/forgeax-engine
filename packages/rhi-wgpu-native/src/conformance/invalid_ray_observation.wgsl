enable wgpu_ray_query;

struct InvalidValues {
    nan: f32,
    infinity: f32,
    invalid_flags: u32,
    _padding: u32,
}

@group(0) @binding(0)
var scene: acceleration_structure;

@group(0) @binding(1)
var<storage, read> invalid: InvalidValues;

fn consume(desc: RayDesc) {
    var query: ray_query;
    rayQueryInitialize(&query, scene, desc);
    while rayQueryProceed(&query) {}
    let hit = rayQueryGetCommittedIntersection(&query);
}

@compute @workgroup_size(1)
fn main() {
    consume(RayDesc(0u, 0xffu, 0.01, 10.0, vec3<f32>(invalid.nan, 0.0, 2.0), vec3<f32>(0.0, 0.0, -1.0)));
    consume(RayDesc(0u, 0xffu, 0.01, 10.0, vec3<f32>(0.0, 0.0, 2.0), vec3<f32>(0.0, invalid.infinity, -1.0)));
    consume(RayDesc(0u, 0xffu, 0.01, 10.0, vec3<f32>(0.0, 0.0, 2.0), vec3<f32>(0.0)));
    consume(RayDesc(0u, 0xffu, 10.0, 0.01, vec3<f32>(0.0, 0.0, 2.0), vec3<f32>(0.0, 0.0, -1.0)));
    consume(RayDesc(invalid.invalid_flags, 0xffu, 0.01, 10.0, vec3<f32>(0.0, 0.0, 2.0), vec3<f32>(0.0, 0.0, -1.0)));
}
