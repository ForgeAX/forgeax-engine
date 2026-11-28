//! Retained SoA RenderScene, FXK1 SceneDelta binary decoder, and DynamicTexture revision tracking.

use crate::handles::{HandleError, SlotTable, INVALID_HANDLE};
use crate::pso::FastBuildHasher;
use std::collections::HashMap;

pub const SCENE_DELTA_MAGIC: u32 = 0x4658_4B31; // "FXK1"
pub const SCENE_DELTA_VERSION: u32 = 1;
pub const SCENE_DELTA_HEADER_BYTES: usize = 64;

pub const DELTA_FLAG_BASELINE: u32 = 1 << 0;
pub const DELTA_FLAG_TEMPORAL_RESET: u32 = 1 << 1;
pub const DELTA_FLAG_CLEAR_SCENE: u32 = 1 << 2;

pub const OP_UPSERT_OBJECTS: u16 = 0x01;
pub const OP_REMOVE_OBJECTS: u16 = 0x02;
pub const OP_SET_TRANSFORMS: u16 = 0x03;
pub const OP_SET_SKIN_JOINTS: u16 = 0x04;
pub const OP_SET_DRAW_PARAMS: u16 = 0x05;
pub const OP_UPDATE_MATERIAL_PARAMS: u16 = 0x06;
pub const OP_UPDATE_MATERIAL_BINDINGS: u16 = 0x07;
pub const OP_SET_LIGHTS: u16 = 0x08;
pub const OP_SET_ENVIRONMENT: u16 = 0x09;
pub const OP_SET_INSTANCES: u16 = 0x0A;

pub const OBJ_FLAG_VISIBLE: u32 = 1 << 0;
pub const OBJ_FLAG_CAST_SHADOW: u32 = 1 << 1;
pub const OBJ_FLAG_RECEIVE_SHADOW: u32 = 1 << 2;
pub const OBJ_FLAG_FRUSTUM_CULLED: u32 = 1 << 3;
pub const OBJ_FLAG_TRANSPARENT: u32 = 1 << 4;
pub const OBJ_FLAG_MASKED: u32 = 1 << 5;
pub const OBJ_FLAG_GPU_DRIVEN: u32 = 1 << 6;

pub const LIGHT_KIND_DIRECTIONAL: u8 = 0;
pub const LIGHT_KIND_POINT: u8 = 1;
pub const LIGHT_KIND_SPOT: u8 = 2;

pub const UPSERT_RECORD_WORDS: usize = 14;
pub const LIGHT_RECORD_WORDS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaError {
    MalformedHeader,
    VersionMismatch,
    BaseMismatch,
    MalformedPayload,
    InvalidHandle(HandleError),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SubmeshRange {
    pub first_index: u32,
    pub index_count: u32,
    pub base_vertex: i32,
    pub first_vertex: u32,
    pub vertex_count: u32,
}

#[derive(Debug, Clone)]
pub struct MeshMeta {
    pub vertex_layout_id: u16,
    pub index_count: u32,
    pub vertex_count: u32,
    pub is_uint32_index: bool,
    pub topology: u8,
    pub submeshes: Vec<SubmeshRange>,
}

#[derive(Debug, Clone)]
pub struct DynamicTextureMeta {
    pub width: u32,
    pub height: u32,
    pub format: u8,
    pub revision: u32,
    /// Incremented ONLY when physical dimensions/format change (same-size writes keep BindGroup valid).
    pub view_generation: u32,
    pub in_place_updates: u32,
    pub reallocations: u32,
}

#[derive(Debug, Clone)]
pub struct MaterialMeta {
    pub shader_program_id: u32,
    pub layout_family_id: u16,
    pub render_state_bits: u32,
    pub variant_flags: u16,
    pub queue: u16,
    pub param_bytes: Vec<u8>,
    pub param_dirty: bool,
    pub dynamic_tex_refs: Vec<(u32, u32)>, // (dynamic_texture_id, observed_view_generation)
    pub bind_group_generation: u32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LightRecord {
    pub light_id: u32,
    pub kind: u8,
    pub cast_shadow: bool,
    pub cascade_count: u8,
    pub layer_mask: u32,
    pub position: [f32; 3],
    pub range: f32,
    pub direction: [f32; 3],
    pub intensity: f32,
    pub color: [f32; 3],
    pub outer_cone_cos: f32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct EnvironmentState {
    pub skylight_color: [f32; 3],
    pub skylight_intensity: f32,
    pub ground_color: [f32; 3],
    pub fog_mode: u32,
    pub fog_density: f32,
    pub fog_height_falloff: f32,
    pub fog_near: f32,
    pub fog_far: f32,
    pub ibl_texture_id: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct DirtyRange {
    pub start_row: u32,
    pub row_count: u32,
}

/// SoA retained render scene: contiguous numeric columns for cache-friendly culling, sorting, and GpuScene packing.
pub struct RetainedRenderScene {
    pub epoch: u32,
    pub revision: u32,
    pub elapsed_seconds: f64,
    pub delta_seconds: f64,
    pub sample_time_seconds: f64,
    pub sort_config_bits: u32,

    // Dense SoA render object columns
    pub object_ids: Vec<u32>,
    pub mesh_ids: Vec<u32>,
    pub submesh_start: Vec<u16>,
    pub submesh_count: Vec<u16>,
    pub material_ids: Vec<u32>,
    pub layer_masks: Vec<u32>,
    pub obj_flags: Vec<u32>,
    pub skin_slots: Vec<u32>,
    pub queues: Vec<u16>,
    pub entity_orders: Vec<u16>,
    pub local_aabb_min: Vec<[f32; 3]>,
    pub local_aabb_max: Vec<[f32; 3]>,
    pub transforms: Vec<[f32; 16]>,
    pub world_aabb_min: Vec<[f32; 3]>,
    pub world_aabb_max: Vec<[f32; 3]>,
    pub draw_params: Vec<[f32; 8]>,
    pub transform_dirty_rows: Vec<u32>,
    transform_dirty_bits: Vec<u64>,
    pub object_to_row: HashMap<u32, usize, FastBuildHasher>,

    // Assets & metadata tables
    pub meshes: SlotTable<MeshMeta>,
    pub textures: SlotTable<(u32, u32, u8)>,
    pub dynamic_textures: SlotTable<DynamicTextureMeta>,
    pub buffers: SlotTable<u32>,
    pub samplers: SlotTable<u32>,
    pub shaders: SlotTable<u32>,
    pub materials: SlotTable<MaterialMeta>,
    pub lights: Vec<LightRecord>,
    pub environment: EnvironmentState,
    /// Flat GPU joint palette storage updated incrementally by `OP_SET_SKIN_JOINTS`.
    pub skin_joints: Vec<[f32; 16]>,
    pub skin_dirty_ranges: Vec<(u32, u32)>,
}

impl Default for RetainedRenderScene {
    fn default() -> Self {
        Self::new()
    }
}

impl RetainedRenderScene {
    pub fn new() -> Self {
        Self {
            epoch: 0,
            revision: 0,
            elapsed_seconds: 0.0,
            delta_seconds: 0.0,
            sample_time_seconds: 0.0,
            sort_config_bits: 0,
            object_ids: Vec::with_capacity(1024),
            mesh_ids: Vec::with_capacity(1024),
            submesh_start: Vec::with_capacity(1024),
            submesh_count: Vec::with_capacity(1024),
            material_ids: Vec::with_capacity(1024),
            layer_masks: Vec::with_capacity(1024),
            obj_flags: Vec::with_capacity(1024),
            skin_slots: Vec::with_capacity(1024),
            queues: Vec::with_capacity(1024),
            entity_orders: Vec::with_capacity(1024),
            local_aabb_min: Vec::with_capacity(1024),
            local_aabb_max: Vec::with_capacity(1024),
            transforms: Vec::with_capacity(1024),
            world_aabb_min: Vec::with_capacity(1024),
            world_aabb_max: Vec::with_capacity(1024),
            draw_params: Vec::with_capacity(1024),
            transform_dirty_rows: Vec::with_capacity(256),
            transform_dirty_bits: Vec::with_capacity(16),
            object_to_row: HashMap::with_capacity_and_hasher(1024, FastBuildHasher),
            meshes: SlotTable::with_capacity(256),
            textures: SlotTable::with_capacity(256),
            dynamic_textures: SlotTable::with_capacity(64),
            buffers: SlotTable::with_capacity(256),
            samplers: SlotTable::with_capacity(32),
            shaders: SlotTable::with_capacity(64),
            materials: SlotTable::with_capacity(256),
            lights: Vec::with_capacity(64),
            environment: EnvironmentState::default(),
            skin_joints: Vec::with_capacity(64),
            skin_dirty_ranges: Vec::with_capacity(16),
        }
    }

    #[inline]
    pub fn object_count(&self) -> usize {
        self.object_ids.len()
    }

    pub fn clear_objects(&mut self) {
        self.object_ids.clear();
        self.mesh_ids.clear();
        self.submesh_start.clear();
        self.submesh_count.clear();
        self.material_ids.clear();
        self.layer_masks.clear();
        self.obj_flags.clear();
        self.skin_slots.clear();
        self.queues.clear();
        self.entity_orders.clear();
        self.local_aabb_min.clear();
        self.local_aabb_max.clear();
        self.transforms.clear();
        self.world_aabb_min.clear();
        self.world_aabb_max.clear();
        self.draw_params.clear();
        self.clear_dirty_rows();
        self.object_to_row.clear();
        self.trim_idle_scratch();
    }

    #[inline]
    pub fn clear_dirty_rows(&mut self) {
        self.transform_dirty_bits.fill(0);
        self.transform_dirty_rows.clear();
    }

    #[inline]
    fn mark_row_dirty(&mut self, row: usize) {
        let word = row >> 6;
        if word >= self.transform_dirty_bits.len() {
            self.transform_dirty_bits.resize(word + 1, 0);
        }
        let bit = 1u64 << (row & 63);
        if (self.transform_dirty_bits[word] & bit) == 0 {
            self.transform_dirty_bits[word] |= bit;
            self.transform_dirty_rows.push(row as u32);
        }
    }

    fn trim_idle_scratch(&mut self) {
        let min_rows = self.object_ids.len().max(1024);
        if self.transform_dirty_rows.capacity() > min_rows * 4 {
            self.transform_dirty_rows.shrink_to(min_rows);
        }
        let needed_words = (self.object_ids.len() + 63) / 64;
        let min_words = needed_words.max(16);
        if self.transform_dirty_bits.len() > min_words * 4 {
            self.transform_dirty_bits.truncate(min_words);
            self.transform_dirty_bits.shrink_to(min_words);
        }
    }

    /// Updates a DynamicTexture revision. Returns `Ok(true)` iff physical view changed (reallocation),
    /// `Ok(false)` for same-size in-place update (BindGroup stays valid) or no-op revision.
    pub fn update_dynamic_texture(
        &mut self,
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
    ) -> Result<bool, HandleError> {
        let meta = self.dynamic_textures.get_mut(id)?;
        if revision == meta.revision && width == meta.width && height == meta.height {
            return Ok(false);
        }
        meta.revision = revision;
        if width != meta.width || height != meta.height {
            meta.width = width;
            meta.height = height;
            meta.view_generation = meta.view_generation.wrapping_add(1);
            meta.reallocations += 1;
            Ok(true)
        } else {
            meta.in_place_updates += 1;
            Ok(false)
        }
    }

    /// Checks whether a material's BindGroup needs refresh due to any referenced DynamicTexture changing view_generation.
    pub fn sync_material_dynamic_bindings(&mut self, material_id: u32) -> bool {
        let mut stale = false;
        if let Ok(mat) = self.materials.get(material_id) {
            for &(dyn_id, observed_gen) in &mat.dynamic_tex_refs {
                if let Ok(dt) = self.dynamic_textures.get(dyn_id) {
                    if dt.view_generation != observed_gen {
                        stale = true;
                        break;
                    }
                }
            }
        }
        if stale {
            let mut updated_gens = Vec::new();
            if let Ok(mat) = self.materials.get(material_id) {
                for &(dyn_id, _) in &mat.dynamic_tex_refs {
                    let g = self
                        .dynamic_textures
                        .get(dyn_id)
                        .map(|d| d.view_generation)
                        .unwrap_or(0);
                    updated_gens.push((dyn_id, g));
                }
            }
            if let Ok(mat) = self.materials.get_mut(material_id) {
                mat.dynamic_tex_refs = updated_gens;
                mat.bind_group_generation = mat.bind_group_generation.wrapping_add(1);
            }
        }
        stale
    }

    /// Applies a binary FXK1 `SceneDelta` buffer in-place with zero intermediate object allocation.
    pub fn apply_scene_delta(&mut self, bytes: &[u8]) -> Result<u32, DeltaError> {
        if bytes.len() < SCENE_DELTA_HEADER_BYTES || (bytes.len() & 3) != 0 {
            return Err(DeltaError::MalformedHeader);
        }
        let magic = read_u32(bytes, 0);
        if magic != SCENE_DELTA_MAGIC {
            return Err(DeltaError::MalformedHeader);
        }
        let version = read_u32(bytes, 4);
        if version != SCENE_DELTA_VERSION {
            return Err(DeltaError::VersionMismatch);
        }
        let epoch = read_u32(bytes, 8);
        let revision = read_u32(bytes, 12);
        let base_revision = read_u32(bytes, 16);
        let flags = read_u32(bytes, 20);
        let op_count = read_u32(bytes, 24);
        let payload_bytes = read_u32(bytes, 28) as usize;

        if SCENE_DELTA_HEADER_BYTES + payload_bytes > bytes.len() || (payload_bytes & 3) != 0 {
            return Err(DeltaError::MalformedPayload);
        }

        let is_baseline = (flags & DELTA_FLAG_BASELINE) != 0;
        if !is_baseline && (epoch != self.epoch || base_revision != self.revision) {
            return Err(DeltaError::BaseMismatch);
        }
        if is_baseline || (flags & DELTA_FLAG_CLEAR_SCENE) != 0 {
            self.clear_objects();
            self.lights.clear();
        }

        self.epoch = epoch;
        self.revision = revision;
        self.elapsed_seconds = read_f64(bytes, 32);
        self.delta_seconds = read_f64(bytes, 40);
        self.sample_time_seconds = read_f64(bytes, 48);
        self.sort_config_bits = read_u32(bytes, 56);
        self.clear_dirty_rows();

        let mut cursor = SCENE_DELTA_HEADER_BYTES;
        let end = SCENE_DELTA_HEADER_BYTES + payload_bytes;

        for _ in 0..op_count {
            if cursor + 8 > end {
                return Err(DeltaError::MalformedPayload);
            }
            let word0 = read_u32(bytes, cursor);
            let op_code = (word0 & 0xFFFF) as u16;
            let count_or_len = read_u32(bytes, cursor + 4) as usize;
            cursor += 8;

            match op_code {
                OP_UPSERT_OBJECTS => {
                    let needed = count_or_len * UPSERT_RECORD_WORDS * 4;
                    if cursor + needed > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    for i in 0..count_or_len {
                        let base = cursor + i * UPSERT_RECORD_WORDS * 4;
                        let object_id = read_u32(bytes, base);
                        let mesh_id = read_u32(bytes, base + 4);
                        let sub_packed = read_u32(bytes, base + 8);
                        let sub_start = (sub_packed >> 16) as u16;
                        let sub_count = (sub_packed & 0xFFFF) as u16;
                        let material_id = read_u32(bytes, base + 12);
                        let layer_mask = read_u32(bytes, base + 16);
                        let obj_flags = read_u32(bytes, base + 20);
                        let skin_slot = read_u32(bytes, base + 24);
                        let q_packed = read_u32(bytes, base + 28);
                        let queue = (q_packed >> 16) as u16;
                        let entity_order = (q_packed & 0xFFFF) as u16;
                        let min = [
                            read_f32(bytes, base + 32),
                            read_f32(bytes, base + 36),
                            read_f32(bytes, base + 40),
                        ];
                        let max = [
                            read_f32(bytes, base + 44),
                            read_f32(bytes, base + 48),
                            read_f32(bytes, base + 52),
                        ];
                        self.upsert_object(
                            object_id,
                            mesh_id,
                            sub_start,
                            sub_count,
                            material_id,
                            layer_mask,
                            obj_flags,
                            skin_slot,
                            queue,
                            entity_order,
                            min,
                            max,
                        );
                    }
                    cursor += needed;
                }
                OP_REMOVE_OBJECTS => {
                    let needed = count_or_len * 4;
                    if cursor + needed > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    for i in 0..count_or_len {
                        let object_id = read_u32(bytes, cursor + i * 4);
                        self.remove_object(object_id);
                    }
                    if count_or_len > 0 {
                        self.trim_idle_scratch();
                    }
                    cursor += needed;
                }
                OP_SET_TRANSFORMS => {
                    let id_bytes = count_or_len * 4;
                    let mat_bytes = count_or_len * 64;
                    if cursor + id_bytes + mat_bytes > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    let mat_base = cursor + id_bytes;
                    for i in 0..count_or_len {
                        let object_id = read_u32(bytes, cursor + i * 4);
                        if let Some(&row) = self.object_to_row.get(&object_id) {
                            let m_off = mat_base + i * 64;
                            let m = &mut self.transforms[row];
                            for k in 0..16 {
                                m[k] = read_f32(bytes, m_off + k * 4);
                            }
                            let (wmin, wmax) = transform_aabb(
                                self.local_aabb_min[row],
                                self.local_aabb_max[row],
                                m,
                            );
                            self.world_aabb_min[row] = wmin;
                            self.world_aabb_max[row] = wmax;
                            self.mark_row_dirty(row);
                        }
                    }
                    cursor += id_bytes + mat_bytes;
                }
                OP_SET_DRAW_PARAMS => {
                    let needed = count_or_len * 36;
                    if cursor + needed > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    for i in 0..count_or_len {
                        let base = cursor + i * 36;
                        let object_id = read_u32(bytes, base);
                        if let Some(&row) = self.object_to_row.get(&object_id) {
                            let p = &mut self.draw_params[row];
                            for k in 0..8 {
                                p[k] = read_f32(bytes, base + 4 + k * 4);
                            }
                            self.mark_row_dirty(row);
                        }
                    }
                    cursor += needed;
                }
                OP_UPDATE_MATERIAL_PARAMS => {
                    if cursor + 8 > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    let material_id = read_u32(bytes, cursor);
                    let packed = read_u32(bytes, cursor + 4);
                    let byte_offset = (packed & 0xFFFF) as usize;
                    let byte_len = (packed >> 16) as usize;
                    let aligned_len = (byte_len + 3) & !3;
                    cursor += 8;
                    if cursor + aligned_len > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    let mat = self
                        .materials
                        .get_mut(material_id)
                        .map_err(DeltaError::InvalidHandle)?;
                    if byte_offset + byte_len > mat.param_bytes.len() {
                        mat.param_bytes.resize(byte_offset + byte_len, 0);
                    }
                    mat.param_bytes[byte_offset..byte_offset + byte_len]
                        .copy_from_slice(&bytes[cursor..cursor + byte_len]);
                    mat.param_dirty = true;
                    cursor += aligned_len;
                }
                OP_SET_LIGHTS => {
                    let needed = count_or_len * LIGHT_RECORD_WORDS * 4;
                    if cursor + needed > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    self.lights.clear();
                    for i in 0..count_or_len {
                        let base = cursor + i * LIGHT_RECORD_WORDS * 4;
                        let light_id = read_u32(bytes, base);
                        let meta = read_u32(bytes, base + 4);
                        let kind = (meta & 0xFF) as u8;
                        let cast_shadow = ((meta >> 8) & 1) != 0;
                        let cascade_count = ((meta >> 16) & 0xFF) as u8;
                        let layer_mask = read_u32(bytes, base + 8);
                        let range = read_f32(bytes, base + 12);
                        let position = [
                            read_f32(bytes, base + 16),
                            read_f32(bytes, base + 20),
                            read_f32(bytes, base + 24),
                        ];
                        let intensity = read_f32(bytes, base + 28);
                        let direction = [
                            read_f32(bytes, base + 32),
                            read_f32(bytes, base + 36),
                            read_f32(bytes, base + 40),
                        ];
                        let outer_cone_cos = read_f32(bytes, base + 44);
                        let color = [
                            read_f32(bytes, base + 48),
                            read_f32(bytes, base + 52),
                            read_f32(bytes, base + 56),
                        ];
                        self.lights.push(LightRecord {
                            light_id,
                            kind,
                            cast_shadow,
                            cascade_count,
                            layer_mask,
                            position,
                            range,
                            direction,
                            intensity,
                            color,
                            outer_cone_cos,
                        });
                    }
                    cursor += needed;
                }
                OP_SET_ENVIRONMENT => {
                    let needed = 64;
                    if cursor + needed > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    self.environment = EnvironmentState {
                        skylight_color: [
                            read_f32(bytes, cursor),
                            read_f32(bytes, cursor + 4),
                            read_f32(bytes, cursor + 8),
                        ],
                        skylight_intensity: read_f32(bytes, cursor + 12),
                        ground_color: [
                            read_f32(bytes, cursor + 16),
                            read_f32(bytes, cursor + 20),
                            read_f32(bytes, cursor + 24),
                        ],
                        fog_mode: read_u32(bytes, cursor + 28),
                        fog_density: read_f32(bytes, cursor + 32),
                        fog_height_falloff: read_f32(bytes, cursor + 36),
                        fog_near: read_f32(bytes, cursor + 40),
                        fog_far: read_f32(bytes, cursor + 44),
                        ibl_texture_id: read_u32(bytes, cursor + 48),
                    };
                    cursor += needed;
                }
                OP_SET_SKIN_JOINTS => {
                    // count_or_len = payload byte length (4-byte aligned):
                    // [joint_offset: u32, joint_count: u32, mat4x4<f32>[joint_count]]
                    let aligned = (count_or_len + 3) & !3;
                    if cursor + aligned > end || aligned < 8 {
                        return Err(DeltaError::MalformedPayload);
                    }
                    let joint_offset = read_u32(bytes, cursor) as usize;
                    let joint_count = read_u32(bytes, cursor + 4) as usize;
                    if 8 + joint_count * 64 > aligned {
                        return Err(DeltaError::MalformedPayload);
                    }
                    let needed = joint_offset + joint_count;
                    if self.skin_joints.len() < needed {
                        let identity = [
                            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                            0.0, 1.0,
                        ];
                        self.skin_joints.resize(needed, identity);
                    }
                    let mat_base = cursor + 8;
                    for j in 0..joint_count {
                        let m_off = mat_base + j * 64;
                        let dst = &mut self.skin_joints[joint_offset + j];
                        for k in 0..16 {
                            dst[k] = read_f32(bytes, m_off + k * 4);
                        }
                    }
                    if joint_count > 0 {
                        self.skin_dirty_ranges
                            .push((joint_offset as u32, joint_count as u32));
                    }
                    cursor += aligned;
                }
                OP_UPDATE_MATERIAL_BINDINGS | OP_SET_INSTANCES => {
                    // Fixed byte length encoded in count_or_len (4-byte aligned)
                    let aligned = (count_or_len + 3) & !3;
                    if cursor + aligned > end {
                        return Err(DeltaError::MalformedPayload);
                    }
                    cursor += aligned;
                }
                _ => return Err(DeltaError::MalformedPayload),
            }
        }

        Ok(self.revision)
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_object(
        &mut self,
        object_id: u32,
        mesh_id: u32,
        sub_start: u16,
        sub_count: u16,
        material_id: u32,
        layer_mask: u32,
        obj_flags: u32,
        skin_slot: u32,
        queue: u16,
        entity_order: u16,
        local_min: [f32; 3],
        local_max: [f32; 3],
    ) {
        if object_id == INVALID_HANDLE {
            return;
        }
        if let Some(&row) = self.object_to_row.get(&object_id) {
            self.mesh_ids[row] = mesh_id;
            self.submesh_start[row] = sub_start;
            self.submesh_count[row] = sub_count;
            self.material_ids[row] = material_id;
            self.layer_masks[row] = layer_mask;
            self.obj_flags[row] = obj_flags;
            let skin_changed = self.skin_slots[row] != skin_slot;
            self.skin_slots[row] = skin_slot;
            if skin_changed {
                self.mark_row_dirty(row);
            }
            self.queues[row] = queue;
            self.entity_orders[row] = entity_order;
            self.local_aabb_min[row] = local_min;
            self.local_aabb_max[row] = local_max;
            let (wmin, wmax) = transform_aabb(local_min, local_max, &self.transforms[row]);
            self.world_aabb_min[row] = wmin;
            self.world_aabb_max[row] = wmax;
            return;
        }
        let row = self.object_ids.len();
        let identity = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        self.object_ids.push(object_id);
        self.mesh_ids.push(mesh_id);
        self.submesh_start.push(sub_start);
        self.submesh_count.push(sub_count);
        self.material_ids.push(material_id);
        self.layer_masks.push(layer_mask);
        self.obj_flags.push(obj_flags);
        self.skin_slots.push(skin_slot);
        self.queues.push(queue);
        self.entity_orders.push(entity_order);
        self.local_aabb_min.push(local_min);
        self.local_aabb_max.push(local_max);
        self.transforms.push(identity);
        self.world_aabb_min.push(local_min);
        self.world_aabb_max.push(local_max);
        self.draw_params.push([0.0; 8]);
        self.object_to_row.insert(object_id, row);
    }

    fn remove_object(&mut self, object_id: u32) {
        let Some(row) = self.object_to_row.remove(&object_id) else {
            return;
        };
        let last = self.object_ids.len() - 1;
        if row != last {
            let moved_id = self.object_ids[last];
            self.object_ids.swap_remove(row);
            self.mesh_ids.swap_remove(row);
            self.submesh_start.swap_remove(row);
            self.submesh_count.swap_remove(row);
            self.material_ids.swap_remove(row);
            self.layer_masks.swap_remove(row);
            self.obj_flags.swap_remove(row);
            self.skin_slots.swap_remove(row);
            self.queues.swap_remove(row);
            self.entity_orders.swap_remove(row);
            self.local_aabb_min.swap_remove(row);
            self.local_aabb_max.swap_remove(row);
            self.transforms.swap_remove(row);
            self.world_aabb_min.swap_remove(row);
            self.world_aabb_max.swap_remove(row);
            self.draw_params.swap_remove(row);
            self.object_to_row.insert(moved_id, row);
            self.mark_row_dirty(row);
        } else {
            self.object_ids.pop();
            self.mesh_ids.pop();
            self.submesh_start.pop();
            self.submesh_count.pop();
            self.material_ids.pop();
            self.layer_masks.pop();
            self.obj_flags.pop();
            self.skin_slots.pop();
            self.queues.pop();
            self.entity_orders.pop();
            self.local_aabb_min.pop();
            self.local_aabb_max.pop();
            self.transforms.pop();
            self.world_aabb_min.pop();
            self.world_aabb_max.pop();
            self.draw_params.pop();
        }
    }

    /// Merges dirty transform rows into sorted contiguous GPU upload ranges.
    pub fn merged_dirty_ranges(&mut self, out: &mut Vec<DirtyRange>) {
        out.clear();
        if self.transform_dirty_rows.is_empty() {
            return;
        }
        let len = self.object_ids.len() as u32;
        if len == 0 {
            return;
        }
        self.transform_dirty_rows.sort_unstable();
        let mut iter = self.transform_dirty_rows.iter().copied().filter(|&r| r < len);
        let Some(mut start) = iter.next() else {
            return;
        };
        let mut end = start + 1;
        for r in iter {
            if r == end {
                end += 1;
            } else {
                out.push(DirtyRange {
                    start_row: start,
                    row_count: end - start,
                });
                start = r;
                end = r + 1;
            }
        }
        out.push(DirtyRange {
            start_row: start,
            row_count: end - start,
        });
    }
}

/// Exact Arvo transform of a local AABB by a column-major 4x4 matrix.
#[inline]
pub fn transform_aabb(min: [f32; 3], max: [f32; 3], m: &[f32; 16]) -> ([f32; 3], [f32; 3]) {
    let cx = (min[0] + max[0]) * 0.5;
    let cy = (min[1] + max[1]) * 0.5;
    let cz = (min[2] + max[2]) * 0.5;
    let ex = (max[0] - min[0]) * 0.5;
    let ey = (max[1] - min[1]) * 0.5;
    let ez = (max[2] - min[2]) * 0.5;

    let wcx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
    let wcy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
    let wcz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];

    let wex = m[0].abs() * ex + m[4].abs() * ey + m[8].abs() * ez;
    let wey = m[1].abs() * ex + m[5].abs() * ey + m[9].abs() * ez;
    let wez = m[2].abs() * ex + m[6].abs() * ey + m[10].abs() * ez;

    (
        [wcx - wex, wcy - wey, wcz - wez],
        [wcx + wex, wcy + wey, wcz + wez],
    )
}

#[inline]
pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
pub(crate) fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
pub(crate) fn read_f64(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}
