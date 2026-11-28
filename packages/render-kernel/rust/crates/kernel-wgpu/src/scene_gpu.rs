//! Fixed 4-BGL GPU scene buffers and incremental dirty-row synchronization for `kernel-wgpu`.
//!
//! Layout contract (`LAYOUT_FAMILY_SCENE_4BGL = 2`):
//! - `@group(0) @binding(0)`: `var<uniform> view` (dynamic offset into `frame_uniform_buffer`)
//! - `@group(1) @binding(0)`: `var<uniform> material` (per-material UBO, updated in-place on `param_dirty`)
//! - `@group(2) @binding(0)`: `var<storage, read> scene_objects: array<SceneObjectGpu>` (96B/row, coalesced dirty-range sync)
//! - `@group(2) @binding(1)`: `var<storage, read> scene_lights: array<SceneLightGpu>` (64B/light)
//! - `@group(3) @binding(0)`: `var<storage, read> instance_rows: array<u32>` (sorted/instanced row indirection)

use forgeax_render_kernel_core::pso::VIEW_UNIFORM_SLOT_STRIDE;
use forgeax_render_kernel_core::scene::{LightRecord, RetainedRenderScene};

pub const SCENE_OBJECT_STRIDE_BYTES: usize = 96; // mat4x4<f32> (64B) + params0 vec4 (16B) + params1 vec4 (16B)
pub const SCENE_LIGHT_STRIDE_BYTES: usize = 64; // 4 x vec4<f32>
const VIEW_BINDING_SIZE: u64 = VIEW_UNIFORM_SLOT_STRIDE as u64;

/// Packed 96-byte per-object GPU row (`world` + `params0` + `params1`).
#[repr(C)]
#[derive(Clone, Copy)]
struct SceneObjectGpu {
    world: [f32; 16],
    params0: [f32; 4],
    params1: [f32; 4],
}

/// Packed 64-byte per-light GPU record matching `LightRecord`.
#[repr(C)]
#[derive(Clone, Copy)]
struct SceneLightGpu {
    position_range: [f32; 4],
    direction_intensity: [f32; 4],
    color_outer_cos: [f32; 4],
    meta: [u32; 4], // [kind, cast_shadow, cascade_count, layer_mask]
}

fn pack_object_row(scene: &RetainedRenderScene, row: usize) -> SceneObjectGpu {
    let dp = scene.draw_params[row];
    let skin_slot = scene.skin_slots[row];
    SceneObjectGpu {
        world: scene.transforms[row],
        params0: [dp[0], dp[1], dp[2], dp[3]],
        params1: [
            dp[4],
            dp[5],
            dp[6],
            if skin_slot != 0 { skin_slot as f32 } else { dp[7] },
        ],
    }
}

fn pack_light(l: &LightRecord) -> SceneLightGpu {
    SceneLightGpu {
        position_range: [l.position[0], l.position[1], l.position[2], l.range],
        direction_intensity: [l.direction[0], l.direction[1], l.direction[2], l.intensity],
        color_outer_cos: [l.color[0], l.color[1], l.color[2], l.outer_cone_cos],
        meta: [
            l.kind as u32,
            u32::from(l.cast_shadow),
            l.cascade_count as u32,
            l.layer_mask,
        ],
    }
}

fn as_byte_slice<T>(slice: &[T]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(slice.as_ptr() as *const u8, std::mem::size_of_val(slice)) }
}

pub struct SceneSyncStats {
    pub dirty_rows_uploaded: u64,
    pub dirty_range_writes: u64,
    pub material_uploads: u64,
}

/// Owns the fixed 4-BGL bind group layouts, shared PipelineLayout, persistent GPU scene buffers,
/// and cached bind groups (rebuilt only on buffer growth).
pub struct Scene4BglState {
    pub bgl_view: wgpu::BindGroupLayout,
    pub bgl_material: wgpu::BindGroupLayout,
    pub bgl_mesh_scene: wgpu::BindGroupLayout,
    pub bgl_instances: wgpu::BindGroupLayout,
    pub pipeline_layout: wgpu::PipelineLayout,

    frame_uniform_buf: wgpu::Buffer,
    frame_uniform_cap: u64,
    pub view_bind_group: wgpu::BindGroup,

    scene_objects_buf: wgpu::Buffer,
    scene_objects_cap_rows: usize,
    scene_lights_buf: wgpu::Buffer,
    scene_lights_cap: usize,
    skin_joints_buf: wgpu::Buffer,
    skin_joints_cap: usize,
    _default_white_tex: wgpu::Texture,
    pub default_white_view: wgpu::TextureView,
    _default_normal_tex: wgpu::Texture,
    pub default_normal_view: wgpu::TextureView,
    pub default_sampler: wgpu::Sampler,
    _default_shadow_tex: wgpu::Texture,
    pub default_shadow_view: wgpu::TextureView,
    pub shadow_sampler: wgpu::Sampler,
    pub mesh_scene_bind_group: wgpu::BindGroup,

    instance_rows_buf: wgpu::Buffer,
    instance_rows_cap: usize,
    pub instances_bind_group: wgpu::BindGroup,

    last_synced_epoch: u32,
    last_synced_object_count: usize,
    last_synced_lights_rev: u32,
    staging_objects: Vec<SceneObjectGpu>,
    staging_lights: Vec<SceneLightGpu>,
    dirty_scratch: Vec<u32>,
}

impl Scene4BglState {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let bgl_view = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kernel.4bgl.view"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let bgl_material = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kernel.4bgl.material"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 6,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });

        let bgl_mesh_scene = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kernel.4bgl.mesh-scene"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let bgl_instances = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("kernel.4bgl.instances"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("kernel.4bgl.pipeline-layout"),
            bind_group_layouts: &[
                Some(&bgl_view),
                Some(&bgl_material),
                Some(&bgl_mesh_scene),
                Some(&bgl_instances),
            ],
            immediate_size: 0,
        });

        let frame_uniform_cap = 4096u64;
        let frame_uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.4bgl.view-ring"),
            size: frame_uniform_cap,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let view_bind_group = Self::make_view_bg(device, &bgl_view, &frame_uniform_buf);

        let scene_objects_cap_rows = 256usize;
        let scene_objects_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.4bgl.scene-objects"),
            size: (scene_objects_cap_rows * SCENE_OBJECT_STRIDE_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let scene_lights_cap = 16usize;
        let scene_lights_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.4bgl.scene-lights"),
            size: (scene_lights_cap * SCENE_LIGHT_STRIDE_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let skin_joints_cap = 64usize;
        let skin_joints_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.4bgl.skin-joints"),
            size: (skin_joints_cap * 64) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let default_white_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kernel.4bgl.default-white"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &default_white_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255u8, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let default_white_view =
            default_white_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let default_normal_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kernel.4bgl.default-normal"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &default_normal_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[128u8, 128, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let default_normal_view =
            default_normal_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("kernel.4bgl.default-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            ..Default::default()
        });

        let default_shadow_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kernel.4bgl.default-shadow"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let default_shadow_view =
            default_shadow_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("kernel.4bgl.shadow-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            compare: Some(wgpu::CompareFunction::LessEqual),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        let mesh_scene_bind_group = Self::make_mesh_scene_bg(
            device,
            &bgl_mesh_scene,
            &scene_objects_buf,
            &scene_lights_buf,
            &default_shadow_view,
            &shadow_sampler,
            &skin_joints_buf,
        );

        let instance_rows_cap = 1024usize;
        let instance_rows_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kernel.4bgl.instance-rows"),
            size: (instance_rows_cap * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let instances_bind_group =
            Self::make_instances_bg(device, &bgl_instances, &instance_rows_buf);

        Self {
            bgl_view,
            bgl_material,
            bgl_mesh_scene,
            bgl_instances,
            pipeline_layout,
            frame_uniform_buf,
            frame_uniform_cap,
            view_bind_group,
            scene_objects_buf,
            scene_objects_cap_rows,
            scene_lights_buf,
            scene_lights_cap,
            skin_joints_buf,
            skin_joints_cap,
            _default_white_tex: default_white_tex,
            default_white_view,
            _default_normal_tex: default_normal_tex,
            default_normal_view,
            default_sampler,
            _default_shadow_tex: default_shadow_tex,
            default_shadow_view,
            shadow_sampler,
            mesh_scene_bind_group,
            instance_rows_buf,
            instance_rows_cap,
            instances_bind_group,
            last_synced_epoch: u32::MAX,
            last_synced_object_count: usize::MAX,
            last_synced_lights_rev: u32::MAX,
            staging_objects: Vec::with_capacity(256),
            staging_lights: Vec::with_capacity(16),
            dirty_scratch: Vec::with_capacity(256),
        }
    }

    fn make_view_bg(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        buf: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kernel.4bgl.view-bg"),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: buf,
                    offset: 0,
                    size: std::num::NonZeroU64::new(VIEW_BINDING_SIZE),
                }),
            }],
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn make_mesh_scene_bg(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        objects_buf: &wgpu::Buffer,
        lights_buf: &wgpu::Buffer,
        shadow_view: &wgpu::TextureView,
        shadow_sampler: &wgpu::Sampler,
        skin_joints_buf: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kernel.4bgl.mesh-scene-bg"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: objects_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: lights_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(shadow_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(shadow_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: skin_joints_buf.as_entire_binding(),
                },
            ],
        })
    }

    pub fn create_mesh_scene_bind_group_with_shadow(
        &self,
        device: &wgpu::Device,
        shadow_view: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        Self::make_mesh_scene_bg(
            device,
            &self.bgl_mesh_scene,
            &self.scene_objects_buf,
            &self.scene_lights_buf,
            shadow_view,
            &self.shadow_sampler,
            &self.skin_joints_buf,
        )
    }

    fn make_instances_bg(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        buf: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kernel.4bgl.instances-bg"),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buf.as_entire_binding(),
            }],
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_material_bind_group(
        &self,
        device: &wgpu::Device,
        uniform_buffer: &wgpu::Buffer,
        tex_view: Option<&wgpu::TextureView>,
        sampler: Option<&wgpu::Sampler>,
        normal_view: Option<&wgpu::TextureView>,
        metallic_roughness_view: Option<&wgpu::TextureView>,
        emissive_view: Option<&wgpu::TextureView>,
        occlusion_view: Option<&wgpu::TextureView>,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kernel.4bgl.material-bg"),
            layout: &self.bgl_material,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        tex_view.unwrap_or(&self.default_white_view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(
                        sampler.unwrap_or(&self.default_sampler),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(
                        normal_view.unwrap_or(&self.default_normal_view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(
                        metallic_roughness_view.unwrap_or(&self.default_white_view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(
                        emissive_view.unwrap_or(&self.default_white_view),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(
                        occlusion_view.unwrap_or(&self.default_white_view),
                    ),
                },
            ],
        })
    }

    pub fn upload_frame_uniforms(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniform_data: &[u8],
    ) {
        if uniform_data.is_empty() {
            return;
        }
        // Keep >= VIEW_BINDING_SIZE tail headroom so a dynamic-offset binding at the last
        // aligned slot always fits within buffer bounds.
        let required = ((uniform_data.len() as u64 + 255) & !255) + VIEW_BINDING_SIZE;
        if self.frame_uniform_cap < required {
            let cap = (required * 2).max(4096);
            self.frame_uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("kernel.4bgl.view-ring"),
                size: cap,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.frame_uniform_cap = cap;
            self.view_bind_group =
                Self::make_view_bg(device, &self.bgl_view, &self.frame_uniform_buf);
        }
        let aligned = (uniform_data.len() + 3) & !3;
        if aligned == uniform_data.len() {
            queue.write_buffer(&self.frame_uniform_buf, 0, uniform_data);
        } else {
            let mut padded = vec![0u8; aligned];
            padded[..uniform_data.len()].copy_from_slice(uniform_data);
            queue.write_buffer(&self.frame_uniform_buf, 0, &padded);
        }
    }

    /// Incrementally syncs coalesced dirty scene object rows, light table, and instance-row
    /// indirection buffer onto native GPU buffers with zero steady-state allocations.
    pub fn sync_scene_and_instances(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &mut RetainedRenderScene,
        instance_rows: &[u32],
    ) -> SceneSyncStats {
        let mut stats = SceneSyncStats {
            dirty_rows_uploaded: 0,
            dirty_range_writes: 0,
            material_uploads: 0,
        };
        let obj_count = scene.object_count();
        let mut mesh_scene_bg_dirty = false;

        if obj_count > self.scene_objects_cap_rows {
            let mut cap = self.scene_objects_cap_rows.max(256);
            while cap < obj_count {
                cap *= 2;
            }
            self.scene_objects_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("kernel.4bgl.scene-objects"),
                size: (cap * SCENE_OBJECT_STRIDE_BYTES) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.scene_objects_cap_rows = cap;
            mesh_scene_bg_dirty = true;
            // Force full upload after reallocation.
            self.last_synced_object_count = usize::MAX;
        }

        let need_full_objects = obj_count > 0
            && (self.last_synced_epoch != scene.epoch
                || self.last_synced_object_count != obj_count);

        if need_full_objects {
            self.staging_objects.clear();
            self.staging_objects.reserve(obj_count);
            for row in 0..obj_count {
                self.staging_objects.push(pack_object_row(scene, row));
            }
            queue.write_buffer(&self.scene_objects_buf, 0, as_byte_slice(&self.staging_objects));
            stats.dirty_rows_uploaded += obj_count as u64;
            stats.dirty_range_writes += 1;
            scene.clear_dirty_rows();
            self.last_synced_epoch = scene.epoch;
            self.last_synced_object_count = obj_count;
        } else if !scene.transform_dirty_rows.is_empty() && obj_count > 0 {
            self.dirty_scratch.clear();
            self.dirty_scratch
                .extend(scene.transform_dirty_rows.iter().copied().filter(|&r| (r as usize) < obj_count));
            scene.clear_dirty_rows();
            if !self.dirty_scratch.is_empty() {
                self.dirty_scratch.sort_unstable();
                self.dirty_scratch.dedup();
                // Coalesce contiguous dirty rows into minimal queue.write_buffer calls.
                let mut i = 0usize;
                while i < self.dirty_scratch.len() {
                    let start = self.dirty_scratch[i] as usize;
                    let mut end = start + 1;
                    i += 1;
                    while i < self.dirty_scratch.len() && self.dirty_scratch[i] as usize == end {
                        end += 1;
                        i += 1;
                    }
                    self.staging_objects.clear();
                    for row in start..end {
                        self.staging_objects.push(pack_object_row(scene, row));
                    }
                    queue.write_buffer(
                        &self.scene_objects_buf,
                        (start * SCENE_OBJECT_STRIDE_BYTES) as u64,
                        as_byte_slice(&self.staging_objects),
                    );
                    stats.dirty_rows_uploaded += (end - start) as u64;
                    stats.dirty_range_writes += 1;
                }
            }
        } else {
            self.last_synced_epoch = scene.epoch;
            self.last_synced_object_count = obj_count;
        }

        // Sync lights buffer when revision changed and lights are present.
        let light_count = scene.lights.len();
        if light_count > self.scene_lights_cap {
            let mut cap = self.scene_lights_cap.max(16);
            while cap < light_count {
                cap *= 2;
            }
            self.scene_lights_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("kernel.4bgl.scene-lights"),
                size: (cap * SCENE_LIGHT_STRIDE_BYTES) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.scene_lights_cap = cap;
            mesh_scene_bg_dirty = true;
            self.last_synced_lights_rev = u32::MAX;
        }
        if self.last_synced_lights_rev != scene.revision && light_count > 0 {
            self.staging_lights.clear();
            for l in &scene.lights {
                self.staging_lights.push(pack_light(l));
            }
            queue.write_buffer(&self.scene_lights_buf, 0, as_byte_slice(&self.staging_lights));
            self.last_synced_lights_rev = scene.revision;
        }

        // Sync GPU skinning joint palette storage buffer (`@group(2) @binding(4)`).
        let joint_len = scene.skin_joints.len();
        if joint_len > self.skin_joints_cap {
            let mut cap = self.skin_joints_cap.max(64);
            while cap < joint_len {
                cap *= 2;
            }
            self.skin_joints_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("kernel.4bgl.skin-joints"),
                size: (cap * 64) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.skin_joints_cap = cap;
            mesh_scene_bg_dirty = true;
            if joint_len > 0 {
                queue.write_buffer(&self.skin_joints_buf, 0, as_byte_slice(&scene.skin_joints));
            }
            scene.skin_dirty_ranges.clear();
        } else if !scene.skin_dirty_ranges.is_empty() && joint_len > 0 {
            for &(start, count) in &scene.skin_dirty_ranges {
                let s = start as usize;
                let e = (s + count as usize).min(joint_len);
                if s < e {
                    queue.write_buffer(
                        &self.skin_joints_buf,
                        (s * 64) as u64,
                        as_byte_slice(&scene.skin_joints[s..e]),
                    );
                }
            }
            scene.skin_dirty_ranges.clear();
        }

        if mesh_scene_bg_dirty {
            self.mesh_scene_bind_group = Self::make_mesh_scene_bg(
                device,
                &self.bgl_mesh_scene,
                &self.scene_objects_buf,
                &self.scene_lights_buf,
                &self.default_shadow_view,
                &self.shadow_sampler,
                &self.skin_joints_buf,
            );
        }

        // Sync sorted/instanced row indirection buffer for Group 3.
        if !instance_rows.is_empty() {
            if instance_rows.len() > self.instance_rows_cap {
                let mut cap = self.instance_rows_cap.max(1024);
                while cap < instance_rows.len() {
                    cap *= 2;
                }
                self.instance_rows_buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("kernel.4bgl.instance-rows"),
                    size: (cap * 4) as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                self.instance_rows_cap = cap;
                self.instances_bind_group =
                    Self::make_instances_bg(device, &self.bgl_instances, &self.instance_rows_buf);
            }
            queue.write_buffer(&self.instance_rows_buf, 0, as_byte_slice(instance_rows));
        }

        stats
    }
}
