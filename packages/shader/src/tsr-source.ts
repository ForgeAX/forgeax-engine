import temporal from './scene-temporal.wgsl?raw';
import analyze from './tsr-analyze.wgsl?raw';
import analyzeCommon from './tsr-analyze-common.wgsl?raw';
import analyzeFragment from './tsr-analyze-fragment.wgsl?raw';
import common from './tsr-common.wgsl?raw';
import fullscreen from './tsr-fullscreen.wgsl?raw';
import opaque from './tsr-opaque.wgsl?raw';
import opaqueFragment from './tsr-opaque-fragment.wgsl?raw';
import reconstruct from './tsr-reconstruct.wgsl?raw';
import reconstructCommon from './tsr-reconstruct-common.wgsl?raw';
import reconstructFragment from './tsr-reconstruct-fragment.wgsl?raw';

// Reuse the sole temporal-v1 decoder. The module marker is composition metadata.
const sceneData = temporal.replace(/^#define_import_path.*$/gm, '');
export const TSR_ANALYZE_WGSL = `${sceneData}\n${common}\n${analyze}\n${analyzeCommon}`;
export const TSR_RECONSTRUCT_WGSL = `${sceneData}\n${common}\n${reconstruct}\n${reconstructCommon}`;
export const TSR_OPAQUE_WGSL = `${sceneData}\n${common}\n${opaque}`;
export const TSR_ANALYZE_FRAGMENT_WGSL = `${sceneData}\n${common}\n${fullscreen}\n${analyzeFragment}\n${analyzeCommon}`;
export const TSR_RECONSTRUCT_FRAGMENT_WGSL = `${sceneData}\n${common}\n${fullscreen}\n${reconstructFragment}\n${reconstructCommon}`;
export const TSR_OPAQUE_FRAGMENT_WGSL = `${sceneData}\n${common}\n${fullscreen}\n${opaqueFragment}`;
