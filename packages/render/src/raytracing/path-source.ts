import type { RayPathInitialRay } from './path-input';

/** Same five vec4 lanes as PathState: origin/cone, direction/spread, throughput,
 * radiance/error, activity/depth/RNG. Immutable seeds are copied per sample. */
export function packInitialPathRays(rays: readonly RayPathInitialRay[], seed: number): Uint8Array {
  const bytes = new Uint8Array(rays.length * 80);
  const floats = new Float32Array(bytes.buffer),
    words = new Uint32Array(bytes.buffer);
  rays.forEach((ray, i) => {
    const base = i * 20;
    floats.set([...ray.origin, ray.coneWidth, ...ray.direction, ray.coneSpread, 1, 1, 1, 0], base);
    words.set([Number(ray.active), 0, seed, 0], base + 16);
  });
  return bytes;
}

// Raw vec4 lanes preserve the existing PathState/Accumulation ABI without a
// second material or traversal kernel. The common trace/material/shade follows.
export const INITIAL_PATH_RAYS_WGSL = `
@group(0) @binding(0) var<storage, read> seeds: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> paths: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> accumulation: array<vec4u>;
@compute @workgroup_size(64) fn generateInitialRays(@builtin(global_invocation_id) id: vec3u) {
  let base = id.x * 5u;
  if (base >= arrayLength(&paths)) { return; }
  for (var i = 0u; i < 5u; i++) { paths[base + i] = seeds[base + i]; }
  paths[base + 4u].z = ((id.x + 1u) * 2654435761u) ^ ((accumulation[base].w + 1u) * 2246822519u) ^ seeds[base + 4u].z;
  accumulation[base + 2u] = vec4u(0u);
  accumulation[base + 3u] = vec4u(0u, 0u, 0u, bitcast<u32>(-1.0));
  accumulation[base + 4u] = vec4u(0xffffffffu);
}
`;
