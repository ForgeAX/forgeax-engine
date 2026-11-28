//! Geodesic voxel & Euclidean heat bone weight binding (`skin.bind`, 4 influences per vertex).

use std::collections::VecDeque;

use crate::error::KernelError;
use crate::mesh::geom::{dot, length, sub, Vec3};
use crate::mesh::EditMesh;

pub const SKIN_INFLUENCES: usize = 4;

#[derive(Debug, Clone)]
pub struct SkinBone {
    pub root: Vec3,
    pub tips: Vec<Vec3>,
}

#[derive(Debug, Clone)]
pub struct SkinWeights {
    /// Vertex high-water stride `SKIN_INFLUENCES`: `[joint0, joint1, joint2, joint3]`
    pub joints: Vec<u16>,
    /// Normalized weights matching `joints`, sum = 1.0 per alive vertex
    pub weights: Vec<f32>,
}

#[inline]
pub fn segment_distance(p: Vec3, a: Vec3, b: Vec3) -> f64 {
    let m = sub(b, a);
    let t = sub(p, a);
    let c1 = dot(m, t);
    if c1 <= 0.0 {
        return length(t);
    }
    let c2 = dot(m, m);
    if c2 <= c1 {
        return length(sub(p, b));
    }
    let s = c1 / c2;
    let q = [t[0] - m[0] * s, t[1] - m[1] * s, t[2] - m[2] * s];
    length(q)
}

#[inline]
pub fn bone_distance(bone: &SkinBone, p: Vec3) -> f64 {
    if bone.tips.is_empty() {
        return length(sub(p, bone.root));
    }
    let mut best = f64::INFINITY;
    for &tip in &bone.tips {
        best = best.min(segment_distance(p, bone.root, tip));
    }
    best
}

/// Bind vertices cleanly to `bones` with geodesic interior BFS distance propagation +
/// inverse-power falloff (`falloff` default ~4.0), producing up to 4 normalized influences per vertex.
pub fn bind_skin_geodesic(
    mesh: &EditMesh,
    bones: &[SkinBone],
    falloff: f64,
    grid_res: usize,
) -> Result<SkinWeights, KernelError> {
    if bones.is_empty() {
        return Err(KernelError::invalid_value(
            "bones",
            "requires at least one bone",
        ));
    }
    let n_verts = mesh.vertex_high_water.max(0) as usize;
    let mut joints = vec![0u16; n_verts * SKIN_INFLUENCES];
    let mut weights = vec![0.0f32; n_verts * SKIN_INFLUENCES];
    let pow = falloff.clamp(0.5, 16.0);

    // Optional voxel occupancy geodesic refinement along vertex mesh graph + spatial grid
    let res = grid_res.clamp(8, 64);
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for v in mesh.vertices() {
        let p = mesh.position(v);
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let extent = (hi[0] - lo[0])
        .max(hi[1] - lo[1])
        .max(hi[2] - lo[2])
        .max(1e-6);
    let step = extent / (res as f64);

    // Build vertex adjacency graph for fast geodesic propagation inside each connected island
    let mut adj: Vec<Vec<(i32, f64)>> = vec![Vec::new(); n_verts];
    for e in mesh.edges() {
        let [a, b] = mesh.edge_vertices(e);
        let d = length(sub(mesh.position(a), mesh.position(b))).max(1e-9);
        adj[a as usize].push((b, d));
        adj[b as usize].push((a, d));
    }

    // For moderate bone counts, run multi-seed surface distance wave or direct bone_distance + graph blend
    let alive_verts = mesh.vertices();
    let mut bone_dists: Vec<Vec<f64>> = Vec::with_capacity(bones.len());
    for b in bones {
        let mut dist = vec![f64::INFINITY; n_verts];
        let mut q = VecDeque::new();
        // Seed closest vertices to bone segment within `1.5 * step`
        let mut best_v = None;
        let mut best_d = f64::INFINITY;
        for &v in &alive_verts {
            let d = bone_distance(b, mesh.position(v));
            if d < best_d {
                best_d = d;
                best_v = Some(v);
            }
            if d <= step * 1.5 {
                dist[v as usize] = d;
                q.push_back(v);
            }
        }
        if q.is_empty() {
            if let Some(bv) = best_v {
                dist[bv as usize] = best_d;
                q.push_back(bv);
            }
        }
        while let Some(u) = q.pop_front() {
            let du = dist[u as usize];
            for &(v, w) in &adj[u as usize] {
                let nd = du + w;
                if nd + 1e-12 < dist[v as usize] {
                    dist[v as usize] = nd;
                    q.push_back(v);
                }
            }
        }
        bone_dists.push(dist);
    }

    for &v in &alive_verts {
        let p = mesh.position(v);
        let mut scored: Vec<(usize, f64)> = bones
            .iter()
            .enumerate()
            .map(|(bi, b)| {
                let d_euc = bone_distance(b, p);
                let d_geo = bone_dists[bi][v as usize];
                let d = if d_geo.is_finite() {
                    0.5 * (d_euc + d_geo)
                } else {
                    d_euc
                };
                let w = 1.0 / (d.max(1e-5)).powf(pow);
                (bi, w)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(SKIN_INFLUENCES);
        let sum: f64 = scored.iter().map(|s| s.1).sum();
        let base = (v as usize) * SKIN_INFLUENCES;
        if sum > 0.0 {
            for (k, &(bi, w)) in scored.iter().enumerate() {
                joints[base + k] = bi as u16;
                weights[base + k] = (w / sum) as f32;
            }
        } else {
            joints[base] = 0;
            weights[base] = 1.0;
        }
    }

    Ok(SkinWeights { joints, weights })
}
