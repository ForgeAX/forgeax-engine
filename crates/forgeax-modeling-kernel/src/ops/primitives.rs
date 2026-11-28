//! Procedural primitives, transforms, and attribute operations over `mesh::EditMesh`.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{face_centroid, scale as vec_scale, sub, Vec3};
use crate::mesh::{EditMesh, NONE};

#[derive(Debug, Clone, Copy)]
pub struct Attribution {
    pub label: i32,
    pub material: i32,
    pub tag: i32,
}

impl Default for Attribution {
    fn default() -> Self {
        Self {
            label: 0,
            material: 0,
            tag: -1,
        }
    }
}

pub fn add_attributed_faces(
    mesh: &mut EditMesh,
    loops: &[Vec<i32>],
    attr: Attribution,
    role: &str,
) -> Result<Vec<i32>, KernelError> {
    let role_idx = if attr.label == 0 {
        0
    } else {
        mesh.name_index_role(role)
    };
    let mut faces = Vec::with_capacity(loops.len());
    for lp in loops {
        let f = mesh.add_face(lp, attr.material)?;
        mesh.f_label[f as usize] = attr.label;
        mesh.f_role[f as usize] = role_idx;
        if attr.tag >= 0 {
            mesh.add_tag(f, attr.tag);
        }
        faces.push(f);
    }
    Ok(faces)
}

pub fn mark_role(mesh: &mut EditMesh, faces: &[i32], label: i32, role: &str) {
    if faces.is_empty() || label == 0 {
        return;
    }
    let role_idx = mesh.name_index_role(role);
    for &f in faces {
        mesh.f_label[f as usize] = label;
        mesh.f_role[f as usize] = role_idx;
    }
}

/// Append a segmented axis-aligned box matching `@forgeax/engine-modeling`'s `appendBox`
/// vertex ordering, face winding, and topology 100%.
pub fn append_box(
    mesh: &mut EditMesh,
    size: [f64; 3],
    segments: [u32; 3],
    center: [f64; 3],
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    for (i, &s) in size.iter().enumerate() {
        if !s.is_finite() || s <= 0.0 {
            return Err(KernelError::invalid_value(
                format!("size[{i}]"),
                "must be finite and > 0",
            ));
        }
    }
    for (i, &n) in segments.iter().enumerate() {
        if n < 1 {
            return Err(KernelError::invalid_value(
                format!("segments[{i}]"),
                "must be >= 1",
            ));
        }
    }
    for (i, &c) in center.iter().enumerate() {
        if !c.is_finite() {
            return Err(KernelError::invalid_value(
                format!("center[{i}]"),
                "must be finite",
            ));
        }
    }

    let [sx, sy, sz] = size;
    let [cx, cy, cz] = center;
    let [nx, ny, nz] = segments;

    let mut grid: HashMap<(u32, u32, u32), i32> = HashMap::new();
    let mut vertex = |mesh: &mut EditMesh, i: u32, j: u32, k: u32| -> Result<i32, KernelError> {
        if let Some(&v) = grid.get(&(i, j, k)) {
            return Ok(v);
        }
        let v = mesh.add_vertex(
            cx + (i as f64 / nx as f64 - 0.5) * sx,
            cy + (j as f64 / ny as f64 - 0.5) * sy,
            cz + (k as f64 / nz as f64 - 0.5) * sz,
        )?;
        grid.insert((i, j, k), v);
        Ok(v)
    };

    let mut loops: Vec<Vec<i32>> = Vec::with_capacity(((ny * nz + nx * nz + nx * ny) * 2) as usize);

    for j in 0..ny {
        for k in 0..nz {
            loops.push(vec![
                vertex(mesh, nx, j, k)?,
                vertex(mesh, nx, j + 1, k)?,
                vertex(mesh, nx, j + 1, k + 1)?,
                vertex(mesh, nx, j, k + 1)?,
            ]);
            loops.push(vec![
                vertex(mesh, 0, j, k)?,
                vertex(mesh, 0, j, k + 1)?,
                vertex(mesh, 0, j + 1, k + 1)?,
                vertex(mesh, 0, j + 1, k)?,
            ]);
        }
    }
    for i in 0..nx {
        for k in 0..nz {
            loops.push(vec![
                vertex(mesh, i, ny, k)?,
                vertex(mesh, i, ny, k + 1)?,
                vertex(mesh, i + 1, ny, k + 1)?,
                vertex(mesh, i + 1, ny, k)?,
            ]);
            loops.push(vec![
                vertex(mesh, i, 0, k)?,
                vertex(mesh, i + 1, 0, k)?,
                vertex(mesh, i + 1, 0, k + 1)?,
                vertex(mesh, i, 0, k + 1)?,
            ]);
        }
    }
    for i in 0..nx {
        for j in 0..ny {
            loops.push(vec![
                vertex(mesh, i, j, nz)?,
                vertex(mesh, i + 1, j, nz)?,
                vertex(mesh, i + 1, j + 1, nz)?,
                vertex(mesh, i, j + 1, nz)?,
            ]);
            loops.push(vec![
                vertex(mesh, i, j, 0)?,
                vertex(mesh, i, j + 1, 0)?,
                vertex(mesh, i + 1, j + 1, 0)?,
                vertex(mesh, i + 1, j, 0)?,
            ]);
        }
    }

    add_attributed_faces(mesh, &loops, attr, "face")
}

/// Append a quad grid in XY facing +Z.
pub fn append_plane(
    mesh: &mut EditMesh,
    width: f64,
    height: f64,
    nx: u32,
    ny: u32,
    center: [f64; 3],
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if !width.is_finite() || width <= 0.0 || !height.is_finite() || height <= 0.0 {
        return Err(KernelError::invalid_value(
            "plane",
            "width and height must be > 0",
        ));
    }
    if nx < 1 || ny < 1 {
        return Err(KernelError::invalid_value("plane", "segments must be >= 1"));
    }
    let mut ids = Vec::with_capacity(((nx + 1) * (ny + 1)) as usize);
    for j in 0..=ny {
        for i in 0..=nx {
            ids.push(mesh.add_vertex(
                center[0] + (i as f64 / nx as f64 - 0.5) * width,
                center[1] + (j as f64 / ny as f64 - 0.5) * height,
                center[2],
            )?);
        }
    }
    let at = |i: u32, j: u32| ids[(j * (nx + 1) + i) as usize];
    let mut loops = Vec::with_capacity((nx * ny) as usize);
    for j in 0..ny {
        for i in 0..nx {
            loops.push(vec![at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
    }
    add_attributed_faces(mesh, &loops, attr, "face")
}

fn unique_face_verts(mesh: &EditMesh, faces: &[i32]) -> Vec<i32> {
    let mut seen = HashSet::new();
    let mut verts = Vec::new();
    for &f in faces {
        for v in mesh.face_vertices(f) {
            if seen.insert(v) {
                verts.push(v);
            }
        }
    }
    verts
}

pub fn translate_faces(mesh: &mut EditMesh, faces: &[i32], delta: Vec3) -> Result<(), KernelError> {
    if !delta.iter().all(|c| c.is_finite()) {
        return Err(KernelError::invalid_value("delta", "must be finite"));
    }
    for v in unique_face_verts(mesh, faces) {
        let p = mesh.position(v);
        mesh.set_position(v, p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]);
    }
    Ok(())
}

pub fn scale_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    factors: Vec3,
    pivot: Option<Vec3>,
) -> Result<(), KernelError> {
    if !factors.iter().all(|c| c.is_finite() && *c != 0.0) {
        return Err(KernelError::invalid_value(
            "scale",
            "factors must be finite and non-zero",
        ));
    }
    let origin = pivot.unwrap_or_else(|| {
        if faces.is_empty() {
            [0.0, 0.0, 0.0]
        } else {
            let mut sum = [0.0f64; 3];
            for &f in faces {
                let c = face_centroid(mesh, f);
                sum[0] += c[0];
                sum[1] += c[1];
                sum[2] += c[2];
            }
            vec_scale(sum, 1.0 / (faces.len() as f64))
        }
    });
    for v in unique_face_verts(mesh, faces) {
        let d = sub(mesh.position(v), origin);
        mesh.set_position(
            v,
            origin[0] + d[0] * factors[0],
            origin[1] + d[1] * factors[1],
            origin[2] + d[2] * factors[2],
        );
    }
    Ok(())
}

/// Rotate vertices of `faces` by `degrees` around axis (`0=x, 1=y, 2=z`) about `pivot`.
pub fn rotate_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    axis: u8,
    degrees: f64,
    pivot: Option<Vec3>,
) -> Result<(), KernelError> {
    if !degrees.is_finite() || axis > 2 {
        return Err(KernelError::invalid_value(
            "rotate",
            "axis must be 0..=2 and degrees finite",
        ));
    }
    let rad = degrees * std::f64::consts::PI / 180.0;
    let (s, c) = rad.sin_cos();
    let origin = pivot.unwrap_or([0.0, 0.0, 0.0]);
    for v in unique_face_verts(mesh, faces) {
        let d = sub(mesh.position(v), origin);
        let r = match axis {
            0 => [d[0], d[1] * c - d[2] * s, d[1] * s + d[2] * c],
            1 => [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c],
            _ => [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]],
        };
        mesh.set_position(v, origin[0] + r[0], origin[1] + r[1], origin[2] + r[2]);
    }
    Ok(())
}

pub fn tag_faces(mesh: &mut EditMesh, faces: &[i32], name: &str) -> Result<(), KernelError> {
    if name.trim().is_empty() {
        return Err(KernelError::invalid_value(
            "tag",
            "tag name must be non-empty",
        ));
    }
    let idx = mesh.tag_index(name, true);
    for &f in faces {
        if mesh.is_face_alive(f) {
            mesh.add_tag(f, idx);
        }
    }
    Ok(())
}

pub fn set_material_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    slot: &str,
) -> Result<(), KernelError> {
    if slot.trim().is_empty() {
        return Err(KernelError::invalid_value(
            "material",
            "slot name must be non-empty",
        ));
    }
    let idx = mesh.name_index_material(slot);
    for &f in faces {
        if mesh.is_face_alive(f) {
            mesh.f_material[f as usize] = idx;
        }
    }
    Ok(())
}

pub fn mark_edge_flags(mesh: &mut EditMesh, edges: &[i32], flag: u8, enable: bool) {
    for &e in edges {
        if mesh.is_edge_alive(e) {
            if enable {
                mesh.e_flags[e as usize] |= flag;
            } else {
                mesh.e_flags[e as usize] &= !flag;
            }
        }
    }
}

pub fn edge_flags_between(mesh: &EditMesh, a: i32, b: i32) -> u8 {
    let h = mesh.find_half(a, b);
    if h == NONE {
        0
    } else {
        mesh.e_flags[(h >> 1) as usize]
    }
}

pub fn set_edge_flags_between(mesh: &mut EditMesh, a: i32, b: i32, flags: u8) {
    let h = mesh.find_half(a, b);
    if h != NONE {
        mesh.e_flags[(h >> 1) as usize] = flags;
    }
}

/// Core revolved surface matching `@forgeax/engine-modeling`'s `revolveSurface`
/// (shared by `revolve`, `cylinder`, `sphere`, and `torus`).
fn revolve_surface(
    mesh: &mut EditMesh,
    raw_points: &[[f64; 2]],
    segments: u32,
    angle_deg: f64,
    start_angle_deg: f64,
    side_role: &str,
    start_role: &str,
    end_role: &str,
    attr: Attribution,
    place: impl Fn(f64, f64, f64) -> Vec3,
) -> Result<Vec<i32>, KernelError> {
    if raw_points.len() < 2 {
        return Err(KernelError::invalid_value(
            "points",
            "revolve profile needs at least 2 points",
        ));
    }
    if !(angle_deg > 0.0 && angle_deg <= 360.0) {
        return Err(KernelError::invalid_value(
            "angle",
            "revolve angle must be in (0, 360]",
        ));
    }
    let full = (angle_deg - 360.0).abs() < 1e-12;
    let min_seg = if full { 3 } else { 1 };
    if segments < min_seg {
        return Err(KernelError::invalid_value(
            "segments",
            "revolve segments below minimum",
        ));
    }

    let first = raw_points[0];
    let last = *raw_points.last().unwrap();
    let is_loop = raw_points.len() >= 4
        && (first[0] - last[0]).abs() < 1e-12
        && (first[1] - last[1]).abs() < 1e-12;
    let profile: &[[f64; 2]] = if is_loop {
        &raw_points[..raw_points.len() - 1]
    } else {
        raw_points
    };
    let m = profile.len();
    let n = segments as usize;
    let cols = if full { n } else { n + 1 };

    let mut ids: Vec<Vec<i32>> = Vec::with_capacity(m);
    for &[r, y] in profile {
        let count = if r.abs() <= 1e-15 { 1 } else { cols };
        let mut ring = Vec::with_capacity(count);
        for i in 0..count {
            let phi = (start_angle_deg + (i as f64) * angle_deg / (n as f64)).to_radians();
            let p = place(r * phi.sin(), y, r * phi.cos());
            ring.push(mesh.add_vertex(p[0], p[1], p[2])?);
        }
        ids.push(ring);
    }

    let at = |j: usize, i: usize| -> i32 {
        let ring = &ids[j];
        if ring.len() == 1 {
            ring[0]
        } else {
            ring[i % cols]
        }
    };
    let is_cap = |j: usize, k: usize, axis_end: usize| -> bool {
        !is_loop
            && profile[axis_end][0].abs() <= 1e-15
            && (profile[j][1] - profile[k][1]).abs() <= 1e-12
    };

    let mut side_loops: Vec<Vec<i32>> = Vec::new();
    let mut cap_defs: Vec<(&str, Vec<i32>, usize)> = Vec::new();
    let spans = if is_loop { m } else { m - 1 };

    for j in 0..spans {
        let k = (j + 1) % m;
        if j == 0 && is_cap(j, k, 0) {
            let mut rim: Vec<i32> = (0..cols).map(|i| at(k, cols - 1 - i)).collect();
            if full {
                mesh.remove_vertex(at(j, 0));
            } else {
                let mut lp = Vec::with_capacity(cols + 1);
                lp.push(at(j, 0));
                lp.append(&mut rim);
                rim = lp;
            }
            cap_defs.push((start_role, rim, k));
            continue;
        }
        if k == m - 1 && is_cap(j, k, k) {
            let mut rim: Vec<i32> = (0..cols).map(|i| at(j, i)).collect();
            if full {
                mesh.remove_vertex(at(k, 0));
            } else {
                rim.push(at(k, 0));
            }
            cap_defs.push((end_role, rim, j));
            continue;
        }
        let j_axis = profile[j][0].abs() <= 1e-15;
        let k_axis = profile[k][0].abs() <= 1e-15;
        for i in 0..n {
            let a = at(j, i);
            let b = at(j, i + 1);
            let c = at(k, i + 1);
            let d = at(k, i);
            if j_axis {
                side_loops.push(vec![a, c, d]);
            } else if k_axis {
                side_loops.push(vec![a, b, c]);
            } else {
                side_loops.push(vec![a, b, c, d]);
            }
        }
    }

    let mut all_faces = add_attributed_faces(mesh, &side_loops, attr, side_role)?;
    let mut sharp_edges = Vec::new();
    for (role, lp, rim_row) in cap_defs {
        let cf = add_attributed_faces(mesh, &[lp], attr, role)?;
        all_faces.extend(cf);
        let rim_count = if full { cols } else { cols - 1 };
        for i in 0..rim_count {
            let h = mesh.find_half(at(rim_row, i), at(rim_row, i + 1));
            if h != NONE {
                sharp_edges.push(h >> 1);
            }
        }
    }
    mark_edge_flags(mesh, &sharp_edges, crate::mesh::EDGE_SHARP, true);
    Ok(all_faces)
}

pub fn append_revolve(
    mesh: &mut EditMesh,
    points: &[[f64; 2]],
    segments: u32,
    angle_deg: f64,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    revolve_surface(
        mesh,
        points,
        segments,
        angle_deg,
        0.0,
        "side",
        "bottom",
        "top",
        attr,
        |x, y, z| [x, y, z],
    )
}

pub fn append_cylinder(
    mesh: &mut EditMesh,
    radius_top: f64,
    radius_bottom: f64,
    height: f64,
    radial_segments: u32,
    height_segments: u32,
    open_ended: bool,
    center: Vec3,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if radius_top < 0.0 || radius_bottom < 0.0 || (radius_top == 0.0 && radius_bottom == 0.0) {
        return Err(KernelError::invalid_value(
            "radius",
            "cylinder radii must be >= 0 with at least one > 0",
        ));
    }
    if !(height > 0.0) {
        return Err(KernelError::invalid_value(
            "height",
            "cylinder height must be > 0",
        ));
    }
    let rows = height_segments.max(1);
    let half = 0.5 * height;
    let mut profile: Vec<[f64; 2]> = Vec::new();
    let caps = !open_ended;
    if caps && radius_bottom > 0.0 {
        profile.push([0.0, -half]);
    }
    for k in 0..=rows {
        let t = (k as f64) / (rows as f64);
        let r = if k == 0 {
            radius_bottom
        } else if k == rows {
            radius_top
        } else {
            radius_bottom + (radius_top - radius_bottom) * t
        };
        let y = if k == rows { half } else { -half + height * t };
        profile.push([r, y]);
    }
    if caps && radius_top > 0.0 {
        profile.push([0.0, half]);
    }
    revolve_surface(
        mesh,
        &profile,
        radial_segments,
        360.0,
        0.0,
        "side",
        "bottom",
        "top",
        attr,
        |x, y, z| [x + center[0], y + center[1], z + center[2]],
    )
}

pub fn append_sphere(
    mesh: &mut EditMesh,
    radius: f64,
    width_segments: u32,
    height_segments: u32,
    center: Vec3,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if !(radius > 0.0) {
        return Err(KernelError::invalid_value(
            "radius",
            "sphere radius must be > 0",
        ));
    }
    let h = height_segments.max(2);
    let mut profile: Vec<[f64; 2]> = Vec::with_capacity((h + 1) as usize);
    profile.push([0.0, -radius]);
    for k in 1..h {
        let theta = std::f64::consts::PI * (k as f64) / (h as f64);
        profile.push([radius * theta.sin(), -radius * theta.cos()]);
    }
    profile.push([0.0, radius]);
    revolve_surface(
        mesh,
        &profile,
        width_segments,
        360.0,
        0.0,
        "face",
        "face",
        "face",
        attr,
        |x, y, z| [x + center[0], y + center[1], z + center[2]],
    )
}

pub fn append_torus(
    mesh: &mut EditMesh,
    radius: f64,
    tube: f64,
    radial_segments: u32,
    tubular_segments: u32,
    angle_deg: f64,
    center: Vec3,
    attr: Attribution,
) -> Result<Vec<i32>, KernelError> {
    if !(radius > 0.0) || !(tube > 0.0) || tube >= radius {
        return Err(KernelError::invalid_value(
            "torus",
            "0 < tube < radius required",
        ));
    }
    let rs = radial_segments.max(3);
    let mut profile: Vec<[f64; 2]> = Vec::with_capacity((rs + 1) as usize);
    for k in 0..rs {
        let v = std::f64::consts::TAU * (k as f64) / (rs as f64);
        profile.push([radius + tube * v.cos(), tube * v.sin()]);
    }
    profile.push(profile[0]);
    revolve_surface(
        mesh,
        &profile,
        tubular_segments,
        angle_deg,
        90.0,
        "face",
        "face",
        "face",
        attr,
        // Rotate +Y revolve axis onto +Z: (x, y, z) -> (x, -z, y)
        |x, y, z| [x + center[0], -z + center[1], y + center[2]],
    )
}
