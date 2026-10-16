enable wgpu_ray_query;
enable wgpu_ray_query_vertex_return;
@group(0) @binding(0) var scene: acceleration_structure<vertex_return>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main() {
    var query: ray_query<vertex_return>;
    rayQueryInitialize(&query, scene, RayDesc(0u, 255u, 0.0, 10.0, vec3f(3.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0)));
    while rayQueryProceed(&query) {
        let candidate = getCandidateHitVertexPositions(&query);
        for (var i = 0u; i < 3u; i++) { output[i] = vec4f(candidate[i], 1.0); }
        rayQueryConfirmIntersection(&query);
    }
    let committed = getCommittedHitVertexPositions(&query);
    for (var i = 0u; i < 3u; i++) { output[3u + i] = vec4f(committed[i], 1.0); }
    rayQueryInitialize(&query, scene, RayDesc(0u, 255u, 0.0, 10.0, vec3f(100.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0)));
    while rayQueryProceed(&query) { rayQueryConfirmIntersection(&query); }
    let miss = getCommittedHitVertexPositions(&query);
    for (var i = 0u; i < 3u; i++) { output[6u + i] = vec4f(miss[i], 0.0); }
}
