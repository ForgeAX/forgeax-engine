use forgeax_rhi_wgpu_native::conformance::{run, ConformanceConfig, RequestedProfile};
use std::path::PathBuf;

fn main() {
    match parse_arguments().and_then(run) {
        Ok(report_directory) => println!("{}", report_directory.display()),
        Err(error) => {
            eprintln!("ray-query-conformance: {error}");
            std::process::exit(1);
        }
    }
}

fn parse_arguments() -> Result<ConformanceConfig, String> {
    let mut output_root = PathBuf::from("report/native-ray-query-conformance");
    let mut profiles = RequestedProfile::parse("core")?;
    let mut sync_iterations = 100;
    let mut soak_frames = 0;
    let mut packaged_executable_identity = None;
    let mut tauri_report = None;
    let mut upstream_report = None;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--output-root" => {
                output_root = PathBuf::from(value(&mut arguments, "--output-root")?);
            }
            "--profile" => {
                profiles = RequestedProfile::parse(&value(&mut arguments, "--profile")?)?;
            }
            "--sync-iterations" => {
                sync_iterations = value(&mut arguments, "--sync-iterations")?
                    .parse()
                    .map_err(|error| format!("invalid --sync-iterations: {error}"))?;
            }
            "--soak-frames" => {
                soak_frames = value(&mut arguments, "--soak-frames")?
                    .parse()
                    .map_err(|error| format!("invalid --soak-frames: {error}"))?;
            }
            "--packaged-executable" => {
                packaged_executable_identity =
                    Some(value(&mut arguments, "--packaged-executable")?);
            }
            "--tauri-report" => {
                tauri_report = Some(PathBuf::from(value(&mut arguments, "--tauri-report")?));
            }
            "--upstream-report" => {
                upstream_report = Some(PathBuf::from(value(&mut arguments, "--upstream-report")?));
            }
            "--help" | "-h" => {
                println!(
                    "ray-query-conformance [--profile core|extended|stability|performance|upstream|full] \
                     [--output-root PATH] [--sync-iterations N] [--soak-frames N] \
                     [--packaged-executable ID] [--tauri-report PATH] [--upstream-report PATH]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument '{other}'")),
        }
    }
    Ok(ConformanceConfig {
        output_root,
        profiles,
        sync_iterations,
        soak_frames,
        packaged_executable_identity,
        tauri_report,
        upstream_report,
    })
}

fn value(arguments: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    arguments
        .next()
        .ok_or_else(|| format!("{flag} requires a value"))
}
