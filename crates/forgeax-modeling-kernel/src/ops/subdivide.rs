//! Direct in-memory Catmull-Clark and Simple subdivision over `mesh::EditMesh`
//! with DeRose semi-sharp creases and zero FXEM serialization round-trips.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{face_centroid, Vec3};
use crate::mesh::{CornerChannelKind, EditMesh, CHANNEL_COUNT, EDGE_SHARP, NONE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SubdivisionScheme {
    CatmullClark = 0,
    Simple = 1,
}

impl SubdivisionScheme {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::CatmullClark),
            1 => Some(Self::Simple),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SubdivisionBoundary {
    EdgeOnly = 0,
    EdgeAndCorner = 1,
}

impl SubdivisionBoundary {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::EdgeOnly),
            1 => Some(Self::EdgeAndCorner),
            _ => None,
        }
    }
}

fn crease_weights(sharpnesses_desc: &[f64]) -> (f64, f64) {
    let s1 = sharpnesses_desc.get(1).copied().unwrap_or(0.0);
    let s2 = sharpnesses_desc.get(2).copied().unwrap_or(0.0);
    (s1.clamp(0.0, 1.0), s2.clamp(0.0, 1.0))
}

fn average_vec3(points: &[Vec3]) -> Vec3 {
    let mut sum = [0.0f64; 3];
    for p in points {
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
    }
    let inv = 1.0 / (points.len() as f64);
    [sum[0] * inv, sum[1] * inv, sum[2] * inv]
}

fn vertex_point(
    mesh: &EditMesh,
    v: i32,
    corners: &[i32],
    selected: &[u8],
    face_points: &HashMap<i32, Vec3>,
    boundary: SubdivisionBoundary,
    sharp: &[f64],
) -> Vec3 {
    let p = mesh.position(v);
    let mut edges_set = HashSet::new();
    for &h in corners {
        if selected[mesh.h_face[h as usize] as usize] == 0 {
            return p;
        }
        edges_set.insert(h >> 1);
        edges_set.insert(mesh.h_prev[h as usize] >> 1);
    }
    let mut creases: Vec<i32> = edges_set
        .iter()
        .copied()
        .filter(|&e| sharp[e as usize] > 0.0)
        .collect();
    creases.sort_by(|&x, &y| {
        sharp[y as usize]
            .total_cmp(&sharp[x as usize])
            .then_with(|| x.cmp(&y))
    });

    let boundary_corner = boundary == SubdivisionBoundary::EdgeAndCorner
        && corners.len() == 1
        && creases.len() == 2
        && creases.iter().all(|&e| mesh.is_boundary_edge(e));
    if boundary_corner {
        return p;
    }

    let crease_vals: Vec<f64> = creases.iter().map(|&e| sharp[e as usize]).collect();
    let (a, b) = crease_weights(&crease_vals);
    if b >= 1.0 {
        return p;
    }

    let crease_rule = || -> Vec3 {
        let mut neighbors = [[0.0f64; 3]; 2];
        for (slot, &e) in creases.iter().take(2).enumerate() {
            let [i, j] = mesh.edge_vertices(e);
            neighbors[slot] = mesh.position(if i == v { j } else { i });
        }
        [
            (neighbors[0][0] + 6.0 * p[0] + neighbors[1][0]) / 8.0,
            (neighbors[0][1] + 6.0 * p[1] + neighbors[1][1]) / 8.0,
            (neighbors[0][2] + 6.0 * p[2] + neighbors[1][2]) / 8.0,
        ]
    };

    if a >= 1.0 && b <= 0.0 {
        return crease_rule();
    }

    let smooth_rule = || -> Vec3 {
        let n = edges_set.len() as f64;
        let q_pts: Vec<Vec3> = corners
            .iter()
            .map(|&h| face_points[&mesh.h_face[h as usize]])
            .collect();
        let q = average_vec3(&q_pts);
        let r_pts: Vec<Vec3> = edges_set
            .iter()
            .map(|&e| {
                let [x, y] = mesh.edge_vertices(e);
                let px = mesh.position(x);
                let py = mesh.position(y);
                [
                    (px[0] + py[0]) * 0.5,
                    (px[1] + py[1]) * 0.5,
                    (px[2] + py[2]) * 0.5,
                ]
            })
            .collect();
        let r = average_vec3(&r_pts);
        [
            (q[0] + 2.0 * r[0] + (n - 3.0) * p[0]) / n,
            (q[1] + 2.0 * r[1] + (n - 3.0) * p[1]) / n,
            (q[2] + 2.0 * r[2] + (n - 3.0) * p[2]) / n,
        ]
    };

    if a <= 0.0 {
        return smooth_rule();
    }
    let smooth = if a < 1.0 { smooth_rule() } else { [0.0; 3] };
    let crease = if a > b { crease_rule() } else { [0.0; 3] };
    [
        (1.0 - a) * smooth[0] + (a - b) * crease[0] + b * p[0],
        (1.0 - a) * smooth[1] + (a - b) * crease[1] + b * p[1],
        (1.0 - a) * smooth[2] + (a - b) * crease[2] + b * p[2],
    ]
}

fn corner_average(mesh: &EditMesh, kind: CornerChannelKind, halves: &[i32]) -> Vec<f32> {
    let dim = kind.dim();
    let mut out = vec![0.0f32; dim];
    for &h in halves {
        if let Some(val) = mesh.corner(kind, h) {
            for k in 0..dim {
                out[k] += val[k];
            }
        }
    }
    let inv = 1.0 / (halves.len() as f32);
    for v in &mut out {
        *v *= inv;
    }
    out
}

fn refine_once(
    mesh: &EditMesh,
    selected: &[u8],
    scheme: SubdivisionScheme,
    boundary: SubdivisionBoundary,
    sharp: &[f64],
) -> Result<(EditMesh, Vec<u8>, Vec<f64>), KernelError> {
    let mut out = EditMesh::new();
    out.tag_names = mesh.tag_names.clone();
    out.label_names = mesh.label_names.clone();
    out.role_names = mesh.role_names.clone();
    out.material_names = mesh.material_names.clone();
    out.reserve_tag_words(mesh.tag_words);

    let faces = mesh.faces();
    let mut face_points: HashMap<i32, Vec3> = HashMap::new();
    for &f in &faces {
        if selected[f as usize] != 0 {
            face_points.insert(f, face_centroid(mesh, f));
        }
    }

    let mut corners_of: HashMap<i32, Vec<i32>> = HashMap::new();
    for &f in &faces {
        for h in mesh.face_halves(f) {
            corners_of
                .entry(mesh.h_vert[h as usize])
                .or_default()
                .push(h);
        }
    }

    let mut vertex_of: HashMap<i32, i32> = HashMap::with_capacity(corners_of.len());
    for v in mesh.vertices() {
        let Some(corners) = corners_of.get(&v) else {
            continue;
        };
        let p = match scheme {
            SubdivisionScheme::Simple => mesh.position(v),
            SubdivisionScheme::CatmullClark => {
                vertex_point(mesh, v, corners, selected, &face_points, boundary, sharp)
            }
        };
        vertex_of.insert(v, out.add_vertex(p[0], p[1], p[2])?);
    }

    let mut edge_of: HashMap<i32, i32> = HashMap::new();
    for e in mesh.edges() {
        let fa = mesh.h_face[(e * 2) as usize];
        let fb = mesh.h_face[(e * 2 + 1) as usize];
        let sa = fa != NONE && selected[fa as usize] != 0;
        let sb = fb != NONE && selected[fb as usize] != 0;
        if !sa && !sb {
            continue;
        }
        let [va, vb] = mesh.edge_vertices(e);
        let a = mesh.position(va);
        let b = mesh.position(vb);
        let hardness = sharp[e as usize].min(1.0);
        let smooth = scheme == SubdivisionScheme::CatmullClark && sa && sb && hardness < 1.0;
        let middle = average_vec3(&[a, b]);
        let full = if smooth {
            average_vec3(&[a, b, face_points[&fa], face_points[&fb]])
        } else {
            middle
        };
        let p = if smooth && hardness > 0.0 {
            [
                (1.0 - hardness) * full[0] + hardness * middle[0],
                (1.0 - hardness) * full[1] + hardness * middle[1],
                (1.0 - hardness) * full[2] + hardness * middle[2],
            ]
        } else {
            full
        };
        edge_of.insert(e, out.add_vertex(p[0], p[1], p[2])?);
    }

    let mut center_of: HashMap<i32, i32> = HashMap::with_capacity(face_points.len());
    for (&f, &p) in &face_points {
        center_of.insert(f, out.add_vertex(p[0], p[1], p[2])?);
    }

    let active_channels: Vec<CornerChannelKind> = CornerChannelKind::ALL
        .into_iter()
        .filter(|&k| mesh.channels[k as usize].is_some())
        .collect();

    let mut next_selected: Vec<u8> = Vec::new();
    for &f in &faces {
        let halves = mesh.face_halves(f);
        if selected[f as usize] != 0 {
            let full_channels: Vec<(CornerChannelKind, Vec<f32>)> = active_channels
                .iter()
                .copied()
                .filter(|&k| halves.iter().all(|&h| mesh.corner(k, h).is_some()))
                .map(|k| (k, corner_average(mesh, k, &halves)))
                .collect();

            for &h in &halves {
                let prev = mesh.h_prev[h as usize];
                let next_h = mesh.h_next[h as usize];
                let lp = [
                    vertex_of[&mesh.h_vert[h as usize]],
                    edge_of[&(h >> 1)],
                    center_of[&f],
                    edge_of[&(prev >> 1)],
                ];
                let g = out.add_face(&lp, 0)?;
                mesh.copy_face_attributes_to(f, &mut out, g);
                if next_selected.len() <= g as usize {
                    next_selected.resize(g as usize + 1, 0);
                }
                next_selected[g as usize] = 1;
                let to = out.face_halves(g);
                for (kind, center_val) in &full_channels {
                    let v0 = mesh.corner(*kind, h).unwrap().to_vec();
                    let v1 = corner_average(mesh, *kind, &[h, next_h]);
                    let v3 = corner_average(mesh, *kind, &[prev, h]);
                    out.set_corner(*kind, to[0], &v0);
                    out.set_corner(*kind, to[1], &v1);
                    out.set_corner(*kind, to[2], center_val);
                    out.set_corner(*kind, to[3], &v3);
                }
            }
        } else {
            let mut lp = Vec::with_capacity(halves.len() * 2);
            let mut corner_writes: Vec<(CornerChannelKind, usize, Vec<f32>)> = Vec::new();
            for &h in &halves {
                for &k in &active_channels {
                    if let Some(val) = mesh.corner(k, h) {
                        corner_writes.push((k, lp.len(), val.to_vec()));
                    }
                }
                lp.push(vertex_of[&mesh.h_vert[h as usize]]);
                if let Some(&split) = edge_of.get(&(h >> 1)) {
                    let next_h = mesh.h_next[h as usize];
                    for &k in &active_channels {
                        if mesh.corner(k, h).is_some() && mesh.corner(k, next_h).is_some() {
                            corner_writes.push((
                                k,
                                lp.len(),
                                corner_average(mesh, k, &[h, next_h]),
                            ));
                        }
                    }
                    lp.push(split);
                }
            }
            let g = out.add_face(&lp, 0)?;
            mesh.copy_face_attributes_to(f, &mut out, g);
            if next_selected.len() <= g as usize {
                next_selected.resize(g as usize + 1, 0);
            }
            next_selected[g as usize] = 0;
            let to = out.face_halves(g);
            for (kind, slot, val) in corner_writes {
                out.set_corner(kind, to[slot], &val);
            }
        }
    }

    let mut child_sharp = vec![0.0f64; out.e_flags.len()];
    for e in mesh.edges() {
        let flags = mesh.e_flags[e as usize];
        let s = sharp[e as usize];
        if flags == 0 && s <= 0.0 {
            continue;
        }
        let [oa, ob] = mesh.edge_vertices(e);
        let a = vertex_of[&oa];
        let b = vertex_of[&ob];
        let split = edge_of.get(&e).copied();
        let next_s = if split.is_none() || scheme == SubdivisionScheme::Simple {
            s
        } else {
            (s - 1.0).max(0.0)
        };
        let child_flags = if split.is_none()
            || scheme == SubdivisionScheme::Simple
            || (flags & EDGE_SHARP) == 0
        {
            flags
        } else if next_s > 0.0 {
            flags | EDGE_SHARP
        } else {
            flags & !EDGE_SHARP
        };
        let pieces: [(i32, i32); 2] = match split {
            None => [(a, b), (NONE, NONE)],
            Some(mid) => [(a, mid), (mid, b)],
        };
        for &(x, y) in &pieces {
            if x == NONE {
                break;
            }
            let h = out.find_half(x, y);
            if h != NONE {
                let ce = (h >> 1) as usize;
                out.e_flags[ce] = child_flags;
                if ce < child_sharp.len() {
                    child_sharp[ce] = next_s;
                }
            }
        }
    }

    let _ = CHANNEL_COUNT;
    Ok((out, next_selected, child_sharp))
}

/// Subdivide `faces` in-place on `mesh` for `levels >= 1`.
pub fn subdivide(
    mesh: &mut EditMesh,
    faces: &[i32],
    levels: u32,
    scheme: SubdivisionScheme,
    boundary: SubdivisionBoundary,
    crease_sharpness: f64,
    face_budget: usize,
) -> Result<usize, KernelError> {
    if levels < 1 {
        return Err(KernelError::invalid_value("levels", "levels must be >= 1"));
    }
    if crease_sharpness.is_nan() || crease_sharpness <= 0.0 {
        return Err(KernelError::invalid_value("creaseSharpness", "must be > 0"));
    }

    let mut corners = 0usize;
    let mut selected = vec![0u8; mesh.face_high_water as usize];
    for &f in faces {
        if mesh.is_face_alive(f) && selected[f as usize] == 0 {
            selected[f as usize] = 1;
            corners += mesh.f_len[f as usize].max(0) as usize;
        }
    }
    let untouched = mesh.face_count().saturating_sub(faces.len());
    let mut predicted = corners;
    for _ in 1..levels {
        predicted = predicted.saturating_mul(4);
        if predicted.saturating_add(untouched) > face_budget {
            return Err(KernelError::work_budget(
                "subdivide",
                format!("subdivided face count exceeds budget {face_budget}"),
            ));
        }
    }
    if predicted.saturating_add(untouched) > face_budget {
        return Err(KernelError::work_budget(
            "subdivide",
            format!("subdivided face count exceeds budget {face_budget}"),
        ));
    }

    let edge_cap = (mesh.half_high_water / 2) as usize;
    let mut sharp = vec![0.0f64; edge_cap];
    for e in mesh.edges() {
        let is_sharp = (mesh.e_flags[e as usize] & EDGE_SHARP) != 0;
        let is_boundary = mesh.is_boundary_edge(e);
        sharp[e as usize] = if is_boundary {
            f64::INFINITY
        } else if is_sharp {
            crease_sharpness
        } else {
            0.0
        };
    }

    let mut current = mesh.clone();
    for _ in 0..levels {
        let (next_mesh, next_sel, next_sharp) =
            refine_once(&current, &selected, scheme, boundary, &sharp)?;
        current = next_mesh;
        selected = next_sel;
        sharp = next_sharp;
    }

    let out_faces = current.face_count();
    *mesh = current;
    Ok(out_faces)
}
