use alloc::{string::String, vec::Vec};

const SOURCE: &str = r#"
enable wgpu_ray_query;
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1)
fn main() {
    var query: ray_query;
    let ray = RayDesc(0u, 255u, 0.0, 10.0, vec3f(0.0), vec3f(1.0, 0.0, 0.0));
    rayQueryInitialize(&query, scene, ray);
    while (rayQueryProceed(&query)) {}
    let previous = rayQueryGetCommittedIntersection(&query);
    rayQueryInitialize(&query, scene,
        RayDesc(0u, 255u, previous.t, 10.0, vec3f(0.0), vec3f(1.0, 0.0, 0.0)));
    output[0] = u32(rayQueryProceed(&query));
    rayQueryTerminate(&query);
    rayQueryInitialize(&query, scene,
        RayDesc(0u, 255u, bitcast<f32>(output[1]), 10.0,
            vec3f(0.0), vec3f(1.0, 0.0, 0.0)));
    output[2] = u32(rayQueryProceed(&query));
}
"#;

fn translate(tracking: bool) -> String {
    let module = crate::front::wgsl::parse_str(SOURCE).unwrap();
    let info = crate::valid::Validator::new(
        crate::valid::ValidationFlags::all(),
        crate::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap();
    let options = super::Options {
        shader_model: super::ShaderModel::V6_7,
        ray_query_initialization_tracking: tracking,
        ..Default::default()
    };
    let pipeline = super::PipelineOptions {
        entry_point: Some((crate::ShaderStage::Compute, String::from("main"))),
    };
    let mut output = String::new();
    super::Writer::new(&mut output, &options, &pipeline)
        .write(&module, &info, None)
        .unwrap();
    output
}

fn initializations(output: &str) -> Vec<&str> {
    output
        .split("RayDesc_ naga_desc = ")
        .skip(1)
        .map(|block| block.split_once(".TraceRayInline(").unwrap().0)
        .collect()
}

// Evaluate only the writer's constant/bitwise tracker assignments, failing closed
// if their shape changes. Descriptor validity is an independent input here.
fn initialize(block: &str, mut state: u32, valid: bool) -> u32 {
    let mut guarded = false;
    for line in block.lines().map(str::trim) {
        if line.starts_with("if (naga_tmin_valid") {
            guarded = true;
        }
        if !line.starts_with("naga_query_init_tracker_for_") || !line.contains(" = ") {
            continue;
        }
        let (name, rhs) = line.trim_end_matches(';').split_once(" = ").unwrap();
        let value = if let Some(bits) = rhs.strip_prefix(&alloc::format!("{name} | ")) {
            state | bits.parse::<u32>().unwrap()
        } else {
            rhs.parse::<u32>().unwrap()
        };
        if valid || !guarded {
            state = value;
        }
    }
    state
}

#[test]
fn reinitialize_discards_previous_proceed_finished_and_invalid_state() {
    let output = translate(true);
    let blocks = initializations(&output);
    assert_eq!(blocks.len(), 3);
    for block in blocks {
        for old in [0, 1, 3, 7] {
            assert_eq!(initialize(block, old, true), 1, "valid after state {old}");
            assert_eq!(
                initialize(block, old, false),
                0,
                "invalid after state {old}"
            );
        }
    }
}

#[test]
fn reset_follows_descriptor_evaluation_and_precedes_validity_guard() {
    let output = translate(true);
    for block in initializations(&output) {
        let descriptor_end = block.find(';').unwrap();
        let reset = block
            .find("naga_query_init_tracker_for_query = 0;")
            .expect("each initialization must reset the previous query state");
        let guard = block.find("if (naga_tmin_valid").unwrap();
        assert!(descriptor_end < reset && reset < guard);
        assert!(block.contains("naga_query_init_tracker_for_query = 1;"));
    }
    let getter = output.find(".CommittedStatus()").unwrap();
    let second_descriptor = output
        .match_indices("RayDesc_ naga_desc = ")
        .nth(1)
        .unwrap()
        .0;
    assert!(getter < second_descriptor);
}

#[test]
fn reinitialization_keeps_proceed_abort_and_untracked_lowering() {
    let output = translate(true);
    assert_eq!(output.matches(".TraceRayInline(").count(), 3);
    assert_eq!(output.matches(".Proceed()").count(), 3);
    assert_eq!(output.matches(".Abort()").count(), 1);
    assert!(output.contains("& 1) == 1"));
    assert!(output.contains("& 4) == 4"));
    assert!(output.contains("| 2;"));
    assert!(output.contains("| 4;"));
    let untracked = translate(false);
    assert!(!untracked.contains("naga_has_initialized"));
    assert!(!untracked.contains("naga_has_finished"));
    assert!(!untracked.contains("| 1;"));
    assert!(!untracked.contains("naga_tmin_valid"));
    assert_eq!(untracked.matches(".TraceRayInline(").count(), 3);
    assert_eq!(untracked.matches(".Proceed()").count(), 3);
    assert_eq!(untracked.matches(".Abort()").count(), 1);
}
