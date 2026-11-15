import type { RenderFeature } from './types';

// Like the fullscreen declaration, this producer fact survives separate entry bundles.
const unusedSurfaceData = Symbol.for('forgeax.render.unused-surface-data');

/** Capture only factory-owned code that never inspects Standard surface-data schemas. */
export function captureUnusedSurfaceData<
  T extends { readonly extract: unknown; readonly plan: unknown },
>(feature: T): T {
  Object.defineProperty(feature, unusedSurfaceData, {
    value: Object.freeze({ extract: feature.extract, plan: feature.plan }),
  });
  return feature;
}

/** Copies and replaced callbacks do not inherit a factory's non-consumption proof. */
export function featureUsesSurfaceData(feature: RenderFeature<unknown>): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(feature, unusedSurfaceData);
    if (descriptor === undefined || !('value' in descriptor)) return true;
    const proof = descriptor.value as { readonly extract: unknown; readonly plan: unknown };
    return proof.extract !== feature.extract || proof.plan !== feature.plan;
  } catch {
    // An observable/failed proof keeps the ordinary conservative admission.
    return true;
  }
}
