//! Narrow-band signed distance grids (`FXSD` v1) and dual Surface Nets iso-meshing.
//! Powers `voxel.fromMesh`, `voxel.toMesh`, `voxel.union`, `voxel.offset`, and `voxel.fillHoles`.

use std::collections::HashMap;

use crate::error::KernelError;
use crate::mesh::bvh::{winding_number, TriSoupBvh};
use crate::mesh::geom::{cross, dot, length, sub, Vec3};
use crate::mesh::rewrite::triangulate_loop;
use crate::mesh::EditMesh;
use crate::ops::primitives::Attribution;

pub const SDF_MAGIC: u32 = 0x4453_5846; // 'FXSD'
pub const SDF_VERSION: u32 = 1;
pub const SDF_HEADER: usize = 56;
pub const MAX_SDF_SAMPLES: usize = 1 << 24;

#[derive(Debug, Clone)]
pub struct SdfGrid {
    pub origin: Vec3,
    pub voxel_size: f64,
    pub dims: [u32; 3],
    pub band: u32,
    pub values: Vec<f64>,
    pub nearest: Vec<i32>,
}

impl SdfGrid {
    pub fn encode(&self) -> Vec<u8> {
        let n = self.values.len();
        let mut out = vec![0u8; SDF_HEADER + n * 12];
        out[0..4].copy_from_slice(&SDF_MAGIC.to_le_bytes());
        out[4..8].copy_from_slice(&SDF_VERSION.to_le_bytes());
        out[8..12].copy_from_slice(&self.dims[0].to_le_bytes());
        out[12..16].copy_from_slice(&self.dims[1].to_le_bytes());
        out[16..20].copy_from_slice(&self.dims[2].to_le_bytes());
        out[20..24].copy_from_slice(&self.band.to_le_bytes());
        out[24..32].copy_from_slice(&self.origin[0].to_le_bytes());
        out[32..40].copy_from_slice(&self.origin[1].to_le_bytes());
        out[40..48].copy_from_slice(&self.origin[2].to_le_bytes());
        out[48..56].copy_from_slice(&self.voxel_size.to_le_bytes());
        for (i, &v) in self.values.iter().enumerate() {
            let off = SDF_HEADER + i * 8;
            out[off..off + 8].copy_from_slice(&v.to_le_bytes());
        }
        let n_base = SDF_HEADER + n * 8;
        for (i, &idx) in self.nearest.iter().enumerate() {
            let off = n_base + i * 4;
            out[off..off + 4].copy_from_slice(&idx.to_le_bytes());
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, KernelError> {
        if bytes.len() < SDF_HEADER {
            return Err(KernelError::invalid_value("sdf", "FXSD buffer too short"));
        }
        let magic = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let ver = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if magic != SDF_MAGIC || ver != SDF_VERSION {
            return Err(KernelError::invalid_value(
                "sdf",
                "invalid FXSD magic or version",
            ));
        }
        let dims = [
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            u32::from_le_bytes(bytes[16..20].try_into().unwrap()),
        ];
        let n = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize);
        if dims.iter().any(|&d| d < 2) || n > MAX_SDF_SAMPLES || bytes.len() != SDF_HEADER + n * 12
        {
            return Err(KernelError::invalid_value("sdf", "invalid FXSD dimensions"));
        }
        let band = u32::from_le_bytes(bytes[20..24].try_into().unwrap());
        let origin = [
            f64::from_le_bytes(bytes[24..32].try_into().unwrap()),
            f64::from_le_bytes(bytes[32..40].try_into().unwrap()),
            f64::from_le_bytes(bytes[40..48].try_into().unwrap()),
        ];
        let voxel_size = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
        let mut values = Vec::with_capacity(n);
        for i in 0..n {
            let off = SDF_HEADER + i * 8;
            values.push(f64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
        }
        let n_base = SDF_HEADER + n * 8;
        let mut nearest = Vec::with_capacity(n);
        for i in 0..n {
            let off = n_base + i * 4;
            nearest.push(i32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()));
        }
        Ok(Self {
            origin,
            voxel_size,
            dims,
            band,
            values,
            nearest,
        })
    }
}

pub fn build_sdf_from_mesh(
    mesh: &EditMesh,
    faces: &[i32],
    voxel_size: f64,
    band: u32,
    margin: f64,
) -> Result<SdfGrid, KernelError> {
    if !voxel_size.is_finite() || voxel_size <= 0.0 {
        return Err(KernelError::invalid_value("voxelSize", "must be > 0"));
    }
    if faces.is_empty() {
        return Err(KernelError::invalid_value(
            "faces",
            "no faces provided for voxelize",
        ));
    }
    let mut positions = Vec::new();
    let mut vert_map = HashMap::new();
    let mut indices = Vec::new();
    let mut tri_face = Vec::new();
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];

    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        let fv = mesh.face_vertices(f);
        if fv.len() < 3 {
            continue;
        }
        let pts: Vec<Vec3> = fv.iter().map(|&v| mesh.position(v)).collect();
        let tri_idx = if fv.len() == 3 {
            vec![0, 1, 2]
        } else {
            triangulate_loop(&pts).ok_or_else(|| {
                KernelError::invalid_value("face", "degenerate polygon in voxelize")
            })?
        };
        let mut local_ids = Vec::with_capacity(fv.len());
        for (vi, &v) in fv.iter().enumerate() {
            let p = pts[vi];
            for c in 0..3 {
                lo[c] = lo[c].min(p[c]);
                hi[c] = hi[c].max(p[c]);
            }
            let id = *vert_map.entry(v).or_insert_with(|| {
                let idx = (positions.len() / 3) as u32;
                positions.extend_from_slice(&p);
                idx
            });
            local_ids.push(id);
        }
        for ch in tri_idx.chunks_exact(3) {
            indices.push(local_ids[ch[0]]);
            indices.push(local_ids[ch[1]]);
            indices.push(local_ids[ch[2]]);
            tri_face.push(f);
        }
    }

    let b = band.max(2);
    let pad = (b as f64) * voxel_size + margin.max(0.0);
    let origin = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
    let dims = [
        (((hi[0] - lo[0] + 2.0 * pad) / voxel_size).ceil() as u32).max(2) + 1,
        (((hi[1] - lo[1] + 2.0 * pad) / voxel_size).ceil() as u32).max(2) + 1,
        (((hi[2] - lo[2] + 2.0 * pad) / voxel_size).ceil() as u32).max(2) + 1,
    ];
    let total = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize);
    if total > MAX_SDF_SAMPLES {
        return Err(KernelError::invalid_value(
            "voxelSize",
            "voxel grid exceeds MAX_SDF_SAMPLES",
        ));
    }

    let bvh = TriSoupBvh::build(&positions, &indices, None);
    let band_dist = (b as f64) * voxel_size;
    let band_dist_sq = band_dist * band_dist;
    let nx = dims[0] as usize;
    let ny = dims[1] as usize;
    let nz = dims[2] as usize;
    let mut values = vec![band_dist; total];
    let mut nearest = vec![-1i32; total];

    // Fast winding-number / ray-parity sign within the narrow band + propagation outside band
    // Step 1: exact distance within narrow band & parity ray crossings along +X per (y,z) scanline
    let mut inside_mask = vec![false; total];
    for z in 0..nz {
        let pz = origin[2] + (z as f64) * voxel_size;
        for y in 0..ny {
            let py = origin[1] + (y as f64) * voxel_size;
            let mut crossings = Vec::new();
            let dir = [1.0, 1e-7, 1.3e-7];
            let mut t_cur = 0.0;
            let max_x = (nx as f64) * voxel_size + voxel_size;
            let ray_orig = [origin[0] - voxel_size, py, pz];
            for _ in 0..64 {
                if let Some(hit) =
                    bvh.raycast_filtered(ray_orig, dir, t_cur + 1e-9, max_x, |_| true)
                {
                    crossings.push(ray_orig[0] + hit.t * dir[0]);
                    t_cur = hit.t;
                } else {
                    break;
                }
            }
            let mut c_idx = 0usize;
            let mut parity = false;
            for x in 0..nx {
                let px = origin[0] + (x as f64) * voxel_size;
                while c_idx < crossings.len() && crossings[c_idx] <= px {
                    parity = !parity;
                    c_idx += 1;
                }
                inside_mask[(z * ny + y) * nx + x] = parity;
            }
        }
    }

    // Refine within narrow band using nearest distance & generalized winding check if near surface
    for z in 0..nz {
        let pz = origin[2] + (z as f64) * voxel_size;
        for y in 0..ny {
            let py = origin[1] + (y as f64) * voxel_size;
            for x in 0..nx {
                let idx = (z * ny + y) * nx + x;
                let px = origin[0] + (x as f64) * voxel_size;
                let p = [px, py, pz];
                if let Some(nr) = bvh.nearest_filtered(p, band_dist_sq, |_| true) {
                    let dist = nr.distance_squared.sqrt().min(band_dist);
                    let w = winding_number(mesh, faces, p);
                    let inside = if (w - 0.5).abs() > 0.15 {
                        w > 0.5
                    } else {
                        inside_mask[idx]
                    };
                    values[idx] = if inside { -dist } else { dist };
                    nearest[idx] = tri_face[nr.triangle];
                } else {
                    values[idx] = if inside_mask[idx] {
                        -band_dist
                    } else {
                        band_dist
                    };
                }
            }
        }
    }

    Ok(SdfGrid {
        origin,
        voxel_size,
        dims,
        band: b,
        values,
        nearest,
    })
}

/// Dual Surface Nets extraction of `iso` level set into an oriented quad/triangle `EditMesh`.
pub fn surface_nets_to_mesh(
    grid: &SdfGrid,
    iso: f64,
    attr: Attribution,
) -> Result<EditMesh, KernelError> {
    let nx = grid.dims[0] as usize;
    let ny = grid.dims[1] as usize;
    let nz = grid.dims[2] as usize;
    let vs = grid.voxel_size;
    let mut out = EditMesh::new();

    #[inline]
    fn idx(x: usize, y: usize, z: usize, nx: usize, ny: usize) -> usize {
        (z * ny + y) * nx + x
    }

    const CORNERS: [(usize, usize, usize); 8] = [
        (0, 0, 0),
        (1, 0, 0),
        (0, 1, 0),
        (1, 1, 0),
        (0, 0, 1),
        (1, 0, 1),
        (0, 1, 1),
        (1, 1, 1),
    ];
    const EDGES: [(usize, usize); 12] = [
        (0, 1),
        (2, 3),
        (4, 5),
        (6, 7),
        (0, 2),
        (1, 3),
        (4, 6),
        (5, 7),
        (0, 4),
        (1, 5),
        (2, 6),
        (3, 7),
    ];

    let cx_n = nx - 1;
    let cy_n = ny - 1;
    let cz_n = nz - 1;
    let mut cell_vert = vec![-1i32; cx_n * cy_n * cz_n];

    for cz in 0..cz_n {
        for cy in 0..cy_n {
            for cx in 0..cx_n {
                let mut mask = 0u8;
                let mut vals = [0.0f64; 8];
                for (ci, &(dx, dy, dz)) in CORNERS.iter().enumerate() {
                    let v = grid.values[idx(cx + dx, cy + dy, cz + dz, nx, ny)] - iso;
                    vals[ci] = v;
                    if v < 0.0 {
                        mask |= 1 << ci;
                    }
                }
                if mask == 0 || mask == 255 {
                    continue;
                }
                let mut sum = [0.0f64; 3];
                let mut crossings = 0usize;
                for &(a, b) in &EDGES {
                    let va = vals[a];
                    let vb = vals[b];
                    if (va < 0.0) == (vb < 0.0) {
                        continue;
                    }
                    let denom = va - vb;
                    let t = if denom.abs() > 1e-18 {
                        (va / denom).clamp(0.0, 1.0)
                    } else {
                        0.5
                    };
                    let ca = CORNERS[a];
                    let cb = CORNERS[b];
                    sum[0] += grid.origin[0]
                        + ((cx + ca.0) as f64 + t * ((cb.0 as isize - ca.0 as isize) as f64)) * vs;
                    sum[1] += grid.origin[1]
                        + ((cy + ca.1) as f64 + t * ((cb.1 as isize - ca.1 as isize) as f64)) * vs;
                    sum[2] += grid.origin[2]
                        + ((cz + ca.2) as f64 + t * ((cb.2 as isize - ca.2 as isize) as f64)) * vs;
                    crossings += 1;
                }
                if crossings > 0 {
                    let inv = 1.0 / (crossings as f64);
                    let vid = out.add_vertex(sum[0] * inv, sum[1] * inv, sum[2] * inv)?;
                    cell_vert[(cz * cy_n + cy) * cx_n + cx] = vid;
                }
            }
        }
    }

    let c_id = |x: usize, y: usize, z: usize| -> i32 { cell_vert[(z * cy_n + y) * cx_n + x] };

    let surface_role = if attr.label == 0 {
        0
    } else {
        out.name_index_role("surface")
    };
    let mut emit_quad = |quad: [i32; 4]| -> Result<(), KernelError> {
        if quad.iter().any(|&v| v < 0) {
            return Ok(());
        }
        if let Ok(f) = out.add_face(&quad, attr.material) {
            out.f_label[f as usize] = attr.label;
            out.f_role[f as usize] = surface_role;
            if attr.tag >= 0 {
                out.add_tag(f, attr.tag);
            }
        } else {
            // Fall back to 2 triangles if non-manifold quad edge occurs
            for tri in [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] {
                if let Ok(f) = out.add_face(&tri, attr.material) {
                    out.f_label[f as usize] = attr.label;
                    out.f_role[f as usize] = surface_role;
                    if attr.tag >= 0 {
                        out.add_tag(f, attr.tag);
                    }
                }
            }
        }
        Ok(())
    };

    // Emit dual quad for each internal sign-changing grid edge
    // X-axis edges: shared by 4 cells around (y, z)
    for z in 1..cz_n {
        for y in 1..cy_n {
            for x in 0..cx_n {
                let s0 = grid.values[idx(x, y, z, nx, ny)] - iso < 0.0;
                let s1 = grid.values[idx(x + 1, y, z, nx, ny)] - iso < 0.0;
                if s0 == s1 {
                    continue;
                }
                let q = if s0 {
                    [
                        c_id(x, y - 1, z - 1),
                        c_id(x, y, z - 1),
                        c_id(x, y, z),
                        c_id(x, y - 1, z),
                    ]
                } else {
                    [
                        c_id(x, y - 1, z - 1),
                        c_id(x, y - 1, z),
                        c_id(x, y, z),
                        c_id(x, y, z - 1),
                    ]
                };
                emit_quad(q)?;
            }
        }
    }
    // Y-axis edges
    for z in 1..cz_n {
        for y in 0..cy_n {
            for x in 1..cx_n {
                let s0 = grid.values[idx(x, y, z, nx, ny)] - iso < 0.0;
                let s1 = grid.values[idx(x, y + 1, z, nx, ny)] - iso < 0.0;
                if s0 == s1 {
                    continue;
                }
                let q = if !s0 {
                    [
                        c_id(x - 1, y, z - 1),
                        c_id(x, y, z - 1),
                        c_id(x, y, z),
                        c_id(x - 1, y, z),
                    ]
                } else {
                    [
                        c_id(x - 1, y, z - 1),
                        c_id(x - 1, y, z),
                        c_id(x, y, z),
                        c_id(x, y, z - 1),
                    ]
                };
                emit_quad(q)?;
            }
        }
    }
    // Z-axis edges
    for z in 0..cz_n {
        for y in 1..cy_n {
            for x in 1..cx_n {
                let s0 = grid.values[idx(x, y, z, nx, ny)] - iso < 0.0;
                let s1 = grid.values[idx(x, y, z + 1, nx, ny)] - iso < 0.0;
                if s0 == s1 {
                    continue;
                }
                let q = if s0 {
                    [
                        c_id(x - 1, y - 1, z),
                        c_id(x, y - 1, z),
                        c_id(x, y, z),
                        c_id(x - 1, y, z),
                    ]
                } else {
                    [
                        c_id(x - 1, y - 1, z),
                        c_id(x - 1, y, z),
                        c_id(x, y, z),
                        c_id(x, y - 1, z),
                    ]
                };
                emit_quad(q)?;
            }
        }
    }

    let _ = (cross, dot, length, sub);
    Ok(out)
}

pub fn voxel_offset(
    mesh: &EditMesh,
    faces: &[i32],
    distance: f64,
    voxel_size: f64,
    band: u32,
    attr: Attribution,
) -> Result<EditMesh, KernelError> {
    let sdf = build_sdf_from_mesh(mesh, faces, voxel_size, band, distance.abs())?;
    surface_nets_to_mesh(&sdf, distance, attr)
}

pub fn voxel_fill_holes(
    mesh: &EditMesh,
    faces: &[i32],
    voxel_size: f64,
    band: u32,
    attr: Attribution,
) -> Result<EditMesh, KernelError> {
    let sdf = build_sdf_from_mesh(mesh, faces, voxel_size, band, 0.0)?;
    surface_nets_to_mesh(&sdf, 0.0, attr)
}
