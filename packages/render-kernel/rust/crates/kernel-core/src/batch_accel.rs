//! Bulk numerical hot-path accelerators directly consumable by `@forgeax/engine-render`
//! for zero-GC batch culling, world-AABB derivation, transparent depth sorting, and
//! integer PSO/material-slot lookup (switchable between TS and Rust WASM).

use crate::cull::{aabb_intersects_frustum, extract_frustum_planes};
use crate::scene::transform_aabb;

/// Bulk Arvo AABB transform + frustum cull over packed columns.
/// - `local_aabbs`: `count * 6` floats (`[minX, minY, minZ, maxX, maxY, maxZ]`)
/// - `world_matrices`: `count * 16` floats (column-major)
/// - `flags`: `count` u32s (`bit0=visible, bit1=frustumCulled, bit2=castShadow`)
/// - `layer_masks`: `count` u32s
/// - `camera_vp`: 16 floats (column-major)
/// - `out_visible_indices`: preallocated `count` u32s
/// - `out_world_aabbs`: optional `count * 6` floats (if non-empty, receives computed world AABBs)
/// Returns number of visible indices written to `out_visible_indices`.
#[allow(clippy::too_many_arguments)]
pub fn batch_transform_and_cull(
    count: usize,
    local_aabbs: &[f32],
    world_matrices: &[f32],
    flags: &[u32],
    layer_masks: &[u32],
    camera_vp: &[f32; 16],
    camera_layer_mask: u32,
    shadow_caster_only: bool,
    out_visible_indices: &mut [u32],
    out_world_aabbs: &mut [f32],
) -> usize {
    let planes = extract_frustum_planes(camera_vp);
    let write_aabbs = out_world_aabbs.len() >= count * 6;
    let mut out_count = 0usize;

    for i in 0..count {
        let f = flags[i];
        if (f & 1) == 0 {
            continue;
        }
        if (layer_masks[i] & camera_layer_mask) == 0 {
            continue;
        }
        if shadow_caster_only && (f & 4) == 0 {
            continue;
        }
        let ab = i * 6;
        let mb = i * 16;
        let mut m = [0.0f32; 16];
        m.copy_from_slice(&world_matrices[mb..mb + 16]);
        let (wmin, wmax) = transform_aabb(
            [local_aabbs[ab], local_aabbs[ab + 1], local_aabbs[ab + 2]],
            [local_aabbs[ab + 3], local_aabbs[ab + 4], local_aabbs[ab + 5]],
            &m,
        );
        if write_aabbs {
            out_world_aabbs[ab] = wmin[0];
            out_world_aabbs[ab + 1] = wmin[1];
            out_world_aabbs[ab + 2] = wmin[2];
            out_world_aabbs[ab + 3] = wmax[0];
            out_world_aabbs[ab + 4] = wmax[1];
            out_world_aabbs[ab + 5] = wmax[2];
        }
        if (f & 2) != 0 && !aabb_intersects_frustum(wmin, wmax, &planes) {
            continue;
        }
        if out_count < out_visible_indices.len() {
            out_visible_indices[out_count] = i as u32;
            out_count += 1;
        }
    }
    out_count
}

/// Bulk multi-camera frustum cull over precomputed world-space AABBs.
/// - `world_aabbs`: `count * 6` floats (`[minX, minY, minZ, maxX, maxY, maxZ]`)
/// - `frustum_planes`: `camera_count * 24` floats (6 planes x 4 floats `[nx, ny, nz, d]` per camera)
/// - `out_vis_bits`: `(count + 31) / 32` u32 bitmask (`bit = 1` if visible in any camera frustum)
/// Returns the number of visible AABBs.
pub fn batch_cull_world_aabbs(
    count: usize,
    world_aabbs: &[f32],
    camera_count: usize,
    frustum_planes: &[f32],
    out_vis_bits: &mut [u32],
) -> usize {
    let words = count.div_ceil(32);
    for w in out_vis_bits.iter_mut().take(words) {
        *w = 0;
    }
    if count == 0 {
        return 0;
    }
    if camera_count == 0 {
        for i in 0..count {
            out_vis_bits[i >> 5] |= 1u32 << (i & 31);
        }
        return count;
    }

    let mut visible_count = 0usize;
    for i in 0..count {
        let ab = i * 6;
        let bx = world_aabbs[ab];
        let by = world_aabbs[ab + 1];
        let bz = world_aabbs[ab + 2];
        let b_x = world_aabbs[ab + 3];
        let b_y = world_aabbs[ab + 4];
        let b_z = world_aabbs[ab + 5];

        let mut visible = false;
        for cam in 0..camera_count {
            let base = cam * 24;
            let mut inside = true;
            for p in 0..6 {
                let off = base + p * 4;
                let nx = frustum_planes[off];
                let ny = frustum_planes[off + 1];
                let nz = frustum_planes[off + 2];
                let d = frustum_planes[off + 3];
                let px = if nx >= 0.0 { b_x } else { bx };
                let py = if ny >= 0.0 { b_y } else { by };
                let pz = if nz >= 0.0 { b_z } else { bz };
                if nx * px + ny * py + nz * pz + d < 0.0 {
                    inside = false;
                    break;
                }
            }
            if inside {
                visible = true;
                break;
            }
        }
        if visible {
            out_vis_bits[i >> 5] |= 1u32 << (i & 31);
            visible_count += 1;
        }
    }
    visible_count
}

/// Bulk transparent distance-sort key evaluation and stable index sort using a caller-owned scratch buffer.
pub fn batch_sort_transparent_into(
    count: usize,
    positions_xyz: &[f32],
    layers: &[i32],
    ties: &[u32],
    eye: [f32; 3],
    out_order: &mut [u32],
    scratch: &mut Vec<(i32, u32, u32, u32)>,
) {
    let n = count.min(out_order.len());
    scratch.clear();
    if scratch.capacity() < n {
        scratch.reserve(n - scratch.capacity());
    }
    for i in 0..n {
        let b = i * 3;
        let dx = positions_xyz[b] - eye[0];
        let dy = positions_xyz[b + 1] - eye[1];
        let dz = positions_xyz[b + 2] - eye[2];
        let dist_sq = dx * dx + dy * dy + dz * dz;
        // Back-to-front: larger dist_sq sorts first => invert IEEE-754 positive float bits
        let inv_dist_bits = !dist_sq.to_bits();
        scratch.push((layers[i], inv_dist_bits, ties[i], i as u32));
    }
    scratch.sort_unstable();
    for (dst, entry) in scratch.iter().enumerate() {
        out_order[dst] = entry.3;
    }
}

/// Bulk transparent distance-sort key evaluation and stable index sort.
/// - `positions_xyz`: `count * 3` floats (`[x, y, z]`)
/// - `layers`: `count` i32s
/// - `ties`: `count` u32s
/// - `out_order`: `count` u32s (receives sorted indices in back-to-front order)
pub fn batch_sort_transparent(
    count: usize,
    positions_xyz: &[f32],
    layers: &[i32],
    ties: &[u32],
    eye: [f32; 3],
    out_order: &mut [u32],
) {
    let mut scratch = Vec::with_capacity(count.min(out_order.len()));
    batch_sort_transparent_into(
        count,
        positions_xyz,
        layers,
        ties,
        eye,
        out_order,
        &mut scratch,
    );
}
