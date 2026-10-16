enable wgpu_ray_query;

struct Observation {
    kind: u32,
    t: f32,
    instance_custom_data: u32,
    instance_index: u32,
    candidate_kind: u32,
    geometry_index: u32,
    primitive_index: u32,
    barycentrics: vec2<f32>,
    front_face: u32,
    object_to_world: mat4x3<f32>,
    world_to_object: mat4x3<f32>,
}

@group(0) @binding(0)
var scene: acceleration_structure;

@group(0) @binding(1)
var<storage, read_write> observation: Observation;

@compute @workgroup_size(1)
fn main() {
    var query: ray_query;
    rayQueryInitialize(
        &query,
        scene,
        RayDesc(0u, 0xffu, 0.01, 10.0, vec3<f32>(0.0, 0.0, 2.0), vec3<f32>(0.0, 0.0, -1.0)),
    );
    var candidate_kind = 0u;
    while rayQueryProceed(&query) {
        let candidate = rayQueryGetCandidateIntersection(&query);
        candidate_kind = candidate.kind;
        if candidate.kind == RAY_QUERY_INTERSECTION_AABB {
            rayQueryGenerateIntersection(&query, 1.0);
        }
    }
    let hit = rayQueryGetCommittedIntersection(&query);
    observation = Observation(
        hit.kind,
        hit.t,
        hit.instance_custom_data,
        hit.instance_index,
        candidate_kind,
        hit.geometry_index,
        hit.primitive_index,
        hit.barycentrics,
        u32(hit.front_face),
        hit.object_to_world,
        hit.world_to_object,
    );
}
