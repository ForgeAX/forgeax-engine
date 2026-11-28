import type { RenderFeature } from '../features/types';

/** Only renderer-installed Water producers may bind through the Standard view. */
export const standardWaterProducers = new WeakSet<RenderFeature<unknown>>();

export function standardWaterProducer<T>(feature: RenderFeature<T>): RenderFeature<unknown> {
  const owner = feature as RenderFeature<unknown>;
  standardWaterProducers.add(owner);
  return owner;
}
