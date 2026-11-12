import { expect, it } from 'vitest';
import type { RenderSystem } from '../../__tests__/render-system-driver';
import type { ViewRecorderHost, ViewRecorderState } from '../view-output-systems';

// The Render World systems own these bodies; the view RenderSystem no longer exposes them.
it('exposes no shell method for the world-system-owned view bodies', () => {
  const absent = (system: RenderSystem) => {
    // @ts-expect-error commitRasterLane moved to render-view-raster-lane
    void system.commitRasterLane;
    // @ts-expect-error shadowCasterSource moved to render-shadow-casters
    void system.shadowCasterSource;
    // @ts-expect-error captureTerrain moved to view-terrain-candidate
    void system.captureTerrain;
    // @ts-expect-error prepareViewTopology moved to render-view-topology
    void system.prepareViewTopology;
    // @ts-expect-error preparePointsLines moved to view-points-lines
    void system.preparePointsLines;
    // @ts-expect-error submittedTerrain is read from the view's ViewDraws receipt
    void system.submittedTerrain;
    // @ts-expect-error isDynamicGeometryConsumed is read from the view's ViewDraws receipt
    void system.isDynamicGeometryConsumed;
    // @ts-expect-error dynamicGeometryRecordStageLane is read from the view's ViewDraws receipt
    void system.dynamicGeometryRecordStageLane;
    // @ts-expect-error presentation is read from the view's ViewRecordHistory
    void system.presentation;
    // @ts-expect-error presentationPendingReason is read from the view's ViewRecordHistory
    void system.presentationPendingReason;
    // @ts-expect-error isCubeCapturePending is read from the Renderer's capture owner
    void system.isCubeCapturePending;
    // @ts-expect-error bounds is read from the view owner's scene
    void system.bounds;
    // @ts-expect-error setSurfaceDynamicInput is the Render World's RenderSurfaceDynamicInput resource
    void system.setSurfaceDynamicInput;
    // @ts-expect-error configureStandard is configureViewStandard over each view owner
    void system.configureStandard;
    // @ts-expect-error prepareCandidatePipelines is prepareViewCandidatePipelines over each view owner
    void system.prepareCandidatePipelines;
    // @ts-expect-error copyConfigurationTo is seedViewConfiguration between view owners
    void system.copyConfigurationTo;
    // @ts-expect-error copyBuiltinPostProcessesTo is seedViewConfiguration between view owners
    void system.copyBuiltinPostProcessesTo;
    // @ts-expect-error adoptSsrFormatReceipt is seedViewConfiguration between view owners
    void system.adoptSsrFormatReceipt;
    // @ts-expect-error renderScene is viewRenderScene over the view owner
    void system.renderScene;
    // @ts-expect-error ssr is viewSsr over the view owner
    void system.ssr;
    // @ts-expect-error bloom is viewBloom over the view owner
    void system.bloom;
    // @ts-expect-error temporal is viewTemporal over the view owner
    void system.temporal;
    // @ts-expect-error perFrameGraphInfo is viewGraphInfo over the view owner
    void system.perFrameGraphInfo;
    // @ts-expect-error frustumStats is the view owner's recorded frustum facts
    void system.frustumStats;
    // @ts-expect-error bindGroupCounts is the view owner's recorded bind-group facts
    void system.bindGroupCounts;
    // @ts-expect-error motionBlurInvalidParams is the view owner's recorded parameter failure
    void system.motionBlurInvalidParams;
    // @ts-expect-error observeCurrentFrame is observeViewFrame over the view owner
    void system.observeCurrentFrame;
    // @ts-expect-error getCurrentGraphTarget is viewGraphTarget over the view owner
    void system.getCurrentGraphTarget;
    // @ts-expect-error lookupPostProcess is the view owner's post-process params lookup
    void system.lookupPostProcess;
    // @ts-expect-error record is the view owner's record
    void system.record;
    // @ts-expect-error disposeFrameState is the view owner's disposeFrameState
    void system.disposeFrameState;
    // @ts-expect-error stageScene is stageRenderScene over the RenderSceneInput resource
    void system.stageScene;
    // @ts-expect-error featureGpuWork is the view owner's preparedResolver.gpuWork
    void system.featureGpuWork;
  };
  expect(typeof absent).toBe('function');
});

// A view recorder is ECS data over its owner bag; it carries no RenderSystem object.
it('keeps the RenderSystem object out of view recorder data', () => {
  const absent = (state: ViewRecorderState, host: ViewRecorderHost) => {
    // @ts-expect-error a view records through its owner bag, not a RenderSystem
    void state.system;
    // @ts-expect-error the primary view's owner bag is published on the host internals
    void host.primary;
  };
  expect(typeof absent).toBe('function');
});
