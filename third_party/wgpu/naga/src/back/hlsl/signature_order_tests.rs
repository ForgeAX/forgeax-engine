use alloc::{string::String, vec::Vec};

const SOURCE: &str = r#"
enable primitive_index;
struct VsOut {
    @builtin(position) @invariant clip: vec4f,
    @location(7) @interpolate(flat) object: vec4u,
    @location(1) normal: vec3f,
};
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VsOut {
    return VsOut(vec4f(f32(index), 0.0, 0.0, 1.0), vec4u(index), vec3f(f32(index)));
}
@fragment
fn fs_gbuffer(input: VsOut, @builtin(front_facing) front: bool,
    @builtin(primitive_index) primitive: u32) -> @location(0) vec4f {
    return vec4f(input.normal + input.clip.xyz + vec3f(input.object.xyz),
        f32(primitive) + select(-1.0, 1.0, front));
}
"#;

fn translate(
    model: super::ShaderModel,
    stage: crate::ShaderStage,
    invariant: bool,
    primitive: bool,
) -> String {
    let mut source = if invariant {
        String::from(SOURCE)
    } else {
        SOURCE.replace(" @invariant", "")
    };
    if !primitive {
        source = source
            .replace(",\n    @builtin(primitive_index) primitive: u32", "")
            .replace("f32(primitive)", "0.0");
    }
    let module = crate::front::wgsl::parse_str(&source).unwrap();
    let info = crate::valid::Validator::new(
        crate::valid::ValidationFlags::all(),
        crate::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap();
    let entry = match stage {
        crate::ShaderStage::Vertex => "vs_main",
        crate::ShaderStage::Fragment => "fs_gbuffer",
        _ => unreachable!(),
    };
    let options = super::Options {
        shader_model: model,
        ..Default::default()
    };
    let pipeline_options = super::PipelineOptions {
        entry_point: Some((stage, String::from(entry))),
    };
    let fragment = (stage == crate::ShaderStage::Vertex)
        .then(|| super::FragmentEntryPoint::new(&module, "fs_gbuffer").unwrap());
    let mut output = String::new();
    super::Writer::new(&mut output, &options, &pipeline_options)
        .write(&module, &info, fragment.as_ref())
        .unwrap();
    output
}

fn signature(source: &str, name: &str) -> Vec<String> {
    let (_, body) = source
        .split_once(&alloc::format!("struct {name} {{"))
        .unwrap();
    body.split_once("};")
        .unwrap()
        .0
        .lines()
        .filter_map(|line| {
            line.split_once(" : ")
                .map(|(_, semantic)| String::from(semantic))
        })
        .collect()
}

#[test]
fn dxc_signature_position_precedes_fragment_only_primitive_index() {
    for model in [
        super::ShaderModel::V6_0,
        super::ShaderModel::V6_7,
        super::ShaderModel::V6_10,
    ] {
        for invariant in [false, true] {
            let vertex = translate(model, crate::ShaderStage::Vertex, invariant, true);
            let fragment = translate(model, crate::ShaderStage::Fragment, invariant, true);
            assert_eq!(
                signature(&vertex, "VertexOutput_vs_main"),
                ["LOC1;", "LOC7;", "SV_Position;"]
            );
            assert_eq!(
                signature(&fragment, "FragmentInput_fs_gbuffer"),
                [
                    "LOC1;",
                    "LOC7;",
                    "SV_Position;",
                    "SV_PrimitiveID;",
                    "SV_IsFrontFace;"
                ]
            );
            assert!(fragment.contains("nointerpolation uint4 object : LOC7;"));
            assert_eq!(
                vertex.contains("precise float4 clip_ : SV_Position;"),
                invariant
            );
            assert_eq!(
                fragment.contains("precise float4 clip_ : SV_Position;"),
                invariant
            );
            assert!(fragment.contains("fragmentinput_fs_gbuffer.primitive_1"));
            assert!(fragment.contains("fragmentinput_fs_gbuffer.front_1"));
        }
    }
}

#[test]
fn fxc_signature_keeps_primitive_index_before_position() {
    for model in [super::ShaderModel::V5_0, super::ShaderModel::V5_1] {
        let fragment = translate(model, crate::ShaderStage::Fragment, true, true);
        assert_eq!(
            signature(&fragment, "FragmentInput_fs_gbuffer"),
            [
                "LOC1;",
                "LOC7;",
                "SV_PrimitiveID;",
                "SV_Position;",
                "SV_IsFrontFace;"
            ]
        );
    }
}

#[test]
fn signature_without_primitive_index_keeps_position_and_front_face() {
    for model in [super::ShaderModel::V5_1, super::ShaderModel::V6_7] {
        let vertex = translate(model, crate::ShaderStage::Vertex, true, false);
        let fragment = translate(model, crate::ShaderStage::Fragment, true, false);
        assert_eq!(
            signature(&vertex, "VertexOutput_vs_main"),
            ["LOC1;", "LOC7;", "SV_Position;"]
        );
        assert_eq!(
            signature(&fragment, "FragmentInput_fs_gbuffer"),
            ["LOC1;", "LOC7;", "SV_Position;", "SV_IsFrontFace;"]
        );
    }
}
