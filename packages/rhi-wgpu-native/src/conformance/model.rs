use crate::conformance_registry::{CaseProfile, CaseStage};
use crate::NativeCapabilities;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaseStatus {
    Pass,
    Fail,
    Unsupported,
    NotRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteVerdict {
    Ok,
    Failed,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiConformanceVerdict {
    Ok,
    Failed,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PerformanceVerdict {
    Measured,
    Unsupported,
    Failed,
    NotRun,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    pub id: String,
    pub name: String,
    pub profile: CaseProfile,
    pub stage: CaseStage,
    pub status: CaseStatus,
    pub duration_ms: u64,
    pub detail: String,
    pub observations: BTreeMap<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_issue_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureSnapshot {
    pub names: Vec<String>,
    pub experimental_ray_query: bool,
    pub experimental_ray_hit_vertex_return: bool,
    pub extended_acceleration_structure_vertex_formats: bool,
    pub acceleration_structure_binding_array: bool,
    pub experimental_ray_tracing_pipelines: bool,
    pub timestamp_query: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccelerationStructureLimits {
    pub max_blas_primitive_count: u32,
    pub max_blas_geometry_count: u32,
    pub max_tlas_instance_count: u32,
    pub max_acceleration_structures_per_shader_stage: u32,
    pub max_buffers_and_acceleration_structures_per_shader_stage: u32,
    pub max_binding_array_acceleration_structure_elements_per_shader_stage: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSnapshot {
    pub wgpu_version: String,
    pub wgpu_tag: String,
    pub wgpu_tag_commit: String,
    pub wgpu_source_commit: String,
    pub engine_commit: String,
    pub rustc: String,
    pub os: String,
    pub architecture: String,
    pub capabilities: NativeCapabilities,
    pub features: FeatureSnapshot,
    pub limits: AccelerationStructureLimits,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub pass: u32,
    pub fail: u32,
    pub unsupported: u32,
    pub not_run: u32,
}

impl StatusCounts {
    pub fn add(&mut self, status: CaseStatus) {
        match status {
            CaseStatus::Pass => self.pass += 1,
            CaseStatus::Fail => self.fail += 1,
            CaseStatus::Unsupported => self.unsupported += 1,
            CaseStatus::NotRun => self.not_run += 1,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstFailure {
    pub case_id: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceReport {
    pub schema_version: u32,
    pub run_id: String,
    pub started_at_unix_ms: u128,
    pub duration_ms: u64,
    pub requested_profiles: Vec<String>,
    pub environment: EnvironmentSnapshot,
    pub route_verdict: RouteVerdict,
    pub api_conformance_verdict: ApiConformanceVerdict,
    pub performance_verdict: PerformanceVerdict,
    pub completeness_valid: bool,
    pub counts_by_profile: BTreeMap<CaseProfile, StatusCounts>,
    pub first_failure: Option<FirstFailure>,
    pub packaged_executable_identity: Option<String>,
    pub case_count: usize,
}
