use wgpu::util::DeviceExt;
use wgpu_test::{
    gpu_test, GpuTestConfiguration, GpuTestInitializer, TestParameters, TestingContext,
};

pub fn all_tests(tests: &mut Vec<GpuTestInitializer>) {
    tests.extend([VERTEX_POSITIONS, INDEXED_VERTEX_POSITIONS]);
}

fn parameters() -> TestParameters {
    TestParameters::default()
        .test_features_limits()
        .limits(super::acceleration_structure_limits())
        .features(
            wgpu::Features::EXPERIMENTAL_RAY_QUERY
                | wgpu::Features::EXPERIMENTAL_RAY_HIT_VERTEX_RETURN,
        )
}

#[gpu_test]
static VERTEX_POSITIONS: GpuTestConfiguration = GpuTestConfiguration::new()
    .parameters(parameters())
    .run_sync(|ctx| vertex_positions(ctx, false));

#[gpu_test]
static INDEXED_VERTEX_POSITIONS: GpuTestConfiguration = GpuTestConfiguration::new()
    .parameters(parameters())
    .run_sync(|ctx| vertex_positions(ctx, true));

fn vertex_positions(ctx: TestingContext, indexed: bool) {
    let vertices = [[-1.0f32, -1.0, 0.0], [1.0, -1.0, 0.0], [0.0, 1.0, 0.0]];
    let vertex_buffer = ctx
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("vertex return triangle"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
    let index_buffer = ctx
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&[2u32, 0, 1]),
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
    let size = wgpu::BlasTriangleGeometrySizeDescriptor {
        vertex_format: wgpu::VertexFormat::Float32x3,
        vertex_count: 3,
        index_format: indexed.then_some(wgpu::IndexFormat::Uint32),
        index_count: indexed.then_some(3),
        flags: wgpu::AccelerationStructureGeometryFlags::empty(),
    };
    let flags = wgpu::AccelerationStructureFlags::ALLOW_RAY_HIT_VERTEX_RETURN;
    let blas = ctx.device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: None,
            flags,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: vec![size.clone()],
        },
    );
    let mut tlas = ctx.device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: None,
        flags,
        max_instances: 1,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    tlas[0] = Some(wgpu::TlasInstance::new(
        &blas,
        [1.0, 0.0, 0.0, 3.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        0,
        255,
    ));
    let output = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 144,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 144,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let shader = ctx
        .device
        .create_shader_module(wgpu::include_wgsl!("vertex_return.wgsl"));
    let pipeline = ctx
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
    let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
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
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    encoder.build_acceleration_structures(
        [&wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &size,
                vertex_buffer: &vertex_buffer,
                first_vertex: 0,
                vertex_stride: 12,
                index_buffer: indexed.then_some(&index_buffer),
                first_index: indexed.then_some(0),
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        }],
        [&tlas],
    );
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, 144);
    ctx.queue.submit([encoder.finish()]);
    let (send, receive) = std::sync::mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            send.send(result).unwrap()
        });
    ctx.device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    receive.recv().unwrap().unwrap();
    let bytes = readback.slice(..).get_mapped_range().unwrap();
    let values: &[f32] = bytemuck::cast_slice(&bytes);
    println!("indexed={indexed} candidate/committed/miss positions: {values:?}");
    let order = if indexed { [2, 0, 1] } else { [0, 1, 2] };
    for base in [0, 12] {
        for (i, index) in order.into_iter().enumerate() {
            assert_eq!(&values[base + i * 4..base + i * 4 + 3], &vertices[index]);
            assert_eq!(values[base + i * 4 + 3], 1.0);
        }
    }
    assert_eq!(
        &values[24..36],
        &[0.0; 12],
        "miss must return zero positions"
    );
}
