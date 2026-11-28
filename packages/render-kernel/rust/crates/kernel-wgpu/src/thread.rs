//! Dedicated OS render thread owning both `RenderKernelCore` and `WgpuKernelExecutor`.
//! Supports deterministic synchronous calls and non-blocking bounded-in-flight async frame
//! pipelining so gameplay / scripting on the host JS thread is never blocked by command
//! planning, culling, or wgpu encoding/submission.

use crate::executor::WgpuKernelExecutor;
use crate::types::{
    NativeBufferDesc, NativeCullRequest, NativeCullSummary, NativeFrameReceipt, NativeKernelError,
    NativeMaterialDesc, NativeMeshDesc, NativeSamplerDesc, NativeShaderProgramDesc,
    NativeTextureDesc, NativeThreadStats,
};
use forgeax_render_kernel_core::cull::CullParams;
use forgeax_render_kernel_core::scene::{MaterialMeta, MeshMeta, SubmeshRange};
use forgeax_render_kernel_core::RenderKernelCore;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Instant;

enum ThreadCmd {
    CreateMesh {
        desc: NativeMeshDesc,
        vertex_bytes: Vec<u8>,
        index_bytes: Option<Vec<u8>>,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    DestroyMesh {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    CreateTexture {
        desc: NativeTextureDesc,
        initial_bytes: Option<Vec<u8>>,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    DestroyTexture {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    CreateDynamicTexture {
        width: u32,
        height: u32,
        format_code: u8,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    UploadDynamicTexture {
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
        reply: mpsc::Sender<Result<bool, NativeKernelError>>,
    },
    DestroyDynamicTexture {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    CreateBuffer {
        desc: NativeBufferDesc,
        initial_bytes: Option<Vec<u8>>,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    WriteBuffer {
        id: u32,
        offset: u64,
        bytes: Vec<u8>,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    DestroyBuffer {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    CreateSampler {
        desc: NativeSamplerDesc,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    DestroySampler {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    RegisterShaderProgram {
        desc: NativeShaderProgramDesc,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    DestroyShaderProgram {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    CreateMaterial {
        desc: NativeMaterialDesc,
        initial_param_bytes: Vec<u8>,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    DestroyMaterial {
        id: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    CommitSceneDelta {
        bytes: Vec<u8>,
        reply: mpsc::Sender<Result<u32, NativeKernelError>>,
    },
    BeginFrame {
        frame_id: u64,
        surface_width: u32,
        surface_height: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    Cull {
        req: NativeCullRequest,
        reply: mpsc::Sender<Result<NativeCullSummary, NativeKernelError>>,
    },
    SubmitFrameSync {
        input_cmds: Vec<u32>,
        uniform_bytes: Vec<u8>,
        reply: mpsc::Sender<Result<NativeFrameReceipt, NativeKernelError>>,
    },
    /// Non-blocking pipelined frame submission: delta + optional culls + plan + wgpu encode/submit
    /// all execute on the dedicated OS render thread while the caller moves on to frame N+1.
    SubmitPipelinedFrameAsync {
        frame_id: u64,
        surface_width: u32,
        surface_height: u32,
        delta_bytes: Option<Vec<u8>>,
        culls: Vec<NativeCullRequest>,
        input_cmds: Vec<u32>,
        uniform_bytes: Vec<u8>,
    },
    ReadbackPoolTexture {
        slot_id: u32,
        reply: mpsc::Sender<Result<(u32, u32, Vec<u8>), NativeKernelError>>,
    },
    ReadbackBuffer {
        buf_id: u32,
        offset: u64,
        size: u64,
        reply: mpsc::Sender<Result<Vec<u8>, NativeKernelError>>,
    },
    ReadbackTicket {
        ticket_id: u32,
        reply: mpsc::Sender<Result<(u32, u32, String, Vec<u8>), NativeKernelError>>,
    },
    Flush {
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    ResizeSurface {
        width: u32,
        height: u32,
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    DetachSurface {
        reply: mpsc::Sender<Result<(), NativeKernelError>>,
    },
    TrimPoolTextures {
        reply: mpsc::Sender<Result<u64, NativeKernelError>>,
    },
    RecoverDevice {
        reply: mpsc::Sender<Result<u64, NativeKernelError>>,
    },
    Shutdown,
}

struct SharedTelemetry {
    submitted_frames: AtomicU64,
    completed_frames: AtomicU64,
    last_completed_frame_id: AtomicU64,
    total_plan_ns: AtomicU64,
    total_encode_submit_ns: AtomicU64,
    last_plan_ns: AtomicU64,
    last_encode_submit_ns: AtomicU64,
    dirty_rows_uploaded: AtomicU64,
    dirty_range_writes: AtomicU64,
    material_uploads: AtomicU64,
    surface_presents: AtomicU64,
    gpu_memory_bytes: AtomicU64,
    pool_memory_bytes: AtomicU64,
    device_generation: AtomicU64,
    recovery_count: AtomicU64,
    surface_format: Option<String>,
    last_async_error: Mutex<Option<String>>,
    adapter_name: String,
    backend_name: String,
}

/// Dedicated OS render thread owning `RenderKernelCore` and `WgpuKernelExecutor`.
/// Uses a bounded `sync_channel` (`max_in_flight`, default 2) to prevent unbounded frame
/// queuing while keeping the host thread completely unblocked during command encoding & submission.
pub struct DedicatedNativeRenderThread {
    tx: mpsc::SyncSender<ThreadCmd>,
    telemetry: Arc<SharedTelemetry>,
    join: Option<thread::JoinHandle<()>>,
}

impl DedicatedNativeRenderThread {
    pub fn spawn_headless(max_in_flight: usize) -> Result<Self, NativeKernelError> {
        let executor = WgpuKernelExecutor::new_headless()?;
        Ok(Self::spawn(executor, max_in_flight))
    }

    pub fn spawn_with_surface(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
        max_in_flight: usize,
    ) -> Result<Self, NativeKernelError> {
        let executor = WgpuKernelExecutor::new_with_surface(instance, surface, width, height)?;
        Ok(Self::spawn(executor, max_in_flight))
    }

    pub fn spawn(mut executor: WgpuKernelExecutor, max_in_flight: usize) -> Self {
        let capacity = max_in_flight.clamp(1, 8);
        // Reserve extra capacity for synchronous control messages alongside pipelined frames.
        let (tx, rx) = mpsc::sync_channel::<ThreadCmd>(capacity + 8);
        let telemetry = Arc::new(SharedTelemetry {
            submitted_frames: AtomicU64::new(0),
            completed_frames: AtomicU64::new(0),
            last_completed_frame_id: AtomicU64::new(0),
            total_plan_ns: AtomicU64::new(0),
            total_encode_submit_ns: AtomicU64::new(0),
            last_plan_ns: AtomicU64::new(0),
            last_encode_submit_ns: AtomicU64::new(0),
            dirty_rows_uploaded: AtomicU64::new(0),
            dirty_range_writes: AtomicU64::new(0),
            material_uploads: AtomicU64::new(0),
            surface_presents: AtomicU64::new(0),
            gpu_memory_bytes: AtomicU64::new(0),
            pool_memory_bytes: AtomicU64::new(0),
            device_generation: AtomicU64::new(executor.device_generation()),
            recovery_count: AtomicU64::new(executor.recovery_count()),
            surface_format: executor.surface_format_name(),
            last_async_error: Mutex::new(None),
            adapter_name: executor.adapter_name.clone(),
            backend_name: executor.backend_name.clone(),
        });
        let tel = Arc::clone(&telemetry);

        let join = thread::Builder::new()
            .name("forgeax-render-kernel-thread".to_owned())
            .spawn(move || {
                let mut core = RenderKernelCore::new();
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        ThreadCmd::CreateMesh {
                            desc,
                            vertex_bytes,
                            index_bytes,
                            reply,
                        } => {
                            let res = core
                                .register_mesh(MeshMeta {
                                    vertex_layout_id: desc.vertex_layout_id as u16,
                                    vertex_count: desc.vertex_count,
                                    index_count: desc.index_count,
                                    is_uint32_index: desc.is_uint32_index,
                                    topology: desc.topology,
                                    submeshes: desc
                                        .submeshes
                                        .iter()
                                        .map(|s| SubmeshRange {
                                            first_index: s.first_index,
                                            index_count: s.index_count,
                                            base_vertex: s.base_vertex,
                                            first_vertex: s.first_vertex,
                                            vertex_count: s.vertex_count,
                                        })
                                        .collect(),
                                })
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.create_mesh(
                                        id,
                                        &desc,
                                        &vertex_bytes,
                                        index_bytes.as_deref(),
                                    );
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroyMesh { id, reply } => {
                            let res = core
                                .destroy_mesh(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_mesh(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::CreateTexture {
                            desc,
                            initial_bytes,
                            reply,
                        } => {
                            let res = core
                                .register_texture(desc.width, desc.height, desc.format_code)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.create_texture(id, &desc, initial_bytes.as_deref());
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroyTexture { id, reply } => {
                            let res = core
                                .destroy_texture(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_texture(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::CreateDynamicTexture {
                            width,
                            height,
                            format_code,
                            reply,
                        } => {
                            let res = core
                                .register_dynamic_texture(width, height, format_code)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.create_dynamic_texture(id, width, height, format_code);
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::UploadDynamicTexture {
                            id,
                            revision,
                            width,
                            height,
                            bytes,
                            reply,
                        } => {
                            let res = core
                                .update_dynamic_texture(id, revision, width, height)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .and_then(|reallocated| {
                                    executor.upload_dynamic_texture(
                                        id,
                                        width,
                                        height,
                                        reallocated,
                                        &bytes,
                                    )?;
                                    Ok(reallocated)
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroyDynamicTexture { id, reply } => {
                            let res = core
                                .destroy_dynamic_texture(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_dynamic_texture(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::CreateBuffer {
                            desc,
                            initial_bytes,
                            reply,
                        } => {
                            let res = core
                                .register_buffer(desc.size)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.create_buffer(id, &desc, initial_bytes.as_deref());
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::WriteBuffer {
                            id,
                            offset,
                            bytes,
                            reply,
                        } => {
                            let res = executor.write_buffer(id, offset, &bytes);
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroyBuffer { id, reply } => {
                            let res = core
                                .destroy_buffer(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_buffer(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::CreateSampler { desc, reply } => {
                            let res = core
                                .register_sampler(0)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.create_sampler(id, &desc);
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroySampler { id, reply } => {
                            let res = core
                                .destroy_sampler(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_sampler(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::RegisterShaderProgram { desc, reply } => {
                            let res = core
                                .register_shader(desc.layout_family_id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.register_shader_program(id, desc);
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroyShaderProgram { id, reply } => {
                            let res = core
                                .destroy_shader(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_shader_program(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::CreateMaterial {
                            desc,
                            initial_param_bytes,
                            reply,
                        } => {
                            let res = core
                                .register_material(MaterialMeta {
                                    shader_program_id: desc.shader_program_id,
                                    layout_family_id: desc.layout_family_id as u16,
                                    render_state_bits: desc.render_state_bits,
                                    variant_flags: desc.variant_flags as u16,
                                    queue: desc.queue,
                                    param_bytes: initial_param_bytes.clone(),
                                    param_dirty: false,
                                    dynamic_tex_refs: Vec::new(),
                                    bind_group_generation: 1,
                                })
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|id| {
                                    executor.create_material(id, &desc, &initial_param_bytes);
                                    id
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::DestroyMaterial { id, reply } => {
                            let res = core
                                .destroy_material(id)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|_| executor.destroy_material(id));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::CommitSceneDelta { bytes, reply } => {
                            let res = core
                                .commit_scene_delta(&bytes)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::BeginFrame {
                            frame_id,
                            surface_width,
                            surface_height,
                            reply,
                        } => {
                            let res = core
                                .begin_frame(frame_id, surface_width, surface_height)
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")));
                            let _ = reply.send(res);
                        }
                        ThreadCmd::Cull { req, reply } => {
                            let res = core
                                .cull(&CullParams {
                                    view_proj: req.view_proj,
                                    camera_pos: req.camera_pos,
                                    layer_mask: req.layer_mask,
                                    flags: req.flags,
                                    lod_bias: req.lod_bias,
                                })
                                .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))
                                .map(|s| NativeCullSummary {
                                    cull_id: s.cull_id,
                                    candidate_count: s.candidate_count,
                                    visible_opaque_count: s.visible_opaque_count,
                                    visible_masked_count: s.visible_masked_count,
                                    visible_transparent_count: s.visible_transparent_count,
                                    visible_shadow_caster_count: s.visible_shadow_caster_count,
                                    visible_bounds_min: s.visible_bounds_min,
                                    visible_bounds_max: s.visible_bounds_max,
                                    visible_lights: s.visible_lights.clone(),
                                });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::SubmitFrameSync {
                            input_cmds,
                            uniform_bytes,
                            reply,
                        } => {
                            let frame_id = core.active_frame_id.unwrap_or(0);
                            let t_plan = Instant::now();
                            let plan_res = core.submit_frame(&input_cmds);
                            let plan_ns = t_plan.elapsed().as_nanos() as u64;
                            let res = match plan_res {
                                Err(e) => Err(NativeKernelError::CoreError(format!("{e:?}"))),
                                Ok(stats) => {
                                    let t_exec = Instant::now();
                                    let sync_stats = executor.sync_scene_gpu_buffers(
                                        &mut core.scene,
                                        &core.draw_instance_rows,
                                    );
                                    let exec_res = executor.execute_physical_stream(
                                        &core.resolved_phys_cmds,
                                        &uniform_bytes,
                                    );
                                    let exec_ns = t_exec.elapsed().as_nanos() as u64;
                                    match exec_res {
                                        Err(e) => Err(e),
                                        Ok(executed_passes) => {
                                            tel.completed_frames.fetch_add(1, Ordering::Relaxed);
                                            tel.last_completed_frame_id
                                                .store(frame_id, Ordering::Relaxed);
                                            tel.total_plan_ns.fetch_add(plan_ns, Ordering::Relaxed);
                                            tel.total_encode_submit_ns
                                                .fetch_add(exec_ns, Ordering::Relaxed);
                                            tel.last_plan_ns.store(plan_ns, Ordering::Relaxed);
                                            tel.last_encode_submit_ns
                                                .store(exec_ns, Ordering::Relaxed);
                                            tel.dirty_rows_uploaded.fetch_add(
                                                sync_stats.dirty_rows_uploaded,
                                                Ordering::Relaxed,
                                            );
                                            tel.dirty_range_writes.fetch_add(
                                                sync_stats.dirty_range_writes,
                                                Ordering::Relaxed,
                                            );
                                            tel.material_uploads.fetch_add(
                                                sync_stats.material_uploads,
                                                Ordering::Relaxed,
                                            );
                                            tel.surface_presents.store(
                                                executor.surface_presents(),
                                                Ordering::Relaxed,
                                            );
                                            tel.gpu_memory_bytes.store(
                                                executor.gpu_memory_bytes(),
                                                Ordering::Relaxed,
                                            );
                                            tel.pool_memory_bytes.store(
                                                executor.pool_memory_bytes(),
                                                Ordering::Relaxed,
                                            );
                                            Ok(NativeFrameReceipt {
                                                frame_id,
                                                scene_revision: core.scene.revision,
                                                submitted_pass_count: stats.submitted_pass_count,
                                                merged_pass_count: stats.merged_pass_count,
                                                submitted_draw_count: stats.submitted_draw_count,
                                                submitted_indirect_count: stats
                                                    .submitted_indirect_count,
                                                pending_pipeline_count: stats
                                                    .pending_pipeline_count,
                                                first_missing_object_id: stats
                                                    .first_missing_object_id,
                                                first_missing_submesh: stats.first_missing_submesh,
                                                pool_texture_count: stats.pool_texture_count,
                                                pool_allocations: stats.pool_allocations,
                                                pool_reuses: stats.pool_reuses,
                                                executed_passes,
                                                plan_us: plan_ns as f64 / 1_000.0,
                                                encode_submit_us: exec_ns as f64 / 1_000.0,
                                                resolved_physical_commands: core
                                                    .resolved_phys_cmds
                                                    .clone(),
                                                submitted_bitmap: core.submitted_bitmap.clone(),
                                            })
                                        }
                                    }
                                }
                            };
                            let _ = reply.send(res);
                        }
                        ThreadCmd::SubmitPipelinedFrameAsync {
                            frame_id,
                            surface_width,
                            surface_height,
                            delta_bytes,
                            culls,
                            input_cmds,
                            uniform_bytes,
                        } => {
                            let t_plan = Instant::now();
                            let prep = (|| -> Result<(), NativeKernelError> {
                                if let Some(delta) = delta_bytes {
                                    if !delta.is_empty() {
                                        core.commit_scene_delta(&delta).map_err(|e| {
                                            NativeKernelError::CoreError(format!("{e:?}"))
                                        })?;
                                    }
                                }
                                core.begin_frame(frame_id, surface_width, surface_height)
                                    .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))?;
                                for req in &culls {
                                    core.cull(&CullParams {
                                        view_proj: req.view_proj,
                                        camera_pos: req.camera_pos,
                                        layer_mask: req.layer_mask,
                                        flags: req.flags,
                                        lod_bias: req.lod_bias,
                                    })
                                    .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))?;
                                }
                                core.submit_frame(&input_cmds)
                                    .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))?;
                                Ok(())
                            })();
                            let plan_ns = t_plan.elapsed().as_nanos() as u64;
                            match prep {
                                Err(err) => {
                                    if let Ok(mut slot) = tel.last_async_error.lock() {
                                        *slot = Some(err.to_string());
                                    }
                                }
                                Ok(()) => {
                                    let t_exec = Instant::now();
                                    let sync_stats = executor.sync_scene_gpu_buffers(
                                        &mut core.scene,
                                        &core.draw_instance_rows,
                                    );
                                    match executor.execute_physical_stream(
                                        &core.resolved_phys_cmds,
                                        &uniform_bytes,
                                    ) {
                                        Err(err) => {
                                            if let Ok(mut slot) = tel.last_async_error.lock() {
                                                *slot = Some(err.to_string());
                                            }
                                        }
                                        Ok(_) => {
                                            let exec_ns = t_exec.elapsed().as_nanos() as u64;
                                            tel.completed_frames.fetch_add(1, Ordering::Relaxed);
                                            tel.last_completed_frame_id
                                                .store(frame_id, Ordering::Relaxed);
                                            tel.total_plan_ns.fetch_add(plan_ns, Ordering::Relaxed);
                                            tel.total_encode_submit_ns
                                                .fetch_add(exec_ns, Ordering::Relaxed);
                                            tel.last_plan_ns.store(plan_ns, Ordering::Relaxed);
                                            tel.last_encode_submit_ns
                                                .store(exec_ns, Ordering::Relaxed);
                                            tel.dirty_rows_uploaded.fetch_add(
                                                sync_stats.dirty_rows_uploaded,
                                                Ordering::Relaxed,
                                            );
                                            tel.dirty_range_writes.fetch_add(
                                                sync_stats.dirty_range_writes,
                                                Ordering::Relaxed,
                                            );
                                            tel.material_uploads.fetch_add(
                                                sync_stats.material_uploads,
                                                Ordering::Relaxed,
                                            );
                                            tel.surface_presents.store(
                                                executor.surface_presents(),
                                                Ordering::Relaxed,
                                            );
                                            tel.gpu_memory_bytes.store(
                                                executor.gpu_memory_bytes(),
                                                Ordering::Relaxed,
                                            );
                                            tel.pool_memory_bytes.store(
                                                executor.pool_memory_bytes(),
                                                Ordering::Relaxed,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        ThreadCmd::ReadbackPoolTexture { slot_id, reply } => {
                            let _ = reply.send(executor.readback_pool_texture(slot_id));
                        }
                        ThreadCmd::ReadbackBuffer {
                            buf_id,
                            offset,
                            size,
                            reply,
                        } => {
                            let _ = reply.send(executor.readback_buffer(buf_id, offset, size));
                        }
                        ThreadCmd::ReadbackTicket { ticket_id, reply } => {
                            let _ = reply.send(executor.readback_ticket(ticket_id));
                        }
                        ThreadCmd::Flush { reply } => {
                            let _ = executor.device.poll(wgpu::PollType::wait_indefinitely());
                            tel.gpu_memory_bytes
                                .store(executor.gpu_memory_bytes(), Ordering::Relaxed);
                            tel.pool_memory_bytes
                                .store(executor.pool_memory_bytes(), Ordering::Relaxed);
                            let err = tel
                                .last_async_error
                                .lock()
                                .ok()
                                .and_then(|mut g| g.take());
                            let res = match err {
                                Some(msg) => Err(NativeKernelError::CoreError(msg)),
                                None => Ok(()),
                            };
                            let _ = reply.send(res);
                        }
                        ThreadCmd::ResizeSurface {
                            width,
                            height,
                            reply,
                        } => {
                            let _ = reply.send(executor.resize_surface(width, height));
                        }
                        ThreadCmd::DetachSurface { reply } => {
                            let _ = executor.device.poll(wgpu::PollType::wait_indefinitely());
                            executor.detach_surface();
                            let _ = reply.send(Ok(()));
                        }
                        ThreadCmd::TrimPoolTextures { reply } => {
                            let freed = executor.trim_pool_textures();
                            tel.gpu_memory_bytes
                                .store(executor.gpu_memory_bytes(), Ordering::Relaxed);
                            tel.pool_memory_bytes
                                .store(executor.pool_memory_bytes(), Ordering::Relaxed);
                            let _ = reply.send(Ok(freed));
                        }
                        ThreadCmd::RecoverDevice { reply } => {
                            let res = executor.recover_device().map(|gen| {
                                core = RenderKernelCore::new();
                                tel.device_generation.store(gen, Ordering::Relaxed);
                                tel.recovery_count
                                    .store(executor.recovery_count(), Ordering::Relaxed);
                                tel.gpu_memory_bytes
                                    .store(executor.gpu_memory_bytes(), Ordering::Relaxed);
                                tel.pool_memory_bytes
                                    .store(executor.pool_memory_bytes(), Ordering::Relaxed);
                                gen
                            });
                            let _ = reply.send(res);
                        }
                        ThreadCmd::Shutdown => break,
                    }
                }
            })
            .expect("spawn forgeax-render-kernel-thread");

        Self {
            tx,
            telemetry,
            join: Some(join),
        }
    }

    fn call<T>(
        &self,
        make: impl FnOnce(mpsc::Sender<Result<T, NativeKernelError>>) -> ThreadCmd,
    ) -> Result<T, NativeKernelError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(make(reply_tx))
            .map_err(|_| NativeKernelError::ChannelClosed)?;
        reply_rx
            .recv()
            .map_err(|_| NativeKernelError::ChannelClosed)?
    }

    pub fn create_mesh(
        &self,
        desc: NativeMeshDesc,
        vertex_bytes: Vec<u8>,
        index_bytes: Option<Vec<u8>>,
    ) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CreateMesh {
            desc,
            vertex_bytes,
            index_bytes,
            reply,
        })
    }

    pub fn destroy_mesh(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroyMesh { id, reply })
    }

    pub fn create_texture(
        &self,
        desc: NativeTextureDesc,
        initial_bytes: Option<Vec<u8>>,
    ) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CreateTexture {
            desc,
            initial_bytes,
            reply,
        })
    }

    pub fn destroy_texture(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroyTexture { id, reply })
    }

    pub fn create_dynamic_texture(
        &self,
        width: u32,
        height: u32,
        format_code: u8,
    ) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CreateDynamicTexture {
            width,
            height,
            format_code,
            reply,
        })
    }

    pub fn upload_dynamic_texture(
        &self,
        id: u32,
        revision: u32,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    ) -> Result<bool, NativeKernelError> {
        self.call(|reply| ThreadCmd::UploadDynamicTexture {
            id,
            revision,
            width,
            height,
            bytes,
            reply,
        })
    }

    pub fn destroy_dynamic_texture(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroyDynamicTexture { id, reply })
    }

    pub fn create_buffer(
        &self,
        desc: NativeBufferDesc,
        initial_bytes: Option<Vec<u8>>,
    ) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CreateBuffer {
            desc,
            initial_bytes,
            reply,
        })
    }

    pub fn write_buffer(&self, id: u32, offset: u64, bytes: Vec<u8>) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::WriteBuffer {
            id,
            offset,
            bytes,
            reply,
        })
    }

    pub fn destroy_buffer(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroyBuffer { id, reply })
    }

    pub fn create_sampler(&self, desc: NativeSamplerDesc) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CreateSampler { desc, reply })
    }

    pub fn destroy_sampler(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroySampler { id, reply })
    }

    pub fn register_shader_program(
        &self,
        desc: NativeShaderProgramDesc,
    ) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::RegisterShaderProgram { desc, reply })
    }

    pub fn destroy_shader_program(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroyShaderProgram { id, reply })
    }

    pub fn create_material(
        &self,
        desc: NativeMaterialDesc,
        initial_param_bytes: Vec<u8>,
    ) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CreateMaterial {
            desc,
            initial_param_bytes,
            reply,
        })
    }

    pub fn destroy_material(&self, id: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DestroyMaterial { id, reply })
    }

    pub fn commit_scene_delta(&self, bytes: Vec<u8>) -> Result<u32, NativeKernelError> {
        self.call(|reply| ThreadCmd::CommitSceneDelta { bytes, reply })
    }

    pub fn begin_frame(
        &self,
        frame_id: u64,
        surface_width: u32,
        surface_height: u32,
    ) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::BeginFrame {
            frame_id,
            surface_width,
            surface_height,
            reply,
        })
    }

    pub fn cull(&self, req: NativeCullRequest) -> Result<NativeCullSummary, NativeKernelError> {
        self.call(|reply| ThreadCmd::Cull { req, reply })
    }

    pub fn submit_frame_sync(
        &self,
        input_cmds: Vec<u32>,
        uniform_bytes: Vec<u8>,
    ) -> Result<NativeFrameReceipt, NativeKernelError> {
        self.telemetry
            .submitted_frames
            .fetch_add(1, Ordering::Relaxed);
        self.call(|reply| ThreadCmd::SubmitFrameSync {
            input_cmds,
            uniform_bytes,
            reply,
        })
    }

    /// Enqueues a complete frame (optional scene delta + culls + frame command stream + uniforms)
    /// onto the dedicated OS render thread without blocking on planning, culling, or wgpu submit.
    pub fn submit_pipelined_frame_async(
        &self,
        frame_id: u64,
        surface_width: u32,
        surface_height: u32,
        delta_bytes: Option<Vec<u8>>,
        culls: Vec<NativeCullRequest>,
        input_cmds: Vec<u32>,
        uniform_bytes: Vec<u8>,
    ) -> Result<u64, NativeKernelError> {
        let submitted = self
            .telemetry
            .submitted_frames
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        self.tx
            .send(ThreadCmd::SubmitPipelinedFrameAsync {
                frame_id,
                surface_width,
                surface_height,
                delta_bytes,
                culls,
                input_cmds,
                uniform_bytes,
            })
            .map_err(|_| NativeKernelError::ChannelClosed)?;
        Ok(submitted)
    }

    pub fn readback_pool_texture(
        &self,
        slot_id: u32,
    ) -> Result<(u32, u32, Vec<u8>), NativeKernelError> {
        self.call(|reply| ThreadCmd::ReadbackPoolTexture { slot_id, reply })
    }

    pub fn readback_buffer(
        &self,
        buf_id: u32,
        offset: u64,
        size: u64,
    ) -> Result<Vec<u8>, NativeKernelError> {
        self.call(|reply| ThreadCmd::ReadbackBuffer {
            buf_id,
            offset,
            size,
            reply,
        })
    }

    pub fn readback_ticket(
        &self,
        ticket_id: u32,
    ) -> Result<(u32, u32, String, Vec<u8>), NativeKernelError> {
        self.call(|reply| ThreadCmd::ReadbackTicket { ticket_id, reply })
    }

    pub fn flush(&self) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::Flush { reply })
    }

    pub fn resize_surface(&self, width: u32, height: u32) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::ResizeSurface {
            width,
            height,
            reply,
        })
    }

    /// Synchronously drains the GPU and drops the attached `wgpu::Surface<'static>` on the
    /// render thread. Callers owning a native `Window` MUST invoke this before dropping the window.
    pub fn detach_surface(&self) -> Result<(), NativeKernelError> {
        self.call(|reply| ThreadCmd::DetachSurface { reply })
    }

    pub fn trim_pool_textures(&self) -> Result<u64, NativeKernelError> {
        self.call(|reply| ThreadCmd::TrimPoolTextures { reply })
    }

    pub fn recover_device(&self) -> Result<u64, NativeKernelError> {
        self.call(|reply| ThreadCmd::RecoverDevice { reply })
    }

    pub fn stats(&self) -> NativeThreadStats {
        let submitted = self.telemetry.submitted_frames.load(Ordering::Relaxed);
        let completed = self.telemetry.completed_frames.load(Ordering::Relaxed);
        NativeThreadStats {
            submitted_frames: submitted,
            completed_frames: completed,
            last_completed_frame_id: self
                .telemetry
                .last_completed_frame_id
                .load(Ordering::Relaxed),
            in_flight_frames: submitted.saturating_sub(completed),
            total_plan_us: self.telemetry.total_plan_ns.load(Ordering::Relaxed) as f64 / 1_000.0,
            total_encode_submit_us: self
                .telemetry
                .total_encode_submit_ns
                .load(Ordering::Relaxed) as f64
                / 1_000.0,
            last_plan_us: self.telemetry.last_plan_ns.load(Ordering::Relaxed) as f64 / 1_000.0,
            last_encode_submit_us: self
                .telemetry
                .last_encode_submit_ns
                .load(Ordering::Relaxed) as f64
                / 1_000.0,
            dirty_rows_uploaded: self.telemetry.dirty_rows_uploaded.load(Ordering::Relaxed),
            dirty_range_writes: self.telemetry.dirty_range_writes.load(Ordering::Relaxed),
            material_uploads: self.telemetry.material_uploads.load(Ordering::Relaxed),
            surface_presents: self.telemetry.surface_presents.load(Ordering::Relaxed),
            gpu_memory_bytes: self.telemetry.gpu_memory_bytes.load(Ordering::Relaxed),
            pool_memory_bytes: self.telemetry.pool_memory_bytes.load(Ordering::Relaxed),
            device_generation: self.telemetry.device_generation.load(Ordering::Relaxed),
            recovery_count: self.telemetry.recovery_count.load(Ordering::Relaxed),
            surface_format: self.telemetry.surface_format.clone(),
            adapter_name: self.telemetry.adapter_name.clone(),
            backend_name: self.telemetry.backend_name.clone(),
        }
    }
}

impl Drop for DedicatedNativeRenderThread {
    fn drop(&mut self) {
        let _ = self.tx.send(ThreadCmd::Shutdown);
        if let Some(h) = self.join.take() {
            let _ = h.join();
        }
    }
}
