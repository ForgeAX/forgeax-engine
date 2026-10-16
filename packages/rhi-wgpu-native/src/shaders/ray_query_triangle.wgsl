enable wgpu_ray_query;

struct Uniforms {
    view_inverse: mat4x4<f32>,
    projection_inverse: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var output: texture_storage_2d<rgba8unorm, write>;

@group(0) @binding(2)
var scene: acceleration_structure;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let size = textureDimensions(output);
    if any(global_id.xy >= size) {
        return;
    }

    let pixel_center = vec2<f32>(global_id.xy) + vec2<f32>(0.5);
    let uv = pixel_center / vec2<f32>(size);
    let clip = uv * 2.0 - 1.0;
    let origin = (uniforms.view_inverse * vec4<f32>(0.0, 0.0, 0.0, 1.0)).xyz;
    let projected = uniforms.projection_inverse * vec4<f32>(clip.x, clip.y, 1.0, 1.0);
    let direction = (uniforms.view_inverse * vec4<f32>(normalize(projected.xyz), 0.0)).xyz;

    var query: ray_query;
    rayQueryInitialize(&query, scene, RayDesc(0u, 0xffu, 0.1, 200.0, origin, direction));
    rayQueryProceed(&query);
    let hit = rayQueryGetCommittedIntersection(&query);
    var color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    if hit.kind != RAY_QUERY_INTERSECTION_NONE {
        color = vec4<f32>(
            hit.barycentrics,
            1.0 - hit.barycentrics.x - hit.barycentrics.y,
            1.0,
        );
    }
    textureStore(output, global_id.xy, color);
}
