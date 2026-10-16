//! RHI-shaped acceleration structures over native wgpu.
//!
//! Mirrors the `@forgeax/engine-rhi` Ray Query vocabulary (`ray-query.ts`): `caps.rayQuery`
//! derives from the device's features and limits, BLAS/TLAS descriptors keep the TypeScript
//! field shapes, and lowering to wgpu is a field rename. Validation applies the same rules as
//! the TypeScript validators (limits, whole triangle lists, creation-time topology, 24-bit
//! custom index, BLAS built before or with the TLAS that instances it), so a future
//! TypeScript-to-native command consumer maps one-to-one. Raw wgpu handles stay crate-private.

use crate::NativeError;
use std::cell::Cell;

/// Admitted acceleration-structure limits (`RhiRayQueryLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RayQueryLimits {
    pub max_blas_geometry_count: u32,
    pub max_blas_primitive_count: u32,
    pub max_tlas_instance_count: u32,
    pub max_acceleration_structures_per_shader_stage: u32,
}

/// `caps.rayQuery` of a native device. Native wgpu only reaches `adapter-lacks-feature`;
/// `backend-has-no-ray-query` belongs to the browser backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RayQueryCaps {
    AdapterLacksFeature,
    Supported(RayQueryLimits),
}

impl RayQueryCaps {
    /// Derive the capability from the features and limits a device was created with.
    pub fn from_device(features: wgpu::Features, limits: &wgpu::Limits) -> Self {
        if !features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
            return Self::AdapterLacksFeature;
        }
        Self::Supported(RayQueryLimits {
            max_blas_geometry_count: limits.max_blas_geometry_count,
            max_blas_primitive_count: limits.max_blas_primitive_count,
            max_tlas_instance_count: limits.max_tlas_instance_count,
            max_acceleration_structures_per_shader_stage: limits
                .max_acceleration_structures_per_shader_stage,
        })
    }

    fn limits(&self, operation: &str) -> Result<&RayQueryLimits, NativeError> {
        match self {
            Self::Supported(limits) => Ok(limits),
            Self::AdapterLacksFeature => Err(invalid(format!(
                "{operation} requires caps.rayQuery.supported; reason='adapter-lacks-feature'"
            ))),
        }
    }
}

/// `BLAS_INPUT_BUFFER_USAGE` of `@forgeax/engine-rhi`: the RHI extension bit outside the W3C
/// `GPUBufferUsage` range, equal to `wgpu::BufferUsages::BLAS_INPUT`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const BLAS_INPUT_BUFFER_USAGE: u32 = 0x400;
/// The W3C `GPUBufferUsage` bits (`MAP_READ` .. `QUERY_RESOLVE`), identical in wgpu.
const W3C_BUFFER_USAGE: u32 = 0x3ff;

/// Lower an RHI buffer usage mask to wgpu. The W3C bits and `BLAS_INPUT_BUFFER_USAGE` map by
/// identity; the BLAS-input bit requires `caps.rayQuery.supported` and any other bit is refused,
/// matching `validateRayQueryBufferUsage`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn buffer_usages(
    caps: &RayQueryCaps,
    usage: u32,
) -> Result<wgpu::BufferUsages, NativeError> {
    if usage & !(W3C_BUFFER_USAGE | BLAS_INPUT_BUFFER_USAGE) != 0 {
        return Err(invalid(format!(
            "buffer usage {usage:#x} has bits outside GPUBufferUsage and BLAS_INPUT_BUFFER_USAGE"
        )));
    }
    if usage & BLAS_INPUT_BUFFER_USAGE != 0 {
        caps.limits("a buffer with BLAS_INPUT_BUFFER_USAGE")?;
    }
    wgpu::BufferUsages::from_bits(usage)
        .ok_or_else(|| invalid(format!("buffer usage {usage:#x} has no wgpu lowering")))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum BuildPreference {
    #[default]
    FastTrace,
    #[cfg_attr(not(test), allow(dead_code))]
    FastBuild,
}

/// `'rebuild'` always performs a full build; `'refit'` admits an in-place update. wgpu 30
/// accepts the update request but still performs a full build, which is behaviourally equal.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum UpdateMode {
    #[default]
    Rebuild,
    #[cfg_attr(not(test), allow(dead_code))]
    Refit,
}

/// Creation-time size of one opaque `float32x3` triangle geometry.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TriangleGeometrySize {
    pub vertex_count: u32,
    pub index: Option<(wgpu::IndexFormat, u32)>,
}

pub(crate) struct BlasDescriptor<'a> {
    pub label: Option<&'a str>,
    pub geometries: Vec<TriangleGeometrySize>,
    pub preference: BuildPreference,
    pub update_mode: UpdateMode,
}

pub(crate) struct TlasDescriptor<'a> {
    pub label: Option<&'a str>,
    pub max_instances: u32,
    pub preference: BuildPreference,
    pub update_mode: UpdateMode,
}

/// Build-time data of one declared geometry.
pub(crate) struct TriangleGeometry<'a> {
    pub vertex_buffer: &'a wgpu::Buffer,
    pub first_vertex: u32,
    pub vertex_stride: u64,
    pub index: Option<(&'a wgpu::Buffer, u32)>,
}

/// One instance: 3x4 row-major object-to-world transform, 24-bit custom index, 8-bit mask.
pub(crate) struct TlasInstance<'a> {
    pub blas: &'a Blas,
    pub transform: [f32; 12],
    pub custom_index: u32,
    pub mask: u8,
}

pub(crate) struct BlasBuild<'a> {
    pub blas: &'a Blas,
    pub geometries: Vec<TriangleGeometry<'a>>,
}

pub(crate) struct TlasBuild<'a> {
    pub tlas: &'a mut Tlas,
    pub instances: Vec<TlasInstance<'a>>,
}

pub(crate) struct Blas {
    raw: wgpu::Blas,
    sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor>,
    built: Cell<bool>,
}

pub(crate) struct Tlas {
    raw: wgpu::Tlas,
    max_instances: u32,
}

impl Tlas {
    /// The bindable wgpu resource (`acceleration_structure` in WGSL).
    pub fn binding(&self) -> wgpu::BindingResource<'_> {
        wgpu::BindingResource::AccelerationStructure(&self.raw)
    }
}

fn invalid(detail: impl Into<String>) -> NativeError {
    NativeError::Render {
        detail: detail.into(),
    }
}

fn lower(
    preference: BuildPreference,
    update_mode: UpdateMode,
) -> (
    wgpu::AccelerationStructureFlags,
    wgpu::AccelerationStructureUpdateMode,
) {
    let mut flags = match preference {
        BuildPreference::FastTrace => wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        BuildPreference::FastBuild => wgpu::AccelerationStructureFlags::PREFER_FAST_BUILD,
    };
    let mode = match update_mode {
        UpdateMode::Rebuild => wgpu::AccelerationStructureUpdateMode::Build,
        UpdateMode::Refit => {
            flags |= wgpu::AccelerationStructureFlags::ALLOW_UPDATE;
            wgpu::AccelerationStructureUpdateMode::PreferUpdate
        }
    };
    (flags, mode)
}

pub(crate) fn create_blas(
    device: &wgpu::Device,
    caps: &RayQueryCaps,
    desc: &BlasDescriptor,
) -> Result<Blas, NativeError> {
    let limits = caps.limits("create_blas")?;
    let count = desc.geometries.len();
    if count == 0 || count > limits.max_blas_geometry_count as usize {
        return Err(invalid(format!(
            "BLAS needs 1..{} geometries, got {count}",
            limits.max_blas_geometry_count
        )));
    }
    let mut primitives = 0_u64;
    for (index, size) in desc.geometries.iter().enumerate() {
        let elements = size.index.map_or(size.vertex_count, |(_, count)| count);
        if size.vertex_count < 3 || elements < 3 || elements % 3 != 0 {
            return Err(invalid(format!(
                "geometries[{index}] is not a whole triangle list"
            )));
        }
        primitives += u64::from(elements / 3);
    }
    if primitives > u64::from(limits.max_blas_primitive_count) {
        return Err(invalid(format!(
            "BLAS admits at most {} triangles, got {primitives}",
            limits.max_blas_primitive_count
        )));
    }
    let sizes: Vec<_> = desc
        .geometries
        .iter()
        .map(|size| wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: size.vertex_count,
            index_format: size.index.map(|(format, _)| format),
            index_count: size.index.map(|(_, count)| count),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        })
        .collect();
    let (flags, update_mode) = lower(desc.preference, desc.update_mode);
    let raw = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: desc.label,
            flags,
            update_mode,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: sizes.clone(),
        },
    );
    Ok(Blas {
        raw,
        sizes,
        built: Cell::new(false),
    })
}

pub(crate) fn create_tlas(
    device: &wgpu::Device,
    caps: &RayQueryCaps,
    desc: &TlasDescriptor,
) -> Result<Tlas, NativeError> {
    let limits = caps.limits("create_tlas")?;
    if desc.max_instances == 0 || desc.max_instances > limits.max_tlas_instance_count {
        return Err(invalid(format!(
            "maxInstances must be in 1..{}, got {}",
            limits.max_tlas_instance_count, desc.max_instances
        )));
    }
    let (flags, update_mode) = lower(desc.preference, desc.update_mode);
    let raw = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: desc.label,
        max_instances: desc.max_instances,
        flags,
        update_mode,
    });
    Ok(Tlas {
        raw,
        max_instances: desc.max_instances,
    })
}

/// Encode BLAS builds first, then TLAS builds. Every TLAS instance must reference a BLAS
/// built earlier or in this call; re-building a TLAS is how instance transforms update.
pub(crate) fn build_acceleration_structures(
    encoder: &mut wgpu::CommandEncoder,
    blas: &[BlasBuild],
    tlas: &mut [TlasBuild],
) -> Result<(), NativeError> {
    for (entry_index, entry) in blas.iter().enumerate() {
        if entry.geometries.len() != entry.blas.sizes.len() {
            return Err(invalid(format!(
                "blas[{entry_index}] supplies {} geometries for {} declared; topology is fixed at creation",
                entry.geometries.len(),
                entry.blas.sizes.len()
            )));
        }
        for (index, (geometry, size)) in entry.geometries.iter().zip(&entry.blas.sizes).enumerate()
        {
            if geometry.index.is_some() != size.index_format.is_some() {
                return Err(invalid(format!(
                    "blas[{entry_index}].geometries[{index}] index presence disagrees with its declaration"
                )));
            }
            if geometry.vertex_stride < 12 || geometry.vertex_stride % 4 != 0 {
                return Err(invalid(format!(
                    "blas[{entry_index}].geometries[{index}] vertexStride must be >= 12 and a multiple of 4"
                )));
            }
            let inputs = std::iter::once(geometry.vertex_buffer)
                .chain(geometry.index.map(|(buffer, _)| buffer));
            if inputs
                .into_iter()
                .any(|buffer| !buffer.usage().contains(wgpu::BufferUsages::BLAS_INPUT))
            {
                return Err(invalid(format!(
                    "blas[{entry_index}].geometries[{index}] binds a buffer without BLAS_INPUT_BUFFER_USAGE"
                )));
            }
        }
    }
    for (entry_index, entry) in tlas.iter().enumerate() {
        if entry.instances.len() > entry.tlas.max_instances as usize {
            return Err(invalid(format!(
                "tlas[{entry_index}] has {} instances for maxInstances {}",
                entry.instances.len(),
                entry.tlas.max_instances
            )));
        }
        for (index, instance) in entry.instances.iter().enumerate() {
            let pending = blas
                .iter()
                .any(|build| std::ptr::eq(build.blas, instance.blas));
            if !instance.blas.built.get() && !pending {
                return Err(invalid(format!(
                    "tlas[{entry_index}].instances[{index}] references a BLAS that was never built"
                )));
            }
            if instance.custom_index >= 1 << 24 || instance.transform.iter().any(|v| !v.is_finite())
            {
                return Err(invalid(format!(
                    "tlas[{entry_index}].instances[{index}] needs a 24-bit customIndex and a finite transform"
                )));
            }
        }
    }

    for entry in tlas.iter_mut() {
        let slots = entry.tlas.max_instances as usize;
        for slot in 0..slots {
            entry.tlas.raw[slot] = entry.instances.get(slot).map(|instance| {
                wgpu::TlasInstance::new(
                    &instance.blas.raw,
                    instance.transform,
                    instance.custom_index,
                    instance.mask,
                )
            });
        }
    }
    let raw_blas: Vec<_> = blas
        .iter()
        .map(|entry| wgpu::BlasBuildEntry {
            blas: &entry.blas.raw,
            geometry: wgpu::BlasGeometries::TriangleGeometries(
                entry
                    .geometries
                    .iter()
                    .zip(&entry.blas.sizes)
                    .map(|(geometry, size)| wgpu::BlasTriangleGeometry {
                        size,
                        vertex_buffer: geometry.vertex_buffer,
                        first_vertex: geometry.first_vertex,
                        vertex_stride: geometry.vertex_stride,
                        index_buffer: geometry.index.map(|(buffer, _)| buffer),
                        first_index: geometry.index.map(|(_, first)| first),
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    })
                    .collect(),
            ),
        })
        .collect();
    encoder
        .build_acceleration_structures(raw_blas.iter(), tlas.iter().map(|entry| &entry.tlas.raw));
    for entry in blas {
        entry.blas.built.set(true);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::device::{create_native_instance, request_native_device, select_native_adapter};
    use glam::{Vec3, Vec4};
    use std::sync::mpsc;
    use std::time::Duration;
    use wgpu::util::{BufferInitDescriptor, DeviceExt};

    const SHADER: &str = r#"
enable wgpu_ray_query;
struct Ray { origin: vec3f, mask: u32, direction: vec3f, t_max: f32 }
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> rays: array<Ray>;
@group(0) @binding(2) var<storage, read_write> hits: array<vec4u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  let ray = rays[id.x];
  var query: ray_query;
  rayQueryInitialize(&query, scene, RayDesc(0u, ray.mask, 0.0, ray.t_max, ray.origin, ray.direction));
  while (rayQueryProceed(&query)) {}
  let hit = rayQueryGetCommittedIntersection(&query);
  if (hit.kind == 1u) {
    hits[id.x] = vec4u(1u, hit.instance_custom_data, hit.primitive_index, bitcast<u32>(hit.t));
  } else {
    hits[id.x] = vec4u(0u, 0u, 0u, 0u);
  }
}
"#;

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct GpuRay {
        origin: [f32; 3],
        mask: u32,
        direction: [f32; 3],
        t_max: f32,
    }

    /// Two triangles of the unit quad in z=0, indexed.
    const INDICES: [u16; 6] = [0, 1, 2, 0, 2, 3];

    fn quad(z: f32) -> [[f32; 3]; 4] {
        [[-1., -1., z], [1., -1., z], [1., 1., z], [-1., 1., z]]
    }

    struct OracleInstance {
        transform: [f32; 12],
        custom_index: u32,
        mask: u8,
    }

    fn apply(transform: &[f32; 12], p: [f32; 3]) -> Vec3 {
        let p = Vec4::new(p[0], p[1], p[2], 1.0);
        Vec3::new(
            Vec4::from_slice(&transform[0..4]).dot(p),
            Vec4::from_slice(&transform[4..8]).dot(p),
            Vec4::from_slice(&transform[8..12]).dot(p),
        )
    }

    /// Moller-Trumbore, double-sided; returns t.
    fn intersect(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Option<f32> {
        let (e1, e2) = (b - a, c - a);
        let p = direction.cross(e2);
        let det = e1.dot(p);
        if det.abs() < 1e-8 {
            return None;
        }
        let s = origin - a;
        let u = s.dot(p) / det;
        let q = s.cross(e1);
        let v = direction.dot(q) / det;
        if !(0.0..=1.0).contains(&u) || v < 0.0 || u + v > 1.0 {
            return None;
        }
        Some(e2.dot(q) / det)
    }

    /// Nearest committed hit as `[hit, customIndex, primitiveIndex, t]`.
    fn oracle(
        vertices: &[[f32; 3]; 4],
        instances: &[OracleInstance],
        ray: &GpuRay,
    ) -> Option<(u32, u32, f32)> {
        let origin = Vec3::from(ray.origin);
        let direction = Vec3::from(ray.direction);
        let mut best: Option<(u32, u32, f32)> = None;
        for instance in instances {
            if u32::from(instance.mask) & ray.mask == 0 {
                continue;
            }
            for (primitive, triangle) in INDICES.chunks_exact(3).enumerate() {
                let [a, b, c] =
                    [0, 1, 2].map(|i| apply(&instance.transform, vertices[triangle[i] as usize]));
                if let Some(t) = intersect(origin, direction, a, b, c) {
                    if t >= 0.0 && t <= ray.t_max && best.is_none_or(|(_, _, best_t)| t < best_t) {
                        best = Some((instance.custom_index, primitive as u32, t));
                    }
                }
            }
        }
        best
    }

    fn rays() -> Vec<GpuRay> {
        let mut rays = Vec::new();
        for mask in [0xff, 0x01, 0x02] {
            for y in -6..=6 {
                for x in -6..=10 {
                    rays.push(GpuRay {
                        origin: [x as f32 * 0.37 + 0.011, y as f32 * 0.37 + 0.013, -1.0],
                        mask,
                        direction: [0.0, 0.0, 1.0],
                        t_max: 100.0,
                    });
                }
            }
        }
        rays
    }

    pub(crate) struct Gpu {
        pub(crate) device: wgpu::Device,
        pub(crate) queue: wgpu::Queue,
        pub(crate) caps: RayQueryCaps,
    }

    /// A Ray Query device, or `None` (skip) unless `FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1`.
    pub(crate) fn gpu() -> Option<Gpu> {
        let required = std::env::var("FORGEAX_REQUIRE_NATIVE_RAY_QUERY").as_deref() == Ok("1");
        let attempt = pollster::block_on(async {
            let instance = create_native_instance()?;
            let selected = select_native_adapter(&instance, None).await?;
            if !selected.capabilities.ray_query {
                return Err(invalid(format!(
                    "adapter '{}' lacks EXPERIMENTAL_RAY_QUERY",
                    selected.capabilities.adapter.name
                )));
            }
            let limits =
                wgpu::Limits::default().using_minimum_supported_acceleration_structure_values();
            let (device, queue) = request_native_device(
                &selected.adapter,
                wgpu::Features::EXPERIMENTAL_RAY_QUERY,
                limits,
            )
            .await?;
            let caps = RayQueryCaps::from_device(device.features(), &device.limits());
            Ok::<_, NativeError>(Gpu {
                device,
                queue,
                caps,
            })
        });
        match attempt {
            Ok(gpu) => Some(gpu),
            Err(error) if !required => {
                eprintln!("skipping native Ray Query GPU test: {error}");
                None
            }
            Err(error) => panic!("FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1 but {error}"),
        }
    }

    fn trace(gpu: &Gpu, tlas: &Tlas, rays: &[GpuRay]) -> Vec<[u32; 4]> {
        let device = &gpu.device;
        let ray_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("rq-test.rays"),
            contents: bytemuck::cast_slice(rays),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let size = rays.len() as u64 * 16;
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rq-test.hits"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rq-test.readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rq-test"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("rq-test"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("rq-test"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: tlas.binding(),
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
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, Some(&bindings), &[]);
            pass.dispatch_workgroups((rays.len() as u32).div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, size);
        gpu.queue.submit([encoder.finish()]);
        let (tx, rx) = mpsc::channel();
        readback.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = tx.send(result);
        });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap();
        let hits =
            bytemuck::cast_slice::<u8, [u32; 4]>(&readback.get_mapped_range(..).unwrap()).to_vec();
        readback.unmap();
        hits
    }

    fn assert_matches_oracle(
        hits: &[[u32; 4]],
        rays: &[GpuRay],
        vertices: &[[f32; 3]; 4],
        instances: &[OracleInstance],
    ) -> usize {
        let mut hit_count = 0;
        for (index, (hit, ray)) in hits.iter().zip(rays).enumerate() {
            match oracle(vertices, instances, ray) {
                None => assert_eq!(hit[0], 0, "ray {index} expected a miss, got {hit:?}"),
                Some((custom, primitive, t)) => {
                    hit_count += 1;
                    assert_eq!(hit[0], 1, "ray {index} expected a hit");
                    assert_eq!(hit[1], custom, "ray {index} custom index");
                    // Rays sample away from the shared diagonal, so the primitive is unambiguous.
                    assert_eq!(hit[2], primitive, "ray {index} primitive index");
                    let gpu_t = f32::from_bits(hit[3]);
                    assert!(
                        (gpu_t - t).abs() <= 1e-4 * t.max(1.0),
                        "ray {index}: {gpu_t} vs {t}"
                    );
                }
            }
        }
        hit_count
    }

    #[test]
    fn caps_derive_from_device_features_and_limits() {
        let limits =
            wgpu::Limits::default().using_minimum_supported_acceleration_structure_values();
        assert_eq!(
            RayQueryCaps::from_device(wgpu::Features::empty(), &limits),
            RayQueryCaps::AdapterLacksFeature
        );
        let RayQueryCaps::Supported(admitted) =
            RayQueryCaps::from_device(wgpu::Features::EXPERIMENTAL_RAY_QUERY, &limits)
        else {
            panic!("feature present must report supported");
        };
        assert_eq!(
            admitted.max_tlas_instance_count,
            limits.max_tlas_instance_count
        );
        assert_eq!(
            admitted.max_blas_primitive_count,
            limits.max_blas_primitive_count
        );
    }

    #[test]
    fn oracle_hits_the_expected_quad_triangle() {
        let instances = [OracleInstance {
            transform: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 5.],
            custom_index: 7,
            mask: 1,
        }];
        let ray = GpuRay {
            origin: [0.5, -0.4, 0.0],
            mask: 0xff,
            direction: [0., 0., 1.],
            t_max: 100.,
        };
        assert_eq!(oracle(&quad(0.0), &instances, &ray), Some((7, 0, 5.0)));
        let miss = GpuRay {
            origin: [2.0, 0.0, 0.0],
            ..ray
        };
        assert_eq!(oracle(&quad(0.0), &instances, &miss), None);
    }

    #[test]
    fn buffer_usage_lowering_is_identity_and_gates_blas_input() {
        let supported = RayQueryCaps::Supported(RayQueryLimits {
            max_blas_geometry_count: 1,
            max_blas_primitive_count: 1,
            max_tlas_instance_count: 1,
            max_acceleration_structures_per_shader_stage: 1,
        });
        assert_eq!(
            BLAS_INPUT_BUFFER_USAGE,
            wgpu::BufferUsages::BLAS_INPUT.bits()
        );
        assert_eq!(
            buffer_usages(&supported, BLAS_INPUT_BUFFER_USAGE | 0x8).unwrap(),
            wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST
        );
        for bit in 0..10 {
            let usage = 1_u32 << bit;
            assert_eq!(
                buffer_usages(&RayQueryCaps::AdapterLacksFeature, usage)
                    .unwrap()
                    .bits(),
                usage
            );
        }
        assert!(
            buffer_usages(&RayQueryCaps::AdapterLacksFeature, BLAS_INPUT_BUFFER_USAGE).is_err()
        );
        assert!(buffer_usages(&supported, wgpu::BufferUsages::TLAS_INPUT.bits()).is_err());
    }

    #[test]
    fn indexed_two_instance_scene_matches_cpu_oracle_and_refits() {
        let Some(gpu) = gpu() else { return };
        let device = &gpu.device;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut vertices = quad(0.0);
        let vertex_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("rq-test.vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST,
        });
        let index_buffer = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("rq-test.indices"),
            contents: bytemuck::cast_slice(&INDICES),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let blas = create_blas(
            device,
            &gpu.caps,
            &BlasDescriptor {
                label: Some("rq-test.blas"),
                geometries: vec![TriangleGeometrySize {
                    vertex_count: 4,
                    index: Some((wgpu::IndexFormat::Uint16, 6)),
                }],
                preference: BuildPreference::FastBuild,
                update_mode: UpdateMode::Refit,
            },
        )
        .unwrap();
        let mut tlas = create_tlas(
            device,
            &gpu.caps,
            &TlasDescriptor {
                label: Some("rq-test.tlas"),
                max_instances: 4,
                preference: BuildPreference::FastTrace,
                update_mode: UpdateMode::Refit,
            },
        )
        .unwrap();
        let geometry = || TriangleGeometry {
            vertex_buffer: &vertex_buffer,
            first_vertex: 0,
            vertex_stride: 12,
            index: Some((&index_buffer, 0)),
        };
        let mut oracle_instances = vec![
            OracleInstance {
                transform: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 5.],
                custom_index: 10,
                mask: 0x01,
            },
            OracleInstance {
                transform: [2., 0., 0., 2.5, 0., 2., 0., 0., 0., 0., 2., 8.],
                custom_index: 20,
                mask: 0x02,
            },
        ];
        let instances = |oracle: &[OracleInstance], blas| {
            oracle
                .iter()
                .map(|instance| TlasInstance {
                    blas,
                    transform: instance.transform,
                    custom_index: instance.custom_index,
                    mask: instance.mask,
                })
                .collect::<Vec<_>>()
        };

        // A TLAS cannot instance a BLAS that has never been built.
        let mut encoder = device.create_command_encoder(&Default::default());
        assert!(build_acceleration_structures(
            &mut encoder,
            &[],
            &mut [TlasBuild {
                tlas: &mut tlas,
                instances: instances(&oracle_instances, &blas),
            }],
        )
        .is_err());

        let mut encoder = device.create_command_encoder(&Default::default());
        build_acceleration_structures(
            &mut encoder,
            &[BlasBuild {
                blas: &blas,
                geometries: vec![geometry()],
            }],
            &mut [TlasBuild {
                tlas: &mut tlas,
                instances: instances(&oracle_instances, &blas),
            }],
        )
        .unwrap();
        gpu.queue.submit([encoder.finish()]);
        let rays = rays();
        let hits = trace(&gpu, &tlas, &rays);
        let first = assert_matches_oracle(&hits, &rays, &vertices, &oracle_instances);
        assert!(first > 50, "scene must produce hits, got {first}");

        // Refit: move the geometry and one instance; the same handles rebuild in place.
        vertices = quad(0.5);
        gpu.queue
            .write_buffer(&vertex_buffer, 0, bytemuck::cast_slice(&vertices));
        oracle_instances[0].transform = [1., 0., 0., -0.5, 0., 1., 0., 0.25, 0., 0., 1., 9.];
        let mut encoder = device.create_command_encoder(&Default::default());
        build_acceleration_structures(
            &mut encoder,
            &[BlasBuild {
                blas: &blas,
                geometries: vec![geometry()],
            }],
            &mut [TlasBuild {
                tlas: &mut tlas,
                instances: instances(&oracle_instances, &blas),
            }],
        )
        .unwrap();
        gpu.queue.submit([encoder.finish()]);
        let hits = trace(&gpu, &tlas, &rays);
        let second = assert_matches_oracle(&hits, &rays, &vertices, &oracle_instances);
        assert!(second > 50, "refit scene must produce hits, got {second}");

        // TLAS-only rebuild with one instance clears the remaining slots.
        let mut encoder = device.create_command_encoder(&Default::default());
        oracle_instances.truncate(1);
        build_acceleration_structures(
            &mut encoder,
            &[],
            &mut [TlasBuild {
                tlas: &mut tlas,
                instances: instances(&oracle_instances, &blas),
            }],
        )
        .unwrap();
        gpu.queue.submit([encoder.finish()]);
        let hits = trace(&gpu, &tlas, &rays);
        assert_matches_oracle(&hits, &rays, &vertices, &oracle_instances);
        if let Some(error) = pollster::block_on(scope.pop()) {
            panic!("wgpu validation error: {error}");
        }
    }

    #[test]
    fn create_refuses_unsupported_caps_and_malformed_topology() {
        let Some(gpu) = gpu() else { return };
        let triangle = |vertex_count, index| TriangleGeometrySize {
            vertex_count,
            index,
        };
        let blas = |geometries| BlasDescriptor {
            label: None,
            geometries,
            preference: BuildPreference::default(),
            update_mode: UpdateMode::default(),
        };
        let unsupported = RayQueryCaps::AdapterLacksFeature;
        assert!(create_blas(&gpu.device, &unsupported, &blas(vec![triangle(3, None)])).is_err());
        assert!(create_blas(&gpu.device, &gpu.caps, &blas(vec![])).is_err());
        assert!(create_blas(&gpu.device, &gpu.caps, &blas(vec![triangle(4, None)])).is_err());
        assert!(create_blas(
            &gpu.device,
            &gpu.caps,
            &blas(vec![triangle(4, Some((wgpu::IndexFormat::Uint32, 5)))])
        )
        .is_err());
        let tlas = |max_instances| TlasDescriptor {
            label: None,
            max_instances,
            preference: BuildPreference::default(),
            update_mode: UpdateMode::default(),
        };
        assert!(create_tlas(&gpu.device, &gpu.caps, &tlas(0)).is_err());
        assert!(create_tlas(&gpu.device, &gpu.caps, &tlas(u32::MAX)).is_err());
        assert!(create_tlas(&gpu.device, &gpu.caps, &tlas(1)).is_ok());
    }
}
