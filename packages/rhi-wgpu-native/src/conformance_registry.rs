use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaseProfile {
    Contract,
    Core,
    Extended,
    Stability,
    Performance,
    Upstream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaseStage {
    Capability,
    Create,
    Blas,
    Tlas,
    Build,
    RayQuery,
    Aabb,
    Lifecycle,
    Benchmark,
    Upstream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendPolicy {
    Native,
    Metal,
    Vulkan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RequiredFeature {
    ExperimentalRayQuery,
    ExperimentalRayHitVertexReturn,
    ExtendedAccelerationStructureVertexFormats,
    AccelerationStructureBindingArray,
    TimestampQuery,
}

impl RequiredFeature {
    pub const fn wgpu_name(self) -> &'static str {
        match self {
            Self::ExperimentalRayQuery => "EXPERIMENTAL_RAY_QUERY",
            Self::ExperimentalRayHitVertexReturn => "EXPERIMENTAL_RAY_HIT_VERTEX_RETURN",
            Self::ExtendedAccelerationStructureVertexFormats => {
                "EXTENDED_ACCELERATION_STRUCTURE_VERTEX_FORMATS"
            }
            Self::AccelerationStructureBindingArray => "ACCELERATION_STRUCTURE_BINDING_ARRAY",
            Self::TimestampQuery => "TIMESTAMP_QUERY",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownIssue {
    pub url: &'static str,
    pub affected_version: &'static str,
    pub removal_condition: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub profile: CaseProfile,
    pub stage: CaseStage,
    pub required_features: &'static [RequiredFeature],
    pub backend_policy: BackendPolicy,
    pub oracle: &'static str,
    pub timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_issue: Option<KnownIssue>,
}

const RAY_QUERY: &[RequiredFeature] = &[RequiredFeature::ExperimentalRayQuery];
const VERTEX_RETURN: &[RequiredFeature] = &[
    RequiredFeature::ExperimentalRayQuery,
    RequiredFeature::ExperimentalRayHitVertexReturn,
];
const EXTENDED_FORMATS: &[RequiredFeature] = &[
    RequiredFeature::ExperimentalRayQuery,
    RequiredFeature::ExtendedAccelerationStructureVertexFormats,
];
const BINDING_ARRAY: &[RequiredFeature] = &[
    RequiredFeature::ExperimentalRayQuery,
    RequiredFeature::AccelerationStructureBindingArray,
];
const TIMESTAMP_QUERY: &[RequiredFeature] = &[
    RequiredFeature::ExperimentalRayQuery,
    RequiredFeature::TimestampQuery,
];

const METAL_EXAMPLE_ISSUE: KnownIssue = KnownIssue {
    url: "https://github.com/gfx-rs/wgpu/issues/9100",
    affected_version: "30.0.1",
    removal_condition: "remove after the pinned wgpu version passes all Ray Tracing examples across supported Metal hardware",
};

const fn case(
    id: &'static str,
    name: &'static str,
    profile: CaseProfile,
    stage: CaseStage,
    required_features: &'static [RequiredFeature],
    oracle: &'static str,
) -> CaseDefinition {
    CaseDefinition {
        id,
        name,
        profile,
        stage,
        required_features,
        backend_policy: BackendPolicy::Native,
        oracle,
        timeout_ms: 30_000,
        known_issue: None,
    }
}

const fn aabb_case(id: &'static str, name: &'static str, oracle: &'static str) -> CaseDefinition {
    case(
        id,
        name,
        CaseProfile::Extended,
        CaseStage::Aabb,
        RAY_QUERY,
        oracle,
    )
}

pub static CASE_REGISTRY: &[CaseDefinition] = &[
    case(
        "CAP-01",
        "strict native backend selection",
        CaseProfile::Contract,
        CaseStage::Capability,
        &[],
        "selected backend equals the target policy and is not a fallback",
    ),
    case(
        "CAP-02",
        "Ray Query features and limits",
        CaseProfile::Contract,
        CaseStage::Capability,
        &[],
        "adapter features and acceleration-structure limits are recorded exactly",
    ),
    case(
        "CAP-03",
        "resource creation without Ray Query feature",
        CaseProfile::Contract,
        CaseStage::Capability,
        &[],
        "validation is captured and the device remains healthy",
    ),
    case(
        "CREATE-01",
        "legal BLAS and TLAS creation",
        CaseProfile::Core,
        CaseStage::Create,
        RAY_QUERY,
        "legal descriptors create and build successfully",
    ),
    case(
        "CREATE-02",
        "descriptor and geometry mismatch",
        CaseProfile::Core,
        CaseStage::Create,
        RAY_QUERY,
        "validation rejects a mismatched build and the device remains healthy",
    ),
    case(
        "CREATE-03",
        "acceleration-structure limit overflow",
        CaseProfile::Core,
        CaseStage::Create,
        RAY_QUERY,
        "creation above the reported limit is rejected",
    ),
    case(
        "TRI-01",
        "non-indexed triangle",
        CaseProfile::Core,
        CaseStage::Blas,
        RAY_QUERY,
        "CPU and GPU t, primitive, and barycentrics agree",
    ),
    case(
        "TRI-02",
        "Uint16 and Uint32 indexed triangles",
        CaseProfile::Core,
        CaseStage::Blas,
        RAY_QUERY,
        "both index formats produce the reference intersection",
    ),
    case(
        "TRI-03",
        "first vertex and first index",
        CaseProfile::Core,
        CaseStage::Blas,
        RAY_QUERY,
        "prefixed geometry is skipped without changing the hit",
    ),
    case(
        "TRI-04",
        "stride padding and multiple geometries",
        CaseProfile::Core,
        CaseStage::Blas,
        RAY_QUERY,
        "geometry and primitive indices identify the reference primitive",
    ),
    case(
        "TRI-05",
        "BLAS transform",
        CaseProfile::Core,
        CaseStage::Blas,
        RAY_QUERY,
        "GPU object/world transforms and t match the CPU oracle",
    ),
    case(
        "TRI-06",
        "opaque and non-opaque triangles",
        CaseProfile::Core,
        CaseStage::Blas,
        RAY_QUERY,
        "committed and candidate behavior matches the geometry flags",
    ),
    case(
        "TRI-07",
        "extended acceleration-structure vertex format",
        CaseProfile::Extended,
        CaseStage::Blas,
        EXTENDED_FORMATS,
        "extended-format output matches Float32x3",
    ),
    case(
        "TLAS-01",
        "multiple BLAS and instances",
        CaseProfile::Core,
        CaseStage::Tlas,
        RAY_QUERY,
        "the nearest expected instance is committed",
    ),
    case(
        "TLAS-02",
        "compound instance transform",
        CaseProfile::Core,
        CaseStage::Tlas,
        RAY_QUERY,
        "instance transform, inverse transform, and t match the CPU oracle",
    ),
    case(
        "TLAS-03",
        "24-bit instance custom data",
        CaseProfile::Core,
        CaseStage::Tlas,
        RAY_QUERY,
        "custom data boundary values round-trip exactly",
    ),
    case(
        "TLAS-04",
        "instance and ray masks",
        CaseProfile::Core,
        CaseStage::Tlas,
        RAY_QUERY,
        "only instances with a non-zero mask intersection are visible",
    ),
    case(
        "TLAS-05",
        "replace BLAS and rebuild TLAS",
        CaseProfile::Core,
        CaseStage::Tlas,
        RAY_QUERY,
        "only the replacement BLAS is visible after rebuild",
    ),
    case(
        "TLAS-06",
        "empty and sparse TLAS slots",
        CaseProfile::Core,
        CaseStage::Tlas,
        RAY_QUERY,
        "empty slots miss while populated slots remain queryable",
    ),
    case(
        "BUILD-01",
        "build and query in one command buffer",
        CaseProfile::Core,
        CaseStage::Build,
        RAY_QUERY,
        "the reference observation is stable",
    ),
    case(
        "BUILD-02",
        "build and query in ordered command buffers",
        CaseProfile::Core,
        CaseStage::Build,
        RAY_QUERY,
        "the reference observation is stable",
    ),
    case(
        "BUILD-03",
        "build and query across submit and poll",
        CaseProfile::Core,
        CaseStage::Build,
        RAY_QUERY,
        "the reference observation is stable",
    ),
    case(
        "BUILD-04",
        "BLAS and TLAS synchronized rebuild",
        CaseProfile::Core,
        CaseStage::Build,
        RAY_QUERY,
        "the rebuilt geometry is visible",
    ),
    case(
        "BUILD-05",
        "BLAS rebuild without TLAS rebuild",
        CaseProfile::Core,
        CaseStage::Build,
        RAY_QUERY,
        "validation is captured and the device remains healthy",
    ),
    case(
        "BUILD-06",
        "PreferUpdate equivalence",
        CaseProfile::Core,
        CaseStage::Build,
        RAY_QUERY,
        "PreferUpdate output equals a full Build",
    ),
    case(
        "COMPACT-01",
        "legal BLAS compaction lifecycle",
        CaseProfile::Extended,
        CaseStage::Build,
        RAY_QUERY,
        "compacted and source BLAS observations agree",
    ),
    case(
        "COMPACT-02",
        "invalid BLAS compaction order",
        CaseProfile::Extended,
        CaseStage::Build,
        RAY_QUERY,
        "validation is captured and the device remains healthy",
    ),
    case(
        "RQ-01",
        "miss and committed triangle",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "miss is NONE and hit fields match the CPU oracle",
    ),
    case(
        "RQ-02",
        "candidate confirmation",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "a confirmed non-opaque candidate becomes committed",
    ),
    case(
        "RQ-03",
        "terminate traversal",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "the committed hit belongs to the allowed set",
    ),
    case(
        "RQ-04",
        "cull and opaque flags",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "the hit set matches flag semantics",
    ),
    case(
        "RQ-05",
        "skip and first-hit flags",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "skip flags exclude geometry and first-hit stays in the allowed set",
    ),
    case(
        "RQ-06",
        "all committed and candidate fields",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "all meaningful fields match the CPU scene facts",
    ),
    case(
        "RQ-07",
        "compute and fragment parity",
        CaseProfile::Core,
        CaseStage::RayQuery,
        RAY_QUERY,
        "the same rays produce the same observation hash",
    ),
    case(
        "RQ-08",
        "hit vertex return",
        CaseProfile::Extended,
        CaseStage::RayQuery,
        VERTEX_RETURN,
        "returned vertices match the source triangle",
    ),
    case(
        "RQ-09",
        "TLAS binding array",
        CaseProfile::Extended,
        CaseStage::RayQuery,
        BINDING_ARRAY,
        "the selected binding resolves the expected TLAS",
    ),
    case(
        "RQ-10",
        "invalid ray descriptor robustness",
        CaseProfile::Extended,
        CaseStage::RayQuery,
        RAY_QUERY,
        "no device loss or uncaptured error occurs",
    ),
    aabb_case(
        "AABB-01",
        "AABB candidate",
        "candidate kind and primitive match the CPU AABB",
    ),
    aabb_case(
        "AABB-02",
        "generated AABB intersection",
        "generated kind and t match the CPU oracle",
    ),
    aabb_case(
        "AABB-03",
        "multiple AABBs with offset and stride",
        "the expected primitive is selected",
    ),
    aabb_case(
        "AABB-04",
        "invalid AABB input",
        "validation is captured and the device remains healthy",
    ),
    aabb_case(
        "AABB-05",
        "SKIP_AABBS mixed scene",
        "AABBs are excluded while the triangle remains visible",
    ),
    case(
        "STAB-01",
        "renderer create and drop",
        CaseProfile::Stability,
        CaseStage::Lifecycle,
        RAY_QUERY,
        "100 create/drop rounds have no device loss or hang",
    ),
    case(
        "STAB-02",
        "BLAS replacement lifecycle",
        CaseProfile::Stability,
        CaseStage::Lifecycle,
        RAY_QUERY,
        "100 replacements reference only the current BLAS",
    ),
    case(
        "STAB-03",
        "offscreen resize stability",
        CaseProfile::Stability,
        CaseStage::Lifecycle,
        RAY_QUERY,
        "100 resizes preserve the core oracle",
    ),
    case(
        "STAB-04",
        "packaged Tauri lifecycle",
        CaseProfile::Stability,
        CaseStage::Lifecycle,
        RAY_QUERY,
        "focus, minimize, restore, resize, and close terminate with evidence",
    ),
    case(
        "SOAK-01",
        "core scene soak",
        CaseProfile::Stability,
        CaseStage::Lifecycle,
        RAY_QUERY,
        "10000 frames or 10 minutes have zero mismatch and zero device loss",
    ),
    case(
        "PERF-01",
        "micro Ray Query and software BVH",
        CaseProfile::Performance,
        CaseStage::Benchmark,
        TIMESTAMP_QUERY,
        "same-input build and steady-state GPU timings are recorded",
    ),
    case(
        "PERF-02",
        "scene Ray Query and software BVH",
        CaseProfile::Performance,
        CaseStage::Benchmark,
        TIMESTAMP_QUERY,
        "same-input build and steady-state GPU timings are recorded",
    ),
    case(
        "PERF-03",
        "stress Ray Query and software BVH",
        CaseProfile::Performance,
        CaseStage::Benchmark,
        TIMESTAMP_QUERY,
        "same-input build and steady-state GPU timings are recorded or limit-probed unsupported",
    ),
    case(
        "PERF-04",
        "compaction timing delta",
        CaseProfile::Performance,
        CaseStage::Benchmark,
        TIMESTAMP_QUERY,
        "source and compacted timing distributions are recorded",
    ),
    case(
        "UPSTREAM-01",
        "wgpu-gpu ray_tracing suite",
        CaseProfile::Upstream,
        CaseStage::Upstream,
        RAY_QUERY,
        "each upstream test retains its original name and terminal result",
    ),
    CaseDefinition {
        id: "UPSTREAM-02",
        name: "wgpu Ray Tracing examples",
        profile: CaseProfile::Upstream,
        stage: CaseStage::Upstream,
        required_features: RAY_QUERY,
        backend_policy: BackendPolicy::Native,
        oracle: "each of the seven examples retains its original name and terminal result",
        timeout_ms: 30_000,
        known_issue: Some(METAL_EXAMPLE_ISSUE),
    },
    case(
        "UPSTREAM-03",
        "Naga Ray Query validation",
        CaseProfile::Upstream,
        CaseStage::Upstream,
        &[],
        "pinned MSL and SPIR-V validation/snapshots pass",
    ),
];

pub fn validate_registry() -> Result<(), String> {
    let mut ids = BTreeSet::new();
    for definition in CASE_REGISTRY {
        if definition.id.is_empty()
            || definition.name.is_empty()
            || definition.oracle.is_empty()
            || definition.timeout_ms == 0
        {
            return Err(format!("case {} has an incomplete contract", definition.id));
        }
        if !ids.insert(definition.id) {
            return Err(format!("duplicate case id {}", definition.id));
        }
        if let Some(issue) = definition.known_issue {
            if issue.affected_version != crate::WGPU_VERSION {
                return Err(format!(
                    "case {} has a stale known issue for wgpu {}",
                    definition.id, issue.affected_version
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_complete_and_unique() {
        validate_registry().unwrap();
        assert_eq!(CASE_REGISTRY.len(), 54);
    }

    #[test]
    fn optional_cases_are_feature_probed() {
        for id in ["TRI-07", "RQ-08", "RQ-09", "PERF-01"] {
            let definition = CASE_REGISTRY.iter().find(|case| case.id == id).unwrap();
            assert!(definition.required_features.len() >= 2);
        }
    }
}
