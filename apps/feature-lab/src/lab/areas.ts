/**
 * Feature areas in SDK feature-catalog order. Each `id` is a directory under
 * `src/features/` and under the tester manual `docs/feature-manual/`.
 */
export const AREAS = [
  { id: 'rendering-core', title: 'Rendering core', section: 'Rendering' },
  {
    id: 'cameras-visibility',
    title: 'Cameras, visibility and geometry submission',
    section: 'Rendering',
  },
  { id: 'lighting-shadows', title: 'Lighting, shadows and environment', section: 'Rendering' },
  { id: 'post-processing', title: 'Antialiasing and post-processing', section: 'Rendering' },
  {
    id: 'materials-shaders',
    title: 'Materials and shaders',
    section: 'Materials, shaders and geometry',
  },
  {
    id: 'geometry-scene-animation',
    title: 'Geometry, scene, skinning and animation',
    section: 'Materials, shaders and geometry',
  },
  {
    id: '2d-text-video-ui',
    title: '2D, text, video and UI',
    section: 'Materials, shaders and geometry',
  },
  { id: 'rhi-backends', title: 'RHI and backends', section: 'GPU, RHI and VFX' },
  { id: 'gpu-driven', title: 'GPU-driven rendering', section: 'GPU, RHI and VFX' },
  { id: 'vfx', title: 'VFX', section: 'GPU, RHI and VFX' },
  { id: 'types-math', title: 'Types and math', section: 'Core and ECS' },
  { id: 'ecs', title: 'ECS World', section: 'Core and ECS' },
  { id: 'state', title: 'State machine', section: 'Core and ECS' },
  { id: 'app-execution', title: 'App and execution tiers', section: 'App, input and plugins' },
  { id: 'input', title: 'Input', section: 'App, input and plugins' },
  { id: 'plugin-project', title: 'Plugin, Project and DSH', section: 'App, input and plugins' },
  { id: 'physics', title: 'Physics', section: 'Physics, audio, net and intelligence' },
  { id: 'audio', title: 'Audio', section: 'Physics, audio, net and intelligence' },
  { id: 'networking', title: 'Networking', section: 'Physics, audio, net and intelligence' },
  { id: 'intelligence', title: 'Intelligence', section: 'Physics, audio, net and intelligence' },
  { id: 'asset-identity', title: 'Asset identity, Pack and Catalog', section: 'Assets' },
  { id: 'import-loading', title: 'Import, cook, DDC and runtime loading', section: 'Assets' },
  { id: 'asset-formats', title: 'Asset formats', section: 'Assets' },
  { id: 'cli-preview', title: 'CLI, Tool Runtime and Preview', section: 'AI tools and delivery' },
  {
    id: 'profiler-remote-debug',
    title: 'Profiler, Remote and RHI Debug',
    section: 'AI tools and delivery',
  },
  { id: 'sdk-delivery', title: 'SDK and repository delivery', section: 'AI tools and delivery' },
] as const;

export type AreaId = (typeof AREAS)[number]['id'];
