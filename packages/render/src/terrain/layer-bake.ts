/// <reference path="../wgsl-raw.d.ts" />
import common from './layer-bake-common.wgsl?raw';
import compute from './layer-bake-compute.wgsl?raw';
import fragment from './layer-bake-fragment.wgsl?raw';

/** Package build embeds shared transport; neither backend compiles authored source at runtime. */
export const TERRAIN_LAYER_BAKE_SHADER = `${common}\n${compute}`;
export const TERRAIN_LAYER_BAKE_FRAGMENT_SHADER = `${common}\n${fragment}`;
