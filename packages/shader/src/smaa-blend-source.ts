import source from './smaa-blend.wgsl?raw';

export const SMAA_BLEND_WGSL = source.replace(/^#define_import_path[^\n]*\n/, '');
