import { defineSchedule, World } from '@forgeax/engine-ecs';

/** One Render World per Renderer, shared by its views; it never advances simulation time. */
export function createRenderWorld(): World {
  return new World();
}

/** Derive: changed source facts become render-side entities and columns (views). */
export const RenderPrepare = defineSchedule('RenderPrepare');
