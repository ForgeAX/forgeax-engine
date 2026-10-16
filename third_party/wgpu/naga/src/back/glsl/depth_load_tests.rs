use super::*;

fn translate(
    source: &str,
    policy: proc::BoundsCheckPolicy,
) -> Result<(String, ReflectionInfo), Error> {
    let module = crate::front::wgsl::parse_str(source).unwrap();
    let info = valid::Validator::new(valid::ValidationFlags::all(), valid::Capabilities::all())
        .validate(&module)
        .unwrap();
    let options = Options {
        version: Version::Desktop(450),
        ..Options::default()
    };
    let pipeline = PipelineOptions {
        shader_stage: ShaderStage::Fragment,
        entry_point: "main".into(),
        multiview: None,
    };
    let mut output = String::new();
    let reflection = Writer::new(
        &mut output,
        &module,
        &info,
        &options,
        &pipeline,
        proc::BoundsCheckPolicies {
            image_load: policy,
            ..Default::default()
        },
    )?
    .write()?;
    Ok((output, reflection))
}

#[test]
fn depth_load_helpers_layers_mips_and_samples() {
    let source = r#"
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var layers: texture_depth_2d_array;
@group(0) @binding(2) var samples: texture_depth_multisampled_2d;
fn read(d: texture_depth_2d, p: vec2<i32>, mip: i32) -> f32 {
    return textureLoad(d, p, mip);
}
@fragment fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(read(depth, vec2<i32>(1, 2), 1),
        textureLoad(layers, vec2<i32>(1, 2), 1, 1),
        textureLoad(samples, vec2<i32>(1, 2), 1), 1.0);
}
"#;
    for policy in [
        proc::BoundsCheckPolicy::Unchecked,
        proc::BoundsCheckPolicy::Restrict,
        proc::BoundsCheckPolicy::ReadZeroSkipWrite,
    ] {
        let (output, reflection) = translate(source, policy).unwrap();
        assert!(output.contains("sampler2D "));
        assert!(output.contains("sampler2DArray "));
        assert!(output.contains("sampler2DMS "));
        assert!(!output.contains("Shadow"));
        assert_eq!(output.matches("texelFetch(").count(), 3);
        assert_eq!(output.matches(").x").count(), 3);
        if policy == proc::BoundsCheckPolicy::ReadZeroSkipWrite {
            assert_eq!(output.matches(" : 0.0)").count(), 3);
        }
        assert_eq!(reflection.texture_mapping.len(), 3);
        assert!(reflection
            .texture_mapping
            .values()
            .all(|mapping| mapping.sampler.is_none()));
    }
}

#[test]
fn depth_comparison_keeps_shadow_sampler() {
    let (output, reflection) = translate(
        r#"
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var comparison: sampler_comparison;
fn compare(d: texture_depth_2d, s: sampler_comparison) -> f32 {
    return textureSampleCompareLevel(d, s, vec2<f32>(0.5), 0.5);
}
@fragment fn main() -> @location(0) f32 { return compare(depth, comparison); }
"#,
        proc::BoundsCheckPolicy::Unchecked,
    )
    .unwrap();
    assert_eq!(output.matches("sampler2DShadow ").count(), 2);
    assert!(!output.contains("texelFetch"));
    assert_eq!(reflection.texture_mapping.len(), 1);
    assert!(reflection
        .texture_mapping
        .values()
        .all(|mapping| mapping.sampler.is_some()));
}

#[test]
fn mixed_depth_load_and_comparison_is_explicitly_unsupported() {
    let error = translate(
        r#"
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var comparison: sampler_comparison;
@fragment fn main() -> @location(0) vec2<f32> {
    return vec2<f32>(textureLoad(depth, vec2<i32>(0), 0),
        textureSampleCompareLevel(depth, comparison, vec2<f32>(0.5), 0.5));
}
"#,
        proc::BoundsCheckPolicy::Unchecked,
    )
    .unwrap_err();
    assert!(matches!(error, Error::Custom(message)
        if message == "GLSL does not support mixing depth texture loads and sampling in one shader"));
}

#[test]
fn noncomparison_depth_samples_and_loads_use_scalar_plain_sampler_reads() {
    for policy in [
        proc::BoundsCheckPolicy::Unchecked,
        proc::BoundsCheckPolicy::Restrict,
        proc::BoundsCheckPolicy::ReadZeroSkipWrite,
    ] {
        let (output, _) = translate(
            r#"
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var linearSampler: sampler;
@fragment fn main() -> @location(0) vec2<f32> {
    return vec2<f32>(textureSampleLevel(depth, linearSampler, vec2<f32>(0.5), 0),
        textureLoad(depth, vec2<i32>(0), 0));
}
"#,
            policy,
        )
        .unwrap();
        assert!(output.contains("sampler2D "));
        assert!(!output.contains("Shadow"));
        assert!(output.contains("textureLod("));
        assert!(output.contains("texelFetch("));
        assert_eq!(output.matches(").x").count(), 2);
    }
}

#[test]
fn independent_depth_globals_keep_plain_and_comparison_sampler_types() {
    let (output, _) = translate(
        r#"
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var shadow: texture_depth_2d;
@group(0) @binding(3) var comparison: sampler_comparison;
@fragment fn main() -> @location(0) vec3<f32> {
    return vec3<f32>(textureSampleLevel(depth, linearSampler, vec2<f32>(0.5), 0),
        textureLoad(depth, vec2<i32>(0), 0),
        textureSampleCompareLevel(shadow, comparison, vec2<f32>(0.5), 0.5));
}
"#,
        proc::BoundsCheckPolicy::ReadZeroSkipWrite,
    )
    .unwrap();
    assert_eq!(output.matches("sampler2D ").count(), 1);
    assert_eq!(output.matches("sampler2DShadow ").count(), 1);
    assert_eq!(output.matches("texelFetch(").count(), 1);
    assert_eq!(output.matches(").x").count(), 2);
}
