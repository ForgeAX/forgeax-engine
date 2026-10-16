// ============================================================================
// #[cfg(test)] — mirror struct round-trip tests (w8)
// ============================================================================

use super::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_node_experimental);

#[wasm_bindgen_test]
fn test_unconfigured_surface_acquire_is_rejected_before_wgpu() {
    let error = ensure_surface_configured(false)
        .expect_err("unconfigured surface acquire must fail closed");
    assert_eq!(
        error.as_string().as_deref(),
        Some("getCurrentTexture: surface is not configured")
    );
    assert!(ensure_surface_configured(true).is_ok());
}

#[wasm_bindgen_test]
fn test_surface_presentation_proof_is_a_plain_json_object() {
    let configuration = SurfaceConfigurationFacts {
        format: "Rgba8Unorm".to_owned(),
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT.bits(),
        width: 800,
        height: 600,
        alpha_mode: "Auto".to_owned(),
        present_mode: "Fifo".to_owned(),
    };
    let value = serialize_surface_presentation_proof(
        &configuration,
        true,
        true,
        "wgpu-surface:17".to_owned(),
    )
    .expect("proof serialization");
    assert!(!value.is_instance_of::<js_sys::Map>());
    let object: js_sys::Object = value.clone().unchecked_into();
    let keys = js_sys::Object::keys(&object);
    assert_eq!(keys.length(), 6);
    for key in [
        "descriptor",
        "acquisition",
        "validation",
        "surfaceIdentity",
        "requested",
        "validated",
    ] {
        assert!(js_sys::Reflect::has(&value, &JsValue::from_str(key)).unwrap());
    }
    assert_eq!(
        js_sys::Reflect::get(&value, &JsValue::from_str("surfaceIdentity"))
            .unwrap()
            .as_string()
            .as_deref(),
        Some("wgpu-surface:17")
    );
    let json = js_sys::JSON::stringify(&value)
        .unwrap()
        .as_string()
        .unwrap();
    assert!(json.contains("\"requested\""));
    assert!(json.contains("\"validated\""));
    assert!(!json.contains("Map"));
}

#[test]
fn test_surface_usage_capability_gate_rejects_unsupported_copy() {
    let supported = wgpu::TextureUsages::RENDER_ATTACHMENT;
    assert!(surface_usage_supported(
        supported,
        wgpu::TextureUsages::RENDER_ATTACHMENT.bits()
    ));
    assert!(!surface_usage_supported(
        supported,
        wgpu::TextureUsages::COPY_SRC.bits()
    ));
    assert!(!surface_usage_supported(supported, u32::MAX));
}

#[wasm_bindgen_test]
fn test_surface_configure_error_is_structured_and_identifies_surface() {
    let desc = SurfaceConfigurationJs {
        device: (),
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT.bits(),
        format: wgpu::TextureFormat::Rgba8Unorm,
        width: 640,
        height: 480,
        present_mode: PresentModeJs::Fifo,
        desired_maximum_frame_latency: None,
        alpha_mode: None,
        view_formats: Vec::new(),
    };
    let error = surface_configure_error(
        "validation-error",
        &desc,
        None,
        17,
        23,
        Some("Validation { message: invalid surface }"),
    );
    let text = error.as_string().expect("structured error text");
    assert!(text.contains("\"reason\":\"validation-error\""));
    assert!(text.contains("\"deviceToken\":17"));
    assert!(text.contains("\"surfaceIdentity\":23"));
    assert!(text.contains("\"usage\":16"));
    assert!(text.contains("invalid surface"));
}

#[wasm_bindgen_test]
fn test_buffer_descriptor_round_trip() {
    let desc: BufferDescriptorJs =
        serde_json::from_str(r#"{"size":256,"usage":40,"mappedAtCreation":true}"#).unwrap();
    let wgpu_desc = desc.into_wgpu();
    assert_eq!(wgpu_desc.size, 256);
    assert!(wgpu_desc.mapped_at_creation);
    // usage 40 = VERTEX(32) | COPY_DST(8)
    assert!(wgpu_desc
        .usage
        .contains(wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST));
}

#[wasm_bindgen_test]
fn test_texture_descriptor_round_trip() {
    let desc: TextureDescriptorJs = serde_json::from_str(
            r#"{"size":{"width":512,"height":512},"format":"rgba8unorm","usage":16,"dimension":"2d","mipLevelCount":1,"sampleCount":1}"#
        ).unwrap();
    let wgpu_desc = desc.into_wgpu();
    assert_eq!(wgpu_desc.size.width, 512);
    assert_eq!(wgpu_desc.size.height, 512);
    assert_eq!(wgpu_desc.size.depth_or_array_layers, 1);
    assert_eq!(wgpu_desc.format, wgpu::TextureFormat::Rgba8Unorm);
    assert_eq!(wgpu_desc.mip_level_count, 1);
}

#[wasm_bindgen_test]
fn test_texture_descriptor_accepts_compatibility_binding_view_dimension() {
    let desc: TextureDescriptorJs = serde_json::from_str(
            r#"{"size":{"width":4,"height":4,"depthOrArrayLayers":6},"format":"rgba8unorm","usage":4,"dimension":"2d","textureBindingViewDimension":"cube"}"#
        )
        .unwrap();
    assert_eq!(
        desc.texture_binding_view_dimension,
        Some(wgpu::TextureViewDimension::Cube)
    );
    let wgpu_desc = desc.into_wgpu();
    assert_eq!(wgpu_desc.dimension, wgpu::TextureDimension::D2);
    assert_eq!(wgpu_desc.size.depth_or_array_layers, 6);
}

#[wasm_bindgen_test]
fn test_texture_view_descriptor_round_trip_preserves_array_and_3d_dimensions() {
    let array_desc: JsValue = js_sys::Object::new().into();
    js_sys::Reflect::set(
        &array_desc,
        &JsValue::from_str("dimension"),
        &JsValue::from_str("2d-array"),
    )
    .unwrap();
    js_sys::Reflect::set(
        &array_desc,
        &JsValue::from_str("baseArrayLayer"),
        &JsValue::from_f64(1.0),
    )
    .unwrap();
    js_sys::Reflect::set(
        &array_desc,
        &JsValue::from_str("arrayLayerCount"),
        &JsValue::from_f64(2.0),
    )
    .unwrap();
    let array_view = parse_texture_view_descriptor(&array_desc).unwrap();
    assert_eq!(
        array_view.dimension,
        Some(wgpu::TextureViewDimension::D2Array)
    );
    assert_eq!(array_view.base_array_layer, 1);
    assert_eq!(array_view.array_layer_count, Some(2));

    let volume_desc: JsValue = js_sys::Object::new().into();
    js_sys::Reflect::set(
        &volume_desc,
        &JsValue::from_str("dimension"),
        &JsValue::from_str("3d"),
    )
    .unwrap();
    let volume_view = parse_texture_view_descriptor(&volume_desc).unwrap();
    assert_eq!(volume_view.dimension, Some(wgpu::TextureViewDimension::D3));
}

#[wasm_bindgen_test]
fn test_texture_view_descriptor_rejects_invalid_format_dimension_and_aspect() {
    for (field, value) in [
        ("format", JsValue::from_str("not-a-format")),
        ("dimension", JsValue::from_str("not-a-dimension")),
        ("aspect", JsValue::from_str("not-an-aspect")),
    ] {
        let desc: JsValue = js_sys::Object::new().into();
        js_sys::Reflect::set(&desc, &JsValue::from_str(field), &value).unwrap();
        let error = parse_texture_view_descriptor(&desc).unwrap_err();
        let message = error.as_string().unwrap_or_default();
        assert!(message.contains("[wgpu-wasm] failed to parse textureView descriptor"));
        assert!(message.contains(field));
    }
}

#[wasm_bindgen_test]
fn test_sampler_descriptor_round_trip() {
    let desc: SamplerDescriptorJs = serde_json::from_str(
        r#"{"magFilter":"linear","minFilter":"linear","mipmapFilter":"linear","maxAnisotropy":4}"#,
    )
    .unwrap();
    let wgpu_desc = desc.into_wgpu();
    assert_eq!(wgpu_desc.mag_filter, wgpu::FilterMode::Linear);
    assert_eq!(wgpu_desc.min_filter, wgpu::FilterMode::Linear);
    assert_eq!(wgpu_desc.anisotropy_clamp, 4);
}

#[wasm_bindgen_test]
fn test_bind_group_layout_descriptor_round_trip() {
    let desc: BindGroupLayoutDescriptorJs = serde_json::from_str(
            r#"{"entries":[{"binding":0,"visibility":6,"buffer":{"type":"uniform","hasDynamicOffset":false}}]}"#
        ).unwrap();
    assert_eq!(desc.entries.len(), 1);
    assert_eq!(desc.entries[0].binding, 0);
    assert!(desc.entries[0].buffer.is_some());
}

#[wasm_bindgen_test]
fn test_render_pipeline_primitive_round_trip() {
    let p: PrimitiveStateJs =
        serde_json::from_str(r#"{"topology":"triangle-list","cullMode":"back"}"#).unwrap();
    let wgpu_p = p.into_wgpu();
    assert_eq!(wgpu_p.topology, wgpu::PrimitiveTopology::TriangleList);
    assert_eq!(wgpu_p.cull_mode, Some(wgpu::Face::Back));
}

#[wasm_bindgen_test]
fn test_render_pipeline_depth_stencil_round_trip() {
    let ds: DepthStencilStateJs = serde_json::from_str(
        r#"{"format":"depth24plus","depthWriteEnabled":true,"depthCompare":"less"}"#,
    )
    .unwrap();
    let wgpu_ds = ds.into_wgpu();
    assert_eq!(wgpu_ds.format, wgpu::TextureFormat::Depth24Plus);
    assert_eq!(wgpu_ds.depth_write_enabled, Some(true));
    assert_eq!(wgpu_ds.depth_compare, Some(wgpu::CompareFunction::Less));
}

#[wasm_bindgen_test]
fn test_render_pipeline_flat_stencil_state_round_trip() {
    let ds: DepthStencilStateJs = serde_json::from_str(
        r#"{
                "format":"depth24plus-stencil8",
                "depthWriteEnabled":false,
                "depthCompare":"less",
                "stencilReadMask":255,
                "stencilWriteMask":255,
                "stencilFront":{"compare":"always","passOp":"replace"},
                "stencilBack":{"compare":"always","passOp":"replace"}
            }"#,
    )
    .unwrap();
    let wgpu_ds = ds.into_wgpu();
    assert_eq!(wgpu_ds.format, wgpu::TextureFormat::Depth24PlusStencil8);
    assert_eq!(wgpu_ds.stencil.read_mask, 255);
    assert_eq!(wgpu_ds.stencil.write_mask, 255);
    assert_eq!(wgpu_ds.stencil.front.compare, wgpu::CompareFunction::Always);
    assert_eq!(
        wgpu_ds.stencil.front.pass_op,
        wgpu::StencilOperation::Replace
    );
    assert_eq!(
        wgpu_ds.stencil.back.pass_op,
        wgpu::StencilOperation::Replace
    );
}

#[wasm_bindgen_test]
fn test_render_pipeline_flat_depth_bias_round_trip() {
    let ds: DepthStencilStateJs = serde_json::from_str(
        r#"{
                "format":"depth32float",
                "depthWriteEnabled":true,
                "depthCompare":"less",
                "depthBias":7,
                "depthBiasSlopeScale":1.25,
                "depthBiasClamp":0.5
            }"#,
    )
    .unwrap();
    let wgpu_ds = ds.into_wgpu();
    assert_eq!(wgpu_ds.bias.constant, 7);
    assert_eq!(wgpu_ds.bias.slope_scale, 1.25);
    assert_eq!(wgpu_ds.bias.clamp, 0.5);
}

#[wasm_bindgen_test]
fn test_blend_state_round_trip() {
    let bs: BlendStateJs = serde_json::from_str(
            r#"{"color":{"srcFactor":"src-alpha","dstFactor":"one-minus-src-alpha"},"alpha":{"operation":"add","srcFactor":"one","dstFactor":"zero"}}"#
        ).unwrap();
    let wgpu_bs = bs.into_wgpu();
    assert_eq!(wgpu_bs.color.src_factor, wgpu::BlendFactor::SrcAlpha);
    assert_eq!(
        wgpu_bs.color.dst_factor,
        wgpu::BlendFactor::OneMinusSrcAlpha
    );
}

#[wasm_bindgen_test]
fn test_extent3d_default_depth() {
    let e: Extent3dJs = serde_json::from_str(r#"{"width":256,"height":256}"#).unwrap();
    let wgpu_e = e.into_wgpu();
    assert_eq!(wgpu_e.depth_or_array_layers, 1);
}

#[wasm_bindgen_test]
fn test_buffer_descriptor_defaults() {
    let desc: BufferDescriptorJs = serde_json::from_str(r#"{"size":128,"usage":8}"#).unwrap();
    let wgpu_desc = desc.into_wgpu();
    assert!(!wgpu_desc.mapped_at_creation);
    assert_eq!(wgpu_desc.size, 128);
}

#[wasm_bindgen_test]
fn test_render_pass_descriptor_round_trip() {
    // Verify colorAttachments array with loadOp/storeOp enum deserialization
    let desc: RenderPassDescriptorJs = serde_json::from_str(
        r#"{"label":"rp","colorAttachments":[{"loadOp":"load","storeOp":"store","depthSlice":3}]}"#,
    )
    .unwrap();
    assert_eq!(desc.color_attachments.len(), 1);
    assert_eq!(desc.label, Some("rp".to_string()));
    assert_eq!(desc.color_attachments[0].depth_slice, Some(3));
    assert!(desc.depth_stencil_attachment.is_none());

    // Verify depthStencilAttachment mapping with lowercase ops
    let desc2: RenderPassDescriptorJs = serde_json::from_str(
            r#"{"colorAttachments":[],"depthStencilAttachment":{"depthLoadOp":"load","depthStoreOp":"store","depthClearValue":1.0,"stencilLoadOp":"load","stencilStoreOp":"store","stencilClearValue":0,"depthReadOnly":false,"stencilReadOnly":false}}"#
        ).unwrap();
    assert!(desc2.depth_stencil_attachment.is_some());
    let dsa = desc2.depth_stencil_attachment.unwrap();
    assert_eq!(dsa.depth_clear_value, Some(1.0));
    assert_eq!(dsa.stencil_clear_value, Some(0));
}

#[wasm_bindgen_test]
fn test_surface_configuration_round_trip() {
    // Verify format enum + usage bitflags + alphaMode enum + viewFormats array
    let desc: SurfaceConfigurationJs = serde_json::from_str(
            r#"{"format":"bgra8unorm","usage":16,"width":800,"height":600,"presentMode":"fifo","alphaMode":"auto","viewFormats":["bgra8unorm","rgba8unorm"]}"#
        ).unwrap();
    assert_eq!(desc.format, wgpu::TextureFormat::Bgra8Unorm);
    assert_eq!(desc.width, 800);
    assert_eq!(desc.height, 600);
    assert_eq!(desc.present_mode, PresentModeJs::Fifo);
    assert_eq!(desc.alpha_mode, Some(wgpu::CompositeAlphaMode::Auto));
    assert_eq!(desc.view_formats.len(), 2);
    assert_eq!(desc.view_formats[0], wgpu::TextureFormat::Bgra8Unorm);
    assert_eq!(desc.view_formats[1], wgpu::TextureFormat::Rgba8Unorm);
}

#[wasm_bindgen_test]
fn test_surface_configuration_defaults() {
    // Verify defaults for optional fields
    let desc: SurfaceConfigurationJs =
        serde_json::from_str(r#"{"format":"bgra8unorm","usage":16,"width":640,"height":480}"#)
            .unwrap();
    assert_eq!(desc.present_mode, PresentModeJs::Fifo); // default
    assert_eq!(desc.alpha_mode, None);
    assert_eq!(desc.desired_maximum_frame_latency, None);
    assert!(desc.view_formats.is_empty());
}

// ============================================================================
// w6: BufferBindingTypeJs round-trip test
// ============================================================================

#[wasm_bindgen_test]
fn test_buffer_binding_type_round_trip() {
    let uniform: BufferBindingTypeJs = serde_json::from_str("\"uniform\"").unwrap();
    assert_eq!(uniform, BufferBindingTypeJs::Uniform);
    assert!(matches!(
        uniform.into_wgpu(),
        wgpu::BufferBindingType::Uniform
    ));

    let storage: BufferBindingTypeJs = serde_json::from_str("\"storage\"").unwrap();
    assert_eq!(storage, BufferBindingTypeJs::Storage);
    assert!(matches!(
        storage.into_wgpu(),
        wgpu::BufferBindingType::Storage { read_only: false }
    ));

    let ros: BufferBindingTypeJs = serde_json::from_str("\"read-only-storage\"").unwrap();
    assert_eq!(ros, BufferBindingTypeJs::ReadOnlyStorage);
    assert!(matches!(
        ros.into_wgpu(),
        wgpu::BufferBindingType::Storage { read_only: true }
    ));

    let err = serde_json::from_str::<BufferBindingTypeJs>("\"Uniform\"");
    assert!(err.is_err());
}

// ============================================================================
// w7: TextureSampleTypeJs round-trip test
// ============================================================================

#[wasm_bindgen_test]
fn test_texture_sample_type_round_trip() {
    let float: TextureSampleTypeJs = serde_json::from_str("\"float\"").unwrap();
    assert_eq!(float, TextureSampleTypeJs::Float);
    assert!(matches!(
        float.into_wgpu(),
        wgpu::TextureSampleType::Float { filterable: true }
    ));

    let unfilterable: TextureSampleTypeJs = serde_json::from_str("\"unfilterable-float\"").unwrap();
    assert_eq!(unfilterable, TextureSampleTypeJs::UnfilterableFloat);
    assert!(matches!(
        unfilterable.into_wgpu(),
        wgpu::TextureSampleType::Float { filterable: false }
    ));

    let depth: TextureSampleTypeJs = serde_json::from_str("\"depth\"").unwrap();
    assert_eq!(depth, TextureSampleTypeJs::Depth);
    assert!(matches!(depth.into_wgpu(), wgpu::TextureSampleType::Depth));

    let sint: TextureSampleTypeJs = serde_json::from_str("\"sint\"").unwrap();
    assert_eq!(sint, TextureSampleTypeJs::Sint);
    assert!(matches!(sint.into_wgpu(), wgpu::TextureSampleType::Sint));

    let uint: TextureSampleTypeJs = serde_json::from_str("\"uint\"").unwrap();
    assert_eq!(uint, TextureSampleTypeJs::Uint);
    assert!(matches!(uint.into_wgpu(), wgpu::TextureSampleType::Uint));

    let err = serde_json::from_str::<TextureSampleTypeJs>("\"Float\"");
    assert!(err.is_err());
}

// ============================================================================
// w8: SamplerBorderColorJs round-trip test
// ============================================================================

#[wasm_bindgen_test]
fn test_sampler_border_color_round_trip() {
    let transparent: SamplerBorderColorJs = serde_json::from_str("\"transparent-black\"").unwrap();
    assert_eq!(transparent, SamplerBorderColorJs::TransparentBlack);
    assert!(matches!(
        transparent.into_wgpu(),
        wgpu::SamplerBorderColor::TransparentBlack
    ));

    let opaque_black: SamplerBorderColorJs = serde_json::from_str("\"opaque-black\"").unwrap();
    assert_eq!(opaque_black, SamplerBorderColorJs::OpaqueBlack);
    assert!(matches!(
        opaque_black.into_wgpu(),
        wgpu::SamplerBorderColor::OpaqueBlack
    ));

    let opaque_white: SamplerBorderColorJs = serde_json::from_str("\"opaque-white\"").unwrap();
    assert_eq!(opaque_white, SamplerBorderColorJs::OpaqueWhite);
    assert!(matches!(
        opaque_white.into_wgpu(),
        wgpu::SamplerBorderColor::OpaqueWhite
    ));

    let err = serde_json::from_str::<SamplerBorderColorJs>("\"TransparentBlack\"");
    assert!(err.is_err());
}

// ============================================================================
// w9: PresentModeJs + QueryTypeJs round-trip tests
// ============================================================================

#[wasm_bindgen_test]
fn test_present_mode_round_trip() {
    let fifo: PresentModeJs = serde_json::from_str("\"fifo\"").unwrap();
    assert_eq!(fifo, PresentModeJs::Fifo);
    assert!(matches!(fifo.into_wgpu(), wgpu::PresentMode::Fifo));

    let relaxed: PresentModeJs = serde_json::from_str("\"fifo-relaxed\"").unwrap();
    assert_eq!(relaxed, PresentModeJs::FifoRelaxed);
    assert!(matches!(
        relaxed.into_wgpu(),
        wgpu::PresentMode::FifoRelaxed
    ));

    let immediate: PresentModeJs = serde_json::from_str("\"immediate\"").unwrap();
    assert_eq!(immediate, PresentModeJs::Immediate);
    assert!(matches!(
        immediate.into_wgpu(),
        wgpu::PresentMode::Immediate
    ));

    let mailbox: PresentModeJs = serde_json::from_str("\"mailbox\"").unwrap();
    assert_eq!(mailbox, PresentModeJs::Mailbox);
    assert!(matches!(mailbox.into_wgpu(), wgpu::PresentMode::Mailbox));

    let auto_vsync: PresentModeJs = serde_json::from_str("\"auto-vsync\"").unwrap();
    assert_eq!(auto_vsync, PresentModeJs::AutoVsync);
    assert!(matches!(
        auto_vsync.into_wgpu(),
        wgpu::PresentMode::AutoVsync
    ));

    let auto_no_vsync: PresentModeJs = serde_json::from_str("\"auto-no-vsync\"").unwrap();
    assert_eq!(auto_no_vsync, PresentModeJs::AutoNoVsync);
    assert!(matches!(
        auto_no_vsync.into_wgpu(),
        wgpu::PresentMode::AutoNoVsync
    ));

    let err = serde_json::from_str::<PresentModeJs>("\"Fifo\"");
    assert!(err.is_err());
}

#[wasm_bindgen_test]
fn test_query_type_round_trip() {
    let occlusion: QueryTypeJs = serde_json::from_str("\"occlusion\"").unwrap();
    assert_eq!(occlusion, QueryTypeJs::Occlusion);
    assert!(matches!(occlusion.into_wgpu(), wgpu::QueryType::Occlusion));

    let timestamp: QueryTypeJs = serde_json::from_str("\"timestamp\"").unwrap();
    assert_eq!(timestamp, QueryTypeJs::Timestamp);
    assert!(matches!(timestamp.into_wgpu(), wgpu::QueryType::Timestamp));

    let err = serde_json::from_str::<QueryTypeJs>("\"Occlusion\"");
    assert!(err.is_err());
}

// ============================================================================
// w11: ShaderModuleDescriptorJs round-trip test
// ============================================================================

#[wasm_bindgen_test]
fn test_shader_module_descriptor_json_round_trip() {
    let desc: ShaderModuleDescriptorJs = serde_json::from_str(
        r#"{"code":"@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }"}"#,
    )
    .unwrap();
    assert!(desc.code.contains("@vertex"));
    assert!(desc.label.is_none());

    let desc2: ShaderModuleDescriptorJs = serde_json::from_str(
            r#"{"code":"@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }","label":"my-shader"}"#
        ).unwrap();
    assert_eq!(desc2.label.as_deref(), Some("my-shader"));

    let err = serde_json::from_str::<ShaderModuleDescriptorJs>(r#"{"label":"no-code"}"#);
    assert!(err.is_err());
}

// ========================================================================
// w4 (F3): create_render_pipeline descriptor parse helpers never panic on
// malformed input -- they return structured Err carrying the stable prefix
// `[wgpu-wasm] failed to parse` + the offending field index (AC-01/02/03).
//
// The malformed paths live in the free helpers parse_vertex_buffers /
// parse_color_targets (extracted from create_render_pipeline so the parse
// boundary is reachable without a real wgpu::Device -- spike-w3 proved node
// cannot construct an adapter, so a device-bound test of the method itself
// is impossible; the helpers are the SSOT both production and tests drive).
// ========================================================================

fn js_array(items: &[JsValue]) -> JsValue {
    let arr = js_sys::Array::new();
    for it in items {
        arr.push(it);
    }
    arr.into()
}

fn js_obj(pairs: &[(&str, JsValue)]) -> JsValue {
    let obj = js_sys::Object::new();
    for (k, v) in pairs {
        js_sys::Reflect::set(&obj, &JsValue::from_str(k), v).unwrap();
    }
    obj.into()
}

// (a) malformed vertex.buffers element -> Err (not panic), message carries
//     the `vertex.buffers` field path + element index.
#[wasm_bindgen_test]
fn test_parse_vertex_buffers_malformed_returns_err() {
    // An array whose [0] is a plain {} -> serde fails (missing arrayStride
    // / attributes). The fix must surface this as Err, never a wasm trap.
    let buffers = js_array(&[js_obj(&[])]);
    let res = parse_vertex_buffers(&buffers);
    assert!(res.is_err(), "malformed vertex.buffers must return Err");
    let msg = res.err().unwrap().as_string().unwrap_or_default();
    assert!(
        msg.contains("[wgpu-wasm] failed to parse"),
        "Err message must carry the stable prefix, got: {msg}"
    );
    assert!(
        msg.contains("vertex.buffers"),
        "Err message must name the offending field, got: {msg}"
    );
    assert!(
        msg.contains("[0]"),
        "Err message must carry the index, got: {msg}"
    );
}

// (b) malformed fragment.targets element (invalid format) -> Err (not the
//     former panic!), message carries `fragment.targets[i]`.
#[wasm_bindgen_test]
fn test_parse_color_targets_malformed_returns_err() {
    // [0] has an invalid `format` value -> serde rejects -> must be Err.
    let targets = js_array(&[js_obj(&[("format", JsValue::from_str("not-a-format"))])]);
    let res = parse_color_targets(&targets);
    assert!(res.is_err(), "malformed fragment.targets must return Err");
    let msg = res.err().unwrap().as_string().unwrap_or_default();
    assert!(
        msg.contains("[wgpu-wasm] failed to parse"),
        "Err message must carry the stable prefix, got: {msg}"
    );
    assert!(
        msg.contains("fragment.targets[0]"),
        "Err message must name field + index, got: {msg}"
    );
}

// (c) vertex-only equivalence: an empty / missing targets list parses to an
//     empty Vec (Ok) -- the if-let lift (F3-c) keeps the no-fragment path
//     behaviour-equivalent; a non-array targets value yields an empty Vec
//     too (is_array() guard), never an Err.
#[wasm_bindgen_test]
fn test_parse_color_targets_empty_and_nonarray_ok() {
    let empty = parse_color_targets(&js_array(&[])).expect("empty targets must be Ok");
    assert_eq!(empty.len(), 0);
    let undef = parse_color_targets(&JsValue::UNDEFINED).expect("undefined targets must be Ok");
    assert_eq!(undef.len(), 0);
    let buffers = parse_vertex_buffers(&JsValue::UNDEFINED).expect("undefined buffers must be Ok");
    assert_eq!(buffers.len(), 0);
}

// (d) sparse targets: null / undefined elements map to push(None) and must
//     NOT be misclassified as malformed (boundary table row 2).
#[wasm_bindgen_test]
fn test_parse_color_targets_sparse_ok() {
    let valid = js_obj(&[("format", JsValue::from_str("rgba8unorm"))]);
    let targets = js_array(&[JsValue::NULL, valid, JsValue::UNDEFINED]);
    let res = parse_color_targets(&targets).expect("sparse targets must be Ok");
    assert_eq!(res.len(), 3);
    assert!(res[0].is_none(), "null element -> None");
    assert!(res[1].is_some(), "valid element -> Some");
    assert!(res[2].is_none(), "undefined element -> None");
}

#[wasm_bindgen_test]
fn test_parse_pipeline_constant_values_round_trip() {
    let constants = js_obj(&[
        ("FOO", JsValue::from_f64(2.5)),
        ("BAR", JsValue::from_f64(-1.0)),
    ]);
    let vertex = js_obj(&[("constants", constants)]);
    let parsed = parse_pipeline_constants(&vertex, "vertex.constants")
        .expect("pipeline constants must parse");
    assert_eq!(parsed.len(), 2);
    assert_eq!(
        parsed
            .iter()
            .find(|(name, _)| *name == "FOO")
            .map(|(_, v)| *v),
        Some(2.5)
    );
    assert_eq!(
        parsed
            .iter()
            .find(|(name, _)| *name == "BAR")
            .map(|(_, v)| *v),
        Some(-1.0)
    );
}

#[wasm_bindgen_test]
fn test_parse_pipeline_constants_rejects_non_numeric_value() {
    let constants = js_obj(&[("FOO", JsValue::from_str("not-a-number"))]);
    let vertex = js_obj(&[("constants", constants)]);
    let error = parse_pipeline_constants(&vertex, "vertex.constants").unwrap_err();
    let message = error.as_string().unwrap_or_default();
    assert!(message.contains("[wgpu-wasm] failed to parse"));
    assert!(message.contains("vertex.constants"));
}

// ========================================================================
// w9 (AC-09b): the parse helpers survive a malformed call -- Err does not
// poison the wasm instance, a subsequent valid call still succeeds.
//
// Coverage boundary (declared so judgment can reference it):
// This test proves the *parse boundary* is panic-free and the wasm instance
// survives an Err return. It does NOT prove that a real wgpu::Device's GPU
// state stack is unpoisoned after a failed createRenderPipeline -- that
// requires an actual adapter/device, which node cannot supply (spike-w3
// proved request_adapter returns NULL). That gap is a judgment-phase
// declaration, not a test gap we can close without real GPU.
//
// Design: the old panic! inside parse_* would trap the entire wasm process
// (instant abort). If this test reaches step 2 and asserts Ok, the fix
// (Err-return instead of panic) has been confirmed and the instance is
// alive.
// ========================================================================
#[wasm_bindgen_test]
fn test_wasm_instance_survives_parse_error_then_success() {
    // Step 1: malformed vertex.buffers (plain {} -> missing arrayStride /
    // attributes). Must return Err, NOT trap.
    let malformed = js_array(&[js_obj(&[])]);
    let res1 = parse_vertex_buffers(&malformed);
    assert!(
        res1.is_err(),
        "step 1: malformed parse must return Err (not trap)"
    );
    let msg = res1.err().unwrap().as_string().unwrap_or_default();
    assert!(
        msg.contains("[wgpu-wasm] failed to parse vertex.buffers[0]"),
        "step 1: Err message must name the field + index, got: {msg}"
    );

    // Step 2: same wasm instance, valid input. Must return Ok -- proves
    // the instance was NOT poisoned by the Err above.
    let valid_attr = js_obj(&[
        ("format", JsValue::from_str("float32x3")),
        ("offset", JsValue::from_f64(0.0)),
        ("shaderLocation", JsValue::from_f64(0.0)),
    ]);
    let valid = js_array(&[js_obj(&[
        ("arrayStride", JsValue::from_f64(32.0)),
        ("attributes", js_array(&[valid_attr])),
    ])]);
    let res2 = parse_vertex_buffers(&valid);
    assert!(
        res2.is_ok(),
        "step 2: valid parse after Err must succeed (instance not poisoned)"
    );
    let vbs = res2.unwrap();
    assert_eq!(vbs.len(), 1);
    let layout = vbs[0].as_ref().expect("valid vertex buffer layout");
    assert_eq!(layout.array_stride, 32);
    assert_eq!(layout.attributes.len(), 1);
    assert_eq!(layout.attributes[0].shader_location, 0);
}

// ========================================================================
// M3: classify_uncaptured_error free-helper tests (TDD red->green).
//
// Node cannot construct a wgpu adapter (spike-w3), so the pure-string
// classification lives in a free helper at module level — same pattern
// as parse_vertex_buffers / parse_color_targets. The caller in M4 is the
// on_uncaptured_error callback that formats wgpu::Error as Debug and
// passes the string through to the TS shim via a per-queue slot.
//
// Panic policy: classify_uncaptured_error never panics (req AC-04).
// Empty / malformed / unrecognised input -> WebgpuRuntimeError (safe
// fallback so the TS caller always gets a valid RhiErrorCode).
// ========================================================================

#[wasm_bindgen_test]
fn test_classify_uncaptured_error_validation() {
    let msg = "Validation { source: ..., description: \"Queue::submit failed: buffer destroyed\" }";
    let c = classify_uncaptured_error(msg);
    assert_eq!(
        c,
        UncapturedErrorClass::QueueSubmitFailed,
        "Validation error must classify as QueueSubmitFailed"
    );
}

#[wasm_bindgen_test]
fn test_classify_uncaptured_error_out_of_memory() {
    let msg = "OutOfMemory { source: ... }";
    let c = classify_uncaptured_error(msg);
    assert_eq!(
        c,
        UncapturedErrorClass::WebgpuRuntimeError,
        "OutOfMemory error must classify as WebgpuRuntimeError"
    );
}

#[wasm_bindgen_test]
fn test_classify_uncaptured_error_internal() {
    let msg = "Internal { source: Some(Error), description: \"internal driver failure\" }";
    let c = classify_uncaptured_error(msg);
    assert_eq!(
        c,
        UncapturedErrorClass::WebgpuRuntimeError,
        "Internal error must classify as WebgpuRuntimeError"
    );
}

#[wasm_bindgen_test]
fn test_classify_uncaptured_error_empty_string() {
    let c = classify_uncaptured_error("");
    assert_eq!(
        c,
        UncapturedErrorClass::WebgpuRuntimeError,
        "empty string must classify as WebgpuRuntimeError (safe fallback, never panic)"
    );
}

#[wasm_bindgen_test]
fn test_classify_uncaptured_error_unrecognized() {
    let c = classify_uncaptured_error("garbage unreadable bytes \0 \n\t");
    assert_eq!(
        c,
        UncapturedErrorClass::WebgpuRuntimeError,
        "unrecognized input must classify as WebgpuRuntimeError (safe fallback, never panic)"
    );
}

#[wasm_bindgen_test]
fn test_classify_uncaptured_error_instance_survives() {
    // Step 1: unrecognized input -> safe fallback, no panic.
    let c1 = classify_uncaptured_error("totally unknown message");
    assert_eq!(
        c1,
        UncapturedErrorClass::WebgpuRuntimeError,
        "step 1: malformed input must return safe fallback"
    );

    // Step 2: valid Validation message after malformed input -> correct
    // classification, instance not poisoned.
    let c2 = classify_uncaptured_error(
        "Validation { source: ..., description: \"Vertex buffer is not big enough\" }",
    );
    assert_eq!(
        c2,
        UncapturedErrorClass::QueueSubmitFailed,
        "step 2: valid Validation after malformed input must classify correctly"
    );

    // Step 3: Internal after Validation -> correct, instance survives
    // across multiple call types.
    let c3 = classify_uncaptured_error(
        "Internal { source: ..., description: \"backend connection lost\" }",
    );
    assert_eq!(
        c3,
        UncapturedErrorClass::WebgpuRuntimeError,
        "step 3: Internal after Validation must classify correctly"
    );
}

#[wasm_bindgen_test]
fn test_creation_error_boundary_clears_stale_error_and_recovers() {
    store_uncaptured_error("stale error from a prior operation".to_string());
    let legal = create_with_uncaptured_error(|| 7_u32).expect("stale error must not leak");
    assert_eq!(legal, 7);

    let failed = create_with_uncaptured_error(|| {
        store_uncaptured_error("Validation { description: \"invalid pipeline\" }".to_string());
        8_u32
    })
    .expect_err("validation must fail closed");
    let message = failed.as_string().unwrap_or_default();
    assert!(message.starts_with("[rhi-code:webgpu-runtime-error]"));
    assert!(message.contains("invalid pipeline"));

    let recovered = create_with_uncaptured_error(|| 9_u32)
        .expect("the consumed error slot must allow the next creation");
    assert_eq!(recovered, 9);
}

#[wasm_bindgen_test]
fn reverse_z_device_feature_request() {
    assert_eq!(super::parse_requested_features(&["depth32float-stencil8".into()]).unwrap(),
        wgpu::Features::DEPTH32FLOAT_STENCIL8);
    assert!(super::parse_requested_features(&["not-a-feature".into()]).is_err());
    assert!(super::parse_requested_features(&[]).unwrap().is_empty());
}
