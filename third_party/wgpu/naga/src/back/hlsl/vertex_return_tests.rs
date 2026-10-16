use alloc::string::String;

const SOURCE: &str = r#"
enable wgpu_ray_query;
enable wgpu_ray_query_vertex_return;
@group(0) @binding(0) var scene: acceleration_structure<vertex_return>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main() {
    var query: ray_query<vertex_return>;
    rayQueryInitialize(&query, scene, RayDesc(0u, 255u, 0.0, 10.0, vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0)));
    while rayQueryProceed(&query) {
        let candidate = getCandidateHitVertexPositions(&query);
        output[0] = vec4f(candidate[0], 1.0);
        rayQueryConfirmIntersection(&query);
    }
    let committed = getCommittedHitVertexPositions(&query);
    output[1] = vec4f(committed[2], 1.0);
}
"#;

fn translate(shader_model: super::ShaderModel, tracking: bool) -> Result<String, super::Error> {
    let module = crate::front::wgsl::parse_str(SOURCE).unwrap();
    let info = crate::valid::Validator::new(
        crate::valid::ValidationFlags::all(),
        crate::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap();
    let options = super::Options {
        shader_model,
        ray_query_initialization_tracking: tracking,
        ..Default::default()
    };
    let mut output = String::new();
    let pipeline_options = super::PipelineOptions::default();
    super::Writer::new(&mut output, &options, &pipeline_options).write(&module, &info, None)?;
    Ok(output)
}

#[test]
fn lower_shader_model_returns_error_for_vertex_positions() {
    for model in [super::ShaderModel::V6_5, super::ShaderModel::V6_9] {
        assert!(matches!(
            translate(model, true),
            Err(super::Error::ShaderModelTooLow(
                _,
                super::ShaderModel::V6_10
            ))
        ));
    }
}

#[test]
fn shader_model_6_10_translates_candidate_and_committed_vertex_positions() {
    for tracking in [true, false] {
        let output = translate(super::ShaderModel::V6_10, tracking).unwrap();
        assert!(output.contains("rq.CandidateTriangleObjectPositions()"));
        assert!(output.contains("rq.CommittedTriangleObjectPositions()"));
        for i in 0..3 {
            assert!(output.contains(&alloc::format!("ret[{i}] = positions.p{i};")));
        }
        if tracking {
            assert!(output.contains("rq.CommittedStatus() == COMMITTED_TRIANGLE_HIT"));
            assert!(output.contains("rq.CandidateType() == CANDIDATE_NON_OPAQUE_TRIANGLE"));
        }
    }
}
