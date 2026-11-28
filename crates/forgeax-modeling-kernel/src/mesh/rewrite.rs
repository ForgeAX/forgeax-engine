//! Shared half-edge face rewriting & ear-clipping polygon triangulation utilities.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;

use super::geom::{cross, dot, length, newell, normalize, sub, Vec3};
use super::{CornerChannelKind, EditMesh, CHANNEL_COUNT, EDGE_SEAM, EDGE_SHARP, NONE};

pub const CREASE_STEPS: f64 = 4.0;
pub const CREASE_INFINITE: f64 = 10.0;
const CODE_SHIFT: u8 = 2;
const CODE_MASK: u8 = 0b1111_1100;
const CREASE_BITS: u8 = EDGE_SHARP | CODE_MASK;
const MAX_CODE: u8 = 39; // 10 * 4 - 1

#[inline]
pub fn flag_sharpness(flags: u8, fallback_infinite: bool) -> f64 {
    if (flags & EDGE_SHARP) == 0 {
        return 0.0;
    }
    let code = (flags & CODE_MASK) >> CODE_SHIFT;
    if code != 0 {
        (code as f64) / CREASE_STEPS
    } else if fallback_infinite {
        f64::INFINITY
    } else {
        CREASE_INFINITE
    }
}

#[inline]
pub fn with_crease(flags: u8, sharpness: f64) -> u8 {
    let plain = flags & !CREASE_BITS;
    if !(sharpness > 0.0) {
        return plain;
    }
    if sharpness >= CREASE_INFINITE {
        return plain | EDGE_SHARP;
    }
    let code = ((sharpness * CREASE_STEPS).round() as i32).clamp(1, MAX_CODE as i32) as u8;
    plain | EDGE_SHARP | (code << CODE_SHIFT)
}

#[inline]
pub fn merge_flags(a: u8, b: u8) -> u8 {
    let sa = flag_sharpness(a, true);
    let sb = flag_sharpness(b, true);
    with_crease((a | b) & !CREASE_BITS, sa.max(sb))
}

#[inline]
pub fn set_edge_intent_flag(flags: u8, bit: u8, on: bool) -> u8 {
    if on {
        merge_flags(flags, bit)
    } else if (bit & EDGE_SHARP) != 0 {
        flags & !bit & !CODE_MASK
    } else {
        flags & !bit
    }
}

/// Source of a vertex corner on a rewritten face.
#[derive(Debug, Clone, Copy)]
pub struct CornerSource {
    pub v: i32,
    pub corner: Option<i32>,
    pub interp: Option<(i32, i32, f64)>,
}

impl CornerSource {
    pub fn from_corner(v: i32, corner: i32) -> Self {
        Self {
            v,
            corner: Some(corner),
            interp: None,
        }
    }

    pub fn from_interp(v: i32, from: i32, to: i32, t: f64) -> Self {
        Self {
            v,
            corner: None,
            interp: Some((from, to, t)),
        }
    }

    pub fn bare(v: i32) -> Self {
        Self {
            v,
            corner: None,
            interp: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FaceRewrite {
    pub face: i32,
    pub loops: Vec<Vec<CornerSource>>,
}

struct SnapshotFace {
    material: i32,
    label: i32,
    role: i32,
    flags: u8,
    tags: Vec<u32>,
}

/// Replace `rewrites` faces atomically while preserving attributes, tags, edge flags, and corner channels.
pub fn rewrite_faces(
    mesh: &mut EditMesh,
    rewrites: &[FaceRewrite],
) -> Result<Vec<Vec<i32>>, KernelError> {
    if rewrites.is_empty() {
        return Ok(Vec::new());
    }
    let words = mesh.tag_words;
    let mut old_faces: Vec<SnapshotFace> = Vec::with_capacity(rewrites.len());
    let mut edge_flags: HashMap<(i32, i32), u8> = HashMap::new();
    let mut corner_values: Vec<[Option<Vec<f32>>; CHANNEL_COUNT]> = Vec::new();
    let mut corner_map: HashMap<i32, usize> = HashMap::new();

    let mut snap_half = |h: i32| {
        if corner_map.contains_key(&h) {
            return;
        }
        let slot = corner_values.len();
        let mut arr: [Option<Vec<f32>>; CHANNEL_COUNT] = Default::default();
        for ch_idx in 0..CHANNEL_COUNT {
            if let Some(ch) = &mesh.channels[ch_idx] {
                if ch.set.get(h as usize).copied().unwrap_or(0) != 0 {
                    let dim = ch.dim;
                    let off = (h as usize) * dim;
                    arr[ch_idx] = Some(ch.values[off..off + dim].to_vec());
                }
            }
        }
        corner_values.push(arr);
        corner_map.insert(h, slot);
    };

    for rw in rewrites {
        let f = rw.face;
        let fu = f as usize;
        old_faces.push(SnapshotFace {
            material: mesh.f_material[fu],
            label: mesh.f_label[fu],
            role: mesh.f_role[fu],
            flags: mesh.f_flags[fu],
            tags: mesh.f_tags[fu * words..(fu + 1) * words].to_vec(),
        });
        for h in mesh.face_halves(f) {
            let e = h >> 1;
            let fl = mesh.e_flags[e as usize];
            if fl != 0 {
                let [a, b] = mesh.edge_vertices(e);
                let key = if a < b { (a, b) } else { (b, a) };
                edge_flags
                    .entry(key)
                    .and_modify(|prev| *prev = merge_flags(*prev, fl))
                    .or_insert(fl);
            }
            snap_half(h);
        }
        for lp in &rw.loops {
            for cs in lp {
                if let Some(c) = cs.corner {
                    if c != NONE {
                        snap_half(c);
                    }
                }
                if let Some((a, b, _)) = cs.interp {
                    if a != NONE {
                        snap_half(a);
                    }
                    if b != NONE {
                        snap_half(b);
                    }
                }
            }
        }
    }

    for rw in rewrites {
        mesh.remove_face(rw.face);
    }

    let mut result = Vec::with_capacity(rewrites.len());
    for (idx, rw) in rewrites.iter().enumerate() {
        let snap = &old_faces[idx];
        let mut created = Vec::with_capacity(rw.loops.len());
        for lp in &rw.loops {
            if lp.len() < 3 {
                continue;
            }
            let verts: Vec<i32> = lp.iter().map(|c| c.v).collect();
            let nf = mesh.add_face(&verts, snap.material)?;
            let nfu = nf as usize;
            mesh.f_label[nfu] = snap.label;
            mesh.f_role[nfu] = snap.role;
            mesh.f_flags[nfu] = snap.flags;
            for w in 0..words {
                mesh.f_tags[nfu * words + w] = snap.tags[w];
            }
            let new_halves = mesh.face_halves(nf);
            for (ci, &nh) in new_halves.iter().enumerate() {
                let cs = &lp[ci];
                if let Some(old_h) = cs.corner {
                    if let Some(&slot) = corner_map.get(&old_h) {
                        for (ch_idx, maybe_val) in corner_values[slot].iter().enumerate() {
                            if let Some(vals) = maybe_val {
                                if let Some(kind) = CornerChannelKind::ALL.get(ch_idx).copied() {
                                    mesh.set_corner(kind, nh, vals);
                                }
                            }
                        }
                    }
                } else if let Some((h0, h1, t)) = cs.interp {
                    if let (Some(&s0), Some(&s1)) = (corner_map.get(&h0), corner_map.get(&h1)) {
                        for ch_idx in 0..CHANNEL_COUNT {
                            if let (Some(a), Some(b)) =
                                (&corner_values[s0][ch_idx], &corner_values[s1][ch_idx])
                            {
                                let blended: Vec<f32> = a
                                    .iter()
                                    .zip(b.iter())
                                    .map(|(&va, &vb)| {
                                        (va as f64 + (vb as f64 - va as f64) * t) as f32
                                    })
                                    .collect();
                                if let Some(kind) = CornerChannelKind::ALL.get(ch_idx).copied() {
                                    mesh.set_corner(kind, nh, &blended);
                                }
                            }
                        }
                    }
                }
                let e = nh >> 1;
                let [va, vb] = mesh.edge_vertices(e);
                let key = if va < vb { (va, vb) } else { (vb, va) };
                if let Some(&fl) = edge_flags.get(&key) {
                    mesh.e_flags[e as usize] = merge_flags(mesh.e_flags[e as usize], fl);
                }
            }
            created.push(nf);
        }
        result.push(created);
    }

    let _ = HashSet::<i32>::new();
    let _ = (EDGE_SHARP, EDGE_SEAM);
    Ok(result)
}

/// Triangulate a simple 3D polygon loop in its Newell best-fit plane via ear clipping.
/// Strictly convex loops fan from vertex 0. Returns vertex indices into `points`.
pub fn triangulate_loop(points: &[Vec3]) -> Option<Vec<usize>> {
    let n = points.len();
    if n < 3 {
        return None;
    }
    if n == 3 {
        return Some(vec![0, 1, 2]);
    }
    let normal = normalize(newell(points));
    if !(length(normal) > 0.0) {
        return None;
    }

    let ref_v = if normal[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let u_ax = normalize(cross(normal, ref_v));
    let v_ax = cross(normal, u_ax);
    let p0 = points[0];
    let pts2: Vec<[f64; 2]> = points
        .iter()
        .map(|&p| {
            let d = sub(p, p0);
            [dot(d, u_ax), dot(d, v_ax)]
        })
        .collect();

    #[inline]
    fn orient2(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    }

    // Fast path: strictly convex polygon
    let mut strictly_convex = true;
    for i in 0..n {
        let a = pts2[(i + n - 1) % n];
        let b = pts2[i];
        let c = pts2[(i + 1) % n];
        if orient2(a, b, c) <= 1e-12 {
            strictly_convex = false;
            break;
        }
    }
    if strictly_convex {
        let mut out = Vec::with_capacity((n - 2) * 3);
        for i in 1..(n - 1) {
            out.push(0);
            out.push(i);
            out.push(i + 1);
        }
        return Some(out);
    }

    // Ear clipping
    let mut rem: Vec<usize> = (0..n).collect();
    let mut out = Vec::with_capacity((n - 2) * 3);
    let mut guard = n * n * 2;
    let mut i = 0usize;
    while rem.len() > 3 && guard > 0 {
        guard -= 1;
        let len = rem.len();
        let ia = rem[(i + len - 1) % len];
        let ib = rem[i % len];
        let ic = rem[(i + 1) % len];
        let pa = pts2[ia];
        let pb = pts2[ib];
        let pc = pts2[ic];
        if orient2(pa, pb, pc) > 1e-14 {
            let mut empty = true;
            for &id in &rem {
                if id == ia || id == ib || id == ic {
                    continue;
                }
                let pd = pts2[id];
                if orient2(pa, pb, pd) >= -1e-14
                    && orient2(pb, pc, pd) >= -1e-14
                    && orient2(pc, pa, pd) >= -1e-14
                {
                    empty = false;
                    break;
                }
            }
            if empty {
                out.push(ia);
                out.push(ib);
                out.push(ic);
                rem.remove(i % len);
                if rem.is_empty() {
                    break;
                }
                i %= rem.len();
                continue;
            }
        }
        i = (i + 1) % len;
    }
    if rem.len() != 3 {
        return None;
    }
    out.push(rem[0]);
    out.push(rem[1]);
    out.push(rem[2]);
    Some(out)
}
