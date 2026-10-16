//! WebGPU `GPUSupportedLimits` / `GPUFeatureName` projection of wgpu limits and features.

use serde_json::{Map, Value};

/// Every WebGPU limit plus the Ray Query acceleration-structure limits the RHI reads.
macro_rules! limit_table {
    ($macro:ident) => {
        $macro!("maxTextureDimension1D", max_texture_dimension_1d, u32);
        $macro!("maxTextureDimension2D", max_texture_dimension_2d, u32);
        $macro!("maxTextureDimension3D", max_texture_dimension_3d, u32);
        $macro!("maxTextureArrayLayers", max_texture_array_layers, u32);
        $macro!("maxBindGroups", max_bind_groups, u32);
        $macro!(
            "maxBindGroupsPlusVertexBuffers",
            max_bind_groups_plus_vertex_buffers,
            u32
        );
        $macro!("maxBindingsPerBindGroup", max_bindings_per_bind_group, u32);
        $macro!(
            "maxDynamicUniformBuffersPerPipelineLayout",
            max_dynamic_uniform_buffers_per_pipeline_layout,
            u32
        );
        $macro!(
            "maxDynamicStorageBuffersPerPipelineLayout",
            max_dynamic_storage_buffers_per_pipeline_layout,
            u32
        );
        $macro!(
            "maxSampledTexturesPerShaderStage",
            max_sampled_textures_per_shader_stage,
            u32
        );
        $macro!(
            "maxSamplersPerShaderStage",
            max_samplers_per_shader_stage,
            u32
        );
        $macro!(
            "maxStorageBuffersPerShaderStage",
            max_storage_buffers_per_shader_stage,
            u32
        );
        $macro!(
            "maxStorageTexturesPerShaderStage",
            max_storage_textures_per_shader_stage,
            u32
        );
        $macro!(
            "maxUniformBuffersPerShaderStage",
            max_uniform_buffers_per_shader_stage,
            u32
        );
        $macro!(
            "maxUniformBufferBindingSize",
            max_uniform_buffer_binding_size,
            u64
        );
        $macro!(
            "maxStorageBufferBindingSize",
            max_storage_buffer_binding_size,
            u64
        );
        $macro!(
            "minUniformBufferOffsetAlignment",
            min_uniform_buffer_offset_alignment,
            u32
        );
        $macro!(
            "minStorageBufferOffsetAlignment",
            min_storage_buffer_offset_alignment,
            u32
        );
        $macro!("maxVertexBuffers", max_vertex_buffers, u32);
        $macro!("maxBufferSize", max_buffer_size, u64);
        $macro!("maxVertexAttributes", max_vertex_attributes, u32);
        $macro!(
            "maxVertexBufferArrayStride",
            max_vertex_buffer_array_stride,
            u32
        );
        $macro!(
            "maxInterStageShaderVariables",
            max_inter_stage_shader_variables,
            u32
        );
        $macro!("maxColorAttachments", max_color_attachments, u32);
        $macro!(
            "maxColorAttachmentBytesPerSample",
            max_color_attachment_bytes_per_sample,
            u32
        );
        $macro!(
            "maxComputeWorkgroupStorageSize",
            max_compute_workgroup_storage_size,
            u32
        );
        $macro!(
            "maxComputeInvocationsPerWorkgroup",
            max_compute_invocations_per_workgroup,
            u32
        );
        $macro!(
            "maxComputeWorkgroupSizeX",
            max_compute_workgroup_size_x,
            u32
        );
        $macro!(
            "maxComputeWorkgroupSizeY",
            max_compute_workgroup_size_y,
            u32
        );
        $macro!(
            "maxComputeWorkgroupSizeZ",
            max_compute_workgroup_size_z,
            u32
        );
        $macro!(
            "maxComputeWorkgroupsPerDimension",
            max_compute_workgroups_per_dimension,
            u32
        );
        $macro!("maxImmediateSize", max_immediate_size, u32);
        $macro!("maxBlasGeometryCount", max_blas_geometry_count, u32);
        $macro!("maxBlasPrimitiveCount", max_blas_primitive_count, u32);
        $macro!("maxTlasInstanceCount", max_tlas_instance_count, u32);
        $macro!(
            "maxAccelerationStructuresPerShaderStage",
            max_acceleration_structures_per_shader_stage,
            u32
        );
    };
}

/// The wgpu extension feature name exposed beside the WebGPU feature names.
pub const RAY_QUERY_FEATURE: &str = "wgpu-ray-query";

pub fn limits_to_json(limits: &wgpu::Limits) -> String {
    let mut out = Map::new();
    macro_rules! put {
        ($name:literal, $field:ident, $ty:ty) => {
            out.insert($name.to_owned(), Value::from(limits.$field as f64));
        };
    }
    limit_table!(put);
    Value::Object(out).to_string()
}

/// Apply `requiredLimits` over `base`. Unknown names and values the adapter cannot satisfy
/// are rejected, matching `GPUAdapter.requestDevice`.
pub fn apply_required_limits(
    base: &mut wgpu::Limits,
    adapter: &wgpu::Limits,
    required: &Map<String, Value>,
) -> Result<(), String> {
    for (name, value) in required {
        let Some(number) = value.as_f64() else {
            continue;
        };
        let mut known = false;
        macro_rules! set {
            ($name:literal, $field:ident, $ty:ty) => {
                if name == $name {
                    known = true;
                    let supported = adapter.$field as f64;
                    let better_is_lower = $name.starts_with("min");
                    let ok = if better_is_lower {
                        number >= supported
                    } else {
                        number <= supported
                    };
                    if !ok {
                        return Err(format!(
                            "requiredLimits.{} = {number} exceeds the adapter limit {supported}",
                            $name
                        ));
                    }
                    let better = if better_is_lower {
                        number < base.$field as f64
                    } else {
                        number > base.$field as f64
                    };
                    if better {
                        base.$field = number as $ty;
                    }
                }
            };
        }
        limit_table!(set);
        if !known {
            return Err(format!("requiredLimits has unknown limit '{name}'"));
        }
    }
    Ok(())
}

/// WebGPU feature names supported by `features`, plus `wgpu-ray-query`.
pub fn feature_names(features: wgpu::Features) -> Vec<String> {
    let mut names: Vec<String> = features
        .iter()
        .filter_map(|flag| flag.as_str())
        .filter(|name| !name.starts_with("wgpu-") || *name == RAY_QUERY_FEATURE)
        .map(str::to_owned)
        .collect();
    names.sort();
    names
}

pub fn parse_feature(name: &str) -> Result<wgpu::Features, String> {
    name.parse::<wgpu::Features>()
        .map_err(|()| format!("requiredFeatures has unknown feature '{name}'"))
}
