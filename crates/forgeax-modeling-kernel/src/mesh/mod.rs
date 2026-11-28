//! Struct-of-Arrays manifold half-edge polygon mesh (`EditMesh`) with exact
//! semantic parity to `@forgeax/engine-modeling`'s TS `EditMesh`.

pub mod bvh;
pub mod geom;
pub mod rewrite;

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};

/// Fast non-cryptographic hasher for integer edge keys (`u64`), avoiding SipHash overhead in hot loops.
#[derive(Default, Clone, Copy)]
pub struct FxHasher(u64);

impl Hasher for FxHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ (b as u64)).wrapping_mul(0x517cc1b727220a95);
        }
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x517cc1b727220a95);
    }
}

#[derive(Default, Clone, Copy)]
pub struct FxBuildHasher;

impl BuildHasher for FxBuildHasher {
    type Hasher = FxHasher;
    #[inline]
    fn build_hasher(&self) -> FxHasher {
        FxHasher(0)
    }
}

#[inline]
fn grow_vec<T: Clone>(v: &mut Vec<T>, min_len: usize, fill: T) {
    if v.len() < min_len {
        let next = min_len.max(v.len().saturating_mul(2)).max(32);
        v.resize(next, fill);
    }
}

use crate::error::KernelError;
use crate::geometry::layout::{AttributeFormat, AttributeKind};
use crate::geometry::staging::{
    build_from_channels, BuiltMesh, ChannelBuffer, OutputMode, PrimitiveTopology, SubmeshInput,
};

pub const NONE: i32 = -1;
pub const ALIVE: u32 = 0x8000_0000;
pub const MAX_VERTICES: i32 = 1 << 26;

pub const EDGE_SHARP: u8 = 1;
pub const EDGE_SEAM: u8 = 2;

pub const FACE_MIRRORED: u8 = 1;
pub const FACE_EDGE_ROUND: u8 = 2;
pub const FACE_ROLE_SHIFT: u8 = 2;
pub const FACE_ROLE_MASK: u8 = 3 << FACE_ROLE_SHIFT;
pub const FACE_FLOAT: u8 = 16;

pub const CHANNEL_COUNT: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum CornerChannelKind {
    Uv0 = 0,
    Uv1 = 1,
    Uv2 = 2,
    Uv3 = 3,
    Uv4 = 4,
    Uv5 = 5,
    Uv6 = 6,
    Uv7 = 7,
    Color = 8,
}

impl CornerChannelKind {
    pub const ALL: [CornerChannelKind; CHANNEL_COUNT] = [
        Self::Uv0,
        Self::Uv1,
        Self::Uv2,
        Self::Uv3,
        Self::Uv4,
        Self::Uv5,
        Self::Uv6,
        Self::Uv7,
        Self::Color,
    ];

    pub fn from_id(id: u8) -> Option<Self> {
        Self::ALL.get(id as usize).copied()
    }

    pub const fn dim(self) -> usize {
        match self {
            Self::Color => 4,
            _ => 2,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Uv0 => "uv0",
            Self::Uv1 => "uv1",
            Self::Uv2 => "uv2",
            Self::Uv3 => "uv3",
            Self::Uv4 => "uv4",
            Self::Uv5 => "uv5",
            Self::Uv6 => "uv6",
            Self::Uv7 => "uv7",
            Self::Color => "color",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CornerChannel {
    pub dim: usize,
    pub values: Vec<f32>,
    pub set: Vec<u8>,
}

#[inline]
pub fn edge_key(a: i32, b: i32) -> u64 {
    let (lo, hi) = if a < b {
        (a as u64, b as u64)
    } else {
        (b as u64, a as u64)
    };
    (lo << 32) | hi
}

/// Editable manifold polygon mesh: paired half-edges (`twin = h ^ 1`, `edge = h >> 1`).
pub struct EditMesh {
    pub vertex_high_water: i32,
    pub half_high_water: i32,
    pub face_high_water: i32,

    pub pos: Vec<f64>,
    pub v_gen: Vec<u32>,

    pub h_vert: Vec<i32>,
    pub h_next: Vec<i32>,
    pub h_prev: Vec<i32>,
    pub h_face: Vec<i32>,
    pub e_flags: Vec<u8>,

    pub f_half: Vec<i32>,
    pub f_len: Vec<i32>,
    pub f_gen: Vec<u32>,
    pub f_material: Vec<i32>,
    pub f_label: Vec<i32>,
    pub f_role: Vec<i32>,
    pub f_flags: Vec<u8>,
    pub f_tags: Vec<u32>,
    pub tag_words: usize,

    pub channels: [Option<CornerChannel>; CHANNEL_COUNT],
    pub tag_names: Vec<String>,
    pub label_names: Vec<String>,
    pub role_names: Vec<String>,
    pub material_names: Vec<String>,

    pub topology_stamp: u32,
    pub shape_stamp: u32,

    pub edge_index: HashMap<u64, i32, FxBuildHasher>,
    pub free_vertices: Vec<i32>,
    pub free_edges: Vec<i32>,
    pub free_faces: Vec<i32>,

    /// Most recently built render mesh (cached for zero-copy WASM readout).
    pub last_built: Option<BuiltMesh>,
    /// Most recent selector evaluation result (cached for zero-copy WASM readout).
    pub last_selection: Vec<i32>,
}

impl Default for EditMesh {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for EditMesh {
    fn clone(&self) -> Self {
        Self {
            vertex_high_water: self.vertex_high_water,
            half_high_water: self.half_high_water,
            face_high_water: self.face_high_water,
            pos: self.pos.clone(),
            v_gen: self.v_gen.clone(),
            h_vert: self.h_vert.clone(),
            h_next: self.h_next.clone(),
            h_prev: self.h_prev.clone(),
            h_face: self.h_face.clone(),
            e_flags: self.e_flags.clone(),
            f_half: self.f_half.clone(),
            f_len: self.f_len.clone(),
            f_gen: self.f_gen.clone(),
            f_material: self.f_material.clone(),
            f_label: self.f_label.clone(),
            f_role: self.f_role.clone(),
            f_flags: self.f_flags.clone(),
            f_tags: self.f_tags.clone(),
            tag_words: self.tag_words,
            channels: self.channels.clone(),
            tag_names: self.tag_names.clone(),
            label_names: self.label_names.clone(),
            role_names: self.role_names.clone(),
            material_names: self.material_names.clone(),
            topology_stamp: self.topology_stamp,
            shape_stamp: self.shape_stamp,
            edge_index: self.edge_index.clone(),
            free_vertices: self.free_vertices.clone(),
            free_edges: self.free_edges.clone(),
            free_faces: self.free_faces.clone(),
            last_built: None,
            last_selection: Vec::new(),
        }
    }
}

impl EditMesh {
    pub fn new() -> Self {
        Self {
            vertex_high_water: 0,
            half_high_water: 0,
            face_high_water: 0,
            pos: Vec::new(),
            v_gen: Vec::new(),
            h_vert: Vec::new(),
            h_next: Vec::new(),
            h_prev: Vec::new(),
            h_face: Vec::new(),
            e_flags: Vec::new(),
            f_half: Vec::new(),
            f_len: Vec::new(),
            f_gen: Vec::new(),
            f_material: Vec::new(),
            f_label: Vec::new(),
            f_role: Vec::new(),
            f_flags: Vec::new(),
            f_tags: Vec::new(),
            tag_words: 1,
            channels: Default::default(),
            tag_names: Vec::new(),
            label_names: vec![String::new()],
            role_names: vec![String::new()],
            material_names: vec!["Default".to_string()],
            topology_stamp: 0,
            shape_stamp: 0,
            edge_index: HashMap::with_hasher(FxBuildHasher),
            free_vertices: Vec::new(),
            free_edges: Vec::new(),
            free_faces: Vec::new(),
            last_built: None,
            last_selection: Vec::new(),
        }
    }

    pub fn vertex_count(&self) -> usize {
        (self.vertex_high_water as usize) - self.free_vertices.len()
    }

    pub fn face_count(&self) -> usize {
        (self.face_high_water as usize) - self.free_faces.len()
    }

    pub fn edge_count(&self) -> usize {
        ((self.half_high_water / 2) as usize) - self.free_edges.len()
    }

    #[inline]
    pub fn is_vertex_alive(&self, v: i32) -> bool {
        v >= 0 && v < self.vertex_high_water && (self.v_gen[v as usize] & ALIVE) != 0
    }

    #[inline]
    pub fn is_face_alive(&self, f: i32) -> bool {
        f >= 0 && f < self.face_high_water && (self.f_gen[f as usize] & ALIVE) != 0
    }

    #[inline]
    pub fn is_edge_alive(&self, e: i32) -> bool {
        e >= 0 && e * 2 < self.half_high_water && self.h_vert[(e * 2) as usize] != NONE
    }

    #[inline]
    pub fn position(&self, v: i32) -> [f64; 3] {
        let i = (v as usize) * 3;
        [self.pos[i], self.pos[i + 1], self.pos[i + 2]]
    }

    pub fn add_vertex(&mut self, x: f64, y: f64, z: f64) -> Result<i32, KernelError> {
        let v = if let Some(reused) = self.free_vertices.pop() {
            reused
        } else {
            if self.vertex_high_water >= MAX_VERTICES {
                return Err(KernelError::out_of_memory(
                    "vertex",
                    "EditMesh exceeded maximum vertex capacity",
                ));
            }
            let next = self.vertex_high_water;
            self.vertex_high_water += 1;
            next
        };
        let vu = v as usize;
        grow_vec(&mut self.pos, (vu + 1) * 3, 0.0);
        grow_vec(&mut self.v_gen, vu + 1, 0);
        self.pos[vu * 3] = x;
        self.pos[vu * 3 + 1] = y;
        self.pos[vu * 3 + 2] = z;
        self.v_gen[vu] = ((self.v_gen[vu] & !ALIVE).wrapping_add(1)) | ALIVE;
        self.shape_stamp = self.shape_stamp.wrapping_add(1);
        Ok(v)
    }

    pub fn remove_vertex(&mut self, v: i32) {
        if !self.is_vertex_alive(v) {
            return;
        }
        self.v_gen[v as usize] &= !ALIVE;
        self.free_vertices.push(v);
    }

    pub fn set_position(&mut self, v: i32, x: f64, y: f64, z: f64) {
        let vu = v as usize;
        self.pos[vu * 3] = x;
        self.pos[vu * 3 + 1] = y;
        self.pos[vu * 3 + 2] = z;
        self.shape_stamp = self.shape_stamp.wrapping_add(1);
    }

    #[inline]
    pub fn find_half(&self, a: i32, b: i32) -> i32 {
        match self.edge_index.get(&edge_key(a, b)) {
            None => NONE,
            Some(&e) => {
                if self.h_vert[(e * 2) as usize] == a {
                    e * 2
                } else {
                    e * 2 + 1
                }
            }
        }
    }

    pub fn can_add_face(&self, loop_verts: &[i32]) -> Result<(), KernelError> {
        if loop_verts.len() < 3 {
            return Err(KernelError::degenerate(
                "face",
                "a face needs at least 3 vertices",
            ));
        }
        let n = loop_verts.len();
        if n <= 16 {
            for i in 0..n {
                let v = loop_verts[i];
                if !self.is_vertex_alive(v) {
                    return Err(KernelError::precondition(
                        "face",
                        format!("face vertex {v} does not exist"),
                    ));
                }
                for j in (i + 1)..n {
                    if loop_verts[j] == v {
                        return Err(KernelError::degenerate(
                            "face",
                            "a face must not repeat a vertex",
                        ));
                    }
                }
            }
        } else {
            let mut seen = HashSet::with_capacity(n);
            for &v in loop_verts {
                if !self.is_vertex_alive(v) {
                    return Err(KernelError::precondition(
                        "face",
                        format!("face vertex {v} does not exist"),
                    ));
                }
                if !seen.insert(v) {
                    return Err(KernelError::degenerate(
                        "face",
                        "a face must not repeat a vertex",
                    ));
                }
            }
        }
        let n = loop_verts.len();
        for i in 0..n {
            let a = loop_verts[i];
            let b = loop_verts[(i + 1) % n];
            let h = self.find_half(a, b);
            if h != NONE && self.h_face[h as usize] != NONE {
                return Err(KernelError::precondition(
                    "face",
                    "each directed edge is used by at most one face (manifold, consistently oriented)",
                ));
            }
        }
        Ok(())
    }

    pub fn add_face(&mut self, loop_verts: &[i32], material: i32) -> Result<i32, KernelError> {
        self.can_add_face(loop_verts)?;
        let f = if let Some(reused) = self.free_faces.pop() {
            reused
        } else {
            let next = self.face_high_water;
            self.face_high_water += 1;
            next
        };
        self.ensure_face_capacity((f + 1) as usize);
        let n = loop_verts.len();
        let mut halves = Vec::with_capacity(n);
        for i in 0..n {
            let a = loop_verts[i];
            let b = loop_verts[(i + 1) % n];
            let h = match self.find_half(a, b) {
                NONE => self.create_edge(a, b),
                existing => existing,
            };
            halves.push(h);
        }
        for i in 0..n {
            let h = halves[i] as usize;
            self.h_face[h] = f;
            self.h_next[h] = halves[(i + 1) % n];
            self.h_prev[h] = halves[(i + n - 1) % n];
            for ch in self.channels.iter_mut().flatten() {
                if h < ch.set.len() {
                    ch.set[h] = 0;
                }
            }
        }
        let fu = f as usize;
        self.f_half[fu] = halves[0];
        self.f_len[fu] = n as i32;
        self.f_gen[fu] = ((self.f_gen[fu] & !ALIVE).wrapping_add(1)) | ALIVE;
        self.f_material[fu] = material;
        self.f_label[fu] = 0;
        self.f_role[fu] = 0;
        self.f_flags[fu] = 0;
        let tag_start = fu * self.tag_words;
        for w in 0..self.tag_words {
            self.f_tags[tag_start + w] = 0;
        }
        self.topology_stamp = self.topology_stamp.wrapping_add(1);
        Ok(f)
    }

    pub fn remove_face(&mut self, f: i32) {
        if !self.is_face_alive(f) {
            return;
        }
        let halves = self.face_halves(f);
        for h in halves {
            let hu = h as usize;
            self.h_face[hu] = NONE;
            self.h_next[hu] = NONE;
            self.h_prev[hu] = NONE;
            let twin = (h ^ 1) as usize;
            if self.h_face[twin] == NONE {
                self.release_edge(h >> 1);
            }
        }
        self.f_gen[f as usize] &= !ALIVE;
        self.free_faces.push(f);
        self.topology_stamp = self.topology_stamp.wrapping_add(1);
    }

    pub fn face_halves(&self, f: i32) -> Vec<i32> {
        let start = self.f_half[f as usize];
        if start == NONE {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.f_len[f as usize].max(0) as usize);
        let mut h = start;
        loop {
            out.push(h);
            h = self.h_next[h as usize];
            if h == start || h == NONE {
                break;
            }
        }
        out
    }

    pub fn face_vertices(&self, f: i32) -> Vec<i32> {
        let start = self.f_half[f as usize];
        if start == NONE {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.f_len[f as usize].max(0) as usize);
        let mut h = start;
        loop {
            out.push(self.h_vert[h as usize]);
            h = self.h_next[h as usize];
            if h == start || h == NONE {
                break;
            }
        }
        out
    }

    pub fn faces(&self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.face_count());
        for f in 0..self.face_high_water {
            if self.is_face_alive(f) {
                out.push(f);
            }
        }
        out
    }

    pub fn edges(&self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.edge_count());
        let hw = self.half_high_water / 2;
        for e in 0..hw {
            if self.is_edge_alive(e) {
                out.push(e);
            }
        }
        out
    }

    pub fn vertices(&self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.vertex_count());
        for v in 0..self.vertex_high_water {
            if self.is_vertex_alive(v) {
                out.push(v);
            }
        }
        out
    }

    #[inline]
    pub fn edge_vertices(&self, e: i32) -> [i32; 2] {
        [
            self.h_vert[(e * 2) as usize],
            self.h_vert[(e * 2 + 1) as usize],
        ]
    }

    #[inline]
    pub fn is_boundary_edge(&self, e: i32) -> bool {
        self.h_face[(e * 2) as usize] == NONE || self.h_face[(e * 2 + 1) as usize] == NONE
    }

    pub fn tag_index(&mut self, name: &str, create: bool) -> i32 {
        if let Some(pos) = self.tag_names.iter().position(|n| n == name) {
            return pos as i32;
        }
        if !create {
            return -1;
        }
        let idx = self.tag_names.len();
        self.tag_names.push(name.to_string());
        if idx >= self.tag_words * 32 {
            self.reserve_tag_words(self.tag_words + 1);
        }
        idx as i32
    }

    pub fn find_tag_index(&self, name: &str) -> i32 {
        self.tag_names
            .iter()
            .position(|n| n == name)
            .map(|p| p as i32)
            .unwrap_or(-1)
    }

    #[inline]
    pub fn has_tag(&self, f: i32, tag: i32) -> bool {
        if tag < 0 {
            return false;
        }
        let t = tag as usize;
        let word = self.f_tags[(f as usize) * self.tag_words + (t >> 5)];
        (word & (1u32 << (t & 31))) != 0
    }

    #[inline]
    pub fn add_tag(&mut self, f: i32, tag: i32) {
        if tag < 0 {
            return;
        }
        let t = tag as usize;
        let slot = (f as usize) * self.tag_words + (t >> 5);
        self.f_tags[slot] |= 1u32 << (t & 31);
    }

    pub fn name_index_label(&mut self, name: &str) -> i32 {
        Self::intern_name(&mut self.label_names, name)
    }

    pub fn name_index_role(&mut self, name: &str) -> i32 {
        Self::intern_name(&mut self.role_names, name)
    }

    pub fn name_index_material(&mut self, name: &str) -> i32 {
        Self::intern_name(&mut self.material_names, name)
    }

    fn intern_name(names: &mut Vec<String>, name: &str) -> i32 {
        if let Some(pos) = names.iter().position(|n| n == name) {
            pos as i32
        } else {
            let idx = names.len() as i32;
            names.push(name.to_string());
            idx
        }
    }

    pub fn copy_face_attributes_to(&self, from: i32, target: &mut EditMesh, to: i32) {
        let fu = from as usize;
        let tu = to as usize;
        target.f_material[tu] = self.f_material[fu];
        target.f_label[tu] = self.f_label[fu];
        target.f_role[tu] = self.f_role[fu];
        target.f_flags[tu] = self.f_flags[fu];
        let words = self.tag_words.min(target.tag_words);
        for w in 0..words {
            target.f_tags[tu * target.tag_words + w] = self.f_tags[fu * self.tag_words + w];
        }
    }

    pub fn ensure_channel(&mut self, kind: CornerChannelKind) -> &mut CornerChannel {
        let idx = kind as usize;
        let h_len = self.h_vert.len();
        if self.channels[idx].is_none() {
            let dim = kind.dim();
            self.channels[idx] = Some(CornerChannel {
                dim,
                values: vec![0.0f32; h_len * dim],
                set: vec![0u8; h_len],
            });
        }
        let ch = self.channels[idx].as_mut().unwrap();
        if ch.set.len() < h_len {
            let next = h_len.max(ch.set.len().saturating_mul(2)).max(64);
            ch.values.resize(next * ch.dim, 0.0);
            ch.set.resize(next, 0);
        }
        ch
    }

    pub fn set_corner(&mut self, kind: CornerChannelKind, h: i32, value: &[f32]) {
        let ch = self.ensure_channel(kind);
        let hu = h as usize;
        let dim = ch.dim;
        if hu >= ch.set.len() {
            let next = (hu + 1).max(ch.set.len().saturating_mul(2)).max(64);
            ch.values.resize(next * dim, 0.0);
            ch.set.resize(next, 0);
        }
        for i in 0..dim {
            ch.values[hu * dim + i] = value[i];
        }
        ch.set[hu] = 1;
    }

    pub fn corner(&self, kind: CornerChannelKind, h: i32) -> Option<&[f32]> {
        let ch = self.channels[kind as usize].as_ref()?;
        let hu = h as usize;
        if hu >= ch.set.len() || ch.set[hu] == 0 {
            return None;
        }
        Some(&ch.values[hu * ch.dim..(hu + 1) * ch.dim])
    }

    pub fn reserve_tag_words(&mut self, words: usize) {
        if words <= self.tag_words {
            return;
        }
        let cap = self.f_half.len().max(self.face_high_water as usize);
        let mut next = vec![0u32; cap * words];
        for f in 0..(self.face_high_water as usize) {
            for w in 0..self.tag_words {
                next[f * words + w] = self.f_tags[f * self.tag_words + w];
            }
        }
        self.f_tags = next;
        self.tag_words = words;
    }

    /// Direct zero-FXEM export from Rust `EditMesh` into `geometry::BuiltMesh` (triangle fan per n-gon,
    /// grouped by material slot, respecting `EDGE_SHARP` / corner UV0 / color splits).
    pub fn build_render_mesh(&mut self, mode: OutputMode) -> Result<&BuiltMesh, KernelError> {
        let alive_faces = self.faces();
        if alive_faces.is_empty() {
            return Err(KernelError::invalid_value(
                "mesh",
                "cannot build render mesh from empty EditMesh",
            ));
        }

        let has_uv0 = self.channels[CornerChannelKind::Uv0 as usize]
            .as_ref()
            .is_some_and(|c| c.set.iter().any(|&s| s != 0));
        let has_color = self.channels[CornerChannelKind::Color as usize]
            .as_ref()
            .is_some_and(|c| c.set.iter().any(|&s| s != 0));

        // Emit per-face vertices (flat/split-safe) grouped by material slot for deterministic
        // sharp-edge & UV-seam fidelity, then run the standard geometry pipeline (normals/tangents/AABB/packing).
        let slot_count = self.material_names.len().max(1);
        let mut by_slot: Vec<Vec<i32>> = vec![Vec::new(); slot_count];
        for f in alive_faces {
            let slot = (self.f_material[f as usize].max(0) as usize).min(slot_count - 1);
            by_slot[slot].push(f);
        }

        let mut pos_bytes: Vec<u8> = Vec::new();
        let mut norm_bytes: Vec<u8> = Vec::new();
        let mut uv_bytes: Vec<u8> = Vec::new();
        let mut color_bytes: Vec<u8> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut submeshes: Vec<SubmeshInput> = Vec::new();
        let mut vertex_count: u32 = 0;

        for (slot_idx, slot_faces) in by_slot.iter().enumerate() {
            if slot_faces.is_empty() {
                continue;
            }
            let index_offset = indices.len() as u32;
            let mut slot_vert_count: u32 = 0;
            for &f in slot_faces {
                let halves = self.face_halves(f);
                if halves.len() < 3 {
                    continue;
                }
                let n = geom::face_normal(self, f);
                let base = vertex_count;
                for &h in &halves {
                    let p = self.position(self.h_vert[h as usize]);
                    for &c in &p {
                        pos_bytes.extend_from_slice(&(c as f32).to_le_bytes());
                    }
                    for &c in &n {
                        norm_bytes.extend_from_slice(&(c as f32).to_le_bytes());
                    }
                    if has_uv0 {
                        let uv = self
                            .corner(CornerChannelKind::Uv0, h)
                            .unwrap_or(&[0.0, 0.0]);
                        uv_bytes.extend_from_slice(&uv[0].to_le_bytes());
                        uv_bytes.extend_from_slice(&uv[1].to_le_bytes());
                    }
                    if has_color {
                        let col = self
                            .corner(CornerChannelKind::Color, h)
                            .unwrap_or(&[1.0, 1.0, 1.0, 1.0]);
                        for &c in col {
                            color_bytes.extend_from_slice(&c.to_le_bytes());
                        }
                    }
                    vertex_count += 1;
                    slot_vert_count += 1;
                }
                for i in 1..(halves.len() - 1) {
                    indices.push(base);
                    indices.push(base + (i as u32));
                    indices.push(base + (i as u32) + 1);
                }
            }
            let index_count = (indices.len() as u32) - index_offset;
            if index_count > 0 {
                submeshes.push(SubmeshInput {
                    index_offset: Some(index_offset),
                    index_count: Some(index_count),
                    vertex_count: Some(slot_vert_count),
                    topology: PrimitiveTopology::TriangleList,
                    material_slot: Some(slot_idx as u32),
                });
            }
        }

        let mut channels = vec![
            ChannelBuffer {
                kind: AttributeKind::Position,
                format: AttributeFormat::Float32x3,
                bytes: pos_bytes,
            },
            ChannelBuffer {
                kind: AttributeKind::Normal,
                format: AttributeFormat::Float32x3,
                bytes: norm_bytes,
            },
        ];
        if has_uv0 {
            channels.push(ChannelBuffer {
                kind: AttributeKind::Uv,
                format: AttributeFormat::Float32x2,
                bytes: uv_bytes,
            });
        }
        if has_color {
            channels.push(ChannelBuffer {
                kind: AttributeKind::Color,
                format: AttributeFormat::Float32x4,
                bytes: color_bytes,
            });
        }

        let built = build_from_channels(
            vertex_count,
            &channels,
            &indices,
            &submeshes,
            slot_count as u32,
            mode,
        )?;
        self.last_built = Some(built);
        Ok(self.last_built.as_ref().unwrap())
    }

    fn create_edge(&mut self, a: i32, b: i32) -> i32 {
        let e = if let Some(reused) = self.free_edges.pop() {
            reused
        } else {
            let next = self.half_high_water / 2;
            self.half_high_water += 2;
            next
        };
        let h = (e * 2) as usize;
        let eu = e as usize;
        if self.h_vert.len() < h + 2 {
            let next_h = (h + 2).max(self.h_vert.len().saturating_mul(2)).max(64);
            self.h_vert.resize(next_h, NONE);
            self.h_next.resize(next_h, NONE);
            self.h_prev.resize(next_h, NONE);
            self.h_face.resize(next_h, NONE);
            for ch in self.channels.iter_mut().flatten() {
                if ch.set.len() < next_h {
                    ch.values.resize(next_h * ch.dim, 0.0);
                    ch.set.resize(next_h, 0);
                }
            }
        }
        grow_vec(&mut self.e_flags, eu + 1, 0);
        self.h_vert[h] = a;
        self.h_vert[h + 1] = b;
        self.h_face[h] = NONE;
        self.h_face[h + 1] = NONE;
        self.e_flags[eu] = 0;
        self.edge_index.insert(edge_key(a, b), e);
        e * 2
    }

    fn release_edge(&mut self, e: i32) {
        let h = (e * 2) as usize;
        let a = self.h_vert[h];
        let b = self.h_vert[h + 1];
        self.edge_index.remove(&edge_key(a, b));
        self.h_vert[h] = NONE;
        self.h_vert[h + 1] = NONE;
        self.e_flags[e as usize] = 0;
        self.free_edges.push(e);
    }

    fn ensure_face_capacity(&mut self, count: usize) {
        if self.f_half.len() < count {
            let next = count.max(self.f_half.len().saturating_mul(2)).max(32);
            self.f_half.resize(next, NONE);
            self.f_len.resize(next, 0);
            self.f_gen.resize(next, 0);
            self.f_material.resize(next, 0);
            self.f_label.resize(next, 0);
            self.f_role.resize(next, 0);
            self.f_flags.resize(next, 0);
            self.f_tags.resize(next * self.tag_words, 0);
        }
    }
}
