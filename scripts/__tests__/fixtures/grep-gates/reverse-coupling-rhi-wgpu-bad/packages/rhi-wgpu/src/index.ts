// Violation fixture: rhi-wgpu must not import @forgeax/engine-naga.
// check-concern-reverse-coupling.mjs should exit 1.
import { parse } from '@forgeax/engine-naga';

export const compileShader = (src) => parse(src);
