use super::GpuHarness;
use wgpu::util::DeviceExt;

impl GpuHarness {
    pub fn run_hit_vertex_return(&self, indexed: bool) -> Result<Vec<[f32; 4]>, String> {
        let vertices = [[-1.0f32, -1.0, 0.0], [1.0, -1.0, 0.0], [0.0, 1.0, 0.0]];
        let vertex_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("vertex return triangle"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::BLAS_INPUT,
            });
        let index_buffer = self
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
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: None,
                flags,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let mut tlas = self.device.create_tlas(&wgpu::CreateTlasDescriptor {
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
        let output = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 144,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 144,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let shader = self
            .device
            .create_shader_module(wgpu::include_wgsl!("vertex_return.wgsl"));
        let pipeline = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: None,
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
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
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(
            [&wgpu::BlasBuildEntry {
                blas: &blas,
                geometry: wgpu::BlasGeometries::TriangleGeometries(vec![
                    wgpu::BlasTriangleGeometry {
                        size: &size,
                        vertex_buffer: &vertex_buffer,
                        first_vertex: 0,
                        vertex_stride: 12,
                        index_buffer: indexed.then_some(&index_buffer),
                        first_index: indexed.then_some(0),
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    },
                ]),
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
        self.queue.submit([encoder.finish()]);
        let (send, receive) = std::sync::mpsc::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = send.send(result);
            });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| error.to_string())?;
        receive
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let bytes = readback
            .slice(..)
            .get_mapped_range()
            .map_err(|error| error.to_string())?;
        let values: &[f32] = bytemuck::cast_slice(&bytes);
        let order = if indexed { [2, 0, 1] } else { [0, 1, 2] };
        for base in [0, 12] {
            for (i, index) in order.into_iter().enumerate() {
                if values[base + i * 4..base + i * 4 + 3] != vertices[index]
                    || values[base + i * 4 + 3] != 1.0
                {
                    return Err(format!(
                        "indexed={indexed} vertex readback mismatch: {values:?}"
                    ));
                }
            }
        }
        if values[24..36] != [0.0; 12] {
            return Err(format!(
                "miss returned nonzero vertex positions: {values:?}"
            ));
        }
        Ok(bytemuck::cast_slice::<u8, [f32; 4]>(&bytes).to_vec())
    }
}
