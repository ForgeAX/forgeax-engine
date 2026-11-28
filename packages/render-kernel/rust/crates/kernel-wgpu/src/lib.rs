//! Native Rust wgpu 30 backend and dedicated OS render thread for ForgeAX RenderKernel.
//! Consumes the exact same `PHYS_*` resolved command stream produced by `kernel-core`.

pub mod executor;
pub mod scene_gpu;
#[cfg(not(target_arch = "wasm32"))]
pub mod thread;
pub mod types;

pub use executor::WgpuKernelExecutor;
pub use scene_gpu::{Scene4BglState, SceneSyncStats};
#[cfg(not(target_arch = "wasm32"))]
pub use thread::DedicatedNativeRenderThread;
pub use types::{
    format_to_webgpu_str, NativeBufferDesc, NativeColorTargetDesc, NativeCullRequest,
    NativeCullSummary, NativeDepthStencilDesc, NativeFrameReceipt, NativeKernelError,
    NativeMaterialDesc, NativeMeshDesc, NativeSamplerDesc, NativeShaderProgramDesc,
    NativeSubmeshDesc, NativeTextureDesc, NativeThreadStats, NativeVertexAttribute,
    NativeVertexBufferLayout,
};

use forgeax_render_kernel_core::RenderKernelCore;

/// Convenience helper pairing `RenderKernelCore` with `WgpuKernelExecutor`.
pub fn run_core_frame_on_wgpu(
    core: &mut RenderKernelCore,
    executor: &mut WgpuKernelExecutor,
    input_cmds: &[u32],
    uniform_bytes: &[u8],
) -> Result<u32, NativeKernelError> {
    core.submit_frame(input_cmds)
        .map_err(|e| NativeKernelError::CoreError(format!("{e:?}")))?;
    executor.sync_scene_gpu_buffers(&mut core.scene, &core.draw_instance_rows);
    executor.execute_physical_stream(&core.resolved_phys_cmds, uniform_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forgeax_render_kernel_core::planner::{
        cmd_header, CMD_ACQUIRE_TEMP_TEX, CMD_BEGIN_COMPUTE_PASS, CMD_BEGIN_RENDER_PASS,
        CMD_DEF_BINDING_SET, CMD_DISPATCH, CMD_DRAW_FULLSCREEN, CMD_DRAW_RENDERERS,
        CMD_END_COMPUTE_PASS, CMD_END_RENDER_PASS, TEMP_TEXTURE_TAG_BIT,
    };
    use forgeax_render_kernel_core::scene::{
        DELTA_FLAG_BASELINE, OBJ_FLAG_FRUSTUM_CULLED, OBJ_FLAG_VISIBLE, OP_SET_TRANSFORMS,
        OP_UPSERT_OBJECTS, SCENE_DELTA_MAGIC, SCENE_DELTA_VERSION,
    };

    const WGSL_TRI: &str = r#"
@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.8, 0.4, 1.0);
}
"#;

    const WGSL_FULLSCREEN_SWIZZLE: &str = r#"
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(srcTex, srcSampler, in.uv);
  return vec4<f32>(c.g, c.r, c.b, 1.0);
}
"#;

    const WGSL_COMPUTE_DOUBLE: &str = r#"
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(4)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  data[gid.x] = data[gid.x] * 2u + 7u;
}
"#;

    fn build_single_object_delta(mesh_id: u32, mat_id: u32) -> Vec<u8> {
        let mut payload = Vec::new();
        // Op 1: OP_UPSERT_OBJECTS (1 object, 56 bytes)
        payload.extend_from_slice(&(OP_UPSERT_OBJECTS as u32).to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes()); // object_id
        payload.extend_from_slice(&mesh_id.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes()); // sub_start=0, sub_count=1
        payload.extend_from_slice(&mat_id.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes()); // layer_mask
        payload.extend_from_slice(&(OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED).to_le_bytes());
        payload.extend_from_slice(&0u32.to_le_bytes()); // skin_slot
        payload.extend_from_slice(&((1000u32 << 16) | 1u32).to_le_bytes()); // queue=1000, entity_order=1
        for f in [-1.0f32, -1.0, -1.0, 1.0, 1.0, 1.0] {
            payload.extend_from_slice(&f.to_le_bytes());
        }

        // Op 2: OP_SET_TRANSFORMS (1 object: 4-byte id + 64-byte mat4)
        payload.extend_from_slice(&(OP_SET_TRANSFORMS as u32).to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes());
        let mat: [f32; 16] = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.5, 1.0,
        ];
        for f in mat {
            payload.extend_from_slice(&f.to_le_bytes());
        }

        // 64-byte FXK1 header
        let mut out = Vec::with_capacity(64 + payload.len());
        out.extend_from_slice(&SCENE_DELTA_MAGIC.to_le_bytes()); // 0
        out.extend_from_slice(&SCENE_DELTA_VERSION.to_le_bytes()); // 4
        out.extend_from_slice(&1u32.to_le_bytes()); // 8: epoch
        out.extend_from_slice(&1u32.to_le_bytes()); // 12: revision
        out.extend_from_slice(&0u32.to_le_bytes()); // 16: base_revision
        out.extend_from_slice(&DELTA_FLAG_BASELINE.to_le_bytes()); // 20: flags
        out.extend_from_slice(&2u32.to_le_bytes()); // 24: op_count
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // 28: payload_bytes
        out.extend_from_slice(&0.0f64.to_le_bytes()); // 32: elapsed
        out.extend_from_slice(&0.016f64.to_le_bytes()); // 40: delta
        out.extend_from_slice(&0.0f64.to_le_bytes()); // 48: sample_time
        out.extend_from_slice(&0u32.to_le_bytes()); // 56: sort_config_bits
        out.extend_from_slice(&0u32.to_le_bytes()); // 60: reserved
        out.extend_from_slice(&payload);
        out
    }

    #[test]
    fn native_thread_two_pass_render_and_pixel_readback_matches_dawn() {
        let Ok(rt) = DedicatedNativeRenderThread::spawn_headless(2) else {
            return;
        };
        let verts: [f32; 9] = [-1.0, -1.0, 0.5, 3.0, -1.0, 0.5, -1.0, 3.0, 0.5];
        let indices: [u16; 3] = [0, 1, 2];
        let vbytes: Vec<u8> = verts.iter().flat_map(|f| f.to_le_bytes()).collect();
        let ibytes: Vec<u8> = indices.iter().flat_map(|i| i.to_le_bytes()).collect();

        let mesh = rt
            .create_mesh(
                NativeMeshDesc {
                    vertex_layout_id: 1,
                    vertex_count: 3,
                    index_count: 3,
                    is_uint32_index: false,
                    topology: 0,
                    submeshes: Vec::new(),
                    label: Some("quad-tri".to_owned()),
                },
                vbytes,
                Some(ibytes),
            )
            .unwrap();
        let tri_shader = rt
            .register_shader_program(NativeShaderProgramDesc {
                code: WGSL_TRI.to_owned(),
                vertex_entry_point: Some("vs_main".to_owned()),
                fragment_entry_point: Some("fs_main".to_owned()),
                compute_entry_point: None,
                layout_family_id: 1,
                vertex_buffer_layouts: vec![NativeVertexBufferLayout {
                    array_stride: 12,
                    step_mode: None,
                    attributes: vec![NativeVertexAttribute {
                        format: "float32x3".to_owned(),
                        offset: 0,
                        shader_location: 0,
                    }],
                }],
                color_formats: vec!["rgba8unorm".to_owned()],
                depth_format: None,
                sample_count: 1,
                blend_mode: None,
                primitive_topology: None,
                label: Some("tri-green".to_owned()),
                ..Default::default()
            })
            .unwrap();
        let post_shader = rt
            .register_shader_program(NativeShaderProgramDesc {
                code: WGSL_FULLSCREEN_SWIZZLE.to_owned(),
                vertex_entry_point: Some("vs_main".to_owned()),
                fragment_entry_point: Some("fs_main".to_owned()),
                compute_entry_point: None,
                layout_family_id: 0,
                vertex_buffer_layouts: vec![],
                color_formats: vec!["rgba8unorm".to_owned()],
                depth_format: None,
                sample_count: 1,
                blend_mode: None,
                primitive_topology: None,
                label: Some("swizzle-post".to_owned()),
                ..Default::default()
            })
            .unwrap();
        let sampler = rt.create_sampler(NativeSamplerDesc::default()).unwrap();
        let mat = rt
            .create_material(
                NativeMaterialDesc {
                    shader_program_id: tri_shader,
                    layout_family_id: 1,
                    render_state_bits: 1,
                    variant_flags: 0,
                    queue: 1000,
                    base_color_texture_id: None,
                    normal_texture_id: None,
                    metallic_roughness_texture_id: None,
                    emissive_texture_id: None,
                    occlusion_texture_id: None,
                    sampler_id: None,
                    label: Some("mat0".to_owned()),
                },
                vec![0u8; 16],
            )
            .unwrap();

        let delta = build_single_object_delta(mesh, mat);
        assert_eq!(rt.commit_scene_delta(delta).unwrap(), 1);

        rt.begin_frame(1, 32, 32).unwrap();
        let cull = rt
            .cull(NativeCullRequest {
                view_proj: [
                    1.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                    0.0, 0.0, 0.0, 1.0,
                ],
                camera_pos: [0.0, 0.0, 0.0],
                layer_mask: 0xFFFF_FFFF,
                flags: 0,
                lod_bias: 0.0,
            })
            .unwrap();
        assert_eq!(cull.visible_opaque_count, 1);

        let scene_color = TEMP_TEXTURE_TAG_BIT | 1;
        let final_color = TEMP_TEXTURE_TAG_BIT | 2;
        let tex_usage = (wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC)
            .bits();

        let cmds = vec![
            // Temp textures
            cmd_header(CMD_ACQUIRE_TEMP_TEX, 7),
            scene_color,
            1 | (1 << 8),
            32,
            32,
            1 | (1 << 16),
            tex_usage,
            cmd_header(CMD_ACQUIRE_TEMP_TEX, 7),
            final_color,
            1 | (1 << 8),
            32,
            32,
            1 | (1 << 16),
            tex_usage,
            // Pass 1: draw triangle into scene_color
            cmd_header(CMD_BEGIN_RENDER_PASS, 11),
            1,
            1,
            scene_color,
            0,
            0,
            0,
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            cmd_header(CMD_DRAW_RENDERERS, 11),
            cull.cull_id,
            1 | (1 << 8) | (1 << 16), // PASS_TAG_FORWARD_OPAQUE, SORT_MATERIAL_PSO, INSTANCING
            0 | (2500 << 16),
            0xFFFF_FFFF,
            0,
            0,
            0,
            0,
            0,
            1,
            cmd_header(CMD_END_RENDER_PASS, 1),
            // Binding set 1: binding 0 = scene_color (texture=0), binding 1 = sampler (sampler=4)
            cmd_header(CMD_DEF_BINDING_SET, 9),
            1,
            2,
            0 | (0 << 16),
            scene_color,
            0,
            1 | (4 << 16),
            sampler,
            0,
            // Pass 2: fullscreen swizzle into final_color
            cmd_header(CMD_BEGIN_RENDER_PASS, 11),
            2,
            1,
            final_color,
            0,
            0,
            0,
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            cmd_header(CMD_DRAW_FULLSCREEN, 5),
            post_shader,
            1,
            0,
            0,
            cmd_header(CMD_END_RENDER_PASS, 1),
        ];

        let receipt = rt.submit_frame_sync(cmds, vec![]).unwrap();
        assert_eq!(receipt.executed_passes, 2);
        assert_eq!(receipt.submitted_draw_count, 2);

        let (w, h, pixels) = rt.readback_pool_texture(2).unwrap();
        assert_eq!((w, h), (32, 32));
        let off = (16 * 32 + 16) * 4;
        // Swizzled (0.8, 0.2, 0.4, 1.0) => ~(204, 51, 102, 255) — identical to Dawn GPU test!
        assert!((pixels[off] as i32 - 204).abs() <= 2, "R={}", pixels[off]);
        assert!((pixels[off + 1] as i32 - 51).abs() <= 2, "G={}", pixels[off + 1]);
        assert!((pixels[off + 2] as i32 - 102).abs() <= 2, "B={}", pixels[off + 2]);
        assert_eq!(pixels[off + 3], 255);
    }

    #[test]
    fn native_thread_compute_dispatch_and_async_pipelined_60_frames() {
        let Ok(rt) = DedicatedNativeRenderThread::spawn_headless(2) else {
            return;
        };
        let cs = rt
            .register_shader_program(NativeShaderProgramDesc {
                code: WGSL_COMPUTE_DOUBLE.to_owned(),
                vertex_entry_point: None,
                fragment_entry_point: None,
                compute_entry_point: Some("cs_main".to_owned()),
                layout_family_id: 0,
                vertex_buffer_layouts: vec![],
                color_formats: vec![],
                depth_format: None,
                sample_count: 1,
                blend_mode: None,
                primitive_topology: None,
                label: Some("compute-double".to_owned()),
                ..Default::default()
            })
            .unwrap();
        let initial: Vec<u8> = [1u32, 2, 3, 4]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let buf = rt
            .create_buffer(
                NativeBufferDesc {
                    size: 16,
                    usage: (wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::COPY_SRC
                        | wgpu::BufferUsages::COPY_DST)
                        .bits(),
                    label: Some("cs-buf".to_owned()),
                },
                Some(initial),
            )
            .unwrap();

        let cmds = vec![
            cmd_header(CMD_DEF_BINDING_SET, 6),
            1,
            1,
            0 | (3 << 16), // binding 0 = buffer (kind=3)
            buf,
            0,
            cmd_header(CMD_BEGIN_COMPUTE_PASS, 2),
            1,
            cmd_header(CMD_DISPATCH, 8),
            cs,
            1,
            0,
            0,
            1,
            1,
            1,
            cmd_header(CMD_END_COMPUTE_PASS, 1),
        ];

        // Run 1 compute pass synchronously and verify GPU results
        rt.begin_frame(1, 16, 16).unwrap();
        let receipt = rt.submit_frame_sync(cmds.clone(), vec![]).unwrap();
        assert_eq!(receipt.executed_passes, 1);
        let out_bytes = rt.readback_buffer(buf, 0, 16).unwrap();
        let out_u32: Vec<u32> = out_bytes
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        assert_eq!(out_u32, vec![9, 11, 13, 15]);

        // Now pipeline 60 frames asynchronously onto the dedicated OS render thread!
        for frame in 2..=61u64 {
            rt.submit_pipelined_frame_async(frame, 16, 16, None, vec![], vec![], vec![])
                .unwrap();
        }
        rt.flush().unwrap();
        let stats = rt.stats();
        assert_eq!(stats.submitted_frames, 61);
        assert_eq!(stats.completed_frames, 61);
        assert_eq!(stats.last_completed_frame_id, 61);
        assert_eq!(stats.in_flight_frames, 0);
    }

    const WGSL_4BGL_LIT: &str = r#"
struct ViewUniform {
  view_proj: mat4x4<f32>,
  ambient: vec4<f32>,
};
struct MaterialUniform {
  albedo: vec4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
struct SceneLightGpu {
  position_range: vec4<f32>,
  direction_intensity: vec4<f32>,
  color_outer_cos: vec4<f32>,
  flags_meta: vec4<u32>,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(1) @binding(0) var<uniform> u_mat: MaterialUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(2) @binding(1) var<storage, read> s_lights: array<SceneLightGpu>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world_n: vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(instance_index) inst: u32,
) -> VsOut {
  let row = s_instance_rows[inst];
  let obj = s_objects[row];
  let world_pos = obj.world * vec4<f32>(pos, 1.0);
  var out: VsOut;
  out.pos = u_view.view_proj * world_pos;
  out.world_n = normalize((obj.world * vec4<f32>(normal, 0.0)).xyz);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let light = s_lights[0];
  let ldir = normalize(-light.direction_intensity.xyz);
  let ndotl = max(dot(normalize(in.world_n), ldir), 0.0);
  let lit = u_mat.albedo.rgb * (u_view.ambient.rgb + light.color_outer_cos.rgb * light.direction_intensity.w * ndotl);
  return vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
"#;

    fn pack_fxk1(epoch: u32, rev: u32, base_rev: u32, flags: u32, op_count: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + payload.len());
        out.extend_from_slice(&SCENE_DELTA_MAGIC.to_le_bytes());
        out.extend_from_slice(&SCENE_DELTA_VERSION.to_le_bytes());
        out.extend_from_slice(&epoch.to_le_bytes());
        out.extend_from_slice(&rev.to_le_bytes());
        out.extend_from_slice(&base_rev.to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&op_count.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&0.0f64.to_le_bytes());
        out.extend_from_slice(&0.016f64.to_le_bytes());
        out.extend_from_slice(&0.0f64.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn translation_mat4(tx: f32, ty: f32, tz: f32) -> [f32; 16] {
        [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            tx, ty, tz, 1.0,
        ]
    }

    #[test]
    fn native_thread_4bgl_3d_lit_scene_and_incremental_dirty_sync() {
        use forgeax_render_kernel_core::pso::LAYOUT_FAMILY_SCENE_4BGL;
        use forgeax_render_kernel_core::scene::{OP_SET_LIGHTS, OP_UPDATE_MATERIAL_PARAMS};

        let Ok(rt) = DedicatedNativeRenderThread::spawn_headless(2) else {
            return;
        };

        // Unit quad in XY plane centered at origin (half-extent 0.25), facing +Z (normal = 0,0,1).
        let verts: [f32; 24] = [
            -0.25, -0.25, 0.0, 0.0, 0.0, 1.0,
             0.25, -0.25, 0.0, 0.0, 0.0, 1.0,
             0.25,  0.25, 0.0, 0.0, 0.0, 1.0,
            -0.25,  0.25, 0.0, 0.0, 0.0, 1.0,
        ];
        let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let vbytes: Vec<u8> = verts.iter().flat_map(|f| f.to_le_bytes()).collect();
        let ibytes: Vec<u8> = indices.iter().flat_map(|i| i.to_le_bytes()).collect();

        let mesh = rt
            .create_mesh(
                NativeMeshDesc {
                    vertex_layout_id: 2,
                    vertex_count: 4,
                    index_count: 6,
                    is_uint32_index: false,
                    topology: 0,
                    submeshes: Vec::new(),
                    label: Some("lit-quad".to_owned()),
                },
                vbytes,
                Some(ibytes),
            )
            .unwrap();

        let shader = rt
            .register_shader_program(NativeShaderProgramDesc {
                code: WGSL_4BGL_LIT.to_owned(),
                vertex_entry_point: Some("vs_main".to_owned()),
                fragment_entry_point: Some("fs_main".to_owned()),
                compute_entry_point: None,
                layout_family_id: LAYOUT_FAMILY_SCENE_4BGL as u32,
                vertex_buffer_layouts: vec![NativeVertexBufferLayout {
                    array_stride: 24,
                    step_mode: None,
                    attributes: vec![
                        NativeVertexAttribute {
                            format: "float32x3".to_owned(),
                            offset: 0,
                            shader_location: 0,
                        },
                        NativeVertexAttribute {
                            format: "float32x3".to_owned(),
                            offset: 12,
                            shader_location: 1,
                        },
                    ],
                }],
                color_formats: vec!["rgba8unorm".to_owned()],
                depth_format: None,
                sample_count: 1,
                blend_mode: None,
                primitive_topology: None,
                label: Some("lit-4bgl".to_owned()),
                ..Default::default()
            })
            .unwrap();

        let red_bytes: Vec<u8> = [0.8f32, 0.2, 0.2, 1.0]
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();
        let blue_bytes: Vec<u8> = [0.2f32, 0.4, 0.9, 1.0]
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        let mat_red = rt
            .create_material(
                NativeMaterialDesc {
                    shader_program_id: shader,
                    layout_family_id: LAYOUT_FAMILY_SCENE_4BGL as u32,
                    render_state_bits: 1,
                    variant_flags: 0,
                    queue: 1000,
                    base_color_texture_id: None,
                    normal_texture_id: None,
                    metallic_roughness_texture_id: None,
                    emissive_texture_id: None,
                    occlusion_texture_id: None,
                    sampler_id: None,
                    label: Some("mat-red".to_owned()),
                },
                red_bytes,
            )
            .unwrap();
        let mat_blue = rt
            .create_material(
                NativeMaterialDesc {
                    shader_program_id: shader,
                    layout_family_id: LAYOUT_FAMILY_SCENE_4BGL as u32,
                    render_state_bits: 1,
                    variant_flags: 0,
                    queue: 1000,
                    base_color_texture_id: None,
                    normal_texture_id: None,
                    metallic_roughness_texture_id: None,
                    emissive_texture_id: None,
                    occlusion_texture_id: None,
                    sampler_id: None,
                    label: Some("mat-blue".to_owned()),
                },
                blue_bytes,
            )
            .unwrap();

        // Interleave 4 objects across mat_red and mat_blue so rows [0,2] and [1,3] are
        // non-contiguous, proving Group 3 instance_rows indirection works on real Metal GPU!
        let mut payload = Vec::new();
        payload.extend_from_slice(&(OP_UPSERT_OBJECTS as u32).to_le_bytes());
        payload.extend_from_slice(&4u32.to_le_bytes());
        let objs = [
            (1u32, mat_red, 1u32),
            (2u32, mat_blue, 2u32),
            (3u32, mat_red, 3u32),
            (4u32, mat_blue, 4u32),
        ];
        for (oid, mid, order) in objs {
            payload.extend_from_slice(&oid.to_le_bytes());
            payload.extend_from_slice(&mesh.to_le_bytes());
            payload.extend_from_slice(&1u32.to_le_bytes());
            payload.extend_from_slice(&mid.to_le_bytes());
            payload.extend_from_slice(&1u32.to_le_bytes());
            payload.extend_from_slice(&(OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED).to_le_bytes());
            payload.extend_from_slice(&0u32.to_le_bytes());
            payload.extend_from_slice(&((1000u32 << 16) | order).to_le_bytes());
            for f in [-0.25f32, -0.25, -0.1, 0.25, 0.25, 0.1] {
                payload.extend_from_slice(&f.to_le_bytes());
            }
        }
        payload.extend_from_slice(&(OP_SET_TRANSFORMS as u32).to_le_bytes());
        payload.extend_from_slice(&4u32.to_le_bytes());
        for oid in [1u32, 2, 3, 4] {
            payload.extend_from_slice(&oid.to_le_bytes());
        }
        let mats = [
            translation_mat4(-0.5, 0.0, 0.5),  // obj 1 (red): left center
            translation_mat4(0.5, 0.0, 0.5),   // obj 2 (blue): right center
            translation_mat4(-0.5, 0.6, 0.5),  // obj 3 (red): top left
            translation_mat4(0.5, -0.6, 0.5),  // obj 4 (blue): bottom right
        ];
        for m in mats {
            for f in m {
                payload.extend_from_slice(&f.to_le_bytes());
            }
        }
        // Directional light shining along (0, 0, -1), intensity 1.0, white (1, 1, 1)
        payload.extend_from_slice(&(OP_SET_LIGHTS as u32).to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes()); // light_id
        payload.extend_from_slice(&0u32.to_le_bytes()); // kind=0 (dir), cast_shadow=0
        payload.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // layer_mask
        payload.extend_from_slice(&0.0f32.to_le_bytes()); // range
        for f in [0.0f32, 0.0, 0.0, 1.0] {
            payload.extend_from_slice(&f.to_le_bytes()); // pos + intensity
        }
        for f in [0.0f32, 0.0, -1.0, 0.0] {
            payload.extend_from_slice(&f.to_le_bytes()); // dir + outer_cone_cos
        }
        for f in [1.0f32, 1.0, 1.0, 0.0] {
            payload.extend_from_slice(&f.to_le_bytes()); // color + pad
        }

        let baseline = pack_fxk1(1, 1, 0, DELTA_FLAG_BASELINE, 3, &payload);
        assert_eq!(rt.commit_scene_delta(baseline).unwrap(), 1);

        // Place ViewUniform at dynamic offset 256 bytes to verify Group 0 dynamic offset!
        let mut uniform_bytes = vec![0u8; 256 + 80];
        let view_proj = translation_mat4(0.0, 0.0, 0.0);
        for (i, f) in view_proj.iter().enumerate() {
            uniform_bytes[256 + i * 4..256 + (i + 1) * 4].copy_from_slice(&f.to_le_bytes());
        }
        // ambient = (0, 0, 0, 0) so output comes purely from directional light * albedo.

        let target = TEMP_TEXTURE_TAG_BIT | 1;
        let tex_usage = (wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC)
            .bits();

        let make_cmds = |cull_id: u32| {
            vec![
                cmd_header(CMD_ACQUIRE_TEMP_TEX, 7),
                target,
                1 | (1 << 8),
                64,
                64,
                1 | (1 << 16),
                tex_usage,
                cmd_header(CMD_BEGIN_RENDER_PASS, 11),
                1,
                1,
                target,
                0,
                0,
                0,
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                cmd_header(CMD_DRAW_RENDERERS, 11),
                cull_id,
                0 | (3 << 8) | (1 << 16), // PASS_TAG_FORWARD_OPAQUE, SORT_MATERIAL_PSO, INSTANCING
                0 | (2500 << 16),
                0xFFFF_FFFF,
                256, // view_uniform_off = 256!
                80,  // view_uniform_len
                0,
                0,
                0,
                1,
                cmd_header(CMD_END_RENDER_PASS, 1),
            ]
        };

        // Frame 1: full baseline upload + 2 instanced draw calls (one per material)
        rt.begin_frame(1, 64, 64).unwrap();
        let cull1 = rt
            .cull(NativeCullRequest {
                view_proj,
                camera_pos: [0.0, 0.0, 0.0],
                layer_mask: 0xFFFF_FFFF,
                flags: 0,
                lod_bias: 0.0,
            })
            .unwrap();
        assert_eq!(cull1.visible_opaque_count, 4);
        let r1 = rt
            .submit_frame_sync(make_cmds(cull1.cull_id), uniform_bytes.clone())
            .unwrap();
        assert_eq!(r1.submitted_draw_count, 2); // 4 interleaved objects folded into 2 instanced draws!

        let (w, h, px1) = rt.readback_pool_texture(1).unwrap();
        assert_eq!((w, h), (64, 64));
        let left = (32 * 64 + 16) * 4;
        let center = (32 * 64 + 32) * 4;
        let right = (32 * 64 + 48) * 4;
        assert!((px1[left] as i32 - 204).abs() <= 2, "left R={}", px1[left]);
        assert!((px1[left + 1] as i32 - 51).abs() <= 2, "left G={}", px1[left + 1]);
        assert!((px1[left + 2] as i32 - 51).abs() <= 2, "left B={}", px1[left + 2]);
        assert_eq!(px1[center], 0); // center empty on frame 1
        assert!((px1[right] as i32 - 51).abs() <= 2, "right R={}", px1[right]);
        assert!((px1[right + 1] as i32 - 102).abs() <= 2, "right G={}", px1[right + 1]);
        assert!((px1[right + 2] as i32 - 230).abs() <= 2, "right B={}", px1[right + 2]);

        let s1 = rt.stats();
        assert_eq!(s1.dirty_rows_uploaded, 4);
        assert_eq!(s1.dirty_range_writes, 1);
        assert_eq!(s1.material_uploads, 0);

        // Frame 2: incremental delta moving ONLY obj 1 to center (0, 0, 0.5) and changing ONLY mat_red -> yellow!
        let mut delta2_payload = Vec::new();
        delta2_payload.extend_from_slice(&(OP_SET_TRANSFORMS as u32).to_le_bytes());
        delta2_payload.extend_from_slice(&1u32.to_le_bytes());
        delta2_payload.extend_from_slice(&1u32.to_le_bytes());
        for f in translation_mat4(0.0, 0.0, 0.5) {
            delta2_payload.extend_from_slice(&f.to_le_bytes());
        }
        delta2_payload.extend_from_slice(&(OP_UPDATE_MATERIAL_PARAMS as u32).to_le_bytes());
        delta2_payload.extend_from_slice(&1u32.to_le_bytes());
        delta2_payload.extend_from_slice(&mat_red.to_le_bytes());
        delta2_payload.extend_from_slice(&((16u32 << 16) | 0u32).to_le_bytes());
        for f in [0.9f32, 0.9, 0.1, 1.0] {
            delta2_payload.extend_from_slice(&f.to_le_bytes());
        }
        let delta2 = pack_fxk1(1, 2, 1, 0, 2, &delta2_payload);
        assert_eq!(rt.commit_scene_delta(delta2).unwrap(), 2);

        rt.begin_frame(2, 64, 64).unwrap();
        let cull2 = rt
            .cull(NativeCullRequest {
                view_proj,
                camera_pos: [0.0, 0.0, 0.0],
                layer_mask: 0xFFFF_FFFF,
                flags: 0,
                lod_bias: 0.0,
            })
            .unwrap();
        let _r2 = rt
            .submit_frame_sync(make_cmds(cull2.cull_id), uniform_bytes)
            .unwrap();

        let s2 = rt.stats();
        // Proves incremental dirty-row sync uploaded ONLY 1 row (in 1 write_buffer call) + 1 material UBO!
        assert_eq!(s2.dirty_rows_uploaded - s1.dirty_rows_uploaded, 1);
        assert_eq!(s2.dirty_range_writes - s1.dirty_range_writes, 1);
        assert_eq!(s2.material_uploads - s1.material_uploads, 1);

        let (_w2, _h2, px2) = rt.readback_pool_texture(1).unwrap();
        // Obj 1 moved to center and turned yellow (230, 230, 26), left is now cleared (0), right stayed blue!
        assert_eq!(px2[left], 0);
        assert!((px2[center] as i32 - 230).abs() <= 2, "center R={}", px2[center]);
        assert!((px2[center + 1] as i32 - 230).abs() <= 2, "center G={}", px2[center + 1]);
        assert!((px2[center + 2] as i32 - 26).abs() <= 2, "center B={}", px2[center + 2]);
        assert!((px2[right] as i32 - 51).abs() <= 2, "right R={}", px2[right]);
        assert!((px2[right + 2] as i32 - 230).abs() <= 2, "right B={}", px2[right + 2]);
    }
}
