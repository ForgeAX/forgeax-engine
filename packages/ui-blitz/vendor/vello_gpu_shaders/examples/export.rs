//! Export the matching generated WGSL for the Engine's RHI executor.
fn main() {
    let out = std::path::PathBuf::from(std::env::args().nth(1).expect("output directory"));
    std::fs::create_dir_all(&out).unwrap();
    for (name, source) in vello_gpu_shaders::wgsl::ALL {
        std::fs::write(out.join(format!("{name}.wgsl")), source).unwrap();
    }
}
