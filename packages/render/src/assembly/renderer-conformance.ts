import { viewGraphTarget } from '../view-inspection';
import type { createCameraViews } from './camera-views';
import type { RendererLegacyHostAdapter } from './host-contract';

type ConformanceHost = Pick<
  RendererLegacyHostAdapter,
  | 'getCurrentGraphTarget'
  | 'requestGraphTargetCapture'
  | 'cancelGraphTargetCapture'
  | 'setGtaoExecutionOverrideForConformance'
  | 'armGtaoCandidatePreparationFailureForConformance'
  | 'setClusterWorkObservationForConformance'
  | 'clusterWorkObservationForConformance'
  | 'clusterWorkFrameTraceForConformance'
  | 'setFeatureGraphTraceForConformance'
  | 'featureGraphTraceForConformance'
>;

/** Project internal capture and conformance operations from their view owners. */
export function rendererConformanceHost(
  views: ReturnType<typeof createCameraViews>,
): ConformanceHost {
  return {
    getCurrentGraphTarget: (name) => viewGraphTarget(views.currentOwner, name),
    requestGraphTargetCapture(request) {
      views.currentOwner.frameState.graphTargetCapture = request;
    },
    cancelGraphTargetCapture: views.cancelGraphTargetCapture,
    setGtaoExecutionOverrideForConformance: views.setGtaoExecutionOverride,
    armGtaoCandidatePreparationFailureForConformance:
      views.armGtaoCandidatePreparationFailureForConformance,
    setClusterWorkObservationForConformance: views.setClusterWorkObservationForConformance,
    clusterWorkObservationForConformance: views.clusterWorkObservationForConformance,
    clusterWorkFrameTraceForConformance: views.clusterWorkFrameTraceForConformance,
    setFeatureGraphTraceForConformance: views.setFeatureGraphTraceForConformance,
    featureGraphTraceForConformance: views.featureGraphTraceForConformance,
  };
}
