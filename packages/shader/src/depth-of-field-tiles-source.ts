import helpers from './depth-of-field-tiles.wgsl?raw';
import kernel from './depth-of-field-tiles-compute.wgsl?raw';

export const DEPTH_OF_FIELD_TILES_WGSL = [helpers.replace(/^#.*$/gm, ''), kernel].join('\n');
