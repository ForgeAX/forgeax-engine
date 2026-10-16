use wgpu_test::{gpu_test, GpuTestConfiguration, GpuTestInitializer, TestParameters};

pub fn all_tests(vec: &mut Vec<GpuTestInitializer>) {
    vec.extend([
        COMPUTE_PASS_TRANSITION_RESOURCES,
        COMPUTE_PASS_TEXTURE_FIRST_USE,
        COMPUTE_PASS_TEXTURE_WRITE_ORDER,
    ]);
}

#[gpu_test]
static COMPUTE_PASS_TEXTURE_WRITE_ORDER: GpuTestConfiguration = GpuTestConfiguration::new()
    .parameters(TestParameters::default().test_features_limits())
    .run_sync(|ctx| {
        let mut failures = Vec::new();
        for boundary in ["dispatch", "pass", "command-buffer"] {
            let texture = ctx.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(boundary),
                size: wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            let pipelines: Vec<_> = ["vec4f(1, 0, 0, 1)", "vec4f(0, 1, 0, 1)"]
                .into_iter()
                .map(|color| {
                    let module = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: None,
                        source: wgpu::ShaderSource::Wgsl(format!(
                            "@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
                             @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {{
                                if (any(id.xy >= textureDimensions(output))) {{ return; }}
                                textureStore(output, vec2i(id.xy), {color});
                             }}"
                        ).into()),
                    });
                    ctx.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: None, layout: None, module: &module, entry_point: Some("main"),
                        compilation_options: Default::default(), cache: None,
                    })
                }).collect();
            let groups: Vec<_> = pipelines.iter().map(|pipeline| {
                ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None, layout: &pipeline.get_bind_group_layout(0),
                    entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }],
                })
            }).collect();
            let mut encoder = ctx.device.create_command_encoder(&Default::default());
            let mut commands = Vec::new();
            if boundary == "dispatch" {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                for (pipeline, group) in pipelines.iter().zip(&groups) {
                    pass.set_pipeline(pipeline);
                    pass.set_bind_group(0, group, &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
            } else {
                for (index, (pipeline, group)) in pipelines.iter().zip(&groups).enumerate() {
                    if boundary == "command-buffer" && index == 1 {
                        commands.push(encoder.finish());
                        encoder = ctx.device.create_command_encoder(&Default::default());
                    }
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(pipeline);
                    pass.set_bind_group(0, group, &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
            }
            let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: None, size: 1024,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo { buffer: &readback, layout: wgpu::TexelCopyBufferLayout {
                    offset: 0, bytes_per_row: Some(256), rows_per_image: Some(4),
                }},
                texture.size(),
            );
            commands.push(encoder.finish());
            ctx.queue.submit(commands);
            readback.slice(..).map_async(wgpu::MapMode::Read, Result::unwrap);
            ctx.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            let bytes = readback.slice(..).get_mapped_range().unwrap();
            for row in 0..4 {
                for column in 0..4 {
                    let pixel = &bytes[row * 256 + column * 4..row * 256 + column * 4 + 4];
                    if pixel != [0, 255, 0, 255] {
                        failures.push((boundary, row, column, pixel.to_vec()));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "last storage writer was not visible: {failures:?}");
    });

#[gpu_test]
static COMPUTE_PASS_TRANSITION_RESOURCES: GpuTestConfiguration = GpuTestConfiguration::new()
    .parameters(TestParameters::default().enable_noop())
    .run_sync(|ctx| {
        let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 128,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });

        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });

        pass.transition_resources(
            [wgpu::BufferTransition {
                buffer: &buffer,
                state: wgpu::BufferUses::STORAGE_READ_WRITE,
            }]
            .into_iter(),
            core::iter::empty(),
        );

        drop(pass);

        ctx.queue.submit([encoder.finish()]);
    });

#[gpu_test]
static COMPUTE_PASS_TEXTURE_FIRST_USE: GpuTestConfiguration = GpuTestConfiguration::new()
    .parameters(
        TestParameters::default()
            .test_features_limits()
            .instance_flags(wgpu::InstanceFlags::GPU_BASED_VALIDATION),
    )
    .run_sync(|ctx| {
        let texture = ctx.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("compute-pass-texture-first-use"),
            size: wgpu::Extent3d {
                width: 4,
                height: 4,
                depth_or_array_layers: 1,
            },
            mip_level_count: 3,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let views: Vec<_> = (0..3)
            .map(|mip| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: mip,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        let seed_module = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(
                    r#"
                @group(0) @binding(0) var destination: texture_storage_2d<r32float,write>;
                @compute @workgroup_size(1) fn main() {
                    textureStore(destination,vec2i(0),vec4f(1));
                }
            "#
                    .into(),
                ),
            });
        let seed = ctx
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: None,
                module: &seed_module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let seed_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &seed.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&views[0]),
            }],
        });
        let layout = ctx
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::StorageTexture {
                            access: wgpu::StorageTextureAccess::WriteOnly,
                            format: wgpu::TextureFormat::R32Float,
                            view_dimension: wgpu::TextureViewDimension::D2,
                        },
                        count: None,
                    },
                ],
            });
        let pipeline_layout = ctx
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
        let module = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(
                    r#"
                @group(0) @binding(0) var source: texture_2d<f32>;
                @group(0) @binding(1) var destination: texture_storage_2d<r32float,write>;
                @compute @workgroup_size(1) fn main() {
                    textureStore(destination,vec2i(0),vec4f(textureLoad(source,vec2i(0),0).x+1));
                }
            "#
                    .into(),
                ),
            });
        let pipeline = ctx
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let groups: Vec<_> = (1..3)
            .map(|mip| {
                ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&views[mip - 1]),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&views[mip]),
                        },
                    ],
                })
            })
            .collect();
        let sampled = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 4,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let sample_layout = ctx
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
        let sample_pipeline_layout =
            ctx.device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: None,
                    bind_group_layouts: &[Some(&sample_layout)],
                    immediate_size: 0,
                });
        let sample_module = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(
                    r#"
                @group(0) @binding(0) var pyramid: texture_2d<f32>;
                @group(0) @binding(1) var<storage,read_write> result: array<f32>;
                @compute @workgroup_size(1) fn main() {
                    result[0] = textureLoad(pyramid,vec2i(0),2).x;
                }
            "#
                    .into(),
                ),
            });
        let sample_pipeline =
            ctx.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: None,
                    layout: Some(&sample_pipeline_layout),
                    module: &sample_module,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                });
        let all_mips = texture.create_view(&Default::default());
        let sample_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &sample_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&all_mips),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: sampled.as_entire_binding(),
                },
            ],
        });
        for _ in 0..3 {
            let mut encoder = ctx.device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&seed);
                pass.set_bind_group(0, &seed_group, &[]);
                pass.dispatch_workgroups(1, 1, 1);
            }
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                for group in &groups {
                    pass.set_bind_group(0, group, &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
            }
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&sample_pipeline);
                pass.set_bind_group(0, &sample_group, &[]);
                pass.dispatch_workgroups(1, 1, 1);
            }
            encoder.copy_buffer_to_buffer(&sampled, 0, &readback, 0, 4);
            ctx.queue.submit([encoder.finish()]);
            readback
                .slice(..)
                .map_async(wgpu::MapMode::Read, Result::unwrap);
            ctx.device
                .poll(wgpu::PollType::wait_indefinitely())
                .unwrap();
            assert_eq!(
                &*readback.slice(..).get_mapped_range().unwrap(),
                &3.0_f32.to_le_bytes()
            );
            readback.unmap();
        }
    });
