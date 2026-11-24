import source from './ray-screen-candidate.wgsl?raw';

/** The published shader import and generated World entries share one codec. */
export const SCREEN_PROBE_CANDIDATE_WGSL = source.replace(/^#define_import_path[^\n]*\r?\n/, '');
