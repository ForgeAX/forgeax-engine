enable wgpu_ray_query;

@group(0) @binding(0)
var scene: acceleration_structure;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fragment_main() -> @location(0) vec4<u32> {
    var query: ray_query;
    rayQueryInitialize(
        &query,
        scene,
        RayDesc(0u, 0xffu, 0.01, 10.0, vec3<f32>(0.0, 0.0, 2.0), vec3<f32>(0.0, 0.0, -1.0)),
    );
    while rayQueryProceed(&query) {}
    let hit = rayQueryGetCommittedIntersection(&query);
    return vec4<u32>(hit.kind, hit.instance_custom_data, hit.geometry_index, bitcast<u32>(hit.t));
}
