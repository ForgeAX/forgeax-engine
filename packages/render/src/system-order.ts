import { defineSystemSet } from '@forgeax/engine-ecs';

/** Stable ordering contracts shared by this owner's system implementations. */
export const RenderFeatureGraphEncodeOrder = defineSystemSet({
  name: 'render-feature-graph-encode',
});
export const RenderCaptureGraphEncodeOrder = defineSystemSet({
  name: 'render-capture-graph-encode',
});
export const RenderCaptureGraphCompileOrder = defineSystemSet({
  name: 'render-capture-graph-compile',
});
export const RenderEncoderOpenOrder = defineSystemSet({ name: 'render-encoder-open' });
export const RenderGraphSealOrder = defineSystemSet({ name: 'render-graph-seal' });
export const RenderScenePublishOrder = defineSystemSet({ name: 'render-scene-publish' });
export const GiSubmissionCommitOrder = defineSystemSet({ name: 'gi-submission-commit' });
export const RenderGraphSettleOrder = defineSystemSet({ name: 'render-graph-settle' });
export const RenderViewOutputsOrder = defineSystemSet({ name: 'render-view-outputs' });
export const RenderSsrAdmissionOrder = defineSystemSet({ name: 'render-ssr-admission' });
export const RenderHistoryAdmissionOrder = defineSystemSet({ name: 'render-history-admission' });
export const RenderGpuDrivenPrepareOrder = defineSystemSet({ name: 'render-gpu-driven-prepare' });
export const RenderRecordRetireOrder = defineSystemSet({ name: 'render-record-retire' });
export const RenderViewGraphPrepareOrder = defineSystemSet({ name: 'render-view-graph-prepare' });
export const RenderStandardLightingOrder = defineSystemSet({ name: 'render-standard-lighting' });
export const RenderViewFrameOrder = defineSystemSet({ name: 'render-view-frame' });
export const RenderViewTopologyOrder = defineSystemSet({ name: 'render-view-topology' });
export const RenderFeatureGraphCompileOrder = defineSystemSet({
  name: 'render-feature-graph-compile',
});

export const RenderRecordCommitOrder = defineSystemSet({ name: 'render-record-commit' });
export const RenderCascadeFitOrder = defineSystemSet({ name: 'render-cascade-fit' });
export const RenderEnvironmentAdmitOrder = defineSystemSet({ name: 'render-environment-admit' });
export const RenderPhaseSortOrder = defineSystemSet({ name: 'render-phase-sort' });
export const RenderFeatureViewsOrder = defineSystemSet({ name: 'render-feature-views' });
export const RenderSkinDemandOrder = defineSystemSet({ name: 'render-skin-demand' });
export const RenderOpaquePlanOrder = defineSystemSet({ name: 'render-opaque-plan' });
export const RenderViewGraphEncodeOrder = defineSystemSet({ name: 'render-view-graph-encode' });
export const RenderViewRecordSettleOrder = defineSystemSet({ name: 'render-view-record-settle' });
export const RenderMotionBlurPlanOrder = defineSystemSet({ name: 'render-motion-blur-plan' });
export const RenderCaptureFaceInputsOrder = defineSystemSet({ name: 'render-capture-face-inputs' });
export const RenderFeatureBatchOrder = defineSystemSet({ name: 'render-feature-batch' });
export const RenderFeatureOpenOrder = defineSystemSet({ name: 'render-feature-open' });
export const RenderSceneOrder = defineSystemSet({ name: 'render-scene' });
export const RenderFeaturePlanOrder = defineSystemSet({ name: 'render-feature-plan' });
export const RenderGpuDrivenRasterOrder = defineSystemSet({ name: 'render-gpu-driven-raster' });
export const RenderTransparentPlanOrder = defineSystemSet({ name: 'render-transparent-plan' });
export const RenderTransmissionPlanOrder = defineSystemSet({ name: 'render-transmission-plan' });
export const RenderFrameSubmitOrder = defineSystemSet({ name: 'render-frame-submit' });
export const RenderViewsOrder = defineSystemSet({ name: 'render-views' });
export const VisibleSurfaceRowsOrder = defineSystemSet({ name: 'visible-surface-rows' });
export const ViewReflectionProbesOrder = defineSystemSet({ name: 'view-reflection-probes' });
export const RenderSubmissionRetireOrder = defineSystemSet({ name: 'render-submission-retire' });
export const RenderViewCamerasOrder = defineSystemSet({ name: 'render-view-cameras' });
export const RenderCaptureScheduleOrder = defineSystemSet({ name: 'render-capture-schedule' });

export const RenderSkinTrackOrder = defineSystemSet({ name: 'render-skin-track' });

export const RenderTemporalFrameCommitOrder = defineSystemSet({
  name: 'render-temporal-frame-commit',
});

export const RenderStandardOutputCommitOrder = defineSystemSet({
  name: 'render-standard-output-commit',
});

export const RenderTemporalGpuCommitOrder = defineSystemSet({ name: 'render-temporal-gpu-commit' });

export const RenderCloudHistoryCommitOrder = defineSystemSet({
  name: 'render-cloud-history-commit',
});

export const RenderTemporalViewCommitOrder = defineSystemSet({
  name: 'render-temporal-view-commit',
});

export const RenderGpuDrivenCommitOrder = defineSystemSet({ name: 'render-gpu-driven-commit' });

export const RenderFogCommitOrder = defineSystemSet({ name: 'render-fog-commit' });

export const RenderShadowCommitOrder = defineSystemSet({ name: 'render-shadow-commit' });

export const RenderEnvironmentCommitOrder = defineSystemSet({ name: 'render-environment-commit' });

export const RenderAtmosphereCommitOrder = defineSystemSet({ name: 'render-atmosphere-commit' });

export const RenderSubsurfaceAdmissionOrder = defineSystemSet({
  name: 'render-subsurface-admission',
});

export const RenderFeatureGraphRetireOrder = defineSystemSet({
  name: 'render-feature-graph-retire',
});

export const ViewDiffuseGiOrder = defineSystemSet({ name: 'view-diffuse-gi' });

export const RenderGraphSealReleaseOrder = defineSystemSet({ name: 'render-graph-seal-release' });

export const RenderCaptureGraphRetireOrder = defineSystemSet({
  name: 'render-capture-graph-retire',
});

export const RenderDebugOverlayPrepareOrder = defineSystemSet({
  name: 'render-debug-overlay-prepare',
});

export const RenderDebugOverlayDiscardOrder = defineSystemSet({
  name: 'render-debug-overlay-discard',
});

export const DynamicGeometryCommitOrder = defineSystemSet({ name: 'dynamic-geometry-commit' });

export const ViewTerrainCandidateOrder = defineSystemSet({ name: 'view-terrain-candidate' });

export const TerrainReceiptCommitOrder = defineSystemSet({ name: 'terrain-receipt-commit' });

export const TerrainReceiptDiscardOrder = defineSystemSet({ name: 'terrain-receipt-discard' });

export const DynamicGeometryResetOrder = defineSystemSet({ name: 'dynamic-geometry-reset' });
