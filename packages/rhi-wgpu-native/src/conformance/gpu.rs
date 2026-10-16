mod vertex_return;

use super::model::{AccelerationStructureLimits, EnvironmentSnapshot, FeatureSnapshot};
use super::oracle::{approximately_equal, intersect_triangle, Ray, Triangle};
use crate::device::{
    create_native_instance, request_native_device, select_native_adapter, REQUIRED_BACKEND_NAME,
};
use crate::{NativeCapabilities, NativeError, WGPU_VERSION};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use std::mem;
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use wgpu::util::{BufferInitDescriptor, DeviceExt};

const WGPU_TAG_COMMIT: &str = "40f4a34ebaf56f9a046231f54125ad046239d3f3";
const RAY_COUNT: usize = 4;
const OBSERVATION_SIZE: usize = 176;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct InputRay {
    origin_t_min: [f32; 4],
    direction_t_max: [f32; 4],
    flags_mask: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct AabbPrimitive {
    minimum: [f32; 3],
    maximum: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PaddedAabbPrimitive {
    primitive: AabbPrimitive,
    padding: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct GpuObservation {
    pub kind: u32,
    pub t: f32,
    pub instance_custom_data: u32,
    pub instance_index: u32,
    pub sbt_record_offset: u32,
    pub geometry_index: u32,
    pub primitive_index: u32,
    _barycentric_alignment: u32,
    pub barycentrics: [f32; 2],
    pub front_face: u32,
    _matrix_alignment: u32,
    pub object_to_world: [[f32; 4]; 4],
    pub world_to_object: [[f32; 4]; 4],
}

#[derive(Debug, Clone, Copy)]
pub enum BuildSchedule {
    OneEncoder,
    OrderedCommandBuffers,
    SeparateSubmitAndPoll,
}

impl BuildSchedule {
    pub const fn name(self) -> &'static str {
        match self {
            Self::OneEncoder => "one-encoder",
            Self::OrderedCommandBuffers => "ordered-command-buffers",
            Self::SeparateSubmitAndPoll => "separate-submit-and-poll",
        }
    }
}

pub struct CoreRunEvidence {
    pub schedule: BuildSchedule,
    pub iterations: u32,
    pub observation_hash: String,
    pub first_observations: Vec<GpuObservation>,
    pub duration: Duration,
}

struct RebuildOutcome {
    observations: Option<Vec<GpuObservation>>,
    validation: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum TriangleVariant {
    NonIndexed,
    Uint16Indexed,
    Uint32Indexed,
    Prefixed,
    PaddedStride,
    Float16x4,
    BlasTransform,
    PreferUpdate,
}

impl TriangleVariant {
    pub const fn name(self) -> &'static str {
        match self {
            Self::NonIndexed => "non-indexed",
            Self::Uint16Indexed => "uint16-indexed",
            Self::Uint32Indexed => "uint32-indexed",
            Self::Prefixed => "prefixed",
            Self::PaddedStride => "padded-stride",
            Self::Float16x4 => "float16x4",
            Self::BlasTransform => "blas-transform",
            Self::PreferUpdate => "prefer-update",
        }
    }
}

pub struct GpuHarness {
    pub environment: EnvironmentSnapshot,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

struct ReferenceScene {
    _vertices: wgpu::Buffer,
    _indices: wgpu::Buffer,
    blas: wgpu::Blas,
    tlas: wgpu::Tlas,
    geometry_size: wgpu::BlasTriangleGeometrySizeDescriptor,
    _rays: wgpu::Buffer,
    output: wgpu::Buffer,
    readback: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    bindings: wgpu::BindGroup,
}

impl GpuHarness {
    pub fn run_performance(
        &self,
        side: u32,
        ray_count: u32,
        compact: bool,
        evidence_directory: &std::path::Path,
    ) -> Result<serde_json::Value, String> {
        super::performance::run(
            &self.device,
            &self.queue,
            side,
            ray_count,
            compact,
            evidence_directory,
        )
    }

    pub async fn create() -> Result<Self, NativeError> {
        let instance = create_native_instance()?;
        let selected = select_native_adapter(&instance, None).await?;
        let environment = environment_snapshot(
            selected.capabilities.clone(),
            selected.features,
            &selected.limits,
        );
        if !selected
            .features
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
        {
            return Err(NativeError::RayQueryUnsupported {
                detail: format!(
                    "adapter '{}' does not expose EXPERIMENTAL_RAY_QUERY",
                    selected.capabilities.adapter.name
                ),
                capabilities: Box::new(selected.capabilities),
            });
        }
        let optional = wgpu::Features::EXPERIMENTAL_RAY_HIT_VERTEX_RETURN
            | wgpu::Features::EXTENDED_ACCELERATION_STRUCTURE_VERTEX_FORMATS
            | wgpu::Features::ACCELERATION_STRUCTURE_BINDING_ARRAY
            | wgpu::Features::TIMESTAMP_QUERY
            | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let required_features =
            wgpu::Features::EXPERIMENTAL_RAY_QUERY | (selected.features & optional);
        let mut required_limits =
            wgpu::Limits::default().using_minimum_supported_acceleration_structure_values();
        if required_features.contains(wgpu::Features::ACCELERATION_STRUCTURE_BINDING_ARRAY) {
            required_limits.max_binding_array_elements_per_shader_stage = selected
                .limits
                .max_binding_array_elements_per_shader_stage
                .min(2);
            required_limits.max_binding_array_acceleration_structure_elements_per_shader_stage =
                selected
                    .limits
                    .max_binding_array_acceleration_structure_elements_per_shader_stage
                    .min(2);
        }
        let (device, queue) =
            request_native_device(&selected.adapter, required_features, required_limits).await?;
        Ok(Self {
            environment,
            adapter: selected.adapter,
            device,
            queue,
        })
    }

    pub async fn validate_feature_disabled_boundary(&self) -> Result<String, String> {
        let (device, queue) = self
            .adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("forgeax Ray Query feature-disabled validation device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
            })
            .await
            .map_err(|error| format!("failed to request feature-disabled device: {error}"))?;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _invalid = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("feature-disabled BLAS input"),
            size: 64,
            usage: wgpu::BufferUsages::BLAS_INPUT,
            mapped_at_creation: false,
        });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("feature-disabled device poll failed: {error}"))?;
        let validation = scope
            .pop()
            .await
            .ok_or_else(|| "BLAS_INPUT without EXPERIMENTAL_RAY_QUERY was accepted".to_string())?;

        let health = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("feature-disabled health probe"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        queue.write_buffer(&health, 0, &[1, 2, 3, 4]);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("device health probe failed: {error}"))?;
        Ok(format!("validation captured; device healthy: {validation}"))
    }

    pub fn run_core_schedule(
        &self,
        schedule: BuildSchedule,
        iterations: u32,
    ) -> Result<CoreRunEvidence, String> {
        let scene = ReferenceScene::create(&self.device)?;
        let started = Instant::now();
        let mut first_observations = Vec::new();
        let mut expected_hash = None;
        for iteration in 0..iterations {
            let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
            self.execute_schedule(&scene, schedule)?;
            self.device
                .poll(wgpu::PollType::wait_indefinitely())
                .map_err(|error| {
                    format!(
                        "{} iteration {iteration} poll failed: {error}",
                        schedule.name()
                    )
                })?;
            if let Some(error) = pollster::block_on(scope.pop()) {
                return Err(format!(
                    "{} iteration {iteration} validation: {error}",
                    schedule.name()
                ));
            }
            let observations = map_observations(&self.device, &scene.readback)?;
            validate_reference_observations(&observations)?;
            let hash = hash_observations(&observations);
            match expected_hash {
                Some(expected) if expected != hash => {
                    return Err(format!(
                        "{} iteration {iteration} produced stale hash {hash:016x}, expected {expected:016x}",
                        schedule.name()
                    ));
                }
                None => {
                    expected_hash = Some(hash);
                    first_observations = observations;
                }
                _ => {}
            }
        }
        Ok(CoreRunEvidence {
            schedule,
            iterations,
            observation_hash: format!("{:016x}", expected_hash.unwrap_or(0)),
            first_observations,
            duration: started.elapsed(),
        })
    }

    pub fn run_triangle_variant(&self, variant: TriangleVariant) -> Result<GpuObservation, String> {
        let target = [-1.0_f32, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let prefix = [20.0_f32, 20.0, 0.0, 21.0, 20.0, 0.0, 20.0, 21.0, 0.0];
        let mut vertex_bytes = bytemuck::cast_slice(&target).to_vec();
        let mut vertex_count = 3;
        let mut first_vertex = 0;
        let mut vertex_stride = mem::size_of::<[f32; 3]>() as u64;
        let mut vertex_format = wgpu::VertexFormat::Float32x3;
        let mut index_bytes = None;
        let mut index_format = None;
        let mut index_count = None;
        let mut first_index = None;
        let mut ray_origin = Vec3::new(0.0, 0.0, 2.0);
        let mut blas_flags = wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE;
        let mut tlas_flags = wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE;
        let mut update_mode = wgpu::AccelerationStructureUpdateMode::Build;
        let mut transform_values = None;
        match variant {
            TriangleVariant::NonIndexed => {}
            TriangleVariant::Uint16Indexed => {
                index_bytes = Some(bytemuck::cast_slice(&[0_u16, 1, 2]).to_vec());
                index_format = Some(wgpu::IndexFormat::Uint16);
                index_count = Some(3);
                first_index = Some(0);
            }
            TriangleVariant::Uint32Indexed => {
                index_bytes = Some(bytemuck::cast_slice(&[0_u32, 1, 2]).to_vec());
                index_format = Some(wgpu::IndexFormat::Uint32);
                index_count = Some(3);
                first_index = Some(0);
            }
            TriangleVariant::Prefixed => {
                let mut values = prefix.to_vec();
                values.extend_from_slice(&target);
                vertex_bytes = bytemuck::cast_slice(&values).to_vec();
                vertex_count = 3;
                first_vertex = 3;
                index_bytes = Some(bytemuck::cast_slice(&[0_u32, 0, 0, 0, 1, 2]).to_vec());
                index_format = Some(wgpu::IndexFormat::Uint32);
                index_count = Some(3);
                first_index = Some(3);
            }
            TriangleVariant::PaddedStride => {
                let padded = [
                    [-1.0_f32, -1.0, 0.0, 91.0],
                    [1.0, -1.0, 0.0, 92.0],
                    [0.0, 1.0, 0.0, 93.0],
                ];
                vertex_bytes = bytemuck::cast_slice(&padded).to_vec();
                vertex_stride = mem::size_of::<[f32; 4]>() as u64;
            }
            TriangleVariant::Float16x4 => {
                let vertices: [[u16; 4]; 3] = [
                    [0xbc00, 0xbc00, 0, 0x3c00],
                    [0x3c00, 0xbc00, 0, 0x4000],
                    [0, 0x3c00, 0, 0x4200],
                ];
                vertex_bytes = bytemuck::cast_slice(&vertices).to_vec();
                vertex_stride = mem::size_of::<[u16; 4]>() as u64;
                vertex_format = wgpu::VertexFormat::Float16x4;
            }
            TriangleVariant::BlasTransform => {
                ray_origin.x = 3.0;
                blas_flags |= wgpu::AccelerationStructureFlags::USE_TRANSFORM;
                transform_values = Some(affine_rows(Mat4::from_translation(Vec3::new(
                    3.0, 0.0, 0.0,
                ))));
            }
            TriangleVariant::PreferUpdate => {
                blas_flags |= wgpu::AccelerationStructureFlags::ALLOW_UPDATE;
                tlas_flags |= wgpu::AccelerationStructureFlags::ALLOW_UPDATE;
                update_mode = wgpu::AccelerationStructureUpdateMode::PreferUpdate;
            }
        }
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance variant vertices"),
            contents: &vertex_bytes,
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let index_buffer = index_bytes.as_ref().map(|bytes| {
            self.device.create_buffer_init(&BufferInitDescriptor {
                label: Some("forgeax conformance variant indices"),
                contents: bytes,
                usage: wgpu::BufferUsages::BLAS_INPUT,
            })
        });
        let transform_buffer = transform_values.as_ref().map(|values| {
            self.device.create_buffer_init(&BufferInitDescriptor {
                label: Some("forgeax conformance BLAS transform"),
                contents: bytemuck::cast_slice(values),
                usage: wgpu::BufferUsages::BLAS_INPUT,
            })
        });
        let geometry_size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format,
            vertex_count,
            index_format,
            index_count,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance variant BLAS"),
                flags: blas_flags,
                update_mode,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![geometry_size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance variant TLAS"),
            max_instances: 1,
            flags: tlas_flags,
            update_mode,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0x00_12_34,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &geometry_size,
                vertex_buffer: &vertex_buffer,
                first_vertex,
                vertex_stride,
                index_buffer: index_buffer.as_ref(),
                first_index,
                transform_buffer: transform_buffer.as_ref(),
                transform_buffer_offset: transform_buffer.as_ref().map(|_| 0),
            }]),
        };
        let ray = input_ray(ray_origin, Vec3::NEG_Z, 0xff);
        let resources = QueryResources::create(&self.device, &tlas, &[ray]);
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance triangle variant"),
            });
        encoder.build_acceleration_structures([&build_entry], [&tlas]);
        resources.encode_query(&mut encoder);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("{} poll failed: {error}", variant.name()))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("{} validation: {error}", variant.name()));
        }
        let observations = map_observations(&self.device, &resources.readback)?;
        let observation = observations
            .into_iter()
            .next()
            .ok_or_else(|| format!("{} produced no observation", variant.name()))?;
        let cpu_triangle = Triangle {
            vertices: [
                Vec3::new(-1.0 + ray_origin.x, -1.0, 0.0),
                Vec3::new(1.0 + ray_origin.x, -1.0, 0.0),
                Vec3::new(ray_origin.x, 1.0, 0.0),
            ],
        };
        let expected = intersect_triangle(
            Ray {
                origin: ray_origin,
                direction: Vec3::NEG_Z,
                t_min: 0.01,
                t_max: 10.0,
            },
            cpu_triangle,
        )
        .ok_or_else(|| format!("{} CPU oracle missed", variant.name()))?;
        if observation.kind != 1
            || observation.geometry_index != 0
            || observation.primitive_index != 0
            || !approximately_equal(observation.t, expected.t)
            || !approximately_equal(observation.barycentrics[0], expected.barycentrics[0])
            || !approximately_equal(observation.barycentrics[1], expected.barycentrics[1])
        {
            return Err(format!(
                "{} observation mismatch: {observation:?}",
                variant.name()
            ));
        }
        Ok(observation)
    }

    pub fn run_multi_geometry(&self) -> Result<GpuObservation, String> {
        let far_vertices: [f32; 9] = [20.0, 20.0, 0.0, 21.0, 20.0, 0.0, 20.0, 21.0, 0.0];
        let target_vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let far_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance far geometry"),
            contents: bytemuck::cast_slice(&far_vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let target_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance target geometry"),
            contents: bytemuck::cast_slice(&target_vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let geometry_sizes = [
            wgpu::BlasTriangleGeometrySizeDescriptor {
                vertex_format: wgpu::VertexFormat::Float32x3,
                vertex_count: 3,
                index_format: None,
                index_count: None,
                flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
            },
            wgpu::BlasTriangleGeometrySizeDescriptor {
                vertex_format: wgpu::VertexFormat::Float32x3,
                vertex_count: 3,
                index_format: None,
                index_count: None,
                flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
            },
        ];
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance multi-geometry BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: geometry_sizes.to_vec(),
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance multi-geometry TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![
                triangle_geometry(&geometry_sizes[0], &far_buffer),
                triangle_geometry(&geometry_sizes[1], &target_buffer),
            ]),
        };
        let resources = QueryResources::create(
            &self.device,
            &tlas,
            &[input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff)],
        );
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance multi-geometry"),
            });
        encoder.build_acceleration_structures([&build_entry], [&tlas]);
        resources.encode_query(&mut encoder);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("multi-geometry poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("multi-geometry validation: {error}"));
        }
        let observation = map_observations(&self.device, &resources.readback)?
            .into_iter()
            .next()
            .ok_or_else(|| "multi-geometry produced no observation".to_string())?;
        if observation.kind != 1
            || observation.geometry_index != 1
            || observation.primitive_index != 0
        {
            return Err(format!(
                "multi-geometry observation mismatch: {observation:?}"
            ));
        }
        Ok(observation)
    }

    pub fn validate_descriptor_mismatch(&self) -> Result<String, String> {
        let vertices: [f32; 9] = [0.0; 9];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance mismatch vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: Some(wgpu::IndexFormat::Uint32),
            index_count: Some(3),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance mismatch BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &size,
                vertex_buffer: &vertex_buffer,
                first_vertex: 0,
                vertex_stride: 12,
                index_buffer: None,
                first_index: None,
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        };
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance descriptor mismatch"),
            });
        encoder.build_acceleration_structures([&entry], []);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("descriptor mismatch poll failed: {error}"))?;
        let validation = pollster::block_on(scope.pop())
            .ok_or_else(|| "descriptor mismatch was accepted".to_string())?;
        self.run_triangle_variant(TriangleVariant::Uint32Indexed)
            .map_err(|error| format!("device health probe failed after mismatch: {error}"))?;
        Ok(format!("validation captured; device healthy: {validation}"))
    }

    pub fn validate_limit_overflow(&self) -> Result<String, String> {
        let maximum = self.environment.limits.max_tlas_instance_count;
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _invalid = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance TLAS limit overflow"),
            max_instances: maximum.saturating_add(1),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("limit overflow poll failed: {error}"))?;
        let validation = pollster::block_on(scope.pop())
            .ok_or_else(|| format!("TLAS max_instances {} was accepted", maximum + 1))?;
        self.run_triangle_variant(TriangleVariant::NonIndexed)
            .map_err(|error| format!("device health probe failed after overflow: {error}"))?;
        Ok(format!(
            "maxTlasInstanceCount={maximum}; validation captured; device healthy: {validation}"
        ))
    }

    pub fn run_candidate_semantics(&self) -> Result<Vec<GpuObservation>, String> {
        let vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance candidate vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance candidate BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance candidate TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0x00_ab_cd,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &vertex_buffer,
            )]),
        };
        let base = input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff);
        let mut rays = [base; 9];
        rays[0].flags_mask = [0x00, 0xff, 0, 0];
        rays[1].flags_mask = [0x00, 0xff, 1, 0];
        rays[2].flags_mask = [0x00, 0xff, 2, 0];
        rays[3].flags_mask = [0x20, 0xff, 0, 0];
        rays[4].flags_mask = [0x10, 0xff, 0, 0];
        rays[5].flags_mask = [0x100, 0xff, 0, 0];
        rays[6].flags_mask = [0x01, 0xff, 0, 0];
        rays[7].flags_mask = [0x02, 0xff, 0, 0];
        rays[8].flags_mask = [0x04, 0xff, 0, 0];
        let resources = QueryResources::create_with_shader(
            &self.device,
            &tlas,
            &rays,
            include_str!("candidate_observation.wgsl"),
        );
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance candidate semantics"),
            });
        encoder.build_acceleration_structures([&build_entry], [&tlas]);
        resources.encode_query(&mut encoder);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("candidate semantics poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("candidate semantics validation: {error}"));
        }
        let observations = map_observations(&self.device, &resources.readback)?;
        if observations.len() != rays.len() {
            return Err(format!(
                "candidate semantics expected {} observations, got {}",
                rays.len(),
                observations.len()
            ));
        }
        Ok(observations)
    }

    pub fn run_tlas_replacement(&self) -> Result<Vec<GpuObservation>, String> {
        let first_vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let second_vertices: [f32; 9] = [2.0, -1.0, 0.0, 4.0, -1.0, 0.0, 3.0, 1.0, 0.0];
        let first_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance replacement first vertices"),
            contents: bytemuck::cast_slice(&first_vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let second_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance replacement second vertices"),
            contents: bytemuck::cast_slice(&second_vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let make_blas = |label| {
            self.device.create_blas(
                &wgpu::CreateBlasDescriptor {
                    label: Some(label),
                    flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                    update_mode: wgpu::AccelerationStructureUpdateMode::Build,
                },
                wgpu::BlasGeometrySizeDescriptors::Triangles {
                    descriptors: vec![size.clone()],
                },
            )
        };
        let first_blas = make_blas("forgeax conformance replacement first BLAS");
        let second_blas = make_blas("forgeax conformance replacement second BLAS");
        let first_entry = wgpu::BlasBuildEntry {
            blas: &first_blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &first_buffer,
            )]),
        };
        let second_entry = wgpu::BlasBuildEntry {
            blas: &second_blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &second_buffer,
            )]),
        };
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance replacement TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &first_blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        tlas[0]
            .as_mut()
            .expect("replacement slot is populated")
            .set_blas(&second_blas);
        let rays = [
            input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff),
            input_ray(Vec3::new(3.0, 0.0, 2.0), Vec3::NEG_Z, 0xff),
        ];
        let resources = QueryResources::create(&self.device, &tlas, &rays);
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance replacement build"),
            });
        encoder.build_acceleration_structures([&first_entry, &second_entry], [&tlas]);
        resources.encode_query(&mut encoder);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("replacement poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("replacement validation: {error}"));
        }
        let observations = map_observations(&self.device, &resources.readback)?;
        if observations[0].kind != 0 || observations[1].kind != 1 {
            return Err(format!(
                "replacement observation mismatch: {observations:?}"
            ));
        }
        Ok(observations)
    }

    pub fn run_fragment_query(&self) -> Result<[u32; 4], String> {
        let vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance fragment vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance fragment BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance fragment TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0x00_a1_b2,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &vertex_buffer,
            )]),
        };
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forgeax conformance fragment observation shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("fragment_observation.wgsl").into()),
            });
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("forgeax conformance fragment Ray Query"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba32Uint,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
        let bindings = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forgeax conformance fragment bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::AccelerationStructure(&tlas),
            }],
        });
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forgeax conformance fragment output"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Uint,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance fragment readback"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance fragment encoder"),
            });
        encoder.build_acceleration_structures([&build_entry], [&tlas]);
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forgeax conformance fragment pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, Some(&bindings), &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(1),
                },
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("fragment query poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("fragment query validation: {error}"));
        }
        let (sender, receiver) = mpsc::channel();
        readback.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("fragment map poll failed: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|error| format!("fragment map callback timed out: {error}"))?
            .map_err(|error| format!("fragment map failed: {error}"))?;
        let mapped = readback
            .get_mapped_range(..16)
            .map_err(|error| format!("fragment mapped range failed: {error}"))?;
        let words: [u32; 4] = bytemuck::cast_slice::<u8, u32>(&mapped)
            .try_into()
            .map_err(|_| "fragment readback was not four words".to_string())?;
        drop(mapped);
        readback.unmap();
        Ok(words)
    }

    pub fn run_synchronized_blas_rebuild(&self) -> Result<Vec<GpuObservation>, String> {
        let outcome = self.execute_blas_rebuild(true)?;
        let observations = outcome
            .observations
            .ok_or_else(|| "synchronized rebuild produced no observations".to_string())?;
        if observations[0].kind != 0 || observations[1].kind != 1 {
            return Err(format!(
                "synchronized rebuild observation mismatch: {observations:?}"
            ));
        }
        Ok(observations)
    }

    pub fn validate_unsynchronized_blas_rebuild(&self) -> Result<String, String> {
        let outcome = self.execute_blas_rebuild(false)?;
        let validation = outcome
            .validation
            .ok_or_else(|| "BLAS rebuild without TLAS rebuild was accepted".to_string())?;
        self.run_triangle_variant(TriangleVariant::NonIndexed)
            .map_err(|error| format!("device health probe failed after stale TLAS: {error}"))?;
        Ok(format!("validation captured; device healthy: {validation}"))
    }

    pub fn run_aabb_candidate(&self) -> Result<GpuObservation, String> {
        let primitive = AabbPrimitive {
            minimum: [-1.0, -1.0, 0.0],
            maximum: [1.0, 1.0, 1.0],
        };
        let aabb_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance AABB input"),
            contents: bytemuck::bytes_of(&primitive),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasAABBGeometrySizeDescriptor {
            primitive_count: 1,
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        };
        self.execute_aabb_query(
            &aabb_buffer,
            &size,
            mem::size_of::<AabbPrimitive>() as u64,
            0,
        )
    }

    pub fn run_tlas_binding_array(&self) -> Result<Vec<GpuObservation>, String> {
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let scene = ReferenceScene::create(&self.device)?;
        let mut second = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance array second TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        second[0] = Some(wgpu::TlasInstance::new(
            &scene.blas,
            affine_rows(Mat4::from_translation(Vec3::new(0.0, 0.0, 0.5))),
            0x00_c3_d4,
            0xff,
        ));
        let ray = input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff);
        let resources = QueryResources::create_with_scenes(
            &self.device,
            &[&scene.tlas, &second],
            &[ray, ray],
            include_str!("binding_array_observation.wgsl"),
        );
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance array build/query"),
            });
        encode_build(&mut encoder, &scene);
        encoder.build_acceleration_structures([], [&second]);
        resources.encode_query_groups(&mut encoder, 2);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("TLAS array poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("TLAS array validation: {error}"));
        }
        let observations = map_observations(&self.device, &resources.readback)?;
        for (index, (data, t)) in [(0x00_a1_b2, 2.0), (0x00_c3_d4, 1.5)]
            .into_iter()
            .enumerate()
        {
            let hit = &observations[index];
            if hit.kind != 1
                || hit.instance_custom_data != data
                || !approximately_equal(hit.t, t)
                || hit.primitive_index != 0
                || hit.geometry_index != 0
                || !approximately_equal(hit.barycentrics[0], 0.25)
                || !approximately_equal(hit.barycentrics[1], 0.5)
            {
                return Err(format!("TLAS array element {index} mismatch: {hit:?}"));
            }
        }
        Ok(observations)
    }

    pub fn run_multiple_aabb_stride(&self) -> Result<GpuObservation, String> {
        let primitives = [
            PaddedAabbPrimitive {
                primitive: AabbPrimitive {
                    minimum: [4.0, -1.0, 0.0],
                    maximum: [6.0, 1.0, 1.0],
                },
                padding: [0.0; 2],
            },
            PaddedAabbPrimitive {
                primitive: AabbPrimitive {
                    minimum: [-1.0, -1.0, 0.0],
                    maximum: [1.0, 1.0, 1.0],
                },
                padding: [0.0; 2],
            },
        ];
        let mut bytes = 0_u64.to_ne_bytes().to_vec();
        bytes.extend_from_slice(bytemuck::cast_slice(&primitives));
        let aabb_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance padded AABB input"),
            contents: &bytes,
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasAABBGeometrySizeDescriptor {
            primitive_count: 2,
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        };
        self.execute_aabb_query(
            &aabb_buffer,
            &size,
            mem::size_of::<PaddedAabbPrimitive>() as u64,
            8,
        )
    }

    fn execute_aabb_query(
        &self,
        aabb_buffer: &wgpu::Buffer,
        size: &wgpu::BlasAABBGeometrySizeDescriptor,
        stride: u64,
        primitive_offset: u32,
    ) -> Result<GpuObservation, String> {
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance AABB BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::AABBs {
                descriptors: vec![size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance AABB TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
                size,
                stride,
                aabb_buffer,
                primitive_offset,
            }]),
        };
        let output = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance AABB observation"),
            size: OBSERVATION_SIZE as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance AABB readback"),
            size: OBSERVATION_SIZE as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forgeax conformance AABB shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("aabb_observation.wgsl").into()),
            });
        let pipeline = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("forgeax conformance AABB pipeline"),
                layout: None,
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let bindings = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forgeax conformance AABB bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::AccelerationStructure(&tlas),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance AABB encoder"),
            });
        encoder.build_acceleration_structures([&build_entry], [&tlas]);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forgeax conformance AABB query"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, Some(&bindings), &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, OBSERVATION_SIZE as u64);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("AABB poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("AABB validation: {error}"));
        }
        map_observations(&self.device, &readback)?
            .into_iter()
            .next()
            .ok_or_else(|| "AABB query produced no observation".to_string())
    }

    pub fn validate_invalid_aabb(&self) -> Result<String, String> {
        let primitive = AabbPrimitive {
            minimum: [-1.0; 3],
            maximum: [1.0; 3],
        };
        let aabb_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance invalid AABB input"),
            contents: bytemuck::bytes_of(&primitive),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasAABBGeometrySizeDescriptor {
            primitive_count: 1,
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance invalid AABB BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::AABBs {
                descriptors: vec![size.clone()],
            },
        );
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance invalid AABB encoder"),
            });
        encoder.build_acceleration_structures(
            [&wgpu::BlasBuildEntry {
                blas: &blas,
                geometry: wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
                    size: &size,
                    stride: wgpu::AABB_GEOMETRY_MIN_STRIDE + 1,
                    aabb_buffer: &aabb_buffer,
                    primitive_offset: 0,
                }]),
            }],
            [],
        );
        let _invalid = encoder.finish();
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("invalid AABB poll failed: {error}"))?;
        let validation = pollster::block_on(scope.pop())
            .ok_or_else(|| "invalid AABB stride was accepted".to_string())?;
        self.run_triangle_variant(TriangleVariant::NonIndexed)
            .map_err(|error| format!("device health probe failed after invalid AABB: {error}"))?;
        Ok(format!("validation captured; device healthy: {validation}"))
    }

    pub fn run_skip_aabb_mixed_scene(&self) -> Result<GpuObservation, String> {
        let aabb = AabbPrimitive {
            minimum: [-1.0, -1.0, 0.5],
            maximum: [1.0, 1.0, 1.0],
        };
        let aabb_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance mixed AABB input"),
            contents: bytemuck::bytes_of(&aabb),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let aabb_size = wgpu::BlasAABBGeometrySizeDescriptor {
            primitive_count: 1,
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        };
        let aabb_blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance mixed AABB BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::AABBs {
                descriptors: vec![aabb_size.clone()],
            },
        );
        let vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance mixed triangle input"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let triangle_size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let triangle_blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance mixed triangle BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![triangle_size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance mixed TLAS"),
            max_instances: 2,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &aabb_blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        tlas[1] = Some(wgpu::TlasInstance::new(
            &triangle_blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        let mut ray = input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff);
        ray.flags_mask[0] = 0x200;
        let resources = QueryResources::create(&self.device, &tlas, &[ray]);
        let aabb_entry = wgpu::BlasBuildEntry {
            blas: &aabb_blas,
            geometry: wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
                size: &aabb_size,
                stride: mem::size_of::<AabbPrimitive>() as u64,
                aabb_buffer: &aabb_buffer,
                primitive_offset: 0,
            }]),
        };
        let triangle_entry = wgpu::BlasBuildEntry {
            blas: &triangle_blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &triangle_size,
                &vertex_buffer,
            )]),
        };
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance mixed build/query"),
            });
        encoder.build_acceleration_structures([&aabb_entry, &triangle_entry], [&tlas]);
        resources.encode_query(&mut encoder);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("mixed AABB poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("mixed AABB validation: {error}"));
        }
        let observation = map_observations(&self.device, &resources.readback)?
            .into_iter()
            .next()
            .ok_or_else(|| "mixed AABB query produced no observation".to_string())?;
        if observation.kind != 1 || !approximately_equal(observation.t, 2.0) {
            return Err(format!(
                "SKIP_AABBS did not preserve triangle hit: {observation:?}"
            ));
        }
        Ok(observation)
    }

    pub fn run_compaction(&self) -> Result<GpuObservation, String> {
        let vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance compact vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance compact source BLAS"),
                flags: wgpu::AccelerationStructureFlags::ALLOW_COMPACTION
                    | wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &vertex_buffer,
            )]),
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance compaction source build"),
            });
        encoder.build_acceleration_structures([&build_entry], []);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("compaction source poll failed: {error}"))?;
        let (sender, receiver) = mpsc::channel();
        blas.prepare_compaction_async(move |result| {
            let _ = sender.send(result.map_err(|error| error.to_string()));
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("compaction preparation poll failed: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|error| format!("compaction callback timed out: {error}"))??;
        if !blas.ready_for_compaction() {
            return Err("BLAS callback completed but ready_for_compaction is false".to_string());
        }
        let compacted = self.queue.compact_blas(&blas);
        self.queue.submit([]);
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("compaction execution poll failed: {error}"))?;
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance compacted TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &compacted,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        let resources = QueryResources::create(
            &self.device,
            &tlas,
            &[input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff)],
        );
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut query = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance compacted query"),
            });
        query.build_acceleration_structures([], [&tlas]);
        resources.encode_query(&mut query);
        self.queue.submit(Some(query.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("compacted query poll failed: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("compacted query validation: {error}"));
        }
        let observation = map_observations(&self.device, &resources.readback)?
            .into_iter()
            .next()
            .ok_or_else(|| "compacted query produced no observation".to_string())?;
        if observation.kind != 1 || !approximately_equal(observation.t, 2.0) {
            return Err(format!("compacted observation mismatch: {observation:?}"));
        }
        Ok(observation)
    }

    pub fn validate_invalid_compaction(&self) -> Result<String, String> {
        let vertices: [f32; 9] = [0.0; 9];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance invalid compaction vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance invalid compaction BLAS"),
                flags: wgpu::AccelerationStructureFlags::ALLOW_COMPACTION,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &vertex_buffer,
            )]),
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance invalid compaction build"),
            });
        encoder.build_acceleration_structures([&entry], []);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("invalid compaction build poll failed: {error}"))?;
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _invalid = self.queue.compact_blas(&blas);
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("invalid compaction poll failed: {error}"))?;
        let validation = pollster::block_on(scope.pop())
            .ok_or_else(|| "unprepared BLAS compaction was accepted".to_string())?;
        self.run_triangle_variant(TriangleVariant::NonIndexed)
            .map_err(|error| format!("device health probe failed after compaction: {error}"))?;
        Ok(format!("validation captured; device healthy: {validation}"))
    }

    pub fn run_invalid_ray_robustness(&self) -> Result<String, String> {
        let vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance invalid-ray vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance invalid-ray BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance invalid-ray TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &vertex_buffer,
            )]),
        };
        let invalid = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance invalid-ray values"),
            contents: bytemuck::cast_slice(&[
                f32::NAN.to_bits(),
                f32::INFINITY.to_bits(),
                u32::MAX,
                0,
            ]),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forgeax conformance invalid-ray shader"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("invalid_ray_observation.wgsl").into(),
                ),
            });
        let pipeline = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("forgeax conformance invalid-ray pipeline"),
                layout: None,
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let bindings = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forgeax conformance invalid-ray bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::AccelerationStructure(&tlas),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: invalid.as_entire_binding(),
                },
            ],
        });
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance invalid-ray encoder"),
            });
        encoder.build_acceleration_structures([&build_entry], [&tlas]);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forgeax conformance invalid-ray query"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, Some(&bindings), &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("invalid-ray device loss or poll failure: {error}"))?;
        if let Some(error) = pollster::block_on(scope.pop()) {
            return Err(format!("invalid-ray uncaptured validation: {error}"));
        }
        self.run_triangle_variant(TriangleVariant::NonIndexed)
            .map_err(|error| format!("device health probe failed after invalid rays: {error}"))?;
        Ok("NaN, infinity, zero direction, reversed t range, and invalid flags caused no device loss; device remained healthy".to_string())
    }

    fn execute_blas_rebuild(&self, synchronize_tlas: bool) -> Result<RebuildOutcome, String> {
        let initial_vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let rebuilt_vertices: [f32; 9] = [2.0, -1.0, 0.0, 4.0, -1.0, 0.0, 3.0, 1.0, 0.0];
        let vertex_buffer = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance rebuild vertices"),
            contents: bytemuck::cast_slice(&initial_vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("forgeax conformance rebuild BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance rebuild TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0,
            0xff,
        ));
        let build_entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![triangle_geometry(
                &size,
                &vertex_buffer,
            )]),
        };
        let mut initial = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance initial rebuild scene"),
            });
        initial.build_acceleration_structures([&build_entry], [&tlas]);
        self.queue.submit(Some(initial.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("initial rebuild scene poll failed: {error}"))?;
        self.queue
            .write_buffer(&vertex_buffer, 0, bytemuck::cast_slice(&rebuilt_vertices));
        let resources = QueryResources::create(
            &self.device,
            &tlas,
            &[
                input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0xff),
                input_ray(Vec3::new(3.0, 0.0, 2.0), Vec3::NEG_Z, 0xff),
            ],
        );
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forgeax conformance BLAS rebuild"),
            });
        if synchronize_tlas {
            encoder.build_acceleration_structures([&build_entry], [&tlas]);
        } else {
            encoder.build_acceleration_structures([&build_entry], []);
        }
        resources.encode_query(&mut encoder);
        self.queue.submit(Some(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("BLAS rebuild poll failed: {error}"))?;
        let validation = pollster::block_on(scope.pop()).map(|error| error.to_string());
        if synchronize_tlas {
            if let Some(error) = validation {
                return Err(format!("synchronized rebuild validation: {error}"));
            }
            Ok(RebuildOutcome {
                observations: Some(map_observations(&self.device, &resources.readback)?),
                validation: None,
            })
        } else {
            Ok(RebuildOutcome {
                observations: None,
                validation,
            })
        }
    }

    fn execute_schedule(
        &self,
        scene: &ReferenceScene,
        schedule: BuildSchedule,
    ) -> Result<(), String> {
        match schedule {
            BuildSchedule::OneEncoder => {
                let mut encoder =
                    self.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("forgeax conformance one-encoder"),
                        });
                encode_build(&mut encoder, scene);
                encode_query(&mut encoder, scene);
                self.queue.submit(Some(encoder.finish()));
            }
            BuildSchedule::OrderedCommandBuffers => {
                let mut build =
                    self.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("forgeax conformance ordered build"),
                        });
                encode_build(&mut build, scene);
                let mut query =
                    self.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("forgeax conformance ordered query"),
                        });
                encode_query(&mut query, scene);
                self.queue.submit([build.finish(), query.finish()]);
            }
            BuildSchedule::SeparateSubmitAndPoll => {
                let mut build =
                    self.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("forgeax conformance separate build"),
                        });
                encode_build(&mut build, scene);
                self.queue.submit(Some(build.finish()));
                self.device
                    .poll(wgpu::PollType::wait_indefinitely())
                    .map_err(|error| format!("build poll failed: {error}"))?;
                let mut query =
                    self.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("forgeax conformance separate query"),
                        });
                encode_query(&mut query, scene);
                self.queue.submit(Some(query.finish()));
            }
        }
        Ok(())
    }
}

fn triangle_geometry<'a>(
    size: &'a wgpu::BlasTriangleGeometrySizeDescriptor,
    vertex_buffer: &'a wgpu::Buffer,
) -> wgpu::BlasTriangleGeometry<'a> {
    wgpu::BlasTriangleGeometry {
        size,
        vertex_buffer,
        first_vertex: 0,
        vertex_stride: 12,
        index_buffer: None,
        first_index: None,
        transform_buffer: None,
        transform_buffer_offset: None,
    }
}

struct QueryResources {
    _rays: wgpu::Buffer,
    output: wgpu::Buffer,
    readback: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    bindings: wgpu::BindGroup,
    count: usize,
}

impl QueryResources {
    fn create(device: &wgpu::Device, tlas: &wgpu::Tlas, rays: &[InputRay]) -> Self {
        Self::create_with_shader(device, tlas, rays, include_str!("core_observation.wgsl"))
    }

    fn create_with_shader(
        device: &wgpu::Device,
        tlas: &wgpu::Tlas,
        rays: &[InputRay],
        shader_source: &'static str,
    ) -> Self {
        Self::create_with_scenes(device, &[tlas], rays, shader_source)
    }

    fn create_with_scenes(
        device: &wgpu::Device,
        scenes: &[&wgpu::Tlas],
        rays: &[InputRay],
        shader_source: &'static str,
    ) -> Self {
        let ray_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance scenario rays"),
            contents: bytemuck::cast_slice(rays),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let size = (rays.len() * OBSERVATION_SIZE) as u64;
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance scenario observations"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance scenario readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forgeax conformance observation shader"),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("forgeax conformance scenario pipeline"),
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forgeax conformance scenario bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: if scenes.len() == 1 {
                        wgpu::BindingResource::AccelerationStructure(scenes[0])
                    } else {
                        wgpu::BindingResource::AccelerationStructureArray(scenes)
                    },
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: ray_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        Self {
            _rays: ray_buffer,
            output,
            readback,
            pipeline,
            bindings,
            count: rays.len(),
        }
    }

    fn encode_query(&self, encoder: &mut wgpu::CommandEncoder) {
        self.encode_query_groups(encoder, (self.count as u32).div_ceil(4));
    }

    fn encode_query_groups(&self, encoder: &mut wgpu::CommandEncoder, groups: u32) {
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forgeax conformance scenario query"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, Some(&self.bindings), &[]);
            pass.dispatch_workgroups(groups, 1, 1);
        }
        encoder.copy_buffer_to_buffer(
            &self.output,
            0,
            &self.readback,
            0,
            (self.count * OBSERVATION_SIZE) as u64,
        );
    }
}

impl ReferenceScene {
    fn create(device: &wgpu::Device) -> Result<Self, String> {
        let vertices: [f32; 9] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let indices: [u32; 3] = [0, 1, 2];
        let vertex_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance triangle vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let index_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance triangle indices"),
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
                label: Some("forgeax conformance triangle BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![geometry_size.clone()],
            },
        );
        let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("forgeax conformance reference TLAS"),
            max_instances: 2,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::IDENTITY),
            0x00_a1_b2,
            0x01,
        ));
        tlas[1] = Some(wgpu::TlasInstance::new(
            &blas,
            affine_rows(Mat4::from_translation(Vec3::new(3.0, 0.0, 0.0))),
            0x00_ff_ff_ff,
            0x02,
        ));
        let rays = [
            input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0x01),
            input_ray(Vec3::new(3.0, 0.0, 2.0), Vec3::NEG_Z, 0x02),
            input_ray(Vec3::new(0.0, 3.0, 2.0), Vec3::NEG_Z, 0xff),
            input_ray(Vec3::new(0.0, 0.0, 2.0), Vec3::NEG_Z, 0x02),
        ];
        let ray_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("forgeax conformance rays"),
            contents: bytemuck::cast_slice(&rays),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance observations"),
            size: (RAY_COUNT * OBSERVATION_SIZE) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forgeax conformance observation readback"),
            size: (RAY_COUNT * OBSERVATION_SIZE) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("core_observation.wgsl"));
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("forgeax conformance core observation"),
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forgeax conformance core bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::AccelerationStructure(&tlas),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: ray_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        Ok(Self {
            _vertices: vertex_buffer,
            _indices: index_buffer,
            blas,
            tlas,
            geometry_size,
            _rays: ray_buffer,
            output,
            readback,
            pipeline,
            bindings,
        })
    }

    fn build_entry(&self) -> wgpu::BlasBuildEntry<'_> {
        wgpu::BlasBuildEntry {
            blas: &self.blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &self.geometry_size,
                vertex_buffer: &self._vertices,
                first_vertex: 0,
                vertex_stride: mem::size_of::<[f32; 3]>() as u64,
                index_buffer: Some(&self._indices),
                first_index: Some(0),
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        }
    }
}

fn encode_build(encoder: &mut wgpu::CommandEncoder, scene: &ReferenceScene) {
    encoder.build_acceleration_structures(Some(&scene.build_entry()), Some(&scene.tlas));
}

fn encode_query(encoder: &mut wgpu::CommandEncoder, scene: &ReferenceScene) {
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("forgeax conformance query"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&scene.pipeline);
        pass.set_bind_group(0, Some(&scene.bindings), &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(
        &scene.output,
        0,
        &scene.readback,
        0,
        (RAY_COUNT * OBSERVATION_SIZE) as u64,
    );
}

fn map_observations(
    device: &wgpu::Device,
    readback: &wgpu::Buffer,
) -> Result<Vec<GpuObservation>, String> {
    let (sender, receiver) = mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("observation map poll failed: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|error| format!("observation map callback timed out: {error}"))?
        .map_err(|error| format!("observation map failed: {error}"))?;
    let mapped = readback
        .get_mapped_range(..)
        .map_err(|error| format!("observation mapped range failed: {error}"))?;
    let observations = bytemuck::cast_slice::<u8, GpuObservation>(&mapped).to_vec();
    drop(mapped);
    readback.unmap();
    Ok(observations)
}

fn validate_reference_observations(observations: &[GpuObservation]) -> Result<(), String> {
    if observations.len() != RAY_COUNT {
        return Err(format!(
            "expected {RAY_COUNT} observations, got {}",
            observations.len()
        ));
    }
    let triangle = Triangle {
        vertices: [
            Vec3::new(-1.0, -1.0, 0.0),
            Vec3::new(1.0, -1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        ],
    };
    let expected = intersect_triangle(
        Ray {
            origin: Vec3::new(0.0, 0.0, 2.0),
            direction: Vec3::NEG_Z,
            t_min: 0.01,
            t_max: 10.0,
        },
        triangle,
    )
    .ok_or_else(|| "CPU triangle oracle unexpectedly missed".to_string())?;
    for (index, custom_data, instance_index) in [(0, 0x00_a1_b2, 0), (1, 0x00_ff_ff_ff, 1)] {
        let actual = &observations[index];
        if actual.kind != 1
            || actual.instance_custom_data != custom_data
            || actual.instance_index != instance_index
            || actual.geometry_index != 0
            || actual.primitive_index != 0
            || !approximately_equal(actual.t, expected.t)
            || !approximately_equal(actual.barycentrics[0], expected.barycentrics[0])
            || !approximately_equal(actual.barycentrics[1], expected.barycentrics[1])
        {
            return Err(format!("ray {index} observation mismatch: {actual:?}"));
        }
    }
    for index in [2, 3] {
        if observations[index].kind != 0 {
            return Err(format!(
                "ray {index} expected NONE, got {:?}",
                observations[index]
            ));
        }
    }
    let translated = &observations[1];
    if !approximately_equal(translated.object_to_world[3][0], 3.0)
        || !approximately_equal(translated.world_to_object[3][0], -3.0)
    {
        return Err(format!(
            "instance transform mismatch: object_to_world={:?} world_to_object={:?}",
            translated.object_to_world, translated.world_to_object
        ));
    }
    Ok(())
}

fn input_ray(origin: Vec3, direction: Vec3, mask: u32) -> InputRay {
    InputRay {
        origin_t_min: [origin.x, origin.y, origin.z, 0.01],
        direction_t_max: [direction.x, direction.y, direction.z, 10.0],
        flags_mask: [0, mask, 0, 0],
    }
}

fn affine_rows(transform: Mat4) -> [f32; 12] {
    transform.transpose().to_cols_array()[..12]
        .try_into()
        .expect("Mat4 always contains 16 values")
}

fn hash_observations(observations: &[GpuObservation]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytemuck::cast_slice::<GpuObservation, u8>(observations) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn environment_snapshot(
    capabilities: NativeCapabilities,
    features: wgpu::Features,
    limits: &wgpu::Limits,
) -> EnvironmentSnapshot {
    let names = features
        .iter_names()
        .map(|(name, _)| name.to_string())
        .collect();
    EnvironmentSnapshot {
        wgpu_version: WGPU_VERSION.to_string(),
        wgpu_tag: format!("v{WGPU_VERSION}"),
        wgpu_tag_commit: WGPU_TAG_COMMIT.to_string(),
        wgpu_source_commit: option_env!("FORGEAX_WGPU_SOURCE_COMMIT")
            .map(str::to_string)
            .unwrap_or_else(|| command_output("git", &["rev-parse", "HEAD:third_party/wgpu"])),
        engine_commit: command_output("git", &["rev-parse", "HEAD"]),
        rustc: command_output("rustc", &["--version"]),
        os: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        capabilities,
        features: FeatureSnapshot {
            names,
            experimental_ray_query: features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            experimental_ray_hit_vertex_return: features
                .contains(wgpu::Features::EXPERIMENTAL_RAY_HIT_VERTEX_RETURN),
            extended_acceleration_structure_vertex_formats: features
                .contains(wgpu::Features::EXTENDED_ACCELERATION_STRUCTURE_VERTEX_FORMATS),
            acceleration_structure_binding_array: features
                .contains(wgpu::Features::ACCELERATION_STRUCTURE_BINDING_ARRAY),
            experimental_ray_tracing_pipelines: features
                .contains(wgpu::Features::EXPERIMENTAL_RAY_TRACING_PIPELINES),
            timestamp_query: features.contains(wgpu::Features::TIMESTAMP_QUERY),
        },
        limits: AccelerationStructureLimits {
            max_blas_primitive_count: limits.max_blas_primitive_count,
            max_blas_geometry_count: limits.max_blas_geometry_count,
            max_tlas_instance_count: limits.max_tlas_instance_count,
            max_acceleration_structures_per_shader_stage: limits
                .max_acceleration_structures_per_shader_stage,
            max_buffers_and_acceleration_structures_per_shader_stage: limits
                .max_buffers_and_acceleration_structures_per_shader_stage,
            max_binding_array_acceleration_structure_elements_per_shader_stage: limits
                .max_binding_array_acceleration_structure_elements_per_shader_stage,
        },
    }
}

fn command_output(program: &str, arguments: &[&str]) -> String {
    Command::new(program)
        .args(arguments)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|output| !output.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn backend_name() -> &'static str {
    REQUIRED_BACKEND_NAME
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_layouts_match_wgsl_contract() {
        assert_eq!(mem::size_of::<InputRay>(), 48);
        assert_eq!(mem::size_of::<GpuObservation>(), OBSERVATION_SIZE);
        assert_eq!(mem::offset_of!(GpuObservation, barycentrics), 32);
        assert_eq!(mem::offset_of!(GpuObservation, front_face), 40);
        assert_eq!(mem::offset_of!(GpuObservation, object_to_world), 48);
    }

    #[test]
    fn affine_rows_matches_wgpu_row_major_contract() {
        assert_eq!(
            affine_rows(Mat4::IDENTITY),
            [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        );
        let translated = affine_rows(Mat4::from_translation(Vec3::new(3.0, 2.0, 1.0)));
        assert_eq!(
            [translated[3], translated[7], translated[11]],
            [3.0, 2.0, 1.0]
        );
    }

    #[test]
    fn every_conformance_shader_parses_and_validates_with_naga_30() {
        for (name, source) in [
            ("core", include_str!("core_observation.wgsl")),
            ("candidate", include_str!("candidate_observation.wgsl")),
            ("fragment", include_str!("fragment_observation.wgsl")),
            ("aabb", include_str!("aabb_observation.wgsl")),
            (
                "binding-array",
                include_str!("binding_array_observation.wgsl"),
            ),
            ("invalid-ray", include_str!("invalid_ray_observation.wgsl")),
        ] {
            let module = naga::front::wgsl::parse_str(source)
                .unwrap_or_else(|error| panic!("{name} WGSL parse failed: {error}"));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .unwrap_or_else(|error| panic!("{name} WGSL validation failed: {error}"));
        }
    }
}
