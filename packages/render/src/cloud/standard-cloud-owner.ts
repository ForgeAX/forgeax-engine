import type { RenderFeature } from '../features/types';

/** Only the engine's installed CloudLayer producer owns Standard's built-in cloud stages. */
export const standardCloudProducers = new WeakSet<RenderFeature<unknown>>();
