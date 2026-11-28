//! Sparse CSR matrix, Jacobi-preconditioned Conjugate Gradient solver, and cotangent Laplacian assembly.

use std::collections::{BTreeMap, HashMap};

use crate::mesh::geom::{cross, dot, length, sub, Vec3};
use crate::mesh::EditMesh;

#[derive(Debug, Clone)]
pub struct TripletList {
    pub rows: Vec<usize>,
    pub cols: Vec<usize>,
    pub vals: Vec<f64>,
}

impl TripletList {
    pub fn new() -> Self {
        Self {
            rows: Vec::new(),
            cols: Vec::new(),
            vals: Vec::new(),
        }
    }

    #[inline]
    pub fn push(&mut self, r: usize, c: usize, v: f64) {
        if v != 0.0 && v.is_finite() {
            self.rows.push(r);
            self.cols.push(c);
            self.vals.push(v);
        }
    }
}

#[derive(Debug, Clone)]
pub struct CsrMatrix {
    pub n: usize,
    pub row_ptr: Vec<usize>,
    pub col_idx: Vec<usize>,
    pub values: Vec<f64>,
    pub diag: Vec<f64>,
}

impl CsrMatrix {
    pub fn from_triplets(n: usize, triplets: &TripletList) -> Self {
        let mut rows: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); n];
        for i in 0..triplets.rows.len() {
            let r = triplets.rows[i];
            let c = triplets.cols[i];
            if r < n && c < n {
                *rows[r].entry(c).or_insert(0.0) += triplets.vals[i];
            }
        }
        let mut row_ptr = Vec::with_capacity(n + 1);
        let mut col_idx = Vec::new();
        let mut values = Vec::new();
        let mut diag = vec![0.0f64; n];
        row_ptr.push(0);
        for (r, map) in rows.into_iter().enumerate() {
            for (c, v) in map {
                if v != 0.0 {
                    if c == r {
                        diag[r] = v;
                    }
                    col_idx.push(c);
                    values.push(v);
                }
            }
            row_ptr.push(col_idx.len());
        }
        Self {
            n,
            row_ptr,
            col_idx,
            values,
            diag,
        }
    }

    pub fn mul_vec(&self, x: &[f64], y: &mut [f64]) {
        for r in 0..self.n {
            let mut sum = 0.0;
            for idx in self.row_ptr[r]..self.row_ptr[r + 1] {
                sum += self.values[idx] * x[self.col_idx[idx]];
            }
            y[r] = sum;
        }
    }
}

/// Jacobi-preconditioned Conjugate Gradient for symmetric positive-definite `A x = b`.
pub fn solve_pcg(a: &CsrMatrix, b: &[f64], tol: f64, max_iter: usize) -> Vec<f64> {
    let n = a.n;
    let mut x = vec![0.0f64; n];
    if n == 0 {
        return x;
    }
    let mut r = b.to_vec();
    let mut inv_m = vec![1.0f64; n];
    for i in 0..n {
        if a.diag[i].abs() > 1e-18 {
            inv_m[i] = 1.0 / a.diag[i];
        }
    }
    let mut z: Vec<f64> = (0..n).map(|i| r[i] * inv_m[i]).collect();
    let mut p = z.clone();
    let mut rz: f64 = r.iter().zip(&z).map(|(ri, zi)| ri * zi).sum();
    let b_norm2: f64 = b.iter().map(|v| v * v).sum();
    let tol2 = tol * tol * b_norm2.max(1e-24);
    let mut ap = vec![0.0f64; n];

    for _ in 0..max_iter.max(n * 4) {
        let r2: f64 = r.iter().map(|v| v * v).sum();
        if r2 <= tol2 {
            break;
        }
        a.mul_vec(&p, &mut ap);
        let p_ap: f64 = p.iter().zip(&ap).map(|(pi, api)| pi * api).sum();
        if p_ap.abs() < 1e-30 {
            break;
        }
        let alpha = rz / p_ap;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
            z[i] = r[i] * inv_m[i];
        }
        let rz_next: f64 = r.iter().zip(&z).map(|(ri, zi)| ri * zi).sum();
        if rz.abs() < 1e-30 {
            break;
        }
        let beta = rz_next / rz;
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
        rz = rz_next;
    }
    x
}

/// Cotangent Laplacian edge weights `(va, vb) -> w` and Voronoi vertex areas over `mesh`.
pub fn build_cotangent_laplacian(
    mesh: &EditMesh,
    verts: &[i32],
) -> (HashMap<(i32, i32), f64>, HashMap<i32, f64>) {
    const W_MIN: f64 = 1e-3;
    const W_MAX: f64 = 1e3;
    let allowed: HashMap<i32, usize> = verts.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let mut weights: HashMap<(i32, i32), f64> = HashMap::new();
    let mut areas: HashMap<i32, f64> = HashMap::new();

    for f in mesh.faces() {
        let fv = mesh.face_vertices(f);
        if fv.len() < 3 {
            continue;
        }
        if !fv.iter().any(|v| allowed.contains_key(v)) {
            continue;
        }
        let v0 = fv[0];
        let p0 = mesh.position(v0);
        for i in 1..(fv.len() - 1) {
            let v1 = fv[i];
            let v2 = fv[i + 1];
            let p1 = mesh.position(v1);
            let p2 = mesh.position(v2);
            let tri = [v0, v1, v2];
            let pos = [p0, p1, p2];
            let area = length(cross(sub(p1, p0), sub(p2, p0))) * 0.5;
            if area <= 1e-18 {
                continue;
            }
            for k in 0..3 {
                *areas.entry(tri[k]).or_insert(0.0) += area / 3.0;
                let a = tri[k];
                let b = tri[(k + 1) % 3];
                let _opp = tri[(k + 2) % 3];
                let pa = pos[k];
                let pb = pos[(k + 1) % 3];
                let po = pos[(k + 2) % 3];
                let u = sub(pa, po);
                let v = sub(pb, po);
                let cr = length(cross(u, v));
                let cot = if cr > 1e-15 {
                    (0.5 * dot(u, v) / cr).clamp(W_MIN, W_MAX)
                } else {
                    W_MIN
                };
                let key = if a < b { (a, b) } else { (b, a) };
                *weights.entry(key).or_insert(0.0) += cot;
                let _ = Vec3::default();
            }
        }
    }
    (weights, areas)
}
