import type { Plugin } from '@forgeax/engine-plugin';
import rhiDebug from '../rhi-debug/frontend.ts';
import profiler from '../profiler/frontend.ts';
import modeling from '../modeling/frontend.ts';
export default [rhiDebug, profiler, modeling] satisfies readonly Plugin.Object[];
