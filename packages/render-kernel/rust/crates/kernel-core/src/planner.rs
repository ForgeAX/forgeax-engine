//! Two-pass linear FrameCommandStream planner:
//! - Pass 1: transient RT lifetime intervals, usage aggregation, pass conflict validation,
//!           and compatible adjacent raster pass batching.
//! - Pass 2: transient RT pooling with lifetime aliasing and idle-frame TTL retirement.
//! - Pass 3: emits resolved physical replay bytecode (`PHYS_*`) consumed identically by
//!           TS RHI replay (WebGPU/Dawn/RhiNull/RHI-Debug) and Native Rust wgpu.

use crate::arena::FrameBumpArena;
use crate::cull::CullRecord;
use crate::draw_list::{emit_draw_renderers, DrawListStats, DrawRenderersArgs};
use crate::pso::PsoTable;
use crate::scene::RetainedRenderScene;

// Input FrameRecorder opcodes
pub const CMD_ACQUIRE_TEMP_TEX: u16 = 0x01;
pub const CMD_DEF_BINDING_SET: u16 = 0x02;
pub const CMD_BEGIN_RENDER_PASS: u16 = 0x10;
pub const CMD_DRAW_RENDERERS: u16 = 0x11;
pub const CMD_DRAW_FULLSCREEN: u16 = 0x12;
pub const CMD_DRAW_MESH: u16 = 0x13;
pub const CMD_END_RENDER_PASS: u16 = 0x14;
pub const CMD_SET_VIEWPORT: u16 = 0x15;
pub const CMD_SET_SCISSOR: u16 = 0x16;
pub const CMD_BEGIN_COMPUTE_PASS: u16 = 0x20;
pub const CMD_DISPATCH: u16 = 0x21;
pub const CMD_DISPATCH_INDIRECT: u16 = 0x22;
pub const CMD_END_COMPUTE_PASS: u16 = 0x23;
pub const CMD_COPY_TEXTURE: u16 = 0x30;
pub const CMD_COPY_BUFFER: u16 = 0x31;
pub const CMD_GENERATE_MIPS: u16 = 0x32;
pub const CMD_REQUEST_READBACK: u16 = 0x33;
pub const CMD_RHI_SET_PIPELINE: u16 = 0x40;
pub const CMD_RHI_SET_BIND_GROUP: u16 = 0x41;
pub const CMD_RHI_SET_VB: u16 = 0x42;
pub const CMD_RHI_SET_IB: u16 = 0x43;
pub const CMD_RHI_DRAW: u16 = 0x44;
pub const CMD_RHI_DRAW_INDEXED: u16 = 0x45;
pub const CMD_RHI_DRAW_INDIRECT: u16 = 0x46;
pub const CMD_SET_SHADER_PIPELINE: u16 = 0x47;

// Resolved Physical Replay Stream opcodes
pub const PHYS_ENSURE_POOL_TEX: u16 = 0x81;
pub const PHYS_RETIRE_POOL_TEX: u16 = 0x82;
pub const PHYS_BEGIN_RENDER_PASS: u16 = 0x83;
pub const PHYS_SET_PSO: u16 = 0x84;
pub const PHYS_SET_BIND_GROUP: u16 = 0x85;
pub const PHYS_SET_VB: u16 = 0x86;
pub const PHYS_SET_IB: u16 = 0x87;
pub const PHYS_DRAW: u16 = 0x88;
pub const PHYS_DRAW_INDEXED: u16 = 0x89;
pub const PHYS_DRAW_INDIRECT: u16 = 0x8A;
pub const PHYS_END_RENDER_PASS: u16 = 0x8B;
pub const PHYS_BEGIN_COMPUTE_PASS: u16 = 0x8C;
pub const PHYS_DISPATCH: u16 = 0x8D;
pub const PHYS_DISPATCH_INDIRECT: u16 = 0x8E;
pub const PHYS_END_COMPUTE_PASS: u16 = 0x8F;
pub const PHYS_COPY_TEXTURE: u16 = 0x90;
pub const PHYS_COPY_BUFFER: u16 = 0x91;
pub const PHYS_GENERATE_MIPS: u16 = 0x92;
pub const PHYS_REQUEST_READBACK: u16 = 0x93;
pub const PHYS_UPLOAD_GPU_SCENE: u16 = 0x94;
pub const PHYS_DRAW_FULLSCREEN: u16 = 0x95;
pub const PHYS_DEF_BINDING_SET: u16 = 0x96;
pub const PHYS_SET_VIEWPORT: u16 = 0x97;
pub const PHYS_SET_SCISSOR: u16 = 0x98;

/// Handle bit flag distinguishing transient pool textures from persistent TextureIds in resolved stream.
pub const TEMP_TEXTURE_TAG_BIT: u32 = 0x8000_0000;

#[inline]
pub const fn cmd_header(opcode: u16, word_len: u16) -> u32 {
    ((word_len as u32) << 16) | (opcode as u32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanError {
    MalformedStream,
    PassResourceConflict,
    TempTextureOutOfScope,
    InvalidCullHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolTextureDesc {
    pub format_samples_domain: u32,
    pub width: u32,
    pub height: u32,
    pub layers_mips: u32,
    pub usage_flags: u32,
}

struct TempTexEntry {
    temp_id: u32,
    desc: PoolTextureDesc,
    first_pass: u32,
    last_pass: u32,
    pool_slot: u32,
}

struct PoolSlot {
    slot_id: u32,
    desc: PoolTextureDesc,
    last_used_frame: u64,
    in_use_until_pass: i32,
    alive: bool,
}

pub struct TransientTexturePool {
    slots: Vec<PoolSlot>,
    next_slot_id: u32,
    pub idle_ttl_frames: u64,
}

impl Default for TransientTexturePool {
    fn default() -> Self {
        Self::new()
    }
}

impl TransientTexturePool {
    pub fn new() -> Self {
        Self {
            slots: Vec::with_capacity(32),
            next_slot_id: 1,
            idle_ttl_frames: 8,
        }
    }

    pub fn begin_frame(&mut self) {
        for slot in &mut self.slots {
            slot.in_use_until_pass = -1;
        }
    }

    /// Acquires a compatible pool slot not overlapping `[first_pass, last_pass]`.
    pub fn acquire(
        &mut self,
        desc: PoolTextureDesc,
        first_pass: u32,
        last_pass: u32,
        frame_id: u64,
    ) -> (u32, bool) {
        for slot in &mut self.slots {
            if slot.alive
                && slot.desc == desc
                && slot.in_use_until_pass < first_pass as i32
            {
                slot.in_use_until_pass = last_pass as i32;
                slot.last_used_frame = frame_id;
                return (slot.slot_id, false);
            }
        }
        let slot_id = self.next_slot_id;
        self.next_slot_id += 1;
        self.slots.push(PoolSlot {
            slot_id,
            desc,
            last_used_frame: frame_id,
            in_use_until_pass: last_pass as i32,
            alive: true,
        });
        (slot_id, true)
    }

    pub fn retire_idle(&mut self, frame_id: u64, out_retired: &mut Vec<u32>) {
        out_retired.clear();
        for slot in &mut self.slots {
            if slot.alive && frame_id.saturating_sub(slot.last_used_frame) > self.idle_ttl_frames {
                slot.alive = false;
                out_retired.push(slot.slot_id);
            }
        }
        self.slots.retain(|s| s.alive);
    }

    pub fn active_count(&self) -> usize {
        self.slots.iter().filter(|s| s.alive).count()
    }

    pub fn clear(&mut self) {
        self.slots.clear();
        self.next_slot_id = 1;
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct PlanResultStats {
    pub submitted_pass_count: u32,
    pub merged_pass_count: u32,
    pub submitted_draw_count: u32,
    pub submitted_indirect_count: u32,
    pub pending_pipeline_count: u32,
    pub first_missing_object_id: u32,
    pub first_missing_submesh: u32,
    pub pool_texture_count: u32,
    pub pool_allocations: u32,
    pub pool_reuses: u32,
}

fn find_temp_idx(temps: &[TempTexEntry], handle: u32) -> Option<usize> {
    if (handle & TEMP_TEXTURE_TAG_BIT) == 0 {
        return None;
    }
    temps.iter().position(|t| t.temp_id == handle)
}

fn resolve_tex_handle(temps: &[TempTexEntry], handle: u32) -> Result<u32, PlanError> {
    if (handle & TEMP_TEXTURE_TAG_BIT) == 0 {
        return Ok(handle);
    }
    let idx = find_temp_idx(temps, handle).ok_or(PlanError::TempTextureOutOfScope)?;
    Ok(TEMP_TEXTURE_TAG_BIT | temps[idx].pool_slot)
}

/// Compiles & lowers `input_cmds` into `out_phys_cmds` with zero per-draw heap allocations.
#[allow(clippy::too_many_arguments)]
pub fn plan_and_lower_frame(
    frame_id: u64,
    surface_width: u32,
    surface_height: u32,
    input_cmds: &[u32],
    scene: &RetainedRenderScene,
    culls: &[CullRecord],
    pso_table: &mut PsoTable,
    pool: &mut TransientTexturePool,
    arena: &mut FrameBumpArena,
    out_phys_cmds: &mut Vec<u32>,
    out_submitted_bitmap: &mut Vec<u32>,
    out_instance_rows: &mut Vec<u32>,
) -> Result<PlanResultStats, PlanError> {
    out_phys_cmds.clear();
    out_instance_rows.clear();
    let bitmap_words = (scene.object_count() + 31) / 32;
    out_submitted_bitmap.clear();
    out_submitted_bitmap.resize(bitmap_words, 0);

    let mut temps: Vec<TempTexEntry> = Vec::with_capacity(16);
    let mut stats = PlanResultStats::default();

    // --- PASS 1: Linear scan for transient texture declarations, lifetimes, and conflict check ---
    let mut cursor = 0usize;
    let mut pass_index = 0u32;
    let mut in_render_pass = false;
    let mut pass_written_temps: Vec<u32> = Vec::with_capacity(8);

    while cursor < input_cmds.len() {
        let hdr = input_cmds[cursor];
        let opcode = (hdr & 0xFFFF) as u16;
        let word_len = (hdr >> 16) as usize;
        if word_len == 0 || cursor + word_len > input_cmds.len() {
            return Err(PlanError::MalformedStream);
        }

        match opcode {
            CMD_ACQUIRE_TEMP_TEX => {
                if word_len < 7 {
                    return Err(PlanError::MalformedStream);
                }
                let temp_id = input_cmds[cursor + 1];
                let format_samples_domain = input_cmds[cursor + 2];
                let w = input_cmds[cursor + 3];
                let h = input_cmds[cursor + 4];
                let layers_mips = input_cmds[cursor + 5];
                let usage_flags = input_cmds[cursor + 6];
                temps.push(TempTexEntry {
                    temp_id,
                    desc: PoolTextureDesc {
                        format_samples_domain,
                        width: if w == 0 { surface_width } else { w },
                        height: if h == 0 { surface_height } else { h },
                        layers_mips,
                        usage_flags,
                    },
                    first_pass: u32::MAX,
                    last_pass: 0,
                    pool_slot: 0,
                });
            }
            CMD_BEGIN_RENDER_PASS => {
                if in_render_pass || word_len < 3 {
                    return Err(PlanError::MalformedStream);
                }
                in_render_pass = true;
                pass_written_temps.clear();
                let meta = input_cmds[cursor + 2];
                let color_count = (meta & 0xFF) as usize;
                let has_depth = ((meta >> 8) & 1) != 0;
                let expected = 3 + color_count * 8 + if has_depth { 4 } else { 0 };
                if word_len < expected {
                    return Err(PlanError::MalformedStream);
                }
                for c in 0..color_count {
                    let base = cursor + 3 + c * 8;
                    let tex = input_cmds[base];
                    let resolve = input_cmds[base + 1];
                    if let Some(idx) = find_temp_idx(&temps, tex) {
                        temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                        temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                        pass_written_temps.push(tex);
                    }
                    if let Some(idx) = find_temp_idx(&temps, resolve) {
                        temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                        temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                        pass_written_temps.push(resolve);
                    }
                }
                if has_depth {
                    let base = cursor + 3 + color_count * 8;
                    let tex = input_cmds[base];
                    let load_store_ro = input_cmds[base + 2];
                    let read_only = ((load_store_ro >> 16) & 1) != 0;
                    if let Some(idx) = find_temp_idx(&temps, tex) {
                        temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                        temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                        if !read_only {
                            pass_written_temps.push(tex);
                        }
                    }
                }
            }
            CMD_END_RENDER_PASS => {
                if !in_render_pass {
                    return Err(PlanError::MalformedStream);
                }
                in_render_pass = false;
                pass_written_temps.clear();
                pass_index += 1;
            }
            CMD_BEGIN_COMPUTE_PASS => {
                if in_render_pass {
                    return Err(PlanError::MalformedStream);
                }
            }
            CMD_END_COMPUTE_PASS => {
                pass_index += 1;
            }
            CMD_DEF_BINDING_SET => {
                if word_len < 3 {
                    return Err(PlanError::MalformedStream);
                }
                let entry_count = input_cmds[cursor + 2] as usize;
                if word_len < 3 + entry_count * 3 {
                    return Err(PlanError::MalformedStream);
                }
                for e in 0..entry_count {
                    let sk = input_cmds[cursor + 3 + e * 3];
                    let kind = sk >> 16;
                    if kind != 0 && kind != 2 {
                        continue;
                    }
                    let handle = input_cmds[cursor + 3 + e * 3 + 1];
                    if let Some(idx) = find_temp_idx(&temps, handle) {
                        if in_render_pass && pass_written_temps.contains(&handle) {
                            return Err(PlanError::PassResourceConflict);
                        }
                        temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                        temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                    }
                }
            }
            CMD_COPY_TEXTURE => {
                if word_len < 8 {
                    return Err(PlanError::MalformedStream);
                }
                let src = input_cmds[cursor + 1];
                let dst = input_cmds[cursor + 3];
                if src == dst && (src & TEMP_TEXTURE_TAG_BIT) != 0 {
                    return Err(PlanError::PassResourceConflict);
                }
                if let Some(idx) = find_temp_idx(&temps, src) {
                    temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                    temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                }
                if let Some(idx) = find_temp_idx(&temps, dst) {
                    temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                    temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                }
                pass_index += 1;
            }
            CMD_GENERATE_MIPS | CMD_REQUEST_READBACK => {
                if word_len >= 2 {
                    let tex = input_cmds[cursor + 1];
                    if let Some(idx) = find_temp_idx(&temps, tex) {
                        temps[idx].first_pass = temps[idx].first_pass.min(pass_index);
                        temps[idx].last_pass = temps[idx].last_pass.max(pass_index);
                    }
                }
                pass_index += 1;
            }
            _ => {}
        }

        cursor += word_len;
    }

    // --- PASS 2: Bind transient textures from pool with lifetime aliasing ---
    pool.begin_frame();
    for t in &mut temps {
        if t.first_pass == u32::MAX {
            // Unused temp texture; still allocate minimally for explicit lifetime tracking
            t.first_pass = 0;
            t.last_pass = 0;
        }
        let (slot_id, newly_allocated) = pool.acquire(t.desc, t.first_pass, t.last_pass, frame_id);
        t.pool_slot = slot_id;
        if newly_allocated {
            stats.pool_allocations += 1;
        } else {
            stats.pool_reuses += 1;
        }
        out_phys_cmds.push(cmd_header(PHYS_ENSURE_POOL_TEX, 7));
        out_phys_cmds.push(slot_id);
        out_phys_cmds.push(t.desc.format_samples_domain);
        out_phys_cmds.push(t.desc.width);
        out_phys_cmds.push(t.desc.height);
        out_phys_cmds.push(t.desc.layers_mips);
        out_phys_cmds.push(t.desc.usage_flags);
    }

    // --- PASS 3: Emit resolved physical command stream (with compatible raster pass batching) ---
    cursor = 0;
    let mut last_pass_sig: Option<(usize, Vec<u32>)> = None; // (end_cmd_pos, attachment_sig)
    let mut draw_stats = DrawListStats::default();

    while cursor < input_cmds.len() {
        let hdr = input_cmds[cursor];
        let opcode = (hdr & 0xFFFF) as u16;
        let word_len = (hdr >> 16) as usize;

        match opcode {
            CMD_ACQUIRE_TEMP_TEX => {
                // Already lowered to PHYS_ENSURE_POOL_TEX
            }
            CMD_DEF_BINDING_SET => {
                let entry_count = input_cmds[cursor + 2] as usize;
                out_phys_cmds.push(cmd_header(PHYS_DEF_BINDING_SET, word_len as u16));
                out_phys_cmds.push(input_cmds[cursor + 1]);
                out_phys_cmds.push(entry_count as u32);
                for e in 0..entry_count {
                    let base = cursor + 3 + e * 3;
                    let sk = input_cmds[base];
                    let kind = sk >> 16;
                    out_phys_cmds.push(sk);
                    let resolved_handle = if kind == 0 || kind == 2 {
                        resolve_tex_handle(&temps, input_cmds[base + 1])?
                    } else {
                        input_cmds[base + 1]
                    };
                    out_phys_cmds.push(resolved_handle);
                    out_phys_cmds.push(input_cmds[base + 2]);
                }
            }
            CMD_BEGIN_RENDER_PASS => {
                let meta = input_cmds[cursor + 2];
                let color_count = (meta & 0xFF) as usize;
                let has_depth = ((meta >> 8) & 1) != 0;

                // Resolve all attachment handles and check if compatible with immediately previous render pass
                let mut resolved_sig = Vec::with_capacity(color_count * 3 + 3);
                let mut all_load = true;
                for c in 0..color_count {
                    let base = cursor + 3 + c * 8;
                    let tex = resolve_tex_handle(&temps, input_cmds[base])?;
                    let res = resolve_tex_handle(&temps, input_cmds[base + 1])?;
                    let mip_layer = input_cmds[base + 2];
                    let load_store = input_cmds[base + 3];
                    let load_op = load_store & 0xFF; // 0=clear, 1=load
                    if load_op != 1 {
                        all_load = false;
                    }
                    resolved_sig.push(tex);
                    resolved_sig.push(res);
                    resolved_sig.push(mip_layer);
                }
                if has_depth {
                    let base = cursor + 3 + color_count * 8;
                    let tex = resolve_tex_handle(&temps, input_cmds[base])?;
                    let mip_layer = input_cmds[base + 1];
                    let load_store_ro = input_cmds[base + 2];
                    let load_op = load_store_ro & 0xFF;
                    if load_op != 1 {
                        all_load = false;
                    }
                    resolved_sig.push(tex);
                    resolved_sig.push(mip_layer);
                    resolved_sig.push(load_store_ro & 0x00FF_0000);
                }

                let merged = if all_load {
                    if let Some((end_pos, ref prev_sig)) = last_pass_sig {
                        if end_pos == out_phys_cmds.len() - 1 && *prev_sig == resolved_sig {
                            // Pop previous PHYS_END_RENDER_PASS to merge into single native pass!
                            out_phys_cmds.pop();
                            stats.merged_pass_count += 1;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                if !merged {
                    stats.submitted_pass_count += 1;
                    out_phys_cmds.push(cmd_header(PHYS_BEGIN_RENDER_PASS, word_len as u16));
                    out_phys_cmds.push(input_cmds[cursor + 1]);
                    out_phys_cmds.push(meta);
                    for c in 0..color_count {
                        let base = cursor + 3 + c * 8;
                        out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[base])?);
                        out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[base + 1])?);
                        out_phys_cmds.push(input_cmds[base + 2]);
                        out_phys_cmds.push(input_cmds[base + 3]);
                        out_phys_cmds.push(input_cmds[base + 4]);
                        out_phys_cmds.push(input_cmds[base + 5]);
                        out_phys_cmds.push(input_cmds[base + 6]);
                        out_phys_cmds.push(input_cmds[base + 7]);
                    }
                    if has_depth {
                        let base = cursor + 3 + color_count * 8;
                        out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[base])?);
                        out_phys_cmds.push(input_cmds[base + 1]);
                        out_phys_cmds.push(input_cmds[base + 2]);
                        out_phys_cmds.push(input_cmds[base + 3]);
                    }
                }
                last_pass_sig = Some((0, resolved_sig));
            }
            CMD_DRAW_RENDERERS => {
                if word_len < 11 {
                    return Err(PlanError::MalformedStream);
                }
                let cull_id = input_cmds[cursor + 1];
                let cull = culls
                    .iter()
                    .find(|c| c.cull_id == cull_id)
                    .ok_or(PlanError::InvalidCullHandle)?;
                let p_meta = input_cmds[cursor + 2];
                let q_meta = input_cmds[cursor + 3];
                let args = DrawRenderersArgs {
                    pass_tag: (p_meta & 0xFF) as u8,
                    sort_mode: ((p_meta >> 8) & 0xFF) as u8,
                    draw_flags: ((p_meta >> 16) & 0xFFFF) as u16,
                    queue_min: (q_meta & 0xFFFF) as u16,
                    queue_max: ((q_meta >> 16) & 0xFFFF) as u16,
                    layer_mask: input_cmds[cursor + 4],
                    view_uniform_off: input_cmds[cursor + 5],
                    view_uniform_len: input_cmds[cursor + 6],
                    extra_bindings: input_cmds[cursor + 7],
                    override_shader: input_cmds[cursor + 8],
                    view_slot_mode: input_cmds[cursor + 9],
                    pass_attachment_id: (input_cmds[cursor + 10] & 0xFFFF) as u16,
                };
                emit_draw_renderers(
                    scene,
                    cull,
                    &args,
                    pso_table,
                    arena,
                    out_phys_cmds,
                    out_submitted_bitmap,
                    out_instance_rows,
                    &mut draw_stats,
                );
            }
            CMD_DRAW_FULLSCREEN => {
                if word_len < 5 {
                    return Err(PlanError::MalformedStream);
                }
                out_phys_cmds.push(cmd_header(PHYS_DRAW_FULLSCREEN, 5));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 5]);
                draw_stats.submitted_draws += 1;
            }
            CMD_DRAW_MESH => {
                if word_len < 6 {
                    return Err(PlanError::MalformedStream);
                }
                // Lower single mesh draw to direct VB/IB/DrawIndexed
                let mesh_id = input_cmds[cursor + 1];
                let material_id = input_cmds[cursor + 2];
                let _transform_off = input_cmds[cursor + 3];
                let pass_tag = (input_cmds[cursor + 4] & 0xFF) as u8;
                let pass_att_id = (input_cmds[cursor + 5] & 0xFFFF) as u16;
                if let (Ok(mesh), Ok(mat)) =
                    (scene.meshes.get(mesh_id), scene.materials.get(material_id))
                {
                    let key = crate::pso::PsoKey::pack(
                        mat.shader_program_id,
                        mesh.vertex_layout_id,
                        pass_att_id,
                        pass_tag,
                        mat.layout_family_id,
                        mat.render_state_bits,
                        mat.variant_flags,
                    );
                    let pso = pso_table.get_or_admit(key, crate::pso::PsoStatus::Ready);
                    let w = pso.key.to_u32x4();
                    out_phys_cmds.push(cmd_header(PHYS_SET_PSO, 6));
                    out_phys_cmds.extend_from_slice(&w);
                    out_phys_cmds.push(pso.slot_id);
                    out_phys_cmds.push(cmd_header(PHYS_SET_BIND_GROUP, 4));
                    out_phys_cmds.push(crate::pso::BGL_SLOT_MATERIAL);
                    out_phys_cmds.push(material_id);
                    out_phys_cmds.push(0);
                    out_phys_cmds.push(cmd_header(PHYS_SET_VB, 4));
                    out_phys_cmds.push(0);
                    out_phys_cmds.push(mesh_id);
                    out_phys_cmds.push(0);
                    if mesh.index_count > 0 {
                        out_phys_cmds.push(cmd_header(PHYS_SET_IB, 4));
                        out_phys_cmds.push(mesh_id);
                        out_phys_cmds.push(u32::from(mesh.is_uint32_index));
                        out_phys_cmds.push(0);
                        out_phys_cmds.push(cmd_header(PHYS_DRAW_INDEXED, 6));
                        out_phys_cmds.push(mesh.index_count);
                        out_phys_cmds.push(1);
                        out_phys_cmds.push(0);
                        out_phys_cmds.push(0);
                        out_phys_cmds.push(0);
                    } else {
                        out_phys_cmds.push(cmd_header(PHYS_DRAW, 5));
                        out_phys_cmds.push(mesh.vertex_count);
                        out_phys_cmds.push(1);
                        out_phys_cmds.push(0);
                        out_phys_cmds.push(0);
                    }
                    draw_stats.submitted_draws += 1;
                }
            }
            CMD_END_RENDER_PASS => {
                let end_pos = out_phys_cmds.len();
                out_phys_cmds.push(cmd_header(PHYS_END_RENDER_PASS, 1));
                if let Some((ref mut pos, _)) = last_pass_sig {
                    *pos = end_pos;
                }
            }
            CMD_SET_VIEWPORT => {
                if word_len < 7 {
                    return Err(PlanError::MalformedStream);
                }
                out_phys_cmds.push(cmd_header(PHYS_SET_VIEWPORT, 7));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 7]);
            }
            CMD_SET_SCISSOR => {
                if word_len < 5 {
                    return Err(PlanError::MalformedStream);
                }
                out_phys_cmds.push(cmd_header(PHYS_SET_SCISSOR, 5));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 5]);
            }
            CMD_BEGIN_COMPUTE_PASS => {
                last_pass_sig = None;
                stats.submitted_pass_count += 1;
                out_phys_cmds.push(cmd_header(PHYS_BEGIN_COMPUTE_PASS, 2));
                out_phys_cmds.push(input_cmds[cursor + 1]);
            }
            CMD_DISPATCH => {
                out_phys_cmds.push(cmd_header(PHYS_DISPATCH, 8));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 8]);
                draw_stats.submitted_draws += 1;
            }
            CMD_DISPATCH_INDIRECT => {
                out_phys_cmds.push(cmd_header(PHYS_DISPATCH_INDIRECT, 5));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 5]);
                draw_stats.submitted_indirect += 1;
            }
            CMD_END_COMPUTE_PASS => {
                out_phys_cmds.push(cmd_header(PHYS_END_COMPUTE_PASS, 1));
            }
            CMD_COPY_TEXTURE => {
                last_pass_sig = None;
                out_phys_cmds.push(cmd_header(PHYS_COPY_TEXTURE, 8));
                out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[cursor + 1])?);
                out_phys_cmds.push(input_cmds[cursor + 2]);
                out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[cursor + 3])?);
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 4..cursor + 8]);
            }
            CMD_COPY_BUFFER => {
                last_pass_sig = None;
                out_phys_cmds.push(cmd_header(PHYS_COPY_BUFFER, 6));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 6]);
            }
            CMD_GENERATE_MIPS => {
                last_pass_sig = None;
                out_phys_cmds.push(cmd_header(PHYS_GENERATE_MIPS, 2));
                out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[cursor + 1])?);
            }
            CMD_REQUEST_READBACK => {
                last_pass_sig = None;
                out_phys_cmds.push(cmd_header(PHYS_REQUEST_READBACK, 4));
                out_phys_cmds.push(resolve_tex_handle(&temps, input_cmds[cursor + 1])?);
                out_phys_cmds.push(input_cmds[cursor + 2]);
                out_phys_cmds.push(input_cmds[cursor + 3]);
            }
            // RHI passthrough opcodes
            CMD_RHI_SET_PIPELINE => {
                out_phys_cmds.push(cmd_header(PHYS_SET_PSO, 6));
                out_phys_cmds.extend_from_slice(&[0, 0, 0, 0, input_cmds[cursor + 1]]);
            }
            CMD_RHI_SET_BIND_GROUP => {
                out_phys_cmds.push(cmd_header(PHYS_SET_BIND_GROUP, word_len as u16));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + word_len]);
            }
            CMD_RHI_SET_VB => {
                out_phys_cmds.push(cmd_header(PHYS_SET_VB, 4));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 4]);
            }
            CMD_RHI_SET_IB => {
                out_phys_cmds.push(cmd_header(PHYS_SET_IB, 4));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 4]);
            }
            CMD_RHI_DRAW => {
                out_phys_cmds.push(cmd_header(PHYS_DRAW, 5));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 5]);
                draw_stats.submitted_draws += 1;
            }
            CMD_RHI_DRAW_INDEXED => {
                out_phys_cmds.push(cmd_header(PHYS_DRAW_INDEXED, 6));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 6]);
                draw_stats.submitted_draws += 1;
            }
            CMD_RHI_DRAW_INDIRECT => {
                out_phys_cmds.push(cmd_header(PHYS_DRAW_INDIRECT, 3));
                out_phys_cmds.extend_from_slice(&input_cmds[cursor + 1..cursor + 3]);
                draw_stats.submitted_indirect += 1;
            }
            CMD_SET_SHADER_PIPELINE => {
                if word_len < 5 {
                    return Err(PlanError::MalformedStream);
                }
                let shader_id = input_cmds[cursor + 1];
                let render_state_bits = input_cmds[cursor + 2];
                let pass_att_id = (input_cmds[cursor + 3] & 0xFFFF) as u16;
                let vertex_layout_id = (input_cmds[cursor + 4] & 0xFFFF) as u16;
                let key = crate::pso::PsoKey::pack(
                    shader_id,
                    vertex_layout_id,
                    pass_att_id,
                    0,
                    0,
                    render_state_bits,
                    0,
                );
                let pso = pso_table.get_or_admit(key, crate::pso::PsoStatus::Ready);
                let w = pso.key.to_u32x4();
                out_phys_cmds.push(cmd_header(PHYS_SET_PSO, 6));
                out_phys_cmds.extend_from_slice(&w);
                out_phys_cmds.push(pso.slot_id);
            }
            _ => return Err(PlanError::MalformedStream),
        }

        cursor += word_len;
    }

    // Retire idle transient pool textures after TTL frames
    let mut retired = Vec::new();
    pool.retire_idle(frame_id, &mut retired);
    for slot_id in retired {
        out_phys_cmds.push(cmd_header(PHYS_RETIRE_POOL_TEX, 2));
        out_phys_cmds.push(slot_id);
    }

    stats.submitted_draw_count = draw_stats.submitted_draws;
    stats.submitted_indirect_count = draw_stats.submitted_indirect;
    stats.pending_pipeline_count = draw_stats.pending_pipelines;
    stats.first_missing_object_id = draw_stats.first_missing_object_id;
    stats.first_missing_submesh = draw_stats.first_missing_submesh;
    stats.pool_texture_count = pool.active_count() as u32;
    Ok(stats)
}
