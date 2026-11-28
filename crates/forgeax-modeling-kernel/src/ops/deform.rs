//! Mesh deformers: bend, twist, lattice (FFD), cage (MVC), draft, curve deform,
//! spherize, soft falloff transforms, Taubin smooth, implicit cotangent smoothing,
//! ARAP deformation, and BVH shrinkwrap.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::bvh::TriSoupBvh;
use crate::mesh::geom::{
    add, cross, dot, face_normal, length, normalize, scale, sub, volume_about, Vec3,
};
use crate::mesh::rewrite::triangulate_loop;
use crate::mesh::{EditMesh, EDGE_SHARP, NONE};
use crate::solve::{build_cotangent_laplacian, solve_pcg, CsrMatrix, TripletList};

fn bounds_of(mesh: &EditMesh, verts: &[i32]) -> (Vec3, Vec3) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for &v in verts {
        let p = mesh.position(v);
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    if !lo[0].is_finite() {
        return ([0.0; 3], [0.0; 3]);
    }
    (lo, hi)
}

#[inline]
fn signed_axis(a: u8) -> Vec3 {
    match a {
        0 => [1.0, 0.0, 0.0],
        1 => [-1.0, 0.0, 0.0],
        2 => [0.0, 1.0, 0.0],
        3 => [0.0, -1.0, 0.0],
        4 => [0.0, 0.0, 1.0],
        _ => [0.0, 0.0, -1.0],
    }
}

pub fn bend_vertices(
    mesh: &mut EditMesh,
    verts: &[i32],
    axis: usize,
    toward: u8,
    angle_deg: f64,
    range: Option<[f64; 2]>,
    origin: Option<Vec3>,
) -> Result<usize, KernelError> {
    if verts.is_empty() {
        return Ok(0);
    }
    if !angle_deg.is_finite() || angle_deg == 0.0 || angle_deg.abs() > 360.0 {
        return Err(KernelError::invalid_value(
            "angle",
            "must be non-zero in [-360, 360]",
        ));
    }
    let ax = axis.min(2);
    let (lo, hi) = bounds_of(mesh, verts);
    let (r0, r1) = range.map_or((lo[ax], hi[ax]), |r| (r[0], r[1]));
    let span = r1 - r0;
    if !(span > 1e-12) {
        return Err(KernelError::invalid_value(
            "range",
            "bend range is degenerate",
        ));
    }
    let orig = origin.unwrap_or([
        0.5 * (lo[0] + hi[0]),
        0.5 * (lo[1] + hi[1]),
        0.5 * (lo[2] + hi[2]),
    ]);
    let mut e_ax = [0.0; 3];
    e_ax[ax] = 1.0;
    let e_tow = signed_axis(toward);
    if dot(e_ax, e_tow).abs() > 1e-6 {
        return Err(KernelError::invalid_value(
            "toward",
            "must be perpendicular to axis",
        ));
    }
    let e_perp = cross(e_ax, e_tow);
    let theta_total = angle_deg.to_radians();
    let radius = span / theta_total;

    for &v in verts {
        let p = mesh.position(v);
        let d = sub(p, orig);
        let u = (p[ax] - r0).clamp(0.0, span);
        let over = (p[ax] - r0) - u;
        let t_ang = u / radius;
        let w_tow = dot(d, e_tow);
        let w_perp = dot(d, e_perp);

        let r_local = radius - w_tow;
        let s = t_ang.sin();
        let c = t_ang.cos();
        let new_along = r0 + r_local * s + over * c;
        let new_tow = radius - r_local * c + over * s;

        let mut base = orig;
        base[ax] = 0.0;
        let mut out = [
            base[0] + e_ax[0] * new_along + e_tow[0] * new_tow + e_perp[0] * w_perp,
            base[1] + e_ax[1] * new_along + e_tow[1] * new_tow + e_perp[1] * w_perp,
            base[2] + e_ax[2] * new_along + e_tow[2] * new_tow + e_perp[2] * w_perp,
        ];
        if (orig[ax]).abs() > 0.0 {
            // orig already incorporated in d; keep exact world coord
            let off_t = dot(orig, e_tow);
            let off_p = dot(orig, e_perp);
            out = [
                e_ax[0] * new_along + e_tow[0] * (off_t + new_tow) + e_perp[0] * (off_p + w_perp),
                e_ax[1] * new_along + e_tow[1] * (off_t + new_tow) + e_perp[1] * (off_p + w_perp),
                e_ax[2] * new_along + e_tow[2] * (off_t + new_tow) + e_perp[2] * (off_p + w_perp),
            ];
        }
        mesh.set_position(v, out[0], out[1], out[2]);
    }
    Ok(verts.len())
}

pub fn twist_vertices(
    mesh: &mut EditMesh,
    verts: &[i32],
    axis: usize,
    angle_deg: f64,
    range: Option<[f64; 2]>,
    origin: Option<Vec3>,
) -> Result<usize, KernelError> {
    if verts.is_empty() {
        return Ok(0);
    }
    if !angle_deg.is_finite() || angle_deg == 0.0 {
        return Err(KernelError::invalid_value(
            "angle",
            "must be finite and non-zero",
        ));
    }
    let ax = axis.min(2);
    let (lo, hi) = bounds_of(mesh, verts);
    let (r0, r1) = range.map_or((lo[ax], hi[ax]), |r| (r[0], r[1]));
    let span = r1 - r0;
    if !(span > 1e-12) {
        return Err(KernelError::invalid_value(
            "range",
            "twist range is degenerate",
        ));
    }
    let orig = origin.unwrap_or([
        0.5 * (lo[0] + hi[0]),
        0.5 * (lo[1] + hi[1]),
        0.5 * (lo[2] + hi[2]),
    ]);
    let u_ax = (ax + 1) % 3;
    let v_ax = (ax + 2) % 3;
    let total = angle_deg.to_radians();

    for &v in verts {
        let p = mesh.position(v);
        let t = ((p[ax] - r0) / span).clamp(0.0, 1.0);
        let ang = t * total;
        let c = ang.cos();
        let s = ang.sin();
        let du = p[u_ax] - orig[u_ax];
        let dv = p[v_ax] - orig[v_ax];
        let mut out = p;
        out[u_ax] = orig[u_ax] + du * c - dv * s;
        out[v_ax] = orig[v_ax] + du * s + dv * c;
        mesh.set_position(v, out[0], out[1], out[2]);
    }
    Ok(verts.len())
}

fn bernstein(n: usize, t: f64, out: &mut Vec<f64>) {
    out.clear();
    out.resize(n + 1, 0.0);
    out[0] = 1.0;
    let omt = 1.0 - t;
    for k in 1..=n {
        for j in (1..=k).rev() {
            out[j] = omt * out[j] + t * out[j - 1];
        }
        out[0] *= omt;
    }
}

pub fn lattice_deform(
    mesh: &mut EditMesh,
    verts: &[i32],
    resolution: [usize; 3],
    bounds: Option<(Vec3, Vec3)>,
    offsets: &[([usize; 3], Vec3)],
) -> Result<usize, KernelError> {
    if resolution.iter().any(|&r| !(2..=16).contains(&r)) {
        return Err(KernelError::invalid_value(
            "resolution",
            "each axis must be in 2..=16",
        ));
    }
    let [nx, ny, nz] = resolution;
    let (lo, hi) = bounds.unwrap_or_else(|| bounds_of(mesh, verts));
    let mut grid_off = vec![[0.0f64; 3]; nx * ny * nz];
    for &(idx, off) in offsets {
        if idx[0] < nx && idx[1] < ny && idx[2] < nz {
            grid_off[(idx[0] * ny + idx[1]) * nz + idx[2]] = off;
        }
    }
    let mut bx = Vec::new();
    let mut by = Vec::new();
    let mut bz = Vec::new();
    for &v in verts {
        let p = mesh.position(v);
        let tx = if hi[0] > lo[0] {
            ((p[0] - lo[0]) / (hi[0] - lo[0])).clamp(0.0, 1.0)
        } else {
            0.5
        };
        let ty = if hi[1] > lo[1] {
            ((p[1] - lo[1]) / (hi[1] - lo[1])).clamp(0.0, 1.0)
        } else {
            0.5
        };
        let tz = if hi[2] > lo[2] {
            ((p[2] - lo[2]) / (hi[2] - lo[2])).clamp(0.0, 1.0)
        } else {
            0.5
        };
        bernstein(nx - 1, tx, &mut bx);
        bernstein(ny - 1, ty, &mut by);
        bernstein(nz - 1, tz, &mut bz);
        let mut disp = [0.0f64; 3];
        for i in 0..nx {
            for j in 0..ny {
                let wxy = bx[i] * by[j];
                if wxy == 0.0 {
                    continue;
                }
                for k in 0..nz {
                    let w = wxy * bz[k];
                    let g = grid_off[(i * ny + j) * nz + k];
                    disp[0] += w * g[0];
                    disp[1] += w * g[1];
                    disp[2] += w * g[2];
                }
            }
        }
        mesh.set_position(v, p[0] + disp[0], p[1] + disp[1], p[2] + disp[2]);
    }
    Ok(verts.len())
}

/// Mean Value Coordinates (Ju-Schaefer-Warren) cage deformation over closed triangulated rest cage.
pub fn cage_deform(
    mesh: &mut EditMesh,
    verts: &[i32],
    rest_points: &[Vec3],
    deformed_points: &[Vec3],
    cage_faces: &[Vec<usize>],
) -> Result<usize, KernelError> {
    if rest_points.len() != deformed_points.len() || rest_points.is_empty() {
        return Err(KernelError::invalid_value(
            "deformed",
            "must match cage points length",
        ));
    }
    let mut tris = Vec::new();
    for f in cage_faces {
        if f.len() == 3 {
            tris.push([f[0], f[1], f[2]]);
        } else if f.len() > 3 {
            let pts: Vec<Vec3> = f.iter().map(|&i| rest_points[i]).collect();
            if let Some(ind) = triangulate_loop(&pts) {
                for c in ind.chunks_exact(3) {
                    tris.push([f[c[0]], f[c[1]], f[c[2]]]);
                }
            }
        }
    }
    let deltas: Vec<Vec3> = rest_points
        .iter()
        .zip(deformed_points)
        .map(|(&r, &d)| sub(d, r))
        .collect();
    let n_pts = rest_points.len();

    for &v in verts {
        let p = mesh.position(v);
        let mut weights = vec![0.0f64; n_pts];
        let mut total_w = 0.0f64;
        let mut snap = None;

        let mut dists = vec![0.0f64; n_pts];
        let mut dirs = vec![[0.0; 3]; n_pts];
        for (i, &c) in rest_points.iter().enumerate() {
            let d = sub(c, p);
            let len = length(d);
            if len < 1e-10 {
                snap = Some(deformed_points[i]);
                break;
            }
            dists[i] = len;
            dirs[i] = scale(d, 1.0 / len);
        }
        if let Some(sp) = snap {
            mesh.set_position(v, sp[0], sp[1], sp[2]);
            continue;
        }

        for &[i0, i1, i2] in &tris {
            let u0 = dirs[i0];
            let u1 = dirs[i1];
            let u2 = dirs[i2];
            let l0 = length(sub(u1, u2));
            let l1 = length(sub(u2, u0));
            let l2 = length(sub(u0, u1));
            let theta = [
                2.0 * (l0 * 0.5).clamp(-1.0, 1.0).asin(),
                2.0 * (l1 * 0.5).clamp(-1.0, 1.0).asin(),
                2.0 * (l2 * 0.5).clamp(-1.0, 1.0).asin(),
            ];
            let h = 0.5 * (theta[0] + theta[1] + theta[2]);
            if (std::f64::consts::PI - h).abs() < 1e-10 {
                // point lies in triangle plane
                continue;
            }
            let sin_h = h.sin();
            let det = dot(u0, cross(u1, u2));
            let mut c_val = [0.0f64; 3];
            let mut s_val = [0.0f64; 3];
            let mut inside = true;
            for k in 0..3 {
                let s0 = (theta[k] * 0.5).sin();
                let s1 = (theta[(k + 1) % 3]).sin();
                let s2 = (theta[(k + 2) % 3]).sin();
                if s1.abs() < 1e-12 || s2.abs() < 1e-12 || s0.abs() < 1e-12 {
                    inside = false;
                    break;
                }
                c_val[k] = 2.0 * sin_h * ((h - theta[k]).sin()) / (s1 * s2) - 1.0;
                let s_sq = (1.0 - c_val[k] * c_val[k]).max(0.0);
                s_val[k] = det.signum() * s_sq.sqrt();
                if s_val[k].abs() < 1e-10 {
                    inside = false;
                    break;
                }
            }
            if !inside {
                continue;
            }
            let w0 = (theta[0] - c_val[1] * theta[2] - c_val[2] * theta[1])
                / (dists[i0] * theta[0].sin() * s_val[1]);
            let w1 = (theta[1] - c_val[2] * theta[0] - c_val[0] * theta[2])
                / (dists[i1] * theta[1].sin() * s_val[2]);
            let w2 = (theta[2] - c_val[0] * theta[1] - c_val[1] * theta[0])
                / (dists[i2] * theta[2].sin() * s_val[0]);
            if w0.is_finite() && w1.is_finite() && w2.is_finite() {
                weights[i0] += w0;
                weights[i1] += w1;
                weights[i2] += w2;
                total_w += w0 + w1 + w2;
            }
        }
        if total_w.abs() > 1e-12 {
            let mut disp = [0.0; 3];
            for i in 0..n_pts {
                let w = weights[i] / total_w;
                disp[0] += w * deltas[i][0];
                disp[1] += w * deltas[i][1];
                disp[2] += w * deltas[i][2];
            }
            mesh.set_position(v, p[0] + disp[0], p[1] + disp[1], p[2] + disp[2]);
        }
    }
    Ok(verts.len())
}

pub fn apply_draft(
    mesh: &mut EditMesh,
    faces: &[i32],
    pull_dir: Vec3,
    neutral_point: Vec3,
    angle_deg: f64,
) -> Result<usize, KernelError> {
    if !angle_deg.is_finite() || angle_deg <= 0.0 || angle_deg >= 89.0 {
        return Err(KernelError::invalid_value(
            "angle",
            "draft angle must be in (0, 89)",
        ));
    }
    let pull = normalize(pull_dir);
    let tan_a = angle_deg.to_radians().tan();
    let mut moved = HashSet::new();
    let mut verts = Vec::new();
    let mut v_normals: HashMap<i32, Vec3> = HashMap::new();
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let fn_v = face_normal(mesh, f);
        for v in mesh.face_vertices(f) {
            if moved.insert(v) {
                verts.push(v);
            }
            let e = v_normals.entry(v).or_insert([0.0; 3]);
            e[0] += fn_v[0];
            e[1] += fn_v[1];
            e[2] += fn_v[2];
        }
    }
    for v in &verts {
        let p = mesh.position(*v);
        let h = dot(sub(p, neutral_point), pull);
        let raw_n = v_normals[v];
        let perp = sub(raw_n, scale(pull, dot(raw_n, pull)));
        let out_dir = normalize(perp);
        if length(out_dir) > 1e-12 {
            let delta = scale(out_dir, -h * tan_a);
            mesh.set_position(*v, p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]);
        }
    }
    Ok(verts.len())
}

pub fn spherize_vertices(
    mesh: &mut EditMesh,
    verts: &[i32],
    factor: f64,
    radius: Option<f64>,
    center: Option<Vec3>,
) -> Result<usize, KernelError> {
    if verts.is_empty() {
        return Ok(0);
    }
    let f = factor.clamp(0.0, 1.0);
    let c = center.unwrap_or_else(|| {
        let mut s = [0.0; 3];
        for &v in verts {
            let p = mesh.position(v);
            s[0] += p[0];
            s[1] += p[1];
            s[2] += p[2];
        }
        scale(s, 1.0 / (verts.len() as f64))
    });
    let r = radius.unwrap_or_else(|| {
        let mut sum_d = 0.0;
        for &v in verts {
            sum_d += length(sub(mesh.position(v), c));
        }
        sum_d / (verts.len() as f64)
    });
    for &v in verts {
        let p = mesh.position(v);
        let d = sub(p, c);
        let l = length(d);
        if l > 1e-15 {
            let target = add(c, scale(d, r / l));
            let next = [
                p[0] + (target[0] - p[0]) * f,
                p[1] + (target[1] - p[1]) * f,
                p[2] + (target[2] - p[2]) * f,
            ];
            mesh.set_position(v, next[0], next[1], next[2]);
        }
    }
    Ok(verts.len())
}

pub fn curve_deform_vertices(
    mesh: &mut EditMesh,
    verts: &[i32],
    path: &[Vec3],
    axis: usize,
    origin: Option<Vec3>,
) -> Result<usize, KernelError> {
    if path.len() < 2 {
        return Err(KernelError::invalid_value(
            "path",
            "curve requires at least 2 points",
        ));
    }
    let ax = axis.min(2);
    let u_ax = (ax + 1) % 3;
    let v_ax = (ax + 2) % 3;
    let (lo, hi) = bounds_of(mesh, verts);
    let orig = origin.unwrap_or([
        if ax == 0 {
            lo[0]
        } else {
            0.5 * (lo[0] + hi[0])
        },
        if ax == 1 {
            lo[1]
        } else {
            0.5 * (lo[1] + hi[1])
        },
        if ax == 2 {
            lo[2]
        } else {
            0.5 * (lo[2] + hi[2])
        },
    ]);

    // Build cumulative arc lengths & RMF along path
    let mut arc = vec![0.0f64; path.len()];
    let mut tangents = Vec::with_capacity(path.len());
    for i in 1..path.len() {
        arc[i] = arc[i - 1] + length(sub(path[i], path[i - 1]));
    }
    for i in 0..path.len() {
        let t = if i == 0 {
            normalize(sub(path[1], path[0]))
        } else if i + 1 == path.len() {
            normalize(sub(path[i], path[i - 1]))
        } else {
            normalize(sub(path[i + 1], path[i - 1]))
        };
        tangents.push(t);
    }

    // Initial frame normal
    let t0 = tangents[0];
    let mut up_ref = [0.0, 1.0, 0.0];
    if dot(t0, up_ref).abs() > 0.9 {
        up_ref = [0.0, 0.0, 1.0];
    }
    let mut n_frame = normalize(sub(up_ref, scale(t0, dot(up_ref, t0))));
    let mut normals = Vec::with_capacity(path.len());
    let mut binormals = Vec::with_capacity(path.len());
    for i in 0..path.len() {
        let ti = tangents[i];
        n_frame = normalize(sub(n_frame, scale(ti, dot(n_frame, ti))));
        normals.push(n_frame);
        binormals.push(cross(ti, n_frame));
    }

    let total_arc = arc[path.len() - 1].max(1e-12);
    for &v in verts {
        let p = mesh.position(v);
        let s = (p[ax] - orig[ax]).clamp(0.0, total_arc);
        let du = p[u_ax] - orig[u_ax];
        let dv = p[v_ax] - orig[v_ax];
        let idx = arc
            .partition_point(|&a| a < s)
            .saturating_sub(1)
            .min(path.len() - 2);
        let seg_len = (arc[idx + 1] - arc[idx]).max(1e-12);
        let alpha = ((s - arc[idx]) / seg_len).clamp(0.0, 1.0);
        let pos_c = [
            path[idx][0] + (path[idx + 1][0] - path[idx][0]) * alpha,
            path[idx][1] + (path[idx + 1][1] - path[idx][1]) * alpha,
            path[idx][2] + (path[idx + 1][2] - path[idx][2]) * alpha,
        ];
        let nc = normalize([
            normals[idx][0] + (normals[idx + 1][0] - normals[idx][0]) * alpha,
            normals[idx][1] + (normals[idx + 1][1] - normals[idx][1]) * alpha,
            normals[idx][2] + (normals[idx + 1][2] - normals[idx][2]) * alpha,
        ]);
        let bc = normalize([
            binormals[idx][0] + (binormals[idx + 1][0] - binormals[idx][0]) * alpha,
            binormals[idx][1] + (binormals[idx + 1][1] - binormals[idx][1]) * alpha,
            binormals[idx][2] + (binormals[idx + 1][2] - binormals[idx][2]) * alpha,
        ]);
        let out = [
            pos_c[0] + nc[0] * du + bc[0] * dv,
            pos_c[1] + nc[1] * du + bc[1] * dv,
            pos_c[2] + nc[2] * du + bc[2] * dv,
        ];
        mesh.set_position(v, out[0], out[1], out[2]);
    }
    Ok(verts.len())
}

/// Taubin lambda/mu explicit smoothing preserving boundary & sharp vertices by default.
pub fn taubin_smooth(
    mesh: &mut EditMesh,
    verts: &[i32],
    lambda: f64,
    mu: f64,
    iterations: usize,
    pin_boundary: bool,
    pin_sharp: bool,
) -> Result<usize, KernelError> {
    let mut adj: HashMap<i32, Vec<i32>> = HashMap::new();
    let mut pinned = HashSet::new();
    for &v in verts {
        adj.entry(v).or_default();
    }
    for e in mesh.edges() {
        let [a, b] = mesh.edge_vertices(e);
        if pin_boundary && mesh.is_boundary_edge(e) {
            pinned.insert(a);
            pinned.insert(b);
        }
        if pin_sharp && (mesh.e_flags[e as usize] & EDGE_SHARP) != 0 {
            pinned.insert(a);
            pinned.insert(b);
        }
        if adj.contains_key(&a) {
            adj.get_mut(&a).unwrap().push(b);
        }
        if adj.contains_key(&b) {
            adj.get_mut(&b).unwrap().push(a);
        }
    }
    for _ in 0..iterations.clamp(1, 200) {
        for &step in &[lambda, mu] {
            if step == 0.0 {
                continue;
            }
            let snap: HashMap<i32, Vec3> = verts.iter().map(|&v| (v, mesh.position(v))).collect();
            for &v in verts {
                if pinned.contains(&v) {
                    continue;
                }
                let nbs = &adj[&v];
                if nbs.is_empty() {
                    continue;
                }
                let p = snap[&v];
                let mut avg = [0.0; 3];
                for &u in nbs {
                    let pu = mesh.position(u);
                    avg[0] += pu[0];
                    avg[1] += pu[1];
                    avg[2] += pu[2];
                }
                let inv = 1.0 / (nbs.len() as f64);
                let target = scale(avg, inv);
                let next = add(p, scale(sub(target, p), step));
                mesh.set_position(v, next[0], next[1], next[2]);
            }
        }
    }
    Ok(verts.len())
}

/// Backward-Euler cotangent-Laplacian implicit fairing `(M - dt * L) x_next = M x` solved via Jacobi-PCG.
pub fn implicit_smooth(
    mesh: &mut EditMesh,
    verts: &[i32],
    lambda: f64,
    iterations: usize,
    extra_pins: &HashSet<i32>,
    pin_boundary: bool,
    pin_sharp: bool,
    preserve_volume: bool,
) -> Result<usize, KernelError> {
    if !lambda.is_finite() || lambda <= 0.0 {
        return Err(KernelError::invalid_value("lambda", "must be > 0"));
    }
    let mut pinned = extra_pins.clone();
    for e in mesh.edges() {
        let [a, b] = mesh.edge_vertices(e);
        if (pin_boundary && mesh.is_boundary_edge(e))
            || (pin_sharp && (mesh.e_flags[e as usize] & EDGE_SHARP) != 0)
        {
            pinned.insert(a);
            pinned.insert(b);
        }
    }
    let mut free_map: HashMap<i32, usize> = HashMap::new();
    let mut free_verts = Vec::new();
    for &v in verts {
        if !pinned.contains(&v) {
            free_map.insert(v, free_verts.len());
            free_verts.push(v);
        }
    }
    if free_verts.is_empty() {
        return Ok(0);
    }

    let n = free_verts.len();
    let vol_before = if preserve_volume {
        Some(volume_about(mesh, [0.0; 3]))
    } else {
        None
    };
    for _ in 0..iterations.clamp(1, 100) {
        let (cot_w, areas) = build_cotangent_laplacian(mesh, verts);
        let mean_area = if areas.is_empty() {
            1.0
        } else {
            areas.values().sum::<f64>() / (areas.len() as f64)
        };
        let dt = lambda * mean_area;

        let mut triplets = TripletList::new();
        let mut bx = vec![0.0; n];
        let mut by = vec![0.0; n];
        let mut bz = vec![0.0; n];
        let mut diag_w = vec![0.0; n];

        for &(a, b) in cot_w.keys() {
            let w = cot_w[&(a, b)];
            let ia = free_map.get(&a).copied();
            let ib = free_map.get(&b).copied();
            if let Some(ia_i) = ia {
                diag_w[ia_i] += dt * w;
                if let Some(ib_i) = ib {
                    triplets.push(ia_i, ib_i, -dt * w);
                    triplets.push(ib_i, ia_i, -dt * w);
                    diag_w[ib_i] += dt * w;
                } else {
                    let pb = mesh.position(b);
                    bx[ia_i] += dt * w * pb[0];
                    by[ia_i] += dt * w * pb[1];
                    bz[ia_i] += dt * w * pb[2];
                }
            } else if let Some(ib_i) = ib {
                diag_w[ib_i] += dt * w;
                let pa = mesh.position(a);
                bx[ib_i] += dt * w * pa[0];
                by[ib_i] += dt * w * pa[1];
                bz[ib_i] += dt * w * pa[2];
            }
        }
        for (i, &v) in free_verts.iter().enumerate() {
            let m_i = areas.get(&v).copied().unwrap_or(mean_area).max(1e-12);
            let p = mesh.position(v);
            triplets.push(i, i, m_i + diag_w[i]);
            bx[i] += m_i * p[0];
            by[i] += m_i * p[1];
            bz[i] += m_i * p[2];
        }
        let mat = CsrMatrix::from_triplets(n, &triplets);
        let nx = solve_pcg(&mat, &bx, 1e-10, (n * 4).max(100));
        let ny = solve_pcg(&mat, &by, 1e-10, (n * 4).max(100));
        let nz = solve_pcg(&mat, &bz, 1e-10, (n * 4).max(100));
        for (i, &v) in free_verts.iter().enumerate() {
            mesh.set_position(v, nx[i], ny[i], nz[i]);
        }
    }
    if let Some(v0) = vol_before {
        let v1 = volume_about(mesh, [0.0; 3]);
        if v0.abs() > 1e-12 && v1.abs() > 1e-12 {
            let s = (v0 / v1).abs().cbrt();
            let c = [0.0; 3];
            for &v in &free_verts {
                let p = mesh.position(v);
                mesh.set_position(v, c[0] + p[0] * s, c[1] + p[1] * s, c[2] + p[2] * s);
            }
        }
    }
    Ok(free_verts.len())
}

/// BVH-accelerated surface shrinkwrap along vertex nearest point or bidirectional ray projection.
pub fn shrinkwrap_vertices(
    mesh: &mut EditMesh,
    verts: &[i32],
    target_pos: &[f64],
    target_indices: &[u32],
    project_dir: Option<Vec3>,
    offset: f64,
    max_distance: Option<f64>,
) -> Result<usize, KernelError> {
    if target_indices.is_empty() {
        return Err(KernelError::invalid_value(
            "onto",
            "target surface is empty",
        ));
    }
    let bvh = TriSoupBvh::build(target_pos, target_indices, None);
    let max_d2 = max_distance.map_or(f64::INFINITY, |d| d * d);

    let tri_normal = |t: usize| -> Vec3 {
        let i0 = (target_indices[t * 3] as usize) * 3;
        let i1 = (target_indices[t * 3 + 1] as usize) * 3;
        let i2 = (target_indices[t * 3 + 2] as usize) * 3;
        let a = [target_pos[i0], target_pos[i0 + 1], target_pos[i0 + 2]];
        let b = [target_pos[i1], target_pos[i1 + 1], target_pos[i1 + 2]];
        let c = [target_pos[i2], target_pos[i2 + 1], target_pos[i2 + 2]];
        normalize(cross(sub(b, a), sub(c, a)))
    };

    let mut moved = 0usize;
    for &v in verts {
        let p = mesh.position(v);
        let hit_q = if let Some(dir) = project_dir {
            let d = normalize(dir);
            let max_d = max_distance.unwrap_or(f64::INFINITY);
            let h1 = bvh.raycast_filtered(p, d, 0.0, max_d, |_| true);
            let h2 = bvh.raycast_filtered(p, [-d[0], -d[1], -d[2]], 0.0, max_d, |_| true);
            match (h1, h2) {
                (Some(a), Some(b)) => Some(if a.t <= b.t {
                    (a.triangle, add(p, scale(d, a.t)))
                } else {
                    (b.triangle, add(p, scale(d, -b.t)))
                }),
                (Some(a), None) => Some((a.triangle, add(p, scale(d, a.t)))),
                (None, Some(b)) => Some((b.triangle, add(p, scale(d, -b.t)))),
                (None, None) => None,
            }
        } else {
            bvh.nearest_filtered(p, max_d2, |_| true).map(|nr| {
                let i0 = (target_indices[nr.triangle * 3] as usize) * 3;
                let i1 = (target_indices[nr.triangle * 3 + 1] as usize) * 3;
                let i2 = (target_indices[nr.triangle * 3 + 2] as usize) * 3;
                let w0 = 1.0 - nr.u - nr.v;
                let q = [
                    w0 * target_pos[i0] + nr.u * target_pos[i1] + nr.v * target_pos[i2],
                    w0 * target_pos[i0 + 1] + nr.u * target_pos[i1 + 1] + nr.v * target_pos[i2 + 1],
                    w0 * target_pos[i0 + 2] + nr.u * target_pos[i1 + 2] + nr.v * target_pos[i2 + 2],
                ];
                (nr.triangle, q)
            })
        };
        if let Some((tri, q)) = hit_q {
            let n = tri_normal(tri);
            let dst = add(q, scale(n, offset));
            mesh.set_position(v, dst[0], dst[1], dst[2]);
            moved += 1;
        }
    }
    let _ = NONE;
    Ok(moved)
}

/// Nearest-rotation polar fit (3x3 Jacobi eigendecomposition of S^T S or iterative orthogonalization) for ARAP.
fn closest_rotation_3x3(s: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    // Higham polar decomposition iteration R_{k+1} = 0.5 * (R_k + R_k^{-T}) - converges in ~8 steps
    let mut r = s;
    for _ in 0..12 {
        let det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
            - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
            + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
        if det.abs() < 1e-18 {
            return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        }
        let inv_det = 1.0 / det;
        // Inverse-transpose entries of r
        let it = [
            [
                (r[1][1] * r[2][2] - r[1][2] * r[2][1]) * inv_det,
                (r[1][2] * r[2][0] - r[1][0] * r[2][2]) * inv_det,
                (r[1][0] * r[2][1] - r[1][1] * r[2][0]) * inv_det,
            ],
            [
                (r[0][2] * r[2][1] - r[0][1] * r[2][2]) * inv_det,
                (r[0][0] * r[2][2] - r[0][2] * r[2][0]) * inv_det,
                (r[0][1] * r[2][0] - r[0][0] * r[2][1]) * inv_det,
            ],
            [
                (r[0][1] * r[1][2] - r[0][2] * r[1][1]) * inv_det,
                (r[0][2] * r[1][0] - r[0][0] * r[1][2]) * inv_det,
                (r[0][0] * r[1][1] - r[0][1] * r[1][0]) * inv_det,
            ],
        ];
        let mut diff = 0.0;
        for i in 0..3 {
            for j in 0..3 {
                let next = 0.5 * (r[i][j] + it[i][j]);
                diff += (next - r[i][j]).abs();
                r[i][j] = next;
            }
        }
        if diff < 1e-12 {
            break;
        }
    }
    r
}

/// As-Rigid-As-Possible local-global surface deformation over `verts`, fixed `constraints` -> target positions.
pub fn arap_deform(
    mesh: &mut EditMesh,
    verts: &[i32],
    constraints: &HashMap<i32, Vec3>,
    iterations: usize,
) -> Result<usize, KernelError> {
    let mut free_map = HashMap::new();
    let mut free_verts = Vec::new();
    for &v in verts {
        if !constraints.contains_key(&v) {
            free_map.insert(v, free_verts.len());
            free_verts.push(v);
        }
    }
    if free_verts.is_empty() {
        for (&v, &p) in constraints {
            mesh.set_position(v, p[0], p[1], p[2]);
        }
        return Ok(0);
    }

    let rest_pos: HashMap<i32, Vec3> = verts.iter().map(|&v| (v, mesh.position(v))).collect();
    let (cot_w, _) = build_cotangent_laplacian(mesh, verts);
    let mut adj: HashMap<i32, Vec<(i32, f64)>> = HashMap::new();
    for &v in verts {
        adj.entry(v).or_default();
    }
    for (&(a, b), &w) in &cot_w {
        if adj.contains_key(&a) && adj.contains_key(&b) {
            adj.get_mut(&a).unwrap().push((b, w));
            adj.get_mut(&b).unwrap().push((a, w));
        }
    }

    // Apply handle/pin positions
    for (&v, &p) in constraints {
        mesh.set_position(v, p[0], p[1], p[2]);
    }

    // Assemble fixed sparse system matrix once
    let n = free_verts.len();
    let mut triplets = TripletList::new();
    let mut diag = vec![0.0f64; n];
    for (i, &vi) in free_verts.iter().enumerate() {
        for &(vj, w) in &adj[&vi] {
            diag[i] += w;
            if let Some(&j) = free_map.get(&vj) {
                triplets.push(i, j, -w);
            }
        }
        triplets.push(i, i, diag[i].max(1e-12));
    }
    let sys = CsrMatrix::from_triplets(n, &triplets);
    let mut rotations: HashMap<i32, [[f64; 3]; 3]> = HashMap::new();

    for _ in 0..iterations.clamp(1, 200) {
        // Local step: fit rotation R_i per vertex cell
        for &v in verts {
            let pi_0 = rest_pos[&v];
            let pi_c = mesh.position(v);
            let mut s = [[0.0f64; 3]; 3];
            for &(u, w) in &adj[&v] {
                let d0 = sub(rest_pos[&u], pi_0);
                let dc = sub(mesh.position(u), pi_c);
                for a in 0..3 {
                    for b in 0..3 {
                        s[a][b] += w * dc[a] * d0[b];
                    }
                }
            }
            rotations.insert(v, closest_rotation_3x3(s));
        }

        // Global step: solve L p' = rhs
        let mut bx = vec![0.0; n];
        let mut by = vec![0.0; n];
        let mut bz = vec![0.0; n];
        for (i, &vi) in free_verts.iter().enumerate() {
            let ri = rotations[&vi];
            let p0_i = rest_pos[&vi];
            for &(vj, w) in &adj[&vi] {
                let rj = rotations[&vj];
                let d0 = sub(p0_i, rest_pos[&vj]);
                let avg_r = [
                    0.5 * ((ri[0][0] + rj[0][0]) * d0[0]
                        + (ri[0][1] + rj[0][1]) * d0[1]
                        + (ri[0][2] + rj[0][2]) * d0[2]),
                    0.5 * ((ri[1][0] + rj[1][0]) * d0[0]
                        + (ri[1][1] + rj[1][1]) * d0[1]
                        + (ri[1][2] + rj[1][2]) * d0[2]),
                    0.5 * ((ri[2][0] + rj[2][0]) * d0[0]
                        + (ri[2][1] + rj[2][1]) * d0[1]
                        + (ri[2][2] + rj[2][2]) * d0[2]),
                ];
                bx[i] += w * avg_r[0];
                by[i] += w * avg_r[1];
                bz[i] += w * avg_r[2];
                if !free_map.contains_key(&vj) {
                    let pv = mesh.position(vj);
                    bx[i] += w * pv[0];
                    by[i] += w * pv[1];
                    bz[i] += w * pv[2];
                }
            }
        }
        let nx = solve_pcg(&sys, &bx, 1e-10, (n * 4).max(100));
        let ny = solve_pcg(&sys, &by, 1e-10, (n * 4).max(100));
        let nz = solve_pcg(&sys, &bz, 1e-10, (n * 4).max(100));
        for (i, &v) in free_verts.iter().enumerate() {
            mesh.set_position(v, nx[i], ny[i], nz[i]);
        }
    }
    Ok(free_verts.len())
}
