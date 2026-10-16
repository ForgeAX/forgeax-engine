//! A bounded same-input, paired GPU query benchmark; not an Engine GI benchmark.
use bytemuck::{Pod, Zeroable};
use serde_json::{json, Value};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
use wgpu::util::{BufferInitDescriptor, DeviceExt};

const WARMUP: u32 = 5;
const SAMPLES: u32 = 31;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Triangle {
    vertices: [[f32; 4]; 3],
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Ray {
    origin: [f32; 4],
    direction: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Node {
    minimum: [f32; 3],
    left: u32,
    maximum: [f32; 3],
    right: u32,
}

fn build_nodes(triangles: &[Triangle], start: usize, end: usize, nodes: &mut Vec<Node>) -> u32 {
    let index = nodes.len() as u32;
    let mut minimum = [f32::INFINITY; 3];
    let mut maximum = [f32::NEG_INFINITY; 3];
    for triangle in &triangles[start..end] {
        for vertex in triangle.vertices {
            for axis in 0..3 {
                minimum[axis] = minimum[axis].min(vertex[axis]);
                maximum[axis] = maximum[axis].max(vertex[axis]);
            }
        }
    }
    nodes.push(Node {
        minimum,
        left: start as u32,
        maximum,
        right: u32::MAX,
    });
    if end - start > 1 {
        let mid = start + (end - start) / 2;
        let left = build_nodes(triangles, start, mid, nodes);
        let right = build_nodes(triangles, mid, end, nodes);
        nodes[index as usize].left = left;
        nodes[index as usize].right = right;
    }
    index
}

fn read(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Result<Vec<u8>, String> {
    let (sender, receiver) = mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| e.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let result = buffer
        .get_mapped_range(..)
        .map_err(|error| error.to_string())?
        .to_vec();
    buffer.unmap();
    Ok(result)
}

fn verify(bytes: &[u8], count: u32, triangles: u32, empty: bool) -> Result<String, String> {
    if bytes.len() != count as usize * 16 {
        return Err("incomplete benchmark readback".into());
    }
    let mut hash = 0xcbf29ce484222325u64;
    for (index, value) in bytes.chunks_exact(16).enumerate() {
        let words: Vec<_> = value
            .chunks_exact(4)
            .map(|w| u32::from_le_bytes(w.try_into().unwrap()))
            .collect();
        let hit = !empty && index % 4 != 0;
        let primitive = (index as u32 * 17) % triangles;
        let distance = f32::from_bits(words[2]);
        if words[0] != u32::from(hit)
            || words[3] != 0
            || (hit
                && (words[1] != primitive
                    || !distance.is_finite()
                    || (distance - 2.0).abs() > 0.00001))
            || (!hit && words != [0, 0, 0, 0])
        {
            return Err(format!(
                "ray {index}: expected hit={hit} primitive={primitive} t=2, got {words:?}"
            ));
        }
        for b in value {
            hash = (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("{hash:016x}"))
}

fn compare_pairs(first: &[u8], second: &[u8], exact: bool) -> Result<Value, String> {
    if first.len() != second.len() || exact && first != second {
        return Err("paired hardware readbacks differ".into());
    }
    let mut different_distances = 0;
    let mut max_delta = 0.0f32;
    for (index, (a, b)) in first
        .chunks_exact(16)
        .zip(second.chunks_exact(16))
        .enumerate()
    {
        if a[..8] != b[..8] || a[12..] != b[12..] {
            return Err(format!(
                "paired kind/primitive/status differs at ray {index}"
            ));
        }
        let a_t = u32::from_le_bytes(a[8..12].try_into().unwrap());
        let b_t = u32::from_le_bytes(b[8..12].try_into().unwrap());
        let delta = (f32::from_bits(a_t) - f32::from_bits(b_t)).abs();
        if !delta.is_finite() || delta > 1.0e-5 {
            return Err(format!(
                "paired distance differs at ray {index}: {a_t:#x} / {b_t:#x}"
            ));
        }
        different_distances += u32::from(a_t != b_t);
        max_delta = max_delta.max(delta);
    }
    Ok(
        json!({"differentDistanceWords":different_distances,"maxDistanceDelta":max_delta,"distanceEpsilon":if exact {0.0} else {1.0e-5},"kindAndPrimitiveExact":true}),
    )
}

fn distribution(pairs: &[[u64; 2]], period: f32) -> Result<Value, String> {
    let mut ns = Vec::new();
    let mut previous_end = 0;
    for &[start, end] in pairs {
        if start == 0 || end <= start || start <= previous_end {
            return Err(format!("invalid timestamp pair [{start}, {end}]"));
        }
        ns.push((end - start) as f64 * f64::from(period));
        previous_end = end;
    }
    if !period.is_finite() || period <= 0.0 || ns.is_empty() {
        return Err("invalid timestamp period/samples".into());
    }
    let mut sorted = ns.clone();
    sorted.sort_by(f64::total_cmp);
    Ok(
        json!({"rawTicks":pairs.iter().map(|pair|pair.map(|tick|tick.to_string())).collect::<Vec<_>>(),"rawTickEncoding":"decimal-string-u64","timestampPeriodNs":period,"samplesNs":ns,
        "medianNs":sorted[sorted.len()/2],"p95Ns":sorted[((sorted.len() as f64 * 0.95).ceil() as usize-1).min(sorted.len()-1)]}),
    )
}

struct Timer {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
}
impl Timer {
    fn new(device: &wgpu::Device) -> Self {
        Self {
            set: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("paired benchmark timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 4,
            }),
            resolve: device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 32,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            readback: device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 32,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
        }
    }
    fn resolve(&self, encoder: &mut wgpu::CommandEncoder, count: u32) {
        encoder.resolve_query_set(&self.set, 0..count, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.readback, 0, u64::from(count) * 8);
    }
    fn pairs(&self, device: &wgpu::Device) -> Result<[[u64; 2]; 2], String> {
        let bytes = read(device, &self.readback)?;
        let ticks: Vec<_> = bytes
            .chunks_exact(8)
            .map(|w| u64::from_le_bytes(w.try_into().unwrap()))
            .collect();
        Ok([[ticks[0], ticks[1]], [ticks[2], ticks[3]]])
    }
}

struct Query {
    pipeline: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    output: wgpu::Buffer,
    readback: wgpu::Buffer,
}
impl Query {
    fn new(
        device: &wgpu::Device,
        shader: &wgpu::ShaderModule,
        entry: &str,
        tlas: &wgpu::Tlas,
        rays: &wgpu::Buffer,
        triangles: &wgpu::Buffer,
        nodes: &wgpu::Buffer,
    ) -> Self {
        let output_size = rays.size() / std::mem::size_of::<Ray>() as u64 * 16;
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: None,
            module: shader,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            cache: None,
        });
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(entry),
            size: output_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: output_size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 1,
                resource: rays.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output.as_entire_binding(),
            },
        ];
        if entry == "hardware" {
            entries.push(wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::AccelerationStructure(tlas),
            });
        } else {
            entries.extend([
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: triangles.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: nodes.as_entire_binding(),
                },
            ]);
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(entry),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        Self {
            pipeline,
            group,
            output,
            readback,
        }
    }
    fn encode(&self, encoder: &mut wgpu::CommandEncoder, timer: &Timer, offset: u32, count: u32) {
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: Some(wgpu::ComputePassTimestampWrites {
                    query_set: &timer.set,
                    beginning_of_pass_write_index: Some(offset),
                    end_of_pass_write_index: Some(offset + 1),
                }),
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, Some(&self.group), &[]);
            pass.dispatch_workgroups(count.div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&self.output, 0, &self.readback, 0, u64::from(count) * 16);
    }
}

pub fn run(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    side: u32,
    ray_count: u32,
    compact: bool,
    evidence_directory: &std::path::Path,
) -> Result<Value, String> {
    std::fs::create_dir_all(evidence_directory).map_err(|error| error.to_string())?;
    let save = |name: &str, bytes: &[u8]| {
        std::fs::write(evidence_directory.join(name), bytes).map_err(|error| error.to_string())
    };
    let primitive_count = side * side;
    if primitive_count > device.limits().max_blas_primitive_count
        || ray_count.div_ceil(64) > device.limits().max_compute_workgroups_per_dimension
    {
        return Err("benchmark corpus exceeds actual device limits".into());
    }
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let triangles: Vec<_> = (0..primitive_count)
        .map(|i| {
            let x = (i % side) as f32;
            let y = (i / side) as f32;
            Triangle {
                vertices: [
                    [x, y, 0.0, 0.0],
                    [x + 0.8, y, 0.0, 0.0],
                    [x, y + 0.8, 0.0, 0.0],
                ],
            }
        })
        .collect();
    let vertices: Vec<_> = triangles
        .iter()
        .flat_map(|t| t.vertices.iter().flat_map(|v| v[..3].iter().copied()))
        .collect();
    let rays: Vec<_> = (0..ray_count)
        .map(|i| {
            let primitive = (i * 17) % primitive_count;
            let coordinate = if i % 4 == 0 { 0.9 } else { 0.2 };
            Ray {
                origin: [
                    (primitive % side) as f32 + coordinate,
                    (primitive / side) as f32 + coordinate,
                    2.0,
                    0.0,
                ],
                direction: [0.0, 0.0, -1.0, 0.0],
            }
        })
        .collect();
    let cpu_started = Instant::now();
    let mut nodes = Vec::with_capacity(primitive_count as usize * 2 - 1);
    build_nodes(&triangles, 0, triangles.len(), &mut nodes);
    let cpu_build_ms = cpu_started.elapsed().as_secs_f64() * 1000.0;
    save("triangles.bin", bytemuck::cast_slice(&triangles))?;
    save("rays.bin", bytemuck::cast_slice(&rays))?;
    save("nodes.bin", bytemuck::cast_slice(&nodes))?;
    let buffer = |label, bytes: &[u8], usage| {
        device.create_buffer_init(&BufferInitDescriptor {
            label: Some(label),
            contents: bytes,
            usage,
        })
    };
    let vertex_buffer = buffer(
        "benchmark vertices",
        bytemuck::cast_slice(&vertices),
        wgpu::BufferUsages::BLAS_INPUT,
    );
    let triangle_buffer = buffer(
        "benchmark triangles",
        bytemuck::cast_slice(&triangles),
        wgpu::BufferUsages::STORAGE,
    );
    let node_buffer = buffer(
        "benchmark software BVH",
        bytemuck::cast_slice(&nodes),
        wgpu::BufferUsages::STORAGE,
    );
    let ray_buffer = buffer(
        "benchmark shared rays",
        bytemuck::cast_slice(&rays),
        wgpu::BufferUsages::STORAGE,
    );
    let geometry_size = wgpu::BlasTriangleGeometrySizeDescriptor {
        vertex_format: wgpu::VertexFormat::Float32x3,
        vertex_count: primitive_count * 3,
        index_format: None,
        index_count: None,
        flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
    };
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("benchmark source BLAS"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
                | if compact {
                    wgpu::AccelerationStructureFlags::ALLOW_COMPACTION
                } else {
                    wgpu::AccelerationStructureFlags::empty()
                },
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: vec![geometry_size.clone()],
        },
    );
    let make_tlas = |blas: &wgpu::Blas, empty: bool| {
        let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("benchmark TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        if !empty {
            tlas[0] = Some(wgpu::TlasInstance::new(
                blas,
                [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                0,
                255,
            ));
        }
        tlas
    };
    let tlas = make_tlas(&blas, false);
    let timer = Timer::new(device);
    let mut build_pairs = Vec::new();
    for sample in 0..WARMUP + SAMPLES {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.write_timestamp(&timer.set, 0);
        encoder.build_acceleration_structures(
            [&wgpu::BlasBuildEntry {
                blas: &blas,
                geometry: wgpu::BlasGeometries::TriangleGeometries(vec![
                    wgpu::BlasTriangleGeometry {
                        size: &geometry_size,
                        vertex_buffer: &vertex_buffer,
                        first_vertex: 0,
                        vertex_stride: 12,
                        index_buffer: None,
                        first_index: None,
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    },
                ]),
            }],
            [&tlas],
        );
        encoder.write_timestamp(&timer.set, 1);
        timer.resolve(&mut encoder, 2);
        queue.submit(Some(encoder.finish()));
        let pair = timer.pairs(device)?[0];
        if sample >= WARMUP {
            build_pairs.push(pair);
        }
    }
    let shader = device.create_shader_module(wgpu::include_wgsl!("performance.wgsl"));
    let first = Query::new(
        device,
        &shader,
        "hardware",
        &tlas,
        &ray_buffer,
        &triangle_buffer,
        &node_buffer,
    );
    let compacted;
    let compact_tlas;
    let second;
    let compaction_cpu_ms;
    if compact {
        let (sender, receiver) = mpsc::channel();
        blas.prepare_compaction_async(move |r| {
            let _ = sender.send(r.map_err(|e| e.to_string()));
        });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| e.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|e| e.to_string())??;
        if !blas.ready_for_compaction() {
            return Err("compaction did not become ready".into());
        }
        let started = Instant::now();
        compacted = queue.compact_blas(&blas);
        queue.submit([]);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| e.to_string())?;
        compaction_cpu_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        compact_tlas = make_tlas(&compacted, false);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.build_acceleration_structures([], [&compact_tlas]);
        queue.submit(Some(encoder.finish()));
        second = Query::new(
            device,
            &shader,
            "hardware",
            &compact_tlas,
            &ray_buffer,
            &triangle_buffer,
            &node_buffer,
        );
    } else {
        compaction_cpu_ms = None;
        second = Query::new(
            device,
            &shader,
            "software",
            &tlas,
            &ray_buffer,
            &triangle_buffer,
            &node_buffer,
        );
    }
    let empty_tlas = make_tlas(&blas, true);
    let empty_query = Query::new(
        device,
        &shader,
        "hardware",
        &empty_tlas,
        &ray_buffer,
        &triangle_buffer,
        &node_buffer,
    );
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.build_acceleration_structures([], [&empty_tlas]);
    empty_query.encode(&mut encoder, &timer, 0, ray_count);
    queue.submit(Some(encoder.finish()));
    let empty_hash = verify(
        &read(device, &empty_query.readback)?,
        ray_count,
        primitive_count,
        true,
    )?;
    if !compact {
        let unavailable_root = [Node {
            minimum: [1.0e20; 3],
            left: 0,
            maximum: [-1.0e20; 3],
            right: u32::MAX,
        }];
        let unavailable_buffer = buffer(
            "software BVH falsifier",
            bytemuck::cast_slice(&unavailable_root),
            wgpu::BufferUsages::STORAGE,
        );
        let unavailable_query = Query::new(
            device,
            &shader,
            "software",
            &tlas,
            &ray_buffer,
            &triangle_buffer,
            &unavailable_buffer,
        );
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        unavailable_query.encode(&mut encoder, &timer, 0, ray_count);
        queue.submit(Some(encoder.finish()));
        let bytes = read(device, &unavailable_query.readback)?;
        verify(&bytes, ray_count, primitive_count, true)?;
        if verify(&bytes, ray_count, primitive_count, false).is_ok() {
            return Err("software BVH falsifier was admitted as a hit corpus".into());
        }
    }
    let mut first_pairs = Vec::new();
    let mut second_pairs = Vec::new();
    let mut hashes = Vec::new();
    let mut second_hashes = Vec::new();
    let mut pair_differences = Vec::new();
    for index in 0..WARMUP + SAMPLES {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        if index % 2 == 0 {
            first.encode(&mut encoder, &timer, 0, ray_count);
            second.encode(&mut encoder, &timer, 2, ray_count);
        } else {
            second.encode(&mut encoder, &timer, 2, ray_count);
            first.encode(&mut encoder, &timer, 0, ray_count);
        }
        timer.resolve(&mut encoder, 4);
        queue.submit(Some(encoder.finish()));
        let ticks = timer.pairs(device)?;
        save(
            &format!("timestamps-{index}.bin"),
            bytemuck::cast_slice(&ticks),
        )?;
        let first_bytes = read(device, &first.readback)?;
        let second_bytes = read(device, &second.readback)?;
        if index == 0 || index == WARMUP || first_bytes != second_bytes && compact {
            save(&format!("first-{index}.bin"), &first_bytes)?;
            save(&format!("second-{index}.bin"), &second_bytes)?;
        }
        let first_hash = verify(&first_bytes, ray_count, primitive_count, false)?;
        let second_hash = verify(&second_bytes, ray_count, primitive_count, false)?;
        let difference = compare_pairs(&first_bytes, &second_bytes, compact)?;
        if first_hash == empty_hash {
            return Err("empty TLAS falsifier failed".into());
        }
        if index >= WARMUP {
            first_pairs.push(ticks[0]);
            second_pairs.push(ticks[1]);
            hashes.push(first_hash);
            second_hashes.push(second_hash);
            pair_differences.push(difference);
        }
    }
    if let Some(error) = pollster::block_on(scope.pop()) {
        return Err(format!("benchmark validation: {error}"));
    }
    Ok(
        json!({"triangles":primitive_count,"rays":ray_count,"nodeCount":nodes.len(),"rayDistribution":"deterministic parallel -Z, 75% hit, 25% miss", "warmup":WARMUP,"sampleCount":SAMPLES,"pairOrder":"alternating", "timestampSource":"native GPU", "buildGpu":distribution(&build_pairs,queue.get_timestamp_period())?, "softwareBuildCpuMs":cpu_build_ms,"softwareBuildPolicy":"balanced CPU BVH; uploads excluded from query timing; no GPU software-build claim", "first":distribution(&first_pairs,queue.get_timestamp_period())?,"second":distribution(&second_pairs,queue.get_timestamp_period())?,"firstPath":"hardware Ray Query","secondPath":if compact {"compacted hardware Ray Query"} else {"bounded software BVH"},"firstOutputHashesFnv1a64":hashes,"secondOutputHashesFnv1a64":second_hashes,"pairedReadbackDifferences":pair_differences,"emptyTlasFalsifierHash":empty_hash,"oracleCheckedEveryRayEverySample":true,"compactionSubmitAndWaitCpuMs":compaction_cpu_ms,"scope":"native query microbenchmark; not renderer or GI end-to-end performance"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paired_benchmark_shader_validates_with_ray_query_capability() {
        let module = naga::front::wgsl::parse_str(include_str!("performance.wgsl")).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
    #[test]
    fn invalid_timestamps_and_wrong_primitive_cannot_qualify() {
        assert!(distribution(&[[0, 2]], 1.0).is_err());
        assert!(distribution(&[[2, 2]], 1.0).is_err());
        assert!(distribution(&[[3, 2]], 1.0).is_err());
        assert!(distribution(&[[1, 2]], f32::NAN).is_err());
        assert!(distribution(&[[1, 2], [1, 2]], 1.0).is_err());
        let counters = distribution(&[[u64::MAX - 2, u64::MAX - 1]], 1.0).unwrap();
        assert_eq!(counters["rawTicks"][0][0], (u64::MAX - 2).to_string());
        let first = [1u32, 0, 2.0f32.to_bits(), 0];
        let mut second = first;
        second[2] -= 1;
        assert!(compare_pairs(
            bytemuck::cast_slice(&first),
            bytemuck::cast_slice(&second),
            false
        )
        .is_ok());
        assert!(compare_pairs(
            bytemuck::cast_slice(&first),
            bytemuck::cast_slice(&second),
            true
        )
        .is_err());
        second[2] = f32::NAN.to_bits();
        assert!(compare_pairs(
            bytemuck::cast_slice(&first),
            bytemuck::cast_slice(&second),
            false
        )
        .is_err());
        let mut output = vec![[0u32; 4]; 4];
        for (i, value) in output.iter_mut().enumerate().skip(1) {
            *value = [1, (i as u32 * 17) % 4, 2.0f32.to_bits(), 0];
        }
        assert!(verify(bytemuck::cast_slice(&output), 4, 4, false).is_ok());
        output[1][1] = 3;
        assert!(verify(bytemuck::cast_slice(&output), 4, 4, false).is_err());
        assert!(verify(bytemuck::cast_slice(&output), 4, 4, true).is_err());
        output[1] = [1, 1, f32::NAN.to_bits(), 0];
        assert!(verify(bytemuck::cast_slice(&output), 4, 4, false).is_err());
    }
}
