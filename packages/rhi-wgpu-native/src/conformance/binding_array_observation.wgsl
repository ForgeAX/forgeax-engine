enable wgpu_ray_query;
enable wgpu_binding_array;

struct InputRay {
    origin_t_min: vec4<f32>,
    direction_t_max: vec4<f32>,
    flags_mask: vec4<u32>,
}

struct Observation {
    kind: u32,
    t: f32,
    instance_custom_data: u32,
    instance_index: u32,
    sbt_record_offset: u32,
    geometry_index: u32,
    primitive_index: u32,
    barycentrics: vec2<f32>,
    front_face: u32,
    object_to_world: mat4x3<f32>,
    world_to_object: mat4x3<f32>,
}

@group(0) @binding(0)
var scenes: binding_array<acceleration_structure, 2>;

@group(0) @binding(1)
var<storage, read> rays: array<InputRay>;

@group(0) @binding(2)
var<storage, read_write> observations: array<Observation>;

@compute @workgroup_size(1)
fn main(@builtin(workgroup_id) id: vec3<u32>) {
    let index = id.x;
    let ray = rays[index];
    var query: ray_query;
    rayQueryInitialize(
        &query,
        scenes[index],
        RayDesc(
            ray.flags_mask.x,
            ray.flags_mask.y,
            ray.origin_t_min.w,
            ray.direction_t_max.w,
            ray.origin_t_min.xyz,
            ray.direction_t_max.xyz,
        ),
    );
    while rayQueryProceed(&query) {}
    let hit = rayQueryGetCommittedIntersection(&query);
    observations[index] = Observation(
        hit.kind,
        hit.t,
        hit.instance_custom_data,
        hit.instance_index,
        hit.sbt_record_offset,
        hit.geometry_index,
        hit.primitive_index,
        hit.barycentrics,
        u32(hit.front_face),
        hit.object_to_world,
        hit.world_to_object,
    );
}
