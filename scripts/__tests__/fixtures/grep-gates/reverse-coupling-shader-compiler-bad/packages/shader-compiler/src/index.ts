// Violation fixture: shader-compiler must not import @forgeax/engine-rhi-wgpu.
// check-concern-reverse-coupling.mjs should exit 1.
import { rhi } from '@forgeax/engine-rhi-wgpu';

export const compile = async () => rhi;
