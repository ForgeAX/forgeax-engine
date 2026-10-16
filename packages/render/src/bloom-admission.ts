import type { BloomEnabled, Tonemap } from './components/camera';

/**
 * The one effective Standard Bloom admission used by graph, resource, and
 * record owners. Authoring remains Camera-owned; this is only the derived
 * zero/non-zero topology decision.
 */
export interface BloomAdmissionCamera {
  readonly bloom: BloomEnabled;
  readonly bloomIntensity: number;
  readonly tonemap: Tonemap;
}

export function standardBloomAdmitted(camera: BloomAdmissionCamera | undefined): boolean {
  return (
    camera !== undefined &&
    camera.bloom === 'on' &&
    camera.bloomIntensity > 0 &&
    camera.tonemap !== 'none'
  );
}
