/** Bindings shared by the native programs and their typed graph recorder. */
export const SSAO_SCREEN_PROGRAMS = {
  'gtao-depth': { entry: 'fs_gtao_depth', format: 'r8unorm', bindings: [14, 5, 16] },
  'gtao-normal': { entry: 'fs_gtao_normal', format: 'r8unorm', bindings: [14, 4, 5, 16] },
  'gtao-spatial': { entry: 'fs_gtao_spatial', format: 'r8unorm', bindings: [14, 5, 18] },
  'gtao-temporal': { entry: 'fs_gtao_temporal', format: 'r8unorm', bindings: [14, 5, 18, 19] },
  'gtao-temporal-velocity': {
    entry: 'fs_gtao_temporal_velocity',
    format: 'r8unorm',
    bindings: [14, 5, 18, 19, 20],
  },
  'gtao-temporal-scene-data': {
    entry: 'fs_gtao_temporal_scene_data',
    format: 'r8unorm',
    bindings: [14, 5, 18, 19, 21],
  },
  'gtao-resolve': { entry: 'fs_gtao_resolve', format: 'r8unorm', bindings: [18] },
  setup: { entry: 'fs_ssao_setup', format: 'rgba16float', bindings: [14, 5, 4] },
  'setup-coarse': { entry: 'fs_ssao_setup_coarse', format: 'rgba16float', bindings: [14, 15] },
  'full-depth': { entry: 'fs_ssao_full_depth', format: 'r8unorm', bindings: [14, 5, 16] },
  'full-normal': { entry: 'fs_ssao_full_normal', format: 'r8unorm', bindings: [14, 5, 4, 16] },
  'full-normal-upsample': {
    entry: 'fs_ssao_full_normal_upsample',
    format: 'r8unorm',
    bindings: [14, 5, 4, 16, 17, 18],
  },
  coarse: { entry: 'fs_ssao_coarse', format: 'r8unorm', bindings: [14, 15, 16] },
  'coarse-upsample': {
    entry: 'fs_ssao_coarse_upsample',
    format: 'r8unorm',
    bindings: [14, 15, 16, 17, 18],
  },
} as const;

export type SsaoScreenStage = keyof typeof SSAO_SCREEN_PROGRAMS;
export type SsaoScreenBinding = (typeof SSAO_SCREEN_PROGRAMS)[SsaoScreenStage]['bindings'][number];
