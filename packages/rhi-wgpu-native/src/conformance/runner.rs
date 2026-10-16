use super::gpu::{
    backend_name, BuildSchedule, CoreRunEvidence, GpuHarness, GpuObservation, TriangleVariant,
};
use super::model::{
    ApiConformanceVerdict, CaseResult, CaseStatus, ConformanceReport, FirstFailure,
    PerformanceVerdict, RouteVerdict, StatusCounts,
};
use crate::conformance_registry::{
    validate_registry, CaseDefinition, CaseProfile, RequiredFeature, CASE_REGISTRY,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

type CandidateExpectation = (usize, u32, u32);
type ValidationExecution = fn(&GpuHarness) -> Result<String, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RequestedProfile {
    Contract,
    Core,
    Extended,
    Stability,
    Performance,
    Upstream,
}

impl RequestedProfile {
    pub fn parse(value: &str) -> Result<BTreeSet<Self>, String> {
        let mut profiles = BTreeSet::new();
        for item in value.split(',') {
            match item.trim() {
                "contract" => {
                    profiles.insert(Self::Contract);
                }
                "core" => {
                    profiles.insert(Self::Contract);
                    profiles.insert(Self::Core);
                }
                "extended" => {
                    profiles.insert(Self::Extended);
                }
                "stability" => {
                    profiles.insert(Self::Contract);
                    profiles.insert(Self::Core);
                    profiles.insert(Self::Stability);
                }
                "performance" => {
                    profiles.insert(Self::Performance);
                }
                "upstream" => {
                    profiles.insert(Self::Upstream);
                }
                "full" => profiles.extend([
                    Self::Contract,
                    Self::Core,
                    Self::Extended,
                    Self::Stability,
                    Self::Performance,
                    Self::Upstream,
                ]),
                other => return Err(format!("unknown profile '{other}'")),
            }
        }
        if profiles.is_empty() {
            return Err("at least one profile is required".to_string());
        }
        Ok(profiles)
    }

    const fn registry_profile(self) -> CaseProfile {
        match self {
            Self::Contract => CaseProfile::Contract,
            Self::Core => CaseProfile::Core,
            Self::Extended => CaseProfile::Extended,
            Self::Stability => CaseProfile::Stability,
            Self::Performance => CaseProfile::Performance,
            Self::Upstream => CaseProfile::Upstream,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Contract => "contract",
            Self::Core => "core",
            Self::Extended => "extended",
            Self::Stability => "stability",
            Self::Performance => "performance",
            Self::Upstream => "upstream",
        }
    }
}

pub struct ConformanceConfig {
    pub output_root: PathBuf,
    pub profiles: BTreeSet<RequestedProfile>,
    pub sync_iterations: u32,
    pub soak_frames: u32,
    pub packaged_executable_identity: Option<String>,
    pub tauri_report: Option<PathBuf>,
    pub upstream_report: Option<PathBuf>,
}

pub fn run(config: ConformanceConfig) -> Result<PathBuf, String> {
    validate_registry()?;
    let run_started = Instant::now();
    let started_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is before the Unix epoch: {error}"))?
        .as_millis();
    let run_id = format!("{}-{}", started_at_unix_ms, std::process::id());
    let output_dir = config.output_root.join(&run_id);
    fs::create_dir_all(output_dir.join("frames"))
        .map_err(|error| format!("failed to create report directory: {error}"))?;
    fs::create_dir_all(output_dir.join("benchmarks"))
        .map_err(|error| format!("failed to create benchmark directory: {error}"))?;

    let mut log = BufWriter::new(
        File::create(output_dir.join("runner.log"))
            .map_err(|error| format!("failed to create runner log: {error}"))?,
    );
    writeln!(log, "backend-policy={}", backend_name()).map_err(io_error)?;
    writeln!(log, "sync-iterations={}", config.sync_iterations).map_err(io_error)?;
    writeln!(log, "soak-frames={}", config.soak_frames).map_err(io_error)?;
    if let Some(path) = &config.tauri_report {
        writeln!(log, "tauri-report={}", path.display()).map_err(io_error)?;
    }
    if let Some(path) = &config.upstream_report {
        writeln!(log, "upstream-report={}", path.display()).map_err(io_error)?;
    }

    let mut harness = Some(
        pollster::block_on(GpuHarness::create())
            .map_err(|error| format!("failed to initialize conformance GPU: {error}"))?,
    );
    let environment = harness
        .as_ref()
        .expect("harness was initialized")
        .environment
        .clone();
    let selected_profiles: BTreeSet<_> = config
        .profiles
        .iter()
        .map(|profile| profile.registry_profile())
        .collect();
    let mut results: BTreeMap<&'static str, CaseResult> = CASE_REGISTRY
        .iter()
        .map(|definition| {
            let result = if !selected_profiles.contains(&definition.profile) {
                result(
                    definition,
                    CaseStatus::NotRun,
                    0,
                    "profile was not requested",
                )
            } else if let Some(feature) = missing_feature(definition, &environment.features) {
                let mut result = result(
                    definition,
                    CaseStatus::Unsupported,
                    0,
                    &format!("adapter does not expose {}", feature.wgpu_name()),
                );
                result.observations.insert(
                    "missingFeature".to_string(),
                    Value::String(feature.wgpu_name().to_string()),
                );
                result
            } else {
                result(
                    definition,
                    CaseStatus::NotRun,
                    0,
                    "selected but no executor produced a terminal observation",
                )
            };
            (definition.id, result)
        })
        .collect();

    if selected_profiles.contains(&CaseProfile::Contract) {
        pass_with(
            &mut results,
            "CAP-01",
            "strict target backend selected without fallback",
            json!({
                "backend": environment.capabilities.backend,
                "adapter": environment.capabilities.adapter.name,
                "deviceType": environment.capabilities.adapter.device_type,
            }),
        );
        pass_with(
            &mut results,
            "CAP-02",
            "features and acceleration-structure limits captured",
            json!({
                "featureCount": environment.features.names.len(),
                "limits": environment.limits,
            }),
        );
        let started = Instant::now();
        match pollster::block_on(
            harness
                .as_ref()
                .expect("harness is present")
                .validate_feature_disabled_boundary(),
        ) {
            Ok(detail) => terminal(
                &mut results,
                "CAP-03",
                CaseStatus::Pass,
                started.elapsed().as_millis() as u64,
                &detail,
                None,
            ),
            Err(detail) => terminal(
                &mut results,
                "CAP-03",
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("validation-boundary"),
            ),
        }
    }

    let core_requested = selected_profiles.contains(&CaseProfile::Core);
    let stability_requested = selected_profiles.contains(&CaseProfile::Stability);
    if core_requested || stability_requested {
        let mut schedule_evidence = Vec::new();
        let iterations = if stability_requested {
            config.sync_iterations.max(1)
        } else {
            1
        };
        for schedule in [
            BuildSchedule::OneEncoder,
            BuildSchedule::OrderedCommandBuffers,
            BuildSchedule::SeparateSubmitAndPoll,
        ] {
            let evidence = harness
                .as_ref()
                .expect("harness is present")
                .run_core_schedule(schedule, iterations);
            match evidence {
                Ok(evidence) => {
                    writeln!(
                        log,
                        "schedule={} iterations={} hash={}",
                        evidence.schedule.name(),
                        evidence.iterations,
                        evidence.observation_hash
                    )
                    .map_err(io_error)?;
                    schedule_evidence.push(evidence);
                }
                Err(detail) => {
                    let id = match schedule {
                        BuildSchedule::OneEncoder => "BUILD-01",
                        BuildSchedule::OrderedCommandBuffers => "BUILD-02",
                        BuildSchedule::SeparateSubmitAndPoll => "BUILD-03",
                    };
                    terminal(
                        &mut results,
                        id,
                        CaseStatus::Fail,
                        0,
                        &detail,
                        Some("gpu-oracle"),
                    );
                }
            }
        }
        if schedule_evidence.len() == 3 {
            record_core_evidence(&mut results, &schedule_evidence);
            if stability_requested {
                let started = Instant::now();
                let replacement_iterations = config.sync_iterations.clamp(1, 100);
                let replacement_result = (0..replacement_iterations).try_for_each(|_| {
                    harness
                        .as_ref()
                        .expect("harness is present")
                        .run_tlas_replacement()
                        .map(|_| ())
                });
                match replacement_result {
                    Ok(()) => pass_with(
                        &mut results,
                        "STAB-02",
                        "every BLAS replacement referenced only the current BLAS",
                        json!({
                            "iterations": replacement_iterations,
                            "durationMs": started.elapsed().as_millis(),
                        }),
                    ),
                    Err(detail) => terminal(
                        &mut results,
                        "STAB-02",
                        CaseStatus::Fail,
                        started.elapsed().as_millis() as u64,
                        &detail,
                        Some("lifecycle"),
                    ),
                }
            }
        }
        if core_requested {
            record_validation_cases(&mut results, harness.as_ref().expect("harness is present"));
            record_triangle_variants(&mut results, harness.as_ref().expect("harness is present"));
            record_candidate_semantics(&mut results, harness.as_ref().expect("harness is present"));
            record_rebuild_semantics(&mut results, harness.as_ref().expect("harness is present"));
        }
    }

    if selected_profiles.contains(&CaseProfile::Extended) {
        record_extended_semantics(&mut results, harness.as_ref().expect("harness is present"));
    }

    if selected_profiles.contains(&CaseProfile::Performance) {
        for (id, side, rays, compact) in [
            ("PERF-01", 8, 4096, false),
            ("PERF-02", 64, 65536, false),
            ("PERF-03", 256, 262144, false),
            ("PERF-04", 64, 65536, true),
        ] {
            if results[id].status == CaseStatus::Unsupported {
                continue;
            }
            if !environment
                .features
                .names
                .iter()
                .any(|feature| feature == "TIMESTAMP_QUERY_INSIDE_ENCODERS")
            {
                terminal(
                    &mut results,
                    id,
                    CaseStatus::Unsupported,
                    0,
                    "build timing requires TIMESTAMP_QUERY_INSIDE_ENCODERS",
                    None,
                );
                continue;
            }
            let started = Instant::now();
            match harness
                .as_ref()
                .expect("harness is present")
                .run_performance(side, rays, compact, &output_dir.join("benchmarks").join(id))
            {
                Ok(evidence) => {
                    fs::write(
                        output_dir.join("benchmarks").join(format!("{id}.json")),
                        serde_json::to_vec_pretty(&evidence).map_err(|error| error.to_string())?,
                    )
                    .map_err(io_error)?;
                    pass_with(
                        &mut results,
                        id,
                        "same-input GPU timings and every-ray oracle retained",
                        evidence,
                    );
                }
                Err(detail) => terminal(
                    &mut results,
                    id,
                    CaseStatus::Fail,
                    started.elapsed().as_millis() as u64,
                    &detail,
                    Some("performance-observation"),
                ),
            }
        }
    }

    if stability_requested {
        record_create_drop_stability(&mut results, config.sync_iterations.clamp(1, 100));
    }

    if selected_profiles.contains(&CaseProfile::Upstream) {
        if let Some(path) = &config.upstream_report {
            if let Err(detail) =
                import_upstream_report(path, &environment.wgpu_source_commit, &mut results)
            {
                for id in ["UPSTREAM-01", "UPSTREAM-02", "UPSTREAM-03"] {
                    terminal(
                        &mut results,
                        id,
                        CaseStatus::Fail,
                        0,
                        &detail,
                        Some("upstream-report"),
                    );
                }
            }
        }
    }

    let mut packaged_executable_identity = config.packaged_executable_identity.clone();
    if stability_requested {
        if let Some(path) = &config.tauri_report {
            match import_tauri_report(path, &environment.capabilities.backend, &mut results) {
                Ok(identity) => packaged_executable_identity = Some(identity),
                Err(detail) => {
                    for id in ["STAB-03", "STAB-04"] {
                        terminal(
                            &mut results,
                            id,
                            CaseStatus::Fail,
                            0,
                            &detail,
                            Some("packaged-tauri-report"),
                        );
                    }
                }
            }
        }
    }

    if stability_requested && config.soak_frames > 0 {
        let started = Instant::now();
        match harness
            .take()
            .expect("harness is present")
            .run_core_schedule(BuildSchedule::SeparateSubmitAndPoll, config.soak_frames)
        {
            Ok(evidence) => {
                let case = results.get_mut("SOAK-01").expect("registered SOAK-01");
                case.status = CaseStatus::Pass;
                case.duration_ms = started.elapsed().as_millis() as u64;
                case.detail = format!(
                    "{} frames completed with stable hash {}",
                    evidence.iterations, evidence.observation_hash
                );
                case.observations
                    .insert("frames".to_string(), json!(evidence.iterations));
                case.observations
                    .insert("hash".to_string(), json!(evidence.observation_hash));
            }
            Err(detail) => terminal(
                &mut results,
                "SOAK-01",
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("soak"),
            ),
        }
    }

    let ordered_results: Vec<_> = CASE_REGISTRY
        .iter()
        .map(|definition| {
            results
                .remove(definition.id)
                .expect("every registry case has one result")
        })
        .collect();
    let completeness_valid = ordered_results.len() == CASE_REGISTRY.len()
        && ordered_results
            .iter()
            .map(|case| case.id.as_str())
            .collect::<BTreeSet<_>>()
            .len()
            == CASE_REGISTRY.len();
    let mut counts_by_profile = BTreeMap::new();
    for result in &ordered_results {
        counts_by_profile
            .entry(result.profile)
            .or_insert_with(StatusCounts::default)
            .add(result.status);
    }
    let first_failure = ordered_results
        .iter()
        .find(|result| result.status == CaseStatus::Fail)
        .map(|result| FirstFailure {
            case_id: result.id.clone(),
            detail: result.detail.clone(),
        });
    let selected_failure = ordered_results
        .iter()
        .find(|case| {
            case.status == CaseStatus::Fail
                || (selected_profiles.contains(&case.profile) && case.status == CaseStatus::NotRun)
        })
        .map(|case| format!("{}: {}", case.id, case.detail));
    let report = ConformanceReport {
        schema_version: 1,
        run_id,
        started_at_unix_ms,
        duration_ms: run_started.elapsed().as_millis() as u64,
        requested_profiles: config
            .profiles
            .iter()
            .map(|profile| profile.name().to_string())
            .collect(),
        environment,
        route_verdict: route_verdict(&ordered_results, packaged_executable_identity.as_deref()),
        api_conformance_verdict: api_verdict(&ordered_results),
        performance_verdict: performance_verdict(&ordered_results),
        completeness_valid,
        counts_by_profile,
        first_failure,
        packaged_executable_identity,
        case_count: ordered_results.len(),
    };
    write_jsonl(output_dir.join("cases.jsonl"), &ordered_results)?;
    fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)
            .map_err(|error| format!("failed to serialize report: {error}"))?,
    )
    .map_err(|error| format!("failed to write report: {error}"))?;
    log.flush().map_err(io_error)?;
    if let Some(detail) = selected_failure {
        return Err(format!(
            "report saved to {}; qualification failed: {detail}",
            output_dir.display()
        ));
    }
    Ok(output_dir)
}

fn record_core_evidence(
    results: &mut BTreeMap<&'static str, CaseResult>,
    evidence: &[CoreRunEvidence],
) {
    let observations = &evidence[0].first_observations;
    let shared = json!({
        "schedules": schedule_json(evidence),
        "ray0": observation_json(&observations[0]),
        "ray1": observation_json(&observations[1]),
        "missKinds": [observations[2].kind, observations[3].kind],
    });
    for id in [
        "CREATE-01",
        "TLAS-01",
        "TLAS-02",
        "TLAS-03",
        "TLAS-04",
        "TLAS-06",
        "RQ-01",
        "RQ-06",
    ] {
        pass_with(
            results,
            id,
            "structured GPU observations match the CPU reference scene",
            shared.clone(),
        );
    }
    for (id, schedule) in [
        ("BUILD-01", &evidence[0]),
        ("BUILD-02", &evidence[1]),
        ("BUILD-03", &evidence[2]),
    ] {
        pass_with(
            results,
            id,
            "build/query schedule matches the reference hash",
            json!({
                "schedule": schedule.schedule.name(),
                "iterations": schedule.iterations,
                "hash": schedule.observation_hash,
                "durationMs": schedule.duration.as_millis(),
            }),
        );
    }
}

fn record_extended_semantics(
    results: &mut BTreeMap<&'static str, CaseResult>,
    harness: &GpuHarness,
) {
    if results["RQ-08"].status != CaseStatus::Unsupported {
        let started = Instant::now();
        match harness
            .run_hit_vertex_return(false)
            .and_then(|non_indexed| {
                harness
                    .run_hit_vertex_return(true)
                    .map(|indexed| (non_indexed, indexed))
            }) {
            Ok((non_indexed, indexed)) => {
                pass_with(results, "RQ-08", "candidate and committed vertices preserve source/index order and object space; miss is zero", json!({"nonIndexed": non_indexed, "indexed": indexed}));
                results.get_mut("RQ-08").unwrap().duration_ms =
                    started.elapsed().as_millis() as u64;
            }
            Err(detail) => terminal(
                results,
                "RQ-08",
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("gpu-oracle"),
            ),
        }
    }
    if results["TRI-07"].status != CaseStatus::Unsupported {
        let started = Instant::now();
        match harness.run_triangle_variant(TriangleVariant::Float16x4) {
            Ok(observation) => {
                pass_with(
                    results,
                    "TRI-07",
                    "Float16x4 hit matches the Float32x3 triangle oracle",
                    observation_json(&observation),
                );
                results.get_mut("TRI-07").unwrap().duration_ms =
                    started.elapsed().as_millis() as u64;
            }
            Err(detail) => terminal(
                results,
                "TRI-07",
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("gpu-oracle"),
            ),
        }
    }
    if results["RQ-09"].status != CaseStatus::Unsupported {
        let started = Instant::now();
        match harness.run_tlas_binding_array() {
            Ok(observations) => {
                pass_with(
                    results,
                    "RQ-09",
                    "both TLAS array elements preserve their own identity and hit distance",
                    json!({"elements": observations
                          .iter()
                          .map(observation_json)
                          .collect::<Vec<_>>()}),
                );
                results.get_mut("RQ-09").unwrap().duration_ms =
                    started.elapsed().as_millis() as u64;
            }
            Err(detail) => terminal(
                results,
                "RQ-09",
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("gpu-oracle"),
            ),
        }
    }
    let started = Instant::now();
    match harness.run_aabb_candidate() {
        Ok(observation) => {
            let evidence = observation_json(&observation);
            let candidate_ok = observation.sbt_record_offset == 3;
            let generated_ok = observation.kind == 2
                && observation.primitive_index == 0
                && (observation.t - 1.0).abs() <= 1.0e-4;
            for (id, passed, detail) in [
                (
                    "AABB-01",
                    candidate_ok,
                    "AABB candidate kind was observed before generation",
                ),
                (
                    "AABB-02",
                    generated_ok,
                    "generated intersection kind and t matched the oracle",
                ),
            ] {
                let case = results.get_mut(id).expect("AABB case is registered");
                case.status = if passed {
                    CaseStatus::Pass
                } else {
                    CaseStatus::Fail
                };
                case.duration_ms = started.elapsed().as_millis() as u64;
                case.detail = if passed {
                    detail.to_string()
                } else {
                    format!("{detail}; actual={observation:?}")
                };
                case.observations
                    .insert("observation".to_string(), evidence.clone());
                if !passed {
                    case.error_class = Some("gpu-oracle".to_string());
                }
            }
        }
        Err(detail) => {
            for id in ["AABB-01", "AABB-02"] {
                terminal(
                    results,
                    id,
                    CaseStatus::Fail,
                    started.elapsed().as_millis() as u64,
                    &detail,
                    Some("gpu-oracle"),
                );
            }
        }
    }
    let started = Instant::now();
    match harness.run_multiple_aabb_stride() {
        Ok(observation) if observation.kind == 2 && observation.primitive_index == 1 => {
            let case = results.get_mut("AABB-03").expect("AABB-03 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "offset and padded stride selected the second AABB primitive".to_string();
            case.observations
                .insert("observation".to_string(), observation_json(&observation));
        }
        Ok(observation) => terminal(
            results,
            "AABB-03",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &format!("multiple AABB observation mismatch: {observation:?}"),
            Some("gpu-oracle"),
        ),
        Err(detail) => terminal(
            results,
            "AABB-03",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
    let started = Instant::now();
    match harness.validate_invalid_aabb() {
        Ok(detail) => terminal(
            results,
            "AABB-04",
            CaseStatus::Pass,
            started.elapsed().as_millis() as u64,
            &detail,
            None,
        ),
        Err(detail) => terminal(
            results,
            "AABB-04",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("validation-boundary"),
        ),
    }
    let started = Instant::now();
    match harness.run_skip_aabb_mixed_scene() {
        Ok(observation) => {
            let case = results.get_mut("AABB-05").expect("AABB-05 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "SKIP_AABBS excluded the procedural instance and preserved the triangle"
                .to_string();
            case.observations
                .insert("observation".to_string(), observation_json(&observation));
        }
        Err(detail) => terminal(
            results,
            "AABB-05",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
    let started = Instant::now();
    match harness.run_compaction() {
        Ok(observation) => {
            let case = results
                .get_mut("COMPACT-01")
                .expect("COMPACT-01 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "prepared compacted BLAS retained the reference intersection".to_string();
            case.observations
                .insert("observation".to_string(), observation_json(&observation));
        }
        Err(detail) => terminal(
            results,
            "COMPACT-01",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
    let started = Instant::now();
    match harness.validate_invalid_compaction() {
        Ok(detail) => terminal(
            results,
            "COMPACT-02",
            CaseStatus::Pass,
            started.elapsed().as_millis() as u64,
            &detail,
            None,
        ),
        Err(detail) => terminal(
            results,
            "COMPACT-02",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("validation-boundary"),
        ),
    }
    let started = Instant::now();
    match harness.run_invalid_ray_robustness() {
        Ok(detail) => terminal(
            results,
            "RQ-10",
            CaseStatus::Pass,
            started.elapsed().as_millis() as u64,
            &detail,
            None,
        ),
        Err(detail) => terminal(
            results,
            "RQ-10",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-robustness"),
        ),
    }
}

fn record_rebuild_semantics(
    results: &mut BTreeMap<&'static str, CaseResult>,
    harness: &GpuHarness,
) {
    let started = Instant::now();
    match harness.run_tlas_replacement() {
        Ok(observations) => {
            let case = results.get_mut("TLAS-05").expect("TLAS-05 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "set_blas replacement removed the old geometry and exposed the new BLAS"
                .to_string();
            case.observations.insert(
                "rays".to_string(),
                Value::Array(observations.iter().map(observation_json).collect()),
            );
        }
        Err(detail) => terminal(
            results,
            "TLAS-05",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
    let started = Instant::now();
    match harness.run_synchronized_blas_rebuild() {
        Ok(observations) => {
            let case = results.get_mut("BUILD-04").expect("BUILD-04 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail =
                "BLAS and TLAS synchronized rebuild exposed only the updated geometry".to_string();
            case.observations.insert(
                "rays".to_string(),
                Value::Array(observations.iter().map(observation_json).collect()),
            );
        }
        Err(detail) => terminal(
            results,
            "BUILD-04",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
    let started = Instant::now();
    match harness.validate_unsynchronized_blas_rebuild() {
        Ok(detail) => terminal(
            results,
            "BUILD-05",
            CaseStatus::Pass,
            started.elapsed().as_millis() as u64,
            &detail,
            None,
        ),
        Err(detail) => terminal(
            results,
            "BUILD-05",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("validation-boundary"),
        ),
    }
    let started = Instant::now();
    match harness.run_triangle_variant(TriangleVariant::PreferUpdate) {
        Ok(observation) => {
            let case = results.get_mut("BUILD-06").expect("BUILD-06 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "PreferUpdate produced the same triangle oracle as Build".to_string();
            case.observations
                .insert("observation".to_string(), observation_json(&observation));
        }
        Err(detail) => terminal(
            results,
            "BUILD-06",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
    let started = Instant::now();
    match harness.run_fragment_query() {
        Ok(words) if words == [1, 0x00_a1_b2, 0, 2.0_f32.to_bits()] => {
            let case = results.get_mut("RQ-07").expect("RQ-07 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail =
                "fragment and compute stages returned the same committed hit facts".to_string();
            case.observations
                .insert("fragmentWords".to_string(), json!(words));
        }
        Ok(words) => terminal(
            results,
            "RQ-07",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &format!(
                "fragment words {words:?} did not match [1, {}, 0, {}]",
                0x00_a1_b2,
                2.0_f32.to_bits()
            ),
            Some("gpu-oracle"),
        ),
        Err(detail) => terminal(
            results,
            "RQ-07",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &detail,
            Some("gpu-oracle"),
        ),
    }
}

fn record_candidate_semantics(
    results: &mut BTreeMap<&'static str, CaseResult>,
    harness: &GpuHarness,
) {
    let started = Instant::now();
    match harness.run_candidate_semantics() {
        Ok(observations) => {
            let evidence = Value::Array(
                observations
                    .iter()
                    .enumerate()
                    .map(|(index, observation)| {
                        json!({
                            "ray": index,
                            "candidateCount": observation.sbt_record_offset,
                            "observation": observation_json(observation),
                        })
                    })
                    .collect(),
            );
            let cases: [(&str, &[CandidateExpectation]); 5] = [
                ("TRI-06", &[(0, 1, 1), (6, 1, 0), (7, 1, 1)]),
                ("RQ-02", &[(0, 1, 1), (1, 0, 1)]),
                ("RQ-03", &[(2, 1, 1)]),
                ("RQ-04", &[(3, 0, 0), (4, 1, 1), (6, 1, 0), (7, 1, 1)]),
                ("RQ-05", &[(5, 0, 0), (8, 1, 1)]),
            ];
            for (id, expectations) in cases {
                let case = results.get_mut(id).expect("candidate case is registered");
                case.duration_ms = started.elapsed().as_millis() as u64;
                let mismatch = expectations.iter().find_map(|(index, kind, candidates)| {
                    let actual = &observations[*index];
                    (actual.kind != *kind || actual.sbt_record_offset != *candidates).then(|| {
                        format!(
                            "ray {index} expected kind={kind} candidates={candidates}, got {actual:?}"
                        )
                    })
                });
                if let Some(detail) = mismatch {
                    case.status = CaseStatus::Fail;
                    case.detail = detail;
                    case.error_class = Some("gpu-oracle".to_string());
                } else {
                    case.status = CaseStatus::Pass;
                    case.detail = "candidate and ray-flag semantics matched".to_string();
                }
                case.observations
                    .insert("rays".to_string(), evidence.clone());
            }
        }
        Err(detail) => {
            for id in ["TRI-06", "RQ-02", "RQ-03", "RQ-04", "RQ-05"] {
                terminal(
                    results,
                    id,
                    CaseStatus::Fail,
                    started.elapsed().as_millis() as u64,
                    &detail,
                    Some("gpu-oracle"),
                );
            }
        }
    }
}

fn record_validation_cases(results: &mut BTreeMap<&'static str, CaseResult>, harness: &GpuHarness) {
    let executions: [(&str, ValidationExecution); 2] = [
        ("CREATE-02", GpuHarness::validate_descriptor_mismatch),
        ("CREATE-03", GpuHarness::validate_limit_overflow),
    ];
    for (id, execution) in executions {
        let started = Instant::now();
        match execution(harness) {
            Ok(detail) => terminal(
                results,
                id,
                CaseStatus::Pass,
                started.elapsed().as_millis() as u64,
                &detail,
                None,
            ),
            Err(detail) => terminal(
                results,
                id,
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("validation-boundary"),
            ),
        }
    }
}

fn record_triangle_variants(
    results: &mut BTreeMap<&'static str, CaseResult>,
    harness: &GpuHarness,
) {
    let cases = [
        ("TRI-01", vec![TriangleVariant::NonIndexed]),
        (
            "TRI-02",
            vec![
                TriangleVariant::Uint16Indexed,
                TriangleVariant::Uint32Indexed,
            ],
        ),
        ("TRI-03", vec![TriangleVariant::Prefixed]),
        ("TRI-05", vec![TriangleVariant::BlasTransform]),
    ];
    for (id, variants) in cases {
        let started = Instant::now();
        let mut evidence = Vec::new();
        let mut failure = None;
        for variant in variants {
            match harness.run_triangle_variant(variant) {
                Ok(observation) => evidence.push((variant, observation)),
                Err(detail) => {
                    failure = Some(detail);
                    break;
                }
            }
        }
        if let Some(detail) = failure {
            terminal(
                results,
                id,
                CaseStatus::Fail,
                started.elapsed().as_millis() as u64,
                &detail,
                Some("gpu-oracle"),
            );
        } else {
            let case = results.get_mut(id).expect("triangle case is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "triangle variant matched the structured CPU/GPU oracle".to_string();
            case.observations.insert(
                "variants".to_string(),
                Value::Array(
                    evidence
                        .iter()
                        .map(|(variant, observation)| {
                            json!({
                                "variant": variant.name(),
                                "observation": observation_json(observation),
                            })
                        })
                        .collect(),
                ),
            );
        }
    }
    let started = Instant::now();
    match (
        harness.run_triangle_variant(TriangleVariant::PaddedStride),
        harness.run_multi_geometry(),
    ) {
        (Ok(padded), Ok(multi)) => {
            let case = results.get_mut("TRI-04").expect("TRI-04 is registered");
            case.status = CaseStatus::Pass;
            case.duration_ms = started.elapsed().as_millis() as u64;
            case.detail = "padded stride and multi-geometry observations matched".to_string();
            case.observations
                .insert("paddedStride".to_string(), observation_json(&padded));
            case.observations
                .insert("multiGeometry".to_string(), observation_json(&multi));
        }
        (padded, multi) => terminal(
            results,
            "TRI-04",
            CaseStatus::Fail,
            started.elapsed().as_millis() as u64,
            &format!("padded-stride={padded:?}; multi-geometry={multi:?}"),
            Some("gpu-oracle"),
        ),
    }
}

fn schedule_json(evidence: &[CoreRunEvidence]) -> Value {
    Value::Array(
        evidence
            .iter()
            .map(|item| {
                json!({
                    "schedule": item.schedule.name(),
                    "iterations": item.iterations,
                    "hash": item.observation_hash,
                    "durationMs": item.duration.as_millis(),
                })
            })
            .collect(),
    )
}

fn observation_json(observation: &GpuObservation) -> Value {
    json!({
        "kind": observation.kind,
        "t": observation.t,
        "instanceCustomData": observation.instance_custom_data,
        "instanceIndex": observation.instance_index,
        "geometryIndex": observation.geometry_index,
        "primitiveIndex": observation.primitive_index,
        "barycentrics": observation.barycentrics,
        "frontFace": observation.front_face,
    })
}

fn missing_feature(
    definition: &CaseDefinition,
    features: &super::model::FeatureSnapshot,
) -> Option<RequiredFeature> {
    definition
        .required_features
        .iter()
        .copied()
        .find(|feature| match feature {
            RequiredFeature::ExperimentalRayQuery => !features.experimental_ray_query,
            RequiredFeature::ExperimentalRayHitVertexReturn => {
                !features.experimental_ray_hit_vertex_return
            }
            RequiredFeature::ExtendedAccelerationStructureVertexFormats => {
                !features.extended_acceleration_structure_vertex_formats
            }
            RequiredFeature::AccelerationStructureBindingArray => {
                !features.acceleration_structure_binding_array
            }
            RequiredFeature::TimestampQuery => !features.timestamp_query,
        })
}

fn pass_with(
    results: &mut BTreeMap<&'static str, CaseResult>,
    id: &'static str,
    detail: &str,
    observations: Value,
) {
    let case = results.get_mut(id).expect("case id is registered");
    case.status = CaseStatus::Pass;
    case.detail = detail.to_string();
    if let Value::Object(values) = observations {
        case.observations.extend(values);
    } else {
        case.status = CaseStatus::Fail;
        case.detail = "case observations must be a JSON object".to_string();
        case.error_class = Some("invalid-observations".to_string());
    }
}

fn terminal(
    results: &mut BTreeMap<&'static str, CaseResult>,
    id: &'static str,
    status: CaseStatus,
    duration_ms: u64,
    detail: &str,
    error_class: Option<&str>,
) {
    let case = results.get_mut(id).expect("case id is registered");
    case.status = status;
    case.duration_ms = duration_ms;
    case.detail = detail.to_string();
    case.error_class = error_class.map(str::to_string);
}

fn result(
    definition: &CaseDefinition,
    status: CaseStatus,
    duration_ms: u64,
    detail: &str,
) -> CaseResult {
    CaseResult {
        id: definition.id.to_string(),
        name: definition.name.to_string(),
        profile: definition.profile,
        stage: definition.stage,
        status,
        duration_ms,
        detail: detail.to_string(),
        observations: BTreeMap::new(),
        error_class: None,
        known_issue_url: definition.known_issue.map(|issue| issue.url.to_string()),
    }
}

fn route_verdict(
    results: &[CaseResult],
    packaged_executable_identity: Option<&str>,
) -> RouteVerdict {
    const PRODUCT_ROUTE_CASES: [&str; 6] = [
        "CREATE-01",
        "TLAS-06",
        "RQ-01",
        "BUILD-01",
        "STAB-03",
        "STAB-04",
    ];
    let route_cases: Vec<_> = results
        .iter()
        .filter(|result| PRODUCT_ROUTE_CASES.contains(&result.id.as_str()))
        .collect();
    if route_cases
        .iter()
        .any(|result| result.status == CaseStatus::Fail)
    {
        RouteVerdict::Failed
    } else if packaged_executable_identity.is_none()
        || route_cases
            .iter()
            .any(|result| result.status != CaseStatus::Pass)
    {
        RouteVerdict::Incomplete
    } else {
        RouteVerdict::Ok
    }
}

fn record_create_drop_stability(results: &mut BTreeMap<&'static str, CaseResult>, iterations: u32) {
    let started = Instant::now();
    for iteration in 0..iterations {
        match pollster::block_on(GpuHarness::create()) {
            Ok(harness) => drop(harness),
            Err(error) => {
                terminal(
                    results,
                    "STAB-01",
                    CaseStatus::Fail,
                    started.elapsed().as_millis() as u64,
                    &format!("create/drop iteration {iteration} failed: {error}"),
                    Some("lifecycle"),
                );
                return;
            }
        }
    }
    pass_with(
        results,
        "STAB-01",
        "every native Ray Query device completed create and drop",
        json!({
            "iterations": iterations,
            "durationMs": started.elapsed().as_millis(),
        }),
    );
}

fn import_tauri_report(
    path: &PathBuf,
    expected_backend: &str,
    results: &mut BTreeMap<&'static str, CaseResult>,
) -> Result<String, String> {
    let report: Value = serde_json::from_slice(
        &fs::read(path)
            .map_err(|error| format!("failed to read Tauri report {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("failed to parse Tauri report {}: {error}", path.display()))?;
    let required = [
        ("schemaVersion", json!(2)),
        ("verdict", json!("ok")),
        ("wgpuVersion", json!("30.0.1")),
    ];
    for (field, expected) in required {
        if report.get(field) != Some(&expected) {
            return Err(format!("Tauri report {field} did not equal {expected}"));
        }
    }
    if report
        .pointer("/capabilities/backend")
        .and_then(Value::as_str)
        != Some(expected_backend)
        || report
            .pointer("/capabilities/rayQuery")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(format!(
            "Tauri report did not prove {expected_backend} EXPERIMENTAL_RAY_QUERY"
        ));
    }
    let cases = report
        .get("coreCases")
        .and_then(Value::as_array)
        .ok_or_else(|| "Tauri report has no coreCases array".to_string())?;
    for id in ["STAB-03", "STAB-04"] {
        let passed = cases.iter().any(|case| {
            case.get("id").and_then(Value::as_str) == Some(id)
                && case.get("status").and_then(Value::as_str) == Some("pass")
        });
        if !passed {
            return Err(format!("Tauri report did not pass {id}"));
        }
        pass_with(
            results,
            id,
            "packaged Tauri lifecycle report passed",
            json!({ "report": path, "backend": expected_backend }),
        );
    }
    report
        .get("executable")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Tauri report has no packaged executable identity".to_string())
}

fn import_upstream_report(
    path: &PathBuf,
    expected_source_commit: &str,
    results: &mut BTreeMap<&'static str, CaseResult>,
) -> Result<(), String> {
    let report: Value =
        serde_json::from_slice(&fs::read(path).map_err(|error| {
            format!("failed to read upstream report {}: {error}", path.display())
        })?)
        .map_err(|error| {
            format!(
                "failed to parse upstream report {}: {error}",
                path.display()
            )
        })?;
    for (field, expected) in [
        ("schemaVersion", json!(1)),
        ("wgpuSourceCommit", json!(expected_source_commit)),
        ("wgpuVersion", json!("30.0.1")),
        ("wgpuTag", json!("v30.0.1")),
        (
            "wgpuTagCommit",
            json!("40f4a34ebaf56f9a046231f54125ad046239d3f3"),
        ),
    ] {
        if report.get(field) != Some(&expected) {
            return Err(format!("upstream report {field} did not equal {expected}"));
        }
    }
    let suites = report
        .get("suites")
        .and_then(Value::as_array)
        .ok_or_else(|| "upstream report has no suites array".to_string())?;
    for (id, name) in [
        ("UPSTREAM-01", "wgpu-gpu-ray-tracing"),
        ("UPSTREAM-02", "wgpu-ray-tracing-examples"),
        ("UPSTREAM-03", "naga-ray-query"),
    ] {
        let suite = suites
            .iter()
            .find(|suite| suite.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| format!("upstream report has no {name} suite"))?;
        let cases = suite
            .get("cases")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("upstream suite {name} has no cases"))?;
        let passed = suite.get("passed").and_then(Value::as_bool) == Some(true)
            && !cases.is_empty()
            && cases.iter().all(|case| {
                matches!(
                    case.get("status").and_then(Value::as_str),
                    Some("pass" | "unsupported")
                )
            });
        let status = if passed {
            CaseStatus::Pass
        } else {
            CaseStatus::Fail
        };
        terminal(
            results,
            id,
            status,
            0,
            if passed {
                "pinned wgpu v30 upstream suite retained every named terminal result"
            } else {
                "pinned wgpu v30 upstream suite failed or was incomplete"
            },
            (!passed).then_some("upstream-suite"),
        );
        results
            .get_mut(id)
            .expect("upstream case is registered")
            .observations
            .insert("cases".to_string(), Value::Array(cases.clone()));
    }
    Ok(())
}

fn api_verdict(results: &[CaseResult]) -> ApiConformanceVerdict {
    let api_cases = results.iter().filter(|result| {
        !matches!(
            result.profile,
            CaseProfile::Performance | CaseProfile::Stability
        )
    });
    let statuses: Vec<_> = api_cases.map(|result| result.status).collect();
    if statuses.contains(&CaseStatus::Fail) {
        ApiConformanceVerdict::Failed
    } else if statuses.contains(&CaseStatus::NotRun) {
        ApiConformanceVerdict::Incomplete
    } else {
        ApiConformanceVerdict::Ok
    }
}

fn performance_verdict(results: &[CaseResult]) -> PerformanceVerdict {
    let statuses: Vec<_> = results
        .iter()
        .filter(|result| result.profile == CaseProfile::Performance)
        .map(|result| result.status)
        .collect();
    if statuses.contains(&CaseStatus::Fail) {
        PerformanceVerdict::Failed
    } else if statuses.iter().all(|status| *status == CaseStatus::Pass) {
        PerformanceVerdict::Measured
    } else if statuses
        .iter()
        .all(|status| *status == CaseStatus::Unsupported)
    {
        PerformanceVerdict::Unsupported
    } else {
        PerformanceVerdict::NotRun
    }
}

fn write_jsonl(path: PathBuf, results: &[CaseResult]) -> Result<(), String> {
    let mut writer = BufWriter::new(
        File::create(path).map_err(|error| format!("failed to create cases.jsonl: {error}"))?,
    );
    for result in results {
        serde_json::to_writer(&mut writer, result)
            .map_err(|error| format!("failed to serialize case {}: {error}", result.id))?;
        writer.write_all(b"\n").map_err(io_error)?;
    }
    writer.flush().map_err(io_error)
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_payloads_cannot_silently_discard_arrays() {
        let definition = CASE_REGISTRY
            .iter()
            .find(|case| case.id == "RQ-09")
            .unwrap();
        let mut results = BTreeMap::from([(
            "RQ-09",
            result(definition, CaseStatus::NotRun, 0, "not yet run"),
        )]);
        let elements = json!([
            {"instanceCustomData": 0xa1b2, "t": 2.0},
            {"instanceCustomData": 0xc3d4, "t": 1.5}
        ]);
        pass_with(&mut results, "RQ-09", "array readbacks", elements.clone());
        assert_eq!(results["RQ-09"].status, CaseStatus::Fail);
        assert_eq!(
            results["RQ-09"].error_class.as_deref(),
            Some("invalid-observations")
        );

        let mut results = BTreeMap::from([(
            "RQ-09",
            result(definition, CaseStatus::NotRun, 0, "not yet run"),
        )]);
        pass_with(
            &mut results,
            "RQ-09",
            "array readbacks",
            json!({"elements": elements}),
        );
        let encoded = serde_json::to_value(&results["RQ-09"]).unwrap();
        assert_eq!(encoded["status"], "pass");
        assert_eq!(
            encoded["observations"]["elements"][0]["instanceCustomData"],
            0xa1b2
        );
        assert_eq!(encoded["observations"]["elements"][1]["t"], 1.5);
    }

    #[test]
    fn core_alias_includes_contract() {
        let profiles = RequestedProfile::parse("core").unwrap();
        assert!(profiles.contains(&RequestedProfile::Contract));
        assert!(profiles.contains(&RequestedProfile::Core));
    }

    #[test]
    fn full_profile_selects_every_registry_profile() {
        let profiles = RequestedProfile::parse("full").unwrap();
        assert_eq!(profiles.len(), 6);
    }

    #[test]
    fn stability_profile_includes_the_product_route() {
        let profiles = RequestedProfile::parse("stability").unwrap();
        assert!(profiles.contains(&RequestedProfile::Contract));
        assert!(profiles.contains(&RequestedProfile::Core));
        assert!(profiles.contains(&RequestedProfile::Stability));
    }
}
