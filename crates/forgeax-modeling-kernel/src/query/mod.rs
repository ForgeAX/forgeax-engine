//! Mesh geometric quality, Hausdorff deviation, and inter-part clearance queries.

use std::collections::HashSet;

use crate::mesh::bvh::TriSoupBvh;
use crate::mesh::geom::{cross, length, sub, Vec3};
use crate::mesh::rewrite::triangulate_loop;
use crate::mesh::{EditMesh, NONE};

#[derive(Debug, Clone, Copy)]
pub struct HausdorffReport {
    pub max: f64,
    pub mean: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct MeshQualityReport {
    pub vertices: usize,
    pub faces: usize,
    pub boundary_edges: usize,
    pub non_manifold_edges: usize,
    pub degenerate_faces: usize,
    pub min_edge: f64,
    pub max_edge: f64,
    pub max_aspect: f64,
}

fn extract_soup(mesh: &EditMesh, faces: &[i32]) -> (Vec<f64>, Vec<u32>, Vec<Vec3>) {
    let mut pos = Vec::new();
    let mut samples = Vec::new();
    let mut idx = Vec::new();
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let fv = mesh.face_vertices(f);
        if fv.len() < 3 {
            continue;
        }
        let pts: Vec<Vec3> = fv.iter().map(|&v| mesh.position(v)).collect();
        let tris = if fv.len() == 3 {
            vec![0, 1, 2]
        } else {
            triangulate_loop(&pts).unwrap_or_default()
        };
        let base = (pos.len() / 3) as u32;
        for &p in &pts {
            pos.extend_from_slice(&p);
        }
        for ch in tris.chunks_exact(3) {
            let a = pts[ch[0]];
            let b = pts[ch[1]];
            let c = pts[ch[2]];
            idx.extend_from_slice(&[
                base + ch[0] as u32,
                base + ch[1] as u32,
                base + ch[2] as u32,
            ]);
            samples.push(a);
            samples.push(b);
            samples.push(c);
            samples.push([
                (a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0,
            ]);
        }
    }
    (pos, idx, samples)
}

pub fn hausdorff_distance(
    mesh_a: &EditMesh,
    faces_a: &[i32],
    mesh_b: &EditMesh,
    faces_b: &[i32],
) -> HausdorffReport {
    let (pa, ia, sa) = extract_soup(mesh_a, faces_a);
    let (pb, ib, sb) = extract_soup(mesh_b, faces_b);
    if ia.is_empty() || ib.is_empty() {
        return HausdorffReport {
            max: 0.0,
            mean: 0.0,
        };
    }
    let bvh_a = TriSoupBvh::build(&pa, &ia, None);
    let bvh_b = TriSoupBvh::build(&pb, &ib, None);

    let mut max_d = 0.0f64;
    let mut sum_d = 0.0f64;
    let mut count = 0usize;
    for &p in &sa {
        if let Some(nr) = bvh_b.nearest_filtered(p, f64::INFINITY, |_| true) {
            let d = nr.distance_squared.sqrt();
            max_d = max_d.max(d);
            sum_d += d;
            count += 1;
        }
    }
    for &p in &sb {
        if let Some(nr) = bvh_a.nearest_filtered(p, f64::INFINITY, |_| true) {
            let d = nr.distance_squared.sqrt();
            max_d = max_d.max(d);
            sum_d += d;
            count += 1;
        }
    }
    HausdorffReport {
        max: max_d,
        mean: if count > 0 {
            sum_d / (count as f64)
        } else {
            0.0
        },
    }
}

pub fn mesh_quality_metrics(mesh: &EditMesh, faces: &[i32]) -> MeshQualityReport {
    let mut boundary_edges = 0usize;
    let mut non_manifold_edges = 0usize;
    let mut degenerate_faces = 0usize;
    let mut min_edge = f64::INFINITY;
    let mut max_edge = 0.0f64;
    let mut max_aspect = 0.0f64;
    let mut verts = HashSet::new();
    let mut seen_e = HashSet::new();

    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let fv = mesh.face_vertices(f);
        let n = fv.len();
        if n < 3 {
            degenerate_faces += 1;
            continue;
        }
        let mut f_min = f64::INFINITY;
        let mut f_max = 0.0f64;
        let mut perim = 0.0f64;
        for i in 0..n {
            verts.insert(fv[i]);
            let d = length(sub(mesh.position(fv[(i + 1) % n]), mesh.position(fv[i])));
            f_min = f_min.min(d);
            f_max = f_max.max(d);
            perim += d;
        }
        min_edge = min_edge.min(f_min);
        max_edge = max_edge.max(f_max);
        let p0 = mesh.position(fv[0]);
        let mut area = 0.0;
        for i in 1..(n - 1) {
            let e1 = sub(mesh.position(fv[i]), p0);
            let e2 = sub(mesh.position(fv[i + 1]), p0);
            area += length(cross(e1, e2)) * 0.5;
        }
        if area <= 1e-16 || f_min <= 1e-12 {
            degenerate_faces += 1;
        } else {
            let aspect = (f_max * perim) / (4.0 * area);
            max_aspect = max_aspect.max(aspect);
        }
        for h in mesh.face_halves(f) {
            let e = h >> 1;
            if seen_e.insert(e) {
                if mesh.is_boundary_edge(e) {
                    boundary_edges += 1;
                }
                if mesh.h_face[(e * 2) as usize] == NONE
                    && mesh.h_face[(e * 2 + 1) as usize] == NONE
                {
                    non_manifold_edges += 1;
                }
            }
        }
    }
    MeshQualityReport {
        vertices: verts.len(),
        faces: faces.len(),
        boundary_edges,
        non_manifold_edges,
        degenerate_faces,
        min_edge: if min_edge.is_finite() { min_edge } else { 0.0 },
        max_edge,
        max_aspect,
    }
}
