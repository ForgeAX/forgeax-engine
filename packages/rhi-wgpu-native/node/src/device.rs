//! `NativeDevice`: the per-device resource table, descriptor lowering, and command replay.

use crate::desc::{self, Command, Id};
use crate::errors::{ErrorKind, ErrorSink};
use crate::limits;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

pub(crate) struct BlasEntry {
    raw: wgpu::Blas,
    sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor>,
}

pub(crate) enum Res {
    Buffer(wgpu::Buffer),
    Texture(wgpu::Texture),
    View(wgpu::TextureView),
    Sampler(wgpu::Sampler),
    Shader(wgpu::ShaderModule),
    Bgl(wgpu::BindGroupLayout),
    PipelineLayout(wgpu::PipelineLayout),
    BindGroup(wgpu::BindGroup),
    RenderPipeline(wgpu::RenderPipeline),
    ComputePipeline(wgpu::ComputePipeline),
    QuerySet(wgpu::QuerySet),
    CommandBuffer(RefCell<Option<wgpu::CommandBuffer>>),
    Bundle(wgpu::RenderBundle),
    Blas(BlasEntry),
    Tlas(RefCell<wgpu::Tlas>),
}

type Table = HashMap<Id, Res>;
type Fallible<T> = std::result::Result<T, String>;

macro_rules! getter {
    ($name:ident, $variant:ident, $ty:ty, $what:literal) => {
        fn $name(table: &Table, id: Id) -> Fallible<&$ty> {
            match table.get(&id) {
                Some(Res::$variant(value)) => Ok(value),
                _ => Err(format!(concat!("invalid ", $what, " (id {})"), id)),
            }
        }
    };
}

getter!(buffer, Buffer, wgpu::Buffer, "GPUBuffer");
getter!(texture, Texture, wgpu::Texture, "GPUTexture");
getter!(view, View, wgpu::TextureView, "GPUTextureView");
getter!(sampler, Sampler, wgpu::Sampler, "GPUSampler");
getter!(shader, Shader, wgpu::ShaderModule, "GPUShaderModule");
getter!(bgl, Bgl, wgpu::BindGroupLayout, "GPUBindGroupLayout");
getter!(
    pipeline_layout,
    PipelineLayout,
    wgpu::PipelineLayout,
    "GPUPipelineLayout"
);
getter!(bind_group, BindGroup, wgpu::BindGroup, "GPUBindGroup");
getter!(
    render_pipeline,
    RenderPipeline,
    wgpu::RenderPipeline,
    "GPURenderPipeline"
);
getter!(
    compute_pipeline,
    ComputePipeline,
    wgpu::ComputePipeline,
    "GPUComputePipeline"
);
getter!(query_set, QuerySet, wgpu::QuerySet, "GPUQuerySet");
getter!(bundle, Bundle, wgpu::RenderBundle, "GPURenderBundle");
getter!(blas, Blas, BlasEntry, "BLAS");
getter!(tlas, Tlas, RefCell<wgpu::Tlas>, "TLAS");

fn parse<T: serde::de::DeserializeOwned>(json: &str, what: &str) -> Fallible<T> {
    serde_json::from_str(json).map_err(|e| format!("malformed {what}: {e}"))
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_else(|| "wgpu panicked".to_owned())
}

fn texture_usages(bits: u32) -> Fallible<wgpu::TextureUsages> {
    wgpu::TextureUsages::from_bits(bits).ok_or_else(|| format!("invalid texture usage {bits:#x}"))
}

fn as_flags(
    preference: Option<&str>,
    update_mode: Option<&str>,
) -> Fallible<(
    wgpu::AccelerationStructureFlags,
    wgpu::AccelerationStructureUpdateMode,
)> {
    let mut flags = match preference.unwrap_or("fast-trace") {
        "fast-trace" => wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        "fast-build" => wgpu::AccelerationStructureFlags::PREFER_FAST_BUILD,
        other => {
            return Err(format!(
                "unknown acceleration-structure preference '{other}'"
            ))
        }
    };
    let mode = match update_mode.unwrap_or("rebuild") {
        "rebuild" => wgpu::AccelerationStructureUpdateMode::Build,
        "refit" => {
            flags |= wgpu::AccelerationStructureFlags::ALLOW_UPDATE;
            wgpu::AccelerationStructureUpdateMode::PreferUpdate
        }
        other => {
            return Err(format!(
                "unknown acceleration-structure updateMode '{other}'"
            ))
        }
    };
    Ok((flags, mode))
}

fn load_op<V>(op: Option<&str>, clear: V) -> Fallible<Option<wgpu::LoadOp<V>>> {
    match op {
        None => Ok(None),
        Some("load") => Ok(Some(wgpu::LoadOp::Load)),
        Some("clear") => Ok(Some(wgpu::LoadOp::Clear(clear))),
        Some(other) => Err(format!("unknown GPULoadOp '{other}'")),
    }
}

fn store_op(op: Option<&str>) -> Fallible<wgpu::StoreOp> {
    match op {
        None | Some("store") => Ok(wgpu::StoreOp::Store),
        Some("discard") => Ok(wgpu::StoreOp::Discard),
        Some(other) => Err(format!("unknown GPUStoreOp '{other}'")),
    }
}

fn copy_texture<'a>(
    table: &'a Table,
    t: &desc::TexelCopyTexture,
) -> Fallible<wgpu::TexelCopyTextureInfo<'a>> {
    Ok(wgpu::TexelCopyTextureInfo {
        texture: texture(table, t.texture)?,
        mip_level: t.mip_level,
        origin: t.origin.into(),
        aspect: t.aspect.unwrap_or(wgpu::TextureAspect::All),
    })
}

fn copy_buffer<'a>(
    table: &'a Table,
    b: &desc::TexelCopyBuffer,
) -> Fallible<wgpu::TexelCopyBufferInfo<'a>> {
    Ok(wgpu::TexelCopyBufferInfo {
        buffer: buffer(table, b.buffer)?,
        layout: wgpu::TexelCopyBufferLayout {
            offset: b.offset,
            bytes_per_row: b.bytes_per_row,
            rows_per_image: b.rows_per_image,
        },
    })
}

fn buffer_slice(buffer: &wgpu::Buffer, offset: u64, size: Option<u64>) -> wgpu::BufferSlice<'_> {
    match size {
        Some(size) => buffer.slice(offset..offset + size),
        None => buffer.slice(offset..),
    }
}

fn color(c: [f64; 4]) -> wgpu::Color {
    wgpu::Color {
        r: c[0],
        g: c[1],
        b: c[2],
        a: c[3],
    }
}

/// Draw-family commands shared by render passes and render bundles.
macro_rules! render_command {
    ($target:expr, $table:expr, $cmd:expr) => {{
        let table: &Table = $table;
        match $cmd {
            Command::SetPipeline { id } => $target.set_pipeline(render_pipeline(table, *id)?),
            Command::SetBindGroup { index, id, offsets } => match id {
                Some(id) => $target.set_bind_group(*index, bind_group(table, *id)?, offsets),
                None => $target.set_bind_group(*index, None, &[]),
            },
            Command::SetVertexBuffer {
                slot,
                id,
                offset,
                size,
            } => {
                if let Some(id) = id {
                    $target.set_vertex_buffer(
                        *slot,
                        buffer_slice(buffer(table, *id)?, *offset, *size),
                    );
                }
            }
            Command::SetIndexBuffer {
                id,
                format,
                offset,
                size,
            } => {
                $target.set_index_buffer(buffer_slice(buffer(table, *id)?, *offset, *size), *format)
            }
            Command::Draw {
                vertex_count,
                instance_count,
                first_vertex,
                first_instance,
            } => $target.draw(
                *first_vertex..first_vertex + vertex_count,
                *first_instance..first_instance + instance_count,
            ),
            Command::DrawIndexed {
                index_count,
                instance_count,
                first_index,
                base_vertex,
                first_instance,
            } => $target.draw_indexed(
                *first_index..first_index + index_count,
                *base_vertex,
                *first_instance..first_instance + instance_count,
            ),
            Command::DrawIndirect { id, offset } => {
                $target.draw_indirect(buffer(table, *id)?, *offset)
            }
            Command::DrawIndexedIndirect { id, offset } => {
                $target.draw_indexed_indirect(buffer(table, *id)?, *offset)
            }
            _ => return Err("command is not valid inside a render pass or bundle".to_owned()),
        }
    }};
}

#[napi]
pub struct NativeDevice {
    device: wgpu::Device,
    queue: wgpu::Queue,
    table: RefCell<Table>,
    next_id: Cell<Id>,
    errors: ErrorSink,
    lost: Arc<Mutex<Option<(String, String)>>>,
}

impl NativeDevice {
    pub(crate) fn surface_device(&self) -> &wgpu::Device {
        &self.device
    }

    pub(crate) fn surface_queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    pub(crate) fn configure_surface(
        &self,
        surface: &wgpu::Surface<'_>,
        config: &wgpu::SurfaceConfiguration,
    ) -> Result<()> {
        let (accepted, errors) = self.errors.capturing(|| {
            self.guard(|| {
                surface.configure(&self.device, config);
                Ok(())
            })
        });
        if accepted.is_none() || !errors.is_empty() {
            return Err(Error::from_reason(format!(
                "native surface configuration failed: {}",
                errors.join("; ")
            )));
        }
        Ok(())
    }

    pub(crate) fn import_surface_texture(&self, texture: wgpu::Texture) -> u32 {
        self.insert(Res::Texture(texture))
    }

    pub(crate) fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let errors = ErrorSink::default();
        errors.install(&device);
        let lost = Arc::new(Mutex::new(None));
        let lost_slot = lost.clone();
        device.set_device_lost_callback(move |reason, message| {
            let reason = match reason {
                wgpu::DeviceLostReason::Destroyed => "destroyed",
                _ => "unknown",
            };
            if let Ok(mut slot) = lost_slot.lock() {
                slot.get_or_insert((reason.to_owned(), message));
            }
        });
        Self {
            device,
            queue,
            table: RefCell::new(HashMap::new()),
            next_id: Cell::new(1),
            errors,
            lost,
        }
    }

    fn insert(&self, res: Res) -> Id {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        self.table.borrow_mut().insert(id, res);
        id
    }

    /// Run `f`; a returned error or a wgpu panic becomes a validation error on this device.
    /// Returns `None` (the invalid-object id 0 at the call sites) on failure.
    fn guard<T>(&self, f: impl FnOnce() -> Fallible<T>) -> Option<T> {
        match catch_unwind(AssertUnwindSafe(f)) {
            Ok(Ok(value)) => Some(value),
            Ok(Err(message)) => {
                self.errors.report(ErrorKind::Validation, message);
                None
            }
            Err(payload) => {
                self.errors
                    .report(ErrorKind::Validation, panic_message(payload));
                None
            }
        }
    }

    fn create(&self, f: impl FnOnce(&Table) -> Fallible<Res>) -> Id {
        let res = {
            let table = self.table.borrow();
            self.guard(|| f(&table))
        };
        res.map_or(0, |res| self.insert(res))
    }

    fn wait(&self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }

    fn bgl_entry(entry: &desc::BglEntry) -> Fallible<wgpu::BindGroupLayoutEntry> {
        let visibility = wgpu::ShaderStages::from_bits(entry.visibility)
            .ok_or_else(|| format!("invalid visibility {:#x}", entry.visibility))?;
        let ty = if let Some(b) = &entry.buffer {
            wgpu::BindingType::Buffer {
                ty: match b.ty.as_deref().unwrap_or("uniform") {
                    "uniform" => wgpu::BufferBindingType::Uniform,
                    "storage" => wgpu::BufferBindingType::Storage { read_only: false },
                    "read-only-storage" => wgpu::BufferBindingType::Storage { read_only: true },
                    other => return Err(format!("unknown GPUBufferBindingType '{other}'")),
                },
                has_dynamic_offset: b.has_dynamic_offset,
                min_binding_size: wgpu::BufferSize::new(b.min_binding_size),
            }
        } else if let Some(s) = &entry.sampler {
            wgpu::BindingType::Sampler(match s.ty.as_deref().unwrap_or("filtering") {
                "filtering" => wgpu::SamplerBindingType::Filtering,
                "non-filtering" => wgpu::SamplerBindingType::NonFiltering,
                "comparison" => wgpu::SamplerBindingType::Comparison,
                other => return Err(format!("unknown GPUSamplerBindingType '{other}'")),
            })
        } else if let Some(t) = &entry.texture {
            wgpu::BindingType::Texture {
                sample_type: match t.sample_type.as_deref().unwrap_or("float") {
                    "float" => wgpu::TextureSampleType::Float { filterable: true },
                    "unfilterable-float" => wgpu::TextureSampleType::Float { filterable: false },
                    "depth" => wgpu::TextureSampleType::Depth,
                    "sint" => wgpu::TextureSampleType::Sint,
                    "uint" => wgpu::TextureSampleType::Uint,
                    other => return Err(format!("unknown GPUTextureSampleType '{other}'")),
                },
                view_dimension: t.view_dimension.unwrap_or(wgpu::TextureViewDimension::D2),
                multisampled: t.multisampled,
            }
        } else if let Some(t) = &entry.storage_texture {
            wgpu::BindingType::StorageTexture {
                access: t.access.unwrap_or(wgpu::StorageTextureAccess::WriteOnly),
                format: t.format,
                view_dimension: t.view_dimension.unwrap_or(wgpu::TextureViewDimension::D2),
            }
        } else if entry.acceleration_structure.is_some() {
            wgpu::BindingType::AccelerationStructure {
                vertex_return: false,
            }
        } else if entry.external_texture.is_some() {
            return Err("externalTexture bindings are not supported by the native device".into());
        } else {
            return Err(format!(
                "bind group layout entry {} has no binding type",
                entry.binding
            ));
        };
        Ok(wgpu::BindGroupLayoutEntry {
            binding: entry.binding,
            visibility,
            ty,
            count: None,
        })
    }

    fn render_pipeline(&self, table: &Table, d: &desc::RenderPipelineDesc) -> Fallible<Res> {
        let layout = d.layout.map(|id| pipeline_layout(table, id)).transpose()?;
        let vertex_constants: Vec<(&str, f64)> = d
            .vertex
            .stage
            .constants
            .iter()
            .map(|(k, v)| (k.as_str(), *v))
            .collect();
        let attributes: Vec<Option<Vec<wgpu::VertexAttribute>>> = d
            .vertex
            .buffers
            .iter()
            .map(|b| {
                b.as_ref().map(|b| {
                    b.attributes
                        .iter()
                        .map(|a| wgpu::VertexAttribute {
                            format: a.format,
                            offset: a.offset,
                            shader_location: a.shader_location,
                        })
                        .collect()
                })
            })
            .collect();
        let buffers: Vec<Option<wgpu::VertexBufferLayout>> = d
            .vertex
            .buffers
            .iter()
            .zip(&attributes)
            .map(|(b, attrs)| {
                b.as_ref()
                    .zip(attrs.as_ref())
                    .map(|(b, attrs)| wgpu::VertexBufferLayout {
                        array_stride: b.array_stride,
                        step_mode: b.step_mode.unwrap_or(wgpu::VertexStepMode::Vertex),
                        attributes: attrs,
                    })
            })
            .collect();
        let fragment_constants: Vec<(&str, f64)> = d
            .fragment
            .as_ref()
            .map(|f| {
                f.stage
                    .constants
                    .iter()
                    .map(|(k, v)| (k.as_str(), *v))
                    .collect()
            })
            .unwrap_or_default();
        let targets: Vec<Option<wgpu::ColorTargetState>> = d
            .fragment
            .as_ref()
            .map(|f| {
                f.targets
                    .iter()
                    .map(|t| {
                        t.as_ref().map(|t| wgpu::ColorTargetState {
                            format: t.format,
                            blend: t.blend.as_ref().map(|b| {
                                let component = |c: &desc::BlendComponent| wgpu::BlendComponent {
                                    src_factor: c.src_factor.unwrap_or(wgpu::BlendFactor::One),
                                    dst_factor: c.dst_factor.unwrap_or(wgpu::BlendFactor::Zero),
                                    operation: c.operation.unwrap_or(wgpu::BlendOperation::Add),
                                };
                                wgpu::BlendState {
                                    color: component(&b.color),
                                    alpha: component(&b.alpha),
                                }
                            }),
                            write_mask: wgpu::ColorWrites::from_bits_truncate(
                                t.write_mask.unwrap_or(0xf),
                            ),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let fragment = match &d.fragment {
            Some(f) => Some(wgpu::FragmentState {
                module: shader(table, f.stage.module)?,
                entry_point: f.stage.entry_point.as_deref(),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &fragment_constants,
                    zero_initialize_workgroup_memory: true,
                },
                targets: &targets,
            }),
            None => None,
        };
        let face = |f: &desc::StencilFace| wgpu::StencilFaceState {
            compare: f.compare.unwrap_or(wgpu::CompareFunction::Always),
            fail_op: f.fail_op.unwrap_or(wgpu::StencilOperation::Keep),
            depth_fail_op: f.depth_fail_op.unwrap_or(wgpu::StencilOperation::Keep),
            pass_op: f.pass_op.unwrap_or(wgpu::StencilOperation::Keep),
        };
        let p = &d.primitive;
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: d.label.as_deref(),
                layout,
                vertex: wgpu::VertexState {
                    module: shader(table, d.vertex.stage.module)?,
                    entry_point: d.vertex.stage.entry_point.as_deref(),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &vertex_constants,
                        zero_initialize_workgroup_memory: true,
                    },
                    buffers: &buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: p.topology.unwrap_or(wgpu::PrimitiveTopology::TriangleList),
                    strip_index_format: p.strip_index_format,
                    front_face: p.front_face.unwrap_or(wgpu::FrontFace::Ccw),
                    cull_mode: match p.cull_mode.as_deref().unwrap_or("none") {
                        "none" => None,
                        "front" => Some(wgpu::Face::Front),
                        "back" => Some(wgpu::Face::Back),
                        other => return Err(format!("unknown GPUCullMode '{other}'")),
                    },
                    unclipped_depth: p.unclipped_depth,
                    polygon_mode: wgpu::PolygonMode::Fill,
                    conservative: false,
                },
                depth_stencil: d.depth_stencil.as_ref().map(|ds| wgpu::DepthStencilState {
                    format: ds.format,
                    depth_write_enabled: ds.depth_write_enabled,
                    depth_compare: ds.depth_compare,
                    stencil: wgpu::StencilState {
                        front: face(&ds.stencil_front),
                        back: face(&ds.stencil_back),
                        read_mask: ds.stencil_read_mask.unwrap_or(0xffff_ffff),
                        write_mask: ds.stencil_write_mask.unwrap_or(0xffff_ffff),
                    },
                    bias: wgpu::DepthBiasState {
                        constant: ds.depth_bias,
                        slope_scale: ds.depth_bias_slope_scale,
                        clamp: ds.depth_bias_clamp,
                    },
                }),
                multisample: wgpu::MultisampleState {
                    count: d.multisample.count.unwrap_or(1),
                    mask: d.multisample.mask.unwrap_or(0xffff_ffff),
                    alpha_to_coverage_enabled: d.multisample.alpha_to_coverage_enabled,
                },
                fragment,
                multiview_mask: None,
                cache: None,
            });
        Ok(Res::RenderPipeline(pipeline))
    }

    fn encode_compute_pass(
        &self,
        table: &Table,
        encoder: &mut wgpu::CommandEncoder,
        d: &desc::ComputePassDesc,
        commands: &mut std::slice::Iter<'_, Command>,
    ) -> Fallible<()> {
        let writes = d
            .timestamp_writes
            .as_ref()
            .map(|w| {
                Ok::<_, String>(wgpu::ComputePassTimestampWrites {
                    query_set: query_set(table, w.query_set)?,
                    beginning_of_pass_write_index: w.beginning_of_pass_write_index,
                    end_of_pass_write_index: w.end_of_pass_write_index,
                })
            })
            .transpose()?;
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: d.label.as_deref(),
            timestamp_writes: writes,
        });
        for cmd in commands.by_ref() {
            match cmd {
                Command::End => return Ok(()),
                Command::SetPipeline { id } => pass.set_pipeline(compute_pipeline(table, *id)?),
                Command::SetBindGroup { index, id, offsets } => match id {
                    Some(id) => pass.set_bind_group(*index, bind_group(table, *id)?, offsets),
                    None => pass.set_bind_group(*index, None, &[]),
                },
                Command::Dispatch { x, y, z } => pass.dispatch_workgroups(*x, *y, *z),
                Command::DispatchIndirect { id, offset } => {
                    pass.dispatch_workgroups_indirect(buffer(table, *id)?, *offset)
                }
                Command::PushDebugGroup { label } => pass.push_debug_group(label),
                Command::PopDebugGroup => pass.pop_debug_group(),
                Command::InsertDebugMarker { label } => pass.insert_debug_marker(label),
                _ => return Err("command is not valid inside a compute pass".to_owned()),
            }
        }
        Err("compute pass was never ended".to_owned())
    }

    fn encode_render_pass(
        &self,
        table: &Table,
        encoder: &mut wgpu::CommandEncoder,
        d: &desc::RenderPassDesc,
        commands: &mut std::slice::Iter<'_, Command>,
    ) -> Fallible<()> {
        let mut colors = Vec::with_capacity(d.color_attachments.len());
        for attachment in &d.color_attachments {
            colors.push(match attachment {
                None => None,
                Some(a) => Some(wgpu::RenderPassColorAttachment {
                    view: view(table, a.view)?,
                    depth_slice: a.depth_slice,
                    resolve_target: a.resolve_target.map(|id| view(table, id)).transpose()?,
                    ops: wgpu::Operations {
                        load: load_op(Some(&a.load_op), color(a.clear_value.unwrap_or_default()))?
                            .unwrap_or(wgpu::LoadOp::Load),
                        store: store_op(Some(&a.store_op))?,
                    },
                }),
            });
        }
        let depth = match &d.depth_stencil_attachment {
            None => None,
            Some(a) => Some(wgpu::RenderPassDepthStencilAttachment {
                view: view(table, a.view)?,
                depth_ops: if a.depth_read_only {
                    None
                } else {
                    load_op(
                        a.depth_load_op.as_deref(),
                        a.depth_clear_value.unwrap_or(0.0),
                    )?
                    .map(|load| -> Fallible<_> {
                        Ok(wgpu::Operations {
                            load,
                            store: store_op(a.depth_store_op.as_deref())?,
                        })
                    })
                    .transpose()?
                },
                stencil_ops: if a.stencil_read_only {
                    None
                } else {
                    load_op(a.stencil_load_op.as_deref(), a.stencil_clear_value)?
                        .map(|load| -> Fallible<_> {
                            Ok(wgpu::Operations {
                                load,
                                store: store_op(a.stencil_store_op.as_deref())?,
                            })
                        })
                        .transpose()?
                },
            }),
        };
        let writes = d
            .timestamp_writes
            .as_ref()
            .map(|w| {
                Ok::<_, String>(wgpu::RenderPassTimestampWrites {
                    query_set: query_set(table, w.query_set)?,
                    beginning_of_pass_write_index: w.beginning_of_pass_write_index,
                    end_of_pass_write_index: w.end_of_pass_write_index,
                })
            })
            .transpose()?;
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: d.label.as_deref(),
            color_attachments: &colors,
            depth_stencil_attachment: depth,
            timestamp_writes: writes,
            occlusion_query_set: d
                .occlusion_query_set
                .map(|id| query_set(table, id))
                .transpose()?,
            multiview_mask: None,
        });
        for cmd in commands.by_ref() {
            match cmd {
                Command::End => return Ok(()),
                Command::SetViewport {
                    x,
                    y,
                    w,
                    h,
                    min,
                    max,
                } => pass.set_viewport(*x, *y, *w, *h, *min, *max),
                Command::SetScissorRect { x, y, w, h } => pass.set_scissor_rect(*x, *y, *w, *h),
                Command::SetBlendConstant { color: c } => pass.set_blend_constant(color(*c)),
                Command::SetStencilReference { reference } => {
                    pass.set_stencil_reference(*reference)
                }
                Command::BeginOcclusionQuery { index } => pass.begin_occlusion_query(*index),
                Command::EndOcclusionQuery => pass.end_occlusion_query(),
                Command::PushDebugGroup { label } => pass.push_debug_group(label),
                Command::PopDebugGroup => pass.pop_debug_group(),
                Command::InsertDebugMarker { label } => pass.insert_debug_marker(label),
                Command::ExecuteBundles { ids } => {
                    let bundles = ids
                        .iter()
                        .map(|id| bundle(table, *id))
                        .collect::<Fallible<Vec<_>>>()?;
                    pass.execute_bundles(bundles);
                }
                other => render_command!(pass, table, other),
            }
        }
        Err("render pass was never ended".to_owned())
    }

    fn build_acceleration_structures(
        &self,
        table: &Table,
        encoder: &mut wgpu::CommandEncoder,
        blas_builds: &[desc::BlasBuild],
        tlas_builds: &[desc::TlasBuild],
    ) -> Fallible<()> {
        let mut blas_entries = Vec::with_capacity(blas_builds.len());
        for build in blas_builds {
            let entry = blas(table, build.blas)?;
            if build.geometries.len() != entry.sizes.len() {
                return Err("BLAS build geometry count differs from its creation".to_owned());
            }
            let mut geometries = Vec::with_capacity(build.geometries.len());
            for (g, size) in build.geometries.iter().zip(&entry.sizes) {
                geometries.push(wgpu::BlasTriangleGeometry {
                    size,
                    vertex_buffer: buffer(table, g.vertex_buffer)?,
                    first_vertex: g.first_vertex,
                    vertex_stride: g.vertex_stride,
                    index_buffer: g.index_buffer.map(|id| buffer(table, id)).transpose()?,
                    first_index: g.index_buffer.map(|_| g.first_index.unwrap_or(0)),
                    transform_buffer: None,
                    transform_buffer_offset: None,
                });
            }
            blas_entries.push(wgpu::BlasBuildEntry {
                blas: &entry.raw,
                geometry: wgpu::BlasGeometries::TriangleGeometries(geometries),
            });
        }
        let mut tlases = Vec::with_capacity(tlas_builds.len());
        for build in tlas_builds {
            let cell = tlas(table, build.tlas)?;
            let mut raw = cell
                .try_borrow_mut()
                .map_err(|_| "TLAS is listed twice in one build".to_owned())?;
            let capacity = raw.get().len();
            if build.instances.len() > capacity {
                return Err(format!(
                    "{} TLAS instances exceed maxInstances {capacity}",
                    build.instances.len()
                ));
            }
            for slot in 0..capacity {
                raw[slot] = match build.instances.get(slot) {
                    None => None,
                    Some(instance) => Some(wgpu::TlasInstance::new(
                        &blas(table, instance.blas)?.raw,
                        instance.transform,
                        instance.custom_index,
                        instance.mask,
                    )),
                };
            }
            drop(raw);
            tlases.push(cell.borrow());
        }
        encoder.build_acceleration_structures(blas_entries.iter(), tlases.iter().map(|t| &**t));
        Ok(())
    }

    fn encode(&self, table: &Table, recording: &desc::EncoderRecording) -> Fallible<Res> {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: recording.label.as_deref(),
            });
        let mut commands = recording.commands.iter();
        while let Some(cmd) = commands.next() {
            match cmd {
                Command::BeginRenderPass(d) => {
                    self.encode_render_pass(table, &mut encoder, d, &mut commands)?
                }
                Command::BeginComputePass(d) => {
                    self.encode_compute_pass(table, &mut encoder, d, &mut commands)?
                }
                Command::CopyBufferToBuffer {
                    source,
                    source_offset,
                    destination,
                    destination_offset,
                    size,
                } => encoder.copy_buffer_to_buffer(
                    buffer(table, *source)?,
                    *source_offset,
                    buffer(table, *destination)?,
                    *destination_offset,
                    *size,
                ),
                Command::CopyBufferToTexture {
                    source,
                    destination,
                    size,
                } => encoder.copy_buffer_to_texture(
                    copy_buffer(table, source)?,
                    copy_texture(table, destination)?,
                    (*size).into(),
                ),
                Command::CopyTextureToBuffer {
                    source,
                    destination,
                    size,
                } => encoder.copy_texture_to_buffer(
                    copy_texture(table, source)?,
                    copy_buffer(table, destination)?,
                    (*size).into(),
                ),
                Command::CopyTextureToTexture {
                    source,
                    destination,
                    size,
                } => encoder.copy_texture_to_texture(
                    copy_texture(table, source)?,
                    copy_texture(table, destination)?,
                    (*size).into(),
                ),
                Command::ClearBuffer { id, offset, size } => {
                    encoder.clear_buffer(buffer(table, *id)?, *offset, *size)
                }
                Command::ResolveQuerySet {
                    query_set: qs,
                    first_query,
                    query_count,
                    destination,
                    destination_offset,
                } => encoder.resolve_query_set(
                    query_set(table, *qs)?,
                    *first_query..first_query + query_count,
                    buffer(table, *destination)?,
                    *destination_offset,
                ),
                Command::PushDebugGroup { label } => encoder.push_debug_group(label),
                Command::PopDebugGroup => encoder.pop_debug_group(),
                Command::InsertDebugMarker { label } => encoder.insert_debug_marker(label),
                Command::BuildAccelerationStructures { blas, tlas } => {
                    self.build_acceleration_structures(table, &mut encoder, blas, tlas)?
                }
                _ => return Err("pass command recorded outside a pass".to_owned()),
            }
        }
        Ok(Res::CommandBuffer(RefCell::new(Some(encoder.finish()))))
    }
}

#[napi]
impl NativeDevice {
    #[napi(catch_unwind)]
    pub fn features(&self) -> Vec<String> {
        limits::feature_names(self.device.features())
    }

    #[napi(catch_unwind)]
    pub fn limits(&self) -> String {
        limits::limits_to_json(&self.device.limits())
    }

    /// Nanoseconds per timestamp tick of the queue.
    #[napi(catch_unwind)]
    pub fn timestamp_period(&self) -> f64 {
        f64::from(self.queue.get_timestamp_period())
    }

    #[napi(catch_unwind)]
    pub fn push_error_scope(&self, filter: String) -> Result<()> {
        let kind = ErrorKind::parse(&filter)
            .ok_or_else(|| Error::from_reason(format!("unknown GPUErrorFilter '{filter}'")))?;
        self.errors.push(kind);
        Ok(())
    }

    /// JSON `{kind, message}` or `null`; an exception when the scope stack is empty.
    #[napi(catch_unwind)]
    pub fn pop_error_scope(&self) -> Result<String> {
        let popped = self
            .errors
            .pop()
            .ok_or_else(|| Error::from_reason("popErrorScope on an empty error scope stack"))?;
        Ok(serde_json::to_string(&popped).unwrap_or_else(|_| "null".to_owned()))
    }

    /// Uncaptured errors since the last drain, as a JSON array of `{kind, message}`.
    #[napi(catch_unwind)]
    pub fn drain_errors(&self) -> String {
        serde_json::to_string(&self.errors.drain()).unwrap_or_else(|_| "[]".to_owned())
    }

    /// `[reason, message]` once the device is lost.
    #[napi(catch_unwind)]
    pub fn lost_info(&self) -> Option<Vec<String>> {
        let lost = self.lost.lock().ok()?;
        lost.as_ref()
            .map(|(reason, message)| vec![reason.clone(), message.clone()])
    }

    #[napi(catch_unwind)]
    pub fn destroy(&self) {
        self.device.destroy();
        self.table.borrow_mut().clear();
    }

    /// Drop the table entry for `id` (JS garbage collection or an explicit destroy).
    #[napi(catch_unwind)]
    pub fn release(&self, id: u32) {
        let removed = self.table.borrow_mut().remove(&id);
        drop(removed);
    }

    #[napi(catch_unwind)]
    pub fn report_validation_error(&self, message: String) {
        self.errors.report(ErrorKind::Validation, message);
    }

    #[napi(catch_unwind)]
    pub fn create_buffer(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::BufferDesc = parse(&descriptor, "GPUBufferDescriptor")?;
            let usage = wgpu::BufferUsages::from_bits(d.usage)
                .ok_or_else(|| format!("invalid buffer usage {:#x}", d.usage))?;
            Ok(Res::Buffer(self.device.create_buffer(
                &wgpu::BufferDescriptor {
                    label: d.label.as_deref(),
                    size: d.size,
                    usage,
                    mapped_at_creation: d.mapped_at_creation,
                },
            )))
        })
    }

    /// Map `[offset, offset+size)` and wait for completion. Returns the failure message, or
    /// `None` on success.
    #[napi(catch_unwind)]
    pub fn buffer_map(&self, id: u32, mode: u32, offset: f64, size: f64) -> Option<String> {
        let table = self.table.borrow();
        let buf = match buffer(&table, id) {
            Ok(buf) => buf.clone(),
            Err(e) => return Some(e),
        };
        drop(table);
        let mode = if mode & 0x1 != 0 {
            wgpu::MapMode::Read
        } else {
            wgpu::MapMode::Write
        };
        let result: Arc<Mutex<Option<std::result::Result<(), String>>>> =
            Arc::new(Mutex::new(None));
        let slot = result.clone();
        let (start, end) = (offset as u64, offset as u64 + size as u64);
        let mapped = catch_unwind(AssertUnwindSafe(|| {
            buf.map_async(mode, start..end, move |r| {
                if let Ok(mut s) = slot.lock() {
                    *s = Some(r.map_err(|e| e.to_string()));
                }
            });
        }));
        if let Err(payload) = mapped {
            return Some(panic_message(payload));
        }
        self.wait();
        let outcome = result.lock().ok().and_then(|mut r| r.take());
        match outcome {
            Some(Ok(())) => None,
            Some(Err(e)) => Some(e),
            None => Some("mapAsync did not complete".to_owned()),
        }
    }

    /// Copy of the mapped bytes `[offset, offset+size)`.
    #[napi(catch_unwind)]
    pub fn buffer_read_mapped(&self, id: u32, offset: f64, size: f64) -> Result<Uint8Array> {
        let table = self.table.borrow();
        let buf = buffer(&table, id).map_err(Error::from_reason)?;
        let start = offset as u64;
        let end = start + size as u64;
        if end == start {
            return Ok(Uint8Array::new(Vec::new()));
        }
        let view = buf
            .get_mapped_range(start..end)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Uint8Array::new(view.to_vec()))
    }

    /// Write `data` into the mapped range at `offset` (flushed by `buffer_unmap`).
    #[napi(catch_unwind)]
    pub fn buffer_write_mapped(&self, id: u32, offset: f64, data: Uint8Array) -> Result<()> {
        let table = self.table.borrow();
        let buf = buffer(&table, id).map_err(Error::from_reason)?;
        if data.is_empty() {
            return Ok(());
        }
        let start = offset as u64;
        let mut view = buf
            .get_mapped_range_mut(start..start + data.len() as u64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        view.copy_from_slice(&data);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn buffer_unmap(&self, id: u32) {
        let table = self.table.borrow();
        if let Ok(buf) = buffer(&table, id) {
            buf.unmap();
        }
    }

    #[napi(catch_unwind)]
    pub fn buffer_destroy(&self, id: u32) {
        let table = self.table.borrow();
        if let Ok(buf) = buffer(&table, id) {
            buf.destroy();
        }
    }

    #[napi(catch_unwind)]
    pub fn create_texture(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::TextureDesc = parse(&descriptor, "GPUTextureDescriptor")?;
            Ok(Res::Texture(self.device.create_texture(
                &wgpu::TextureDescriptor {
                    label: d.label.as_deref(),
                    size: d.size.into(),
                    mip_level_count: d.mip_level_count,
                    sample_count: d.sample_count,
                    dimension: d.dimension.unwrap_or(wgpu::TextureDimension::D2),
                    format: d.format,
                    usage: texture_usages(d.usage)?,
                    view_formats: &d.view_formats,
                },
            )))
        })
    }

    #[napi(catch_unwind)]
    pub fn texture_destroy(&self, id: u32) {
        let table = self.table.borrow();
        if let Ok(tex) = texture(&table, id) {
            tex.destroy();
        }
    }

    #[napi(catch_unwind)]
    pub fn create_view(&self, texture_id: u32, descriptor: String) -> u32 {
        self.create(|table| {
            let d: desc::ViewDesc = parse(&descriptor, "GPUTextureViewDescriptor")?;
            let tex = texture(table, texture_id)?;
            Ok(Res::View(tex.create_view(&wgpu::TextureViewDescriptor {
                label: d.label.as_deref(),
                format: d.format,
                dimension: d.dimension,
                usage: d.usage.map(texture_usages).transpose()?,
                aspect: d.aspect.unwrap_or(wgpu::TextureAspect::All),
                base_mip_level: d.base_mip_level,
                mip_level_count: d.mip_level_count,
                base_array_layer: d.base_array_layer,
                array_layer_count: d.array_layer_count,
            })))
        })
    }

    #[napi(catch_unwind)]
    pub fn create_sampler(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::SamplerDesc = parse(&descriptor, "GPUSamplerDescriptor")?;
            let clamp = wgpu::AddressMode::ClampToEdge;
            Ok(Res::Sampler(self.device.create_sampler(
                &wgpu::SamplerDescriptor {
                    label: d.label.as_deref(),
                    address_mode_u: d.address_mode_u.unwrap_or(clamp),
                    address_mode_v: d.address_mode_v.unwrap_or(clamp),
                    address_mode_w: d.address_mode_w.unwrap_or(clamp),
                    mag_filter: d.mag_filter.unwrap_or(wgpu::FilterMode::Nearest),
                    min_filter: d.min_filter.unwrap_or(wgpu::FilterMode::Nearest),
                    mipmap_filter: d.mipmap_filter.unwrap_or(wgpu::MipmapFilterMode::Nearest),
                    lod_min_clamp: d.lod_min_clamp.unwrap_or(0.0),
                    lod_max_clamp: d.lod_max_clamp.unwrap_or(32.0),
                    compare: d.compare,
                    anisotropy_clamp: d.max_anisotropy.unwrap_or(1),
                    border_color: None,
                },
            )))
        })
    }

    /// Returns JSON `{id, messages}` where `messages` are `GPUCompilationMessage` PODs.
    #[napi(catch_unwind)]
    pub fn create_shader_module(&self, code: String, label: Option<String>) -> String {
        let (module, captured) = self.errors.capturing(|| {
            self.guard(|| {
                Ok(self
                    .device
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: label.as_deref(),
                        source: wgpu::ShaderSource::Wgsl(code.as_str().into()),
                    }))
            })
        });
        let mut messages: Vec<serde_json::Value> = Vec::new();
        if let Some(module) = &module {
            let info = pollster::block_on(module.get_compilation_info());
            for m in info.messages {
                let location = m.location.unwrap_or(wgpu::SourceLocation {
                    line_number: 0,
                    line_position: 0,
                    offset: 0,
                    length: 0,
                });
                messages.push(serde_json::json!({
                    "type": match m.message_type {
                        wgpu::CompilationMessageType::Error => "error",
                        wgpu::CompilationMessageType::Warning => "warning",
                        wgpu::CompilationMessageType::Info => "info",
                    },
                    "message": m.message,
                    "lineNum": location.line_number,
                    "linePos": location.line_position,
                    "offset": location.offset,
                    "length": location.length,
                }));
            }
        }
        if messages.is_empty() {
            for message in captured {
                messages.push(serde_json::json!({
                    "type": "error", "message": message,
                    "lineNum": 0, "linePos": 0, "offset": 0, "length": 0,
                }));
            }
        }
        let id = module.map_or(0, |m| self.insert(Res::Shader(m)));
        serde_json::json!({ "id": id, "messages": messages }).to_string()
    }

    #[napi(catch_unwind)]
    pub fn create_bind_group_layout(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::BglDesc = parse(&descriptor, "GPUBindGroupLayoutDescriptor")?;
            let entries = d
                .entries
                .iter()
                .map(Self::bgl_entry)
                .collect::<Fallible<Vec<_>>>()?;
            Ok(Res::Bgl(self.device.create_bind_group_layout(
                &wgpu::BindGroupLayoutDescriptor {
                    label: d.label.as_deref(),
                    entries: &entries,
                },
            )))
        })
    }

    #[napi(catch_unwind)]
    pub fn create_pipeline_layout(&self, descriptor: String) -> u32 {
        self.create(|table| {
            let d: desc::PipelineLayoutDesc = parse(&descriptor, "GPUPipelineLayoutDescriptor")?;
            let layouts = d
                .bind_group_layouts
                .iter()
                .map(|id| id.map(|id| bgl(table, id)).transpose())
                .collect::<Fallible<Vec<_>>>()?;
            Ok(Res::PipelineLayout(self.device.create_pipeline_layout(
                &wgpu::PipelineLayoutDescriptor {
                    label: d.label.as_deref(),
                    bind_group_layouts: &layouts,
                    immediate_size: d.immediate_size,
                },
            )))
        })
    }

    #[napi(catch_unwind)]
    pub fn create_bind_group(&self, descriptor: String) -> u32 {
        self.create(|table| {
            let d: desc::BindGroupDesc = parse(&descriptor, "GPUBindGroupDescriptor")?;
            let mut tlas_guards = Vec::new();
            for entry in &d.entries {
                if let desc::BindingResource::AccelerationStructure { id } = entry.resource {
                    tlas_guards.push(
                        tlas(table, id)?
                            .try_borrow()
                            .map_err(|_| "TLAS is being built".to_owned())?,
                    );
                }
            }
            let mut next_tlas = tlas_guards.iter();
            let mut entries = Vec::with_capacity(d.entries.len());
            for entry in &d.entries {
                let resource = match &entry.resource {
                    desc::BindingResource::Buffer { id, offset, size } => {
                        wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: buffer(table, *id)?,
                            offset: *offset,
                            size: size.and_then(wgpu::BufferSize::new),
                        })
                    }
                    desc::BindingResource::Sampler { id } => {
                        wgpu::BindingResource::Sampler(sampler(table, *id)?)
                    }
                    desc::BindingResource::TextureView { id } => {
                        wgpu::BindingResource::TextureView(view(table, *id)?)
                    }
                    desc::BindingResource::AccelerationStructure { .. } => {
                        let guard = next_tlas.next().ok_or("TLAS binding mismatch")?;
                        wgpu::BindingResource::AccelerationStructure(guard)
                    }
                };
                entries.push(wgpu::BindGroupEntry {
                    binding: entry.binding,
                    resource,
                });
            }
            Ok(Res::BindGroup(self.device.create_bind_group(
                &wgpu::BindGroupDescriptor {
                    label: d.label.as_deref(),
                    layout: bgl(table, d.layout)?,
                    entries: &entries,
                },
            )))
        })
    }

    #[napi(catch_unwind)]
    pub fn create_render_pipeline(&self, descriptor: String) -> u32 {
        self.create(|table| {
            let d: desc::RenderPipelineDesc = parse(&descriptor, "GPURenderPipelineDescriptor")?;
            self.render_pipeline(table, &d)
        })
    }

    #[napi(catch_unwind)]
    pub fn create_compute_pipeline(&self, descriptor: String) -> u32 {
        self.create(|table| {
            let d: desc::ComputePipelineDesc = parse(&descriptor, "GPUComputePipelineDescriptor")?;
            let constants: Vec<(&str, f64)> = d
                .compute
                .constants
                .iter()
                .map(|(k, v)| (k.as_str(), *v))
                .collect();
            Ok(Res::ComputePipeline(self.device.create_compute_pipeline(
                &wgpu::ComputePipelineDescriptor {
                    label: d.label.as_deref(),
                    layout: d.layout.map(|id| pipeline_layout(table, id)).transpose()?,
                    module: shader(table, d.compute.module)?,
                    entry_point: d.compute.entry_point.as_deref(),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &constants,
                        zero_initialize_workgroup_memory: true,
                    },
                    cache: None,
                },
            )))
        })
    }

    #[napi(catch_unwind)]
    pub fn pipeline_bind_group_layout(&self, pipeline: u32, index: u32) -> u32 {
        self.create(|table| match table.get(&pipeline) {
            Some(Res::RenderPipeline(p)) => Ok(Res::Bgl(p.get_bind_group_layout(index))),
            Some(Res::ComputePipeline(p)) => Ok(Res::Bgl(p.get_bind_group_layout(index))),
            _ => Err(format!("invalid pipeline (id {pipeline})")),
        })
    }

    #[napi(catch_unwind)]
    pub fn create_query_set(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::QuerySetDesc = parse(&descriptor, "GPUQuerySetDescriptor")?;
            let ty = match d.ty.as_str() {
                "occlusion" => wgpu::QueryType::Occlusion,
                "timestamp" => wgpu::QueryType::Timestamp,
                other => return Err(format!("unknown GPUQueryType '{other}'")),
            };
            Ok(Res::QuerySet(self.device.create_query_set(
                &wgpu::QuerySetDescriptor {
                    label: d.label.as_deref(),
                    ty,
                    count: d.count,
                },
            )))
        })
    }

    #[napi(catch_unwind)]
    pub fn query_set_destroy(&self, id: u32) {
        let table = self.table.borrow();
        if let Ok(qs) = query_set(&table, id) {
            qs.destroy();
        }
    }

    #[napi(catch_unwind)]
    pub fn create_blas(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::BlasDesc = parse(&descriptor, "BlasDescriptor")?;
            let (flags, update_mode) = as_flags(d.preference.as_deref(), d.update_mode.as_deref())?;
            let sizes: Vec<_> = d
                .geometries
                .iter()
                .map(|g| wgpu::BlasTriangleGeometrySizeDescriptor {
                    vertex_format: wgpu::VertexFormat::Float32x3,
                    vertex_count: g.vertex_count,
                    index_format: g.index.as_ref().map(|i| i.format),
                    index_count: g.index.as_ref().map(|i| i.count),
                    flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
                })
                .collect();
            let raw = self.device.create_blas(
                &wgpu::CreateBlasDescriptor {
                    label: d.label.as_deref(),
                    flags,
                    update_mode,
                },
                wgpu::BlasGeometrySizeDescriptors::Triangles {
                    descriptors: sizes.clone(),
                },
            );
            Ok(Res::Blas(BlasEntry { raw, sizes }))
        })
    }

    #[napi(catch_unwind)]
    pub fn create_tlas(&self, descriptor: String) -> u32 {
        self.create(|_| {
            let d: desc::TlasDesc = parse(&descriptor, "TlasDescriptor")?;
            let (flags, update_mode) = as_flags(d.preference.as_deref(), d.update_mode.as_deref())?;
            Ok(Res::Tlas(RefCell::new(self.device.create_tlas(
                &wgpu::CreateTlasDescriptor {
                    label: d.label.as_deref(),
                    max_instances: d.max_instances,
                    flags,
                    update_mode,
                },
            ))))
        })
    }

    /// Replay a recorded `GPUCommandEncoder` and return the finished command buffer id, or 0
    /// (an invalid command buffer) after reporting the encoding error.
    #[napi(catch_unwind)]
    pub fn finish_encoder(&self, recording: String) -> u32 {
        self.create(|table| {
            let r: desc::EncoderRecording = parse(&recording, "command recording")?;
            self.encode(table, &r)
        })
    }

    #[napi(catch_unwind)]
    pub fn finish_bundle(&self, descriptor: String, recording: String) -> u32 {
        self.create(|table| {
            let d: desc::BundleEncoderDesc =
                parse(&descriptor, "GPURenderBundleEncoderDescriptor")?;
            let r: desc::EncoderRecording = parse(&recording, "bundle recording")?;
            let mut encoder =
                self.device
                    .create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
                        label: d.label.as_deref(),
                        color_formats: &d.color_formats,
                        depth_stencil: d.depth_stencil_format.map(|format| {
                            wgpu::RenderBundleDepthStencil {
                                format,
                                depth_read_only: d.depth_read_only,
                                stencil_read_only: d.stencil_read_only,
                            }
                        }),
                        sample_count: d.sample_count,
                        multiview: None,
                    });
            for cmd in &r.commands {
                // Debug markers carry no semantics inside a bundle.
                if matches!(
                    cmd,
                    Command::PushDebugGroup { .. }
                        | Command::PopDebugGroup
                        | Command::InsertDebugMarker { .. }
                ) {
                    continue;
                }
                render_command!(encoder, table, cmd);
            }
            Ok(Res::Bundle(encoder.finish(&wgpu::RenderBundleDescriptor {
                label: r.label.as_deref(),
            })))
        })
    }

    #[napi(catch_unwind)]
    pub fn queue_submit(&self, ids: Vec<u32>) -> bool {
        let (accepted, errors) = self.errors.capturing(|| {
            self.guard(|| {
                let table = self.table.borrow();
                let mut buffers = Vec::with_capacity(ids.len());
                for id in &ids {
                    match table.get(id) {
                        Some(Res::CommandBuffer(cell)) => match cell.borrow_mut().take() {
                            Some(cb) => buffers.push(cb),
                            None => return Err("GPUCommandBuffer was already submitted".to_owned()),
                        },
                        _ => return Err(format!("invalid GPUCommandBuffer (id {id}) submitted")),
                    }
                }
                drop(table);
                self.queue.submit(buffers);
                Ok(())
            })
        });
        let mut table = self.table.borrow_mut();
        for id in ids {
            table.remove(&id);
        }
        accepted.is_some() && errors.is_empty()
    }

    #[napi(catch_unwind)]
    pub fn queue_write_buffer(&self, id: u32, offset: f64, data: Uint8Array) {
        let table = self.table.borrow();
        let _ = self.guard(|| {
            self.queue
                .write_buffer(buffer(&table, id)?, offset as u64, &data);
            Ok(())
        });
    }

    #[napi(catch_unwind)]
    pub fn queue_write_texture(&self, descriptor: String, data: Uint8Array) {
        let table = self.table.borrow();
        let _ = self.guard(|| {
            let d: desc::WriteTextureDesc = parse(&descriptor, "writeTexture descriptor")?;
            self.queue.write_texture(
                copy_texture(&table, &d.destination)?,
                &data,
                wgpu::TexelCopyBufferLayout {
                    offset: d.offset,
                    bytes_per_row: d.bytes_per_row,
                    rows_per_image: d.rows_per_image,
                },
                d.size.into(),
            );
            Ok(())
        });
    }

    /// Block until all submitted work completes (`onSubmittedWorkDone`).
    #[napi(catch_unwind)]
    pub fn queue_wait(&self) {
        self.wait();
    }
}
