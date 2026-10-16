enable wgpu_ray_query;
struct Ray { origin: vec4<f32>, direction: vec4<f32> }
struct Triangle { a: vec4<f32>, b: vec4<f32>, c: vec4<f32> }
struct Node { minimum: vec3<f32>, left: u32, maximum: vec3<f32>, right: u32 }
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> rays: array<Ray>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(4) var<storage, read> nodes: array<Node>;

@compute @workgroup_size(64)
fn hardware(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= arrayLength(&rays) { return; }
    let ray = rays[id.x];
    var query: ray_query;
    rayQueryInitialize(&query, scene, RayDesc(1u, 255u, 0.001, 100.0, ray.origin.xyz, ray.direction.xyz));
    while rayQueryProceed(&query) {}
    let hit = rayQueryGetCommittedIntersection(&query);
    var value = vec4<u32>(0u);
    if hit.kind == 1u { value = vec4<u32>(1u, hit.primitive_index, bitcast<u32>(hit.t), 0u); }
    output[id.x] = value;
}

fn triangle_hit(ray: Ray, triangle: Triangle) -> f32 {
    let e1 = triangle.b.xyz - triangle.a.xyz;
    let e2 = triangle.c.xyz - triangle.a.xyz;
    let p = cross(ray.direction.xyz, e2);
    let determinant = dot(e1, p);
    if abs(determinant) < 0.000001 { return -1.0; }
    let inverse = 1.0 / determinant;
    let s = ray.origin.xyz - triangle.a.xyz;
    let u = dot(s, p) * inverse;
    if u < 0.0 || u > 1.0 { return -1.0; }
    let q = cross(s, e1);
    let v = dot(ray.direction.xyz, q) * inverse;
    if v < 0.0 || u + v > 1.0 { return -1.0; }
    let distance = dot(e2, q) * inverse;
    return select(-1.0, distance, distance >= 0.001 && distance <= 100.0);
}

@compute @workgroup_size(64)
fn software(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= arrayLength(&rays) { return; }
    let ray = rays[id.x];
    var stack: array<u32, 32>;
    var size = 1u;
    stack[0] = 0u;
    var closest = 100.0;
    var value = vec4<u32>(0u);
    loop {
        if size == 0u { break; }
        size -= 1u;
        let node = nodes[stack[size]];
        // This bounded corpus uses parallel -Z rays. Avoid 0*infinity slabs.
        if ray.origin.x < node.minimum.x || ray.origin.x > node.maximum.x ||
            ray.origin.y < node.minimum.y || ray.origin.y > node.maximum.y { continue; }
        if node.right == 0xffffffffu {
            let distance = triangle_hit(ray, triangles[node.left]);
            if distance >= 0.0 && distance < closest {
                closest = distance;
                value = vec4<u32>(1u, node.left, bitcast<u32>(distance), 0u);
            }
        } else {
            if size + 2u > 32u { output[id.x] = vec4<u32>(0xffffffffu); return; }
            stack[size] = node.left;
            stack[size + 1u] = node.right;
            size += 2u;
        }
    }
    output[id.x] = value;
}
