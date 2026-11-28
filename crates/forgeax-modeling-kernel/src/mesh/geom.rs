//! Double-precision geometry helpers for EditMesh operations and selectors.

use super::{EditMesh, NONE};

pub type Vec3 = [f64; 3];

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
pub fn length(a: Vec3) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

#[inline]
pub fn normalize(a: Vec3) -> Vec3 {
    let l = length(a);
    if l > 0.0 && l.is_finite() {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// Newell polygon normal (unnormalized; length = 2 * polygon area).
pub fn newell(points: &[Vec3]) -> Vec3 {
    let mut n = [0.0f64; 3];
    let len = points.len();
    for i in 0..len {
        let a = points[i];
        let b = points[(i + 1) % len];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

pub fn face_newell(mesh: &EditMesh, f: i32) -> Vec3 {
    let start = mesh.f_half[f as usize];
    if start == NONE {
        return [0.0, 0.0, 0.0];
    }
    let mut n = [0.0f64; 3];
    let mut h = start;
    loop {
        let next = mesh.h_next[h as usize];
        let a = mesh.position(mesh.h_vert[h as usize]);
        let b = mesh.position(mesh.h_vert[next as usize]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
        h = next;
        if h == start {
            break;
        }
    }
    n
}

pub fn face_normal(mesh: &EditMesh, f: i32) -> Vec3 {
    normalize(face_newell(mesh, f))
}

pub fn face_area(mesh: &EditMesh, f: i32) -> f64 {
    length(face_newell(mesh, f)) * 0.5
}

pub fn face_centroid(mesh: &EditMesh, f: i32) -> Vec3 {
    let start = mesh.f_half[f as usize];
    if start == NONE {
        return [0.0, 0.0, 0.0];
    }
    let mut sum = [0.0f64; 3];
    let mut count = 0usize;
    let mut h = start;
    loop {
        let p = mesh.position(mesh.h_vert[h as usize]);
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
        count += 1;
        h = mesh.h_next[h as usize];
        if h == start {
            break;
        }
    }
    if count == 0 {
        [0.0, 0.0, 0.0]
    } else {
        scale(sum, 1.0 / (count as f64))
    }
}

pub fn is_closed(mesh: &EditMesh) -> bool {
    let mut has_edge = false;
    let edge_hw = mesh.half_high_water / 2;
    for e in 0..edge_hw {
        if mesh.is_edge_alive(e) {
            has_edge = true;
            if mesh.is_boundary_edge(e) {
                return false;
            }
        }
    }
    has_edge
}

pub fn volume_about(mesh: &EditMesh, pivot: Vec3) -> f64 {
    let mut vol = 0.0;
    for f in 0..mesh.face_high_water {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let verts = mesh.face_vertices(f);
        if verts.len() < 3 {
            continue;
        }
        let p0 = sub(mesh.position(verts[0]), pivot);
        for i in 1..(verts.len() - 1) {
            let pi = sub(mesh.position(verts[i]), pivot);
            let pj = sub(mesh.position(verts[i + 1]), pivot);
            vol += dot(p0, cross(pi, pj)) / 6.0;
        }
    }
    vol
}

pub fn signed_axis_vector(axis_id: u8) -> Option<Vec3> {
    match axis_id {
        0 => Some([1.0, 0.0, 0.0]),
        1 => Some([-1.0, 0.0, 0.0]),
        2 => Some([0.0, 1.0, 0.0]),
        3 => Some([0.0, -1.0, 0.0]),
        4 => Some([0.0, 0.0, 1.0]),
        5 => Some([0.0, 0.0, -1.0]),
        _ => None,
    }
}

pub fn unsigned_axis_vector(axis_id: u8) -> Option<Vec3> {
    match axis_id {
        0 => Some([1.0, 0.0, 0.0]),
        1 => Some([0.0, 1.0, 0.0]),
        2 => Some([0.0, 0.0, 1.0]),
        _ => None,
    }
}
