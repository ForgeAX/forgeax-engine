import type { CameraSnapshot } from './render-contract';

/**
 * The one effective Standard Bloom admission used by graph, resource, and
 * record owners. Authoring remains Camera-owned; this is only the derived
 * zero/non-zero topology decision.
 */
type BloomAdmissionCamera = Pick<CameraSnapshot, 'bloom' | 'bloomIntensity'>;

export function standardBloomAdmitted(camera: BloomAdmissionCamera | undefined): boolean {
  return camera !== undefined && camera.bloom === 'on' && camera.bloomIntensity > 0;
}
