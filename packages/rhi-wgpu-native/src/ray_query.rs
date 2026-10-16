use crate::device::NativeContext;
use crate::surface;
use crate::{analyze_rgba, FrameCapture, NativeCapabilities, NativeError};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use std::mem;
use std::sync::mpsc;
use wgpu::util::{BufferInitDescriptor, DeviceExt};

#[derive(Debug, Clone, Copy)]
pub struct RendererConfig {
    pub width: u32,
    pub height: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    view_inverse: [f32; 16],
    projection_inverse: [f32; 16],
}

struct Scene {
    _vertex_buffer: wgpu::Buffer,
    _index_buffer: wgpu::Buffer,
    blas: wgpu::Blas,
    tlas: wgpu::Tlas,
}

struct Output {
    texture: wgpu::Texture,
    compute_bind_group: wgpu::BindGroup,
    blit_bind_group: wgpu::BindGroup,
}

pub struct RayQueryRenderer {
    context: NativeContext,
    scene: Scene,
    compute_pipeline: wgpu::ComputePipeline,
    blit_pipeline: wgpu::RenderPipeline,
    compute_bind_group_layout: wgpu::BindGroupLayout,
    blit_bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffer: wgpu::Buffer,
    sampler: wgpu::Sampler,
    output: Output,
}

impl RayQueryRenderer {
    pub async fn new<W>(window: W, config: RendererConfig) -> Result<Self, NativeError>
    where
        W: wgpu::DisplayAndWindowHandle + 'static,
    {
        let context = NativeContext::create(window, config.width, config.height).await?;
        let device = &context.device;
        let init_error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

        let compute_shader =
            device.create_shader_module(wgpu::include_wgsl!("shaders/ray_query_triangle.wgsl"));
        let blit_shader = device.create_shader_module(wgpu::include_wgsl!("shaders/blit.wgsl"));
        let compute_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forgeax Ray Query bind group layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::StorageTexture {
                            access: wgpu::StorageTextureAccess::WriteOnly,
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            view_dimension: wgpu::TextureViewDimension::D2,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::AccelerationStructure {
                            vertex_return: false,
                        },
                        count: None,
                    },
                ],
            });
        let blit_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forgeax Ray Query blit bind group layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                        count: None,
                    },
                ],
            });
        let compute_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forgeax Ray Query pipeline layout"),
            bind_group_layouts: &[Some(&compute_bind_group_layout)],
            immediate_size: 0,
        });
        let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("forgeax Ray Query compute pipeline"),
            layout: Some(&compute_layout),
            module: &compute_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let blit_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forgeax Ray Query blit pipeline layout"),
            bind_group_layouts: &[Some(&blit_bind_group_layout)],
            immediate_size: 0,
        });
        let blit_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("forgeax Ray Query blit pipeline"),
            layout: Some(&blit_layout),
            vertex: wgpu::VertexState {
                module: &blit_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &blit_shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: context.surface_config.format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });

        let vertices: [f32; 9] = [1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 0.0, -1.0, 0.0];
        let indices: [u32; 3] = [0, 1, 2];
        let vertex_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax Ray Query triangle vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let index_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax Ray Query triangle indices"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let geometry_size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: Some(wgpu::IndexFormat::Uint32),
            index_count: Some(3),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax triangle BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![geometry_size.clone()],
            },
        );
        let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax triangle TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(triangle_instance(&blas));
        let mut build_encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        build_encoder.build_acceleration_structures(
            Some(&wgpu::BlasBuildEntry {
                blas: &blas,
                geometry: wgpu::BlasGeometries::TriangleGeometries(vec![
                    wgpu::BlasTriangleGeometry {
                        size: &geometry_size,
                        vertex_buffer: &vertex_buffer,
                        first_vertex: 0,
                        vertex_stride: mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                        index_buffer: Some(&index_buffer),
                        first_index: Some(0),
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    },
                ]),
            }),
            Some(&tlas),
        );
        context.queue.submit(Some(build_encoder.finish()));

        let view = Mat4::look_at_rh(Vec3::new(0.0, 0.0, 2.5), Vec3::ZERO, Vec3::Y);
        let projection = Mat4::perspective_rh(59.0_f32.to_radians(), 1.0, 0.001, 1000.0);
        let uniforms = Uniforms {
            view_inverse: view.inverse().to_cols_array(),
            projection_inverse: projection.inverse().to_cols_array(),
        };
        let uniform_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax Ray Query camera uniforms"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forgeax Ray Query blit sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let scene = Scene {
            _vertex_buffer: vertex_buffer,
            _index_buffer: index_buffer,
            blas,
            tlas,
        };
        let output = create_output(
            device,
            (context.surface_config.width, context.surface_config.height),
            &compute_bind_group_layout,
            &blit_bind_group_layout,
            &uniform_buffer,
            &scene.tlas,
            &sampler,
        );
        context
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| NativeError::GpuInitialization {
                detail: format!("failed to wait for acceleration-structure build: {error}"),
            })?;
        if let Some(error) = init_error_scope.pop().await {
            return Err(NativeError::GpuInitialization {
                detail: error.to_string(),
            });
        }

        Ok(Self {
            context,
            scene,
            compute_pipeline,
            blit_pipeline,
            compute_bind_group_layout,
            blit_bind_group_layout,
            uniform_buffer,
            sampler,
            output,
        })
    }

    pub fn capabilities(&self) -> &NativeCapabilities {
        &self.context.capabilities
    }

    pub fn set_triangle_present(&mut self, present: bool) {
        self.scene.tlas[0] = present.then(|| triangle_instance(&self.scene.blas));
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.context.resize(width, height);
        self.output = create_output(
            &self.context.device,
            (
                self.context.surface_config.width,
                self.context.surface_config.height,
            ),
            &self.compute_bind_group_layout,
            &self.blit_bind_group_layout,
            &self.uniform_buffer,
            &self.scene.tlas,
            &self.sampler,
        );
    }

    pub fn render(&mut self) -> Result<(), NativeError> {
        self.draw(None, true)?;
        Ok(())
    }

    pub fn capture(&mut self) -> Result<FrameCapture, NativeError> {
        let width = self.context.surface_config.width;
        let height = self.context.surface_config.height;
        let unpadded_bytes_per_row = width * 4;
        let padded_bytes_per_row = unpadded_bytes_per_row.div_ceil(256) * 256;
        let readback = self.context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax Ray Query readback"),
            size: u64::from(padded_bytes_per_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        self.draw(Some((&readback, padded_bytes_per_row)), false)?;

        let (sender, receiver) = mpsc::channel();
        readback.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        self.context
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| NativeError::Evidence {
                detail: format!("failed to poll readback: {error}"),
            })?;
        receiver
            .recv()
            .map_err(|error| NativeError::Evidence {
                detail: format!("readback callback was lost: {error}"),
            })?
            .map_err(|error| NativeError::Evidence {
                detail: format!("failed to map readback: {error}"),
            })?;

        let mapped = readback
            .get_mapped_range(..)
            .map_err(|error| NativeError::Evidence {
                detail: format!("failed to view mapped readback: {error}"),
            })?;
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for row in mapped.chunks_exact(padded_bytes_per_row as usize) {
            rgba.extend_from_slice(&row[..unpadded_bytes_per_row as usize]);
        }
        drop(mapped);
        readback.unmap();
        analyze_rgba(width, height, rgba)
    }

    fn draw(
        &mut self,
        readback: Option<(&wgpu::Buffer, u32)>,
        present: bool,
    ) -> Result<(), NativeError> {
        let frame_error_scope = self
            .context
            .device
            .push_error_scope(wgpu::ErrorFilter::Validation);
        let surface_frame = if present {
            Some(surface::acquire(
                &self.context.surface,
                &self.context.device,
                &self.context.surface_config,
            )?)
        } else {
            None
        };
        let surface_view = surface_frame.as_ref().map(|frame| {
            frame
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default())
        });
        let mut encoder =
            self.context
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("forgeax Ray Query frame"),
                });
        encoder.build_acceleration_structures(None, Some(&self.scene.tlas));
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forgeax Ray Query compute"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.compute_pipeline);
            pass.set_bind_group(0, Some(&self.output.compute_bind_group), &[]);
            pass.dispatch_workgroups(
                self.context.surface_config.width.div_ceil(8),
                self.context.surface_config.height.div_ceil(8),
                1,
            );
        }
        if let Some((buffer, padded_bytes_per_row)) = readback {
            encoder.copy_texture_to_buffer(
                self.output.texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_bytes_per_row),
                        rows_per_image: Some(self.context.surface_config.height),
                    },
                },
                wgpu::Extent3d {
                    width: self.context.surface_config.width,
                    height: self.context.surface_config.height,
                    depth_or_array_layers: 1,
                },
            );
        }
        if let Some(surface_view) = &surface_view {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forgeax Ray Query blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: surface_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.blit_pipeline);
            pass.set_bind_group(0, Some(&self.output.blit_bind_group), &[]);
            pass.draw(0..3, 0..1);
        }
        self.context.queue.submit(Some(encoder.finish()));
        if let Some(surface_frame) = surface_frame {
            self.context.queue.present(surface_frame);
        }
        self.context
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| NativeError::Render {
                detail: format!("failed to complete frame: {error}"),
            })?;
        if let Some(error) = pollster::block_on(frame_error_scope.pop()) {
            return Err(NativeError::Render {
                detail: error.to_string(),
            });
        }
        Ok(())
    }
}

fn triangle_instance(blas: &wgpu::Blas) -> wgpu::TlasInstance {
    wgpu::TlasInstance::new(blas, IDENTITY_INSTANCE_TRANSFORM, 0, 0xff)
}

const IDENTITY_INSTANCE_TRANSFORM: [f32; 12] =
    [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];

fn create_output(
    device: &wgpu::Device,
    size: (u32, u32),
    compute_layout: &wgpu::BindGroupLayout,
    blit_layout: &wgpu::BindGroupLayout,
    uniform_buffer: &wgpu::Buffer,
    tlas: &wgpu::Tlas,
    sampler: &wgpu::Sampler,
) -> Output {
    let (width, height) = size;
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forgeax Ray Query output"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let compute_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("forgeax Ray Query compute bindings"),
        layout: compute_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::AccelerationStructure(tlas),
            },
        ],
    });
    let blit_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("forgeax Ray Query blit bindings"),
        layout: blit_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    });
    Output {
        texture,
        compute_bind_group,
        blit_bind_group,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_instance_transform_matches_wgpu_row_major_contract() {
        let official_form: [f32; 12] = Mat4::IDENTITY.transpose().to_cols_array()[..12]
            .try_into()
            .unwrap();
        assert_eq!(IDENTITY_INSTANCE_TRANSFORM, official_form);
    }
}
