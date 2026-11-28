//! Polygon, cone, extruded-polygon, loft, pipe-network, strands, and mesh-lift operators.

use std::collections::HashMap;

use crate::error::KernelError;
use crate::mesh::geom::{add, cross, dot, face_normal, length, normalize, scale, sub, Vec3};
use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SHARP};
use crate::ops::primitives::{add_attributed_faces, append_cylinder, append_sphere, Attribution};

pub fn append_polygon(
    mesh: &mut EditMesh,
    points: &[[f64; 2]],
    flip: bool,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if points.len() < 3 {
        return Err(KernelError::invalid_value(
            "points",
            "polygon needs at least 3 points",
        ));
    }
    let mut ids = Vec::with_capacity(points.len());
    for &[x, y] in points {
        ids.push(mesh.add_vertex(x, y, 0.0)?);
    }
    if flip {
        ids.reverse();
    }
    add_attributed_faces(mesh, &[ids], attr, "face")
}

pub fn append_cone(
    mesh: &mut EditMesh,
    radius: f64,
    height: f64,
    radial_segments: u32,
    open_ended: bool,
    center: Vec3,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    append_cylinder(
        mesh,
        radius,
        0.0,
        height,
        radial_segments,
        1,
        open_ended,
        center,
        attr,
    )
}

pub fn append_extrude_polygon(
    mesh: &mut EditMesh,
    points: &[[f64; 2]],
    depth: f64,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if !depth.is_finite() || depth == 0.0 {
        return Err(KernelError::invalid_value("depth", "must be non-zero"));
    }
    if points.len() < 3 {
        return Err(KernelError::invalid_value(
            "points",
            "must have >= 3 points",
        ));
    }
    // Check 2D signed area to enforce CCW outer loop
    let mut area2 = 0.0;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        area2 += a[0] * b[1] - a[1] * b[0];
    }
    let ordered: Vec<[f64; 2]> = if area2 < 0.0 {
        points.iter().copied().rev().collect()
    } else {
        points.to_vec()
    };
    let n = ordered.len();
    let mut bot = Vec::with_capacity(n);
    let mut top = Vec::with_capacity(n);
    let z0 = if depth > 0.0 { 0.0 } else { depth };
    let z1 = if depth > 0.0 { depth } else { 0.0 };
    for &[x, y] in &ordered {
        bot.push(mesh.add_vertex(x, y, z0)?);
        top.push(mesh.add_vertex(x, y, z1)?);
    }
    let mut out = Vec::new();
    let bot_rev: Vec<i32> = bot.iter().copied().rev().collect();
    out.extend(add_attributed_faces(mesh, &[bot_rev], attr, "bottom")?);
    out.extend(add_attributed_faces(mesh, &[top.clone()], attr, "top")?);
    let mut side_loops = Vec::with_capacity(n);
    for i in 0..n {
        let j = (i + 1) % n;
        side_loops.push(vec![bot[i], bot[j], top[j], top[i]]);
    }
    out.extend(add_attributed_faces(mesh, &side_loops, attr, "side")?);
    Ok(out)
}

fn resample_closed_ring(ring: &[Vec3], target_count: usize) -> Vec<Vec3> {
    let n = ring.len();
    let mut arc = vec![0.0; n + 1];
    for i in 0..n {
        arc[i + 1] = arc[i] + length(sub(ring[(i + 1) % n], ring[i]));
    }
    let total = arc[n].max(1e-12);
    let mut out = Vec::with_capacity(target_count);
    for k in 0..target_count {
        let s = (k as f64) * total / (target_count as f64);
        let seg = arc
            .partition_point(|&a| a <= s)
            .saturating_sub(1)
            .min(n - 1);
        let len = (arc[seg + 1] - arc[seg]).max(1e-12);
        let t = ((s - arc[seg]) / len).clamp(0.0, 1.0);
        let a = ring[seg];
        let b = ring[(seg + 1) % n];
        out.push(add(a, scale(sub(b, a), t)));
    }
    out
}

pub fn append_loft(
    mesh: &mut EditMesh,
    sections: &[Vec<Vec3>],
    capped: bool,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if sections.len() < 2 {
        return Err(KernelError::invalid_value(
            "sections",
            "loft requires at least 2 sections",
        ));
    }
    let count = sections.iter().map(|s| s.len()).max().unwrap_or(0).max(3);
    let resampled: Vec<Vec<Vec3>> = sections
        .iter()
        .map(|s| {
            if s.len() == count {
                s.clone()
            } else {
                resample_closed_ring(s, count)
            }
        })
        .collect();

    let mut vert_rings = Vec::with_capacity(resampled.len());
    for ring in &resampled {
        let mut vr = Vec::with_capacity(count);
        for &p in ring {
            vr.push(mesh.add_vertex(p[0], p[1], p[2])?);
        }
        vert_rings.push(vr);
    }
    let mut out = Vec::new();
    let mut sides = Vec::new();
    for r in 0..(vert_rings.len() - 1) {
        for i in 0..count {
            let j = (i + 1) % count;
            sides.push(vec![
                vert_rings[r][i],
                vert_rings[r][j],
                vert_rings[r + 1][j],
                vert_rings[r + 1][i],
            ]);
        }
    }
    out.extend(add_attributed_faces(mesh, &sides, attr, "side")?);
    if capped {
        let mut start_cap = vert_rings[0].clone();
        start_cap.reverse();
        out.extend(add_attributed_faces(mesh, &[start_cap], attr, "start")?);
        out.extend(add_attributed_faces(
            mesh,
            &[vert_rings.last().unwrap().clone()],
            attr,
            "end",
        )?);
    }
    Ok(out)
}

pub fn append_pipe_network(
    mesh: &mut EditMesh,
    nodes: &[Vec3],
    edges: &[(usize, usize)],
    radius: f64,
    segments: u32,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if !(radius > 0.0) {
        return Err(KernelError::invalid_value("radius", "must be > 0"));
    }
    let segs = segments.max(6);
    let mut created = Vec::new();
    for &p in nodes {
        created.extend(append_sphere(
            mesh,
            radius * 1.02,
            segs,
            (segs / 2).max(4),
            p,
            attr,
        )?);
    }
    for &(a, b) in edges {
        if a >= nodes.len() || b >= nodes.len() || a == b {
            continue;
        }
        let pa = nodes[a];
        let pb = nodes[b];
        let d = sub(pb, pa);
        let len = length(d);
        if len < 1e-6 {
            continue;
        }
        let dir = scale(d, 1.0 / len);
        let ref_v = if dir[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let u = normalize(cross(dir, ref_v));
        let v = cross(dir, u);
        let mut r0 = Vec::with_capacity(segs as usize);
        let mut r1 = Vec::with_capacity(segs as usize);
        for k in 0..segs {
            let ang = (k as f64) * std::f64::consts::TAU / (segs as f64);
            let off = add(scale(u, ang.cos() * radius), scale(v, ang.sin() * radius));
            let p0 = add(pa, off);
            let p1 = add(pb, off);
            r0.push(mesh.add_vertex(p0[0], p0[1], p0[2])?);
            r1.push(mesh.add_vertex(p1[0], p1[1], p1[2])?);
        }
        let mut sides = Vec::with_capacity(segs as usize);
        for k in 0..(segs as usize) {
            let nk = (k + 1) % (segs as usize);
            sides.push(vec![r0[k], r0[nk], r1[nk], r1[k]]);
        }
        created.extend(add_attributed_faces(mesh, &sides, attr, "strut")?);
    }
    Ok(created)
}

/// Lift an indexed triangle soup into `EditMesh`, welding exact positions and marking sharp creases.
pub fn lift_triangle_soup(
    mesh: &mut EditMesh,
    positions: &[f32],
    indices: &[u32],
    uvs: Option<&[f32]>,
    crease_angle_deg: f64,
    attr: Attribution,
) -> Result<usize, KernelError> {
    let mut pos_map: HashMap<[u32; 3], i32> = HashMap::new();
    let vert_count = positions.len() / 3;
    let mut local_v = Vec::with_capacity(vert_count);
    for i in 0..vert_count {
        let x = positions[i * 3];
        let y = positions[i * 3 + 1];
        let z = positions[i * 3 + 2];
        let key = [x.to_bits(), y.to_bits(), z.to_bits()];
        let vid = match pos_map.get(&key) {
            Some(&v) => v,
            None => {
                let v = mesh.add_vertex(x as f64, y as f64, z as f64)?;
                pos_map.insert(key, v);
                v
            }
        };
        local_v.push(vid);
    }

    let mut created = 0usize;
    for tri in indices.chunks_exact(3) {
        let va = local_v[tri[0] as usize];
        let vb = local_v[tri[1] as usize];
        let vc = local_v[tri[2] as usize];
        if va == vb || vb == vc || vc == va {
            continue;
        }
        if let Ok(nf) = mesh.add_face(&[va, vb, vc], attr.material) {
            mesh.f_label[nf as usize] = attr.label;
            if attr.tag >= 0 {
                mesh.add_tag(nf, attr.tag);
            }
            if let Some(uv) = uvs {
                let hs = mesh.face_halves(nf);
                for (k, &h) in hs.iter().enumerate() {
                    let ui = (tri[k] as usize) * 2;
                    if ui + 1 < uv.len() {
                        mesh.set_corner(CornerChannelKind::Uv0, h, &[uv[ui], uv[ui + 1]]);
                    }
                }
            }
            created += 1;
        }
    }

    let cos_thresh = crease_angle_deg.to_radians().cos();
    for e in mesh.edges() {
        if mesh.is_boundary_edge(e) {
            continue;
        }
        let f1 = mesh.h_face[(e * 2) as usize];
        let f2 = mesh.h_face[(e * 2 + 1) as usize];
        if dot(face_normal(mesh, f1), face_normal(mesh, f2)) < cos_thresh {
            mesh.e_flags[e as usize] |= EDGE_SHARP;
        }
    }
    Ok(created)
}
