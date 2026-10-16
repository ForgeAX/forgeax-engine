import type { Plugin } from '@forgeax/engine-plugin';
import rhiDebug from '../rhi-debug/frontend.ts';
import profiler from '../profiler/frontend.ts';
export default [rhiDebug, profiler] satisfies readonly Plugin.Object[];
