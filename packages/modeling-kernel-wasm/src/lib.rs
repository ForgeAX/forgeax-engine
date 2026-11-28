//! Zero-copy C-ABI WASM exports over `forgeax-modeling-kernel`.
//!
//! All data transfers happen directly via raw pointers into WASM linear memory
//! (`exports.memory.buffer`) without serde or JS wrapper allocations.

use std::cell::RefCell;

mod ops_ext;
pub use ops_ext::*;

use forgeax_modeling_kernel::arena::{Arena, Handle};
use forgeax_modeling_kernel::bake::correspond::BakeCorrespondenceData;
use forgeax_modeling_kernel::error::{KernelError, KernelErrorCode};
use forgeax_modeling_kernel::geometry::{
    decode_tangent_frame32, encode_tangent_frame32, AttributeFormat, AttributeKind, BuiltMesh,
    IndexOutput, MeshBuilderState, OutputMode, PrimitiveTopology, SubmeshInput,
};
use forgeax_modeling_kernel::mesh::bvh::{build_gpu_bake_bvh_groups, GpuBakeBvhPack};
use forgeax_modeling_kernel::mesh::{CornerChannelKind, EditMesh};
use forgeax_modeling_kernel::ops::assembly::{
    append_mesh, array_faces, fill_holes, taper_faces, ArrayMode,
};
use forgeax_modeling_kernel::ops::bevel::bevel_edges;
use forgeax_modeling_kernel::ops::boolean::{boolean_op, BooleanOp};
use forgeax_modeling_kernel::ops::primitives::{
    append_box, append_cylinder, append_plane, append_revolve, append_sphere, append_torus,
    mark_edge_flags, rotate_faces, scale_faces, set_material_faces, tag_faces, translate_faces,
    Attribution,
};
use forgeax_modeling_kernel::ops::region::{extrude, inset, RegionMode};
use forgeax_modeling_kernel::ops::subdivide::{subdivide, SubdivisionBoundary, SubdivisionScheme};
use forgeax_modeling_kernel::ops::sweep::{panel_line_plane, sweep_polyline};
use forgeax_modeling_kernel::ops::wave2::{delete_faces, flip_faces, mirror, offset, weld};
use forgeax_modeling_kernel::selector::{decode_fxsl, eval_node, resolve_fxsl};
use forgeax_modeling_kernel::surface::{
    blend, blur_gaussian, gen_brick, gen_brushed, gen_perlin_fbm, gen_wood, gen_worley,
    height_to_normal, invert, levels, BlendMode, ImageBuffer, PbrSurfaceStack, WorleyMode,
};
use forgeax_modeling_kernel::uv::{
    auto_uv, pack_uv_skyline, project_uv, unwrap_uv_lscm, ProjectionMode, SeamSource,
};

struct KernelRuntime {
    builders: Arena<MeshBuilderState>,
    meshes: Arena<EditMesh>,
    images: Arena<ImageBuffer>,
    surfaces: Arena<PbrSurfaceStack>,
    correspondences: Arena<BakeCorrespondenceData>,
    scratch: Vec<u8>,
    last_error_code: u16,
    last_error_field: Vec<u8>,
    last_error_reason: Vec<u8>,
    last_bake_bvh: Option<GpuBakeBvhPack>,
}

impl KernelRuntime {
    fn new() -> Self {
        Self {
            builders: Arena::new(),
            meshes: Arena::new(),
            images: Arena::new(),
            surfaces: Arena::new(),
            correspondences: Arena::new(),
            scratch: vec![0u8; 4096],
            last_error_code: 0,
            last_error_field: Vec::new(),
            last_error_reason: Vec::new(),
            last_bake_bvh: None,
        }
    }

    fn clear_error(&mut self) {
        self.last_error_code = 0;
        self.last_error_field.clear();
        self.last_error_reason.clear();
    }

    fn set_error(&mut self, err: KernelError) {
        self.last_error_code = err.code as u16;
        self.last_error_field.clear();
        self.last_error_field
            .extend_from_slice(err.field.as_bytes());
        self.last_error_reason.clear();
        self.last_error_reason
            .extend_from_slice(err.reason.as_bytes());
    }
}

thread_local! {
    static RT: RefCell<KernelRuntime> = RefCell::new(KernelRuntime::new());
}

#[no_mangle]
pub extern "C" fn mk_scratch_ensure(min_len: u32) -> u32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let target = min_len as usize;
        if rt.scratch.len() < target {
            rt.scratch.resize(target.next_power_of_two(), 0);
        }
        rt.scratch.as_mut_ptr() as u32
    })
}

#[no_mangle]
pub extern "C" fn mk_last_error_code() -> u16 {
    RT.with(|rt| rt.borrow().last_error_code)
}

#[no_mangle]
pub extern "C" fn mk_last_error_field_ptr() -> u32 {
    RT.with(|rt| rt.borrow().last_error_field.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn mk_last_error_field_len() -> u32 {
    RT.with(|rt| rt.borrow().last_error_field.len() as u32)
}

#[no_mangle]
pub extern "C" fn mk_last_error_reason_ptr() -> u32 {
    RT.with(|rt| rt.borrow().last_error_reason.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn mk_last_error_reason_len() -> u32 {
    RT.with(|rt| rt.borrow().last_error_reason.len() as u32)
}

#[no_mangle]
pub extern "C" fn mk_live_builders() -> u32 {
    RT.with(|rt| rt.borrow().builders.live_count() as u32)
}

/// Create a retained MeshBuilder with declared `(kind: u8, format: u8)` pairs at `layout_ptr`.
/// Returns 0 on failure (inspect `mk_last_error_*`).
#[no_mangle]
pub extern "C" fn mk_builder_create(
    layout_ptr: u32,
    pair_count: u32,
    material_slot_count: u32,
    vertex_capacity: u32,
    index_capacity: u32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let bytes = unsafe {
            std::slice::from_raw_parts(layout_ptr as *const u8, (pair_count as usize) * 2)
        };
        let mut declared = Vec::with_capacity(pair_count as usize);
        for i in 0..(pair_count as usize) {
            let Some(kind) = AttributeKind::from_u8(bytes[i * 2]) else {
                rt.set_error(KernelError::invalid_value(
                    "attributes",
                    "unknown attribute kind id",
                ));
                return 0;
            };
            let Some(fmt) = AttributeFormat::from_u8(bytes[i * 2 + 1]) else {
                rt.set_error(KernelError::invalid_value(
                    kind.name(),
                    "unknown attribute format id",
                ));
                return 0;
            };
            declared.push((kind, fmt));
        }
        match MeshBuilderState::new(
            &declared,
            material_slot_count,
            vertex_capacity,
            index_capacity,
        ) {
            Ok(state) => rt.builders.insert(state).0,
            Err(err) => {
                rt.set_error(err);
                0
            }
        }
    })
}

/// Reserve `count` vertices in every staging channel and write each channel's raw byte pointer
/// (pointing at `base_vertex * byte_len`) into `out_ptrs_ptr` as `u32` entries in canonical order.
/// Returns `base_vertex` (>= 0) on success, or `-1` on error.
#[no_mangle]
pub extern "C" fn mk_builder_alloc_verts(handle: u64, count: u32, out_ptrs_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(builder) = rt.builders.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let base = match builder.allocate_vertices(count) {
            Ok(b) => b,
            Err(err) => {
                rt.set_error(err);
                return -1;
            }
        };
        let out_ptrs = unsafe {
            std::slice::from_raw_parts_mut(out_ptrs_ptr as *mut u32, builder.channels.len())
        };
        for (i, ch) in builder.channels.iter_mut().enumerate() {
            let byte_offset = (base as usize) * ch.format.byte_len();
            out_ptrs[i] = unsafe { ch.bytes.as_mut_ptr().add(byte_offset) } as u32;
        }
        base as i32
    })
}

/// Reserve `count` u32 indices and write the starting pointer into `out_ptr` (one `u32`).
/// Returns `index_offset` (>= 0) on success, or `-1` on error.
#[no_mangle]
pub extern "C" fn mk_builder_alloc_indices(handle: u64, count: u32, out_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(builder) = rt.builders.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let offset = match builder.allocate_indices(count) {
            Ok(o) => o,
            Err(err) => {
                rt.set_error(err);
                return -1;
            }
        };
        let ptr = unsafe { builder.indices.as_mut_ptr().add(offset as usize) } as u32;
        unsafe {
            *(out_ptr as *mut u32) = ptr;
        }
        offset as i32
    })
}

/// Validate and rebase section-local indices in-place inside WASM linear memory.
#[no_mangle]
pub extern "C" fn mk_builder_rebase_section(
    handle: u64,
    index_offset: u32,
    index_count: u32,
    base_vertex: u32,
    local_vertex_count: u32,
    section_idx: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(builder) = rt.builders.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match builder.rebase_section_indices(
            index_offset,
            index_count,
            base_vertex,
            local_vertex_count,
            section_idx,
        ) {
            Ok(()) => 0,
            Err(err) => {
                rt.set_error(err);
                -1
            }
        }
    })
}

/// Add a submesh range. `flags` bits: 1=has_index_offset, 2=has_index_count, 4=has_vertex_count, 8=has_material_slot.
#[no_mangle]
pub extern "C" fn mk_builder_add_submesh(
    handle: u64,
    flags: u32,
    index_offset: u32,
    index_count: u32,
    vertex_count: u32,
    topology: u8,
    material_slot: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(topo) = PrimitiveTopology::from_u8(topology) else {
            rt.set_error(KernelError::invalid_value(
                "submeshes.topology",
                "must be a WebGPU primitive topology",
            ));
            return -1;
        };
        let Some(builder) = rt.builders.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        builder.add_submesh(SubmeshInput {
            index_offset: if (flags & 1) != 0 {
                Some(index_offset)
            } else {
                None
            },
            index_count: if (flags & 2) != 0 {
                Some(index_count)
            } else {
                None
            },
            vertex_count: if (flags & 4) != 0 {
                Some(vertex_count)
            } else {
                None
            },
            topology: topo,
            material_slot: if (flags & 8) != 0 {
                Some(material_slot)
            } else {
                None
            },
        });
        0
    })
}

/// Finalize the staged mesh in `output_mode` (0=Separate, 1=Interleaved, 2=InterleavedWithChannels).
#[no_mangle]
pub extern "C" fn mk_builder_build(handle: u64, output_mode: u8) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(mode) = OutputMode::from_u8(output_mode) else {
            rt.set_error(KernelError::new(
                KernelErrorCode::InvalidArgument,
                "outputMode",
                "expected 0 (separate), 1 (interleaved), or 2 (interleaved-with-channels)",
            ));
            return -1;
        };
        let Some(builder) = rt.builders.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match builder.build(mode) {
            Ok(_) => 0,
            Err(err) => {
                rt.set_error(err);
                -1
            }
        }
    })
}

/// Write 16 u32 words to `out_meta_ptr`:
/// [0]=vertexCount, [1]=arrayStride, [2]=layoutMask, [3]=interleavedPtr, [4]=interleavedByteLen,
/// [5]=indexKind(0=none,1=u16,2=u32), [6]=indexPtr, [7]=indexCount,
/// [8]=channelCount, [9]=submeshCount, [10..16]=aabb (6 f32 bits).
#[no_mangle]
pub extern "C" fn mk_builder_built_meta(handle: u64, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(builder) = rt.builders.get(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(built) = builder.last_built.as_ref() else {
            rt.set_error(KernelError::new(
                KernelErrorCode::Precondition,
                "build",
                "builder has not been built yet",
            ));
            return -1;
        };
        let (idx_kind, idx_ptr, idx_count) = match &built.indices {
            IndexOutput::None => (0u32, 0u32, 0u32),
            IndexOutput::U16(v) => (1u32, v.as_ptr() as u32, v.len() as u32),
            IndexOutput::U32(v) => (2u32, v.as_ptr() as u32, v.len() as u32),
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 16) };
        out[0] = built.vertex_count;
        out[1] = built.layout.array_stride as u32;
        out[2] = built.layout.mask;
        out[3] = built.interleaved.as_ptr() as u32;
        out[4] = built.interleaved.len() as u32;
        out[5] = idx_kind;
        out[6] = idx_ptr;
        out[7] = idx_count;
        out[8] = built.channels.len() as u32;
        out[9] = built.submeshes.len() as u32;
        for i in 0..6 {
            out[10 + i] = built.aabb[i].to_bits();
        }
        0
    })
}

/// Write 4 u32 words for built channel `index`: [kind, format, ptr, byteLen].
#[no_mangle]
pub extern "C" fn mk_builder_built_channel_meta(handle: u64, index: u32, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(built) = rt
            .builders
            .get(Handle(handle))
            .and_then(|b| b.last_built.as_ref())
        else {
            return -1;
        };
        let Some(ch) = built.channels.get(index as usize) else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 4) };
        out[0] = ch.kind as u32;
        out[1] = ch.format as u32;
        out[2] = ch.bytes.as_ptr() as u32;
        out[3] = ch.bytes.len() as u32;
        0
    })
}

/// Write 5 u32 words for built submesh `index`: [indexOffset, indexCount, vertexCount, topology, materialSlot].
#[no_mangle]
pub extern "C" fn mk_builder_built_submesh_meta(handle: u64, index: u32, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(built) = rt
            .builders
            .get(Handle(handle))
            .and_then(|b| b.last_built.as_ref())
        else {
            return -1;
        };
        let Some(sub) = built.submeshes.get(index as usize) else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 5) };
        out[0] = sub.index_offset;
        out[1] = sub.index_count;
        out[2] = sub.vertex_count;
        out[3] = sub.topology as u32;
        out[4] = sub.material_slot;
        0
    })
}

/// Write 2 u32 words for built layout entry `index`: [kind, format].
#[no_mangle]
pub extern "C" fn mk_builder_built_layout_entry(handle: u64, index: u32, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(built) = rt
            .builders
            .get(Handle(handle))
            .and_then(|b| b.last_built.as_ref())
        else {
            return -1;
        };
        let Some(entry) = built.layout.entries.get(index as usize) else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 2) };
        out[0] = entry.kind as u32;
        out[1] = entry.format as u32;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_builder_built_layout_len(handle: u64) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(built) = rt
            .builders
            .get(Handle(handle))
            .and_then(|b| b.last_built.as_ref())
        else {
            return -1;
        };
        built.layout.entries.len() as i32
    })
}

#[no_mangle]
pub extern "C" fn mk_builder_dispose(handle: u64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        if rt.builders.remove(Handle(handle)).is_some() {
            0
        } else {
            -1
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_encode_tangent_frame32(
    nx: f32,
    ny: f32,
    nz: f32,
    tx: f32,
    ty: f32,
    tz: f32,
    handedness: f32,
    out_word_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match encode_tangent_frame32(nx, ny, nz, tx, ty, tz, handedness) {
            Ok(word) => {
                unsafe {
                    *(out_word_ptr as *mut u32) = word;
                }
                0
            }
            Err(err) => {
                rt.set_error(err);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_decode_tangent_frame32(word: u32, out_f32_ptr: u32) {
    let vals = decode_tangent_frame32(word);
    let out = unsafe { std::slice::from_raw_parts_mut(out_f32_ptr as *mut f32, 7) };
    out.copy_from_slice(&vals);
}

// ---- Phase 2: EditMesh, FXSL v1 VM, and Modeling Ops C-ABI --------------------------------

fn write_built_meta(built: &BuiltMesh, out_meta_ptr: u32) {
    let (idx_kind, idx_ptr, idx_count) = match &built.indices {
        IndexOutput::None => (0u32, 0u32, 0u32),
        IndexOutput::U16(v) => (1u32, v.as_ptr() as u32, v.len() as u32),
        IndexOutput::U32(v) => (2u32, v.as_ptr() as u32, v.len() as u32),
    };
    let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 16) };
    out[0] = built.vertex_count;
    out[1] = built.layout.array_stride as u32;
    out[2] = built.layout.mask;
    out[3] = built.interleaved.as_ptr() as u32;
    out[4] = built.interleaved.len() as u32;
    out[5] = idx_kind;
    out[6] = idx_ptr;
    out[7] = idx_count;
    out[8] = built.channels.len() as u32;
    out[9] = built.submeshes.len() as u32;
    for i in 0..6 {
        out[10 + i] = built.aabb[i].to_bits();
    }
}

unsafe fn read_utf8(ptr: u32, len: u32) -> Result<String, KernelError> {
    let slice = std::slice::from_raw_parts(ptr as *const u8, len as usize);
    std::str::from_utf8(slice)
        .map(|s| s.to_string())
        .map_err(|_| KernelError::invalid_value("string", "invalid UTF-8"))
}

unsafe fn read_i32_slice<'a>(ptr: u32, count: u32) -> &'a [i32] {
    if count == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr as *const i32, count as usize)
    }
}

#[no_mangle]
pub extern "C" fn mk_live_meshes() -> u32 {
    RT.with(|rt| rt.borrow().meshes.live_count() as u32)
}

#[no_mangle]
pub extern "C" fn mk_mesh_create() -> u64 {
    RT.with(|rt| rt.borrow_mut().meshes.insert(EditMesh::new()).0)
}

#[no_mangle]
pub extern "C" fn mk_mesh_dispose(handle: u64) -> i32 {
    RT.with(|rt| {
        if rt.borrow_mut().meshes.remove(Handle(handle)).is_some() {
            0
        } else {
            -1
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_clone(handle: u64) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(cloned) = rt.meshes.get(Handle(handle)).cloned() else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        rt.meshes.insert(cloned).0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_assign(dst_handle: u64, src_handle: u64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(src_clone) = rt.meshes.get(Handle(src_handle)).cloned() else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(dst) = rt.meshes.get_mut(Handle(dst_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        *dst = src_clone;
        0
    })
}

/// Write 8 u32 words: [vertexCount, faceCount, edgeCount, vertexHW, halfHW, faceHW, topoStamp, shapeStamp].
#[no_mangle]
pub extern "C" fn mk_mesh_counts(handle: u64, out_u32_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(mesh) = rt.meshes.get(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_u32_ptr as *mut u32, 8) };
        out[0] = mesh.vertex_count() as u32;
        out[1] = mesh.face_count() as u32;
        out[2] = mesh.edge_count() as u32;
        out[3] = mesh.vertex_high_water as u32;
        out[4] = mesh.half_high_water as u32;
        out[5] = mesh.face_high_water as u32;
        out[6] = mesh.topology_stamp;
        out[7] = mesh.shape_stamp;
        0
    })
}

/// Write 16 u32 words with direct linear-memory pointers for zero-copy SoA reads:
/// [0]=pos, [1]=vGen, [2]=hVert, [3]=hNext, [4]=hPrev, [5]=hFace, [6]=eFlags,
/// [7]=fHalf, [8]=fLen, [9]=fGen, [10]=fMaterial, [11]=fLabel, [12]=fRole, [13]=fFlags,
/// [14]=fTags, [15]=tagWords.
#[no_mangle]
pub extern "C" fn mk_mesh_soa_ptrs(handle: u64, out_u32_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_u32_ptr as *mut u32, 16) };
        out[0] = m.pos.as_ptr() as u32;
        out[1] = m.v_gen.as_ptr() as u32;
        out[2] = m.h_vert.as_ptr() as u32;
        out[3] = m.h_next.as_ptr() as u32;
        out[4] = m.h_prev.as_ptr() as u32;
        out[5] = m.h_face.as_ptr() as u32;
        out[6] = m.e_flags.as_ptr() as u32;
        out[7] = m.f_half.as_ptr() as u32;
        out[8] = m.f_len.as_ptr() as u32;
        out[9] = m.f_gen.as_ptr() as u32;
        out[10] = m.f_material.as_ptr() as u32;
        out[11] = m.f_label.as_ptr() as u32;
        out[12] = m.f_role.as_ptr() as u32;
        out[13] = m.f_flags.as_ptr() as u32;
        out[14] = m.f_tags.as_ptr() as u32;
        out[15] = m.tag_words as u32;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_add_vertex(handle: u64, x: f64, y: f64, z: f64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match m.add_vertex(x, y, z) {
            Ok(v) => v,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_remove_vertex(handle: u64, v: i32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        m.remove_vertex(v);
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_set_position(handle: u64, v: i32, x: f64, y: f64, z: f64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        m.set_position(v, x, y, z);
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_add_face(
    handle: u64,
    verts_ptr: u32,
    vert_count: u32,
    material: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let verts = unsafe { read_i32_slice(verts_ptr, vert_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match m.add_face(&verts, material) {
            Ok(f) => f,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_remove_face(handle: u64, f: i32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        m.remove_face(f);
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_find_half(handle: u64, a: i32, b: i32) -> i32 {
    RT.with(|rt| {
        rt.borrow()
            .meshes
            .get(Handle(handle))
            .map(|m| m.find_half(a, b))
            .unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_intern_tag(handle: u64, ptr: u32, len: u32, create: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let name = match unsafe { read_utf8(ptr, len) } {
            Ok(s) => s,
            Err(e) => {
                rt.set_error(e);
                return -2;
            }
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -2;
        };
        m.tag_index(&name, create != 0)
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_intern_label(handle: u64, ptr: u32, len: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Ok(name) = (unsafe { read_utf8(ptr, len) }) else {
            return -1;
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            return -1;
        };
        m.name_index_label(&name)
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_intern_role(handle: u64, ptr: u32, len: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Ok(name) = (unsafe { read_utf8(ptr, len) }) else {
            return -1;
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            return -1;
        };
        m.name_index_role(&name)
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_intern_material(handle: u64, ptr: u32, len: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Ok(name) = (unsafe { read_utf8(ptr, len) }) else {
            return -1;
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            return -1;
        };
        m.name_index_material(&name)
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_set_corner(
    handle: u64,
    channel_id: u8,
    h: i32,
    vals_ptr: u32,
    dim: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(kind) = CornerChannelKind::from_id(channel_id) else {
            return -1;
        };
        let vals = unsafe { std::slice::from_raw_parts(vals_ptr as *const f32, dim as usize) };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            return -1;
        };
        if vals.len() < kind.dim() {
            return -1;
        }
        m.set_corner(kind, h, &vals[..kind.dim()]);
        0
    })
}

/// Write 4 u32 words: [dim, valuesPtr, setPtr, halfLen]; returns 0 if present, 1 if absent, -1 on error.
#[no_mangle]
pub extern "C" fn mk_mesh_channel_ptrs(handle: u64, channel_id: u8, out_u32_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(kind) = CornerChannelKind::from_id(channel_id) else {
            return -1;
        };
        let Some(m) = rt.meshes.get(Handle(handle)) else {
            return -1;
        };
        let Some(ch) = m.channels[kind as usize].as_ref() else {
            return 1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_u32_ptr as *mut u32, 4) };
        out[0] = ch.dim as u32;
        out[1] = ch.values.as_ptr() as u32;
        out[2] = ch.set.as_ptr() as u32;
        out[3] = m.half_high_water as u32;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_box(
    handle: u64,
    sx: f64,
    sy: f64,
    sz: f64,
    nx: u32,
    ny: u32,
    nz: u32,
    cx: f64,
    cy: f64,
    cz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_box(
            m,
            [sx, sy, sz],
            [nx, ny, nz],
            [cx, cy, cz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(faces) => faces.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_plane(
    handle: u64,
    w: f64,
    h: f64,
    nx: u32,
    ny: u32,
    cx: f64,
    cy: f64,
    cz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_plane(
            m,
            w,
            h,
            nx,
            ny,
            [cx, cy, cz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(faces) => faces.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

/// Evaluate FXSL v1 bytes on `handle` and write `[ptr, count]` into `out_meta_ptr`.
#[no_mangle]
pub extern "C" fn mk_mesh_eval_fxsl(
    handle: u64,
    bytes_ptr: u32,
    byte_len: u32,
    check_cardinality: u32,
    out_meta_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let bytes =
            unsafe { std::slice::from_raw_parts(bytes_ptr as *const u8, byte_len as usize) }
                .to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let res = if check_cardinality != 0 {
            resolve_fxsl(m, &bytes)
        } else {
            decode_fxsl(&bytes).and_then(|d| eval_node(m, &d.root))
        };
        match res {
            Ok(ids) => {
                m.last_selection = ids;
                let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 2) };
                out[0] = m.last_selection.as_ptr() as u32;
                out[1] = m.last_selection.len() as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_translate(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    dx: f64,
    dy: f64,
    dz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match translate_faces(m, &faces, [dx, dy, dz]) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_scale(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    sx: f64,
    sy: f64,
    sz: f64,
    has_pivot: u32,
    px: f64,
    py: f64,
    pz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let pivot = if has_pivot != 0 {
            Some([px, py, pz])
        } else {
            None
        };
        match scale_faces(m, &faces, [sx, sy, sz], pivot) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_rotate(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    axis: u8,
    degrees: f64,
    has_pivot: u32,
    px: f64,
    py: f64,
    pz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let pivot = if has_pivot != 0 {
            Some([px, py, pz])
        } else {
            None
        };
        match rotate_faces(m, &faces, axis, degrees, pivot) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_tag_faces(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    name_ptr: u32,
    name_len: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let name = match unsafe { read_utf8(name_ptr, name_len) } {
            Ok(s) => s,
            Err(e) => {
                rt.set_error(e);
                return -1;
            }
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match tag_faces(m, &faces, &name) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_set_material(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    slot_ptr: u32,
    slot_len: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let slot = match unsafe { read_utf8(slot_ptr, slot_len) } {
            Ok(s) => s,
            Err(e) => {
                rt.set_error(e);
                return -1;
            }
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match set_material_faces(m, &faces, &slot) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_mark_edges(
    handle: u64,
    edges_ptr: u32,
    edge_count: u32,
    flag: u8,
    enable: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        mark_edge_flags(m, &edges, flag, enable != 0);
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_extrude(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    distance: f64,
    region_mode: u8,
    label: i32,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(mode) = RegionMode::from_u8(region_mode) else {
            rt.set_error(KernelError::invalid_value("region", "invalid region mode"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match extrude(m, &faces, distance, mode, label) {
            Ok((top, side)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = top as u32;
                out[1] = side as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_inset(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    thickness: f64,
    region_mode: u8,
    label: i32,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(mode) = RegionMode::from_u8(region_mode) else {
            rt.set_error(KernelError::invalid_value("region", "invalid region mode"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match inset(m, &faces, thickness, mode, label) {
            Ok((inner, rim)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = inner as u32;
                out[1] = rim as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_subdivide(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    levels: u32,
    scheme: u8,
    boundary: u8,
    crease_sharpness: f64,
    face_budget: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(s) = SubdivisionScheme::from_u8(scheme) else {
            rt.set_error(KernelError::invalid_value(
                "scheme",
                "invalid subdivision scheme",
            ));
            return -1;
        };
        let Some(b) = SubdivisionBoundary::from_u8(boundary) else {
            rt.set_error(KernelError::invalid_value(
                "boundary",
                "invalid subdivision boundary",
            ));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match subdivide(
            m,
            &faces,
            levels,
            s,
            b,
            crease_sharpness,
            face_budget as usize,
        ) {
            Ok(out_faces) => out_faces as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_build_render(handle: u64, output_mode: u8) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(mode) = OutputMode::from_u8(output_mode) else {
            rt.set_error(KernelError::invalid_value(
                "outputMode",
                "invalid output mode",
            ));
            return -1;
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match m.build_render_mesh(mode) {
            Ok(_) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_built_meta(handle: u64, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        let Some(m) = rt.meshes.get(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(built) = m.last_built.as_ref() else {
            rt.set_error(KernelError::precondition(
                "build",
                "mesh has not been built yet",
            ));
            return -1;
        };
        write_built_meta(built, out_meta_ptr);
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_built_channel_meta(handle: u64, index: u32, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(ch) = rt
            .meshes
            .get(Handle(handle))
            .and_then(|m| m.last_built.as_ref())
            .and_then(|b| b.channels.get(index as usize))
        else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 4) };
        out[0] = ch.kind as u32;
        out[1] = ch.format as u32;
        out[2] = ch.bytes.as_ptr() as u32;
        out[3] = ch.bytes.len() as u32;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_built_submesh_meta(handle: u64, index: u32, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(sub) = rt
            .meshes
            .get(Handle(handle))
            .and_then(|m| m.last_built.as_ref())
            .and_then(|b| b.submeshes.get(index as usize))
        else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 5) };
        out[0] = sub.index_offset;
        out[1] = sub.index_count;
        out[2] = sub.vertex_count;
        out[3] = sub.topology as u32;
        out[4] = sub.material_slot;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_built_layout_len(handle: u64) -> i32 {
    RT.with(|rt| {
        rt.borrow()
            .meshes
            .get(Handle(handle))
            .and_then(|m| m.last_built.as_ref())
            .map(|b| b.layout.entries.len() as i32)
            .unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_built_layout_entry(handle: u64, index: u32, out_meta_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(entry) = rt
            .meshes
            .get(Handle(handle))
            .and_then(|m| m.last_built.as_ref())
            .and_then(|b| b.layout.entries.get(index as usize))
        else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_meta_ptr as *mut u32, 2) };
        out[0] = entry.kind as u32;
        out[1] = entry.format as u32;
        0
    })
}

// ---- Phase 3: Wave 2 Ops & UV Pipeline C-ABI ----------------------------------------------

#[no_mangle]
pub extern "C" fn mk_mesh_offset(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    distance: f64,
    region_mode: u8,
    label: i32,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(mode) = RegionMode::from_u8(region_mode) else {
            rt.set_error(KernelError::invalid_value("region", "invalid region mode"));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match offset(m, &faces, distance, mode, label) {
            Ok((top, side)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = top as u32;
                out[1] = side as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_mirror(handle: u64, axis: u8, weld_distance: f64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match mirror(m, axis, weld_distance) {
            Ok(copies) => copies as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_weld(handle: u64, distance: f64, out_counts_ptr: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match weld(m, distance) {
            Ok((merged, collapsed)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = merged as u32;
                out[1] = collapsed as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_flip(handle: u64, faces_ptr: u32, face_count: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match flip_faces(m, &faces) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_delete(handle: u64, faces_ptr: u32, face_count: u32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match delete_faces(m, &faces) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_uv_project(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    mode: u8,
    axis: u8,
    scale: f64,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(proj_mode) = ProjectionMode::from_u8(mode) else {
            rt.set_error(KernelError::invalid_value(
                "mode",
                "invalid UV projection mode",
            ));
            return -1;
        };
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value(
                "channel",
                "invalid corner channel id",
            ));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match project_uv(m, &faces, proj_mode, axis, scale, ch) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_uv_unwrap(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    seam_mode: u8,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(seams) = SeamSource::from_u8(seam_mode) else {
            rt.set_error(KernelError::invalid_value("seams", "invalid seam mode"));
            return -1;
        };
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value(
                "channel",
                "invalid corner channel id",
            ));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match unwrap_uv_lscm(m, &faces, seams, ch) {
            Ok(islands) => islands as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_uv_pack(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    resolution: u32,
    padding_texels: f64,
    normalize_density: u32,
    allow_rotate: u32,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value(
                "channel",
                "invalid corner channel id",
            ));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match pack_uv_skyline(
            m,
            &faces,
            resolution,
            padding_texels,
            normalize_density != 0,
            allow_rotate != 0,
            ch,
        ) {
            Ok(islands) => islands as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Phase 4: Surface ImageBuffer, Mesh-to-Texture Baking, and PBR Surface Stack
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn mk_live_images() -> u32 {
    RT.with(|rt| rt.borrow().images.live_count() as u32)
}

#[no_mangle]
pub extern "C" fn mk_live_surfaces() -> u32 {
    RT.with(|rt| rt.borrow().surfaces.live_count() as u32)
}

#[no_mangle]
pub extern "C" fn mk_img_dispose(handle: u64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        if rt.images.remove(Handle(handle)).is_some() {
            0
        } else {
            -1
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_create(width: u32, height: u32, channels: u8, fill: f32) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match ImageBuffer::new(width, height, channels, fill) {
            Ok(img) => rt.images.insert(img).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

/// Write 5 u32 words: [width, height, channels, dataF32Ptr, dataF32Len].
#[no_mangle]
pub extern "C" fn mk_img_meta(handle: u64, out_u32_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(img) = rt.images.get(Handle(handle)) else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_u32_ptr as *mut u32, 5) };
        out[0] = img.width;
        out[1] = img.height;
        out[2] = img.channels as u32;
        out[3] = img.data.as_ptr() as u32;
        out[4] = img.data.len() as u32;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_img_perlin_fbm(
    width: u32,
    height: u32,
    scale_x: u32,
    scale_y: u32,
    octaves: u32,
    persistence: f32,
    seed: u32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match gen_perlin_fbm(width, height, scale_x, scale_y, octaves, persistence, seed) {
            Ok(img) => rt.images.insert(img).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_worley(
    width: u32,
    height: u32,
    cells_x: u32,
    cells_y: u32,
    jitter: f32,
    mode: u8,
    seed: u32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(wm) = WorleyMode::from_u8(mode) else {
            rt.set_error(KernelError::invalid_value("mode", "invalid worley mode"));
            return 0;
        };
        match gen_worley(width, height, cells_x, cells_y, jitter, wm, seed) {
            Ok(img) => rt.images.insert(img).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_brick(
    width: u32,
    height: u32,
    cols: u32,
    rows: u32,
    mortar: f32,
    bevel: f32,
    stagger: f32,
    seed: u32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match gen_brick(width, height, cols, rows, mortar, bevel, stagger, seed) {
            Ok(img) => rt.images.insert(img).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_brushed(
    width: u32,
    height: u32,
    scale_u: u32,
    scale_v: u32,
    seed: u32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match gen_brushed(width, height, scale_u, scale_v, seed) {
            Ok(img) => rt.images.insert(img).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_wood(width: u32, height: u32, rings: f32, warp: f32, seed: u32) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match gen_wood(width, height, rings, warp, seed) {
            Ok(img) => rt.images.insert(img).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_levels(
    src_handle: u64,
    in_min: f32,
    in_max: f32,
    gamma: f32,
    out_min: f32,
    out_max: f32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(src) = rt.images.get(Handle(src_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        let out = levels(src, in_min, in_max, gamma, out_min, out_max);
        rt.images.insert(out).0
    })
}

#[no_mangle]
pub extern "C" fn mk_img_invert(src_handle: u64) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(src) = rt.images.get(Handle(src_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        let out = invert(src);
        rt.images.insert(out).0
    })
}

#[no_mangle]
pub extern "C" fn mk_img_blur(src_handle: u64, radius: u32) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(src) = rt.images.get(Handle(src_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        let out = blur_gaussian(src, radius);
        rt.images.insert(out).0
    })
}

#[no_mangle]
pub extern "C" fn mk_img_height_to_normal(src_handle: u64, strength: f32) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(src) = rt.images.get(Handle(src_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        match height_to_normal(src, strength) {
            Ok(out) => rt.images.insert(out).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_img_blend(
    base_handle: u64,
    top_handle: u64,
    mask_handle: u64,
    mode: u8,
    opacity: f32,
) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(bm) = BlendMode::from_u8(mode) else {
            rt.set_error(KernelError::invalid_value("mode", "invalid blend mode"));
            return 0;
        };
        let Some(base) = rt.images.get(Handle(base_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        let Some(top) = rt.images.get(Handle(top_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return 0;
        };
        let mask = if mask_handle != 0 {
            match rt.images.get(Handle(mask_handle)) {
                Some(m) => Some(m),
                None => {
                    rt.set_error(KernelError::invalid_handle());
                    return 0;
                }
            }
        } else {
            None
        };
        match blend(base, top, mask, bm, opacity) {
            Ok(out) => rt.images.insert(out).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_surface_create(width: u32, height: u32) -> u64 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        match PbrSurfaceStack::new(width, height) {
            Ok(s) => rt.surfaces.insert(s).0,
            Err(e) => {
                rt.set_error(e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_surface_dispose(handle: u64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        if rt.surfaces.remove(Handle(handle)).is_some() {
            0
        } else {
            -1
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_surface_add_layer(
    surface_handle: u64,
    r: f32,
    g: f32,
    b: f32,
    roughness: f32,
    metallic: f32,
    height_val: f32,
    er: f32,
    eg: f32,
    eb: f32,
    mask_handle: u64,
    height_handle: u64,
    roughness_handle: u64,
    opacity: f32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        // Borrow disjoint arenas cleanly via struct field destructuring
        let KernelRuntime {
            surfaces, images, ..
        } = &mut *rt;
        let Some(surf) = surfaces.get_mut(Handle(surface_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let mask = if mask_handle != 0 {
            match images.get(Handle(mask_handle)) {
                Some(m) => Some(m),
                None => {
                    rt.set_error(KernelError::invalid_handle());
                    return -1;
                }
            }
        } else {
            None
        };
        let height_src = if height_handle != 0 {
            match images.get(Handle(height_handle)) {
                Some(h) => Some(h),
                None => {
                    rt.set_error(KernelError::invalid_handle());
                    return -1;
                }
            }
        } else {
            None
        };
        let roughness_src = if roughness_handle != 0 {
            match images.get(Handle(roughness_handle)) {
                Some(rs) => Some(rs),
                None => {
                    rt.set_error(KernelError::invalid_handle());
                    return -1;
                }
            }
        } else {
            None
        };
        match surf.add_layer(
            [r, g, b],
            roughness,
            metallic,
            height_val,
            [er, eg, eb],
            mask,
            height_src,
            roughness_src,
            opacity,
        ) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_surface_apply_ao(surface_handle: u64, ao_handle: u64, strength: f32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let KernelRuntime {
            surfaces, images, ..
        } = &mut *rt;
        let Some(surf) = surfaces.get_mut(Handle(surface_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(ao_map) = images.get(Handle(ao_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match surf.apply_ao(ao_map, strength) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_surface_apply_base_normal(surface_handle: u64, normal_handle: u64) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let KernelRuntime {
            surfaces, images, ..
        } = &mut *rt;
        let Some(surf) = surfaces.get_mut(Handle(surface_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(norm_map) = images.get(Handle(normal_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match surf.apply_base_normal(norm_map) {
            Ok(()) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_surface_export_pbr(surface_handle: u64, height_normal_strength: f32) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(surf) = rt.surfaces.get_mut(Handle(surface_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match surf.export_standard_pbr(height_normal_strength) {
            Ok(_) => 0,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

/// Write 10 u32 words:
/// [width, height, baseColorPtr, baseColorLen, normalPtr, normalLen, ormPtr, ormLen, emissivePtr, emissiveLen]
#[no_mangle]
pub extern "C" fn mk_surface_export_meta(surface_handle: u64, out_u32_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(surf) = rt.surfaces.get(Handle(surface_handle)) else {
            return -1;
        };
        let Some(pbr) = surf.last_export.as_ref() else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_u32_ptr as *mut u32, 10) };
        out[0] = pbr.width;
        out[1] = pbr.height;
        out[2] = pbr.base_color_rgba8.as_ptr() as u32;
        out[3] = pbr.base_color_rgba8.len() as u32;
        out[4] = pbr.normal_rgba8.as_ptr() as u32;
        out[5] = pbr.normal_rgba8.len() as u32;
        out[6] = pbr.orm_rgba8.as_ptr() as u32;
        out[7] = pbr.orm_rgba8.len() as u32;
        out[8] = if pbr.emissive_rgba8.is_empty() {
            0
        } else {
            pbr.emissive_rgba8.as_ptr() as u32
        };
        out[9] = pbr.emissive_rgba8.len() as u32;
        0
    })
}

// ---------------------------------------------------------------------------
// Phase 5 (Convoy 100% Rust): Primitives, Assembly, Sweep, PanelLine, Bevel, Boolean, AutoUV
// ---------------------------------------------------------------------------

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_cylinder(
    handle: u64,
    radius_top: f64,
    radius_bottom: f64,
    height: f64,
    radial_segments: u32,
    height_segments: u32,
    open_ended: u32,
    cx: f64,
    cy: f64,
    cz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_cylinder(
            m,
            radius_top,
            radius_bottom,
            height,
            radial_segments,
            height_segments,
            open_ended != 0,
            [cx, cy, cz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(f) => f.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_sphere(
    handle: u64,
    radius: f64,
    width_segments: u32,
    height_segments: u32,
    cx: f64,
    cy: f64,
    cz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_sphere(
            m,
            radius,
            width_segments,
            height_segments,
            [cx, cy, cz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(f) => f.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_torus(
    handle: u64,
    radius: f64,
    tube: f64,
    radial_segments: u32,
    tubular_segments: u32,
    angle_deg: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_torus(
            m,
            radius,
            tube,
            radial_segments,
            tubular_segments,
            angle_deg,
            [cx, cy, cz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(f) => f.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_revolve(
    handle: u64,
    pts_f64_ptr: u32,
    pt_count: u32,
    segments: u32,
    angle_deg: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let raw = unsafe {
            std::slice::from_raw_parts(pts_f64_ptr as *const f64, (pt_count as usize) * 2)
        };
        let pts: Vec<[f64; 2]> = raw.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_revolve(
            m,
            &pts,
            segments,
            angle_deg,
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(f) => f.len() as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_append(
    dst_handle: u64,
    src_handle: u64,
    tx: f64,
    ty: f64,
    tz: f64,
    label: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        if dst_handle == src_handle {
            rt.set_error(KernelError::invalid_value(
                "source",
                "cannot append mesh onto itself",
            ));
            return -1;
        }
        let Some(src_clone) = rt.meshes.get(Handle(src_handle)).cloned() else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(dst) = rt.meshes.get_mut(Handle(dst_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match append_mesh(
            dst,
            &src_clone,
            [tx, ty, tz],
            Attribution {
                label,
                material: 0,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_array(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    kind: u8, // 0=linear, 1=radial
    count: u32,
    vx: f64,
    vy: f64,
    vz: f64,
    angle_deg: f64,
    cx: f64,
    cy: f64,
    cz: f64,
    prefix_ptr: u32,
    prefix_len: u32,
    label: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let prefix = match unsafe { read_utf8(prefix_ptr, prefix_len) } {
            Ok(s) => s,
            Err(e) => {
                rt.set_error(e);
                return -1;
            }
        };
        let mode = if kind == 0 {
            ArrayMode::Linear {
                count,
                offset: [vx, vy, vz],
            }
        } else {
            ArrayMode::Radial {
                count,
                axis: [vx, vy, vz],
                angle_deg,
                center: [cx, cy, cz],
            }
        };
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match array_faces(
            m,
            &faces,
            mode,
            &prefix,
            Attribution {
                label,
                material: 0,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_fill_holes(
    handle: u64,
    edges_ptr: u32,
    edge_count: u32,
    material: i32, // < 0 means infer from rim
    label: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let mat_opt = if material < 0 { None } else { Some(material) };
        match fill_holes(
            m,
            &edges,
            mat_opt,
            Attribution {
                label,
                material: 0,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_taper(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    axis: u8,
    factor: f64,
    axes_mask: u8,
    has_range: u32,
    r0: f64,
    r1: f64,
    has_origin: u32,
    ox: f64,
    oy: f64,
    oz: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let range = if has_range != 0 { Some([r0, r1]) } else { None };
        let origin = if has_origin != 0 {
            Some([ox, oy, oz])
        } else {
            None
        };
        match taper_faces(m, &faces, axis, factor, axes_mask, range, origin) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_sweep_polyline(
    handle: u64,
    profile_f64_ptr: u32,
    profile_count: u32,
    path_f64_ptr: u32,
    path_count: u32,
    caps: u32,
    sharp_angle_deg: f64,
    ux: f64,
    uy: f64,
    uz: f64,
    label: i32,
    material: i32,
    tag: i32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let prof_raw = unsafe {
            std::slice::from_raw_parts(profile_f64_ptr as *const f64, (profile_count as usize) * 2)
        };
        let path_raw = unsafe {
            std::slice::from_raw_parts(path_f64_ptr as *const f64, (path_count as usize) * 3)
        };
        let profile: Vec<[f64; 2]> = prof_raw.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let path: Vec<[f64; 3]> = path_raw
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match sweep_polyline(
            m,
            &profile,
            &path,
            caps != 0,
            sharp_angle_deg,
            [ux, uy, uz],
            Attribution {
                label,
                material,
                tag,
            },
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_panel_line_plane(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    px: f64,
    py: f64,
    pz: f64,
    nx: f64,
    ny: f64,
    nz: f64,
    width: f64,
    depth: f64,
    material: i32,
    label: i32,
    tag: i32,
    tolerance: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let mat_opt = if material < 0 { None } else { Some(material) };
        match panel_line_plane(
            m,
            &faces,
            [px, py, pz],
            [nx, ny, nz],
            width,
            depth,
            mat_opt,
            Attribution {
                label,
                material: 0,
                tag,
            },
            tolerance,
        ) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_bevel(
    handle: u64,
    edges_ptr: u32,
    edge_count: u32,
    width: f64,
    segments: u32,
    material: i32,
    label: i32,
    tag: i32,
    out_counts_ptr: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let edges = unsafe { read_i32_slice(edges_ptr, edge_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let mat_opt = if material < 0 { None } else { Some(material) };
        match bevel_edges(
            m,
            &edges,
            width,
            segments,
            mat_opt,
            Attribution {
                label,
                material: 0,
                tag,
            },
        ) {
            Ok((bevels, corners)) => {
                let out = unsafe { std::slice::from_raw_parts_mut(out_counts_ptr as *mut u32, 2) };
                out[0] = bevels as u32;
                out[1] = corners as u32;
                0
            }
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn mk_mesh_boolean(
    target_handle: u64,
    tool_handle: u64,
    op_id: u8,
    eps: f64,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(op) = BooleanOp::from_u8(op_id) else {
            rt.set_error(KernelError::invalid_value("op", "invalid boolean op id"));
            return -1;
        };
        let Some(tool_clone) = rt.meshes.get(Handle(tool_handle)).cloned() else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        let Some(target) = rt.meshes.get_mut(Handle(target_handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match boolean_op(target, &tool_clone, op, eps) {
            Ok(n) => n as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_mesh_uv_auto(
    handle: u64,
    faces_ptr: u32,
    face_count: u32,
    max_normal_dev_deg: f64,
    respect_sharp: u32,
    resolution: u32,
    padding_texels: f64,
    allow_rotate: u32,
    channel_id: u8,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let Some(ch) = CornerChannelKind::from_id(channel_id) else {
            rt.set_error(KernelError::invalid_value(
                "channel",
                "invalid corner channel id",
            ));
            return -1;
        };
        let faces = unsafe { read_i32_slice(faces_ptr, face_count) }.to_vec();
        let Some(m) = rt.meshes.get_mut(Handle(handle)) else {
            rt.set_error(KernelError::invalid_handle());
            return -1;
        };
        match auto_uv(
            m,
            &faces,
            max_normal_dev_deg,
            respect_sharp != 0,
            resolution,
            padding_texels,
            allow_rotate != 0,
            ch,
        ) {
            Ok(charts) => charts as i32,
            Err(e) => {
                rt.set_error(e);
                -1
            }
        }
    })
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_bake_build_bvh_groups(
    pos_ptr: u32,
    pos_len: u32,
    norm_ptr: u32,
    norm_len: u32,
    idx_ptr: u32,
    idx_len: u32,
    slots_ptr: u32,
    slots_len: u32,
    floater_ptr: u32,
    floater_len: u32,
    stray_ptr: u32,
    stray_len: u32,
    group_tris_ptr: u32,
    group_tris_len: u32,
    group_ranges_ptr: u32,
    group_ranges_len: u32,
) -> i32 {
    RT.with(|rt| {
        let mut rt = rt.borrow_mut();
        rt.clear_error();
        let positions =
            unsafe { std::slice::from_raw_parts(pos_ptr as *const f32, pos_len as usize) };
        let normals =
            unsafe { std::slice::from_raw_parts(norm_ptr as *const f32, norm_len as usize) };
        let indices =
            unsafe { std::slice::from_raw_parts(idx_ptr as *const u32, idx_len as usize) };
        let slots =
            unsafe { std::slice::from_raw_parts(slots_ptr as *const i32, slots_len as usize) };
        let floater =
            unsafe { std::slice::from_raw_parts(floater_ptr as *const u8, floater_len as usize) };
        let stray =
            unsafe { std::slice::from_raw_parts(stray_ptr as *const u8, stray_len as usize) };
        let group_tris = unsafe {
            std::slice::from_raw_parts(group_tris_ptr as *const u32, group_tris_len as usize)
        };
        let group_ranges = unsafe {
            std::slice::from_raw_parts(group_ranges_ptr as *const u32, group_ranges_len as usize)
        };
        let pack = build_gpu_bake_bvh_groups(
            positions,
            normals,
            indices,
            slots,
            floater,
            stray,
            group_tris,
            group_ranges,
        );
        rt.last_bake_bvh = Some(pack);
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_bake_bvh_meta(out_u32_ptr: u32) -> i32 {
    RT.with(|rt| {
        let rt = rt.borrow();
        let Some(pack) = rt.last_bake_bvh.as_ref() else {
            return -1;
        };
        let out = unsafe { std::slice::from_raw_parts_mut(out_u32_ptr as *mut u32, 8) };
        out[0] = pack.nodes.as_ptr() as u32;
        out[1] = pack.nodes.len() as u32;
        out[2] = pack.tris.as_ptr() as u32;
        out[3] = pack.tris.len() as u32;
        out[4] = pack.tri_normals.as_ptr() as u32;
        out[5] = pack.tri_normals.len() as u32;
        out[6] = pack.group_roots.as_ptr() as u32;
        out[7] = pack.group_roots.len() as u32;
        0
    })
}

#[no_mangle]
pub extern "C" fn mk_bake_bvh_clear() {
    RT.with(|rt| {
        rt.borrow_mut().last_bake_bvh = None;
    });
}
