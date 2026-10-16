// Happy-path fixture: rhi-wgpu depends only on @forgeax/engine-rhi +
// @forgeax/engine-wgpu-wasm + @forgeax/engine-types (legal forward direction). No
// @forgeax/engine-naga import.
import type { Rhi } from '@forgeax/engine-rhi';
import { ensureReady } from '@forgeax/engine-wgpu-wasm';

export const rhi: Rhi = {} as Rhi;

export const init = async () => ensureReady();
