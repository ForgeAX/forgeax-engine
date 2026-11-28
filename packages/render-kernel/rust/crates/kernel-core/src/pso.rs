//! Fixed 4-BGL contract and 128-bit integer PSO lookup table.

use std::collections::HashMap;

/// Fixed 4-BindGroupLayout slot assignment matching ForgeAX Standard PBR/Unlit ABI.
pub const BGL_SLOT_VIEW: u32 = 0;
pub const BGL_SLOT_MATERIAL: u32 = 1;
pub const BGL_SLOT_MESH_SCENE: u32 = 2;
pub const BGL_SLOT_INSTANCES: u32 = 3;

/// Explicit fixed 4-BGL scene layout family (`[view, material, scene-objects+lights, instance-rows]`).
pub const LAYOUT_FAMILY_SCENE_4BGL: u16 = 2;

/// Reserved SurfaceId targeting the attached native swapchain surface directly.
pub const SURFACE_SWAPCHAIN_HANDLE: u32 = 0x7FFF_FFFF;

/// Canonical View UBO sizing from `packages/render/src/record/view-ubo.ts`.
pub const VIEW_UNIFORM_BYTES: u32 = 1392;
pub const VIEW_UNIFORM_SLOT_STRIDE: u32 = 1536;

/// Pass tag constants (8-bit).
pub const PASS_TAG_FORWARD_OPAQUE: u8 = 0;
pub const PASS_TAG_FORWARD_TRANSPARENT: u8 = 1;
pub const PASS_TAG_SHADOW_DEPTH: u8 = 2;
pub const PASS_TAG_DEPTH_PREPASS: u8 = 3;
pub const PASS_TAG_GBUFFER: u8 = 4;
pub const PASS_TAG_VELOCITY: u8 = 5;
pub const PASS_TAG_CUSTOM: u8 = 16;

/// 128-bit integer PSO lookup key: zero strings, zero heap allocations.
#[repr(C)]
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub struct PsoKey {
    pub lo: u64,
    pub hi: u64,
}

impl PsoKey {
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub const fn pack(
        shader_program_id: u32,
        vertex_layout_id: u16,
        pass_attachment_id: u16,
        pass_tag: u8,
        layout_family_id: u16,
        render_state_bits: u32,
        variant_flags: u16,
    ) -> Self {
        let lo = (((shader_program_id & 0x00FF_FFFF) as u64) << 40)
            | ((vertex_layout_id as u64) << 24)
            | ((pass_attachment_id as u64) << 8)
            | (pass_tag as u64);
        let hi = ((layout_family_id as u64) << 48)
            | ((render_state_bits as u64) << 16)
            | (variant_flags as u64);
        Self { lo, hi }
    }

    #[inline]
    pub const fn to_u32x4(self) -> [u32; 4] {
        [
            self.lo as u32,
            (self.lo >> 32) as u32,
            self.hi as u32,
            (self.hi >> 32) as u32,
        ]
    }

    #[inline]
    pub const fn from_u32x4(words: [u32; 4]) -> Self {
        let lo = (words[0] as u64) | ((words[1] as u64) << 32);
        let hi = (words[2] as u64) | ((words[3] as u64) << 32);
        Self { lo, hi }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum PsoStatus {
    Ready = 0,
    Compiling = 1,
    Failed = 2,
}

#[derive(Debug, Copy, Clone)]
pub struct PsoEntry {
    pub slot_id: u32,
    pub status: PsoStatus,
    pub key: PsoKey,
}

/// Fast deterministic integer PSO cache (FNV-1a/Wyhash-style hasher avoids SipHash overhead).
#[derive(Default)]
pub struct FastU64Hasher(u64);

impl std::hash::Hasher for FastU64Hasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut h = self.0 ^ 0x9E37_79B9_7F4A_7C15;
        for &b in bytes {
            h = (h ^ b as u64).wrapping_mul(0x100000001B3);
        }
        self.0 = h;
    }

    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0 ^ i).wrapping_mul(0x517C_C1B7_2722_0A95);
    }

    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
}

#[derive(Default, Clone)]
pub struct FastBuildHasher;

impl std::hash::BuildHasher for FastBuildHasher {
    type Hasher = FastU64Hasher;
    #[inline]
    fn build_hasher(&self) -> Self::Hasher {
        FastU64Hasher(0)
    }
}

pub struct PsoTable {
    map: HashMap<PsoKey, PsoEntry, FastBuildHasher>,
    next_slot: u32,
}

impl Default for PsoTable {
    fn default() -> Self {
        Self::new()
    }
}

impl PsoTable {
    pub fn new() -> Self {
        Self {
            map: HashMap::with_capacity_and_hasher(256, FastBuildHasher),
            next_slot: 1,
        }
    }

    #[inline]
    pub fn get(&self, key: PsoKey) -> Option<&PsoEntry> {
        self.map.get(&key)
    }

    pub fn get_or_admit(&mut self, key: PsoKey, initial_status: PsoStatus) -> PsoEntry {
        if let Some(&entry) = self.map.get(&key) {
            return entry;
        }
        let slot_id = self.next_slot;
        self.next_slot = self.next_slot.wrapping_add(1);
        let entry = PsoEntry {
            slot_id,
            status: initial_status,
            key,
        };
        self.map.insert(key, entry);
        entry
    }

    pub fn set_status(&mut self, key: PsoKey, status: PsoStatus) {
        if let Some(entry) = self.map.get_mut(&key) {
            entry.status = status;
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.next_slot = 1;
    }
}
