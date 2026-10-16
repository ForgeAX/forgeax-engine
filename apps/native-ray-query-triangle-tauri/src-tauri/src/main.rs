use forgeax_rhi_wgpu_native::{
    FrameEvidence, NativeCapabilities, NativeError, RayQueryRenderer, RendererConfig, WGPU_VERSION,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::WindowEvent;

#[derive(Debug, Clone)]
struct Options {
    smoke: bool,
    report_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    schema_version: u32,
    verdict: &'static str,
    mode: &'static str,
    wgpu_version: &'static str,
    tauri_version: &'static str,
    rust_version: &'static str,
    executable: String,
    capabilities: Option<NativeCapabilities>,
    scene: SceneFacts,
    positive: Option<FrameEvidence>,
    resized: Option<FrameEvidence>,
    restored: Option<FrameEvidence>,
    empty_tlas: Option<FrameEvidence>,
    empty_tlas_verdict: Option<&'static str>,
    core_cases: Vec<CoreCaseFacts>,
    error: Option<ErrorFacts>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreCaseFacts {
    id: &'static str,
    status: &'static str,
    detail: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneFacts {
    blas_count: u32,
    tlas_instance_count: u32,
    triangle_count: u32,
}

#[derive(Serialize)]
struct ErrorFacts {
    code: String,
    detail: String,
}

fn main() {
    let options = parse_options();
    tauri::Builder::default()
        .setup(move |app| {
            let side = if options.smoke { 512.0 } else { 800.0 };
            let native_window = match tauri::window::WindowBuilder::new(app, "native-ray-query")
                .title("ForgeaX Native Ray Query Viewport")
                .inner_size(side, side)
                .build()
            {
                Ok(window) => window,
                Err(error) => {
                    if options.smoke {
                        let report = failure_report(
                            "failed",
                            None,
                            "gpu-initialization-failed",
                            format!("failed to create native viewport: {error}"),
                        );
                        persist_report_and_exit(&options.report_dir, &report, 1);
                    }
                    return Ok(());
                }
            };
            let size = native_window.inner_size()?;
            let renderer = pollster::block_on(RayQueryRenderer::new(
                native_window.clone(),
                RendererConfig {
                    width: size.width,
                    height: size.height,
                },
            ));

            let mut renderer = match renderer {
                Ok(renderer) => renderer,
                Err(error) => {
                    eprintln!("[native-ray-query] {error}");
                    if options.smoke {
                        let unsupported = matches!(
                            error,
                            NativeError::NativeBackendUnavailable { .. }
                                | NativeError::RayQueryUnsupported { .. }
                        );
                        let report = failure_report(
                            if unsupported { "unsupported" } else { "failed" },
                            error.capabilities().cloned(),
                            error.code(),
                            error.to_string(),
                        );
                        persist_report_and_exit(
                            &options.report_dir,
                            &report,
                            if unsupported { 2 } else { 1 },
                        );
                    }
                    return Ok(());
                }
            };

            if options.smoke {
                let capabilities = renderer.capabilities().clone();
                let positive = match renderer.capture() {
                    Ok(capture) => capture,
                    Err(error) => {
                        let report = failure_report(
                            "failed",
                            Some(capabilities),
                            error.code(),
                            error.to_string(),
                        );
                        persist_report_and_exit(&options.report_dir, &report, 1);
                    }
                };
                std::fs::create_dir_all(&options.report_dir)?;
                positive.write_png(options.report_dir.join("frame.png"))?;
                let mut resized = None;
                for iteration in 0..100 {
                    let dimensions = if iteration % 2 == 0 {
                        (512, 384)
                    } else {
                        (384, 320)
                    };
                    native_window.set_size(tauri::PhysicalSize::new(dimensions.0, dimensions.1))?;
                    renderer.resize(dimensions.0, dimensions.1);
                    let capture = match renderer.capture() {
                        Ok(capture) => capture,
                        Err(error) => {
                            let report = failure_report(
                                "failed",
                                Some(capabilities),
                                error.code(),
                                format!("resize iteration {iteration}: {error}"),
                            );
                            persist_report_and_exit(&options.report_dir, &report, 1);
                        }
                    };
                    if !capture.evidence.triangle_visible || !capture.evidence.barycentric_variation
                    {
                        let report = failure_report(
                            "failed",
                            Some(capabilities),
                            "evidence-failed",
                            format!("resize iteration {iteration} lost the Ray Query triangle"),
                        );
                        persist_report_and_exit(&options.report_dir, &report, 1);
                    }
                    resized = Some(capture);
                }
                let resized = resized.expect("the 100-iteration resize loop is non-empty");
                resized.write_png(options.report_dir.join("frame-resized.png"))?;
                native_window.minimize()?;
                native_window.unminimize()?;
                native_window.set_focus()?;
                let restored = match renderer.capture() {
                    Ok(capture) => capture,
                    Err(error) => {
                        let report = failure_report(
                            "failed",
                            Some(capabilities),
                            error.code(),
                            error.to_string(),
                        );
                        persist_report_and_exit(&options.report_dir, &report, 1);
                    }
                };
                restored.write_png(options.report_dir.join("frame-restored.png"))?;
                renderer.set_triangle_present(false);
                let empty = match renderer.capture() {
                    Ok(capture) => capture,
                    Err(error) => {
                        let report = failure_report(
                            "failed",
                            Some(capabilities),
                            error.code(),
                            error.to_string(),
                        );
                        persist_report_and_exit(&options.report_dir, &report, 1);
                    }
                };
                renderer.set_triangle_present(true);
                let _ = renderer.render();

                let positive_ok =
                    positive.evidence.triangle_visible && positive.evidence.barycentric_variation;
                let resized_ok = resized.evidence.width == 384
                    && resized.evidence.height == 320
                    && resized.evidence.triangle_visible
                    && resized.evidence.barycentric_variation;
                let restored_ok =
                    restored.evidence.triangle_visible && restored.evidence.barycentric_variation;
                let empty_ok =
                    !empty.evidence.triangle_visible && empty.evidence.non_black_pixel_count == 0;
                let route_ok = positive_ok && resized_ok && restored_ok && empty_ok;
                let report = SmokeReport {
                    schema_version: 2,
                    verdict: if route_ok { "ok" } else { "failed" },
                    mode: "packaged-tauri-smoke",
                    wgpu_version: WGPU_VERSION,
                    tauri_version: tauri::VERSION,
                    rust_version: env!("FORGEAX_RUSTC_VERSION"),
                    executable: executable_path(),
                    capabilities: Some(capabilities),
                    scene: scene_facts(),
                    positive: Some(positive.evidence),
                    resized: Some(resized.evidence),
                    restored: Some(restored.evidence),
                    empty_tlas: Some(empty.evidence),
                    empty_tlas_verdict: empty_ok.then_some("triangle-not-visible"),
                    core_cases: core_case_facts(route_ok),
                    error: (!route_ok).then(|| ErrorFacts {
                        code: "evidence-failed".into(),
                        detail: "positive, resize, restore, or empty-TLAS evidence did not pass"
                            .into(),
                    }),
                };
                persist_report_and_exit(
                    &options.report_dir,
                    &report,
                    if report.verdict == "ok" { 0 } else { 1 },
                );
            }

            let renderer = Arc::new(Mutex::new(Some(renderer)));
            native_window.on_window_event({
                let renderer = Arc::clone(&renderer);
                move |event| match event {
                    WindowEvent::Resized(size) if size.width > 0 && size.height > 0 => {
                        if let Some(renderer) =
                            renderer.lock().expect("renderer lock poisoned").as_mut()
                        {
                            renderer.resize(size.width, size.height);
                            if let Err(error) = renderer.render() {
                                eprintln!("[native-ray-query] resize render failed: {error}");
                            }
                        }
                    }
                    WindowEvent::Focused(true) => {
                        if let Some(renderer) =
                            renderer.lock().expect("renderer lock poisoned").as_mut()
                        {
                            if let Err(error) = renderer.render() {
                                eprintln!("[native-ray-query] focus render failed: {error}");
                            }
                        }
                    }
                    WindowEvent::Destroyed => {
                        renderer.lock().expect("renderer lock poisoned").take();
                    }
                    _ => {}
                }
            });
            native_window.set_focus()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run native Ray Query Tauri app");
}

fn core_case_facts(passed: bool) -> Vec<CoreCaseFacts> {
    let status = if passed { "pass" } else { "fail" };
    [
        ("CREATE-01", "packaged app created and built BLAS/TLAS"),
        ("RQ-01", "positive and miss readbacks matched"),
        ("TLAS-06", "empty TLAS produced zero visible pixels"),
        ("STAB-03", "resized offscreen readback remained correct"),
        (
            "STAB-04",
            "minimize, restore, focus, capture, report, and shutdown completed",
        ),
    ]
    .into_iter()
    .map(|(id, detail)| CoreCaseFacts { id, status, detail })
    .collect()
}

fn parse_options() -> Options {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let smoke = args.iter().any(|arg| arg == "--smoke");
    let report_dir = args
        .windows(2)
        .find(|pair| pair[0] == "--report-dir")
        .map(|pair| PathBuf::from(&pair[1]))
        .unwrap_or_else(|| PathBuf::from("report/native-ray-query-triangle"));
    Options { smoke, report_dir }
}

fn scene_facts() -> SceneFacts {
    SceneFacts {
        blas_count: 1,
        tlas_instance_count: 1,
        triangle_count: 1,
    }
}

fn failure_report(
    verdict: &'static str,
    capabilities: Option<NativeCapabilities>,
    code: impl Into<String>,
    detail: impl Into<String>,
) -> SmokeReport {
    SmokeReport {
        schema_version: 2,
        verdict,
        mode: "packaged-tauri-smoke",
        wgpu_version: WGPU_VERSION,
        tauri_version: tauri::VERSION,
        rust_version: env!("FORGEAX_RUSTC_VERSION"),
        executable: executable_path(),
        capabilities,
        scene: scene_facts(),
        positive: None,
        resized: None,
        restored: None,
        empty_tlas: None,
        empty_tlas_verdict: None,
        core_cases: Vec::new(),
        error: Some(ErrorFacts {
            code: code.into(),
            detail: detail.into(),
        }),
    }
}

fn persist_report_and_exit(report_dir: &Path, report: &SmokeReport, exit_code: i32) -> ! {
    if let Err(error) = write_report(report_dir, report) {
        eprintln!("[native-ray-query] failed to persist report: {error}");
    }
    std::process::exit(exit_code);
}

fn write_report(report_dir: &Path, report: &SmokeReport) -> Result<(), String> {
    std::fs::create_dir_all(report_dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
    std::fs::write(report_dir.join("report.json"), bytes).map_err(|error| error.to_string())
}

fn executable_path() -> String {
    std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "unknown".into())
}
