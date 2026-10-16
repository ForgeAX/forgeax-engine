use super::*;

#[test]
fn clip_depth_convention_preserves_y_adjustment_and_return_paths() {
    for source in [
        r#"
@vertex fn main(@location(0) p: vec4<f32>) -> @builtin(position) vec4<f32> {
    if p.x > 0.0 { return p; }
    return vec4<f32>(-p.x, p.yzw);
}"#,
        r#"
struct Output { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn main(@location(0) p: vec4<f32>) -> Output {
    return Output(p, vec2<f32>(0.0));
}"#,
    ] {
        let module = crate::front::wgsl::parse_str(source).unwrap();
        let info = valid::Validator::new(valid::ValidationFlags::all(), valid::Capabilities::all())
            .validate(&module)
            .unwrap();
        for zero_to_one in [false, true] {
            let mut options = Options::default();
            options
                .writer_flags
                .set(WriterFlags::ZERO_TO_ONE_DEPTH, zero_to_one);
            let pipeline = PipelineOptions {
                shader_stage: ShaderStage::Vertex,
                entry_point: "main".into(),
                multiview: None,
            };
            let mut output = String::new();
            Writer::new(
                &mut output,
                &module,
                &info,
                &options,
                &pipeline,
                proc::BoundsCheckPolicies::default(),
            )
            .unwrap()
            .write()
            .unwrap();
            let adjustment = if zero_to_one {
                assert!(!output.contains("gl_Position.z * 2.0 - gl_Position.w"));
                "gl_Position.y = -gl_Position.y;"
            } else {
                "gl_Position.yz = vec2(-gl_Position.y, gl_Position.z * 2.0 - gl_Position.w);"
            };
            assert_eq!(
                output.matches(adjustment).count(),
                output.matches("return;").count()
            );
        }
    }
}
