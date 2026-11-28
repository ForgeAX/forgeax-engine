import { RhiError } from '@forgeax/engine-rhi';
import { BARREL_DISTORTION_PROGRAM } from '../features/barrel-distortion';
import { CHROMATIC_ABERRATION_PROGRAM, LENS_EFFECTS_PROGRAM } from '../features/lens-effects';
import { LENS_FLARE_PROGRAMS } from '../features/lens-flare';
import { OUTLINE_PROGRAMS } from '../features/outline/shaders';
import { SMAA_PROGRAMS } from '../features/smaa/shaders';
import type { RenderFeature } from '../features/types';
import { BLOOM_PREFILTER_PROGRAM } from '../pipeline/bloom-prefilter';
import { POST_SCENE_COLOR_HALF_PROGRAM } from '../pipeline/post-scene-color';
import {
  SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS,
  SINGLE_LAYER_MEDIUM_PRODUCER_PROGRAMS,
} from '../pipeline/single-layer-medium-passes';
import type { RendererState } from '../render-system';
import {
  SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM,
  SSR_SCENE_COLOR_HISTORY_PROGRAM,
} from '../ssr/scene-color-input';
import { WATER_SLW_POST_PROCESS_PROGRAMS } from '../water/slw-graph';

const STANDARD_POST_PROCESS_PROGRAMS = [
  POST_SCENE_COLOR_HALF_PROGRAM,
  BLOOM_PREFILTER_PROGRAM,
  BARREL_DISTORTION_PROGRAM,
  CHROMATIC_ABERRATION_PROGRAM,
  LENS_EFFECTS_PROGRAM,
  ...LENS_FLARE_PROGRAMS,
  ...OUTLINE_PROGRAMS,
  ...SMAA_PROGRAMS,
  SSR_SCENE_COLOR_HISTORY_PROGRAM,
  SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM,
  ...SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS,
  ...SINGLE_LAYER_MEDIUM_PRODUCER_PROGRAMS,
  ...WATER_SLW_POST_PROCESS_PROGRAMS.map((entry) => ({ ...entry, kind: 'fullscreen' as const })),
];

/** Graph aliases may select the exact same renderer-owned program. */
export function isStandardPostProcessSource(source: string): boolean {
  return STANDARD_POST_PROCESS_PROGRAMS.some((program) => program.source === source);
}

/** Standard owns these static declarations and their device-bound parameters. */
export function registerStandardPostProcessBuiltins(
  renderSystem: Pick<RendererState, 'registerBuiltinPostProcess'>,
): void {
  for (const { kind: _kind, name, ...entry } of STANDARD_POST_PROCESS_PROGRAMS)
    renderSystem.registerBuiltinPostProcess(name, entry);
}

export interface FullscreenProgramRequirement {
  readonly identity: string;
  readonly source: string;
  readonly rendererOwned?: true;
}

export function collectRequiredFullscreenPostProcesses(
  features: readonly RenderFeature<unknown>[],
): readonly FullscreenProgramRequirement[] {
  const entries = new Map<string, FullscreenProgramRequirement>();
  for (const { name, source } of STANDARD_POST_PROCESS_PROGRAMS)
    entries.set(name, { identity: name, source, rendererOwned: true });
  for (const feature of features) {
    for (const entry of feature.requiredFullscreenPostProcesses ?? []) {
      const existing = entries.get(entry.identity);
      if (existing !== undefined && existing.source !== entry.source) {
        throw new RhiError({
          code: 'internal-error',
          expected: `fullscreen identity '${entry.identity}' has one source across render features`,
          hint: 'rename the conflicting fullscreen identity or make its WGSL source identical',
        });
      }
      // A Feature's explicit requirement still applies when it aliases an
      // engine declaration. Its source record carries no renderer authority.
      entries.set(entry.identity, { identity: entry.identity, source: entry.source });
    }
  }
  return Object.freeze([...entries.values()]);
}
