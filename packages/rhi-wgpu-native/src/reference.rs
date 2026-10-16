//! Bounded world-space opaque query transport. Inputs are the u32 words of the
//! portable reference's captured storage buffers; acceleration structures are
//! rebuilt on a fresh native device. This is scene re-execution, not native tape replay.
use crate::acceleration::{
    build_acceleration_structures, create_blas, create_tlas, BlasBuild, BlasDescriptor,
    BuildPreference, RayQueryCaps, TlasBuild, TlasDescriptor, TlasInstance, TriangleGeometry,
    TriangleGeometrySize, UpdateMode,
};
use crate::device::{create_native_instance, request_native_device, select_native_adapter};
use crate::{NativeCapabilities, NativeError, WGPU_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc;
use std::time::Duration;
use wgpu::util::{BufferInitDescriptor, DeviceExt};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceBatch {
    pub triangles: Vec<[u32; 20]>,
    pub rays: Vec<[u32; 12]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceResult {
    pub wgpu_version: &'static str,
    pub capabilities: NativeCapabilities,
    /// Eight u32 words per hit; final four words encode t, u, v, front-face f32.
    pub hits: Vec<[u32; 8]>,
}

fn invalid(detail: impl Into<String>) -> NativeError {
    NativeError::Render {
        detail: detail.into(),
    }
}

fn validate(batch: &ReferenceBatch) -> Result<(), NativeError> {
    if batch.triangles.len() > 65_536 || batch.rays.is_empty() || batch.rays.len() > 65_536 {
        return Err(invalid(
            "reference limit: at most 65536 triangles and 1..65536 rays",
        ));
    }
    let mut instances = BTreeMap::new();
    let mut primitives = BTreeSet::new();
    for t in &batch.triangles {
        if !primitives.insert((t[12], t[14])) {
            return Err(invalid("duplicate primitive identity"));
        }
        if t[12] == u32::MAX
            || t[16] > 255
            || [3, 7, 11, 17, 18, 19].iter().any(|&i| t[i] != 0)
            || t[..12].iter().any(|&v| !f32::from_bits(v).is_finite())
        {
            return Err(invalid("invalid triangle record"));
        }
        let a = glam::Vec3::new(
            f32::from_bits(t[0]),
            f32::from_bits(t[1]),
            f32::from_bits(t[2]),
        );
        let b = glam::Vec3::new(
            f32::from_bits(t[4]),
            f32::from_bits(t[5]),
            f32::from_bits(t[6]),
        );
        let c = glam::Vec3::new(
            f32::from_bits(t[8]),
            f32::from_bits(t[9]),
            f32::from_bits(t[10]),
        );
        if (b.as_dvec3() - a.as_dvec3())
            .cross(c.as_dvec3() - a.as_dvec3())
            .length_squared()
            == 0.0
        {
            return Err(invalid("degenerate triangle"));
        }
        if let Some(previous) = instances.insert(t[12], (t[13], t[16])) {
            if previous != (t[13], t[16]) {
                return Err(invalid("instance geometry/mask disagreement"));
            }
        }
    }
    if instances.len() > 1024 {
        return Err(invalid("reference instance limit exceeded"));
    }
    for r in &batch.rays {
        let min = f32::from_bits(r[3]);
        let max = f32::from_bits(r[7]);
        if r[..8].iter().any(|&v| !f32::from_bits(v).is_finite())
            || min < 0.0
            || max <= min
            || r[4..7].iter().all(|&v| f32::from_bits(v) == 0.0)
            || r[8] > 255
            || r[9..].iter().any(|&v| v != 0)
        {
            return Err(invalid("invalid ray record"));
        }
    }
    Ok(())
}

pub async fn run_batch(batch: ReferenceBatch) -> Result<ReferenceResult, NativeError> {
    validate(&batch)?;
    let instance = create_native_instance()?;
    let selected = select_native_adapter(&instance, None).await?;
    if !selected.capabilities.ray_query {
        return Err(NativeError::RayQueryUnsupported {
            detail: "opaque query requires EXPERIMENTAL_RAY_QUERY".into(),
            capabilities: Box::new(selected.capabilities),
        });
    }
    let mut groups: BTreeMap<u32, Vec<&[u32; 20]>> = BTreeMap::new();
    for triangle in &batch.triangles {
        groups.entry(triangle[12]).or_default().push(triangle);
    }
    let limits = wgpu::Limits::default().using_minimum_supported_acceleration_structure_values();
    if groups.len() > limits.max_tlas_instance_count as usize
        || groups
            .values()
            .any(|g| g.len() > limits.max_blas_primitive_count as usize)
    {
        return Err(invalid(
            "batch exceeds admitted acceleration structure limits",
        ));
    }
    let (device, queue) = request_native_device(
        &selected.adapter,
        wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        limits,
    )
    .await?;
    let caps = RayQueryCaps::from_device(device.features(), &device.limits());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut vertices = Vec::new();
    let mut blases = Vec::new();
    let mut identities = Vec::<[u32; 4]>::new();
    let mut offsets = Vec::new();
    for triangles in groups.values() {
        let mut points = Vec::<[f32; 3]>::new();
        offsets.push(identities.len() as u32);
        for t in triangles {
            for offset in [0, 4, 8] {
                points.push([
                    f32::from_bits(t[offset]),
                    f32::from_bits(t[offset + 1]),
                    f32::from_bits(t[offset + 2]),
                ]);
            }
            identities.push([t[12], t[13], t[14], t[15]]);
        }
        vertices.push(device.create_buffer_init(&BufferInitDescriptor {
            label: Some("ray-reference.vertices"),
            contents: bytemuck::cast_slice(&points),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        }));
        blases.push(create_blas(
            &device,
            &caps,
            &BlasDescriptor {
                label: Some("ray-reference.blas"),
                geometries: vec![TriangleGeometrySize {
                    vertex_count: points.len() as u32,
                    index: None,
                }],
                preference: BuildPreference::FastTrace,
                update_mode: UpdateMode::Rebuild,
            },
        )?);
    }
    let mut tlas = create_tlas(
        &device,
        &caps,
        &TlasDescriptor {
            label: Some("ray-reference.tlas"),
            max_instances: groups.len().max(1) as u32,
            preference: BuildPreference::FastTrace,
            update_mode: UpdateMode::Rebuild,
        },
    )?;
    let instances = groups
        .values()
        .enumerate()
        .map(|(i, group)| TlasInstance {
            blas: &blases[i],
            transform: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.],
            custom_index: offsets[i],
            mask: group[0][16] as u8,
        })
        .collect();
    if identities.is_empty() {
        identities.push([0; 4]);
    }
    let ray_buffer = device.create_buffer_init(&BufferInitDescriptor {
        label: Some("ray-reference.rays"),
        contents: bytemuck::cast_slice(&batch.rays),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let identity_buffer = device.create_buffer_init(&BufferInitDescriptor {
        label: Some("ray-reference.identities"),
        contents: bytemuck::cast_slice(&identities),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let byte_size = batch.rays.len() as u64 * 32;
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ray-reference.hits"),
        size: byte_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ray-reference.readback"),
        size: byte_size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let shader = device.create_shader_module(wgpu::include_wgsl!("reference.wgsl"));
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("ray-reference"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ray-reference"),
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
                resource: identity_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: output.as_entire_binding(),
            },
        ],
    });
    let builds: Vec<_> = blases
        .iter()
        .zip(&vertices)
        .map(|(blas, vertex_buffer)| BlasBuild {
            blas,
            geometries: vec![TriangleGeometry {
                vertex_buffer,
                first_vertex: 0,
                vertex_stride: 12,
                index: None,
            }],
        })
        .collect();
    let mut encoder = device.create_command_encoder(&Default::default());
    build_acceleration_structures(
        &mut encoder,
        &builds,
        &mut [TlasBuild {
            tlas: &mut tlas,
            instances,
        }],
    )?;
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("ray-reference"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, Some(&bindings), &[]);
        pass.dispatch_workgroups((batch.rays.len() as u32).div_ceil(64), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, byte_size);
    queue.submit([encoder.finish()]);
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| invalid(e.to_string()))?;
    if let Some(error) = scope.pop().await {
        return Err(invalid(error.to_string()));
    }
    let (tx, rx) = mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = tx.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| invalid(e.to_string()))?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|e| invalid(e.to_string()))?
        .map_err(|e| invalid(e.to_string()))?;
    let mapped = readback
        .get_mapped_range(..)
        .map_err(|e| invalid(e.to_string()))?;
    let hits = bytemuck::cast_slice::<u8, [u32; 8]>(&mapped).to_vec();
    drop(mapped);
    readback.unmap();
    Ok(ReferenceResult {
        wgpu_version: WGPU_VERSION,
        capabilities: selected.capabilities,
        hits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_records_before_gpu_creation() {
        let mut batch = ReferenceBatch {
            triangles: vec![],
            rays: vec![[0; 12]],
        };
        assert!(validate(&batch).is_err());
        batch.rays[0][6] = (-1.0f32).to_bits();
        batch.rays[0][7] = 10.0f32.to_bits();
        assert!(validate(&batch).is_ok());
        batch.rays[0][8] = 256;
        assert!(validate(&batch).is_err());
    }
    #[test]
    fn shader_validates_with_pinned_naga() {
        let module = naga::front::wgsl::parse_str(include_str!("reference.wgsl")).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
}
