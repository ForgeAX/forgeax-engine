import { err, ok, type Result } from '@forgeax/engine-types';
import type { CloudLayerSource } from '../contracts';
import {
  type CloudAuthoringError,
  type CloudAuthoringLocation,
  cloudAuthoringError,
} from '../errors';
import { cloudFinite } from './material';

export function validateCloudLayer(
  layer: CloudLayerSource,
  location: CloudAuthoringLocation,
): Result<CloudLayerSource, CloudAuthoringError> {
  const fail = (field: string, reason: string) =>
    err(cloudAuthoringError('cloud-layer-invalid', location, field, reason));
  if (!(layer.material instanceof Uint8Array) || layer.material.length !== 16) {
    return fail('material', 'expected a cooked material GUID');
  }
  if (!cloudFinite(layer.bottomMeters)) return fail('bottomMeters', 'expected finite meters');
  if (!cloudFinite(layer.thicknessMeters) || layer.thicknessMeters <= 0) {
    return fail('thicknessMeters', 'expected positive finite meters');
  }
  const trace = layer.trace;
  for (const field of [
    'tracingStartMaxDistanceMeters',
    'tracingMaxDistanceMeters',
    'viewSampleCountScale',
    'shadowViewSampleCountScale',
  ] as const) {
    if (!cloudFinite(trace[field]) || trace[field] <= 0)
      return fail(`trace.${field}`, 'expected a positive finite value');
  }
  if (
    trace.tracingMaxDistanceMode !== 'from-layer-entry' &&
    trace.tracingMaxDistanceMode !== 'from-camera'
  ) {
    return fail('trace.tracingMaxDistanceMode', 'expected a known trace distance origin');
  }
  if (
    !cloudFinite(trace.stopTransmittance) ||
    trace.stopTransmittance < 0 ||
    trace.stopTransmittance > 1
  ) {
    return fail('trace.stopTransmittance', 'expected transmittance in [0, 1]');
  }
  return ok(structuredClone(layer));
}
